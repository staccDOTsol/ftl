import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ftl-rh-cohort-'))
const { db } = await import('../src/db.ts')
const { StrictRhRpc, TRANSFER_TOPIC, ZERO } = await import('../src/robinhood/research-source.ts')
const { startRobinhoodHolders, robinhoodHolderStatus, advanceRobinhoodHolderBootstrap, advanceRobinhoodHolderLive } =
  await import('../src/robinhood/holders.ts')

const token = `0x${'a'.repeat(40)}`
const alice = `0x${'1'.repeat(40)}`
const bob = `0x${'2'.repeat(40)}`
const head = 200_002
const base = Math.floor(Date.now() / 1000) - head * 4 - 1_800
const ts = (n: number) => base + 4 * n
const hex = (n: number) => `0x${n.toString(16)}`
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
const word = (n: bigint) => n.toString(16).padStart(64, '0')
const topic = (address: string) => `0x${address.slice(2).padStart(64, '0')}`
const transfer = (block: number, index: number, from: string, to: string, amount: bigint) => ({
  address: token, topics: [TRANSFER_TOPIC, topic(from), topic(to)], data: `0x${word(amount)}`,
  blockNumber: hex(block), blockHash: hash(block), blockTimestamp: hex(ts(block)),
  transactionHash: hash(100 + block), logIndex: hex(index),
})

test('old RH token gets an event-derived seven-day top-owner cohort after full replay and anchor validation', async () => {
  const events = [transfer(2, 0, ZERO, alice, 100n), transfer(60_000, 0, alice, bob, 40n)]
  const request: typeof fetch = async (_url, init) => {
    const calls = JSON.parse(String(init?.body)) as { id: number; method: string; params: any[] }[]
    const replies = calls.map(call => {
      let result: any
      if (call.method === 'eth_getBlockByNumber') {
        const n = call.params[0] === 'finalized' ? head : Number(BigInt(call.params[0]))
        result = { number: hex(n), hash: hash(n), timestamp: hex(ts(n)) }
      } else if (call.method === 'eth_getCode') {
        result = Number(BigInt(call.params[1])) >= 2 ? '0x6000' : '0x'
      } else if (call.method === 'eth_getLogs') {
        const filter = call.params[0]
        const from = Number(BigInt(filter.fromBlock)), to = Number(BigInt(filter.toBlock))
        result = events.filter(event => Number(BigInt(event.blockNumber)) >= from && Number(BigInt(event.blockNumber)) <= to)
      } else if (call.method === 'eth_call') {
        const selector = call.params[0].data.slice(0, 10)
        const owner = `0x${call.params[0].data.slice(-40)}`
        result = `0x${word(selector === '0x18160ddd' ? 100n : owner === alice ? 60n : owner === bob ? 40n : 0n)}`
      }
      if (result === undefined) throw new Error(`Unexpected mock method: ${call.method}`)
      return { jsonrpc: '2.0', id: call.id, result }
    })
    return new Response(JSON.stringify(replies), { status: 200 })
  }
  db.prepare("INSERT INTO research_tokens(chain,address,first_seen_ts) VALUES('robinhood',?,1)").run(token)
  startRobinhoodHolders(new StrictRhRpc('https://example.test', request))
  for (let i = 0; i < 35 && robinhoodHolderStatus(token)?.state !== 'live'; i++) {
    await advanceRobinhoodHolderBootstrap()
    await advanceRobinhoodHolderLive()
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  const status = robinhoodHolderStatus(token)
  assert.equal(status?.state, 'live')
  assert.equal(status?.baselineSlot, 48_802)
  assert.equal(status?.baselineTs, ts(48_802) * 1000)
  assert.equal(status?.coveredThroughSlot, head)
  assert.equal(status?.observedDays, 7)
  assert.equal(status?.baselineRetentionPct, 60)
  assert.equal(status?.top20SharePct, 100)
  const cohort = db.prepare('SELECT owner,amount FROM research_rh_holder_baseline_top WHERE token=?').all(token) as any[]
  assert.deepEqual(cohort.map(row => ({ owner: row.owner, amount: row.amount })),
    [{ owner: alice, amount: '100' }])
  process.env.RH_RESEARCH_SOURCE = '1'
  const { getResearch } = await import('../src/research.ts')
  const report = getResearch('robinhood', token)
  assert.equal(report.holderStrength.score, 42, JSON.stringify({ holder: report.holderStrength, coverage: report.coverage }))
  assert.equal(report.bottoming.signs, null, 'holder proof must not invent a full-market price score')
})
