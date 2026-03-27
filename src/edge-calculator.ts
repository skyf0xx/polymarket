// src/edge-calculator.ts
// Compare sharp_prob vs polymarket_price, apply fees, filter by min edge,
// compute Kelly sizing. Pure functions + per-market cooldown state.

import { config } from "./config.js";
import { createLogger } from "./logger.js";
import type { EdgeResult, Position } from "./types.js";

const log = createLogger("edge");

// ── Fee Schedule ──────────────────────────────────────────────────
// Some Polymarket markets charge taker fees. The fee formula is:
// fee = C × p × feeRate × (p × (1 - p))^exponent
// Where C = number of shares traded and p = price of the shares.
// Where rate 0.03 for sports market, and exponent is 1
// Note these are only for takes but to simplify we assume we are takers.
// There may be a better way in the future

const FEE_RATE = 0.03;

// Per-share fee: feeRate × p × (p × (1 - p))^1 = feeRate × p² × (1 - p)
// Makers pay zero fees on Polymarket, so return 0 when MARKET_MAKER is enabled.
function estimateFee(price: number, _sportKey?: string): number {
  if (config.marketMaker) return 0;
  return FEE_RATE * price * price * (1 - price);
}

// ── Cooldown State ────────────────────────────────────────────────

const lastSignalTime = new Map<string, number>();

export function isOnCooldown(tokenId: string): boolean {
  const last = lastSignalTime.get(tokenId);
  if (!last) return false;
  return Date.now() - last < config.cooldownSeconds * 1_000;
}

export function markSignaled(tokenId: string): void {
  lastSignalTime.set(tokenId, Date.now());
}

export function clearCooldown(tokenId: string): void {
  lastSignalTime.delete(tokenId);
}

// ── Edge Computation ──────────────────────────────────────────────

export interface ComputeEdgeInput {
  sharpProb: number; // implied prob from Odds API
  polyPrice: number; // midpoint (for logging)
  takerPrice: number; // best ask when buying, best bid when selling
  sportKey: string; // for fee lookup
  bankroll: number; // total USDC bankroll
  existingPosition: number; // USDC already in this market
  existingEventExposure: number; // USDC across all markets for this event
}

/**
 * Compute edge and Kelly-optimal bet size.
 * Returns null if the edge is not tradeable.
 */
export function computeEdge(input: ComputeEdgeInput): EdgeResult {
  const {
    sharpProb,
    takerPrice,
    sportKey,
    bankroll,
    existingPosition,
    existingEventExposure,
  } = input;

  // 1. Gross edge — use taker price (ask when buying) for realistic fill
  const grossEdge = sharpProb - takerPrice;

  // 2. Fee adjustment
  const fee = estimateFee(takerPrice, sportKey);

  // 3. Net edge
  const netEdge = grossEdge - fee;

  // 4. Minimum edge filter
  if (netEdge < config.minEdge) {
    return {
      grossEdge,
      fee,
      netEdge,
      kellyFraction: 0,
      suggestedSize: 0,
      tradeable: false,
      skipReason:
        netEdge <= 0
          ? "no_edge"
          : `edge_too_small (${(netEdge * 100).toFixed(2)}% < ${(config.minEdge * 100).toFixed(0)}%)`,
    };
  }

  // 5. Kelly fraction: netEdge / (1 - effectivePrice)
  //    effectivePrice = takerPrice + fee (what you actually pay per share).
  //    This is the Kelly formula for a binary bet where you buy at effectivePrice
  //    and win $1 or lose your stake.
  const effectivePrice = takerPrice + fee;
  const kellyFraction = effectivePrice < 1 ? netEdge / (1 - effectivePrice) : 0;

  // 6. Apply Kelly multiplier (quarter Kelly by default), capped at MAX_KELLY_PCT
  const adjustedKelly = Math.min(
    kellyFraction * config.kellyFraction,
    config.maxKellyPct,
  );

  // 7. Suggested size in USDC
  let suggestedSize = bankroll * adjustedKelly;

  // 8. Position cap: max % of bankroll per market
  const maxPosition = bankroll * config.maxPositionPct;
  const remainingMarketRoom = Math.max(0, maxPosition - existingPosition);

  // 8b. Event cap: max % of bankroll across all markets for the same event
  const maxEvent = bankroll * config.maxEventPct;
  const remainingEventRoom = Math.max(0, maxEvent - existingEventExposure);

  const remainingRoom = Math.min(remainingMarketRoom, remainingEventRoom);
  suggestedSize = Math.min(suggestedSize, remainingRoom);

  // 9. Minimum viable bet ($5)
  if (suggestedSize < 5) {
    return {
      grossEdge,
      fee,
      netEdge,
      kellyFraction,
      suggestedSize: 0,
      tradeable: false,
      skipReason:
        remainingEventRoom < 5
          ? "event_cap_reached"
          : remainingMarketRoom < 5
            ? "position_cap_reached"
            : "bet_too_small",
    };
  }

  return {
    grossEdge,
    fee,
    netEdge,
    kellyFraction,
    suggestedSize: Math.round(suggestedSize * 100) / 100,
    tradeable: true,
  };
}

// ── Exit Check ────────────────────────────────────────────────────

export interface ExitCheckInput {
  position: Position;
  currentPrice: number; // midpoint (for logging)
  bestBid: number; // taker sell price — what you'd actually receive
  sharpProb: number; // current sharp line implied prob
  sportKey: string;
}

export interface ExitResult {
  shouldExit: boolean;
  reason?: string;
  edge: number; // current edge (negative = overpriced)
  profitPerShare: number;
}

/**
 * Check if an open position should be exited.
 * Exit when the edge has flipped negative (market price > sharp prob).
 */
export function checkExit(input: ExitCheckInput): ExitResult {
  const { position, bestBid, sharpProb, sportKey } = input;

  // Use best bid for exit calc — that's what we'd receive as a taker seller
  const fee = estimateFee(bestBid, sportKey);
  const edge = sharpProb - bestBid - fee;
  const profitPerShare = bestBid - position.avgPrice;

  // Don't exit if edge is still positive — hold
  if (edge > 0) {
    return { shouldExit: false, edge, profitPerShare };
  }

  // Don't exit if profit is too small to cover fees/slippage
  // Rough estimate: ~2% round-trip cost
  if (profitPerShare < 0.02) {
    return {
      shouldExit: false,
      reason: "profit_too_small_for_fees",
      edge,
      profitPerShare,
    };
  }

  return {
    shouldExit: true,
    reason: `edge_negative (${(edge * 100).toFixed(2)}%), locking ${(profitPerShare * 100).toFixed(1)}¢/share profit`,
    edge,
    profitPerShare,
  };
}

// ── Logging Helper ────────────────────────────────────────────────

export function logEdge(
  tokenId: string,
  slug: string,
  sharpProb: number,
  polyPrice: number,
  result: EdgeResult,
): void {
  log.record(result.tradeable ? "EDGE DETECTED" : "edge checked", {
    tokenId,
    slug,
    sharpProb,
    polyPrice,
    grossEdge: result.grossEdge,
    netEdge: result.netEdge,
    kellyFraction: result.kellyFraction,
    suggestedSize: result.suggestedSize,
    tradeable: result.tradeable,
    ...(result.skipReason && { skipReason: result.skipReason }),
  });
}
