// Finalized Uniswap v4 swaps for every FTL-seen Robinhood token. The stream
// advances a durable block cursor only after every log in a range is decoded
// against a canonical block and ingested. A reconnect replays from that cursor.
import { config, redact } from '../config.ts'
import { db, getCursor, setCursor } from '../db.ts'
import { lookupPool } from '../hub.ts'
import { ingestRobinhoodSwap, onResearchSwapStream } from '../research.ts'
import { INIT_TOPIC, POOL_MANAGER, SWAP_TOPIC, StrictRhRpc, blockNumber,
  decodePoolInit, decodeSwap, hexBlock, type ChainLog, type PoolPair } from './research-source.ts'

const LANE = 'robinhood-swaps'
const DAY = 86_400_000
const CURSOR = 'rh:research-swap:block'
const START_TS = 'rh:research-swap:start-ts'
const seenToken = db.prepare("SELECT 1 FROM research_tokens WHERE chain='robinhood' AND address=?")
const decimalsCache = new Map<string, number>()
const pairCache = new Map<string, PoolPair>()
let source: StrictRhRpc | null = null
let started = false
let scanning = false
let continuous = false
let lastPulseTs: number | null = null

async function blockAt(n: number): Promise<{ n: number; ts: number }> {
  if (!source) throw new Error('Robinhood RPC unavailable')
  const block = await source.call('eth_getBlockByNumber', [hexBlock(n), false]) as any
  const observed = blockNumber(block.number)
  if (observed !== n || !/^0x[a-f\d]{64}$/i.test(block.hash)) throw new Error('Invalid historical Robinhood block')
  return { n, ts: blockNumber(block.timestamp) * 1000 }
}
async function firstBlockAt(ts: number, head: number): Promise<number> {
  let lo = 0, hi = head
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const block = await blockAt(mid)
    if (block.ts < ts) lo = mid + 1
    else hi = mid
  }
  return lo
}
async function ensureStart(head: number): Promise<number> {
  const existing = getCursor(CURSOR)
  if (existing !== null) {
    const n = Number(existing)
    if (!Number.isSafeInteger(n) || n < -1) throw new Error('Invalid persisted Robinhood swap cursor')
    return n
  }
  // Bottoming's requested window is 30 completed UTC days. Replay one extra
  // UTC day so the first candle is complete even when starting mid-day.
  const today = Math.floor(Date.now() / DAY) * DAY
  const start = await firstBlockAt(today - 31 * DAY, head)
  const actual = await blockAt(start)
  setCursor(START_TS, String(actual.ts))
  setCursor(CURSOR, String(start - 1))
  return start - 1
}
function pairFor(id: string): PoolPair | null {
  const prior = pairCache.get(id)
  if (prior) return prior
  const pool = lookupPool('robinhood', id)
  if (!pool || pool.mints.length !== 2) return null
  const pair = { currency0: pool.mints[0], currency1: pool.mints[1] }
  pairCache.set(id, pair)
  return pair
}
async function decimalsFor(token: string, block: number): Promise<number> {
  const cached = decimalsCache.get(token)
  if (cached !== undefined) return cached
  if (!source) throw new Error('Robinhood RPC unavailable')
  const value = await source.call('eth_call', [{ to: token, data: '0x313ce567' }, hexBlock(block)]) as string
  if (!/^0x[a-f\d]{64}$/i.test(value)) throw new Error('Token decimals() is unavailable at finalized swap block')
  const decimals = Number(BigInt(value))
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('Invalid ERC-20 decimals')
  decimalsCache.set(token, decimals)
  return decimals
}
async function applyLogs(logs: ChainLog[], from: number, to: number, finalizedHead: number): Promise<void> {
  if (!source) throw new Error('Robinhood RPC unavailable')
  const times = await source.finalizedStampedTimes(logs, from, to, finalizedHead)
  logs.sort((a, b) => blockNumber(a.blockNumber) - blockNumber(b.blockNumber) || blockNumber(a.logIndex) - blockNumber(b.logIndex))
  for (const log of logs) {
    if (log.address.toLowerCase() !== POOL_MANAGER) throw new Error('Unexpected address in PoolManager range')
    const topic = log.topics[0]?.toLowerCase()
    if (topic === INIT_TOPIC) {
      const init = decodePoolInit(log)
      if (init) pairCache.set(init.id, init.pair)
      continue
    }
    if (topic !== SWAP_TOPIC) throw new Error('Unexpected PoolManager log topic')
    const id = log.topics[1]?.toLowerCase()
    if (!/^0x[a-f\d]{64}$/.test(id ?? '')) throw new Error('Malformed v4 pool id')
    const pair = pairFor(id)
    if (!pair) continue // A pool FTL never indexed is outside the Research universe.
    const q0 = pair.currency0.toLowerCase(), q1 = pair.currency1.toLowerCase()
    const quoted = ['0x0000000000000000000000000000000000000000',
      '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
      '0x5fc5360d0400a0fd4f2af552add042d716f1d168']
    const token = quoted.includes(q0) ? q1 : quoted.includes(q1) ? q0 : null
    if (!token || !seenToken.get(token)) continue
    const block = blockNumber(log.blockNumber)
    const observation = decodeSwap(log, pair, await decimalsFor(token, block), times.get(block)!)
    if (observation) ingestRobinhoodSwap(observation)
  }
}

async function scanOnce(): Promise<boolean> {
  if (!source) return false
  const head = await source.finalizedHead()
  const cursor = await ensureStart(head.number)
  if (cursor >= head.number) {
    if (!continuous) {
      const prior = db.prepare("SELECT 1 FROM research_stream_sessions WHERE lane=? ORDER BY id DESC LIMIT 1").get(LANE)
      onResearchSwapStream({ t: prior ? 'resume' : 'open', lane: LANE,
        ts: prior ? Date.now() : Number(getCursor(START_TS) ?? head.ts) })
      continuous = true
    }
    lastPulseTs = Date.now()
    onResearchSwapStream({ t: 'pulse', lane: LANE, ts: lastPulseTs })
    return false
  }
  const from = cursor + 1, to = Math.min(head.number, from + 9_999)
  const logs = await source.completeLogs({ address: POOL_MANAGER, topics: [[INIT_TOPIC, SWAP_TOPIC]] }, from, to)
  await applyLogs(logs, from, to, head.number)
  setCursor(CURSOR, String(to))
  if (to >= head.number) {
    if (!continuous) {
      const prior = db.prepare("SELECT 1 FROM research_stream_sessions WHERE lane=? ORDER BY id DESC LIMIT 1").get(LANE)
      onResearchSwapStream({ t: prior ? 'resume' : 'open', lane: LANE,
        ts: prior ? Date.now() : Number(getCursor(START_TS) ?? head.ts) })
      continuous = true
    }
    lastPulseTs = Date.now()
    onResearchSwapStream({ t: 'pulse', lane: LANE, ts: lastPulseTs })
  }
  return to < head.number
}

async function run(): Promise<void> {
  if (!source || scanning) return
  scanning = true
  try {
    let more = true
    while (more) {
      more = await scanOnce()
      if (more) await new Promise<void>(resolve => setImmediate(resolve))
    }
  } catch (error) {
    if (continuous) onResearchSwapStream({ t: 'close', lane: LANE, ts: lastPulseTs ?? Date.now() })
    continuous = false
    console.error('[rh:swaps] finalized replay pending:', redact(String(error)).slice(0, 260))
  } finally { scanning = false }
}

export function startRobinhoodSwaps(rpc?: StrictRhRpc): void {
  if (started) return
  started = true
  source = rpc ?? (config.rhHttp ? new StrictRhRpc(config.rhHttp) : null)
  if (!source) return
  setInterval(() => void run(), 3_000).unref()
  void run()
}

// Explicit advancement supports a deterministic finalized replay fixture.
export async function advanceRobinhoodSwaps(): Promise<void> { await run() }
