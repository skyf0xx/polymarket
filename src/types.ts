// src/types.ts
// Shared interfaces for the value-bet bot.

// -- Position Tracking --------------------------------------------------------

export interface Position {
  tokenId: string;
  slug: string;
  side: "YES" | "NO";
  avgPrice: number;
  size: number;
  totalCost: number;
  openedAt: number;
  edgeAtEntry?: number;
  kellyAtEntry?: number;
  exitReason?: string;
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

// -- Logger -------------------------------------------------------------------

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  module: string;
  msg: string;
  data?: Record<string, unknown>;
}
