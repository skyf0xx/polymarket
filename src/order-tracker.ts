// src/order-tracker.ts
// Tracks resting GTD orders (notional) and signal metadata (for fill logging).
// Merged from pending-orders.ts + pending-signals.ts.

import { createLogger } from "./logger.js";
import type { MatchEntry } from "./types.js";

const log = createLogger("orders");

const GTD_TTL_MS = 5 * 60 * 1_000;
const SIGNAL_TTL_MS = 10 * 60 * 1_000;

interface PendingOrder {
  orderId: string;
  tokenId: string;
  notional: number;
  placedAt: number;
}

export interface SignalMeta {
  tokenSide: "YES" | "NO";
  match: MatchEntry;
  line: null;
  sharpProb: null;
  netEdge: number;
  kellyFraction: number;
  storedAt: number;
}

export class OrderTracker {
  private orders = new Map<string, PendingOrder>();
  private signals = new Map<string, SignalMeta>();

  // -- Pending Orders ---------------------------------------------------------

  trackOrder(orderId: string, tokenId: string, price: number, size: number): void {
    const notional = price * size;
    this.orders.set(orderId, { orderId, tokenId, notional, placedAt: Date.now() });
    log.info(
      `Pending +$${notional.toFixed(2)} for ${tokenId} (order=${orderId}, total=$${this.getTokenNotional(tokenId).toFixed(2)})`,
    );
  }

  removeOrder(orderId: string): void {
    this.orders.delete(orderId);
  }

  removeOrdersByToken(tokenId: string): void {
    for (const [id, entry] of this.orders) {
      if (entry.tokenId === tokenId) this.orders.delete(id);
    }
  }

  getTokenNotional(tokenId: string): number {
    let total = 0;
    for (const entry of this.orders.values()) {
      if (entry.tokenId === tokenId) total += entry.notional;
    }
    return total;
  }

  get pendingCount(): number {
    return this.orders.size;
  }

  // -- Signal Metadata --------------------------------------------------------

  storeSignal(tokenId: string, meta: Omit<SignalMeta, "storedAt">): void {
    this.signals.set(tokenId, { ...meta, storedAt: Date.now() });
  }

  consumeSignal(tokenId: string): SignalMeta | undefined {
    const meta = this.signals.get(tokenId);
    if (!meta) return undefined;
    this.signals.delete(tokenId);
    if (Date.now() - meta.storedAt > SIGNAL_TTL_MS) {
      log.warn(`Signal expired for token=${tokenId}, skipping`);
      return undefined;
    }
    return meta;
  }

  // -- Pruning ----------------------------------------------------------------

  pruneExpired(): void {
    const now = Date.now();
    let ordersPruned = 0;
    let signalsPruned = 0;

    for (const [id, entry] of this.orders) {
      if (now - entry.placedAt > GTD_TTL_MS) {
        this.orders.delete(id);
        ordersPruned++;
      }
    }
    for (const [id, meta] of this.signals) {
      if (now - meta.storedAt > SIGNAL_TTL_MS) {
        this.signals.delete(id);
        signalsPruned++;
      }
    }

    if (ordersPruned > 0 || signalsPruned > 0) {
      log.info(`Pruned ${ordersPruned} order(s), ${signalsPruned} signal(s)`);
    }
  }
}
