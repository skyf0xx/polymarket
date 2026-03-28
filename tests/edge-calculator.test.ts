// tests/edge-calculator.test.ts
// Integration tests for EdgeCalculator — pure math, no network calls.

import 'dotenv/config'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  computeEdge,
  checkExit,
  isOnCooldown,
  markSignaled,
  clearCooldown,
  type ComputeEdgeInput,
  type ExitCheckInput,
} from '../src/edge-calculator.js'
import { config } from '../src/config.js'

// ── Helpers ──────────────────────────────────────────────────────
// These tests must work with whatever MARKET_MAKER is set in .env.
// When MARKET_MAKER=true, fees are 0. When false, fees follow the formula.
const FEE_RATE = 0.03
function expectedFee(price: number): number {
  return config.marketMaker ? 0 : FEE_RATE * price * price * (1 - price)
}

describe('computeEdge', () => {
  it('returns tradeable=true for a clear edge: sharpProb=0.65, takerPrice=0.50', () => {
    const takerPrice = 0.50
    const sharpProb = 0.65
    const bankroll = 1000

    const result = computeEdge({
      sharpProb,
      polyPrice: takerPrice,
      takerPrice,
      sportKey: 'basketball',
      bankroll,
      existingPosition: 0,
      existingEventExposure: 0,
    })

    const grossEdge = sharpProb - takerPrice
    const fee = expectedFee(takerPrice)
    const netEdge = grossEdge - fee

    expect(result.grossEdge, `grossEdge should be sharpProb(${sharpProb}) - takerPrice(${takerPrice})`).toBeCloseTo(grossEdge, 4)
    expect(result.fee, `fee should be ${fee} (marketMaker=${config.marketMaker})`).toBeCloseTo(fee, 4)
    expect(result.netEdge, `netEdge should be grossEdge(${grossEdge}) - fee(${fee})`).toBeCloseTo(netEdge, 4)

    if (netEdge >= config.minEdge) {
      expect(result.tradeable, 'should be tradeable when netEdge >= minEdge').toBe(true)
      expect(result.kellyFraction, 'kellyFraction should be positive').toBeGreaterThan(0)
      expect(result.suggestedSize, 'suggestedSize should be > 5').toBeGreaterThan(5)
      expect(result.suggestedSize, `suggestedSize should not exceed bankroll × MAX_KELLY_PCT (${bankroll * config.maxKellyPct})`).toBeLessThanOrEqual(bankroll * config.maxKellyPct + 0.01)
    } else {
      expect(result.tradeable, 'tradeable=false when netEdge < minEdge').toBe(false)
    }
  })

  it('returns tradeable=false when netEdge is below minEdge', () => {
    // With MARKET_MAKER=true, fee=0. Use sharpProb - takerPrice = 0.01 < MIN_EDGE (0.02).
    // With MARKET_MAKER=false, takerPrice=0.50 fee=0.00375, so 0.52-0.50-0.00375=0.01625 < 0.02.
    const takerPrice = 0.50
    // Choose sharpProb so that netEdge < minEdge under either fee regime:
    // fee=0 case: need sharpProb - 0.50 < 0.02 → sharpProb < 0.52 (use 0.51)
    // fee>0 case: 0.51 - 0.50 - 0.00375 = 0.00625 < 0.02 — also works
    const sharpProb = 0.51

    const result = computeEdge({
      sharpProb,
      polyPrice: takerPrice,
      takerPrice,
      sportKey: 'basketball',
      bankroll: 1000,
      existingPosition: 0,
      existingEventExposure: 0,
    })

    const fee = expectedFee(takerPrice)
    const netEdge = (sharpProb - takerPrice) - fee

    expect(result.tradeable, `tradeable should be false when netEdge(${netEdge.toFixed(4)}) < minEdge(${config.minEdge})`).toBe(false)
    expect(
      result.skipReason,
      'skipReason should contain edge_too_small or no_edge',
    ).toMatch(/edge_too_small|no_edge/)
  })

  it('returns tradeable=false with skipReason=position_cap_reached when existingPosition fills the cap', () => {
    const bankroll = 1000
    const maxPosition = bankroll * config.maxPositionPct
    // existingPosition exactly at cap — remainingMarketRoom = 0
    const result = computeEdge({
      sharpProb: 0.80,
      polyPrice: 0.50,
      takerPrice: 0.50,
      sportKey: 'basketball',
      bankroll,
      existingPosition: maxPosition,
      existingEventExposure: 0,
    })

    expect(result.tradeable, 'should be false when position cap is full').toBe(false)
    expect(result.skipReason, 'skipReason should be position_cap_reached').toBe('position_cap_reached')
  })

  it('returns tradeable=false with skipReason=event_cap_reached when existingEventExposure fills the event cap', () => {
    const bankroll = 1000
    const maxEvent = bankroll * config.maxEventPct
    const result = computeEdge({
      sharpProb: 0.80,
      polyPrice: 0.50,
      takerPrice: 0.50,
      sportKey: 'basketball',
      bankroll,
      existingPosition: 0,
      existingEventExposure: maxEvent,
    })

    expect(result.tradeable, 'should be false when event cap is full').toBe(false)
    expect(result.skipReason, 'skipReason should be event_cap_reached').toBe('event_cap_reached')
  })

  it('verifies fee formula at price=0.90: fee = 0.03 × 0.81 × 0.10', () => {
    const price = 0.90
    const expected = FEE_RATE * price * price * (1 - price)
    // Expected: 0.03 × 0.81 × 0.10 = 0.00243

    const result = computeEdge({
      sharpProb: 0.99, // very high to ensure tradeable path
      polyPrice: price,
      takerPrice: price,
      sportKey: 'basketball',
      bankroll: 10000,
      existingPosition: 0,
      existingEventExposure: 0,
    })

    if (config.marketMaker) {
      expect(result.fee, 'fee should be 0 when MARKET_MAKER=true').toBe(0)
    } else {
      expect(result.fee, `fee at price=0.90 should be 0.03 × 0.81 × 0.10 = ${expected}`).toBeCloseTo(expected, 4)
      expect(result.fee, 'fee at price=0.90 should be close to 0.00243').toBeCloseTo(0.00243, 4)
    }
  })

  it('Kelly cap: suggestedSize never exceeds bankroll × MAX_KELLY_PCT even with extreme edge', () => {
    const bankroll = 10000
    const maxAllowed = bankroll * config.maxKellyPct

    const result = computeEdge({
      sharpProb: 0.99,
      polyPrice: 0.10,
      takerPrice: 0.10,
      sportKey: 'basketball',
      bankroll,
      existingPosition: 0,
      existingEventExposure: 0,
    })

    if (result.tradeable) {
      expect(
        result.suggestedSize,
        `suggestedSize (${result.suggestedSize}) must not exceed bankroll × MAX_KELLY_PCT (${maxAllowed})`,
      ).toBeLessThanOrEqual(maxAllowed + 0.01) // +0.01 for rounding
    }
  })

  it('grossEdge is always sharpProb - takerPrice regardless of other inputs', () => {
    const sharpProb = 0.70
    const takerPrice = 0.45

    const result = computeEdge({
      sharpProb,
      polyPrice: 0.45,
      takerPrice,
      sportKey: 'football',
      bankroll: 5000,
      existingPosition: 0,
      existingEventExposure: 0,
    })

    expect(result.grossEdge, `grossEdge must equal sharpProb(${sharpProb}) - takerPrice(${takerPrice})`).toBeCloseTo(sharpProb - takerPrice, 6)
  })
})

describe('checkExit', () => {
  const makePosition = (avgPrice: number, size: number) => ({
    tokenId: 'token-exit-test',
    slug: 'test-market',
    side: 'YES' as const,
    avgPrice,
    size,
    totalCost: avgPrice * size,
    openedAt: Date.now() - 3600_000,
  })

  it('returns shouldExit=false when edge is still positive', () => {
    // sharpProb > bestBid so edge is positive
    const bestBid = 0.55
    const sharpProb = 0.65
    const exitFee = expectedFee(bestBid)
    const edge = sharpProb - bestBid - exitFee

    // Only test if edge is actually positive given current MARKET_MAKER setting
    if (edge > 0) {
      const result = checkExit({
        position: makePosition(0.50, 100),
        currentPrice: 0.55,
        bestBid,
        sharpProb,
        sportKey: 'basketball',
      })

      expect(result.shouldExit, 'shouldExit should be false when edge is positive').toBe(false)
      expect(result.edge, `edge should be sharpProb(${sharpProb}) - bestBid(${bestBid}) - exitFee(${exitFee})`).toBeCloseTo(edge, 4)
    }
  })

  it('returns shouldExit=true with loss_cut reason when edge is strongly negative (< -2 × minEdge)', () => {
    // sharpProb much less than bestBid → edge deeply negative
    const bestBid = 0.80
    const sharpProb = 0.40  // edge = 0.40 - 0.80 - fee << 0
    const exitFee = expectedFee(bestBid)
    const edge = sharpProb - bestBid - exitFee

    // Confirm edge is actually < -2 × minEdge
    expect(edge, 'test setup: edge must be < -2 × minEdge for loss_cut').toBeLessThan(-2 * config.minEdge)

    const result = checkExit({
      position: makePosition(0.70, 100),
      currentPrice: 0.80,
      bestBid,
      sharpProb,
      sportKey: 'basketball',
    })

    expect(result.shouldExit, 'shouldExit should be true when edge < -2 × minEdge').toBe(true)
    expect(result.reason, 'reason should contain loss_cut').toMatch(/loss_cut/)
    expect(result.edge, `edge should be ${edge.toFixed(4)}`).toBeCloseTo(edge, 4)
  })

  it('returns shouldExit=false when edge is mildly negative but profit does not cover fees', () => {
    // Edge mildly gone but we bought at nearly the same price — profit < roundTripFee
    const avgPrice = 0.50
    const bestBid = 0.48   // slight drop, mildly negative edge
    const sharpProb = 0.47  // small negative edge, not severe
    const exitFee = expectedFee(bestBid)
    const edge = sharpProb - bestBid - exitFee

    // Edge should be mildly negative: between -2×minEdge and 0
    // Only run this test if the configuration produces the right scenario
    if (edge <= 0 && edge > -2 * config.minEdge) {
      const profitPerShare = bestBid - avgPrice  // negative in this case
      const entryFee = expectedFee(avgPrice)
      const roundTripFee = entryFee + exitFee

      if (profitPerShare < roundTripFee) {
        const result = checkExit({
          position: makePosition(avgPrice, 100),
          currentPrice: bestBid,
          bestBid,
          sharpProb,
          sportKey: 'basketball',
        })
        expect(result.shouldExit, 'shouldExit=false when profit < roundTripFee').toBe(false)
      }
    }
  })

  it('returns shouldExit=true with edge_gone reason when edge gone but profit covers fees', () => {
    // We bought cheap, price rose, now edge gone but profit > roundTripFee
    const avgPrice = 0.40
    const bestBid = 0.58   // price rose significantly
    const sharpProb = 0.57  // edge just gone
    const exitFee = expectedFee(bestBid)
    const edge = sharpProb - bestBid - exitFee

    const profitPerShare = bestBid - avgPrice  // 0.18
    const entryFee = expectedFee(avgPrice)
    const roundTripFee = entryFee + exitFee

    // Only test when scenario is valid for this config
    if (edge <= 0 && edge > -2 * config.minEdge && profitPerShare >= roundTripFee) {
      const result = checkExit({
        position: makePosition(avgPrice, 100),
        currentPrice: bestBid,
        bestBid,
        sharpProb,
        sportKey: 'basketball',
      })

      expect(result.shouldExit, 'shouldExit=true when profit covers round-trip fees').toBe(true)
      expect(result.reason, 'reason should contain edge_gone').toMatch(/edge_gone/)
    }
  })

  it('profitPerShare is correctly calculated as bestBid - avgPrice', () => {
    const avgPrice = 0.45
    const bestBid = 0.60
    const expected = bestBid - avgPrice

    const result = checkExit({
      position: makePosition(avgPrice, 50),
      currentPrice: bestBid,
      bestBid,
      sharpProb: 0.65, // positive edge — shouldExit=false
      sportKey: 'basketball',
    })

    expect(result.profitPerShare, `profitPerShare should be bestBid(${bestBid}) - avgPrice(${avgPrice})`).toBeCloseTo(expected, 4)
  })
})

describe('cooldown state', () => {
  const TOKEN_ID = `cooldown-test-${Date.now()}`

  beforeEach(() => {
    clearCooldown(TOKEN_ID)
  })

  it('fresh tokenId is not on cooldown', () => {
    expect(isOnCooldown(TOKEN_ID), 'brand new tokenId should not be on cooldown').toBe(false)
  })

  it('after markSignaled, tokenId is on cooldown', () => {
    markSignaled(TOKEN_ID)
    expect(isOnCooldown(TOKEN_ID), 'should be on cooldown immediately after markSignaled').toBe(true)
  })

  it('after clearCooldown, tokenId is no longer on cooldown', () => {
    markSignaled(TOKEN_ID)
    expect(isOnCooldown(TOKEN_ID)).toBe(true)
    clearCooldown(TOKEN_ID)
    expect(isOnCooldown(TOKEN_ID), 'should not be on cooldown after clearCooldown').toBe(false)
  })
})
