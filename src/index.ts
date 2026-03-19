// src/index.ts
// Entry point: initialise CLOB client, run the poll → execute loop.

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { pollNewTrades, getUsdcBalance, type TargetTrade } from "./poller.js";
import { executeTrade, type SizingConfig } from "./executor.js";

const CREDS_FILE = "./api_creds.json";

// ── Config from env ──────────────────────────────────────────────
function env(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (!v) {
    console.error(`Missing env var: ${key}. See .env.example`);
    process.exit(1);
  }
  return v;
}

const PRIVATE_KEY = env("PRIVATE_KEY");
const FUNDER_ADDRESS = env("FUNDER_ADDRESS");
const SIGNATURE_TYPE = Number(env("SIGNATURE_TYPE", "2"));
const TARGET_WALLET = env("TARGET_WALLET");
const SIZING_MODE = env("SIZING_MODE", "fixed");
const SIZING_VALUE = Number(env("SIZING_VALUE", "10"));
const POLL_INTERVAL_MS = Number(env("POLL_INTERVAL_MS", "300000"));
const MAX_SLIPPAGE = Number(env("MAX_SLIPPAGE", "0.05"));
const MY_BANKROLL = process.env["MY_BANKROLL"]
  ? Number(process.env["MY_BANKROLL"])
  : null;

// ── Helpers ───────────────────────────────────────────────────────
function makeClobClient(
  wallet: Wallet,
  signatureType: number,
  funderAddress: string,
  creds?: any,
): ClobClient {
  return new ClobClient(
    "https://clob.polymarket.com",
    137,
    wallet,
    creds,
    signatureType,
    funderAddress,
  );
}

async function createAuthedClient(
  wallet: Wallet,
  signatureType: number,
  funderAddress: string,
): Promise<ClobClient> {
  if (existsSync(CREDS_FILE)) {
    try {
      const creds = JSON.parse(readFileSync(CREDS_FILE, "utf-8"));
      console.log(`   Loaded API credentials from ${CREDS_FILE} (key: ${creds.key.slice(0, 8)}...)`);
      return makeClobClient(wallet, signatureType, funderAddress, creds);
    } catch {
      console.warn(`   Could not read ${CREDS_FILE}, re-deriving...`);
    }
  }

  console.log("   Deriving API credentials...");
  const creds = await makeClobClient(
    wallet,
    signatureType,
    funderAddress,
  ).createOrDeriveApiKey();
  writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2));
  console.log(`   API key: ${creds.key.slice(0, 8)}... (saved to ${CREDS_FILE})`);
  return makeClobClient(wallet, signatureType, funderAddress, creds);
}

/** Keep only the first trade per (asset, side) pair within a batch. */
function deduplicateTrades(trades: TargetTrade[]): TargetTrade[] {
  const seen = new Set<string>();
  return trades.filter((t) => {
    const key = `${t.asset}:${t.side}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log("🤖 Polymarket Copy Trader");
  console.log(`   Target: ${TARGET_WALLET}`);
  console.log(`   Sizing: ${SIZING_MODE} = ${SIZING_VALUE}`);
  console.log(`   Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`   Max slippage: ${MAX_SLIPPAGE}`);
  console.log();

  // 1. Create wallet signer
  const wallet = new Wallet(PRIVATE_KEY);
  console.log(`   Your signer: ${wallet.address}`);
  console.log(`   Funder: ${FUNDER_ADDRESS}`);
  console.log();

  // 2. Create CLOB client & derive API creds
  const authedClient = await createAuthedClient(
    wallet,
    SIGNATURE_TYPE,
    FUNDER_ADDRESS,
  );

  // 3. Initial poll (mark existing trades as seen, don't execute)
  console.log("\n   Initial sync — marking existing trades as seen...");
  const initial = await pollNewTrades(TARGET_WALLET);
  console.log(
    `   Marked ${initial.length} existing trades. Will only copy NEW trades.\n`,
  );

  // 4. Verify bankroll is fetchable before entering poll loop
  if (SIZING_MODE === "percent") {
    console.log("   Verifying bankroll (percent mode)...");
    const bankroll = MY_BANKROLL ?? (await getUsdcBalance(FUNDER_ADDRESS));
    if (!bankroll || bankroll <= 0) {
      console.error(
        `   ERROR: Could not fetch bankroll for FUNDER_ADDRESS=${FUNDER_ADDRESS}.\n` +
          `   Either the address has no USDC on Polymarket, or the API is unreachable.\n` +
          `   Tip: set MY_BANKROLL=<amount> in .env to override.`,
      );
      process.exit(1);
    }
    console.log(`   Bankroll: $${bankroll.toFixed(2)} ✓\n`);
  }

  // 5. Poll loop
  console.log("   Entering poll loop...\n");

  const tick = async () => {
    try {
      const trades = await pollNewTrades(TARGET_WALLET);
      if (trades.length === 0) {
        console.log(`[${new Date().toISOString()}] No new trades`);
        return;
      }

      // Build sizing config. For percent mode, refresh portfolio values each tick.
      const sizing: SizingConfig = {
        mode: SIZING_MODE as SizingConfig["mode"],
        value: SIZING_VALUE,
        targetValue: null,
        myBankroll: null,
      };

      if (sizing.mode === "percent") {
        sizing.targetValue = await getUsdcBalance(TARGET_WALLET);
        sizing.myBankroll =
          MY_BANKROLL ?? (await getUsdcBalance(FUNDER_ADDRESS));
        console.log(
          `[${new Date().toISOString()}] Percent mode — target portfolio: $${sizing.targetValue?.toFixed(2) ?? "?"}, my bankroll: $${sizing.myBankroll?.toFixed(2) ?? "?"}`,
        );
      }

      const uniqueTrades = deduplicateTrades(trades);
      const skipped = trades.length - uniqueTrades.length;
      console.log(
        `[${new Date().toISOString()}] ${trades.length} new trade(s) detected` +
          (skipped > 0 ? `, ${skipped} duplicate(s) skipped` : "") + ":",
      );
      for (const t of uniqueTrades) {
        await executeTrade(authedClient, t, sizing, MAX_SLIPPAGE);
      }
    } catch (err: any) {
      console.error(`[poll error]`, err.message ?? err);
    }
  };

  setInterval(tick, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
