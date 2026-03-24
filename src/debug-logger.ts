// src/debug-logger.ts
// Strategic debug sampling — writes to data/debug.jsonl.
// Captures a small set of high-value probe points to diagnose matching and
// odds pipeline issues without drowning in noise.
//
// Probe types:
//   signal_probe   — full SharpLine + MatchEntry for every tradeable signal
//   match_created  — LLM/deterministic match result vs the source polymarket data
//   odds_snapshot  — raw parsed SharpLine on hydration (sampled 1-in-N)

import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { config } from "./config.js";
import type { SharpLine, MatchEntry, PolymarketMarket } from "./types.js";

const DEBUG_FILE = join(config.dataDir, "debug.jsonl");

// Cap writes per process lifetime so the file stays manageable
const MAX_WRITES = 500;
let writeCount = 0;

if (!existsSync(config.dataDir)) {
  mkdirSync(config.dataDir, { recursive: true });
}

function write(record: Record<string, unknown>): void {
  if (writeCount >= MAX_WRITES) return;
  try {
    appendFileSync(
      DEBUG_FILE,
      JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n",
    );
    writeCount++;
  } catch {
    // Never crash the bot over debug logging
  }
}

// ── Probe 1: Signal ──────────────────────────────────────────────
// Fired for every tradeable BUY signal.
// Key questions answered:
//   - Does line.markets have the expected market type?
//   - Are the raw odds values sensible?
//   - Is the resolvedProb consistent with the raw odds?

export function probeSignal(
  tokenSide: "YES" | "NO",
  match: MatchEntry,
  line: SharpLine,
  resolvedProb: number,
  polyPrice: number,
  netEdge: number,
): void {
  write({
    probe: "signal_probe",
    slug: match.slug,
    tokenSide,
    marketType: match.marketType,
    point: match.point,
    outcomeMap: match.outcomeMap,
    // The prob we actually used — compare this to the raw market values below
    resolvedProb,
    polyPrice,
    netEdgePct: Math.round(netEdge * 10_000) / 100,
    // Full SharpLine markets — the raw source of truth
    sharpLine: {
      eventId: line.eventId,
      homeTeam: line.homeTeam,
      awayTeam: line.awayTeam,
      commence: new Date(line.commence).toISOString(),
      marketsPresent: Object.keys(line.markets),
      markets: line.markets,
      ageMs: Date.now() - line.updatedAt,
    },
    // Match metadata
    match: {
      oddsApiEventId: match.oddsApiEventId,
      sportKey: match.sportKey,
      confidence: match.confidence,
      matchedAt: new Date(match.matchedAt).toISOString(),
    },
  });
}

// ── Probe 2: Match Created ───────────────────────────────────────
// Fired whenever a new match is persisted (LLM or deterministic).
// Key questions answered:
//   - Did the LLM pick the right event?
//   - Is the outcomeMap correct (Yes → right team)?
//   - Does the matched oddsLine have the required market type?

export function probeMatchCreated(
  match: MatchEntry,
  polymarket: PolymarketMarket,
  oddsLine: SharpLine | undefined,
  source: "llm" | "deterministic",
): void {
  write({
    probe: "match_created",
    source,
    slug: match.slug,
    question: polymarket.question,
    outcomes: polymarket.outcomes,
    marketType: match.marketType,
    point: match.point,
    outcomeMap: match.outcomeMap,
    confidence: match.confidence,
    matchedTo: {
      eventId: match.oddsApiEventId,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      commence: new Date(match.commence || 0).toISOString(),
    },
    oddsLineMarketsPresent: oddsLine ? Object.keys(oddsLine.markets) : null,
    // Include the specific market odds we'll actually use
    relevantMarket: oddsLine?.markets[match.marketType] ?? null,
  });
}

// ── Probe 3: Suspicious Odds ────────────────────────────────────
// Fired when parsed odds look wrong. Logs the raw API response so you
// can see exactly what the bookmaker sent before any parsing.
//
// Triggers:
//   - Either side of a market has implied prob > 0.95 (decimal odds ~1.05 or shorter)
//   - Totals: over + under both > 0.90 (physically impossible — sums to >1.80)
//   - Spreads: |point| > 20 (extreme line unlikely to match any Polymarket market)

export function probeRawOdds(
  parsedLine: SharpLine,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawApiResponse: any,
): void {
  const reasons: string[] = [];

  const { h2h, spreads, totals } = parsedLine.markets;

  if (spreads) {
    for (const s of spreads) {
      if (s.home > 0.95 || s.away > 0.95)
        reasons.push(
          `spread_prob_too_high at ${s.point} (home=${s.home.toFixed(3)}, away=${s.away.toFixed(3)})`,
        );
    }
  }

  if (totals) {
    for (const t of totals) {
      if (t.over > 0.95 || t.under > 0.95)
        reasons.push(
          `totals_prob_too_high at ${t.point} (over=${t.over.toFixed(3)}, under=${t.under.toFixed(3)})`,
        );
      if (t.over > 0.9 && t.under > 0.9)
        reasons.push(
          `totals_both_sides_high at ${t.point} — impossible market`,
        );
    }
  }

  if (h2h) {
    if (h2h.home > 0.97 || h2h.away > 0.97)
      reasons.push(
        `h2h_prob_too_high (home=${h2h.home.toFixed(3)}, away=${h2h.away.toFixed(3)})`,
      );
  }

  if (reasons.length === 0) return;

  write({
    probe: "suspicious_odds",
    reasons,
    event: `${parsedLine.homeTeam} vs ${parsedLine.awayTeam}`,
    eventId: parsedLine.eventId,
    sportKey: parsedLine.sportKey,
    parsedMarkets: parsedLine.markets,
    // Raw API response — this is what the bookmaker actually sent
    rawApiResponse,
  });
}

// ── Probe 4: Odds Hydration Sample ──────────────────────────────
// Fired for a sample of events on REST hydration.
// Key questions answered:
//   - What market names does the bookmaker actually return?
//   - Are spread/totals odds present and sensible for the events we care about?
//
// sampleRate: write 1 out of every N events (default 10)

export function probeOddsHydration(line: SharpLine, sampleRate = 10): void {
  if (Math.random() >= 1 / sampleRate) return;
  write({
    probe: "odds_snapshot",
    eventId: line.eventId,
    homeTeam: line.homeTeam,
    awayTeam: line.awayTeam,
    sportKey: line.sportKey,
    commence: new Date(line.commence).toISOString(),
    marketsPresent: Object.keys(line.markets),
    markets: line.markets,
  });
}
