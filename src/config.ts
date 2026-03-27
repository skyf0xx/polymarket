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

// ── Validated Config Object ──────────────────────────────────────

export const config = {
  // Wallet / CLOB
  privateKey: env("PRIVATE_KEY"),
  funderAddress: env("FUNDER_ADDRESS"),
  signatureType: envNum("SIGNATURE_TYPE", 2),

  // Odds API
  oddsApiKey: env("ODDS_API_KEY"),
  oddsApiWsUrl: env(
    "ODDS_API_WS_URL",
    "wss://api.odds-api.io/v3/ws",
  ),
  oddsApiRestUrl: env("ODDS_API_REST_URL", "https://api.odds-api.io"),
  bookmakerId: env("BOOKMAKER_ID", ""),
  oddsApiSports: envList("ODDS_API_SPORTS", []),
  oddsApiLeagues: envList("ODDS_API_LEAGUES", []),

  // Polymarket
  polymarketSportsTypes: envList("POLYMARKET_SPORTS_TYPES", ["moneyline", "spreads", "totals"]),
  polymarketTagIds: envList("POLYMARKET_TAG_IDS", []),
  polymarketMinLiquidity: envNum("POLYMARKET_MIN_LIQUIDITY", 1000),
  clobApiUrl: "https://clob.polymarket.com",
  gammaApiUrl: "https://gamma-api.polymarket.com",
  polyWsUrl:
    "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  userWsUrl:
    "wss://ws-subscriptions-clob.polymarket.com/ws/user",

  // Strategy
  marketMaker: envBool("MARKET_MAKER", false),

  // Edge & Sizing
  minEdge: envNum("MIN_EDGE", 0.02),
  kellyFraction: envNum("KELLY_FRACTION", 0.25),
  maxKellyPct: envNum("MAX_KELLY_PCT", 0.02),
  maxPositionPct: envNum("MAX_POSITION_PCT", 0.10),
  maxEventPct: envNum("MAX_EVENT_PCT", 0.15),

  // Timing
  cooldownSeconds: envNum("COOLDOWN_SECONDS", 30),
  debounceMs: envNum("DEBOUNCE_MS", 500),
  maintenanceIntervalMs: envNum("MAINTENANCE_INTERVAL_MS", 300_000), // 5 min

  // Operation
  verbose: envBool("VERBOSE", false),
  dryRun: envBool("DRY_RUN", true),
  dataDir: env("DATA_DIR", "./data"),
  credsFile: env("CREDS_FILE", "./api_creds.json"),

  // Gamma Teams API — league codes for team abbreviation hydration
  // These are Polymarket/Gamma league slugs, NOT Odds API slugs
  gammaLeagues: envList("GAMMA_LEAGUES", [
    "nba",
    "cbb",
    "wnba", // basketball
    "nfl",
    "cfb", // american football
    "mlb", // baseball
    "atp",
    "wta", // tennis
    "epl", // premier league
  ]),

  // Maps Gamma/Polymarket league slug (from market slug prefix) → Odds API sport name.
  // Format: "epl:football,nba:basketball,nfl:american-football"
  // Used by the pre-filter in market-matcher to only send relevant odds events to the LLM.
  gammaLeagueToOddsSport: (() => {
    const raw = process.env.GAMMA_LEAGUE_TO_ODDS_API_SPORT ?? "";
    const map = new Map<string, string>([
      // override with env var
      ["epl", "football"],
      ["nba", "basketball"],
      ["nfl", "american-football"],
      ["mlb", "baseball"],
      ["cbb", "basketball"],
      ["wnba", "basketball"],
      ["cfb", "american-football"],
      ["atp", "tennis"],
      ["wta", "tennis"],
    ]);
    for (const pair of raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      const [league, sport] = pair.split(":").map((s) => s.trim());
      if (league && sport) map.set(league, sport);
    }
    return map;
  })(),

  // Anthropic (for market matching)
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  matcherModel: env("MATCHER_MODEL", "claude-haiku-4-5-20251001"),

  // Polygon RPC
  polygonRpc: env("POLYGON_RPC", "https://polygon-rpc.com"),
} as const;

export type Config = typeof config;
