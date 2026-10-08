import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ftl-rh-group-'))
const { db } = await import('../src/db.ts')
const { StrictRhRpc, TRANSFER_TOPIC, ZERO } = await import('../src/robinhood/research-source.ts')
const { startRobinhoodHolders, robinhoodHolderStatus, advanceRobinhoodHolderBootstrap,
  advanceRobinhoodHolderLive } =
  await import('../src/robinhood/holders.ts')

const tokens = [`0x${'a'.repeat(40)}`, `0x${'b'.repeat(40)}`]
const owners = [`0x${'1'.repeat(40)}`, `0x${'2'.repeat(40)}`]
const hex = (n: number) => `0x${n.toString(16)}`
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
const word = (n: bigint) => n.toString(16).padStart(64, '0')
const topic = (address: string) => `0x${address.slice(2).padStart(64, '0')}`
const logs = tokens.map((token, index) => ({
  address: token, topics: [TRANSFER_TOPIC, topic(ZERO), topic(owners[index])], data: `0x${word(100n)}`,
  blockNumber: hex(2), blockHash: hash(2), transactionHash: hash(100 + index), logIndex: hex(index),
}))

test('historical holder replay shares log ranges across enrolled tokens and validates each anchor', async () => {
  let head = 20_002
  let groupedCalls = 0
  let globalCalls = 0
  let firstTokenCodeReads = 0
  const request: typeof fetch = async (_url, init) => {
    const calls = JSON.parse(String(init?.body)) as { id: number; method: string; params: any[] }[]
    const replies = calls.map(call => {
      let result: any
      if (call.method === 'eth_getBlockByNumber') {
        const n = call.params[0] === 'finalized' ? head : Number(BigInt(call.params[0]))
        result = { number: hex(n), hash: hash(n), timestamp: hex(1_000_000_000 + n) }
      } else if (call.method === 'eth_getCode') {
        if (call.params[0] === tokens[0]) firstTokenCodeReads++
        result = Number(BigInt(call.params[1])) >= 2 ? '0x6000' : '0x'
      } else if (call.method === 'eth_getTransactionReceipt') {
        result = { blockNumber: hex(2) }
      } else if (call.method === 'eth_getLogs') {
        const filter = call.params[0]
        if (!filter.address) globalCalls++
        const addresses = Array.isArray(filter.address) ? filter.address : [filter.address]
        if (addresses.length === 2) groupedCalls++
        const from = Number(BigInt(filter.fromBlock)), to = Number(BigInt(filter.toBlock))
        result = logs.filter(log => addresses.includes(log.address) && from <= 2 && to >= 2)
      } else if (call.method === 'eth_call') {
        const selector = call.params[0].data.slice(0, 10)
        const index = tokens.indexOf(call.params[0].to)
        result = selector === '0x18160ddd' ? `0x${word(100n)}` :
          selector === '0x70a08231' && call.params[0].data.endsWith(owners[index].slice(2))
            ? `0x${word(100n)}` : `0x${word(0n)}`
      }
      if (result === undefined) throw new Error(`Unexpected mock method: ${call.method}`)
      return { jsonrpc: '2.0', id: call.id, result }
    })
    return new Response(JSON.stringify(replies), { status: 200 })
  }
  for (const token of tokens)
    db.prepare("INSERT INTO research_tokens(chain,address,first_seen_ts) VALUES('robinhood',?,1)").run(token)
  db.prepare("INSERT INTO tokens(chain,address,launch_tx) VALUES('robinhood',?,?)")
    .run(tokens[0], hash(500))
  startRobinhoodHolders(new StrictRhRpc('https://example.test', request))
  for (let i = 0; i < 20 && tokens.some(token => robinhoodHolderStatus(token)?.state !== 'live'); i++) {
    await advanceRobinhoodHolderBootstrap()
    await advanceRobinhoodHolderLive()
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.ok(groupedCalls > 0, 'both tokens should share at least one historical log-range read')
  assert.equal(firstTokenCodeReads, 3, 'verified launch receipt should avoid a full-height code search')
  for (const token of tokens) {
    const status = robinhoodHolderStatus(token)
    assert.equal(status?.state, 'live')
    assert.equal(status?.coveredThroughSlot, 20_002)
    assert.equal(status?.ownerCount, 1)
  }
  head = 20_005
  await advanceRobinhoodHolderLive()
  assert.equal(globalCalls, 1, 'steady-state holder coverage reads one global Transfer range')
  for (const token of tokens)
    assert.equal(robinhoodHolderStatus(token)?.coveredThroughSlot, head)
})
