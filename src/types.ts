// src/types.ts
// Shared interfaces for the value-bet bot.

// -- Odds Event (from value-bets endpoint) ------------------------------------

export interface OddsEvent {
  id: string;
  sport: string;
  league: string;
  home: string;
  away: string;
  time: string;
}

// -- Market Matching ----------------------------------------------------------

export type MarketType = "h2h" | "spreads" | "totals";
export type MatchConfidence = "high" | "medium" | "low";

export interface MatchEntry {
  slug: string;
  oddsApiEventId: string;
  sportKey: string;
  leagueSlug?: string;
  homeTeam: string;
  awayTeam: string;
  outcomeMap: { Yes: string; No: string };
  marketType: MarketType;
  point?: number;
  confidence: MatchConfidence;
  matchedAt: number;
  commence: number;
  active: boolean;
  tokenIds: { yes: string; no: string };
}

// -- Position Tracking --------------------------------------------------------

export interface Position {
  tokenId: string;
  slug: string;
  side: "YES" | "NO";
  avgPrice: number;
  size: number;
  totalCost: number;
  openedAt: number;
}

// -- Trade Signals ------------------------------------------------------------

export interface TradeSignal {
  tokenId: string;
  slug: string;
  side: "BUY" | "SELL";
  tokenSide: "YES" | "NO";
  price: number;
  size: number;
  edge: number;
  kellyFraction: number;
  reason: "value_bet_confirmed" | "exit_signal";
}

// -- Polymarket Market Metadata -----------------------------------------------

export interface PolymarketMarket {
  slug: string;
  question: string;
  outcomes: string[];
  outcomePrices: string[];
  tokenIds: string[];
  endDate: string;
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  groupItemTitle?: string;
  conditionId: string;
}

// -- Logger -------------------------------------------------------------------

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  module: string;
  msg: string;
  data?: Record<string, unknown>;
}
