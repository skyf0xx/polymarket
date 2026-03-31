// tests/odds-stream.test.ts
// Unit tests for OddsStream state (no network).

import 'dotenv/config'
import { describe, it, expect } from 'vitest'
import { OddsStream } from '../src/odds-stream.js'

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
