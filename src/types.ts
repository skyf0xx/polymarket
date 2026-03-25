// src/types.ts
// Shared interfaces and enums for the edge detection bot.

// ── Sharp Odds (from The Odds API) ──────────────────────────────

export interface H2HMarket {
  home: number; // implied probability
  away: number;
  draw?: number;
}

export interface SpreadMarket {
  home: number;
  away: number;
  point: number;
}

export interface TotalsMarket {
  over: number;
  under: number;
  point: number;
}

export interface SharpLine {
  eventId: string;
  sportKey: string;
  leagueSlug: string; // e.g. "nba", "ncaab", "epl" — from Odds API league.slug
  homeTeam: string;
  awayTeam: string;
  commence: number; // unix ms
  markets: {
    h2h?: H2HMarket;
    spreads?: SpreadMarket[];  // all available lines, indexed by .point
    totals?: TotalsMarket[];   // all available lines, indexed by .point
  };
  updatedAt: number;
}

// ── Polymarket Price Cache ──────────────────────────────────────

export interface PriceEntry {
  tokenId: string;
  price: number;      // midpoint (for display / logging)
  bestBid: number;    // best bid — what you receive as a taker seller
  bestAsk: number;    // best ask — what you pay as a taker buyer
  updatedAt: number;
}

// ── Market Matching ─────────────────────────────────────────────

export type MarketType = "h2h" | "spreads" | "totals";
export type MatchConfidence = "high" | "medium" | "low";

export interface MatchEntry {
  slug: string;
  oddsApiEventId: string;
  sportKey: string;
  leagueSlug?: string; // e.g. "nba", "ncaab" — from Odds API league.slug
  homeTeam: string;
  awayTeam: string;
  outcomeMap: { Yes: string; No: string }; // "Yes" → "Los Angeles Lakers"
  marketType: MarketType;
  point?: number; // for spreads/totals
  confidence: MatchConfidence;
  matchedAt: number;
  commence: number; // unix ms — event start time from Odds API
  active: boolean; // false once Polymarket market is resolved/closed
  tokenIds: { yes: string; no: string };
}

// ── Position Tracking ───────────────────────────────────────────

export interface Position {
  tokenId: string;
  slug: string;
  side: "YES" | "NO";
  avgPrice: number;
  size: number; // shares held
  totalCost: number; // USDC spent
  openedAt: number;
}

// ── Edge & Trade Signals ────────────────────────────────────────

export interface EdgeResult {
  grossEdge: number;
  fee: number;
  netEdge: number;
  kellyFraction: number;
  suggestedSize: number; // USDC
  tradeable: boolean;
  skipReason?: string;
}

export interface TradeSignal {
  tokenId: string;
  slug: string;
  side: "BUY" | "SELL";
  tokenSide: "YES" | "NO"; // which outcome token this is
  price: number; // market price at detection time
  size: number; // shares
  edge: number; // net edge that triggered this
  kellyFraction: number;
  reason: "edge_detected" | "exit_signal";
}

// ── Polymarket Market Metadata ──────────────────────────────────

export interface PolymarketMarket {
  slug: string;
  question: string;
  outcomes: string[]; // e.g. ["Yes", "No"]
  outcomePrices: string[]; // e.g. ["0.42", "0.58"]
  tokenIds: string[]; // parallel to outcomes
  endDate: string;
  active: boolean;
  closed: boolean;
  groupItemTitle?: string; // often the team name
  conditionId: string;
}

// ── Odds API (odds-api.io v3) REST Types ────────────────────────

export interface OddsApiIoEvent {
  id: number;
  home: string;
  away: string;
  date: string; // ISO
  status: string;
  sport: { name: string; slug: string };
  league: { name: string; slug: string };
}

export interface OddsApiIoMarketOdds {
  home?: string;
  away?: string;
  draw?: string;
  hdp?: number;   // spread line or totals line
  over?: string;
  under?: string;
  max?: number;
}

export interface OddsApiIoMarket {
  name: string; // "ML" | "Spread" | "Totals" | ...
  updatedAt: string;
  odds: OddsApiIoMarketOdds[];
}

// Response from /v3/odds and /v3/odds/multi
export interface OddsApiIoOddsResponse {
  id: number;
  home: string;
  away: string;
  date: string; // ISO
  status: string;
  sport?: { name: string; slug: string };
  league?: { name: string; slug: string };
  bookmakers: Record<string, OddsApiIoMarket[]>;
}

// ── Odds API WebSocket Message Types ────────────────────────────
// WS messages have NO `data` wrapper — fields are directly on the message.

export interface OddsWsWelcome {
  type: "welcome";
  message: string;
  user_id: string;
  bookmakers: string[];
  connected_at: string;
}

// Sent for both "created" and "updated" events
export interface OddsWsEventMessage {
  type: "updated" | "created";
  timestamp: string;
  id: string;   // event ID as string
  bookie: string;
  url?: string;
  markets: OddsApiIoMarket[];
}

export interface OddsWsDeleted {
  type: "deleted";
  timestamp: string;
  id: string;
  bookie: string;
}

export interface OddsWsNoMarkets {
  type: "no_markets";
  timestamp: string;
  id: string;
  bookie: string;
}

export type OddsWsMessage =
  | OddsWsWelcome
  | OddsWsEventMessage
  | OddsWsDeleted
  | OddsWsNoMarkets;

// ── Logger ──────────────────────────────────────────────────────

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  module: string;
  msg: string;
  data?: Record<string, unknown>;
}

export interface EdgeLogEntry extends LogEntry {
  module: "edge";
  data: {
    tokenId: string;
    slug: string;
    sharpProb: number;
    polyPrice: number;
    grossEdge: number;
    netEdge: number;
    kellyFraction: number;
    suggestedSize: number;
    tradeable: boolean;
    skipReason?: string;
  };
}

export interface TradeLogEntry extends LogEntry {
  module: "executor";
  data: {
    tokenId: string;
    slug: string;
    side: "BUY" | "SELL";
    price: number;
    size: number;
    edge: number;
    reason: string;
    orderId?: string;
    success: boolean;
    error?: string;
  };
}
