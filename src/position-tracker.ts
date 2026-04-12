// src/position-tracker.ts
// Tracks open positions (token ID, avg price, size).
// Hydrates from Polymarket Data API on startup + re-syncs during maintenance.
// Real-time updates come from the user WebSocket (trade events).

import { config } from "./config.js";
import { createLogger } from "./logger.js";
import type { Position } from "./types.js";

const log = createLogger("positions");

const DATA_API_URL = "https://data-api.polymarket.com";

/** Shape returned by GET /positions */
interface DataApiPosition {
  asset: string; // token ID
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  slug: string; // market slug (e.g. "sea-udi-com-2026-04-06-udi")
  eventSlug: string; // event slug (e.g. "sea-udi-com-2026-04-06")
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate: string;
  redeemable: boolean;
  mergeable: boolean;
}

export interface RedeemablePosition {
  tokenId: string;
  slug: string;
  conditionId: string;
}

export class PositionTracker {
  private positions = new Map<string, Position>();
  private redeemablePositions = new Map<string, RedeemablePosition>(); // keyed by tokenId
  private pendingSignals = new Map<string, { edgeAtEntry: number; kellyAtEntry: number }>(); // keyed by tokenId

  /** Store signal metadata before order execution so it survives reconnects and catch-up replays. */
  storePendingSignal(tokenId: string, edgeAtEntry: number, kellyAtEntry: number): void {
    this.pendingSignals.set(tokenId, { edgeAtEntry, kellyAtEntry });
  }

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Hydrate positions from the Polymarket Data API.
   * Fetches all current positions for the funder wallet — the API
   * already filters out resolved/settled markets.
   */
  async hydrate(): Promise<void> {
    try {
      const url = `${DATA_API_URL}/positions?user=${config.funderAddress}&sizeThreshold=0.01&limit=500`;
      const res = await fetch(url);

      if (!res.ok) {
        log.error(`Data API /positions returned ${res.status}`);
        return;
      }

      const apiPositions: DataApiPosition[] = await res.json();
      const freshTokenIds = new Set(apiPositions.filter(p => p.size > 0).map(p => p.asset));
      this.redeemablePositions.clear();

      // Detect positions that disappeared since last hydration — market resolved or manually closed elsewhere
      for (const [tokenId, held] of this.positions) {
        if (!freshTokenIds.has(tokenId)) {
          const currentValue = (held as Position & { _currentValue?: number })._currentValue;
          if (currentValue == null) {
            log.warn(`TRADE_CLOSED skipped for ${held.slug}: no currentValue snapshot available`);
            continue;
          }
          const exitPrice = Math.round((currentValue / held.size) * 10000) / 10000;
          const profitPerShare = exitPrice - held.avgPrice;
          log.record("TRADE_CLOSED", {
            ts: new Date().toISOString(),
            slug: held.slug,
            side: held.side,
            entryPrice: Math.round(held.avgPrice * 10000) / 10000,
            exitPrice,
            size: held.size,
            edgeAtEntry: held.edgeAtEntry ?? null,
            kellyAtEntry: held.kellyAtEntry ?? null,
            exitReason: "resolved_or_manual",
            profitPerShare: Math.round(profitPerShare * 10000) / 10000,
            totalProfit: Math.round(profitPerShare * held.size * 100) / 100,
          });
        }
      }

      this.positions.clear();

      for (const p of apiPositions) {
        if (Math.floor(p.size) <= 0) continue;

        // Determine YES/NO side from outcome
        const side: "YES" | "NO" =
          p.outcome === "Yes" || p.outcomeIndex === 0 ? "YES" : "NO";

        if (p.redeemable) {
          this.redeemablePositions.set(p.asset, {
            tokenId: p.asset,
            slug: p.eventSlug,
            conditionId: p.conditionId,
          });
          continue; // resolved — don't track as open position
        }

        const pos: Position & { _currentValue?: number } = {
          tokenId: p.asset,
          slug: p.eventSlug, // use event slug so exit logic matches activeValueBetSlugs
          side,
          avgPrice: p.avgPrice,
          size: Math.floor(p.size), // CLOB only accepts whole integer shares
          totalCost: p.initialValue,
          openedAt: Date.now(),
        };
        pos._currentValue = p.currentValue;
        this.positions.set(p.asset, pos);
      }

      log.info(
        `Hydrated ${this.positions.size} position(s), ${this.redeemablePositions.size} redeemable from Data API`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Failed to hydrate positions: ${message}`);
    }
  }

  /** Get all positions with redeemable=true from the last hydration. */
  getRedeemable(): RedeemablePosition[] {
    return [...this.redeemablePositions.values()];
  }

  /** Get position for a token. */
  getPosition(tokenId: string): Position | null {
    return this.positions.get(tokenId) ?? null;
  }

  /** Get all open positions. */
  getAllPositions(): Position[] {
    return [...this.positions.values()];
  }

  /** Total USDC currently deployed across all positions. */
  getTotalDeployed(): number {
    let total = 0;
    for (const p of this.positions.values()) {
      total += p.totalCost;
    }
    return total;
  }

  /** USDC deployed in a specific market (by token ID). */
  getPositionCost(tokenId: string): number {
    return this.positions.get(tokenId)?.totalCost ?? 0;
  }

  /** USDC deployed across all markets for a given event slug. */
  getEventExposure(slug: string): number {
    let total = 0;
    for (const p of this.positions.values()) {
      if (p.slug === slug) total += p.totalCost;
    }
    return total;
  }

  get size(): number {
    return this.positions.size;
  }

  // ── Record Trades ───────────────────────────────────────────────

  /**
   * Record a buy: increases position size, recalculates weighted avg price.
   */
  recordBuy(
    tokenId: string,
    slug: string,
    side: "YES" | "NO",
    price: number,
    size: number,
    edgeAtEntry?: number,
    kellyAtEntry?: number,
  ): void {
    const existing = this.positions.get(tokenId);
    const pending = this.pendingSignals.get(tokenId);
    const resolvedEdge = pending?.edgeAtEntry ?? edgeAtEntry;
    const resolvedKelly = pending?.kellyAtEntry ?? kellyAtEntry;

    if (existing) {
      // Weighted average cost basis
      const newTotalCost = existing.totalCost + price * size;
      const newSize = existing.size + size;
      const newAvgPrice = newTotalCost / newSize;

      existing.avgPrice = newAvgPrice;
      existing.size = newSize;
      existing.totalCost = newTotalCost;
      // Backfill if not yet set (e.g. position was hydrated from Data API without signal data)
      if (existing.edgeAtEntry == null && resolvedEdge != null) existing.edgeAtEntry = resolvedEdge;
      if (existing.kellyAtEntry == null && resolvedKelly != null) existing.kellyAtEntry = resolvedKelly;
    } else {
      this.positions.set(tokenId, {
        tokenId,
        slug,
        side,
        avgPrice: price,
        size,
        totalCost: price * size,
        openedAt: Date.now(),
        edgeAtEntry: resolvedEdge,
        kellyAtEntry: resolvedKelly,
      });
    }

    // Clear pending signal once consumed into position
    this.pendingSignals.delete(tokenId);

    log.info(`BUY recorded: ${slug} ${size} @ ${price}`);
  }

  /**
   * Record a sell: reduces position size. Removes position if fully closed.
   */
  recordSell(tokenId: string, price: number, size: number, exitReason?: string): void {
    const existing = this.positions.get(tokenId);
    if (!existing) {
      log.warn(`Sell recorded for unknown position: ${tokenId}`);
      return;
    }

    const soldSize = Math.min(size, existing.size);
    const costReduced = existing.avgPrice * soldSize;
    const profitPerShare = price - existing.avgPrice;
    const totalProfit = profitPerShare * soldSize;

    existing.size -= soldSize;
    existing.totalCost -= costReduced;

    log.info(`SELL recorded: ${existing.slug} ${soldSize} @ ${price} (remaining: ${existing.size})`);

    if (existing.size <= 0) {
      log.record("TRADE_CLOSED", {
        ts: new Date().toISOString(),
        slug: existing.slug,
        side: existing.side,
        entryPrice: Math.round(existing.avgPrice * 10000) / 10000,
        exitPrice: Math.round(price * 10000) / 10000,
        size: soldSize,
        edgeAtEntry: existing.edgeAtEntry ?? null,
        kellyAtEntry: existing.kellyAtEntry ?? null,
        exitReason: exitReason ?? null,
        profitPerShare: Math.round(profitPerShare * 10000) / 10000,
        totalProfit: Math.round(totalProfit * 100) / 100,
      });
      this.positions.delete(tokenId);
      log.info(`Position closed: ${tokenId} (${existing.slug})`);
    }
  }
}
