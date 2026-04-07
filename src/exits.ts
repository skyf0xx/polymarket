// src/exits.ts
// Exit logic: check open positions against profit/loss thresholds.
// Sells when value-bet signal disappears (edge gone) and position meets exit criteria.
// Fetches live prices from CLOB REST (no persistent WS needed).

import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { isOnCooldown, markSignaled } from "./cooldown.js";
import { executeSignal } from "./executor.js";
import type { ClobClient } from "@polymarket/clob-client";
import type { PositionTracker } from "./position-tracker.js";
import type { OrderTracker } from "./order-tracker.js";
import type { TradeSignal, Position } from "./types.js";

const log = createLogger("exits");

async function fetchFeeRate(_client: ClobClient, tokenId: string): Promise<number> {
  try {
    const res = await fetch("https://clob.polymarket.com/fee-rate");
    const data = await res.json() as { base_fee?: number };
    return Number(data.base_fee ?? 0);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to fetch fee rate for ${tokenId}: ${message}, using 0`);
    return 0;
  }
}

// Consecutive "no value-bet" check counter per token
const noEdgeChecks = new Map<string, number>();

// -- Public API ---------------------------------------------------------------

export interface ExitDeps {
  client: ClobClient;
  positions: PositionTracker;
  orders: OrderTracker;
  activeValueBetSlugs: Set<string>;
}

/**
 * Check all open positions for exit signals. Fetches live prices from CLOB REST.
 *
 * Exit rules:
 *  1. Event still in value-bets → hold (thesis intact)
 *  2. Event gone + profit ≥ minEdge → take profit
 *  3. Event gone + loss > minEdge → cut loss
 *  4. Event gone + profit > round-trip fees → lock gain
 *  5. Event gone for N consecutive checks → exit (underwater persistence)
 */
export async function checkAllExits(deps: ExitDeps): Promise<void> {
  const positions = deps.positions.getAllPositions();
  if (positions.length === 0) return;

  log.debug(`Exit sweep: checking ${positions.length} open position(s)`);

  for (const position of positions) {
    await checkExitForToken(position, deps);
  }
}

// -- Per-Token Exit Check -----------------------------------------------------

async function checkExitForToken(position: Position, deps: ExitDeps): Promise<void> {
  try {
    const { client, orders, activeValueBetSlugs } = deps;
    const tokenId = position.tokenId;

    // Check if this position's event still has an active value-bet signal
    const hasActiveEdge = activeValueBetSlugs.has(position.slug);

    // Fetch live price and fee rate from CLOB REST
    const [bestBid, feeRateBps] = await Promise.all([
      fetchBestBid(client, tokenId),
      fetchFeeRate(client, tokenId),
    ]);
    if (bestBid === null || bestBid < config.minPrice) return;

    const consecutiveChecks = noEdgeChecks.get(tokenId) ?? 0;
    const exitResult = checkExit(position, bestBid, hasActiveEdge, consecutiveChecks, feeRateBps);

    // Track consecutive checks where value-bet is absent
    if (!hasActiveEdge) {
      noEdgeChecks.set(tokenId, consecutiveChecks + 1);
    } else {
      noEdgeChecks.delete(tokenId);
    }

    if (!exitResult.shouldExit) return;

    log.info(`EXIT SIGNAL: ${position.slug} bestBid=${bestBid.toFixed(4)} reason=${exitResult.reason}`);

    if (isOnCooldown(tokenId)) {
      log.debug(`Cooldown active for exit on ${tokenId}, skipping`);
      return;
    }

    const sellSize = Math.floor(position.size);
    if (sellSize < 1) return;

    // Stash exit reason on position so recordSell can include it in TRADE_CLOSED
    position.exitReason = exitResult.reason;

    const signal: TradeSignal = {
      tokenId,
      slug: position.slug,
      side: "SELL",
      tokenSide: position.side,
      price: bestBid,
      size: sellSize,
      edge: 0,
      kellyFraction: 0,
      reason: "exit_signal",
    };

    markSignaled(tokenId);
    noEdgeChecks.delete(tokenId);

    if (config.dryRun) {
      log.info(
        `[DRY RUN] Would SELL ${sellSize} shares of ${position.slug} @ ${bestBid.toFixed(4)} (${exitResult.reason})`,
      );
      return;
    }

    executeSignal(client, signal, orders).catch((err) =>
      log.error(`Exit dispatch error: ${err.message}`),
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Exit check error for ${position.tokenId}: ${message}`);
  }
}

// -- Exit Decision ------------------------------------------------------------

interface ExitResult {
  shouldExit: boolean;
  reason?: string;
  profitPerShare: number;
}

function checkExit(
  position: Position,
  bestBid: number,
  hasActiveEdge: boolean,
  consecutiveNoEdgeChecks: number,
  feeRateBps: number,
): ExitResult {
  const profitPerShare = bestBid - position.avgPrice;

  // 1. Thesis intact — value-bet still showing for this event
  if (hasActiveEdge) return { shouldExit: false, profitPerShare };

  // Edge is gone — evaluate exit conditions

  // 2. Take profit
  if (profitPerShare >= config.minEdge) {
    return {
      shouldExit: true,
      reason: `take_profit: ${(profitPerShare * 100).toFixed(1)}c/share`,
      profitPerShare,
    };
  }

  // 3. Cut loss — thesis broken and underwater
  if (profitPerShare < -config.minEdge) {
    return {
      shouldExit: true,
      reason: `loss_cut: P&L ${(profitPerShare * 100).toFixed(1)}c/share`,
      profitPerShare,
    };
  }

  // 4. Lock gain — profit clears round-trip fees AND meets minimum per-share/notional floors.
  //
  // Fee model: fee = C × feeRate × p × (1 - p)
  // where C = size (contracts), feeRate from /fee-rate endpoint, p = price.
  // Round-trip = entry fee + exit fee.
  const feeFactor = feeRateBps / 10000;
  const entryFee = position.size * feeFactor * position.avgPrice * (1 - position.avgPrice);
  const exitFee = position.size * feeFactor * bestBid * (1 - bestBid);
  const totalFees = entryFee + exitFee;
  const grossProfit = profitPerShare * position.size;

  const positionCost = position.avgPrice * position.size;
  const meetsPerShareFloor = profitPerShare >= position.avgPrice * config.minLockGainPricePct;
  const meetsNotionalFloor = grossProfit >= positionCost * config.minLockGainReturnPct;
  const clearsFees = grossProfit >= totalFees;

  if (meetsPerShareFloor && meetsNotionalFloor && clearsFees) {
    return {
      shouldExit: true,
      reason: `lock_gain: ${(profitPerShare * 100).toFixed(1)}c/share (clears fees)`,
      profitPerShare,
    };
  }

  // 5. Underwater persistence — edge gone for too many consecutive checks
  if (consecutiveNoEdgeChecks >= config.maxNegativeEdgeChecks) {
    return {
      shouldExit: true,
      reason: `underwater_persistence: no edge for ${consecutiveNoEdgeChecks} checks, P&L ${(profitPerShare * 100).toFixed(1)}c/share`,
      profitPerShare,
    };
  }

  return { shouldExit: false, profitPerShare };
}

// -- REST Price Fetch ---------------------------------------------------------

async function fetchBestBid(client: ClobClient, tokenId: string): Promise<number | null> {
  try {
    const { price } = await client.getPrice(tokenId, "SELL");
    const bid = Number(price);
    return isFinite(bid) && bid > 0 ? bid : null;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to fetch bestBid for ${tokenId}: ${message}`);
    return null;
  }
}
