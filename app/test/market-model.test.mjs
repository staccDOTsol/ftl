import test from 'node:test'
import assert from 'node:assert/strict'
import { activityBuckets, rankTokens, recentEvents } from '../src/lib/market-model.ts'
import { composerFeeLabel } from '../src/lib/solana-trade.ts'

const token = (address, properties = {}) => ({ chain: 'solana', address, pools: 1, fundedPools: 1, lpWallets: 2, events: 1, lastTs: 1000, score: 10, flags: [], firstPoolTs: 900, launchedTs: null, launchVenue: null, graduatedTs: null, ...properties })
const event = (id, properties = {}) => ({ id, chain: 'solana', token: 'mint', kind: 'liq_add', stage: 'confirmed', ts: 500, ...properties })

test('a token appearing on the stream joins the board before the next snapshot', () => {
  const snapshot = [token('old')]
  const updates = [token('new', { score: 25, lastTs: 1200 })]
  assert.deepEqual(rankTokens(snapshot, updates, 'all', 'hot', 0).map(t => t.address), ['new', 'old'])
  assert.deepEqual(snapshot.map(t => t.address), ['old'])
})

test('a late HTTP snapshot cannot erase newer liquidity counts, and old tokens leave the window', () => {
  const rows = rankTokens([token('a', { lastTs: 900, lpWallets: 1 }), token('expired', { lastTs: 10 })], [token('a', { lastTs: 1000, lpWallets: 7 }), token('rh', { chain: 'robinhood' }), token('launch-only', { pools: 0 })], 'solana', 'wallets', 500)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].lpWallets, 7)
})

test('HTTP/WS overlap, confirmation upgrades and metadata do not duplicate an activity row', () => {
  const rows = recentEvents([
    event('same', { stage: 'pending', tokenMeta: { symbol: 'FLOW' } }),
    event('same', { stage: 'confirmed', confirmedTs: 700 }),
    event('same', { stage: 'pending' }),
    event('same', { stage: 'confirmed', tokenMeta: { image: 'https://example.com/icon.png' } }),
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].stage, 'confirmed')
  assert.equal(rows[0].confirmedTs, 700)
  assert.equal(rows[0].tokenMeta.symbol, 'FLOW')
  assert.equal(rows[0].tokenMeta.image, 'https://example.com/icon.png')
})

test('the pulse charts only confirmed observed moves, including exact time-window edges', () => {
  const events = [event('before', { ts: 99 }), event('in', { ts: 100 }), event('in', { ts: 100 }), event('out', { ts: 200, kind: 'liq_remove' }), event('pending', { stage: 'pending', ts: 120 }), event('failed', { stage: 'failed', ts: 150 }), event('launch', { ts: 151, kind: 'launch' }), event('later', { ts: 201 })]
  const buckets = activityBuckets(events, 100, 200, 2)
  assert.deepEqual(buckets.map(({ incoming, outgoing, launches }) => [incoming, outgoing, launches]), [[1, 0, 0], [0, 1, 1]])
  assert.equal(activityBuckets(events, 200, 100, 0).length, 1)
})

test('per-hop fees and atomic execution are claimed only for a composed quote', () => {
  assert.equal(composerFeeLabel({}), null)
  assert.equal(composerFeeLabel({ hops: 2, composerFeeBps: 10 }), null)
  assert.equal(composerFeeLabel({ composed: true, hops: 2, composerFeeBps: 10 }), '0.1% per hop · 2 hops · in kind')
  assert.equal(composerFeeLabel({ composed: true, hops: 3, composerFeeBps: 0 }), '0% per hop · 3 hops · in kind')
  assert.equal(composerFeeLabel({ composed: true, hops: 2 }), 'Fee not reported')
  assert.equal(composerFeeLabel({ composed: true, hops: 2, composerFeeBps: -10 }), 'Fee not reported')
  assert.equal(composerFeeLabel({ composed: true, hops: 9, composerFeeBps: 10 }), null)
})
