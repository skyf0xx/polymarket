// tests/price-cache.test.ts
// Integration tests for PriceCache.
// Tests hit the real Polymarket CLOB WebSocket — no mocks.
// No REST hydration — WS initial_dump provides book snapshots on subscribe.

import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PriceCache } from '../src/price-cache.js'
import type { PriceEntry } from '../src/types.js'

const GAMMA_API = 'https://gamma-api.polymarket.com'

/** Fetch known active token IDs from the Gamma API. */
async function fetchActiveTokenIds(count = 2): Promise<string[]> {
  const url =
    `${GAMMA_API}/markets` +
    `?sports_market_types=moneyline` +
    `&closed=false` +
    `&active=true` +
    `&liquidity_num_min=1000` +
    `&limit=10` +
    `&offset=0`

  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`Gamma API ${res.status}: ${res.statusText}`)

  interface RawMarket {
    clobTokenIds: string | string[]
    active: boolean
  }

  const markets: RawMarket[] = await res.json()
  const tokenIds: string[] = []

  for (const market of markets) {
    const tids = typeof market.clobTokenIds === 'string'
      ? JSON.parse(market.clobTokenIds) as string[]
      : Array.isArray(market.clobTokenIds) ? market.clobTokenIds : []

    for (const tid of tids) {
      if (tid && !tokenIds.includes(tid)) {
        tokenIds.push(tid)
        if (tokenIds.length >= count) return tokenIds
      }
    }
  }

  if (tokenIds.length === 0) throw new Error('No active tokenIds found in Gamma API response')
  return tokenIds
}

// ── Pure state tests — no network ────────────────────────────────

describe('PriceCache — state (no network)', () => {
  it('getPrice() returns undefined for an unknown tokenId before any hydration', () => {
    const cache = new PriceCache()
    const result = cache.getPrice('token-that-was-never-added')
    expect(result, 'getPrice should return undefined for unknown token').toBeUndefined()
  })

  it('size is 0 before any tokens are added', () => {
    const cache = new PriceCache()
    expect(cache.size, 'size should be 0 before any start()').toBe(0)
  })

  it('getAllPrices() returns an empty Map before start', () => {
    const cache = new PriceCache()
    const all = cache.getAllPrices()
    expect(all instanceof Map, 'getAllPrices should return a Map').toBe(true)
    expect(all.size, 'Map should be empty before start').toBe(0)
  })
})

// ── WebSocket tests — single shared connection ────────────────────
// We create one cache in beforeAll, subscribe to tokens, wait for WS
// initial_dump book snapshots, then run all assertions on that data.

let sharedCache: PriceCache
let subscribedTokenId: string
let firstUpdate: PriceEntry

describe('PriceCache — WebSocket (initial_dump)', () => {
  beforeAll(async () => {
    const tokenIds = await fetchActiveTokenIds(2)
    subscribedTokenId = tokenIds[0]

    sharedCache = new PriceCache()

    // Register listener BEFORE start() to catch the initial book snapshot
    const updateReceived = new Promise<PriceEntry>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`No price_update for token ${subscribedTokenId} within 30s`)),
        29_000,
      )
      sharedCache.on('price_update', (tid, entry) => {
        if (tid === subscribedTokenId) {
          clearTimeout(timer)
          resolve(entry)
        }
      })
    })

    sharedCache.start(tokenIds)
    firstUpdate = await updateReceived
  }, 60_000) // WS connect + initial_dump snapshot

  afterAll(() => {
    sharedCache?.destroy()
  })

  it('price_update event has valid PriceEntry shape', () => {
    expect(firstUpdate, 'should have received a price_update').toBeDefined()
    expect(firstUpdate.tokenId, 'entry.tokenId should match subscribed token').toBe(subscribedTokenId)

    expect(typeof firstUpdate.price, 'price must be a number').toBe('number')
    expect(firstUpdate.price, `price must be > 0, got ${firstUpdate.price}`).toBeGreaterThan(0)
    expect(firstUpdate.price, `price must be <= 1, got ${firstUpdate.price}`).toBeLessThanOrEqual(1)

    expect(typeof firstUpdate.bestBid, 'bestBid must be a number').toBe('number')
    expect(firstUpdate.bestBid, `bestBid must be >= 0, got ${firstUpdate.bestBid}`).toBeGreaterThanOrEqual(0)

    expect(typeof firstUpdate.bestAsk, 'bestAsk must be a number').toBe('number')
    expect(firstUpdate.bestAsk, `bestAsk must be >= 0, got ${firstUpdate.bestAsk}`).toBeGreaterThanOrEqual(0)

    expect(typeof firstUpdate.updatedAt, 'updatedAt must be a number').toBe('number')
    expect(firstUpdate.updatedAt, 'updatedAt must be > 0').toBeGreaterThan(0)

    expect(firstUpdate.hasBook, 'hasBook should be true for a WS-sourced entry').toBe(true)
  })

  it('bestBid <= bestAsk — no crossed book', () => {
    if (firstUpdate.bestBid > 0 && firstUpdate.bestAsk > 0) {
      expect(
        firstUpdate.bestBid,
        `bestBid(${firstUpdate.bestBid}) must be <= bestAsk(${firstUpdate.bestAsk}) — no crossed book`,
      ).toBeLessThanOrEqual(firstUpdate.bestAsk + 0.001) // +0.001 for float edge cases
    }
  })

  it('price is the midpoint: (bestBid + bestAsk) / 2 when both sides are > 0', () => {
    if (firstUpdate.bestBid > 0 && firstUpdate.bestAsk > 0) {
      const expectedMid = (firstUpdate.bestBid + firstUpdate.bestAsk) / 2
      expect(
        firstUpdate.price,
        `price should be midpoint(bestBid=${firstUpdate.bestBid}, bestAsk=${firstUpdate.bestAsk}) = ${expectedMid}`,
      ).toBeCloseTo(expectedMid, 4)
    }
  })

  it('getPrice() returns a PriceEntry after receiving the WS update', () => {
    const entry = sharedCache.getPrice(subscribedTokenId)
    expect(entry, `getPrice("${subscribedTokenId}") should return a PriceEntry`).not.toBeUndefined()
    expect(entry!.tokenId, 'getPrice result.tokenId should match').toBe(subscribedTokenId)
    expect(entry!.hasBook, 'getPrice result should have hasBook=true').toBe(true)
  })

  it('getPrice() still returns undefined for a token that was never subscribed', () => {
    const result = sharedCache.getPrice('token-never-subscribed-xyz-abc-123')
    expect(result, 'should return undefined for never-subscribed token').toBeUndefined()
  })

  it('size reflects the number of tokens with received price data', () => {
    expect(sharedCache.size, 'size should be >= 1 after receiving at least one update').toBeGreaterThanOrEqual(1)
  })

  it('getAllPrices() returns a Map containing the subscribed token', () => {
    const all = sharedCache.getAllPrices()
    expect(all instanceof Map, 'getAllPrices should return a Map').toBe(true)
    expect(all.has(subscribedTokenId), `getAllPrices should contain the subscribed token "${subscribedTokenId}"`).toBe(true)
  })
})
