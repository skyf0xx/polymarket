// src/cooldown.ts
// Per-token cooldown state. Prevents double-firing signals on the same market.
// Also tracks per-slug stop-loss cooldowns to prevent re-entering a volatile event
// after a stop-loss or loss_cut exit.

import { config } from "./config.js";

const lastSignalTime = new Map<string, number>();

// Keyed by event slug. Set when a stop_loss or loss_cut fires on any token in that event.
const stopLossSlugTime = new Map<string, number>();

export function isOnCooldown(tokenId: string): boolean {
  const last = lastSignalTime.get(tokenId);
  if (!last) return false;
  return Date.now() - last < config.cooldownSeconds * 1_000;
}

export function markSignaled(tokenId: string): void {
  lastSignalTime.set(tokenId, Date.now());
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
