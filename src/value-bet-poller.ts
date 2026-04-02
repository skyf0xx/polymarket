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
import type { PolymarketMarket } from "./types.js";

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

      const line = this.odds.getLine(eventIdStr);
      if (!line) continue;

      for (const match of matches) {
        log.debug(
          `Value-bet confirmed signal candidate: ${match.slug} (EV=${bet.expectedValue.toFixed(4)}, side=${bet.betSide})`,
        );
        // Coordinator re-runs computeEdge with our own formula and only fires
        // if net_edge >= MIN_EDGE and cooldown is clear.
        this.coordinator.triggerEdgeEval(match.tokenIds.yes, match, line, "value_bet_confirmed");
        this.coordinator.triggerEdgeEval(match.tokenIds.no, match, line, "value_bet_confirmed");
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
