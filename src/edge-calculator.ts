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

// Exits are always market orders (taker), so fee applies unconditionally.
function estimateExitFee(price: number): number {
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

  // 0a. Price floor — skip near-zero tokens (noise / dead markets)
  if (takerPrice < config.minPrice) {
    return {
      grossEdge: sharpProb - takerPrice,
      fee: 0,
      netEdge: 0,
      kellyFraction: 0,
      suggestedSize: 0,
      tradeable: false,
      skipReason: `price_too_low (${takerPrice} < ${config.minPrice})`,
    };
  }

  // 0b. No-liquidity filter — prices near 0.50 mean nobody has traded the market
  if (Math.abs(takerPrice - 0.5) < config.noLiquidityBand) {
    return {
      grossEdge: sharpProb - takerPrice,
      fee: 0,
      netEdge: 0,
      kellyFraction: 0,
      suggestedSize: 0,
      tradeable: false,
      skipReason: `no_liquidity (price ${takerPrice} within ${config.noLiquidityBand} of 0.50)`,
    };
  }

  // 1. Gross edge — use taker price (ask when buying) for realistic fill
  const grossEdge = sharpProb - takerPrice;

  // 2. Fee adjustment
  const fee = estimateFee(takerPrice, sportKey);

  // 3. Net edge
  const netEdge = grossEdge - fee;

  // 4. Edge range filter
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
  if (netEdge > config.maxEdge) {
    return {
      grossEdge,
      fee,
      netEdge,
      kellyFraction: 0,
      suggestedSize: 0,
      tradeable: false,
      skipReason: `edge_too_large (${(netEdge * 100).toFixed(2)}% > ${(config.maxEdge * 100).toFixed(0)}%) — likely bad match or stale odds`,
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
  sharpProbUpdatedAt: number; // Date.now() when odds line was last updated
  sportKey: string;
  consecutiveNegativeEdgeChecks: number; // how many consecutive checks edge has been ≤0
}

export interface ExitResult {
  shouldExit: boolean;
  reason?: string;
  edge: number; // current edge (negative = overpriced)
  profitPerShare: number;
}

/**
 * Check if an open position should be exited.
 *
 *  0. Stale odds → hold (don't act on bad data)
 *  1. Edge > 0 → hold (thesis intact)
 *  2. Edge ≤ 0 + profit ≥ minEdge → take profit (locked meaningful gain)
 *  3. Edge < -minEdge → cut loss (thesis broken)
 *  4. Edge ≤ 0 + profit covers round-trip fees → lock gain
 *  5. Edge ≤ 0 for N consecutive checks → exit (underwater persistence)
 *  6. Otherwise → hold
 */
export function checkExit(input: ExitCheckInput): ExitResult {
  const { position, bestBid, sharpProb, sharpProbUpdatedAt, consecutiveNegativeEdgeChecks } = input;

  const exitFee = estimateExitFee(bestBid);
  const edge = sharpProb - bestBid - exitFee;
  const profitPerShare = bestBid - position.avgPrice;

  // 0. Stale odds — don't act on data that may no longer reflect the market
  const sharpProbAge = Date.now() - sharpProbUpdatedAt;
  if (sharpProbAge > config.maxSharpProbAgeMs) {
    log.warn(`Stale sharp odds for ${input.position.slug} (${(sharpProbAge / 1000).toFixed(0)}s old) — skipping exit check`);
    return { shouldExit: false, edge, profitPerShare };
  }

  // 1. Thesis intact — keep holding
  if (edge > 0) {
    return { shouldExit: false, edge, profitPerShare };
  }

  // Edge is ≤ 0 from here on.

  // 2. Take profit — locked a meaningful gain (at least minEdge worth)
  const roundTripFee = estimateFee(position.avgPrice) + exitFee;
  if (profitPerShare >= config.minEdge) {
    return {
      shouldExit: true,
      reason: `take_profit: ${(profitPerShare * 100).toFixed(1)}¢/share (edge ${(edge * 100).toFixed(2)}%)`,
      edge,
      profitPerShare,
    };
  }

  // 3. Thesis broken hard — cut immediately
  if (edge < -config.minEdge) {
    return {
      shouldExit: true,
      reason: `loss_cut: edge ${(edge * 100).toFixed(2)}%, P&L ${(profitPerShare * 100).toFixed(1)}¢/share`,
      edge,
      profitPerShare,
    };
  }

  // 4. Edge gone, profit clears round-trip fees — lock the gain
  if (profitPerShare >= roundTripFee) {
    return {
      shouldExit: true,
      reason: `edge_gone (${(edge * 100).toFixed(2)}%), locking ${(profitPerShare * 100).toFixed(1)}¢/share`,
      edge,
      profitPerShare,
    };
  }

  // 5. Underwater with persistently zero/negative edge — exit to free capital
  if (consecutiveNegativeEdgeChecks >= config.maxNegativeEdgeChecks) {
    return {
      shouldExit: true,
      reason: `underwater_persistence: edge ≤0 for ${consecutiveNegativeEdgeChecks} checks, P&L ${(profitPerShare * 100).toFixed(1)}¢/share`,
      edge,
      profitPerShare,
    };
  }

  return { shouldExit: false, edge, profitPerShare };
}

// ── Logging Helper ────────────────────────────────────────────────

let loggedSlugDay = "";
const loggedSlugs = new Set<string>();

export function logEdge(
  _tokenId: string,
  slug: string,
  sharpProb: number,
  polyPrice: number,
  result: EdgeResult,
): void {
  if (!result.tradeable) return;
  const today = new Date().toISOString().slice(0, 10);
  if (today !== loggedSlugDay) {
    loggedSlugDay = today;
    loggedSlugs.clear();
  }
  if (loggedSlugs.has(slug)) return;
  loggedSlugs.add(slug);
  log.record("EDGE DETECTED", {
    slug,
    sharpProb,
    polyPrice,
    grossEdge: result.grossEdge,
    netEdge: result.netEdge,
  });
}
