import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ftl-rh-research-test-'))
process.env.DATA_DIR = directory
const { db } = await import('../src/db.ts')
const { StrictRhRpc, POOL_MANAGER, SWAP_TOPIC, TRANSFER_TOPIC, ZERO, decodeSwap, decodeTransfer } =
  await import('../src/robinhood/research-source.ts')
const { startRobinhoodHolders, robinhoodHolderStatus, advanceRobinhoodHolderBootstrap,
  advanceRobinhoodHolderLive } = await import('../src/robinhood/holders.ts')

const token = `0x${'a'.repeat(40)}`
const a = `0x${'1'.repeat(40)}`
const b = `0x${'2'.repeat(40)}`
const pool = `0x${'f'.repeat(64)}`
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}`
const word = (n: bigint) => (n < 0n ? (1n << 256n) + n : n).toString(16).padStart(64, '0')
const topic = (address: string) => `0x${address.slice(2).padStart(64, '0')}`
const log = (block: number, index: number, from: string, to: string, amount: bigint) => ({
  address: token, topics: [TRANSFER_TOPIC, topic(from), topic(to)], data: `0x${word(amount)}`,
  blockNumber: hex(block), blockHash: hash(block), transactionHash: hash(100 + block), logIndex: hex(index),
})

test('v4 swap decoder uses opposite finalized pool deltas and exact quote decimals', () => {
  const event = {
    address: POOL_MANAGER, topics: [SWAP_TOPIC, pool, topic(a)],
    data: `0x${word(-1_000_000_000_000_000_000n)}${word(2_000_000n)}${word(1n)}${word(1n)}`,
    blockNumber: hex(5), blockHash: hash(5), transactionHash: hash(105), logIndex: hex(2),
  }
  const result = decodeSwap(event, { currency0: ZERO, currency1: token }, 6, 1_000_000)
  assert.equal(result?.token, token)
  assert.equal(result?.quoteSymbol, 'ETH')
  assert.equal(result?.tokenUi, 2)
  assert.equal(result?.quoteUi, 1)
  assert.equal(result?.priceQuote, 0.5)
  assert.equal(result?.id, `${hash(105)}:2`)
  assert.equal(decodeSwap({ ...event, data: `0x${word(1n)}${word(2n)}${word(1n)}` },
    { currency0: ZERO, currency1: token }, 6, 1_000_000), null)
  assert.throws(() => decodeTransfer({ ...log(2, 0, ZERO, a, 100n), topics: [TRANSFER_TOPIC, topic(a)] }),
    /Malformed finalized/)
})

test('strict RPC never treats provider errors or truncated log ranges as empty coverage', async () => {
  const failed = new StrictRhRpc('https://example.test', async () =>
    new Response(JSON.stringify([{ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'range too large' } }]), { status: 200 }))
  await assert.rejects(failed.completeLogs({ address: token, topics: [TRANSFER_TOPIC] }, 3, 3), /Incomplete Robinhood logs/)

  let requests = 0
  const quota = new StrictRhRpc('https://example.test', async (_url, init) => {
    requests++
    const [{ id }] = JSON.parse(String(init?.body))
    return new Response(JSON.stringify([{ jsonrpc: '2.0', id,
      error: { code: -32005, message: 'rate limit exceeded' } }]), { status: 200 })
  })
  await assert.rejects(quota.completeLogs({ topics: [TRANSFER_TOPIC] }, 1, 10_000), /rate limit exceeded/)
  assert.equal(requests, 1, 'a quota error must not recursively fan out into thousands of requests')

  let splits = 0
  const ranged = new StrictRhRpc('https://example.test', async (_url, init) => {
    splits++
    const [{ id, params }] = JSON.parse(String(init?.body))
    const filter = params[0]
    const length = Number(BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n)
    return new Response(JSON.stringify([{ jsonrpc: '2.0', id,
      ...(length > 4 ? { error: { code: -32000, message: 'block range too large' } } : { result: [] }) }]),
    { status: 200 })
  })
  assert.deepEqual(await ranged.completeLogs({ topics: [TRANSFER_TOPIC] }, 1, 8), [])
  assert.equal(splits, 3)

  let paidCalls = 0
  const paid = new StrictRhRpc('https://example.test', async (_url, init) => {
    paidCalls++
    const [{ id }] = JSON.parse(String(init?.body))
    return new Response(JSON.stringify([{ jsonrpc: '2.0', id, result: Array.from({ length: 1001 }, () => ({})) }]),
      { status: 200 })
  })
  assert.equal((await paid.completeLogs({ topics: [TRANSFER_TOPIC] }, 1, 1)).length, 1001)
  assert.equal(paidCalls, 1, 'a paid endpoint may return more than 1,000 complete logs in one response')
})

test('provider-stamped finalized log times use exact timestamps with canonical range anchors', async () => {
  let headerReads = 0
  const rpc = new StrictRhRpc('https://example.test', async (_url, init) => {
    const calls = JSON.parse(String(init?.body)) as { id: number; method: string; params: string[] }[]
    return new Response(JSON.stringify(calls.map(call => {
      assert.equal(call.method, 'eth_getBlockByNumber')
      headerReads++
      const n = Number(BigInt(call.params[0]))
      return { jsonrpc: '2.0', id: call.id,
        result: { number: hex(n), hash: hash(n), timestamp: hex(1_000_000_000 + n) } }
    })), { status: 200 })
  })
  const stamped = { ...log(2, 0, ZERO, a, 100n), blockTimestamp: hex(1_000_000_002) }
  const times = await rpc.finalizedStampedTimes([stamped], 1, 3, 3)
  assert.equal(times.get(2), 1_000_000_002_000)
  assert.equal(headerReads, 2, 'stamped logs need range anchors, not one header per log block')
  await assert.rejects(rpc.finalizedStampedTimes([{ ...stamped, blockTimestamp: hex(1_000_000_010) }], 1, 3, 3),
    /outside canonical range/)
  headerReads = 0
  const fallback = await rpc.finalizedStampedTimes([{ ...stamped, blockTimestamp: undefined }], 1, 3, 3)
  assert.equal(fallback.get(2), 1_000_000_002_000)
  assert.equal(headerReads, 1, 'standard RPC logs without timestamps retain per-block verification')
})

test('holder ledger proves first-supply baseline, replays a gap, and preserves the verified cohort', async () => {
  let head = 3
  let badHash = false
  const transfers = [log(2, 0, ZERO, a, 100n), log(3, 0, a, b, 30n), log(4, 0, a, b, 10n)]
  const request: typeof fetch = async (_url, init) => {
    const calls = JSON.parse(String(init?.body)) as { id: number; method: string; params: any[] }[]
    const replies = calls.map(call => {
      let result: any
      if (call.method === 'eth_getBlockByNumber') {
        const n = call.params[0] === 'finalized' ? head : Number(BigInt(call.params[0]))
        result = { number: hex(n), hash: badHash && n === 4 ? hash(999) : hash(n), timestamp: hex(1_000_000_000 + n) }
      } else if (call.method === 'eth_getCode') {
        result = Number(BigInt(call.params[1])) >= 2 ? '0x6000' : '0x'
      } else if (call.method === 'eth_getLogs') {
        const filter = call.params[0]
        const start = Number(BigInt(filter.fromBlock)), end = Number(BigInt(filter.toBlock))
        result = transfers.filter(t => Number(BigInt(t.blockNumber)) >= start && Number(BigInt(t.blockNumber)) <= end)
      } else if (call.method === 'eth_call') {
        const selector = call.params[0].data.slice(0, 10)
        const at = Number(BigInt(call.params[1]))
        if (selector === '0x18160ddd') result = `0x${word(100n)}`
        else if (selector === '0x70a08231') {
          const owner = `0x${call.params[0].data.slice(-40)}`
          const amount = owner === a ? at >= 4 ? 60n : 70n : owner === b ? at >= 4 ? 40n : 30n : 0n
          result = `0x${word(amount)}`
        }
      }
      if (result === undefined) throw new Error(`Unexpected mock method: ${call.method}`)
      return { jsonrpc: '2.0', id: call.id, result }
    })
    return new Response(JSON.stringify(replies), { status: 200 })
  }
  db.prepare("INSERT INTO research_tokens(chain,address,first_seen_ts) VALUES('robinhood',?,1)").run(token)
  startRobinhoodHolders(new StrictRhRpc('https://example.test', request))
  for (let i = 0; i < 20 && robinhoodHolderStatus(token)?.state !== 'live'; i++) {
    await advanceRobinhoodHolderBootstrap()
    await advanceRobinhoodHolderLive()
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  let status = robinhoodHolderStatus(token)
  assert.equal(status?.state, 'live')
  assert.equal(status?.baselineSlot, 2)
  assert.equal(status?.ownerCount, 2)
  assert.equal(status?.baselineRetentionPct, 70)
  head = 4
  badHash = true
  await advanceRobinhoodHolderLive()
  assert.equal(robinhoodHolderStatus(token)?.state, 'stale')
  assert.equal(robinhoodHolderStatus(token)?.coveredThroughSlot, 3)
  badHash = false
  await advanceRobinhoodHolderLive()
  status = robinhoodHolderStatus(token)
  assert.equal(status?.state, 'live')
  assert.equal(status?.coveredThroughSlot, 4)
  assert.equal(status?.baselineSlot, 2)
  assert.equal(status?.baselineRetentionPct, 60)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM research_rh_holder_balances WHERE token=?').get(token) as any).n, 2)
})
