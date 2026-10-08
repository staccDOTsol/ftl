import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import bs58 from 'bs58'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ftl-blocktime-test-'))
const oldCap = process.env.HELIUS_BLOCKTIME_MAX_MIB_PER_HOUR
process.env.DATA_DIR = tmp
delete process.env.HELIUS_BLOCKTIME_MAX_MIB_PER_HOUR
const { db } = await import('../src/db.ts')
const { finalizedBlockTime, waitForFinalizedBlockTime, recordFinalizedSlot,
  recordBlockMeta, researchLaserStreamRequest, blockTimeUsage } = await import('../src/solana/blocktime.ts')
after(() => {
  db.close(); fs.rmSync(tmp, { recursive: true, force: true })
  if (oldCap === undefined) delete process.env.HELIUS_BLOCKTIME_MAX_MIB_PER_HOUR
  else process.env.HELIUS_BLOCKTIME_MAX_MIB_PER_HOUR = oldCap
})

test('a block timestamp is available only after finalized slot and block metadata agree', async () => {
  const slot = 900_123
  const pending = waitForFinalizedBlockTime(slot, 1_000)
  recordBlockMeta(slot, 'canonical-block', Date.UTC(2026, 9, 7, 10))
  assert.equal(finalizedBlockTime(slot), null)
  recordFinalizedSlot(slot)
  assert.equal(await pending, Date.UTC(2026, 9, 7, 10))
  assert.equal(finalizedBlockTime(slot), Date.UTC(2026, 9, 7, 10))
  assert.equal(recordBlockMeta(slot, 'different-block', Date.UTC(2026, 9, 7, 11)), false)
  assert.equal(finalizedBlockTime(slot), null) // conflicting final metadata fails closed
})

test('targeted request combines exact finalized block time and mint matching on one stream', () => {
  const mint = 'So11111111111111111111111111111111111111112'
  const request = researchLaserStreamRequest([mint], 900_000)
  assert.equal(request.commitment, 2)
  assert.equal(request.fromSlot, 900_000)
  assert.deepEqual(request.transactions.research.accountInclude, [mint])
  assert.equal((request.transactions.research as any).matchMints, true)
  assert.ok(request.blocksMeta.research)
  assert.equal(request.slots.research.filterByCommitment, true)
  assert.equal(blockTimeUsage().budgetLimitBytes, 0) // telemetry-only default
})

test('a growing mint universe uses the transaction cuckoo filter without a list cap', () => {
  const mints = Array.from({ length: 12 }, (_, i) => bs58.encode(Buffer.alloc(32, i + 1)))
  const request = researchLaserStreamRequest(mints, undefined, 'generation2')
  const tx = (request.transactions as any).generation2
  assert.deepEqual(tx.accountInclude, [])
  assert.equal(tx.matchMints, true)
  assert.ok(tx.cuckooAccountInclude?.data)
  assert.ok(request.blocksMeta.generation2)
  assert.ok(request.slots.generation2)
})

test('FTL fallback programs are a separate named filter on the same finalized stream', () => {
  const mint = 'So11111111111111111111111111111111111111112'
  const program = '6EF8rrecthR5Dkzon8NwuFudmmJLSqAeLfnKQdpEABKp'
  const request = researchLaserStreamRequest([mint], undefined, 'generation3', [program])
  assert.deepEqual((request.transactions as any).generation3.accountInclude, [mint])
  assert.deepEqual((request.transactions as any).fgeneration3.accountInclude, [program])
  assert.equal((request.transactions as any).fgeneration3.matchMints, undefined)
  assert.ok(request.blocksMeta.generation3)
})
