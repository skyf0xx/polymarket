// src/edge-calculator.ts
// Compare sharp_prob vs polymarket_price, apply fees, filter by min edge,
// compute Kelly sizing. Pure functions + per-market cooldown state.

import { config } from "./config.js";
import { createLogger } from "./logger.js";
import type { EdgeResult, Position } from "./types.js";

const log = createLogger("edge");

// ── Fee Schedule ──────────────────────────────────────────────────
// Some Polymarket markets charge taker fees. The fee formula is:
//   fee = rate × price × (1 - price)
// where rate ≈ 1.75% for certain markets (NCAAB, Serie A, etc.)

const FEE_SPORT_KEYS = new Set([
  "basketball_ncaab",
  "soccer_italy_serie_a",
]);

const FEE_RATE = 0.0175;

function estimateFee(price: number, sportKey: string): number {
  if (FEE_SPORT_KEYS.has(sportKey)) {
    return FEE_RATE * price * (1 - price);
  }
  return 0;
}

// ── Cooldown State ────────────────────────────────────────────────

const lastSignalTime = new Map<string, number>();

export function isOnCooldown(tokenId: string): boolean {
  const last = lastSignalTime.get(tokenId);
  if (!last) return false;
  return Date.now() - last < config.cooldownSeconds * 1000;
}

export function markSignaled(tokenId: string): void {
  lastSignalTime.set(tokenId, Date.now());
}

export function clearCooldown(tokenId: string): void {
  lastSignalTime.delete(tokenId);
}

// ── Edge Computation ──────────────────────────────────────────────

export interface ComputeEdgeInput {
  sharpProb: number;        // implied prob from Odds API
  polyPrice: number;        // midpoint (for logging)
  takerPrice: number;       // best ask when buying, best bid when selling
  sportKey: string;         // for fee lookup
  bankroll: number;         // total USDC bankroll
  existingPosition: number; // USDC already in this market
}

/**
 * Compute edge and Kelly-optimal bet size.
 * Returns null if the edge is not tradeable.
 */
export function computeEdge(input: ComputeEdgeInput): EdgeResult {
  const { sharpProb, takerPrice, sportKey, bankroll, existingPosition } = input;

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

  // 5. Kelly fraction: edge / (1 - price)
  //    This is the Kelly formula for a binary bet where you buy at `price`
  //    and win $1 or lose your stake.
  const kellyFraction =
    takerPrice < 1 ? netEdge / (1 - takerPrice) : 0;

  // 6. Apply Kelly multiplier (quarter Kelly by default)
  const adjustedKelly = kellyFraction * config.kellyFraction;

  // 7. Suggested size in USDC
  let suggestedSize = bankroll * adjustedKelly;

  // 8. Position cap: max 10% of bankroll per market
  const maxPosition = bankroll * config.maxPositionPct;
  const remainingRoom = Math.max(0, maxPosition - existingPosition);
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
        remainingRoom < 5
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
  currentPrice: number;  // midpoint (for logging)
  bestBid: number;       // taker sell price — what you'd actually receive
  sharpProb: number;     // current sharp line implied prob
  sportKey: string;
}

export interface ExitResult {
  shouldExit: boolean;
  reason?: string;
  edge: number;         // current edge (negative = overpriced)
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
