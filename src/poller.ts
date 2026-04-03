// src/poller.ts
// Polls odds-api.io /v3/value-bets every 30s.
// Two jobs: market discovery (new events) + signal dispatch (known events).
// Exposes activeValueBetEvents for exit logic to check thesis status.

import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { isOnCooldown, markSignaled } from "./cooldown.js";
import { executeSignal } from "./executor.js";
import type { ClobClient } from "@polymarket/clob-client";
import type { MarketMatcher } from "./market-matcher.js";
import type { OrderTracker } from "./order-tracker.js";
import type { MatchEntry, TradeSignal, OddsEvent } from "./types.js";

const log = createLogger("poller");

// -- API types ----------------------------------------------------------------

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

// -- Active value-bet events (shared with exit logic) -------------------------

/** Set of Odds API event IDs that had value-bets in the latest poll cycle. */
let _activeValueBetEvents = new Set<string>();

export function getActiveValueBetEvents(): Set<string> {
  return _activeValueBetEvents;
}

// -- Poller -------------------------------------------------------------------

export interface PollerDeps {
  client: ClobClient;
  matcher: MarketMatcher;
  orders: OrderTracker;
  getBankroll: () => number;
}

let timer: ReturnType<typeof setInterval> | null = null;
let destroyed = false;

export function startPoller(deps: PollerDeps): void {
  destroyed = false;
  log.info(`Poller starting (interval=${config.valueBetPollIntervalMs}ms)`);
  void poll(deps);
  timer = setInterval(() => void poll(deps), config.valueBetPollIntervalMs);
}

export function stopPoller(): void {
  destroyed = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  log.info("Poller stopped");
}

// -- Core poll ----------------------------------------------------------------

async function poll(deps: PollerDeps): Promise<void> {
  if (destroyed) return;

  let bets: ValueBet[];
  try {
    bets = await fetchValueBets();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Value-bet fetch failed: ${msg}`);
    return;
  }

  // Update the active value-bet events set (used by exit logic)
  _activeValueBetEvents = new Set(bets.map((b) => String(b.eventId)));

  if (bets.length === 0) return;
  log.debug(`Fetched ${bets.length} value bet(s)`);

  // Extract odds events from value-bets and feed to matcher
  const oddsEvents = extractOddsEvents(bets);
  if (oddsEvents.length > 0) {
    deps.matcher.setOddsEvents(oddsEvents);
  }

  const seenEventIds = new Set<number>();
  const newEventBets: ValueBet[] = [];
  const knownEventBets: ValueBet[] = [];

  for (const bet of bets) {
    const isKnown = deps.matcher.getMatchesByEvent(String(bet.eventId)).length > 0;
    if (isKnown) {
      knownEventBets.push(bet);
    } else if (!seenEventIds.has(bet.eventId)) {
      seenEventIds.add(bet.eventId);
      newEventBets.push(bet);
    }
  }

  // Job 1: market discovery
  if (newEventBets.length > 0) {
    log.info(`${newEventBets.length} unmatched event(s) -- triggering matcher`);
    await runDiscovery(deps, newEventBets);
  }

  // Job 2: confirmed signals
  for (const bet of knownEventBets) {
    dispatchSignal(deps, bet);
  }
}

// -- Job 1: discovery ---------------------------------------------------------

async function runDiscovery(deps: PollerDeps, bets: ValueBet[]): Promise<void> {
  try {
    const polymarkets = deps.matcher.getKnownMarkets();
    const { newMatches } = await deps.matcher.runMatchCycle(polymarkets);
    if (newMatches > 0) {
      log.info(`Discovery: matched ${newMatches} new market(s) from ${bets.length} event(s)`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Discovery error: ${msg}`);
  }
}

// -- Extract odds events from value-bets --------------------------------------

function extractOddsEvents(bets: ValueBet[]): OddsEvent[] {
  const seen = new Set<string>();
  const events: OddsEvent[] = [];

  for (const bet of bets) {
    const id = String(bet.eventId);
    if (seen.has(id) || !bet.event) continue;
    seen.add(id);

    events.push({
      id,
      sport: bet.event.sport,
      league: bet.event.league,
      home: bet.event.home,
      away: bet.event.away,
      time: bet.event.date,
    });
  }

  return events;
}

// -- Job 2: signal dispatch ---------------------------------------------------

function dispatchSignal(deps: PollerDeps, bet: ValueBet): void {
  const matches = deps.matcher.getMatchesByEvent(String(bet.eventId));
  if (matches.length === 0) return;

  const bidPrice = impliedProbFromBet(bet);
  if (bidPrice === null) return;

  for (const match of matches) {
    if (match.active === false) continue;

    const tokenId = resolveTokenForBetSide(bet, match);
    if (tokenId === null) continue;

    if (isOnCooldown(tokenId)) {
      log.debug(`Cooldown active for ${tokenId}, skipping`);
      continue;
    }

    // Kelly sizing: EV as net-edge proxy
    const ev = bet.expectedValue;
    const rawKelly = ev / (1 - bidPrice);
    const adjustedKelly = Math.min(rawKelly * config.kellyFraction, config.maxKellyPct);
    const suggestedUsdc = deps.getBankroll() * adjustedKelly;

    const size = Math.round(suggestedUsdc / bidPrice);
    if (size < 1) continue;

    const tokenSide = tokenId === match.tokenIds.yes ? "YES" : "NO";
    const signal: TradeSignal = {
      tokenId,
      slug: match.slug,
      side: "BUY",
      tokenSide,
      price: bidPrice,
      size,
      edge: ev,
      kellyFraction: rawKelly,
      reason: "value_bet_confirmed",
    };

    markSignaled(tokenId);

    deps.orders.storeSignal(tokenId, {
      tokenSide,
      match,
      line: null,
      sharpProb: null,
      netEdge: ev,
      kellyFraction: rawKelly,
    });

    log.record(`SIGNAL BUY`, {
      tokenId,
      slug: match.slug,
      price: bidPrice,
      size,
      edge: ev,
      kellyFraction: rawKelly,
      reason: "value_bet_confirmed",
      dryRun: config.dryRun,
    });

    if (config.dryRun) {
      log.info(
        `[DRY RUN] Would BUY ${size} shares of ${match.slug} @ ${bidPrice.toFixed(4)} (EV=${(ev * 100).toFixed(2)}%)`,
      );
      continue;
    }

    executeSignal(deps.client, signal, deps.orders).catch((err) =>
      log.error(`Dispatch error: ${err.message}`),
    );
  }
}

// -- HTTP ---------------------------------------------------------------------

async function fetchValueBets(): Promise<ValueBet[]> {
  const url = new URL(`${config.oddsApiRestUrl}/v3/value-bets`);
  url.searchParams.set("apiKey", config.oddsApiKey);
  url.searchParams.set("bookmaker", "Polymarket");
  url.searchParams.set("includeEventDetails", "true");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const data = await res.json() as ValueBet[] | { error: string };
  if (!Array.isArray(data)) throw new Error(`Unexpected response: ${JSON.stringify(data)}`);
  return data;
}

// -- Helpers ------------------------------------------------------------------

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

function resolveTokenForBetSide(bet: ValueBet, match: MatchEntry): string | null {
  const side = bet.betSide.toLowerCase();
  if (side === "draw") return null;

  const eventHome = bet.event?.home ?? "";
  const eventAway = bet.event?.away ?? "";
  const betTeam = side === "home" ? eventHome : eventAway;
  if (!betTeam) return null;

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
