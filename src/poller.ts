// src/poller.ts
// Polls odds-api.io /v3/value-bets every 30s.
// For each bet: extract slug from bookmakerOdds.href, fetch event from Gamma,
// resolve token, Kelly-size, dispatch order.
// Exposes activeValueBetSlugs for exit logic to check thesis status.

import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { isOnCooldown, markSignaled, isSlugStopLossCooled } from "./cooldown.js";
import { executeSignal } from "./executor.js";
import type { ClobClient } from "@polymarket/clob-client";
import type { OrderTracker } from "./order-tracker.js";
import type { PositionTracker } from "./position-tracker.js";
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
  outcomes: string; // JSON-encoded string: '["Yes","No"]'
  clobTokenIds: string; // JSON-encoded string: '["token1","token2"]'
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  groupItemTitle?: string; // Team name in negRisk events (e.g., "Udinese Calcio")
  sportsMarketType?: string;
  line?: number;
  orderPriceMinTickSize?: number;
  orderMinSize?: number;
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
  orderMinSize: number;
}

const slugCache = new Map<string, ResolvedMarket>();

// Token→slug+side map (for UserStream to resolve fills without matcher)
const tokenInfoMap = new Map<string, { slug: string; side: "YES" | "NO" }>();

export function getTokenInfo(
  tokenId: string,
): { slug: string; side: "YES" | "NO" } | undefined {
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
  positions: PositionTracker;
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
    console.log(`[DEBUG poll] 0 value bets returned`);
    return;
  }
  console.log(
    `[DEBUG poll] ${bets.length} value bet(s): ${bets.map((b) => `${b.id}(${b.betSide})`).join(", ")}`,
  );
  log.debug(`Fetched ${bets.length} value bet(s)`);

  // Update active slugs for exit logic
  const activeSlugs = new Set<string>();
  for (const bet of bets) {
    const slug = extractSlug(bet);
    if (slug) activeSlugs.add(slug);
  }
  _activeValueBetSlugs = activeSlugs;

  // Process each bet (ML, Totals, Spread supported)
  for (const bet of bets) {
    const mktName = bet.market.name;
    if (mktName !== "ML" && mktName !== "Totals" && mktName !== "Spread") {
      log.warn(
        `Skipping unsupported market type ${bet.id} (market=${mktName})`,
      );
      continue;
    }
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

  const decimalOdds = parseFloat(
    bet.bookmakerOdds[bet.betSide as keyof ValueBetBookmakerOdds] ?? "",
  );
  const bidPrice = 1 / decimalOdds;
  console.log(
    `[DEBUG processBet] id=${bet.id} slug=${slug} betSide=${bet.betSide} decimalOdds=${decimalOdds} bidPrice=${bidPrice}`,
  );
  if (!isFinite(bidPrice) || bidPrice <= 0 || bidPrice >= 1) {
    console.log(`[DEBUG processBet] SKIP invalid bidPrice=${bidPrice}`);
    return;
  }
  if (bidPrice < config.minEntryPrice) {
    log.debug(
      `Entry price too low for ${slug}: bidPrice=${bidPrice.toFixed(4)} < minEntryPrice=${config.minEntryPrice}, skipping`,
    );
    return;
  }

  // Find the right market and token for this bet
  const match = resolveToken(bet, resolved);
  if (!match) {
    log.warn(
      `[DEBUG processBet] SKIP resolveToken returned null for ${bet.id}`,
    );
    return;
  }

  const { tokenId, tokenSide, market } = match;

  if (!market.active) {
    log.debug(`Market inactive for ${slug}, skipping`);
    return;
  }

  if (isSlugStopLossCooled(slug)) {
    log.debug(`Stop-loss slug cooldown active for ${slug}, skipping`);
    return;
  }

  if (isOnCooldown(tokenId)) {
    log.debug(`Cooldown active for ${tokenId}, skipping`);
    return;
  }

  // Position cap: skip if already at or above per-market or per-event limit
  const bankroll = deps.getBankroll();
  const existingPosition = deps.positions.getPositionCost(tokenId);
  const existingEventExposure = deps.positions.getEventExposure(slug);
  const maxPosition = bankroll * config.maxPositionPct;
  const maxEvent = bankroll * config.maxEventPct;
  const remainingMarketRoom = Math.max(0, maxPosition - existingPosition);
  const remainingEventRoom = Math.max(0, maxEvent - existingEventExposure);
  const remainingRoom = Math.min(remainingMarketRoom, remainingEventRoom);

  if (remainingRoom < 1) {
    const reason =
      remainingEventRoom < 1 ? "event_cap_reached" : "position_cap_reached";
    log.debug(
      `${reason} for ${slug} (existing=$${existingPosition.toFixed(2)} market cap=$${maxPosition.toFixed(2)}, event=$${existingEventExposure.toFixed(2)} event cap=$${maxEvent.toFixed(2)})`,
    );
    return;
  }

  // Kelly sizing
  // expectedValue is e.g. 108.5 meaning Polymarket odds are 8.5% better than fair
  // Kelly for decimal odds: f = edge / (decimalOdds - 1)
  const ev = (bet.expectedValue - 100) / 100; // normalise to e.g. 0.085
  if (ev < config.minEdge) {
    log.debug(
      `Edge too low for ${slug}: ev=${(ev * 100).toFixed(2)}% < minEdge=${(config.minEdge * 100).toFixed(2)}%, skipping`,
    );
    return;
  }
  const rawKelly = ev / (decimalOdds - 1);
  const adjustedKelly = Math.min(
    rawKelly * config.kellyFraction,
    config.maxKellyPct,
  );
  const suggestedUsdc = Math.min(bankroll * adjustedKelly, remainingRoom);
  const minSize = market.orderMinSize;
  // Also enforce $1 minimum notional (CLOB rejects marketable BUY < $1)
  const minSizeForNotional = Math.ceil(1 / bidPrice);
  const size = Math.max(
    Math.round(suggestedUsdc / bidPrice),
    minSize,
    minSizeForNotional,
  );
  console.log(
    `[DEBUG processBet] bankroll=${bankroll} ev=${ev} rawKelly=${rawKelly.toFixed(4)} adjustedKelly=${adjustedKelly.toFixed(4)} suggestedUsdc=${suggestedUsdc.toFixed(2)} size=${size} minSize=${minSize} remainingRoom=${remainingRoom.toFixed(2)}`,
  );

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
  deps.positions.storePendingSignal(tokenId, ev, rawKelly);

  log.info(
    `SIGNAL BUY: ${slug} ${size} @ ${bidPrice.toFixed(4)} edge=${(ev * 100).toFixed(1)}% kelly=${(rawKelly * 100).toFixed(1)}%`,
  );

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

async function fetchAndCacheEvent(
  slug: string,
): Promise<ResolvedMarket | null> {
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
        active: m.active && !m.closed && m.acceptingOrders !== false,
        question: m.question,
        sportsMarketType: m.sportsMarketType,
        line: m.line,
        orderMinSize: m.orderMinSize ?? 5,
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

  const data = (await res.json()) as ValueBet[] | { error: string };
  if (!Array.isArray(data))
    throw new Error(`Unexpected response: ${JSON.stringify(data)}`);
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

function resolveToken(
  bet: ValueBet,
  resolved: ResolvedMarket,
): { tokenId: string; tokenSide: "YES" | "NO"; market: ParsedMarket } | null {
  const mktName = bet.market.name;

  // Totals and Spread bets resolve by market type + line, not team name
  if (mktName === "Totals" || mktName === "Spread") {
    return resolveLineMarket(bet, resolved);
  }

  return resolveMoneyline(bet, resolved);
}

/** Resolve Totals / Spread bets by matching sportsMarketType + line. */
function resolveLineMarket(
  bet: ValueBet,
  resolved: ResolvedMarket,
): { tokenId: string; tokenSide: "YES" | "NO"; market: ParsedMarket } | null {
  const hdp = bet.market.hdp;
  if (hdp == null) {
    log.warn(`No hdp for ${bet.market.name} bet ${bet.id}`);
    return null;
  }

  const gammaType = bet.market.name === "Totals" ? "totals" : "spreads";
  const side = bet.betSide.toLowerCase();

  // Find the Gamma market with matching type and line
  // Odds API hdp and Gamma line should match directly, but for spreads
  // the sign may differ (Odds API from home perspective, Gamma may negate).
  for (const market of resolved.markets) {
    if (market.sportsMarketType !== gammaType) continue;
    if (market.line == null) continue;
    if (market.line !== hdp && market.line !== -hdp) continue;

    // Totals: betSide "home" = Over (YES), "away" = Under (NO)
    // Spreads: betSide "home" = home covers (YES), "away" = away covers (NO)
    const tokenSide: "YES" | "NO" = side === "home" ? "YES" : "NO";
    const tokenId =
      tokenSide === "YES" ? market.tokenIds.yes : market.tokenIds.no;

    return { tokenId, tokenSide, market };
  }

  log.warn(
    `No ${gammaType} market with line=${hdp} for bet ${bet.id} in slug=${resolved.slug}`,
  );
  return null;
}

/** Resolve moneyline bets (ML + draw) by team name matching. */
function resolveMoneyline(
  bet: ValueBet,
  resolved: ResolvedMarket,
): { tokenId: string; tokenSide: "YES" | "NO"; market: ParsedMarket } | null {
  const side = bet.betSide.toLowerCase();

  // Draw bets: match the market whose groupItemTitle starts with "Draw"
  if (side === "draw") {
    for (const market of resolved.markets) {
      if (
        market.groupItemTitle &&
        normalize(market.groupItemTitle).startsWith("draw")
      ) {
        return { tokenId: market.tokenIds.yes, tokenSide: "YES", market };
      }
    }
    log.warn(
      `Could not resolve draw market for bet ${bet.id} in slug=${resolved.slug}`,
    );
    return null;
  }

  const betTeam = side === "home" ? bet.event?.home : bet.event?.away;
  if (!betTeam) return null;
  const betWords = extractWords(betTeam);

  // Only consider moneyline markets to avoid matching spread/totals markets
  for (const market of resolved.markets) {
    if (market.sportsMarketType && market.sportsMarketType !== "moneyline")
      continue;

    // negRisk events: team name is in groupItemTitle, outcomes are just Yes/No
    if (market.groupItemTitle) {
      const titleWords = extractWords(market.groupItemTitle);
      if (fuzzyTeamMatch(betWords, titleWords)) {
        return { tokenId: market.tokenIds.yes, tokenSide: "YES", market };
      }
      continue;
    }

    // Non-negRisk events (e.g. NBA play-in): outcomes contain team names directly
    const yesWords = extractWords(market.outcomes.yes);
    const noWords = extractWords(market.outcomes.no);
    if (fuzzyTeamMatch(betWords, yesWords)) {
      return { tokenId: market.tokenIds.yes, tokenSide: "YES", market };
    }
    if (fuzzyTeamMatch(betWords, noWords)) {
      return { tokenId: market.tokenIds.no, tokenSide: "NO", market };
    }
  }

  log.warn(
    `Could not resolve token for bet ${bet.id} (team=${betTeam}) in slug=${resolved.slug}`,
  );
  return null;
}

/** Strip diacritics and lowercase for fuzzy team name matching. */
function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Common short tokens that appear in team prefixes/suffixes but carry no identity. */
const NOISE_WORDS = new Set([
  "fc",
  "ac",
  "sc",
  "cf",
  "afc",
  "fk",
  "sk",
  "bk",
  "if",
  "de",
  "e",
  "la",
  "le",
  "el",
  "al",
  "von",
  "van",
  "du",
  "da",
  "do",
  "dos",
]);

/** Extract meaningful words from a team name (normalized, noise-filtered). */
function extractWords(name: string): string[] {
  return normalize(name)
    .split(/[\s.'-]+/)
    .filter((w) => w.length > 0 && !NOISE_WORDS.has(w));
}

/**
 * Fuzzy team name match: true if ≥50% of the shorter word list appears in the
 * longer one. Handles abbreviations (SL Benfica vs Sport Lisboa e Benfica),
 * extra qualifiers (FC Unirea 2004 Slobozia vs AFC Unirea Slobozia), and
 * suffix differences (Celtic Glasgow vs Celtic FC).
 */
function fuzzyTeamMatch(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const longerSet = new Set(longer);
  let hits = 0;
  for (const word of shorter) {
    if (longerSet.has(word)) hits++;
  }
  return hits >= Math.max(1, Math.ceil(shorter.length * 0.5));
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
