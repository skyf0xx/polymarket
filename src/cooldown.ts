// src/cooldown.ts
// Per-token cooldown state. Prevents double-firing signals on the same market.

import { config } from "./config.js";

const lastSignalTime = new Map<string, number>();

export function isOnCooldown(tokenId: string): boolean {
  const last = lastSignalTime.get(tokenId);
  if (!last) return false;
  return Date.now() - last < config.cooldownSeconds * 1_000;
}

export function markSignaled(tokenId: string): void {
  lastSignalTime.set(tokenId, Date.now());
}
