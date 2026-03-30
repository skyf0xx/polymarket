// src/pending-signals.ts
// Stashes signal metadata (edge, sharp prob, match context) at signal-fire time
// so it can be consumed when a GTD order is confirmed MATCHED by the user stream.

import { createLogger } from "./logger.js";
import type { MatchEntry, SharpLine } from "./types.js";

const log = createLogger("pending-signals");

// Keep signal metadata for up to 10 minutes — GTD TTL is 5 min, this gives buffer
const SIGNAL_TTL_MS = 10 * 60 * 1_000;

export interface SignalMeta {
  tokenSide: "YES" | "NO";
  match: MatchEntry;
  line: SharpLine;
  sharpProb: number;
  netEdge: number;
  kellyFraction: number;
  storedAt: number;
}

export class PendingSignals {
  private signals = new Map<string, SignalMeta>(); // keyed by tokenId

  /** Store signal metadata when an edge fires. Overwrites any prior signal for the same token. */
  store(tokenId: string, meta: Omit<SignalMeta, "storedAt">): void {
    this.signals.set(tokenId, { ...meta, storedAt: Date.now() });
    log.debug(`Signal stored for token=${tokenId}`);
  }

  /** Consume and return signal metadata on fill. Returns undefined if not found or expired. */
  consume(tokenId: string): SignalMeta | undefined {
    const meta = this.signals.get(tokenId);
    if (!meta) return undefined;
    this.signals.delete(tokenId);
    if (Date.now() - meta.storedAt > SIGNAL_TTL_MS) {
      log.warn(`Signal expired for token=${tokenId}, skipping entry log`);
      return undefined;
    }
    return meta;
  }

  /** Prune expired entries (called during maintenance). */
  pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [id, meta] of this.signals) {
      if (now - meta.storedAt > SIGNAL_TTL_MS) {
        this.signals.delete(id);
        pruned++;
      }
    }
    if (pruned > 0) log.info(`Pruned ${pruned} expired pending signal(s)`);
    return pruned;
  }

  get size(): number {
    return this.signals.size;
  }
}
