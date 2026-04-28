// src/cooldown.ts
// Per-token cooldown state. Prevents double-firing signals on the same market.
// Also tracks per-slug stop-loss cooldowns to prevent re-entering a volatile event
// after a stop-loss or loss_cut exit.

import { config } from "./config.js";

const lastSignalTime = new Map<string, number>();

// Keyed by event slug. Set when a stop_loss or loss_cut fires on any token in that event.
const stopLossSlugTime = new Map<string, number>();

// Consecutive failed BUY order counts per token. After MAX_BUY_FAILURES consecutive
// 400s, the token is put on a long backoff to prevent retry storms.
const buyFailureCount = new Map<string, number>();
const buyBackoffTime = new Map<string, number>();
const MAX_BUY_FAILURES = 3;
const BUY_BACKOFF_MS = 60 * 60 * 1_000; // 1 hour

export function isOnCooldown(tokenId: string): boolean {
  const backoff = buyBackoffTime.get(tokenId);
  if (backoff && Date.now() - backoff < BUY_BACKOFF_MS) return true;

  const last = lastSignalTime.get(tokenId);
  if (!last) return false;
  return Date.now() - last < config.cooldownSeconds * 1_000;
}

export function markSignaled(tokenId: string): void {
  lastSignalTime.set(tokenId, Date.now());
}

/** Call after a BUY order returns a hard failure (400). After MAX_BUY_FAILURES
 *  consecutive failures the token is backed off for BUY_BACKOFF_MS. */
export function markBuyFailed(tokenId: string): void {
  const count = (buyFailureCount.get(tokenId) ?? 0) + 1;
  buyFailureCount.set(tokenId, count);
  if (count >= MAX_BUY_FAILURES) {
    buyBackoffTime.set(tokenId, Date.now());
    buyFailureCount.delete(tokenId);
  }
}

/** Reset failure counter on a successful BUY fill. */
export function markBuySucceeded(tokenId: string): void {
  buyFailureCount.delete(tokenId);
  buyBackoffTime.delete(tokenId);
}

/**
 * Mark a slug as stop-loss cooled-down. New BUY signals for this slug are blocked
 * for stopLossSlugCooldownMs. Call after any stop_loss or loss_cut exit fires.
 */
export function markStopLoss(slug: string): void {
  stopLossSlugTime.set(slug, Date.now());
}

/**
 * Returns true if the slug is currently blocked due to a recent stop-loss on that event.
 */
export function isSlugStopLossCooled(slug: string): boolean {
  const last = stopLossSlugTime.get(slug);
  if (!last) return false;
  return Date.now() - last < config.stopLossSlugCooldownMs;
}
