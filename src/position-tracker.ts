// src/position-tracker.ts
// Tracks open positions (token ID, avg price, size).
// Persists to positions.json for crash recovery.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import type { Position } from "./types.js";

const log = createLogger("positions");

const POSITIONS_FILE = join(config.dataDir, "positions.json");

export class PositionTracker {
  private positions = new Map<string, Position>();

  constructor() {
    this.loadFromDisk();
  }

  // ── Public API ──────────────────────────────────────────────────

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

    this.saveToDisk();

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

    this.saveToDisk();
  }

  // ── Persistence ─────────────────────────────────────────────────

  private loadFromDisk(): void {
    if (!existsSync(POSITIONS_FILE)) return;
    try {
      const raw: Position[] = JSON.parse(
        readFileSync(POSITIONS_FILE, "utf-8"),
      );
      for (const p of raw) {
        if (p.size > 0) {
          this.positions.set(p.tokenId, p);
        }
      }
      log.info(
        `Loaded ${this.positions.size} open position(s) from disk`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Could not read positions file: ${message}`);
    }
  }

  private saveToDisk(): void {
    if (!existsSync(config.dataDir)) {
      mkdirSync(config.dataDir, { recursive: true });
    }
    const tmpFile = POSITIONS_FILE + ".tmp";
    const data = JSON.stringify([...this.positions.values()], null, 2);
    writeFileSync(tmpFile, data);
    renameSync(tmpFile, POSITIONS_FILE);
  }
}
