// tests/odds-stream.test.ts
// Integration tests for OddsStream.
// Tests hit the real Odds API WebSocket — no mocks.
// ODDS_API_KEY must be set in .env.
//
// Note: With no REST hydration, the cache populates entirely from WS.
// "updated" events for unknown IDs require a REST lookup for team names,
// which may 404 for some event IDs. Tests account for this.

import 'dotenv/config'
import { describe, it, expect, afterAll } from 'vitest'
import { OddsStream } from '../src/odds-stream.js'
import type { SharpLine } from '../src/types.js'

// ── Pure state tests — no network ───────────────────────────────

describe('OddsStream — state (no network)', () => {
  it('getLine() returns undefined for an unknown eventId', () => {
    const stream = new OddsStream()
    const result = stream.getLine('event-id-that-does-not-exist-9999999')
    expect(result, 'getLine for unknown eventId should return undefined').toBeUndefined()
  })

  it('size is 0 before start', () => {
    const stream = new OddsStream()
    expect(stream.size, 'size should be 0 before start').toBe(0)
  })

  it('getAllLines() returns an empty Map before start', () => {
    const stream = new OddsStream()
    const all = stream.getAllLines()
    expect(all instanceof Map, 'getAllLines should return a Map').toBe(true)
    expect(all.size, 'Map should be empty before start').toBe(0)
  })
})

// ── WebSocket tests ───────────────────────────────────────────────
// We use a single shared stream and collect updates over time to avoid
// spinning up multiple WS connections that race for the same events.

describe('OddsStream — WebSocket', () => {
  let stream: OddsStream
  let firstUpdate: { eventId: string; line: SharpLine } | null = null

  afterAll(() => {
    stream?.destroy()
  })

  it('WS connects, receives updates, and populates cache', async () => {
    stream = new OddsStream()

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

    const updatePromise = new Promise<{ eventId: string; line: SharpLine }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('No odds_update received within 120s — ' +
          'possible cause: no live market activity, or REST 404s for all event IDs')),
        119_500,
      )
      stream.once('odds_update', (eventId, line) => {
        clearTimeout(timer)
        resolve({ eventId, line })
      })
    })

    stream.start()

    // Step 1: verify connection
    await connectedPromise

    // Step 2: wait for first odds_update (requires successful REST lookup)
    firstUpdate = await updatePromise

    // Step 3: validate the update
    expect(firstUpdate.eventId, 'emitted eventId should be non-empty').toBeTruthy()
    expect(firstUpdate.line.eventId, 'line.eventId should be non-empty').toBeTruthy()
    expect(firstUpdate.line.homeTeam, 'line.homeTeam should be non-empty').toBeTruthy()
    expect(firstUpdate.line.awayTeam, 'line.awayTeam should be non-empty').toBeTruthy()
    expect(typeof firstUpdate.line.commence, 'line.commence should be a number').toBe('number')

    // Step 4: validate h2h if present (exchange overround can be up to ~15%)
    const h2h = firstUpdate.line.markets.h2h
    if (h2h) {
      expect(h2h.home, 'h2h.home must be > 0').toBeGreaterThan(0)
      expect(h2h.home, 'h2h.home must be <= 1').toBeLessThanOrEqual(1)
      expect(h2h.away, 'h2h.away must be > 0').toBeGreaterThan(0)
      expect(h2h.away, 'h2h.away must be <= 1').toBeLessThanOrEqual(1)
      const sum = h2h.home + h2h.away + (h2h.draw ?? 0)
      expect(sum, `h2h prob sum ${sum.toFixed(4)} must be <= 1.15`).toBeLessThanOrEqual(1.15)
    }

    // Step 5: verify cache is consistent
    expect(stream.size, 'cache should have at least 1 entry').toBeGreaterThan(0)

    const fetched = stream.getLine(firstUpdate.eventId)
    expect(fetched, `getLine("${firstUpdate.eventId}") should return the SharpLine`).not.toBeUndefined()

    const allLines = stream.getAllLines()
    expect(allLines.has(firstUpdate.eventId), 'getAllLines should contain the event').toBe(true)
    expect(allLines.get(firstUpdate.eventId)!.eventId).toBe(fetched!.eventId)
  }, 120_000)
})
