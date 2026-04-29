// src/maintenance.ts
// Periodic maintenance: refresh positions, prune stale data, run exits.

import { ethers } from "ethers";
import { createLogger } from "./logger.js";
import { checkAllExits } from "./exits.js";
import { redeemResolvedPositions } from "./redeemer.js";
import { getUsdcBalance } from "./wallet.js";
import { getActiveValueBetSlugs } from "./poller.js";
import { config } from "./config.js";
import type { ClobClient } from "@polymarket/clob-client-v2";
import type { PositionTracker } from "./position-tracker.js";
import type { OrderTracker } from "./order-tracker.js";

const log = createLogger("maintenance");

export interface MaintenanceDeps {
  client: ClobClient;
  signer: ethers.Signer;
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
    const { positions, orders } = deps;

    // 1. Re-sync positions from Data API
    await positions.hydrate();

    // 2. Refresh bankroll
    const freshBalance = await getUsdcBalance();
    if (freshBalance !== null) {
      deps.setBankroll(freshBalance);
    }

    // 3. Prune expired orders
    orders.pruneExpired();

    // 4. Redeem resolved positions on-chain
    await redeemResolvedPositions(deps.signer, positions);

    // 5. Check all open positions for exit signals
    await checkAllExits({
      client: deps.client,
      positions,
      orders,
      activeValueBetSlugs: getActiveValueBetSlugs(),
    });

    log.info(
      `Maintenance complete: positions=${positions.size}, pending=${orders.pendingCount}`,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Maintenance error: ${message}`);
  }
}
