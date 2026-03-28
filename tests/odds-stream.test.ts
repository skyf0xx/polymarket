// tests/odds-stream.test.ts
// Integration tests for OddsStream.
// Tests hit the real Odds API (REST + WebSocket).
// ODDS_API_KEY must be set in .env.
//
// Rate limit note: The Odds API allows 5000 req/hr. Full rehydration with
// 5 sports can consume 500-3000 requests. Tests are structured to:
// 1. Use minimal targeted API calls where possible.
// 2. Share a single hydrated instance across related tests.
// 3. Skip gracefully when rate limited (429).

import 'dotenv/config'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OddsStream } from '../src/odds-stream.js'
import { config } from '../src/config.js'
import type { SharpLine } from '../src/types.js'

// ── Test whether the API is accessible ──────────────────────────

let apiAvailable = false
let restStream: OddsStream

beforeAll(async () => {
  // Quick probe: single /v3/events call (1 request) to check rate limit status
  try {
    const probeRes = await fetch(
      `${config.oddsApiRestUrl}/v3/events` +
      `?apiKey=${config.oddsApiKey}&sport=american-football&status=pending`,
      { signal: AbortSignal.timeout(15_000) },
    )
    apiAvailable = probeRes.ok
    if (!apiAvailable) {
      const body = await probeRes.text()
      console.warn(`[test] Odds API not available (${probeRes.status}): ${body.slice(0, 200)}`)
    }
  } catch (err) {
    console.warn('[test] Odds API probe failed:', err)
    apiAvailable = false
  }

  if (apiAvailable) {
    // Use a single OddsStream for all REST tests, hydrate once
    restStream = new OddsStream()
    await restStream.rehydrate()
  }
}, 300_000)

afterAll(() => {
  restStream?.destroy()
})

// ── REST hydration tests ─────────────────────────────────────────

describe('OddsStream — REST hydration', () => {
  it('rehydrate() completes without throwing; cache size >= 0', () => {
    if (!apiAvailable) {
      console.warn('[test] Skipping: Odds API rate limited or unavailable')
      return
    }
    expect(restStream.size, 'cache size should be >= 0').toBeGreaterThanOrEqual(0)
    expect(restStream.lastHydrateAt, 'lastHydrateAt should be > 0').toBeGreaterThan(0)
  })

  it('cache has at least 1 SharpLine when API is available', () => {
    if (!apiAvailable) {
      console.warn('[test] Skipping: Odds API rate limited or unavailable')
      return
    }
    expect(restStream.size, 'should have at least 1 event after hydration').toBeGreaterThan(0)
  })

  it('every SharpLine has required fields: eventId, homeTeam, awayTeam, sportKey, commence', () => {
    if (!apiAvailable || restStream.size === 0) {
      console.warn('[test] Skipping: cache is empty')
      return
    }

    for (const [eventId, line] of restStream.getAllLines()) {
      expect(eventId, 'map key must be non-empty').toBeTruthy()
      expect(line.eventId, `line.eventId must be non-empty (key=${eventId})`).toBeTruthy()
      expect(line.eventId, 'line.eventId must match map key').toBe(eventId)
      expect(line.homeTeam, `homeTeam must be non-empty for event ${eventId}`).toBeTruthy()
      expect(line.awayTeam, `awayTeam must be non-empty for event ${eventId}`).toBeTruthy()
      expect(line.sportKey, `sportKey must be non-empty for event ${eventId}`).toBeTruthy()
      expect(typeof line.commence, `commence must be a number for event ${eventId}`).toBe('number')
      expect(line.commence, `commence must be > 0 for event ${eventId}`).toBeGreaterThan(0)
      expect(typeof line.updatedAt, 'updatedAt must be a number').toBe('number')
    }
  })

  it('all h2h markets have probs in (0,1] and home+away+draw <= 1.05', () => {
    if (!apiAvailable || restStream.size === 0) return

    let checkedCount = 0
    for (const line of restStream.getAllLines().values()) {
      const h2h = line.markets.h2h
      if (!h2h) continue
      checkedCount++

      expect(h2h.home, `h2h.home must be > 0 for event ${line.eventId}`).toBeGreaterThan(0)
      expect(h2h.home, `h2h.home must be <= 1 for event ${line.eventId}`).toBeLessThanOrEqual(1)
      expect(h2h.away, `h2h.away must be > 0 for event ${line.eventId}`).toBeGreaterThan(0)
      expect(h2h.away, `h2h.away must be <= 1 for event ${line.eventId}`).toBeLessThanOrEqual(1)
      if (h2h.draw !== undefined) {
        expect(h2h.draw, `h2h.draw must be in (0,1]`).toBeGreaterThan(0)
        expect(h2h.draw, `h2h.draw must be <= 1`).toBeLessThanOrEqual(1)
      }
      const sum = h2h.home + h2h.away + (h2h.draw ?? 0)
      expect(sum, `h2h sum=${sum.toFixed(4)} for ${line.homeTeam} vs ${line.awayTeam} must be <= 1.05`).toBeLessThanOrEqual(1.05)
    }

    if (checkedCount > 0) console.log(`[test] Validated ${checkedCount} h2h markets`)
  })

  it('all totals markets have over+under <= 1.05', () => {
    if (!apiAvailable || restStream.size === 0) return

    for (const line of restStream.getAllLines().values()) {
      const totals = line.markets.totals
      if (!totals || totals.length === 0) continue

      for (const total of totals) {
        expect(total.over, `totals.over must be > 0 for event ${line.eventId}`).toBeGreaterThan(0)
        expect(total.over, `totals.over must be <= 1`).toBeLessThanOrEqual(1)
        expect(total.under, `totals.under must be > 0 for event ${line.eventId}`).toBeGreaterThan(0)
        expect(total.under, `totals.under must be <= 1`).toBeLessThanOrEqual(1)
        const sum = total.over + total.under
        expect(sum, `totals sum=${sum.toFixed(4)} for event ${line.eventId} must be <= 1.05`).toBeLessThanOrEqual(1.05)
      }
    }
  })

  it('all spreads markets have probs in (0,1]', () => {
    if (!apiAvailable || restStream.size === 0) return

    for (const line of restStream.getAllLines().values()) {
      const spreads = line.markets.spreads
      if (!spreads || spreads.length === 0) continue

      for (const spread of spreads) {
        expect(spread.home, `spreads.home must be > 0`).toBeGreaterThan(0)
        expect(spread.home, `spreads.home must be <= 1`).toBeLessThanOrEqual(1)
        expect(spread.away, `spreads.away must be > 0`).toBeGreaterThan(0)
        expect(spread.away, `spreads.away must be <= 1`).toBeLessThanOrEqual(1)
      }
    }
  })

  it('getLine() and getAllLines() return consistent data', () => {
    if (!apiAvailable || restStream.size === 0) return

    const firstEntry = [...restStream.getAllLines().entries()][0]
    if (!firstEntry) return

    const [eventId, line] = firstEntry
    const fetched = restStream.getLine(eventId)

    expect(fetched, `getLine("${eventId}") should return the SharpLine`).not.toBeUndefined()
    expect(fetched!.eventId, 'eventId should match').toBe(line.eventId)
    expect(fetched!.homeTeam, 'homeTeam should match').toBe(line.homeTeam)
  })

  it('getLine() returns undefined for an unknown eventId', () => {
    const cache = restStream ?? new OddsStream()
    const result = cache.getLine('event-id-that-does-not-exist-9999999')
    expect(result, 'getLine for unknown eventId should return undefined').toBeUndefined()
  })
})

// ── WebSocket tests ───────────────────────────────────────────────

describe('OddsStream — WebSocket', () => {
  it('WS connects and emits connected event within 15s', async () => {
    const stream = new OddsStream()

    try {
      const connectedPromise = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('WS connected event not received within 15s')),
          14_500,
        )
        stream.once('connected', () => {
          clearTimeout(timer)
          resolve()
        })
      })

      // Fire-and-forget start() — we only need the WS connection, not the REST hydration
      void stream.start()

      await connectedPromise
      // Connected — WS is working
    } finally {
      stream.destroy()
    }
  }, 15_000)

  it('start() emits odds_update within 30s when cache is pre-populated', async () => {
    if (!apiAvailable || !restStream || restStream.size === 0) {
      console.warn('[test] Skipping: Odds API rate limited or cache is empty. ' +
        'Re-run after rate limit resets (check Odds API dashboard for reset time).')
      return
    }

    const stream = new OddsStream()

    try {
      const updatePromise = new Promise<{ eventId: string; line: SharpLine }>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('No odds_update received within 30s — ' +
            'possible cause: no live market activity for configured sports')),
          29_500,
        )
        stream.once('odds_update', (eventId, line) => {
          clearTimeout(timer)
          resolve({ eventId, line })
        })
      })

      await stream.start()

      const { eventId, line } = await updatePromise

      expect(eventId, 'emitted eventId should be non-empty').toBeTruthy()
      expect(line.eventId, 'emitted line.eventId should be non-empty').toBeTruthy()
      expect(line.homeTeam, 'emitted line.homeTeam should be non-empty').toBeTruthy()
      expect(line.awayTeam, 'emitted line.awayTeam should be non-empty').toBeTruthy()
      expect(typeof line.commence, 'emitted line.commence should be a number').toBe('number')

      const h2h = line.markets.h2h
      if (h2h) {
        expect(h2h.home, 'WS update h2h.home must be > 0').toBeGreaterThan(0)
        expect(h2h.home, 'WS update h2h.home must be <= 1').toBeLessThanOrEqual(1)
        expect(h2h.away, 'WS update h2h.away must be > 0').toBeGreaterThan(0)
        expect(h2h.away, 'WS update h2h.away must be <= 1').toBeLessThanOrEqual(1)
        const sum = h2h.home + h2h.away + (h2h.draw ?? 0)
        expect(sum, `WS update h2h prob sum ${sum.toFixed(4)} must be <= 1.05`).toBeLessThanOrEqual(1.05)
      }
    } finally {
      stream.destroy()
    }
  }, 30_000)
})
