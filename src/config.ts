// src/config.ts
// Validated configuration from environment variables.

import "dotenv/config";

function env(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v === undefined || v === "") {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
  return v;
}

function envNum(key: string, fallback?: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
  const n = Number(raw);
  if (Number.isNaN(n)) {
    console.error(`Env var ${key} must be a number, got: "${raw}"`);
    process.exit(1);
  }
  return n;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

// -- Validated Config Object --------------------------------------------------

export const config = {
  // Wallet / CLOB
  privateKey: env("PRIVATE_KEY"),
  funderAddress: env("FUNDER_ADDRESS"),
  signatureType: envNum("SIGNATURE_TYPE", 2),

  // Odds API
  oddsApiKey: env("ODDS_API_KEY"),
  oddsApiRestUrl: env("ODDS_API_REST_URL", "https://api.odds-api.io"),

  // Polymarket
  clobApiUrl: "https://clob.polymarket.com",
  gammaApiUrl: "https://gamma-api.polymarket.com",
  userWsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/user",

  // Edge & Sizing
  minEdge: envNum("MIN_EDGE", 0.06),
  minPrice: envNum("MIN_PRICE", 0.1),
  // Minimum signal price for new BUY entries. Longshots below this threshold have
  // wide spreads and fee drag that consumes edge. Default: 0.15 (15c).
  minEntryPrice: envNum("MIN_ENTRY_PRICE", 0.15),
  kellyFraction: envNum("KELLY_FRACTION", 0.5),
  maxKellyPct: envNum("MAX_KELLY_PCT", 0.02),
  maxPositionPct: envNum("MAX_POSITION_PCT", 0.1),
  maxEventPct: envNum("MAX_EVENT_PCT", 0.1),

  // Timing
  cooldownSeconds: envNum("COOLDOWN_SECONDS", 30),
  maintenanceIntervalMs: envNum("MAINTENANCE_INTERVAL_MS", 300_000),
  maxNegativeEdgeChecks: envNum("MAX_NEGATIVE_EDGE_CHECKS", 3),
  // How long (ms) to block new BUY signals on a slug after a stop_loss or loss_cut fires.
  // Prevents re-entering a fast-moving event that already stopped us out.
  // Default: 60 minutes. Set to 0 to disable.
  stopLossSlugCooldownMs: envNum("STOP_LOSS_SLUG_COOLDOWN_MS", 3_600_000),

  // Exit thresholds
  // Minimum price improvement as a fraction of entry price to trigger lock_gain.
  // e.g. 0.05 = price must improve by ≥5% of avgPrice (0.50 entry → needs 0.525 bid).
  // Scales correctly across the full 0.10–0.90 price range.
  minLockGainPricePct: envNum("MIN_LOCK_GAIN_PRICE_PCT", 0.05),
  // Minimum gross profit as a fraction of position cost (avgPrice × size) to trigger lock_gain.
  // e.g. 0.03 = must earn ≥3% of what was deployed. Prevents noise exits on large cheap positions.
  minLockGainReturnPct: envNum("MIN_LOCK_GAIN_RETURN_PCT", 0.03),
  // Hard stop-loss: exit immediately if bestBid falls below avgPrice × (1 - stopLossPct).
  // Fires unconditionally — even while the Odds API signal is still active.
  // e.g. 0.25 = exit if price drops 25% from entry (0.50 entry → exit at ≤0.375).
  stopLossPct: envNum("STOP_LOSS_PCT", 0.25),
  // Loss floor for loss_cut (edge-gone path only). Actual floor = max(stopLossFloorMin, avgPrice × stopLossFloorPct).
  // Scales with entry price so cheap tokens get cut faster and expensive ones get more room.
  // e.g. at 0.15 entry: max(0.02, 0.15×0.08) = 0.02 (2c). At 0.60 entry: max(0.02, 0.60×0.08) = 0.048 (4.8c).
  stopLossFloorPct: envNum("STOP_LOSS_FLOOR_PCT", 0.08),
  stopLossFloorMin: envNum("STOP_LOSS_FLOOR_MIN", 0.02),
  // Hard stop minimum tick distance — prevents stop from sitting inside the spread on cheap tokens.
  // e.g. 0.05 = stop must be at least 5 ticks (5c) below entry regardless of stopLossPct.
  stopLossMinDrop: envNum("STOP_LOSS_MIN_DROP", 0.05),

  // Operation
  verbose: envBool("VERBOSE", false),
  dryRun: envBool("DRY_RUN", false),
  dataDir: env("DATA_DIR", "./data"),
  credsFile: env("CREDS_FILE", "./api_creds.json"),

  // Value Bet Poller
  valueBetPollIntervalMs: envNum("VALUE_BET_POLL_INTERVAL_MS", 5_000),
  // Maximum age of a value-bet signal (ms). Signals older than this are skipped —
  // Polymarket has had time to correct the price. Default: 5 minutes.
  maxSignalAgeMs: envNum("MAX_SIGNAL_AGE_MS", 5 * 60 * 1_000),

  // Polygon RPC
  polygonRpc: env("POLYGON_RPC", "https://polygon-rpc.com"),
} as const;

export type Config = typeof config;
