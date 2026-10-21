import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import bs58 from 'bs58'
import { ProgramIndex } from '../src/solana/program-index.ts'
import { observePrograms } from '../src/solana/program-observation.ts'
import { pruneProgramHistory } from '../src/solana/program-retention.ts'
import type { NTx } from '../src/solana/decode.ts'

const address = (byte: number) => bs58.encode(new Uint8Array(32).fill(byte))
const caller = address(21), callee = address(22), wallet = address(23)
const tx = (sig: string): NTx => ({ sig, slot: 1, version: 1,
  keys: [wallet, caller, callee], keyFlags: [{ signer: true, writable: true }, { signer: false, writable: false }, { signer: false, writable: false }],
  ixs: [{ prog: caller, n: '0', data: new Uint8Array([1]), accts: [0] }, { prog: callee, n: '0.0', stackHeight: 2, data: new Uint8Array([2]), accts: [0] }], failed: false })
const count = (db: DatabaseSync, table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
const DAY = 86_400_000

test('retention clears per-transaction history older than the window and keeps the learned registry', async () => {
  const db = new DatabaseSync(':memory:')
  let clock = 1_000 * DAY
  const index = new ProgramIndex({ db, enabled: true, now: () => clock, fetcher: (async () => { throw new Error('offline') }) as typeof fetch })
  // 30 transactions a day for 20 days, appended in time order like the live lanes
  for (let day = 0; day < 20; day++) {
    for (let i = 0; i < 30; i++) {
      clock = 1_000 * DAY + day * DAY + i * 1000
      index.observeMany([observePrograms(tx(`d${day}-${i}`), 'geyser-primary', clock)!])
    }
  }
  const before = { tx: count(db, 'program_transactions'), receipts: count(db, 'program_receipts'), edges: count(db, 'program_edge_receipts') }
  assert.equal(before.tx, 600)
  assert.ok(before.receipts >= 600 && before.edges >= 600)

  const cutoff = 1_000 * DAY + 6 * DAY // keep days 6..19 (a 14-day window)
  const counts = await pruneProgramHistory(db, cutoff)
  assert.equal(count(db, 'program_transactions'), 14 * 30)
  assert.equal(counts.program_transactions, 6 * 30)
  assert.equal(Number((db.prepare('SELECT MIN(ts) AS m FROM program_transactions').get() as { m: number }).m), cutoff)
  assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM program_receipts WHERE ts < ?').get(cutoff) as { n: number }).n), 0)
  assert.equal(count(db, 'program_receipts'), before.receipts * 14 / 20)
  assert.equal(count(db, 'program_edge_receipts'), before.edges * 14 / 20)
  assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM program_activity WHERE ts < ?').get(cutoff) as { n: number }).n), 0)
  // the learned registry is untouched: both programs, their lifetime counts and the edge between them stay
  assert.equal(count(db, 'programs'), 2)
  assert.equal(Number((db.prepare('SELECT transactions FROM programs WHERE address = ?').get(caller) as { transactions: number }).transactions), 600)
  assert.equal(count(db, 'program_edges'), 1)
  assert.ok(count(db, 'program_buckets') > 0)

  // a second pass with the same cutoff clears nothing; an empty index is a no-op
  const again = await pruneProgramHistory(db, cutoff)
  assert.equal(Object.values(again).reduce((a, n) => a + n, 0), 0)
  const empty = new DatabaseSync(':memory:')
  new ProgramIndex({ db: empty, enabled: false })
  assert.equal(Object.values(await pruneProgramHistory(empty, Date.now())).reduce((a, n) => a + n, 0), 0)
})
