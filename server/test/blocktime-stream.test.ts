import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ftl-blocktime-stream-'))
process.env.DATA_DIR = tmp
process.env.HELIUS_API_KEY = 'test-key-never-sent'
const require = createRequire(import.meta.url)
const sdk = require('helius-laserstream')
const oldSubscribe = sdk.subscribe
let onData: ((update: any) => void) | undefined
let initialRequest: any
let cancellations = 0
sdk.subscribe = async (_config: unknown, request: unknown, callback: (update: any) => void) => {
  initialRequest = request
  onData = callback
  return { write: async () => {}, cancel: () => { cancellations++ } }
}

const { db } = await import('../src/db.ts')
const { startBlockTimeStream, finalizedBlockTime, recordBlockMeta, recordFinalizedSlot,
  setFallbackPrograms, blockTimeUsage } = await import('../src/solana/blocktime.ts')
const { programIds } = await import('../src/solana/programs.ts')
after(() => {
  sdk.subscribe = oldSubscribe
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.HELIUS_API_KEY
})

test('a finalized metadata parent gap cannot advance the safe replay checkpoint or reopen coverage', async () => {
  const mint = 'So11111111111111111111111111111111111111112'
  db.prepare('INSERT INTO research_tokens(chain,address,first_seen_ts) VALUES(?,?,?)')
    .run('solana', mint, Date.now())
  const events: any[] = []
  const stop = await startBlockTimeStream({ onStream: e => events.push(e) })
  assert.ok(onData)
  const filterName = Object.keys(initialRequest.blocksMeta)[0]
  const now = Date.now()
  const meta = (slot: number, parentSlot: number) => ({
    filters: [filterName], createdAt: new Date(now), blockMeta: {
      slot, parentSlot, blockhash: `block-${slot}`,
      blockTime: { timestamp: Math.floor(now / 1000) },
    },
  })
  onData!({ filters: [filterName], slot: { slot: 100, status: 2 }, createdAt: new Date(now) })
  onData!(meta(100, 99))
  assert.ok(events.some(e => e.t === 'open' && e.token === mint))
  onData!(meta(102, 101)) // 101 was never delivered
  assert.equal(finalizedBlockTime(102), null)
  assert.ok(events.some(e => e.t === 'gap' && !e.token))
  assert.equal(events.filter(e => e.t === 'open' && e.token === mint).length, 1)
  stop()
  assert.ok(cancellations >= 1)
})

test('a restarted stream resumes an earlier session only after verified replay reaches the live tip', async () => {
  const mint = 'So11111111111111111111111111111111111111112'
  const now = Date.now()
  db.prepare(`INSERT INTO research_stream_sessions(lane,token,started_ts,last_pulse_ts,ended_ts)
    VALUES('laserstream',?,?,?,?)`).run(mint, now - 10_000, now - 2_000, now - 2_000)
  const events: any[] = []
  const stop = await startBlockTimeStream({ onStream: e => events.push(e) })
  assert.ok(onData)
  const filterName = Object.keys(initialRequest.blocksMeta)[0]
  // First callback has an old provider creation time, so replay is still catching up.
  onData!({ filters: [filterName], createdAt: new Date(now - 60_000), blockMeta: {
    slot: 100, parentSlot: 99, blockhash: 'block-100', blockTime: { timestamp: Math.floor(now / 1000) },
  } })
  assert.equal(events.filter(e => e.t === 'resume').length, 0)
  onData!({ filters: [filterName], createdAt: new Date(now), blockMeta: {
    slot: 101, parentSlot: 100, blockhash: 'block-101', blockTime: { timestamp: Math.floor(now / 1000) },
  } })
  assert.ok(events.some(e => e.t === 'resume' && e.token === mint))
  stop()
})

test('enabling FTL fallback restarts with an inclusive finalized checkpoint before the Flux tip', async () => {
  const now = Date.now()
  for (const slot of [600, 700]) {
    recordFinalizedSlot(slot)
    assert.equal(recordBlockMeta(slot, `block-${slot}`, now), true)
  }
  const stop = await startBlockTimeStream()
  const initialFilter = Object.keys(initialRequest.blocksMeta)[0]
  assert.equal(initialRequest.fromSlot, 700)
  const applied = setFallbackPrograms([programIds[0]], 800)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.notEqual(Object.keys(initialRequest.blocksMeta)[0], initialFilter)
  assert.equal(initialRequest.fromSlot, 100)
  assert.deepEqual(Object.values(initialRequest.transactions).find((filter: any) =>
    filter.accountInclude?.includes(programIds[0]))?.accountInclude, [programIds[0]])
  stop()
  assert.equal(await applied, false)
  await setFallbackPrograms([])
})

test('holder transactions wait for named filter acknowledgement and receive a linked-slot watermark', async () => {
  const mint = 'So11111111111111111111111111111111111111112'
  const transactions: any[] = []
  const events: any[] = []
  const metadataGaps: string[] = []
  const stop = await startBlockTimeStream({ fromSlot: 800,
    onHolderTransaction: tx => transactions.push(tx), onHolderStream: e => events.push(e),
    onHolderMetadataGap: reason => metadataGaps.push(reason) })
  const filterName = Object.keys(initialRequest.blocksMeta)[0]
  const now = Date.now()
  const tx = (slot: number, index: number) => ({ filters: [filterName], transaction: {
    slot, transaction: { index, meta: { preTokenBalances: [{ mint }], postTokenBalances: [{ mint }] } },
  } })
  onData!(tx(800, 0))
  onData!({ filters: [filterName], transaction: { slot: 800, transaction: { index: 1, meta: {} } } })
  assert.equal(transactions.length, 0)
  assert.equal(metadataGaps.length, 0)
  onData!({ filters: [filterName], createdAt: new Date(now), blockMeta: {
    slot: 800, parentSlot: 799, blockhash: 'block-800', blockTime: { timestamp: Math.floor(now / 1000) },
  } })
  assert.equal(transactions.length, 1)
  assert.equal(metadataGaps.length, 1)
  assert.ok(events.some(e => e.t === 'open' && e.token === mint))
  onData!({ filters: [filterName], createdAt: new Date(now), blockMeta: {
    slot: 801, parentSlot: 800, blockhash: 'block-801', blockTime: { timestamp: Math.floor(now / 1000) },
  } })
  assert.ok(events.some(e => e.t === 'pulse' && e.coveredThroughSlot === 800))
  onData!(tx(801, 1))
  assert.equal(transactions.length, 2)
  onData!({ filters: [filterName], transaction: { slot: 801, transaction: { index: 2,
    meta: { preTokenBalances: [], postTokenBalances: [] } } } })
  assert.equal(metadataGaps.length, 1) // a valid empty-array false positive is harmless
  stop()
})

test('byte telemetry samples the decoded stream while all updates remain counted', async () => {
  const before = blockTimeUsage()
  const stop = await startBlockTimeStream()
  for (let n = 0; n < 32; n++) onData!({ filters: ['unrelated'] })
  const after = blockTimeUsage()
  assert.equal(after.budgetPayloadSamples - before.budgetPayloadSamples, 2)
  assert.ok(after.estimatedWindowPayloadBytes > before.estimatedWindowPayloadBytes)
  stop()
})
