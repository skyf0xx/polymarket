// src/index.ts
// Entry point: init wallet, hydrate positions, start poller + maintenance.

import { ethers } from "ethers";
import { ClobClient, ApiKeyCreds } from "@polymarket/clob-client";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { PositionTracker } from "./position-tracker.js";
import { OrderTracker } from "./order-tracker.js";
import { UserStream } from "./user-stream.js";
import { startPoller, stopPoller } from "./poller.js";
import { startMaintenance, stopMaintenance } from "./maintenance.js";
import { getUsdcBalance } from "./wallet.js";
import { readFileSync, existsSync, writeFileSync, renameSync } from "fs";

const log = createLogger("main");

const CHAIN_ID = 137;

// -- CLOB Client Setup --------------------------------------------------------

function makeClobClient(signer: ethers.Wallet, creds?: ApiKeyCreds): ClobClient {
  return new ClobClient(
    config.clobApiUrl,
    CHAIN_ID,
    signer,
    creds,
    config.signatureType,
    config.funderAddress,
  );
}

async function initClobClient(): Promise<ClobClient> {
  const provider = new ethers.providers.JsonRpcProvider(config.polygonRpc);
  const signer = new ethers.Wallet(config.privateKey, provider);

  log.info(`Signer: ${signer.address}`);
  log.info(`Funder: ${config.funderAddress}`);

  if (existsSync(config.credsFile)) {
    try {
      const creds = JSON.parse(readFileSync(config.credsFile, "utf-8")) as ApiKeyCreds;
      log.info(`Loaded API credentials from ${config.credsFile}`);
      return makeClobClient(signer, creds);
    } catch {
      log.warn("Could not parse creds file, will create new credentials");
    }
  }

  log.info("Deriving API credentials...");
  const creds = await makeClobClient(signer).createOrDeriveApiKey();
  const tmp = config.credsFile + ".tmp";
  writeFileSync(tmp, JSON.stringify(creds, null, 2));
  renameSync(tmp, config.credsFile);
  log.info("API credentials created and saved");
  return makeClobClient(signer, creds);
}

// -- Main ---------------------------------------------------------------------

async function main(): Promise<void> {
  log.info("==============================================");
  log.info("  Value-Bet Bot");
  log.info(`  DRY_RUN=${config.dryRun}`);
  log.info(`  Kelly: ${config.kellyFraction}  Cooldown: ${config.cooldownSeconds}s`);
  log.info("==============================================");

  // 1. Init CLOB client
  const client = await initClobClient();

  // 2. Fetch bankroll
  let bankroll = await getUsdcBalance();
  if (bankroll === null || bankroll <= 0) {
    log.error("Could not fetch USDC balance or balance is zero -- aborting");
    process.exit(1);
  }
  log.info(`Bankroll: $${bankroll.toFixed(2)}`);

  // 3. Instantiate modules
  const positions = new PositionTracker();
  const orders = new OrderTracker();

  // 4. Hydrate positions
  log.info("Hydrating positions...");
  await positions.hydrate();

  // 5. Start user stream (fill confirmations)
  const userStream = new UserStream(positions, orders, config.credsFile);
  userStream.start();

  // 6. Start poller (sole signal source)
  startPoller({
    client,
    orders,
    getBankroll: () => bankroll!,
  });

  // 7. Start maintenance (refresh data + exit sweep every 5 min)
  startMaintenance({
    client,
    positions,
    orders,
    getBankroll: () => bankroll!,
    setBankroll: (b) => { bankroll = b; },
  });

  // 8. Health logging
  const healthTimer = setInterval(() => {
    log.info("HEALTH", {
      positions: positions.size,
      pending: orders.pendingCount,
      bankroll,
      dryRun: config.dryRun,
    });
  }, 60_000);

  log.info("==============================================");
  log.info("  Bot is live. Awaiting value-bet signals.");
  log.info("==============================================");

  // -- Graceful Shutdown -------------------------------------------------------

  const shutdown = (signal: string) => {
    log.info(`Received ${signal}, shutting down...`);
    clearInterval(healthTimer);
    stopPoller();
    stopMaintenance();
    userStream.destroy();
    log.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error(`Fatal: ${err.message ?? err}`);
  process.exit(1);
});
