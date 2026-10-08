import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ftl-rh-provisional-'))
const { RobinhoodProvisionalSource } = await import('../src/robinhood/provisional.ts')
const { POOL_MANAGER, SWAP_TOPIC, TRANSFER_TOPIC, ZERO } = await import('../src/robinhood/research-source.ts')

const token = `0x${'a'.repeat(40)}`
const alice = `0x${'1'.repeat(40)}`
const bob = `0x${'2'.repeat(40)}`
const pool = `0x${'f'.repeat(64)}`
const hex = (n: number) => `0x${n.toString(16)}`
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`
const topic = (address: string) => `0x${address.slice(2).padStart(64, '0')}`
const word = (n: bigint) => (n < 0n ? (1n << 256n) + n : n).toString(16).padStart(64, '0')
const transfer = (block: number, index: number, from: string, to: string) => ({
  address: token, topics: [TRANSFER_TOPIC, topic(from), topic(to)], data: `0x${word(1n)}`,
  blockNumber: hex(block), blockHash: hash(block), transactionHash: hash(1000 + block), logIndex: hex(index),
})
const swap = (block: number) => ({
  address: POOL_MANAGER, topics: [SWAP_TOPIC, pool, topic(alice)],
  data: `0x${word(-1n)}${word(2n)}`,
  blockNumber: hex(block), blockHash: hash(block), transactionHash: hash(2000 + block), logIndex: hex(4),
})

test('latest overlay rolls back reorged Transfer and Swap logs without touching finalized scores', async () => {
  let finalized = 10
  let latest = 12
  let reorg = false
  let failed = false
  const nft = { ...transfer(11, 3, alice, bob), address: `0x${'e'.repeat(40)}`,
    topics: [TRANSFER_TOPIC, topic(alice), topic(bob), hash(1)], data: '0x' }
  const events = [transfer(11, 0, ZERO, alice), nft, transfer(12, 1, alice, bob), swap(12)]
  const rpc = {
    finalizedHead: async () => ({ number: finalized, hash: hash(finalized), ts: finalized * 1000 }),
    latestHead: async () => ({ number: latest, hash: reorg ? hash(1200) : hash(latest), ts: latest * 1000 }),
    call: async (_method: string, [at]: unknown[]) => {
      const n = Number(BigInt(String(at)))
      return { number: hex(n), hash: reorg && n === 12 ? hash(1200) : hash(n), timestamp: hex(n) }
    },
    completeLogs: async (filter: any, from: number, to: number) => {
      if (failed) throw new Error('provider error')
      return events.filter(event => Number(BigInt(event.blockNumber)) >= from &&
        Number(BigInt(event.blockNumber)) <= to &&
        (filter.address ? event.address === filter.address : event.topics[0] === TRANSFER_TOPIC))
    },
  }
  const source = new RobinhoodProvisionalSource(rpc as any, id => id === pool ? token : null)
  await source.tick()
  let status = source.status(token)
  assert.equal(status.state, 'live')
  assert.equal(status.finality, 'provisional')
  assert.equal(status.observedFromBlock, 11)
  assert.equal(status.observedThroughBlock, 12)
  assert.equal(status.holderTransferEvents, 2)
  assert.equal(status.touchedWallets, 2)
  assert.equal(status.knownV4SwapEvents, 1)

  // The same block height now has a different canonical hash. The stale
  // events disappear, and the replacement branch is replayed from finalized.
  reorg = true
  events.splice(2, 2)
  await source.tick()
  status = source.status(token)
  assert.equal(status.rollbackCount, 1)
  assert.equal(status.holderTransferEvents, 1)
  assert.equal(status.touchedWallets, 1)
  assert.equal(status.knownV4SwapEvents, 0)

  // A provider error leaves the overlay visibly stale, not zero or complete.
  latest = 13
  failed = true
  await assert.rejects(source.tick(), /provider error/)
  status = source.status(token)
  assert.equal(status.state, 'stale')
  assert.equal(status.holderTransferEvents, null)
  failed = false
  await source.tick()
  assert.equal(source.status(token).state, 'live')

  // Finalization removes the provisional contribution from the rolling view.
  finalized = 11
  await source.tick()
  assert.equal(source.status(token).holderTransferEvents, 0)
})
