// tests/position-tracker.test.ts
// Integration tests for PositionTracker.
// recordBuy/recordSell are pure state mutations (no network).
// hydrate() hits the real Polymarket Data API.

import 'dotenv/config'
import { describe, it, expect, beforeEach } from 'vitest'
import { PositionTracker } from '../src/position-tracker.js'

describe('PositionTracker — state mutations', () => {
  let tracker: PositionTracker

  beforeEach(() => {
    tracker = new PositionTracker()
  })

  // ── recordBuy ────────────────────────────────────────────────────

  it('recordBuy new position: sets avgPrice=price, size=shares, totalCost=price×size', () => {
    const tokenId = 'token-abc'
    const price = 0.50
    const size = 100

    tracker.recordBuy(tokenId, 'test-slug', 'YES', price, size)

    const pos = tracker.getPosition(tokenId)
    expect(pos, 'position should exist after recordBuy').not.toBeNull()
    expect(pos!.avgPrice, `avgPrice should equal entry price ${price}`).toBeCloseTo(price, 6)
    expect(pos!.size, `size should equal shares bought ${size}`).toBeCloseTo(size, 6)
    expect(pos!.totalCost, `totalCost should be price(${price}) × size(${size}) = ${price * size}`).toBeCloseTo(price * size, 6)
    expect(pos!.tokenId, 'tokenId should match').toBe(tokenId)
    expect(pos!.slug, 'slug should match').toBe('test-slug')
    expect(pos!.side, 'side should match').toBe('YES')
  })

  it('recordBuy adds to existing position with correct weighted average price', () => {
    const tokenId = 'token-waap'

    // First buy: 100 shares at 0.50
    tracker.recordBuy(tokenId, 'test-slug', 'YES', 0.50, 100)
    // Second buy: 100 shares at 0.60
    tracker.recordBuy(tokenId, 'test-slug', 'YES', 0.60, 100)

    const pos = tracker.getPosition(tokenId)!
    // totalCost = 50 + 60 = 110, size = 200, avgPrice = 110/200 = 0.55
    const expectedTotalCost = 0.50 * 100 + 0.60 * 100  // 110
    const expectedAvgPrice = expectedTotalCost / 200  // 0.55

    expect(pos.size, 'size should be 200 after two buys').toBeCloseTo(200, 6)
    expect(pos.totalCost, `totalCost should be ${expectedTotalCost} after two buys`).toBeCloseTo(expectedTotalCost, 4)
    expect(pos.avgPrice, `avgPrice should be weighted avg ${expectedAvgPrice}`).toBeCloseTo(expectedAvgPrice, 4)
  })

  it('recordBuy: three buys at different prices produce correct weighted average', () => {
    const tokenId = 'token-3buy'
    tracker.recordBuy(tokenId, 'slug-3', 'NO', 0.40, 50)   // cost=20
    tracker.recordBuy(tokenId, 'slug-3', 'NO', 0.50, 100)  // cost=50
    tracker.recordBuy(tokenId, 'slug-3', 'NO', 0.60, 50)   // cost=30

    const pos = tracker.getPosition(tokenId)!
    const expectedTotalCost = 20 + 50 + 30  // 100
    const expectedSize = 50 + 100 + 50       // 200
    const expectedAvgPrice = expectedTotalCost / expectedSize  // 0.50

    expect(pos.totalCost, `totalCost should be ${expectedTotalCost}`).toBeCloseTo(expectedTotalCost, 4)
    expect(pos.size, `size should be ${expectedSize}`).toBeCloseTo(expectedSize, 6)
    expect(pos.avgPrice, `avgPrice should be ${expectedAvgPrice}`).toBeCloseTo(expectedAvgPrice, 4)
  })

  // ── recordSell ───────────────────────────────────────────────────

  it('recordSell partial: size and totalCost reduce proportionally', () => {
    const tokenId = 'token-sell-partial'
    tracker.recordBuy(tokenId, 'test-slug', 'YES', 0.50, 200)

    tracker.recordSell(tokenId, 0.60, 50)  // sell 50 of 200

    const pos = tracker.getPosition(tokenId)!
    // totalCost reduced by avgPrice × soldSize = 0.50 × 50 = 25
    const expectedSize = 150
    const expectedTotalCost = 0.50 * 200 - 0.50 * 50  // 100 - 25 = 75

    expect(pos.size, `size should be ${expectedSize} after partial sell`).toBeCloseTo(expectedSize, 6)
    expect(pos.totalCost, `totalCost should be ${expectedTotalCost}`).toBeCloseTo(expectedTotalCost, 4)
  })

  it('recordSell full close: position is removed from map', () => {
    const tokenId = 'token-sell-full'
    tracker.recordBuy(tokenId, 'test-slug', 'YES', 0.50, 100)

    tracker.recordSell(tokenId, 0.70, 100)

    const pos = tracker.getPosition(tokenId)
    expect(pos, 'position should be null after full sell').toBeNull()
    expect(tracker.size, 'tracker.size should be 0 after full close').toBe(0)
  })

  it('recordSell unknown tokenId: does not throw', () => {
    expect(() => {
      tracker.recordSell('nonexistent-token-xyz', 0.50, 100)
    }, 'recordSell for unknown tokenId must not throw').not.toThrow()
  })

  it('recordSell capped at existing size: does not result in negative position', () => {
    const tokenId = 'token-oversell'
    tracker.recordBuy(tokenId, 'test-slug', 'YES', 0.50, 100)

    // Try to sell 200 when only 100 exist
    tracker.recordSell(tokenId, 0.60, 200)

    // Position should be closed (size 0 → deleted)
    const pos = tracker.getPosition(tokenId)
    expect(pos, 'position should be gone after oversell').toBeNull()
  })

  // ── Aggregates ───────────────────────────────────────────────────

  it('getTotalDeployed returns sum of all position totalCosts', () => {
    tracker.recordBuy('token-a', 'slug-a', 'YES', 0.50, 100)  // cost=50
    tracker.recordBuy('token-b', 'slug-b', 'NO', 0.40, 200)   // cost=80

    const total = tracker.getTotalDeployed()
    expect(total, 'total deployed should be sum of all position costs: 50+80=130').toBeCloseTo(130, 4)
  })

  it('getTotalDeployed returns 0 when no positions', () => {
    expect(tracker.getTotalDeployed(), 'should be 0 with no positions').toBe(0)
  })

  it('getPositionCost returns totalCost for known token', () => {
    const tokenId = 'token-cost'
    tracker.recordBuy(tokenId, 'slug', 'YES', 0.60, 150)  // cost=90

    const cost = tracker.getPositionCost(tokenId)
    expect(cost, 'getPositionCost should return 90 for this position').toBeCloseTo(90, 4)
  })

  it('getPositionCost returns 0 for unknown token', () => {
    const cost = tracker.getPositionCost('completely-unknown-token')
    expect(cost, 'getPositionCost should return 0 for unknown token').toBe(0)
  })

  it('getAllPositions returns all tracked positions', () => {
    tracker.recordBuy('token-x', 'slug-x', 'YES', 0.50, 100)
    tracker.recordBuy('token-y', 'slug-y', 'NO', 0.60, 200)

    const all = tracker.getAllPositions()
    expect(all.length, 'getAllPositions should return 2 positions').toBe(2)
    const tokenIds = all.map((p) => p.tokenId)
    expect(tokenIds, 'getAllPositions should include token-x').toContain('token-x')
    expect(tokenIds, 'getAllPositions should include token-y').toContain('token-y')
  })

  it('size getter reflects the current number of open positions', () => {
    expect(tracker.size, 'size should be 0 initially').toBe(0)
    tracker.recordBuy('t1', 's1', 'YES', 0.5, 10)
    expect(tracker.size, 'size should be 1 after one buy').toBe(1)
    tracker.recordBuy('t2', 's2', 'YES', 0.5, 10)
    expect(tracker.size, 'size should be 2 after two buys').toBe(2)
    tracker.recordSell('t1', 0.6, 10)
    expect(tracker.size, 'size should be 1 after closing one position').toBe(1)
  })
})

describe('PositionTracker.hydrate() — real Polymarket Data API', () => {
  it('hydrates without throwing and returns valid position shapes', async () => {
    const tracker = new PositionTracker()

    await expect(tracker.hydrate(), 'hydrate() should not throw').resolves.not.toThrow()

    const positions = tracker.getAllPositions()
    expect(Array.isArray(positions), 'getAllPositions should return an array').toBe(true)
    // May be 0 if no open positions — that is valid

    for (const pos of positions) {
      expect(pos.tokenId, 'tokenId must be a non-empty string').toBeTruthy()
      expect(typeof pos.tokenId, 'tokenId must be a string').toBe('string')
      expect(pos.avgPrice, `avgPrice must be between 0 and 1 (got ${pos.avgPrice})`).toBeGreaterThan(0)
      expect(pos.avgPrice, `avgPrice must be <= 1 (got ${pos.avgPrice})`).toBeLessThanOrEqual(1)
      expect(pos.size, `size must be > 0 (got ${pos.size} for ${pos.tokenId})`).toBeGreaterThan(0)
      expect(pos.totalCost, `totalCost must be >= 0 (got ${pos.totalCost})`).toBeGreaterThanOrEqual(0)
      expect(pos.slug, 'slug must be a non-empty string').toBeTruthy()
      expect(['YES', 'NO'], `side must be YES or NO (got ${pos.side})`).toContain(pos.side)
    }
  }, 30_000)
})
