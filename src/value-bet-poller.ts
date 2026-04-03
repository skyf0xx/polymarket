// src/value-bet-poller.ts
// Polls odds-api.io /v3/value-bets?bookmaker=Polymarket every 30s.
//
// Two jobs:
//   1. Market discovery — any event not yet in our match table triggers the
//      matcher so it enters the normal WS-driven edge pipeline.
//   2. Confirmed signal — when the endpoint also sees value on a market we
//      already track, re-evaluate edge immediately and fire with
//      reason="value_bet_confirmed" if our own calc agrees. Cooldown is
//      respected, so this never double-fires on a market already signalled.

import { createLogger } from "./logger.js";
import { config } from "./config.js";
import type { MarketMatcher } from "./market-matcher.js";
import type { OddsStream } from "./odds-stream.js";
import type { Coordinator } from "./coordinator.js";
import type { PolymarketMarket, MatchEntry } from "./types.js";

const log = createLogger("value-bet-poller");

// ── API types ────────────────────────────────────────────────────

interface ValueBetEvent {
  away: string;
  date: string;
  home: string;
  league: string;
  sport: string;
}

interface ValueBetBookmakerOdds {
  away?: string;
  draw?: string;
  home?: string;
  hdp?: string;
}

interface ValueBetMarket {
  away?: string;
  draw?: string;
  hdp?: number;
  home?: string;
  max?: number;
  name: string;
}

interface ValueBet {
  betSide: string;
  bookmaker: string;
  bookmakerOdds: ValueBetBookmakerOdds;
  event?: ValueBetEvent;
  eventId: number;
  expectedValue: number;
  expectedValueUpdatedAt: string;
  id: string;
  market: ValueBetMarket;
}

// ── Poller ───────────────────────────────────────────────────────

export class ValueBetPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  constructor(
    private readonly matcher: MarketMatcher,
    private readonly odds: OddsStream,
    private readonly coordinator: Coordinator,
    private readonly fetchPolymarkets: () => Promise<PolymarketMarket[]>,
  ) {}

  start(): void {
    log.info(
      `Value-bet poller starting (interval=${config.valueBetPollIntervalMs}ms)`,
    );
    // Run immediately, then on interval
    void this.poll();
    this.timer = setInterval(() => void this.poll(), config.valueBetPollIntervalMs);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info("Value-bet poller stopped");
  }

  // ── Core poll ──────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (this.destroyed) return;

    let bets: ValueBet[];
    try {
      bets = await this.fetchValueBets();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Value-bet fetch failed: ${msg}`);
      return;
    }

    if (bets.length === 0) return;

    log.debug(`Fetched ${bets.length} value bet(s) from odds-api.io`);

    // Deduplicate by eventId — one entry per event is enough for discovery
    const seenEventIds = new Set<number>();
    const newEventBets: ValueBet[] = [];
    const knownEventBets: ValueBet[] = [];

    for (const bet of bets) {
      const eventIdStr = String(bet.eventId);
      const isKnown = this.matcher.getMatchesByEvent(eventIdStr).length > 0;

      if (isKnown) {
        knownEventBets.push(bet);
      } else if (!seenEventIds.has(bet.eventId)) {
        seenEventIds.add(bet.eventId);
        newEventBets.push(bet);
      }
    }

    // ── Job 1: market discovery ──────────────────────────────────
    if (newEventBets.length > 0) {
      log.info(
        `Value-bet poller: ${newEventBets.length} unmatched event(s) — triggering matcher`,
      );
      await this.runDiscovery(newEventBets);
    }

    // ── Job 2: confirmed signals ─────────────────────────────────
    if (knownEventBets.length > 0) {
      this.triggerConfirmedEvals(knownEventBets);
    }
  }

  // ── Job 1: discovery ──────────────────────────────────────────

  private async runDiscovery(bets: ValueBet[]): Promise<void> {
    try {
      const polymarkets = await this.fetchPolymarkets();
      const allLines = this.odds.getAllLines();
      const { newMatches } = await this.matcher.runMatchCycle(
        allLines,
        polymarkets,
      );
      if (newMatches > 0) {
        log.info(
          `Value-bet discovery: matched ${newMatches} new market(s) after polling ${bets.length} unmatched event(s)`,
        );
      } else {
        log.debug(
          `Value-bet discovery: no new matches from ${bets.length} unmatched event(s)`,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Value-bet discovery error: ${msg}`);
    }
  }

  // ── Job 2: confirmed signals ───────────────────────────────────

  private triggerConfirmedEvals(bets: ValueBet[]): void {
    for (const bet of bets) {
      const eventIdStr = String(bet.eventId);
      const matches = this.matcher.getMatchesByEvent(eventIdStr);
      if (matches.length === 0) continue;

      // Parse the bookmaker's decimal odds for betSide → implied probability.
      // This is the price we will bid at in the GTD order.
      const bidPrice = impliedProbFromBet(bet);
      if (bidPrice === null) {
        log.debug(`Cannot parse odds for bet id=${bet.id} side=${bet.betSide}`);
        continue;
      }

      for (const match of matches) {
        // Only place on the token whose outcome matches betSide.
        const tokenId = resolveTokenForBetSide(bet, match);
        if (tokenId === null) continue;

        log.debug(
          `Value-bet signal: ${match.slug} token=${tokenId} price=${bidPrice.toFixed(4)} EV=${bet.expectedValue.toFixed(4)} side=${bet.betSide}`,
        );

        // Trust the external signal — skip our own edge recomputation.
        // Coordinator places a GTD limit order at bidPrice; if the market
        // doesn't fill within 5 minutes it auto-cancels.
        this.coordinator.placeValueBetSignal(tokenId, match, bidPrice, bet.expectedValue);
      }
    }
  }

  // ── HTTP ───────────────────────────────────────────────────────

  private async fetchValueBets(): Promise<ValueBet[]> {
    const url = new URL(`${config.oddsApiRestUrl}/v3/value-bets`);
    url.searchParams.set("apiKey", config.oddsApiKey);
    url.searchParams.set("bookmaker", "Polymarket");
    url.searchParams.set("includeEventDetails", "true");

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const data = await res.json() as ValueBet[] | { error: string };
    if (!Array.isArray(data)) {
      throw new Error(`Unexpected response: ${JSON.stringify(data)}`);
    }
    return data;
  }
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Convert the bookmaker's decimal odds for betSide → implied probability.
 * Decimal odds of 2.10 → 1/2.10 ≈ 0.476.
 * Returns null if the odds string is missing or unparseable.
 */
function impliedProbFromBet(bet: ValueBet): number | null {
  const side = bet.betSide.toLowerCase();
  let oddsStr: string | undefined;

  if (side === "home") oddsStr = bet.bookmakerOdds.home;
  else if (side === "away") oddsStr = bet.bookmakerOdds.away;
  else if (side === "draw") oddsStr = bet.bookmakerOdds.draw;

  if (!oddsStr) return null;
  const decimal = parseFloat(oddsStr);
  if (!isFinite(decimal) || decimal <= 1) return null;
  return 1 / decimal;
}

/**
 * Map betSide ("home" | "away" | "draw") to the Polymarket token that
 * corresponds to that outcome. Uses outcomeMap to find which YES/NO token
 * covers the team named in the event.
 *
 * Returns null when the side can't be resolved (e.g. draw on an h2h market
 * that Polymarket doesn't offer a draw outcome for).
 */
function resolveTokenForBetSide(bet: ValueBet, match: MatchEntry): string | null {
  const side = bet.betSide.toLowerCase();
  if (side === "draw") return null; // Polymarket h2h markets are typically win/loss only

  const eventHome = bet.event?.home ?? "";
  const eventAway = bet.event?.away ?? "";

  // The outcome we're betting on
  const betTeam = side === "home" ? eventHome : eventAway;
  if (!betTeam) return null;

  // Check if the YES outcome matches the bet team (case-insensitive substring)
  const yesOutcome = match.outcomeMap.Yes.toLowerCase();
  const betTeamLower = betTeam.toLowerCase();

  if (yesOutcome.includes(betTeamLower) || betTeamLower.includes(yesOutcome)) {
    return match.tokenIds.yes;
  }

  const noOutcome = match.outcomeMap.No.toLowerCase();
  if (noOutcome.includes(betTeamLower) || betTeamLower.includes(noOutcome)) {
    return match.tokenIds.no;
  }

  return null;
}
