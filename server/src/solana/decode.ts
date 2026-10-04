// One decoder for every Solana lane. Each lane normalizes its transaction into
// an NTx; executed lanes add balances so amounts come out exact.

import bs58 from 'bs58'
import { lookup, rolesOf, programIds, type IxSpec } from './programs.ts'
import type { RawEvent } from '../hub.ts'
import type { Amount, Lane, Stage } from '../../../shared/types.ts'

export interface NIx { prog: string; accts: number[]; data: Uint8Array; n: string }
export interface TokenBal { idx: number; mint: string; owner: string; amount: bigint; decimals: number }
export interface NTx {
  sig: string
  slot: number
  keys: (string | null)[]     // static + loaded; null where a lane could not resolve a lookup table
  ixs: NIx[]                   // top-level, then inner (n = "i" or "i.j")
  failed?: boolean
  pre?: TokenBal[]
  post?: TokenBal[]
  lamports?: { pre: bigint[]; post: bigint[]; fee: bigint }
}

export const WSOL = 'So11111111111111111111111111111111111111112'

// launch instructions carry the token's name, symbol and metadata uri in their args:
// FTL names a token the moment it is created, before any indexer has seen it
function borshStr(d: Uint8Array, o: { i: number }): string {
  const n = d[o.i] | (d[o.i + 1] << 8) | (d[o.i + 2] << 16) | (d[o.i + 3] << 24)
  o.i += 4
  if (n < 0 || n > 400 || o.i + n > d.length) throw new Error('bad string')
  const s = Buffer.from(d.subarray(o.i, o.i + n)).toString('utf8').replace(/\0/g, '').trim()
  o.i += n
  return s
}
function launchMeta(venue: string, name: string, data: Uint8Array): RawEvent['meta'] {
  try {
    const o = { i: 8 }
    let decimals: number | undefined
    if (venue === 'raydium-launchlab') decimals = data[o.i++]
    else if (venue !== 'pumpfun' && venue !== 'meteora-dbc') return undefined
    if (venue === 'pumpfun' && !name.startsWith('create')) return undefined
    return { name: borshStr(data, o), symbol: borshStr(data, o), uri: borshStr(data, o), decimals: decimals ?? (venue === 'pumpfun' ? 6 : undefined) }
  } catch { return undefined }
}
const programSet = new Set(programIds)

export function touchesUs(keys: (string | null)[]): boolean {
  for (const k of keys) if (k && programSet.has(k)) return true
  return false
}

export function decode(tx: NTx, lane: Lane, stage: Stage): RawEvent[] {
  const out: RawEvent[] = []
  const hits: { ix: NIx; spec: IxSpec }[] = []
  for (const ix of tx.ixs) {
    if (!programSet.has(ix.prog)) continue
    const spec = lookup(ix.prog, ix.data)
    if (spec) hits.push({ ix, spec })
  }
  if (!hits.length) return out
  const wallet = tx.keys[0] ?? ''
  const key = (ix: NIx, i: number) => (i >= 0 && i < ix.accts.length ? tx.keys[ix.accts[i]] ?? null : null)

  const graduating = hits.some(h => h.spec.kind === 'graduate')
  const addedPools = new Set(hits.filter(h => h.spec.kind === 'liq_add').map(h => key(h.ix, rolesOf(h.spec).pool)).filter(Boolean) as string[])

  // balance deltas by account index (executed lanes only)
  let delta: Map<number, { mint: string; d: bigint; decimals: number; owner: string }> | null = null
  if (tx.pre && tx.post) {
    delta = new Map()
    for (const b of tx.post) delta.set(b.idx, { mint: b.mint, d: b.amount, decimals: b.decimals, owner: b.owner })
    for (const b of tx.pre) {
      const cur = delta.get(b.idx)
      if (cur) cur.d -= b.amount
      else delta.set(b.idx, { mint: b.mint, d: -b.amount, decimals: b.decimals, owner: b.owner })
    }
  }

  for (const { ix, spec } of hits) {
    const r = rolesOf(spec)
    const pool = key(ix, r.pool)
    const mints = r.mints.map(i => key(ix, i)).filter(Boolean) as string[]
    let amounts: Amount[] | undefined
    if (delta && (spec.kind === 'liq_add' || spec.kind === 'liq_remove' || spec.kind === 'pool_init')) {
      amounts = []
      // what moved through this instruction's pool vaults, signed from the wallet's side
      for (const vi of r.vaults) {
        const ai = ix.accts[vi]
        if (ai === undefined) continue
        const d = delta.get(ai)
        if (!d || d.d === 0n) continue
        amounts.push({ mint: d.mint, ui: -Number(d.d) / 10 ** d.decimals, decimals: d.decimals })
      }
      // vault balances are exact; only when an instruction names no vault we can read
      // fall back to the wallet's own token accounts, and to its lamports for a native SOL leg
      const movesFunds = spec.kind !== 'pool_init' || !!spec.fundsOnInit
      if (!amounts.length && movesFunds) {
        for (const d of delta.values()) {
          if (d.owner !== wallet || d.d === 0n) continue
          if (mints.length && !mints.includes(d.mint)) continue
          amounts.push({ mint: d.mint, ui: Number(d.d) / 10 ** d.decimals, decimals: d.decimals })
        }
        if (mints.includes(WSOL) && !amounts.some(a => a.mint === WSOL) && tx.lamports) {
          const d = tx.lamports.post[0] - tx.lamports.pre[0] + tx.lamports.fee
          if (d !== 0n) amounts.push({ mint: WSOL, ui: Number(d) / 1e9, decimals: 9 })
        }
      }
    }
    out.push({
      chain: 'solana',
      kind: spec.kind,
      venue: spec.venue,
      ix: spec.name,
      pool: spec.kind === 'launch' || spec.kind === 'graduate' ? null : pool,
      mints,
      wallet,
      amounts,
      feeBps: null,
      tx: tx.sig,
      n: ix.n,
      slot: tx.slot,
      lane,
      stage: tx.failed ? 'failed' : stage,
      noLiquidity: spec.kind === 'pool_init' && !spec.fundsOnInit && !(pool && addedPools.has(pool)),
      gradPool: spec.kind === 'pool_init' && graduating,
      meta: spec.kind === 'launch' ? launchMeta(spec.venue, spec.name, ix.data) : undefined,
    })
  }
  return out
}

// ---- wire-format transactions (Preconfs) -----------------------------------

function shortvec(b: Uint8Array, o: { i: number }): number {
  let len = 0, size = 0
  for (;;) {
    const x = b[o.i++]
    len |= (x & 0x7f) << (size * 7)
    size++
    if ((x & 0x80) === 0) return len
  }
}

export interface WireTx { sig: string; keys: string[]; ixs: { prog: number; accts: number[]; data: Uint8Array }[]; lookups: { table: string; w: number[]; r: number[] }[] }

export function parseWire(b: Uint8Array): WireTx {
  const o = { i: 0 }
  const nsig = shortvec(b, o)
  const sig = bs58.encode(b.subarray(o.i, o.i + 64))
  o.i += 64 * nsig
  let versioned = false
  if (b[o.i] & 0x80) { versioned = true; o.i++ }
  o.i += 3 // header
  const nkeys = shortvec(b, o)
  const keys: string[] = []
  for (let k = 0; k < nkeys; k++) { keys.push(bs58.encode(b.subarray(o.i, o.i + 32))); o.i += 32 }
  o.i += 32 // blockhash
  const nix = shortvec(b, o)
  const ixs: WireTx['ixs'] = []
  for (let k = 0; k < nix; k++) {
    const prog = b[o.i++]
    const na = shortvec(b, o)
    const accts = Array.from(b.subarray(o.i, o.i + na)); o.i += na
    const nd = shortvec(b, o)
    const data = b.subarray(o.i, o.i + nd); o.i += nd
    ixs.push({ prog, accts, data })
  }
  const lookups: WireTx['lookups'] = []
  if (versioned && o.i < b.length) {
    const nl = shortvec(b, o)
    for (let k = 0; k < nl; k++) {
      const table = bs58.encode(b.subarray(o.i, o.i + 32)); o.i += 32
      const nw = shortvec(b, o); const w = Array.from(b.subarray(o.i, o.i + nw)); o.i += nw
      const nr = shortvec(b, o); const r = Array.from(b.subarray(o.i, o.i + nr)); o.i += nr
      lookups.push({ table, w, r })
    }
  }
  return { sig, keys, ixs, lookups }
}
