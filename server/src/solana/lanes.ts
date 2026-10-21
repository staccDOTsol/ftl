// Solana lanes, fastest first:
//   preconf        Triton Preconfs (selected Harmonic / BAM regions), before shreds
//   deshred        Triton Dragon's Mouth SubscribeDeshred, before execution
//   geyser-primary provider-neutral Yellowstone Subscribe, processed with metadata
//   geyser         optional Triton Dragon's Mouth Subscribe, processed with metadata
//   geyser-drpc    optional dRPC Yellowstone Subscribe, processed with metadata
// All lanes race into the hub; the first copy of an instruction wins, executed copies confirm it.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import bs58 from 'bs58'
import Client, { CommitmentLevel, type SubscribeRequest, type SubscribeUpdate } from '@triton-one/yellowstone-grpc'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { config, redact } from '../config.ts'
import type { RawEvent } from '../hub.ts'
import { decode, parseWire, type NIx, type NTx, type TokenBal } from './decode.ts'
import { programIds, lookup } from './programs.ts'
import type { Lane } from '../../../shared/types.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

// Each lane runs in its own worker thread (see worker.ts). A lane reports through a sink:
// matched events go to the hub on the main thread, counters go to /api/status.
export interface LaneStats { connected: boolean; msgs: number; lastMsgTs: number | null; lagMs?: number; configuredStreams?: number; activeStreams?: number }
export interface Sink { emit(evs: RawEvent[]): void; stats(l: Lane): LaneStats }
let sink: Sink
export function setSink(s: Sink) { sink = s }
const lane = (_chain: 'solana', l: Lane, _enabled: boolean) => sink.stats(l)
const lagOf = (u: any) => (u?.createdAt instanceof Date ? Date.now() - u.createdAt.getTime() : undefined)
const ewma = (prev: number | undefined, x: number | undefined) => (x === undefined ? prev : prev === undefined ? x : Math.round(prev * 0.9 + x * 0.1))
const programHex = new Map(programIds.map(p => [Buffer.from(bs58.decode(p)).toString('hex'), p]))
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

// ---- yellowstone message -> NTx ---------------------------------------------

// cheap gate: does any (inner) instruction hit a spec? Only then pay for base58.
function interesting(keys: Uint8Array[], ixs: { programIdIndex: number; data: Uint8Array }[]): boolean {
  for (const ix of ixs) {
    const k = keys[ix.programIdIndex]
    if (!k) continue
    const p = programHex.get(hex(k))
    if (p && lookup(p, ix.data)) return true
  }
  return false
}

export function __toNTx(...a: Parameters<typeof toNTx>) { return toNTx(...a) }
function toNTx(sig: Uint8Array, slot: number, message: any, loadedW: Uint8Array[], loadedR: Uint8Array[], meta: any | null): NTx | null {
  const raw: Uint8Array[] = [...(message?.accountKeys ?? []), ...loadedW, ...loadedR]
  const top = message?.instructions ?? []
  const inner: { idx: number; ixs: any[] }[] = (meta?.innerInstructions ?? []).map((g: any) => ({ idx: g.index, ixs: g.instructions }))
  if (!interesting(raw, top) && !inner.some(g => interesting(raw, g.ixs))) return null
  const keys = raw.map(k => bs58.encode(k))
  const ixs: NIx[] = []
  top.forEach((ix: any, i: number) => ixs.push({ prog: keys[ix.programIdIndex], accts: Array.from(ix.accounts as Uint8Array), data: ix.data, n: String(i) }))
  for (const g of inner) g.ixs.forEach((ix: any, j: number) => ixs.push({ prog: keys[ix.programIdIndex], accts: Array.from(ix.accounts as Uint8Array), data: ix.data, n: `${g.idx}.${j}` }))
  const tx: NTx = { sig: bs58.encode(sig), slot, keys, ixs }
  if (meta) {
    tx.failed = !!meta.err
    const bal = (arr: any[]): TokenBal[] => (arr ?? []).map(b => ({ idx: b.accountIndex, mint: b.mint, owner: b.owner, amount: BigInt(b.uiTokenAmount?.amount ?? '0'), decimals: b.uiTokenAmount?.decimals ?? 0 }))
    tx.pre = bal(meta.preTokenBalances)
    tx.post = bal(meta.postTokenBalances)
    tx.lamports = { pre: (meta.preBalances ?? []).map((x: string) => BigInt(x)), post: (meta.postBalances ?? []).map((x: string) => BigInt(x)), fee: BigInt(meta.fee ?? 0) }
  }
  return tx
}

function emit(tx: NTx | null, l: Lane, stage: 'pending' | 'confirmed') {
  if (!tx) return
  const evs = decode(tx, l, stage)
  if (evs.length) sink.emit(evs)
}

const emptyRequest = (): SubscribeRequest => ({
  accounts: {}, slots: {}, transactions: {}, transactionsStatus: {}, blocks: {}, blocksMeta: {}, entry: {}, accountsDataSlice: [], blockFooter: {},
})

const channelOptions = {
  'grpc.max_receive_message_length': 64 * 1024 * 1024,
  'grpc.http2.adaptive_window': true,
  'grpc.http2.initial_connection_window_size': 8 * 1024 * 1024,
  'grpc.http2.initial_stream_window_size': 4 * 1024 * 1024,
} as any

// ---- executed lane: Subscribe at processed ----------------------------------

export function geyserLane(l: Lane, url: string, token: string) {
  const ls = lane('solana', l, true)
  ls.configuredStreams = 1
  let attempt = 0
  const run = async () => {
    try {
      const client = new Client(url, token, channelOptions)
      await client.connect()
      const req = emptyRequest()
      req.commitment = CommitmentLevel.PROCESSED
      req.transactions.ftl = { vote: false, accountInclude: programIds, accountExclude: [], accountRequired: [] }
      const stream = await client.subscribe(req)
      ls.connected = true
      ls.activeStreams = 1
      attempt = 0
      console.log(`[sol:${l}] subscribed (${programIds.length} programs)`)
      const ping = setInterval(() => stream.write({ ...emptyRequest(), ping: { id: 1 } } as any), 10_000)
      stream.on('data', (u: SubscribeUpdate) => {
        ls.msgs++
        ls.lastMsgTs = Date.now()
        ls.lagMs = ewma(ls.lagMs, lagOf(u))
        const t = u.transaction
        if (!t?.transaction) return
        const info = t.transaction
        try {
          emit(toNTx(info.signature, Number(t.slot), info.transaction?.message, info.meta?.loadedWritableAddresses ?? [], info.meta?.loadedReadonlyAddresses ?? [], info.meta), l, 'confirmed')
        } catch (e) { console.error(`[sol:${l}] decode`, String(e)) }
      })
      await new Promise<void>((resolve) => {
        stream.on('error', (e: any) => { console.error(`[sol:${l}] stream`, redact(String(e?.message ?? e))); resolve() })
        stream.on('end', () => resolve())
        stream.on('close', () => resolve())
      })
      clearInterval(ping)
      stream.destroy()
    } catch (e: any) {
      console.error(`[sol:${l}] connect`, redact(String(e?.message ?? e)))
    }
    ls.connected = false
    ls.activeStreams = 0
    const wait = Math.min(30_000, 500 * 2 ** attempt++)
    setTimeout(run, wait)
  }
  void run()
}

// ---- pre-execution lane: SubscribeDeshred -----------------------------------

export function deshredLane(url: string, token: string) {
  const ls = lane('solana', 'deshred', true)
  ls.configuredStreams = 1
  let attempt = 0
  const run = async () => {
    try {
      const client = new Client(url, token, channelOptions)
      await client.connect()
      const stream = await client.subscribeDeshred()
      stream.write({ deshredTransactions: { ftl: { vote: false, accountInclude: programIds, accountExclude: [], accountRequired: [] } }, slots: {} } as any)
      ls.connected = true
      ls.activeStreams = 1
      attempt = 0
      console.log('[sol:deshred] subscribed')
      const ping = setInterval(() => stream.write({ deshredTransactions: { ftl: { vote: false, accountInclude: programIds, accountExclude: [], accountRequired: [] } }, slots: {}, ping: { id: 1 } } as any), 10_000)
      stream.on('data', (u: any) => {
        ls.msgs++
        ls.lastMsgTs = Date.now()
        ls.lagMs = ewma(ls.lagMs, lagOf(u))
        const d = u.deshredTransaction
        if (!d?.transaction) return
        const info = d.transaction
        try {
          emit(toNTx(info.signature, Number(d.slot), info.transaction?.message, info.loadedWritableAddresses ?? [], info.loadedReadonlyAddresses ?? [], null), 'deshred', 'pending')
        } catch (e) { console.error('[sol:deshred] decode', String(e)) }
      })
      await new Promise<void>((resolve) => {
        stream.on('error', (e: any) => { console.error('[sol:deshred] stream', redact(String(e?.message ?? e))); resolve() })
        stream.on('end', () => resolve())
        stream.on('close', () => resolve())
      })
      clearInterval(ping)
      stream.destroy()
    } catch (e: any) {
      console.error('[sol:deshred] connect', redact(String(e?.message ?? e)))
    }
    ls.connected = false
    ls.activeStreams = 0
    setTimeout(run, Math.min(30_000, 500 * 2 ** attempt++))
  }
  void run()
}

// ---- Preconfs: Harmonic + BAM ------------------------------------------------

// address lookup tables are append-only, so a cached table only ever grows
const alts = new Map<string, string[]>()
const altInflight = new Set<string>()
const altRetryAt = new Map<string, number>()
async function fetchAlt(table: string) {
  if (!config.solanaRpc || altInflight.has(table) || (altRetryAt.get(table) ?? 0) > Date.now()) return
  altInflight.add(table)
  try {
    const r = await fetch(config.solanaRpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [table, { encoding: 'base64', commitment: 'processed' }] }), signal: AbortSignal.timeout(8_000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const j = await r.json() as any
    const data = j?.result?.value?.data?.[0]
    if (data) {
      const b = Buffer.from(data, 'base64')
      const addrs: string[] = []
      for (let o = 56; o + 32 <= b.length; o += 32) addrs.push(bs58.encode(b.subarray(o, o + 32)))
      alts.set(table, addrs)
      altRetryAt.delete(table)
    } else altRetryAt.set(table, Date.now() + 60_000)
  } catch { altRetryAt.set(table, Date.now() + 60_000) }
  finally { altInflight.delete(table) }
  if (altRetryAt.size > 20_000) altRetryAt.clear()
}

function wireToNTx(bytes: Uint8Array, slot: number): NTx | null {
  const w = parseWire(bytes)
  if (!interesting(w.keys, w.ixs.map(ix => ({ programIdIndex: ix.prog, data: ix.data })))) return null
  const keys: (string | null)[] = w.keys.map(k => bs58.encode(k))
  const ro: (string | null)[] = []
  for (const lk of w.lookups) {
    const t = alts.get(lk.table)
    if (!t) void fetchAlt(lk.table)
    for (const i of lk.w) keys.push(t?.[i] ?? null)
    for (const i of lk.r) ro.push(t?.[i] ?? null)
  }
  keys.push(...ro)
  return { sig: bs58.encode(w.sig), slot, keys, ixs: w.ixs.map((ix, i) => ({ prog: keys[ix.prog] as string, accts: ix.accts, data: ix.data, n: String(i) })) }
}

export function preconfsLanes() {
  const def = protoLoader.loadSync(path.join(here, '..', '..', 'proto', 'preconfs.proto'), { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true })
  const pkg = grpc.loadPackageDefinition(def).preconfs as any
  const host = config.preconfsUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
  const target = host.includes(':') ? host : `${host}:443`
  const filters = { ftl: { instructions: programIds.map(p => ({ program_id: p })) } }
  const ls = lane('solana', 'preconf', true)
  ls.configuredStreams = config.preconfsRegions.length
  const open = new Set<string>()
  for (const spec of config.preconfsRegions) {
    const [feed, region] = spec.split(':')
    const isBam = feed.toLowerCase() === 'bam'
    const Svc = isBam ? pkg.BAM : pkg.Harmonic
    const regionField = isBam ? { bam_region: `BAM_REGION_${region.toUpperCase()}` } : { harmonic_region: `HARMONIC_REGION_${region.toUpperCase()}` }
    let attempt = 0
    const run = () => {
      const client = new Svc(target, grpc.credentials.createSsl(), { 'grpc.keepalive_time_ms': 30_000, 'grpc.max_receive_message_length': -1 })
      const md = new grpc.Metadata()
      md.set('x-token', config.preconfsToken!)
      const call = client.Subscribe({ transactions: filters, ...regionField }, md)
      let opened = false
      let restarting = false
      call.on('data', (u: any) => {
        if (!opened) { opened = true; attempt = 0; open.add(spec); ls.connected = true; ls.activeStreams = open.size }
        ls.msgs++
        ls.lastMsgTs = Date.now()
        ls.lagMs = ewma(ls.lagMs, lagOf(u))
        const t = u.transaction
        if (!t?.transaction) return
        if (t.result && /FAILURE/.test(String(t.result))) return
        try { emit(wireToNTx(t.transaction, Number(t.slot)), 'preconf', 'pending') } catch (e) { console.error('[sol:preconf] decode', String(e)) }
      })
      const restart = (why: string) => {
        if (restarting) return
        restarting = true
        if (opened) console.warn(`[sol:preconf] ${spec} ${why}`)
        open.delete(spec)
        ls.connected = open.size > 0
        ls.activeStreams = open.size
        try { client.close() } catch {}
        setTimeout(run, Math.min(30_000, 1000 * 2 ** attempt++))
      }
      call.on('error', (e: any) => restart(redact(String(e?.details ?? e?.message ?? e))))
      call.on('end', () => restart('ended'))
    }
    run()
  }
}

// ---- start ------------------------------------------------------------------

export function startSolana(ingest: (r: RawEvent) => void, setLane: (l: Lane, enabled: boolean, reason?: string, stats?: LaneStats) => void) {
  const triton = config.tritonGrpcUrl && config.tritonXToken
  const spawn = (kind: Lane) => {
    setLane(kind, true)
    const w = new Worker(new URL('./worker.ts', import.meta.url), { workerData: { kind } })
    w.on('message', (m: any) => {
      if (m.t === 'ev') for (const r of m.evs) ingest(r)
      else if (m.t === 'stats') setLane(kind, true, undefined, m.stats)
    })
    w.on('error', (e) => console.error(`[sol:${kind}] worker`, redact(String(e))))
    w.on('exit', (code) => { console.warn(`[sol:${kind}] worker exited ${code}, restarting`); setTimeout(() => spawn(kind), 2000) })
  }
  if (config.yellowstoneGrpcUrl && config.yellowstoneXToken) spawn('geyser-primary')
  else setLane('geyser-primary', false, 'YELLOWSTONE_GRPC_URL / YELLOWSTONE_X_TOKEN not set')

  if (!config.tritonGeyser) setLane('geyser', false, 'TRITON_GEYSER=1 not set')
  else if (triton) spawn('geyser')
  else setLane('geyser', false, 'TRITON_GRPC_URL / TRITON_X_TOKEN not set')

  if (!config.tritonDeshred) setLane('deshred', false, 'TRITON_DESHRED=1 not set')
  else if (triton) spawn('deshred')
  else setLane('deshred', false, 'TRITON_GRPC_URL / TRITON_X_TOKEN not set')

  if (!config.drpcGeyser) setLane('geyser-drpc', false, 'DRPC_GEYSER=1 not set')
  else if (config.drpcGeyserUrl && config.drpcKey) spawn('geyser-drpc')
  else setLane('geyser-drpc', false, 'DRPC_GEYSER_URL / DRPC_KEY not set')

  const regions = config.preconfsRegions
  if (!config.tritonPreconfs) setLane('preconf', false, 'TRITON_PRECONFS=1 not set')
  else if (!config.preconfsToken) setLane('preconf', false, 'TRITON_PRECONFS_TOKEN not set')
  else if (!regions.length) setLane('preconf', false, 'TRITON_PRECONFS_REGIONS not set')
  else if (regions.some(r => !/^(harmonic|bam):[a-z0-9-]+$/i.test(r)) || new Set(regions).size !== regions.length)
    setLane('preconf', false, 'TRITON_PRECONFS_REGIONS invalid or contains duplicates')
  else { console.log(`[sol:preconf] opening ${regions.length} explicitly selected region streams`); spawn('preconf') }
}
