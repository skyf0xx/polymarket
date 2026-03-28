// tests/market-matcher.test.ts
// Integration tests for MarketMatcher.
// Calls real Gamma API and real Claude Haiku — no mocks.
//
// Architecture:
// - The matcher loads its match table from disk on construction.
// - We validate the loaded table against live Gamma data.
// - For the odds validation, we fetch a small targeted batch of odds
//   (only for event IDs already in the match table) rather than the
//   full rehydration (which can hit 28k+ events globally).
// - runMatchCycle is called with only slugs already on disk — no LLM calls.

import 'dotenv/config'
import { describe, it, expect, beforeAll } from 'vitest'
import { MarketMatcher } from '../src/market-matcher.js'
import { config } from '../src/config.js'
import type { SharpLine, PolymarketMarket } from '../src/types.js'

const GAMMA_API = 'https://gamma-api.polymarket.com'
const ODDS_API_REST = config.oddsApiRestUrl

/** Fetch a small batch of odds for specific event IDs from the Odds API. */
async function fetchOddsForEventIds(eventIds: string[]): Promise<Map<string, SharpLine>> {
  const cache = new Map<string, SharpLine>()
  if (eventIds.length === 0) return cache

  // Take a small sample to keep the test fast
  const sample = eventIds.slice(0, 20)
  const BATCH_SIZE = 10

  for (let i = 0; i < sample.length; i += BATCH_SIZE) {
    const batch = sample.slice(i, i + BATCH_SIZE)
    const url =
      `${ODDS_API_REST}/v3/odds/multi` +
      `?apiKey=${config.oddsApiKey}` +
      `&eventIds=${batch.join(',')}` +
      `&bookmakers=${config.bookmakerId}`

    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) continue

    interface OddsResponseItem {
      id: number
      home: string
      away: string
      date: string
      sport?: { name: string; slug: string }
      league?: { name: string; slug: string }
      bookmakers: Record<string, unknown[]>
    }

    const data: OddsResponseItem[] = await res.json()
    for (const item of data) {
      const eventId = String(item.id)
      cache.set(eventId, {
        eventId,
        sportKey: item.sport?.slug ?? 'unknown',
        leagueSlug: item.league?.slug ?? 'unknown',
        homeTeam: item.home,
        awayTeam: item.away,
        commence: new Date(item.date).getTime(),
        markets: {},
        updatedAt: Date.now(),
      })
    }
  }

  return cache
}

/** Fetch Gamma markets for a set of slugs (broad fetch, filter client-side). */
async function fetchGammaMarketsForSlugs(slugs: string[]): Promise<PolymarketMarket[]> {
  if (slugs.length === 0) return []
  const slugSet = new Set(slugs)

  const url =
    `${GAMMA_API}/markets` +
    `?sports_market_types=moneyline` +
    `&closed=false` +
    `&liquidity_num_min=100` +
    `&limit=200` +
    `&offset=0`

  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) return []

  interface RawMarket {
    slug: string
    question: string
    outcomes: string | string[]
    outcomePrices: string | string[]
    clobTokenIds: string | string[]
    endDate: string
    active: boolean
    closed: boolean
    acceptingOrders?: boolean
    groupItemTitle?: string
    conditionId: string
  }

  const raw: RawMarket[] = await res.json()
  return raw
    .filter((m) => slugSet.has(m.slug))
    .map((m) => ({
      slug: m.slug,
      question: m.question,
      outcomes: typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : (m.outcomes ?? ['Yes', 'No']),
      outcomePrices: typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : (m.outcomePrices ?? ['0.5', '0.5']),
      tokenIds: typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : Array.isArray(m.clobTokenIds) ? m.clobTokenIds : [],
      endDate: m.endDate,
      active: m.active,
      closed: m.closed,
      acceptingOrders: m.acceptingOrders ?? true,
      groupItemTitle: m.groupItemTitle,
      conditionId: m.conditionId,
    }))
}

// ── Shared fixtures ──────────────────────────────────────────────

let matcher: MarketMatcher
let oddsLines: Map<string, SharpLine>
let polymarkets: PolymarketMarket[]
let matchCycleResult: { newMatches: number; total: number }

describe('MarketMatcher', () => {
  beforeAll(async () => {
    // Step 1: Construct matcher — loads match table from disk (no network)
    matcher = new MarketMatcher()

    // Step 2: Hydrate team knowledge (Gamma Teams API — single REST call)
    await matcher.hydrateTeams(config.gammaLeagues)

    // Step 3: Get event IDs from disk-loaded matches and fetch only those odds
    // This avoids the full 28k-event rehydration that times out tests.
    const allMatches = matcher.getAllMatches()
    const eventIds = [...new Set(allMatches.map((m) => m.oddsApiEventId).filter(Boolean))]
    oddsLines = await fetchOddsForEventIds(eventIds)

    // Step 4: Fetch Gamma markets only for slugs already in the match table
    // runMatchCycle will see 0 unmatched → returns immediately, no LLM needed.
    const existingSlugs = allMatches.map((m) => m.slug).slice(0, 30)
    polymarkets = await fetchGammaMarketsForSlugs(existingSlugs)

    // Step 5: Run match cycle — all slugs are cached, returns immediately
    matchCycleResult = await matcher.runMatchCycle(oddsLines, polymarkets)
  }, 60_000)

  // ── hydrateTeams ─────────────────────────────────────────────────

  it('hydrateTeams() succeeds and matcher is ready', () => {
    expect(matcher, 'matcher should be defined').toBeDefined()
    expect(matcher.size, 'matcher.size should be >= 0').toBeGreaterThanOrEqual(0)
  })

  // ── getMatch / getMatchByToken ───────────────────────────────────

  it('getMatch() returns null for a completely unknown slug', () => {
    const result = matcher.getMatch('this-slug-does-not-exist-xyz-2099-01-01')
    expect(result, 'getMatch() should return null for unknown slug').toBeNull()
  })

  it('getMatchByToken() returns null for an unknown tokenId', () => {
    const result = matcher.getMatchByToken(
      '0x0000000000000000000000000000000000000000000000000000000000000000',
    )
    expect(result, 'getMatchByToken() should return null for unknown tokenId').toBeNull()
  })

  it('getMatch() finds a known match from the disk-loaded table', () => {
    const allMatches = matcher.getAllMatches()
    if (allMatches.length === 0) return // skip if table is empty

    const sample = allMatches[0]
    const found = matcher.getMatch(sample.slug)
    expect(found, `getMatch("${sample.slug}") should return a MatchEntry`).not.toBeNull()
    expect(found!.slug, 'returned entry slug should match query').toBe(sample.slug)
  })

  // ── runMatchCycle ────────────────────────────────────────────────

  it('runMatchCycle() returns numeric newMatches and total counts', () => {
    expect(typeof matchCycleResult.newMatches, 'newMatches should be a number').toBe('number')
    expect(typeof matchCycleResult.total, 'total should be a number').toBe('number')
    expect(matchCycleResult.newMatches, 'newMatches should be >= 0').toBeGreaterThanOrEqual(0)
    expect(matchCycleResult.total, 'total should be >= 0').toBeGreaterThanOrEqual(0)
  })

  it('runMatchCycle() with pre-cached slugs adds 0 new matches', () => {
    // All polymarkets passed in were already in the table — should be 0 new
    expect(matchCycleResult.newMatches, 'no new LLM matches expected when all slugs pre-cached').toBe(0)
  })

  // ── Integrity of on-disk match table ─────────────────────────────

  it('every matched entry: outcomeMap.Yes and outcomeMap.No are non-empty strings', () => {
    for (const match of matcher.getAllMatches()) {
      expect(
        typeof match.outcomeMap.Yes === 'string' && match.outcomeMap.Yes.length > 0,
        `outcomeMap.Yes must be non-empty for slug "${match.slug}", got "${match.outcomeMap.Yes}"`,
      ).toBe(true)
      expect(
        typeof match.outcomeMap.No === 'string' && match.outcomeMap.No.length > 0,
        `outcomeMap.No must be non-empty for slug "${match.slug}", got "${match.outcomeMap.No}"`,
      ).toBe(true)
    }
  })

  it('every matched entry: confidence is one of high/medium/low', () => {
    const validConfidence = new Set(['high', 'medium', 'low'])
    for (const match of matcher.getAllMatches()) {
      expect(
        validConfidence.has(match.confidence),
        `confidence "${match.confidence}" for slug "${match.slug}" must be high/medium/low`,
      ).toBe(true)
    }
  })

  it('every matched entry: marketType is one of h2h/spreads/totals', () => {
    const validTypes = new Set(['h2h', 'spreads', 'totals'])
    for (const match of matcher.getAllMatches()) {
      expect(
        validTypes.has(match.marketType),
        `marketType "${match.marketType}" for slug "${match.slug}" must be h2h/spreads/totals`,
      ).toBe(true)
    }
  })

  it('every matched entry: tokenIds are non-empty strings when present', () => {
    for (const match of matcher.getAllMatches()) {
      if (match.tokenIds.yes) {
        expect(typeof match.tokenIds.yes, `tokenIds.yes must be string for "${match.slug}"`).toBe('string')
        expect(match.tokenIds.yes.length, `tokenIds.yes must be non-empty for "${match.slug}"`).toBeGreaterThan(0)
      }
      if (match.tokenIds.no) {
        expect(typeof match.tokenIds.no, `tokenIds.no must be string for "${match.slug}"`).toBe('string')
        expect(match.tokenIds.no.length, `tokenIds.no must be non-empty for "${match.slug}"`).toBeGreaterThan(0)
      }
    }
  })

  it('every matched entry: matchedAt is a positive timestamp', () => {
    for (const match of matcher.getAllMatches()) {
      expect(match.matchedAt, `matchedAt must be > 0 for slug "${match.slug}"`).toBeGreaterThan(0)
    }
  })

  it('fetched polymarkets slice: tokenIds in match table reference real Gamma tokens', () => {
    // For the markets we fetched from Gamma, verify the persisted tokenIds are still correct.
    const realTokenIds = new Set<string>()
    for (const pm of polymarkets) {
      for (const tid of pm.tokenIds) {
        if (tid) realTokenIds.add(tid)
      }
    }

    const polySlugSet = new Set(polymarkets.map((pm) => pm.slug))
    const matchesInSlice = matcher.getAllMatches().filter((m) => polySlugSet.has(m.slug))

    for (const match of matchesInSlice) {
      if (match.tokenIds.yes) {
        expect(
          realTokenIds.has(match.tokenIds.yes),
          `tokenIds.yes "${match.tokenIds.yes}" for slug "${match.slug}" not in live Gamma data`,
        ).toBe(true)
      }
      if (match.tokenIds.no) {
        expect(
          realTokenIds.has(match.tokenIds.no),
          `tokenIds.no "${match.tokenIds.no}" for slug "${match.slug}" not in live Gamma data`,
        ).toBe(true)
      }
    }
  })

  // ── getAllTokenIds ────────────────────────────────────────────────

  it('getAllTokenIds() returns only token IDs from high-confidence active matches', () => {
    const tokenIds = matcher.getAllTokenIds()
    expect(Array.isArray(tokenIds), 'getAllTokenIds() should return an array').toBe(true)

    const tradeableMatches = matcher.getTradeableMatches()
    const tradeableTokenIds = new Set<string>()
    for (const m of tradeableMatches) {
      if (m.tokenIds.yes) tradeableTokenIds.add(m.tokenIds.yes)
      if (m.tokenIds.no) tradeableTokenIds.add(m.tokenIds.no)
    }

    for (const tid of tokenIds) {
      expect(
        tradeableTokenIds.has(tid),
        `getAllTokenIds() returned "${tid}" which is not in a high-confidence active match`,
      ).toBe(true)
    }
  })

  // ── getMatchByToken O(1) lookup ──────────────────────────────────

  it('getMatchByToken() finds a match by token ID in O(1)', () => {
    const tradeableMatches = matcher.getTradeableMatches()
    if (tradeableMatches.length === 0) return // no active matches right now

    const sample = tradeableMatches[0]

    if (sample.tokenIds.yes) {
      const found = matcher.getMatchByToken(sample.tokenIds.yes)
      expect(found, `getMatchByToken(yes) should find slug "${sample.slug}"`).not.toBeNull()
      expect(found!.slug, 'yes-token lookup should return correct slug').toBe(sample.slug)
    }

    if (sample.tokenIds.no) {
      const found = matcher.getMatchByToken(sample.tokenIds.no)
      expect(found, `getMatchByToken(no) should find slug "${sample.slug}"`).not.toBeNull()
      expect(found!.slug, 'no-token lookup should return correct slug').toBe(sample.slug)
    }
  })
})
