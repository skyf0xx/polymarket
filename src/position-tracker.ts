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

export class PositionTracker {
  private positions = new Map<string, Position>();

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

      this.positions.clear();

      for (const p of apiPositions) {
        if (Math.floor(p.size) <= 0) continue;

        // Determine YES/NO side from outcome
        const side: "YES" | "NO" =
          p.outcome === "Yes" || p.outcomeIndex === 0 ? "YES" : "NO";

        this.positions.set(p.asset, {
          tokenId: p.asset,
          slug: p.eventSlug, // use event slug so exit logic matches activeValueBetSlugs
          side,
          avgPrice: p.avgPrice,
          size: Math.floor(p.size), // CLOB only accepts whole integer shares
          totalCost: p.initialValue,
          openedAt: Date.now(),
        });
      }

      log.info(`Hydrated ${this.positions.size} position(s) from Data API`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Failed to hydrate positions: ${message}`);
    }
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
  ): void {
    const existing = this.positions.get(tokenId);

    if (existing) {
      // Weighted average cost basis
      const newTotalCost = existing.totalCost + price * size;
      const newSize = existing.size + size;
      const newAvgPrice = newTotalCost / newSize;

      existing.avgPrice = newAvgPrice;
      existing.size = newSize;
      existing.totalCost = newTotalCost;
    } else {
      this.positions.set(tokenId, {
        tokenId,
        slug,
        side,
        avgPrice: price,
        size,
        totalCost: price * size,
        openedAt: Date.now(),
      });
    }

    log.record("BUY recorded", {
      tokenId,
      slug,
      side,
      price,
      size,
      avgPrice: this.positions.get(tokenId)!.avgPrice,
      totalSize: this.positions.get(tokenId)!.size,
    });
  }

  /**
   * Record a sell: reduces position size. Removes position if fully closed.
   */
  recordSell(tokenId: string, price: number, size: number): void {
    const existing = this.positions.get(tokenId);
    if (!existing) {
      log.warn(`Sell recorded for unknown position: ${tokenId}`);
      return;
    }

    const soldSize = Math.min(size, existing.size);
    const costReduced = existing.avgPrice * soldSize;
    const profit = (price - existing.avgPrice) * soldSize;

    existing.size -= soldSize;
    existing.totalCost -= costReduced;

    log.record("SELL recorded", {
      tokenId,
      slug: existing.slug,
      price,
      size: soldSize,
      profit: Math.round(profit * 100) / 100,
      remainingSize: existing.size,
    });

    if (existing.size <= 0) {
      this.positions.delete(tokenId);
      log.info(`Position closed: ${tokenId} (${existing.slug})`);
    }
  }
}
