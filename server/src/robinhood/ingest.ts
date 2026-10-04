// Robinhood Chain (4663) over dRPC: one websocket log subscription for the v4
// PoolManager plus chain-wide launchpad topics, grouped per transaction so a
// pool birth knows whether its own tx funded it. A boot backfill replays the
// last BACKFILL_HOURS of births and launches so young-pool state survives restarts.

import { config, redact } from '../config.ts'
import { ingest, lane, lookupPool, type RawEvent } from '../hub.ts'
import { getCursor, setCursor } from '../db.ts'
import type { Amount } from '../../../shared/types.ts'
import { WebSocket } from 'ws'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

const keccak = (hex: string) => bytesToHex(keccak_256(hexToBytes(hex)))

const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const T = {
  Initialize: '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438',
  ModifyLiquidity: '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec',
  Swap: '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
  TokenLaunched: '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607',
  PoolGraduated: '0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259',
  PoolRegistered: '0x01bf263a1db1652580721573296e1a1fa70b3d4c87f61d02a69c4e1109d2d573',
}
// launchpad graduation hooks: Pons V2 Meme Hook, Square pad v1, Square pad v4
const LAUNCH_HOOKS = new Set([
  '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044',
  '0x946dd8ccd353a4e08dcf6ad1862df0a695b1a044',
  '0x57387b5b814e4083aaaa58578c2b4d2c2138a044',
])
const ZERO = '0x0000000000000000000000000000000000000000'

interface Log { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string; removed?: boolean }

const addr = (topic: string) => '0x' + topic.slice(26).toLowerCase()
const word = (data: string, i: number) => BigInt('0x' + data.slice(2 + i * 64, 2 + (i + 1) * 64))
const sword = (data: string, i: number, bits: number) => { const v = word(data, i); const m = 1n << 255n; return v & m ? v - (1n << 256n) : v } // int256 two's complement
const int24 = (v: bigint) => { const x = Number(v & 0xffffffn); return x >= 0x800000 ? x - 0x1000000 : x }

// ---- JSON-RPC over HTTP (batches) -------------------------------------------

let rpcId = 0
async function rpc(calls: { method: string; params: unknown[] }[]): Promise<any[]> {
  if (!calls.length) return []
  const body = calls.map(c => ({ jsonrpc: '2.0', id: ++rpcId, method: c.method, params: c.params }))
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(config.rhHttp!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) })
      const j = await r.json() as any
      const arr = Array.isArray(j) ? j : [j]
      const byId = new Map(arr.map((x: any) => [x.id, x]))
      return body.map(b => (byId.get(b.id) as any)?.result ?? null)
    } catch (e) {
      if (attempt >= 3) throw e
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)))
    }
  }
}

// ---- token decimals / pool prices -------------------------------------------

const decimals = new Map<string, number>([[ZERO, 18], ['0x5fc5360d0400a0fd4f2af552add042d716f1d168', 6], ['0x0bd7d308f8e1639fab988df18a8011f41eacad73', 18]])
const sqrtP = new Map<string, number>()   // poolId -> sqrtPriceX96 / 2^96 (float)
const Q96 = 2 ** 96

async function ensureDecimals(tokens: string[]) {
  const missing = [...new Set(tokens)].filter(t => !decimals.has(t))
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50)
    const res = await rpc(chunk.map(t => ({ method: 'eth_call', params: [{ to: t, data: '0x313ce567' }, 'latest'] })))
    chunk.forEach((t, k) => { const v = res[k]; decimals.set(t, v && v !== '0x' ? Number(BigInt(v)) : 18) })
  }
}

// v4 pool slot0 straight from PoolManager storage: _pools mapping at slot 6
async function ensurePrices(poolIds: string[]) {
  const missing = [...new Set(poolIds)].filter(p => !sqrtP.has(p))
  if (!missing.length) return
  const res = await rpc(missing.map(id => {
    const slot = '0x' + keccak(id.slice(2) + '0'.repeat(63) + '6')
    return { method: 'eth_call', params: [{ to: PM, data: '0x1e2eaeaf' + slot.slice(2) }, 'latest'] }
  }))
  missing.forEach((id, k) => {
    const v = res[k]
    if (v && v.length >= 66) {
      const word0 = BigInt('0x' + v.slice(2, 66))
      const sp = Number(word0 & ((1n << 160n) - 1n))
      if (sp > 0) sqrtP.set(id, sp / Q96)
    }
  })
}

function liquidityAmounts(sp: number, tickLower: number, tickUpper: number, L: number): [number, number] {
  const sa = Math.pow(1.0001, tickLower / 2), sb = Math.pow(1.0001, tickUpper / 2)
  if (sp <= sa) return [L * (sb - sa) / (sa * sb), 0]
  if (sp >= sb) return [0, L * (sb - sa)]
  return [L * (sb - sp) / (sp * sb), L * (sp - sa)]
}

// ---- tx grouping ------------------------------------------------------------

const pendingBlocks = new Map<number, Log[]>()
let flushTimer: NodeJS.Timeout | null = null
let maxSeen = 0
const from = new Map<string, string>()

function onLog(l: Log) {
  if (l.removed) return
  const bn = parseInt(l.blockNumber, 16)
  if (l.topics[0] === T.Swap) {
    // swaps only move our price state; process inline in arrival order unless a block is buffered
    if (!pendingBlocks.size) return applySwap(l)
  }
  let arr = pendingBlocks.get(bn)
  if (!arr) { arr = []; pendingBlocks.set(bn, arr) }
  arr.push(l)
  if (bn > maxSeen) {
    const older = [...pendingBlocks.keys()].filter(b => b < bn)
    maxSeen = bn
    if (older.length) void flush(older)
  }
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => void flush([...pendingBlocks.keys()]), 120)
}

function applySwap(l: Log) {
  const id = l.topics[1].toLowerCase()
  const sp = Number(word(l.data, 2))
  if (sp > 0) sqrtP.set(id, sp / Q96)
}

let flushing: Promise<void> = Promise.resolve()
function flush(blocks: number[]): Promise<void> {
  const logs: Log[] = []
  for (const b of blocks.sort((a, z) => a - z)) { logs.push(...(pendingBlocks.get(b) ?? [])); pendingBlocks.delete(b) }
  if (!logs.length) return flushing
  flushing = flushing.then(() => processLogs(logs, null)).catch(e => console.error('[rh] process', redact(String(e))))
  return flushing
}

// `at` maps a block number to an epoch ms for backfilled logs; live logs use arrival time
async function processLogs(logs: Log[], at: ((bn: number) => number) | null) {
  logs.sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16) || parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16))
  const byTx = new Map<string, Log[]>()
  for (const l of logs) { const g = byTx.get(l.transactionHash); if (g) g.push(l); else byTx.set(l.transactionHash, [l]) }

  // who sent each tx that matters (not swaps)
  const needFrom = [...byTx.entries()].filter(([h, g]) => !from.has(h) && g.some(l => l.topics[0] !== T.Swap)).map(([h]) => h)
  for (let i = 0; i < needFrom.length; i += 100) {
    const chunk = needFrom.slice(i, i + 100)
    const res = await rpc(chunk.map(h => ({ method: 'eth_getTransactionByHash', params: [h] })))
    chunk.forEach((h, k) => { if (res[k]?.from) from.set(h, res[k].from.toLowerCase()) })
  }
  if (from.size > 50_000) for (const k of from.keys()) { from.delete(k); if (from.size < 30_000) break }

  // decimals for every currency we are about to size; prices for pools born before we watched
  const tokensNeeded: string[] = []
  const pricesNeeded: string[] = []
  for (const l of logs) {
    if (l.topics[0] === T.Initialize) tokensNeeded.push(addr(l.topics[2]), addr(l.topics[3]))
    if (l.topics[0] === T.ModifyLiquidity) {
      const p = lookupPool('robinhood', l.topics[1].toLowerCase())
      if (p) tokensNeeded.push(...p.mints)
      if (!at && !sqrtP.has(l.topics[1].toLowerCase()) && !logs.some(x => x.topics[0] === T.Initialize && x.topics[1] === l.topics[1])) pricesNeeded.push(l.topics[1].toLowerCase())
    }
  }
  await ensureDecimals(tokensNeeded)
  if (pricesNeeded.length) await ensurePrices(pricesNeeded).catch(() => {})

  for (const [hash, group] of byTx) {
    const wallet = from.get(hash) ?? ZERO
    const registered = new Set(group.filter(l => l.topics[0] === T.PoolRegistered).map(l => l.topics[1].toLowerCase()))
    for (const l of group) {
      const bn = parseInt(l.blockNumber, 16)
      const n = String(parseInt(l.logIndex, 16))
      const base = { chain: 'robinhood' as const, tx: hash, n, slot: bn, lane: 'logs' as const, stage: 'confirmed' as const, at: at ? at(bn) : undefined }
      const t0 = l.topics[0]
      if (t0 === T.Swap) { applySwap(l); continue }
      if (t0 === T.Initialize) {
        const id = l.topics[1].toLowerCase()
        const c0 = addr(l.topics[2]), c1 = addr(l.topics[3])
        const fee = Number(word(l.data, 0))
        const hooks = '0x' + l.data.slice(2 + 2 * 64 + 24, 2 + 3 * 64).toLowerCase()
        const sp = Number(word(l.data, 3))
        if (sp > 0) sqrtP.set(id, sp / Q96)
        const funded = group.some(x => x.topics[0] === T.ModifyLiquidity && x.topics[1].toLowerCase() === id && sword(x.data, 2, 256) > 0n)
        const gradPool = LAUNCH_HOOKS.has(hooks) || registered.has(id)
        ingest({
          ...base, kind: 'pool_init', venue: gradPool ? 'pons' : hooks === ZERO ? 'uniswap-v4' : 'uniswap-v4-hook', ix: 'Initialize',
          pool: id, mints: [c0, c1], wallet,
          feeBps: fee & 0x800000 ? null : fee / 100,
          noLiquidity: !funded, gradPool,
        } as RawEvent)
      } else if (t0 === T.ModifyLiquidity) {
        const id = l.topics[1].toLowerCase()
        const tl = int24(word(l.data, 0)), tu = int24(word(l.data, 1))
        const dL = sword(l.data, 2, 256)
        if (dL === 0n) continue
        const p = lookupPool('robinhood', id)
        let amounts: Amount[] = []
        const sp = sqrtP.get(id)
        if (p && p.mints.length === 2 && sp && !at) {
          const [a0, a1] = liquidityAmounts(sp, tl, tu, Math.abs(Number(dL)))
          const sign = dL > 0n ? -1 : 1   // from the wallet's side: adding liquidity spends tokens
          const d0 = decimals.get(p.mints[0]) ?? 18, d1 = decimals.get(p.mints[1]) ?? 18
          amounts = [
            { mint: p.mints[0], ui: sign * a0 / 10 ** d0, decimals: d0 },
            { mint: p.mints[1], ui: sign * a1 / 10 ** d1, decimals: d1 },
          ]
        }
        ingest({
          ...base, kind: dL > 0n ? 'liq_add' : 'liq_remove', venue: 'uniswap-v4', ix: 'ModifyLiquidity',
          pool: id, mints: p?.mints ?? [], wallet, amounts,
        } as RawEvent)
      } else if (t0 === T.TokenLaunched && l.topics.length === 4) {
        const token = addr(l.topics[1])
        ingest({ ...base, kind: 'launch', venue: 'pons', ix: 'TokenLaunched', pool: null, mints: [token], wallet: addr(l.topics[3]) || wallet } as RawEvent)
      } else if (t0 === T.PoolGraduated) {
        const token = addr(l.topics[1])
        ingest({ ...base, kind: 'graduate', venue: 'pons', ix: 'PoolGraduated', pool: null, mints: [token], wallet } as RawEvent)
      }
    }
  }
  const last = logs[logs.length - 1]
  if (last && !at) setCursor('rh:block', String(parseInt(last.blockNumber, 16)))
}

// ---- backfill ---------------------------------------------------------------

async function backfill(head: number) {
  const hours = Number(process.env.BACKFILL_HOURS ?? 24)
  const [hb, ob] = await rpc([
    { method: 'eth_getBlockByNumber', params: ['0x' + head.toString(16), false] },
    { method: 'eth_getBlockByNumber', params: ['0x' + Math.max(1, head - 200_000).toString(16), false] },
  ])
  const headTs = parseInt(hb.timestamp, 16) * 1000
  const msPerBlock = (headTs - parseInt(ob.timestamp, 16) * 1000) / 200_000
  const at = (bn: number) => Math.round(headTs - (head - bn) * msPerBlock)
  const cursor = Number(getCursor('rh:block') ?? 0)
  let start = Math.max(cursor + 1, head - Math.floor(hours * 3600_000 / msPerBlock))
  console.log(`[rh] backfill ${head - start} blocks (${(msPerBlock).toFixed(0)} ms/block)`)
  const STEP = 10_000
  const topicsAll = [[T.Initialize, T.ModifyLiquidity, T.PoolRegistered]]
  while (start <= head) {
    const end = Math.min(head, start + STEP - 1)
    const range = { fromBlock: '0x' + start.toString(16), toBlock: '0x' + end.toString(16) }
    const [pm, lp] = await rpc([
      { method: 'eth_getLogs', params: [{ ...range, address: PM, topics: topicsAll }] },
      { method: 'eth_getLogs', params: [{ ...range, topics: [[T.TokenLaunched, T.PoolGraduated, T.PoolRegistered]] }] },
    ])
    // ModifyLiquidity on pools we never saw born is old liquidity: skip before paying for tx lookups
    const born = new Set<string>()
    const logs: Log[] = []
    for (const l of [...(lp ?? []), ...(pm ?? [])] as Log[]) {
      if (l.topics[0] === T.Initialize) born.add(l.topics[1].toLowerCase())
    }
    for (const l of [...(lp ?? []), ...(pm ?? [])] as Log[]) {
      if (l.topics[0] === T.ModifyLiquidity) {
        const id = l.topics[1].toLowerCase()
        if (!born.has(id) && !lookupPool('robinhood', id)?.created) continue
      }
      if (l.topics[0] === T.PoolRegistered && l.address.toLowerCase() === PM) continue
      logs.push(l)
    }
    const seen = new Set<string>()
    const uniq = logs.filter(l => { const k = l.transactionHash + l.logIndex; if (seen.has(k)) return false; seen.add(k); return true })
    await processLogs(uniq, at)
    setCursor('rh:block', String(end))
    start = end + 1
  }
  console.log('[rh] backfill done')
}

// ---- live -------------------------------------------------------------------

export function startRobinhood() {
  const ls = lane('robinhood', 'logs', !!config.rhWss, config.rhWss ? undefined : 'DRPC_KEY not set')
  if (!config.rhWss) return
  let backfilled = false
  const buffer: Log[] = []
  let attempt = 0

  const connect = () => {
    const ws = new WebSocket(config.rhWss!)
    let alive = Date.now()
    const ping = setInterval(() => {
      if (Date.now() - alive > 30_000) { ws.terminate(); return }
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'hb', method: 'eth_blockNumber', params: [] }))
    }, 10_000)
    ws.on('open', () => {
      attempt = 0
      ls.connected = true
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['logs', { address: PM, topics: [[T.Initialize, T.ModifyLiquidity, T.Swap]] }] }))
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_subscribe', params: ['logs', { topics: [[T.TokenLaunched, T.PoolGraduated, T.PoolRegistered]] }] }))
      console.log('[rh] dRPC websocket subscribed')
    })
    ws.on('message', (raw) => {
      alive = Date.now()
      ls.msgs++
      ls.lastMsgTs = alive
      const m = JSON.parse(String(raw))
      if (m.id === 'hb') {
        // a websocket that answers but stopped delivering logs is caught by the gap check on reconnect
        if (!backfilled && m.result) void startBackfill(parseInt(m.result, 16))
        return
      }
      if (m.id && m.error) console.error('[rh] subscribe error', m.error.message)
      const l = m.params?.result as Log | undefined
      if (!l?.topics) return
      if (l.topics[0] === T.PoolRegistered && l.address.toLowerCase() === PM) return
      if (!backfilled) { buffer.push(l); return }
      onLog(l)
    })
    ws.on('close', () => {
      clearInterval(ping)
      ls.connected = false
      const wait = Math.min(15_000, 500 * 2 ** attempt++)
      console.warn(`[rh] websocket closed, reconnecting in ${wait} ms`)
      setTimeout(() => { backfilled = false; connect() }, wait)
    })
    ws.on('error', (e) => console.error('[rh] websocket', redact(String(e))))
  }

  let backfilling = false
  async function startBackfill(head: number) {
    if (backfilling) return
    backfilling = true
    try { await backfill(head) } catch (e) { console.error('[rh] backfill failed', redact(String(e))) }
    backfilled = true
    backfilling = false
    const b = buffer.splice(0)
    for (const l of b) onLog(l)
  }

  connect()
  // kick the backfill without waiting for the first heartbeat
  setTimeout(async () => {
    try { const [bn] = await rpc([{ method: 'eth_blockNumber', params: [] }]); if (!backfilled) await startBackfill(parseInt(bn, 16)) } catch (e) { console.error('[rh] head', redact(String(e))) }
  }, 500)
}
