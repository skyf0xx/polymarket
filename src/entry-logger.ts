// src/entry-logger.ts
// Append-only log of BUY entries to data/entries.jsonl.
// Each line is a human-readable record you can grep/scan to manually
// verify how a trade played out on Polymarket.

import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { config } from "./config.js";
import type { MatchEntry, SharpLine } from "./types.js";

const ENTRIES_FILE = join(config.dataDir, "entries.jsonl");

if (!existsSync(config.dataDir)) {
  mkdirSync(config.dataDir, { recursive: true });
}

export interface BuyEntry {
  ts: string;
  slug: string;
  homeTeam: string;
  awayTeam: string;
  /** The specific outcome being bought, e.g. "Indiana Pacers", "Over 234.5" */
  betOn: string;
  tokenSide: "YES" | "NO";
  marketType: string;
  /** Spread or total line, if applicable */
  point?: number;
  /** Price paid per share (taker ask) */
  price: number;
  sharpProb: number;
  /** Net edge as a percentage, e.g. 4.2 means 4.2% */
  edgePct: number;
  /** Raw Kelly fraction (before multiplier) */
  kellyFraction: number;
  shares: number;
  /** USDC at risk = shares × price */
  usdcRisk: number;
  dryRun: boolean;
}

/**
 * Derive a human-readable label for the outcome being bet on.
 * For totals: "Over 234.5" / "Under 234.5"
 * For h2h/spreads: the team name from outcomeMap
 */
function resolveBetOn(
  tokenSide: "YES" | "NO",
  match: MatchEntry,
  line: SharpLine,
): string {
  if (match.marketType === "totals") {
    const point = match.point;
    const yesIsOver = match.outcomeMap.Yes.toLowerCase().includes("over");
    const isOver = tokenSide === "YES" ? yesIsOver : !yesIsOver;
    return `${isOver ? "Over" : "Under"}${point !== undefined ? ` ${point}` : ""}`;
  }

  // h2h / spreads — use the outcomeMap name
  const teamName =
    tokenSide === "YES" ? match.outcomeMap.Yes : match.outcomeMap.No;
  if (match.marketType === "spreads" && match.point !== undefined) {
    const sign = match.point > 0 ? `+${match.point}` : `${match.point}`;
    return `${teamName} ${sign}`;
  }
  return teamName;
}

export function appendBuyEntry(
  tokenSide: "YES" | "NO",
  match: MatchEntry,
  line: SharpLine,
  price: number,
  sharpProb: number,
  netEdge: number,
  kellyFraction: number,
  shares: number,
): void {
  const entry: BuyEntry = {
    ts: new Date().toISOString(),
    slug: match.slug,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    betOn: resolveBetOn(tokenSide, match, line),
    tokenSide,
    marketType: match.marketType,
    ...(match.point !== undefined && { point: match.point }),
    price,
    sharpProb,
    edgePct: Math.round(netEdge * 10_000) / 100,
    kellyFraction: Math.round(kellyFraction * 10_000) / 10_000,
    shares,
    usdcRisk: Math.round(shares * price * 100) / 100,
    dryRun: config.dryRun,
  };

  try {
    appendFileSync(ENTRIES_FILE, JSON.stringify(entry) + "\n");
  } catch {
    // Don't crash the bot over logging
  }
}
