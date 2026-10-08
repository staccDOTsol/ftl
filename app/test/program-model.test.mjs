import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeProgramBuckets, mergeProgramUpdate } from '../src/lib/program-model.ts'

const record = (address, options = {}) => ({ address, infrastructure: false, known: false, firstSeenTs: 100, transactions: 1, state: 'queued', priority: 1, ...options })
test('live program deltas ignore stale sequence numbers, patch progress in place, and order net-new arrivals', () => {
  const previous = { items: [record('old')], sequence: 4, total: 1, activity: [], buckets: [] }
  const update = { sequence: 5, records: [record('new', { firstSeenTs: 200 }), record('old', { state: 'learning' })], activity: [{ id: 2 }],
    totals: { unseen: 2 }, coverage: {}, buckets: [], ts: 3600000 }
  const result = mergeProgramUpdate(previous, update, 'new', '', 1)
  assert.deepEqual(result.items.map(x => [x.address, x.state]), [['new', 'queued'], ['old', 'learning']])
  assert.equal(result.total, 2)
  assert.equal(mergeProgramUpdate(result, { ...update, sequence: 4 }, 'new', '', 1), result)
})
test('an interface completion exits the progress view and enters the IDL index without duplicating activities', () => {
  const previous = { items: [record('a')], sequence: 1, total: 1, activity: [{ id: 4 }], buckets: [] }
  const update = { sequence: 2, records: [record('a', { state: 'partial', idlHash: 'proof' })], activity: [{ id: 4 }], totals: {}, coverage: {}, buckets: [], ts: 3600000 }
  assert.equal(mergeProgramUpdate(previous, update, 'working', '', 1).items.length, 0)
  const interfaces = mergeProgramUpdate({ ...previous, items: [] }, update, 'interfaces', '', 1)
  assert.equal(interfaces.items.length, 1)
  assert.equal(interfaces.activity.length, 1)
})
test('minute-level WebSocket history does not erase the earlier portion of coarse six-hour history', () => {
  const minute = 60000, start = 60 * minute
  const previous = [{ ts: start, discoveries: 12, learned: 4, transactions: 20, invocations: 40, atomic: 2 }]
  const incoming = [{ ts: start + minute, discoveries: 1, learned: 0, transactions: 2, invocations: 3, atomic: 0 },
    { ts: start + 5 * minute, discoveries: 2, learned: 1, transactions: 3, invocations: 8, atomic: 1 }]
  const result = mergeProgramBuckets(previous, incoming, 6, start + 6 * minute)
  assert.equal(result.find(x => x.ts === start).discoveries, 12)
  assert.equal(result.find(x => x.ts === start + 5 * minute).discoveries, 2)
})
