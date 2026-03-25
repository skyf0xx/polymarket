// src/pending-orders.ts
// Tracks notional value of resting (unfilled) GTD orders.
// Used by the edge calculator to avoid over-sizing when multiple
// maker orders are live for the same token.

import { createLogger } from "./logger.js";

const log = createLogger("pending-orders");

const GTD_TTL_MS = 5 * 60 * 1_000; // orders expire after 5 min

interface PendingEntry {
  orderId: string;
  tokenId: string;
  notional: number; // price × size (USDC equivalent)
  placedAt: number; // Date.now() when placed
}

/** In-memory tracker for resting GTD orders. */
export class PendingOrders {
  private orders = new Map<string, PendingEntry>(); // keyed by orderId

  /** Record a newly placed order. */
  add(orderId: string, tokenId: string, price: number, size: number): void {
    const notional = price * size;
    this.orders.set(orderId, {
      orderId,
      tokenId,
      notional,
      placedAt: Date.now(),
    });
    log.info(
      `Pending +$${notional.toFixed(2)} for ${tokenId} (order=${orderId}, total pending=$${this.getTokenNotional(tokenId).toFixed(2)})`,
    );
  }

  /** Remove an order (filled or cancelled). */
  remove(orderId: string): void {
    const entry = this.orders.get(orderId);
    if (entry) {
      this.orders.delete(orderId);
      log.info(
        `Pending cleared: order=${orderId} $${entry.notional.toFixed(2)} for ${entry.tokenId}`,
      );
    }
  }

  /** Remove all pending orders for a token (e.g. on full fill). */
  removeByToken(tokenId: string): void {
    for (const [id, entry] of this.orders) {
      if (entry.tokenId === tokenId) {
        this.orders.delete(id);
      }
    }
  }

  /** Total pending notional for a given token. */
  getTokenNotional(tokenId: string): number {
    let total = 0;
    for (const entry of this.orders.values()) {
      if (entry.tokenId === tokenId) {
        total += entry.notional;
      }
    }
    return total;
  }

  /** Prune orders older than GTD_TTL_MS (expired). */
  pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [id, entry] of this.orders) {
      if (now - entry.placedAt > GTD_TTL_MS) {
        this.orders.delete(id);
        pruned++;
      }
    }
    if (pruned > 0) {
      log.info(`Pruned ${pruned} expired pending order(s)`);
    }
    return pruned;
  }

  get size(): number {
    return this.orders.size;
  }
}
