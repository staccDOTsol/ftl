import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ftl-rh-young-'))
const { db } = await import('../src/db.ts')
const { StrictRhRpc, TRANSFER_TOPIC, ZERO } = await import('../src/robinhood/research-source.ts')
const { startRobinhoodHolders, robinhoodHolderStatus, advanceRobinhoodHolderBootstrap,
  advanceRobinhoodHolderLive } = await import('../src/robinhood/holders.ts')

const token = `0x${'a'.repeat(40)}`
const alice = `0x${'1'.repeat(40)}`
const bob = `0x${'2'.repeat(40)}`
let head = 151_000
const base = Math.floor(Date.now() / 1000) - head * 4 - 1_800
const ts = (n: number) => base + 4 * n
const hex = (n: number) => `0x${n.toString(16)}`
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
const word = (n: bigint) => n.toString(16).padStart(64, '0')
const topic = (address: string) => `0x${address.slice(2).padStart(64, '0')}`
const transfer = (block: number, index: number, from: string, to: string, amount: bigint) => ({
  address: token, topics: [TRANSFER_TOPIC, topic(from), topic(to)], data: `0x${word(amount)}`,
  blockNumber: hex(block), blockHash: hash(block), blockTimestamp: hex(ts(block)),
  transactionHash: hash(1000 + block), logIndex: hex(index),
})

test('young token anchors at first positive supply and rolls into a true seven-day cohort', async () => {
  const events = [transfer(2, 0, ZERO, alice, 100n), transfer(100, 0, alice, bob, 40n)]
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
        result = events.filter(event => from <= Number(BigInt(event.blockNumber)) &&
          Number(BigInt(event.blockNumber)) <= to)
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
  let status = robinhoodHolderStatus(token)
  assert.equal(status?.state, 'live')
  assert.equal(status?.baselineSlot, 2, 'bootstrap must use actual first supply, not the current head')
  assert.ok(status!.observedDays! < 7)
  assert.equal(status?.baselineRetentionPct, 60)
  process.env.RH_RESEARCH_SOURCE = '1'
  const { getResearch } = await import('../src/research.ts')
  assert.equal(getResearch('robinhood', token).holderStrength.score, null)

  head = 151_500
  await advanceRobinhoodHolderLive()
  status = robinhoodHolderStatus(token)
  assert.equal(status?.state, 'live')
  assert.equal(status?.baselineSlot, 300)
  assert.equal(status?.observedDays, 7)
  assert.equal(status?.baselineRetentionPct, 100)
  assert.equal(getResearch('robinhood', token).holderStrength.score, 70)
  assert.equal((db.prepare('SELECT COUNT(*) n FROM research_rh_holder_cohort_deltas WHERE token=?')
    .get(token) as { n: number }).n, 0, 'rolled deltas must be pruned atomically')

  head = 152_000
  await advanceRobinhoodHolderLive()
  status = robinhoodHolderStatus(token)
  assert.equal(status?.baselineSlot, 800, 'the seven-day boundary advances with no new balance snapshot')
  assert.equal(status?.baselineRetentionPct, 100)
  assert.equal((db.prepare('SELECT baseline_block FROM research_rh_holder_state WHERE token=?')
    .get(token) as { baseline_block: number }).baseline_block, 300,
  'inactive cohorts are projected from the global boundary without rewriting the owner ledger')
})
