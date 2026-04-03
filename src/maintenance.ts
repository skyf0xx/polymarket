// src/maintenance.ts
// Periodic maintenance: refresh markets, positions, prune stale data, run exits.

import { createLogger } from "./logger.js";
import { checkAllExits } from "./exits.js";
import { getUsdcBalance } from "./wallet.js";
import { getActiveValueBetEvents } from "./poller.js";
import { config } from "./config.js";
import type { ClobClient } from "@polymarket/clob-client";
import type { MarketMatcher } from "./market-matcher.js";
import type { PositionTracker } from "./position-tracker.js";
import type { OrderTracker } from "./order-tracker.js";

const log = createLogger("maintenance");

export interface MaintenanceDeps {
  client: ClobClient;
  matcher: MarketMatcher;
  positions: PositionTracker;
  orders: OrderTracker;
  getBankroll: () => number;
  setBankroll: (b: number) => void;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startMaintenance(deps: MaintenanceDeps): void {
  log.info("Starting maintenance timer");
  timer = setInterval(() => void runMaintenance(deps), config.maintenanceIntervalMs);
}

export function stopMaintenance(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function runMaintenance(deps: MaintenanceDeps): Promise<void> {
  log.info("Running maintenance cycle...");

  try {
    const { matcher, positions, orders } = deps;

    // 1. Re-sync positions from Data API
    await positions.hydrate();

    // 2. Refresh bankroll
    const freshBalance = await getUsdcBalance();
    if (freshBalance !== null) {
      deps.setBankroll(freshBalance);
    }

    // 3. Prune expired data
    matcher.pruneExpired();
    orders.pruneExpired();

    // 4. Check all open positions for exit signals
    await checkAllExits({
      client: deps.client,
      matcher,
      positions,
      orders,
      activeValueBetEvents: getActiveValueBetEvents(),
    });

    log.info(
      `Maintenance complete: matches=${matcher.size}, positions=${positions.size}, pending=${orders.pendingCount}`,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Maintenance error: ${message}`);
  }
}
