import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { archivalTransaction, SolanaPriceArchive } from '../src/solana/archive.ts'
import { extractSwap, type SwapObservation } from '../src/solana/swaps.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const venueRows = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/solana-archive-venues.json'), 'utf8')) as
  { venue: string; token: string; sig: string; row: any }[]
const row = venueRows.find(x => x.venue === 'pumpswap')!.row
const token = venueRows.find(x => x.venue === 'pumpswap')!.token
const signature = venueRows.find(x => x.venue === 'pumpswap')!.sig
const DAY = 86_400_000
const start = Date.UTC(2026, 8, 8), end = Date.UTC(2026, 9, 9)

function setup(responses: unknown[]) {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE research_swaps (
    id TEXT PRIMARY KEY, chain TEXT, token TEXT, finalized INTEGER, ts INTEGER, slot INTEGER);
    CREATE TABLE research_tokens(chain TEXT,address TEXT);`)
  db.prepare('INSERT INTO research_tokens VALUES(?,?)').run('solana', token)
  const calls: any[] = [], emitted: SwapObservation[] = []
  const fetcher = async (_url: any, init: any) => {
    calls.push(JSON.parse(init.body))
    return new Response(JSON.stringify(responses.shift()), { status: 200 })
  }
  const archive = new SolanaPriceArchive({ db, endpoint: 'https://example.invalid/rpc',
    fetch: fetcher as typeof fetch, now: () => end + DAY + calls.length,
    onSwap: swap => {
      emitted.push(swap)
      db.prepare('INSERT OR IGNORE INTO research_swaps VALUES(?,?,?,?,?,?)')
        .run(`solana:${swap.id}`, 'solana', swap.token, Number(swap.finalized), swap.ts, swap.slot)
    } })
  return { db, archive, calls, emitted }
}

test('raw Helius archive transactions match finalized live swaps in all eight observed venues', () => {
  assert.equal(venueRows.length, 8)
  for (const sample of venueRows) {
    const { tx, ts } = archivalTransaction(sample.row)
    const swap = extractSwap(tx, ts)
    assert.equal(swap?.id, sample.sig, sample.venue)
    assert.equal(swap?.token, sample.token, sample.venue)
    assert.equal(swap?.venue, sample.venue)
  }
  const { tx, ts } = archivalTransaction(row)
  assert.equal(tx.sig, signature)
  assert.equal(ts, row.blockTime * 1000)
  const swap = extractSwap(tx, ts)
  assert.equal(swap?.token, token)
  assert.equal(swap?.venue, 'pumpswap')
  assert.equal(swap?.quoteSymbol, 'SOL')
  assert.ok(swap?.priceQuote && swap.priceQuote > 0)
})

test('cursor pages resume and verify each pre-existing live overlap signature', async () => {
  const { db, archive, calls, emitted } = setup([
    { result: { data: [row], paginationToken: '454424229:1' } },
    { result: { data: [], paginationToken: null } },
  ])
  db.prepare('INSERT INTO research_swaps VALUES(?,?,?,?,?,?)')
    .run(`solana:${signature}`, 'solana', token, 1, row.blockTime * 1000, row.slot)
  assert.equal(archive.enqueue(token, start, end, row.slot), true)
  assert.equal(archive.get(token)?.overlapMissing, 1)
  assert.equal((await archive.next())?.state, 'running')
  assert.equal(archive.get(token)?.overlapMissing, 0)
  assert.equal(calls[0].params[0], token)
  assert.equal(calls[0].params[1].transactionDetails, 'full')
  assert.equal(calls[0].params[1].paginationToken, undefined)
  assert.equal((await archive.next())?.state, 'complete')
  assert.equal(calls[1].params[1].paginationToken, '454424229:1')
  assert.equal(archive.get(token)?.estimatedCredits, 200)
  assert.equal(archive.get(token)?.records, 1)
  assert.equal(archive.get(token)?.eligibleSwaps, 1)
  assert.equal(emitted[0].finalized, true)
  assert.equal(archive.totals().complete, 1)
  assert.equal(await archive.next(), null)
})

test('a live swap missing from the mint archive blocks a completeness claim', async () => {
  const { db, archive } = setup([{ result: { data: [], paginationToken: null } }])
  db.prepare('INSERT INTO research_swaps VALUES(?,?,?,?,?,?)')
    .run(`solana:${signature}`, 'solana', token, 1, row.blockTime * 1000, row.slot)
  archive.enqueue(token, start, end, row.slot)
  const status = await archive.next()
  assert.equal(status?.state, 'blocked')
  assert.equal(status?.overlapMissing, 1)
  assert.match(status?.reason ?? '', /absent from the mint archive/)
})

test('malformed transaction stops before the page cursor advances', async () => {
  const { archive, emitted } = setup([{ result: { data: [{ ...row, meta: null }], paginationToken: null } }])
  archive.enqueue(token, start, end, row.slot)
  const status = await archive.next()
  assert.equal(status?.state, 'blocked')
  assert.equal(status?.pages, 0)
  assert.equal(emitted.length, 0)
})
