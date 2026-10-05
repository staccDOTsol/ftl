// Solana lanes, fastest first:
//   preconf     Triton Preconfs (Harmonic builder batches / BAM leader acks), raw wire txs, before shreds
//   deshred     Triton Dragon's Mouth SubscribeDeshred, entries rebuilt from shreds, before execution
//   geyser      Triton Dragon's Mouth Subscribe, processed commitment, with metadata
//   geyser-drpc dRPC's Yellowstone Subscribe, processed commitment, with metadata
// All lanes race into the hub; the first copy of an instruction wins, executed copies confirm it.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import bs58 from 'bs58'
import Client, { CommitmentLevel, type SubscribeRequest, type SubscribeUpdate } from '@triton-one/yellowstone-grpc'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { config, redact } from '../config.ts'
import { ingest, lane } from '../hub.ts'
import { decode, parseWire, type NIx, type NTx, type TokenBal } from './decode.ts'
import { programIds, lookup } from './programs.ts'
import type { Lane } from '../../../shared/types.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
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
  for (const r of decode(tx, l, stage)) ingest(r)
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

function geyserLane(l: Lane, url: string, token: string) {
  const ls = lane('solana', l, true)
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
      attempt = 0
      console.log(`[sol:${l}] subscribed (${programIds.length} programs)`)
      const ping = setInterval(() => stream.write({ ...emptyRequest(), ping: { id: 1 } } as any), 10_000)
      stream.on('data', (u: SubscribeUpdate) => {
        ls.msgs++
        ls.lastMsgTs = Date.now()
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
    } catch (e: any) {
      console.error(`[sol:${l}] connect`, redact(String(e?.message ?? e)))
    }
    ls.connected = false
    const wait = Math.min(30_000, 500 * 2 ** attempt++)
    setTimeout(run, wait)
  }
  void run()
}

// ---- pre-execution lane: SubscribeDeshred -----------------------------------

function deshredLane(url: string, token: string) {
  const ls = lane('solana', 'deshred', true)
  let attempt = 0
  const run = async () => {
    try {
      const client = new Client(url, token, channelOptions)
      await client.connect()
      const stream = await client.subscribeDeshred()
      stream.write({ deshredTransactions: { ftl: { vote: false, accountInclude: programIds, accountExclude: [], accountRequired: [] } }, slots: {} } as any)
      ls.connected = true
      attempt = 0
      console.log('[sol:deshred] subscribed')
      const ping = setInterval(() => stream.write({ deshredTransactions: { ftl: { vote: false, accountInclude: programIds, accountExclude: [], accountRequired: [] } }, slots: {}, ping: { id: 1 } } as any), 10_000)
      stream.on('data', (u: any) => {
        ls.msgs++
        ls.lastMsgTs = Date.now()
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
    } catch (e: any) {
      console.error('[sol:deshred] connect', redact(String(e?.message ?? e)))
    }
    ls.connected = false
    setTimeout(run, Math.min(30_000, 500 * 2 ** attempt++))
  }
  void run()
}

// ---- Preconfs: Harmonic + BAM ------------------------------------------------

// address lookup tables are append-only, so a cached table only ever grows
const alts = new Map<string, string[]>()
const altInflight = new Set<string>()
async function fetchAlt(table: string) {
  if (!config.solanaRpc || altInflight.has(table)) return
  altInflight.add(table)
  try {
    const r = await fetch(config.solanaRpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [table, { encoding: 'base64', commitment: 'processed' }] }) })
    const j = await r.json() as any
    const data = j?.result?.value?.data?.[0]
    if (data) {
      const b = Buffer.from(data, 'base64')
      const addrs: string[] = []
      for (let o = 56; o + 32 <= b.length; o += 32) addrs.push(bs58.encode(b.subarray(o, o + 32)))
      alts.set(table, addrs)
    }
  } catch {} finally { altInflight.delete(table) }
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

function preconfsLanes() {
  const def = protoLoader.loadSync(path.join(here, '..', '..', 'proto', 'preconfs.proto'), { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true })
  const pkg = grpc.loadPackageDefinition(def).preconfs as any
  const host = config.preconfsUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')
  const target = host.includes(':') ? host : `${host}:443`
  const filters = { ftl: { instructions: programIds.map(p => ({ program_id: p })) } }
  const ls = lane('solana', 'preconf', true)
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
      call.on('data', (u: any) => {
        if (!opened) { opened = true; attempt = 0; open.add(spec); ls.connected = true }
        ls.msgs++
        ls.lastMsgTs = Date.now()
        const t = u.transaction
        if (!t?.transaction) return
        if (t.result && /FAILURE/.test(String(t.result))) return
        try { emit(wireToNTx(t.transaction, Number(t.slot)), 'preconf', 'pending') } catch (e) { console.error('[sol:preconf] decode', String(e)) }
      })
      const restart = (why: string) => {
        if (opened) console.warn(`[sol:preconf] ${spec} ${why}`)
        open.delete(spec)
        ls.connected = open.size > 0
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

export function startSolana() {
  const triton = config.tritonGrpcUrl && config.tritonXToken
  if (triton) {
    geyserLane('geyser', config.tritonGrpcUrl!, config.tritonXToken!)
    if (config.tritonDeshred) deshredLane(config.tritonGrpcUrl!, config.tritonXToken!)
    else lane('solana', 'deshred', false, 'TRITON_DESHRED=0')
  } else {
    lane('solana', 'geyser', false, 'TRITON_GRPC_URL / TRITON_X_TOKEN not set')
    lane('solana', 'deshred', false, 'TRITON_GRPC_URL / TRITON_X_TOKEN not set')
  }
  if (config.drpcGeyserUrl && config.drpcKey) geyserLane('geyser-drpc', config.drpcGeyserUrl, config.drpcKey)
  else lane('solana', 'geyser-drpc', false, 'DRPC_GEYSER_URL not set (dRPC dashboard: Solana Geyser gRPC card)')
  if (config.preconfsToken) preconfsLanes()
  else lane('solana', 'preconf', false, 'TRITON_PRECONFS_TOKEN not set')
}
