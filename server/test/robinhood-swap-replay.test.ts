import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ftl-rh-swap-replay-'))
const { db, getCursor, setCursor } = await import('../src/db.ts')
const { StrictRhRpc, POOL_MANAGER, INIT_TOPIC, SWAP_TOPIC, ZERO } =
  await import('../src/robinhood/research-source.ts')
const { startRobinhoodSwaps, advanceRobinhoodSwaps } = await import('../src/robinhood/swaps.ts')

const token = `0x${'a'.repeat(40)}`
const pool = `0x${'f'.repeat(64)}`
const DAY = 86_400_000
const today = Math.floor(Date.now() / DAY) * DAY
const base = Math.floor((today - 31 * DAY) / 1000) - 1_000
const ts = (n: number) => base + 100 * n
const hex = (n: number) => `0x${n.toString(16)}`
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
const word = (n: bigint) => (n < 0n ? (1n << 256n) + n : n).toString(16).padStart(64, '0')
const topic = (address: string) => `0x${address.slice(2).padStart(64, '0')}`
const logBase = (block: number, index: number) => ({
  address: POOL_MANAGER, blockNumber: hex(block), blockHash: hash(block),
  blockTimestamp: hex(ts(block)), transactionHash: hash(100 + block), logIndex: hex(index),
})

test('finalized v4 replay ingests one exact-time swap, advances coverage, and is idempotent', async () => {
  const logs = [
    { ...logBase(20, 0), topics: [INIT_TOPIC, pool, topic(ZERO), topic(token)], data: '0x' },
    { ...logBase(21, 1), topics: [SWAP_TOPIC, pool],
      data: `0x${word(-1_000_000_000_000_000_000n)}${word(2_000_000n)}${word(1n)}${word(1n)}` },
  ]
  const request: typeof fetch = async (_url, init) => {
    const calls = JSON.parse(String(init?.body)) as { id: number; method: string; params: any[] }[]
    return new Response(JSON.stringify(calls.map(call => {
      let result: any
      if (call.method === 'eth_getBlockByNumber') {
        const n = call.params[0] === 'finalized' ? 100 : Number(BigInt(call.params[0]))
        result = { number: hex(n), hash: hash(n), timestamp: hex(ts(n)) }
      } else if (call.method === 'eth_getLogs') {
        const filter = call.params[0]
        const from = Number(BigInt(filter.fromBlock)), to = Number(BigInt(filter.toBlock))
        result = logs.filter(log => from <= Number(BigInt(log.blockNumber)) && Number(BigInt(log.blockNumber)) <= to)
      } else if (call.method === 'eth_call') {
        assert.equal(call.params[0].to, token)
        result = `0x${word(6n)}`
      }
      if (result === undefined) throw new Error(`Unexpected mock method: ${call.method}`)
      return { jsonrpc: '2.0', id: call.id, result }
    })), { status: 200 })
  }
  db.prepare("INSERT INTO research_tokens(chain,address,first_seen_ts) VALUES('robinhood',?,1)").run(token)
  startRobinhoodSwaps(new StrictRhRpc('https://example.test', request))
  for (let i = 0; i < 10 && getCursor('rh:research-swap:block') !== '100'; i++) {
    await advanceRobinhoodSwaps()
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.equal(getCursor('rh:research-swap:block'), '100')
  const swaps = db.prepare("SELECT COUNT(*) n FROM research_swaps WHERE chain='robinhood' AND token=?")
    .get(token) as { n: number }
  assert.equal(swaps.n, 1)
  const candle = db.prepare("SELECT close,volume_quote,trades FROM research_trade_candles WHERE chain='robinhood' AND token=?")
    .get(token) as { close: number; volume_quote: number; trades: number }
  assert.equal(candle.close, 0.5)
  assert.equal(candle.volume_quote, 1)
  assert.equal(candle.trades, 1)
  assert.equal((db.prepare("SELECT COUNT(*) n FROM research_stream_sessions WHERE lane='robinhood-swaps' AND ended_ts IS NULL")
    .get() as { n: number }).n, 1)

  setCursor('rh:research-swap:block', '9')
  await advanceRobinhoodSwaps()
  assert.equal(getCursor('rh:research-swap:block'), '100')
  assert.equal((db.prepare("SELECT trades FROM research_trade_candles WHERE chain='robinhood' AND token=?")
    .get(token) as { trades: number }).trades, 1, 'replayed swap must not double count')
})
