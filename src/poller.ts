// src/poller.ts
// Polls odds-api.io /v3/value-bets every 30s.
// For each bet: extract slug from bookmakerOdds.href, fetch event from Gamma,
// resolve token, Kelly-size, dispatch order.
// Exposes activeValueBetSlugs for exit logic to check thesis status.

import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { isOnCooldown, markSignaled } from "./cooldown.js";
import { executeSignal } from "./executor.js";
import type { ClobClient } from "@polymarket/clob-client";
import type { OrderTracker } from "./order-tracker.js";
import type { TradeSignal } from "./types.js";

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
  href?: string;
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

// -- Gamma event shape (subset we need) ---------------------------------------

interface GammaMarket {
  id: string;
  question: string;
  outcomes: string;        // JSON-encoded string: '["Yes","No"]'
  clobTokenIds: string;    // JSON-encoded string: '["token1","token2"]'
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  groupItemTitle?: string; // Team name in negRisk events (e.g., "Udinese Calcio")
  sportsMarketType?: string;
  line?: number;
  orderPriceMinTickSize?: number;
}

interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  active: boolean;
  closed: boolean;
  markets: GammaMarket[];
}

// -- Resolved market cache ----------------------------------------------------

interface ResolvedMarket {
  slug: string;
  markets: ParsedMarket[];
}

interface ParsedMarket {
  tokenIds: { yes: string; no: string };
  outcomes: { yes: string; no: string };
  groupItemTitle?: string; // Team name for negRisk markets
  active: boolean;
  question: string;
  sportsMarketType?: string;
  line?: number;
}

const slugCache = new Map<string, ResolvedMarket>();

// Token→slug+side map (for UserStream to resolve fills without matcher)
const tokenInfoMap = new Map<string, { slug: string; side: "YES" | "NO" }>();

export function getTokenInfo(tokenId: string): { slug: string; side: "YES" | "NO" } | undefined {
  return tokenInfoMap.get(tokenId);
}

// -- Active value-bet slugs (shared with exit logic) --------------------------

let _activeValueBetSlugs = new Set<string>();

export function getActiveValueBetSlugs(): Set<string> {
  return _activeValueBetSlugs;
}

// -- Poller -------------------------------------------------------------------

export interface PollerDeps {
  client: ClobClient;
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

  if (bets.length === 0) {
    _activeValueBetSlugs = new Set();
    return;
  }
  log.debug(`Fetched ${bets.length} value bet(s)`);

  // Update active slugs for exit logic
  const activeSlugs = new Set<string>();
  for (const bet of bets) {
    const slug = extractSlug(bet);
    if (slug) activeSlugs.add(slug);
  }
  _activeValueBetSlugs = activeSlugs;

  // Process each bet
  for (const bet of bets) {
    await processBet(deps, bet);
  }
}

// -- Process a single value bet -----------------------------------------------

async function processBet(deps: PollerDeps, bet: ValueBet): Promise<void> {
  const slug = extractSlug(bet);
  if (!slug) {
    log.debug(`No href in value bet ${bet.id}, skipping`);
    return;
  }

  // Resolve event from Gamma (cached)
  let resolved = slugCache.get(slug);
  if (!resolved) {
    const fetched = await fetchAndCacheEvent(slug);
    if (!fetched) return;
    resolved = fetched;
  }

  const bidPrice = impliedProbFromBet(bet);
  if (bidPrice === null) return;

  // Find the right market and token for this bet
  const match = resolveToken(bet, resolved);
  if (!match) return;

  const { tokenId, tokenSide, market } = match;

  if (!market.active) {
    log.debug(`Market inactive for ${slug}, skipping`);
    return;
  }

  if (isOnCooldown(tokenId)) {
    log.debug(`Cooldown active for ${tokenId}, skipping`);
    return;
  }

  // Kelly sizing
  const ev = bet.expectedValue;
  const rawKelly = ev / (1 - bidPrice);
  const adjustedKelly = Math.min(rawKelly * config.kellyFraction, config.maxKellyPct);
  const suggestedUsdc = deps.getBankroll() * adjustedKelly;

  const size = Math.round(suggestedUsdc / bidPrice);
  if (size < 1) return;

  const signal: TradeSignal = {
    tokenId,
    slug,
    side: "BUY",
    tokenSide,
    price: bidPrice,
    size,
    edge: ev,
    kellyFraction: rawKelly,
    reason: "value_bet_confirmed",
  };

  markSignaled(tokenId);

  // Register token info for UserStream fill resolution
  tokenInfoMap.set(tokenId, { slug, side: tokenSide });

  deps.orders.storeSignal(tokenId, {
    tokenSide,
    slug,
    netEdge: ev,
    kellyFraction: rawKelly,
  });

  log.record(`SIGNAL BUY`, {
    tokenId,
    slug,
    price: bidPrice,
    size,
    edge: ev,
    kellyFraction: rawKelly,
    reason: "value_bet_confirmed",
    dryRun: config.dryRun,
  });

  if (config.dryRun) {
    log.info(
      `[DRY RUN] Would BUY ${size} shares of ${slug} @ ${bidPrice.toFixed(4)} (EV=${(ev * 100).toFixed(2)}%)`,
    );
    return;
  }

  executeSignal(deps.client, signal, deps.orders).catch((err) =>
    log.error(`Dispatch error: ${err.message}`),
  );
}

// -- Gamma API ----------------------------------------------------------------

async function fetchAndCacheEvent(slug: string): Promise<ResolvedMarket | null> {
  try {
    const url = `${config.gammaApiUrl}/events/slug/${slug}`;
    const res = await fetch(url);
    if (!res.ok) {
      log.warn(`Gamma fetch failed for slug=${slug}: HTTP ${res.status}`);
      return null;
    }

    const event = (await res.json()) as GammaEvent;
    if (!event.markets || event.markets.length === 0) {
      log.warn(`No markets for slug=${slug}`);
      return null;
    }

    const markets: ParsedMarket[] = [];
    for (const m of event.markets) {
      const outcomes = safeJsonParse<string[]>(m.outcomes, []);
      const tokenIds = safeJsonParse<string[]>(m.clobTokenIds, []);
      if (outcomes.length < 2 || tokenIds.length < 2) continue;

      markets.push({
        tokenIds: { yes: tokenIds[0], no: tokenIds[1] },
        outcomes: { yes: outcomes[0], no: outcomes[1] },
        groupItemTitle: m.groupItemTitle,
        active: m.active && !m.closed && (m.acceptingOrders !== false),
        question: m.question,
        sportsMarketType: m.sportsMarketType,
        line: m.line,
      });
    }

    const resolved: ResolvedMarket = { slug, markets };
    slugCache.set(slug, resolved);
    log.info(`Cached event slug=${slug} with ${markets.length} market(s)`);
    return resolved;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Gamma fetch error for slug=${slug}: ${msg}`);
    return null;
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

function extractSlug(bet: ValueBet): string | null {
  const href = bet.bookmakerOdds.href;
  if (!href) return null;
  // href = "https://polymarket.com/event/nba-atl-bkn-2026-04-03"
  const parts = href.split("/");
  return parts[parts.length - 1] || null;
}

function impliedProbFromBet(bet: ValueBet): number | null {
  const side = bet.betSide.toLowerCase();
  let oddsStr: string | undefined;

  // Use sharp/reference odds from bet.market (not Polymarket's own price)
  if (side === "home") oddsStr = bet.market.home;
  else if (side === "away") oddsStr = bet.market.away;
  else if (side === "draw") oddsStr = bet.market.draw;

  if (!oddsStr) return null;
  const decimal = parseFloat(oddsStr);
  if (!isFinite(decimal) || decimal <= 1) return null;
  return 1 / decimal;
}

function resolveToken(
  bet: ValueBet,
  resolved: ResolvedMarket,
): { tokenId: string; tokenSide: "YES" | "NO"; market: ParsedMarket } | null {
  const side = bet.betSide.toLowerCase();
  if (side === "draw") return null;

  const betTeam = side === "home" ? bet.event?.home : bet.event?.away;
  if (!betTeam) return null;
  const betTeamLower = normalize(betTeam);

  // Strategy 1: Match by groupItemTitle (negRisk events — one market per team,
  // outcomes are just Yes/No, team name is in groupItemTitle).
  // Betting ON a team = buying YES on that team's market.
  for (const market of resolved.markets) {
    if (!market.groupItemTitle) continue;
    const titleNorm = normalize(market.groupItemTitle);
    if (titleNorm.includes(betTeamLower) || betTeamLower.includes(titleNorm)) {
      return { tokenId: market.tokenIds.yes, tokenSide: "YES", market };
    }
  }

  // Strategy 2: Match by outcome names (non-negRisk events — outcomes contain
  // team names directly, e.g., ["Atlanta Hawks", "Brooklyn Nets"]).
  for (const market of resolved.markets) {
    const yesNorm = normalize(market.outcomes.yes);
    const noNorm = normalize(market.outcomes.no);

    if (yesNorm.includes(betTeamLower) || betTeamLower.includes(yesNorm)) {
      return { tokenId: market.tokenIds.yes, tokenSide: "YES", market };
    }
    if (noNorm.includes(betTeamLower) || betTeamLower.includes(noNorm)) {
      return { tokenId: market.tokenIds.no, tokenSide: "NO", market };
    }
  }

  // Strategy 3: Match by question text (e.g., "Will Udinese Calcio win on 2026-04-06?")
  for (const market of resolved.markets) {
    if (normalize(market.question).includes(betTeamLower)) {
      return { tokenId: market.tokenIds.yes, tokenSide: "YES", market };
    }
  }

  // Strategy 4: Last-word match (handles "Atletico Tucuman" vs "CA Tucumán" —
  // different prefixes but same city name)
  const betWords = betTeamLower.split(/\s+/);
  const lastWord = betWords[betWords.length - 1];
  if (lastWord && lastWord.length >= 4) {
    const candidates: { market: ParsedMarket; titleNorm: string }[] = [];
    for (const market of resolved.markets) {
      if (!market.groupItemTitle || market.groupItemTitle.toLowerCase().startsWith("draw")) continue;
      const titleNorm = normalize(market.groupItemTitle);
      if (titleNorm.includes(lastWord)) {
        candidates.push({ market, titleNorm });
      }
    }
    if (candidates.length === 1) {
      return { tokenId: candidates[0].market.tokenIds.yes, tokenSide: "YES", market: candidates[0].market };
    }
  }

  log.warn(`Could not resolve token for bet ${bet.id} (team=${betTeam}) in slug=${resolved.slug}`);
  return null;
}

/** Strip diacritics and lowercase for fuzzy team name matching. */
function normalize(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
