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

function envList(key: string, fallback: string[] = []): string[] {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
  oddsApiSports: envList("ODDS_API_SPORTS", []),

  // Polymarket
  clobApiUrl: "https://clob.polymarket.com",
  gammaApiUrl: "https://gamma-api.polymarket.com",
  userWsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/user",

  // Edge & Sizing
  minEdge: envNum("MIN_EDGE", 0.02),
  minPrice: envNum("MIN_PRICE", 0.1),
  kellyFraction: envNum("KELLY_FRACTION", 0.25),
  maxKellyPct: envNum("MAX_KELLY_PCT", 0.02),
  maxPositionPct: envNum("MAX_POSITION_PCT", 0.1),
  maxEventPct: envNum("MAX_EVENT_PCT", 0.15),

  // Timing
  cooldownSeconds: envNum("COOLDOWN_SECONDS", 30),
  maintenanceIntervalMs: envNum("MAINTENANCE_INTERVAL_MS", 300_000),
  maxNegativeEdgeChecks: envNum("MAX_NEGATIVE_EDGE_CHECKS", 5),

  // Exit thresholds
  // Minimum price improvement as a fraction of entry price to trigger lock_gain.
  // e.g. 0.05 = price must improve by ≥5% of avgPrice (0.50 entry → needs 0.525 bid).
  // Scales correctly across the full 0.10–0.90 price range.
  minLockGainPricePct: envNum("MIN_LOCK_GAIN_PRICE_PCT", 0.05),
  // Minimum gross profit as a fraction of position cost (avgPrice × size) to trigger lock_gain.
  // e.g. 0.03 = must earn ≥3% of what was deployed. Prevents noise exits on large cheap positions.
  minLockGainReturnPct: envNum("MIN_LOCK_GAIN_RETURN_PCT", 0.03),

  // Operation
  verbose: envBool("VERBOSE", false),
  dryRun: envBool("DRY_RUN", true),
  dataDir: env("DATA_DIR", "./data"),
  credsFile: env("CREDS_FILE", "./api_creds.json"),

  // Value Bet Poller
  valueBetPollIntervalMs: envNum("VALUE_BET_POLL_INTERVAL_MS", 30_000),

  // Polygon RPC
  polygonRpc: env("POLYGON_RPC", "https://polygon-rpc.com"),
} as const;

export type Config = typeof config;
