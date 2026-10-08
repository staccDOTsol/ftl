import test from 'node:test'
import assert from 'node:assert/strict'
import { eventContext, eventLink } from '../src/lib/event-context.ts'
const event = { id: 'solana:signature:3', chain: 'solana', kind: 'liq_remove', stage: 'confirmed', token: 'mint', wallet: 'observed-wallet', pool: 'pool', venue: 'orca' }
test('feed and pull alerts retain the event while never assigning the observed wallet as owner', () => {
  const url = new URL(eventLink(event), 'https://liquidityxyz.fun')
  assert.equal(url.pathname, '/token/solana/mint')
  assert.equal(url.searchParams.get('event'), event.id)
  assert.equal(url.searchParams.get('action'), 'exit')
  assert.equal(url.searchParams.has('owner'), false)
  assert.equal(url.searchParams.has('wallet'), false)
  assert.equal(eventContext(event.id, 'solana', 'mint'), event)
})
test('a stale or foreign event cannot become another token or chain context', () => {
  eventLink(event)
  assert.equal(eventContext(event.id, 'solana', 'other-mint'), null)
  assert.equal(eventContext(event.id, 'robinhood', 'mint'), null)
  assert.equal(eventContext('missing', 'solana', 'mint'), null)
})
test('pool initialization offers liquidity context without guessing a user position', () => {
  const url = new URL(eventLink({ ...event, kind: 'pool_init' }), 'https://liquidityxyz.fun')
  assert.equal(url.searchParams.get('action'), 'liquidity')
  assert.equal(url.searchParams.has('position'), false)
})
