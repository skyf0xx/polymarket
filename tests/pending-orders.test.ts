// tests/pending-orders.test.ts
// Integration tests for PendingOrders — pure in-memory state, no network calls.

import 'dotenv/config'
import { describe, it, expect, beforeEach } from 'vitest'
import { PendingOrders } from '../src/pending-orders.js'

describe('PendingOrders', () => {
  let pending: PendingOrders

  beforeEach(() => {
    pending = new PendingOrders()
  })

  it('size starts at 0', () => {
    expect(pending.size, 'brand new PendingOrders should have size=0').toBe(0)
  })

  it('add() then getTokenNotional() returns price × size', () => {
    const orderId = 'order-001'
    const tokenId = 'token-001'
    const price = 0.60
    const size = 100

    pending.add(orderId, tokenId, price, size)

    const notional = pending.getTokenNotional(tokenId)
    const expected = price * size  // 60

    expect(notional, `notional should be price(${price}) × size(${size}) = ${expected}`).toBeCloseTo(expected, 4)
    expect(pending.size, 'size should be 1 after adding one order').toBe(1)
  })

  it('add() twice for same token: notional accumulates', () => {
    const tokenId = 'token-multi'
    pending.add('order-a', tokenId, 0.50, 100)  // notional=50
    pending.add('order-b', tokenId, 0.40, 200)  // notional=80

    const total = pending.getTokenNotional(tokenId)
    const expected = 50 + 80  // 130

    expect(total, `accumulated notional should be ${expected}`).toBeCloseTo(expected, 4)
    expect(pending.size, 'size should be 2 after two add() calls').toBe(2)
  })

  it('add() for different tokens: getTokenNotional is isolated per token', () => {
    pending.add('order-x', 'token-x', 0.50, 100)  // notional=50
    pending.add('order-y', 'token-y', 0.60, 200)  // notional=120

    expect(pending.getTokenNotional('token-x'), 'token-x notional should be 50').toBeCloseTo(50, 4)
    expect(pending.getTokenNotional('token-y'), 'token-y notional should be 120').toBeCloseTo(120, 4)
  })

  it('remove() by orderId: notional drops to 0 and size decreases', () => {
    const orderId = 'order-remove'
    const tokenId = 'token-remove'
    pending.add(orderId, tokenId, 0.50, 100)

    expect(pending.getTokenNotional(tokenId)).toBeCloseTo(50, 4)

    pending.remove(orderId)

    expect(pending.getTokenNotional(tokenId), 'notional should be 0 after remove()').toBe(0)
    expect(pending.size, 'size should be 0 after removing the only order').toBe(0)
  })

  it('remove() unknown orderId: does not throw', () => {
    expect(() => {
      pending.remove('nonexistent-order-xyz')
    }, 'remove() for unknown orderId must not throw').not.toThrow()
  })

  it('remove() one of two orders for same token: remaining notional is correct', () => {
    const tokenId = 'token-partial-remove'
    pending.add('order-1', tokenId, 0.50, 100)  // notional=50
    pending.add('order-2', tokenId, 0.40, 100)  // notional=40

    pending.remove('order-1')

    expect(pending.getTokenNotional(tokenId), 'notional should be 40 after removing order-1').toBeCloseTo(40, 4)
    expect(pending.size, 'size should be 1').toBe(1)
  })

  it('removeByToken(): all orders for that token are cleared', () => {
    const tokenId = 'token-clear'
    pending.add('order-a', tokenId, 0.50, 100)
    pending.add('order-b', tokenId, 0.60, 100)
    pending.add('order-c', 'other-token', 0.70, 100)  // different token — should survive

    pending.removeByToken(tokenId)

    expect(pending.getTokenNotional(tokenId), 'cleared token notional should be 0').toBe(0)
    expect(pending.getTokenNotional('other-token'), 'other-token notional should be unaffected').toBeCloseTo(70, 4)
    expect(pending.size, 'size should be 1 (only other-token remains)').toBe(1)
  })

  it('removeByToken() for unknown token: does not throw', () => {
    expect(() => {
      pending.removeByToken('nonexistent-token-xyz')
    }, 'removeByToken() for unknown token must not throw').not.toThrow()
  })

  it('pruneExpired(): orders older than 5 min are removed, recent ones kept', async () => {
    // Add a recent order (will survive)
    pending.add('recent-order', 'token-recent', 0.50, 100)

    // Manually inject a stale entry by directly accessing the private map
    // We do this by using type assertion to reach the private field
    const pendingAny = pending as unknown as {
      orders: Map<string, { orderId: string; tokenId: string; notional: number; placedAt: number }>
    }
    const FIVE_MIN_MS = 5 * 60 * 1000
    pendingAny.orders.set('stale-order', {
      orderId: 'stale-order',
      tokenId: 'token-stale',
      notional: 30,
      placedAt: Date.now() - FIVE_MIN_MS - 1000,  // 1s past TTL
    })

    expect(pending.size, 'should have 2 orders before prune').toBe(2)

    const pruned = pending.pruneExpired()

    expect(pruned, 'pruneExpired() should return 1 (the stale order)').toBe(1)
    expect(pending.size, 'size should be 1 after pruning stale order').toBe(1)
    expect(pending.getTokenNotional('token-recent'), 'recent order should survive prune').toBeCloseTo(50, 4)
    expect(pending.getTokenNotional('token-stale'), 'stale order should be gone').toBe(0)
  })

  it('pruneExpired() returns 0 when no orders are expired', () => {
    pending.add('fresh-1', 'token-fresh', 0.50, 100)
    pending.add('fresh-2', 'token-fresh', 0.60, 50)

    const pruned = pending.pruneExpired()

    expect(pruned, 'pruneExpired() should return 0 for fresh orders').toBe(0)
    expect(pending.size, 'size should be unchanged').toBe(2)
  })

  it('getTokenNotional returns 0 for a token with no orders', () => {
    const notional = pending.getTokenNotional('token-never-added')
    expect(notional, 'getTokenNotional should return 0 for unknown token').toBe(0)
  })
})
