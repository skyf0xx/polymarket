// src/index.ts
// Entry point — init CLOB client, instantiate all modules, run startup sequence.

import { ethers } from "ethers";
import { ClobClient, ApiKeyCreds } from "@polymarket/clob-client";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { OddsStream } from "./odds-stream.js";
import { PriceCache } from "./price-cache.js";
import {
  MarketMatcher,
  fetchPolymarketSportsMarkets,
} from "./market-matcher.js";
import { PositionTracker } from "./position-tracker.js";
import { PendingOrders } from "./pending-orders.js";
import { PendingSignals } from "./pending-signals.js";
import { Coordinator } from "./coordinator.js";
import { UserStream } from "./user-stream.js";
import { getUsdcBalance } from "./wallet.js";
import { readFileSync, existsSync, writeFileSync, renameSync } from "fs";

const log = createLogger("main");

const CHAIN_ID = 137; // Polygon mainnet

// ── CLOB Client Setup ─────────────────────────────────────────────

function makeClobClient(
  signer: ethers.Wallet,
  creds?: ApiKeyCreds,
): ClobClient {
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

  log.info(`Signer address: ${signer.address}`);
  log.info(`Funder address: ${config.funderAddress}`);

  if (existsSync(config.credsFile)) {
    try {
      const creds = JSON.parse(readFileSync(config.credsFile, "utf-8")) as ApiKeyCreds;
      log.info(`Loaded API credentials from ${config.credsFile}`);
      return makeClobClient(signer, creds);
    } catch {
      log.warn("Could not parse creds file, will create new credentials");
    }
  }

  // Derive/create new credentials
  log.info("Deriving API credentials...");
  const creds = await makeClobClient(signer).createOrDeriveApiKey();
  const tmp = config.credsFile + ".tmp";
  writeFileSync(tmp, JSON.stringify(creds, null, 2));
  renameSync(tmp, config.credsFile);
  log.info("API credentials created and saved");
  return makeClobClient(signer, creds);
}

// ── Health Logging ────────────────────────────────────────────────

function startHealthLogging(
  odds: OddsStream,
  prices: PriceCache,
  matcher: MarketMatcher,
  positions: PositionTracker,
  coordinator: Coordinator,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    log.info("HEALTH", {
      oddsEvents: odds.size,
      priceTokens: prices.size,
      matches: matcher.size,
      tradeableMatches: matcher.getTradeableMatches().length,
      openPositions: positions.size,
      totalDeployed: positions.getTotalDeployed(),
      dryRun: config.dryRun,
      bankroll: coordinator.bankroll,
    });
  }, 60_000); // every minute
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log.info("═══════════════════════════════════════════════");
  log.info("  Edge Detection Bot — Starting Up");
  log.info(`  DRY_RUN=${config.dryRun}  MARKET_MAKER=${config.marketMaker}`);
  log.info(`  Odds API sports: ${config.oddsApiSports.join(", ")}`);
  log.info(`  Polymarket sports types: ${config.polymarketSportsTypes.join(", ")}`);
  log.info(`  Min edge: ${(config.minEdge * 100).toFixed(1)}%`);
  log.info(`  Kelly fraction: ${config.kellyFraction}`);
  log.info("═══════════════════════════════════════════════");

  // 1. Init CLOB client
  const client = await initClobClient();

  // 2. Fetch on-chain bankroll
  log.info("Fetching on-chain USDC balance...");
  const bankroll = await getUsdcBalance();
  if (bankroll === null || bankroll <= 0) {
    log.error("Could not fetch USDC balance or balance is zero — aborting");
    process.exit(1);
  }
  log.info(`  Bankroll: $${bankroll.toFixed(2)}`);

  if (config.oddsApiSports.length === 0) {
    log.error("ODDS_API_SPORTS is empty — set comma-separated sport keys (e.g. basketball,football,american-football)");
    process.exit(1);
  }

  // 3. Instantiate modules
  const odds = new OddsStream();
  const prices = new PriceCache();
  const matcher = new MarketMatcher();
  const positions = new PositionTracker();
  const pendingOrders = new PendingOrders();
  const pendingSignals = new PendingSignals();
  const coordinator = new Coordinator(client, odds, prices, matcher, positions, pendingOrders, pendingSignals, bankroll);

  // 4. Fetch Polymarket sports markets from Gamma
  log.info("Fetching active sports markets from Gamma...");
  const polymarkets = await fetchPolymarketSportsMarkets();
  log.info(`Found ${polymarkets.length} active sports market(s)`);

  // 5. Hydrate team knowledge from Gamma Teams API
  log.info(`Hydrating team knowledge for leagues: [${config.gammaLeagues.join(", ")}]`);
  await matcher.hydrateTeams(config.gammaLeagues);

  // 6. Hydrate positions from Polymarket Data API (critical — no WS alternative)
  log.info("Hydrating positions from Data API...");
  await positions.hydrate();

  // 7. Start odds stream (REST hydrate then WS — cache pre-populated before matching)
  log.info("Starting odds stream...");
  await odds.start();

  // 8. Run initial match cycle (odds cache is now populated)
  log.info("Running initial market match cycle...");
  const { newMatches, total } = await matcher.runMatchCycle(
    odds.getAllLines(),
    polymarkets,
  );
  log.info(`Initial matching: ${newMatches} new, ${total} total matches`);

  // 9. Start price cache with matched token IDs (WS with initial_dump snapshots)
  const tokenIds = matcher.getAllTokenIds();
  log.info(`Starting price cache for ${tokenIds.length} token(s)...`);
  prices.start(tokenIds);

  // 10. Start coordinator (wires event listeners + maintenance timer)
  coordinator.start();

  // 11. Start user stream (authenticated WS for trade confirmations)
  const userStream = new UserStream(positions, pendingOrders, pendingSignals, matcher, config.credsFile);
  userStream.start();

  // 12. Health logging
  const healthTimer = startHealthLogging(odds, prices, matcher, positions, coordinator);

  log.info("═══════════════════════════════════════════════");
  log.info("  Bot is live. Listening for edge signals.");
  log.info("═══════════════════════════════════════════════");

  // ── Graceful Shutdown ───────────────────────────────────────────

  const shutdown = (signal: string) => {
    log.info(`Received ${signal}, shutting down...`);
    clearInterval(healthTimer);
    coordinator.destroy();
    userStream.destroy();
    prices.destroy();
    odds.destroy();
    log.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error(`Fatal startup error: ${err.message ?? err}`);
  process.exit(1);
});
