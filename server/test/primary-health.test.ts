import test from 'node:test'
import assert from 'node:assert/strict'
import { primaryStreamFresh } from '../src/solana/lanes.ts'

test('primary health requires fresh slot or transaction data, not just ping traffic', () => {
  const now = 100_000
  assert.equal(primaryStreamFresh({ connected: true, lastDataTs: now - 14_999 }, now), true)
  assert.equal(primaryStreamFresh({ connected: true, lastDataTs: now - 15_001 }, now), false)
  assert.equal(primaryStreamFresh({ connected: true }, now), false)
  assert.equal(primaryStreamFresh({ connected: false, lastDataTs: now }, now), false)
  const pingOnly = { connected: true, lastDataTs: now - 15_001, lastMsgTs: now }
  assert.equal(primaryStreamFresh(pingOnly, now), false)
})
