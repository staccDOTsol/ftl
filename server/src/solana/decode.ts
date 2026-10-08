// One decoder for every Solana lane. Each lane normalizes its transaction into
// an NTx; executed lanes add balances so amounts come out exact.

import bs58 from 'bs58'
import { decodeV1, type V1Config } from './transaction-v1.ts'
import { lookup, rolesOf, programIds, type IxSpec } from './programs.ts'
import type { RawEvent } from '../hub.ts'
import type { Amount, Lane, Stage } from '../../../shared/types.ts'

export interface NIx { prog: string; accts: number[]; data: Uint8Array; n: string; stackHeight?: number; rawDataKnown?: boolean }
export interface TokenBal { idx: number; mint: string; owner: string; amount: bigint; decimals: number }
export interface NTx {
  version?: 'legacy' | 0 | 1
  transactionConfig?: V1Config
  sig: string
  slot: number
  keys: (string | null)[]     // static + loaded; null where a lane could not resolve a lookup table
  ixs: NIx[]                   // top-level, then inner (n = "i" or "i.j")
  keyFlags?: { signer: boolean; writable: boolean }[]
  failed?: boolean
  pre?: TokenBal[]
  post?: TokenBal[]
  lamports?: { pre: bigint[]; post: bigint[]; fee: bigint }
  lookups?: string[]           // address lookup tables the message loaded from
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
      pool,
      mints,
      ...(spec.venue === 'meteora-dbc' && spec.kind === 'launch' ? { baseMint: key(ix, spec.accounts.indexOf('base_mint')) ?? undefined, quoteMint: key(ix, spec.accounts.indexOf('quote_mint')) ?? undefined } : {}),
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
  let len = 0
  for (let size = 0; size < 3; size++) {
    if (o.i >= b.length) throw new Error('Truncated transaction length')
    const x = b[o.i++]
    if (size === 2 && x > 3) throw new Error('Invalid compact-u16 length')
    len |= (x & 0x7f) << (size * 7)
    if ((x & 0x80) === 0) { if (size > 0 && x === 0) throw new Error('Noncanonical transaction length'); return len }
  }
  throw new Error('Invalid transaction length')
}

export interface WireTx { version: 'legacy' | 0 | 1; transactionConfig?: V1Config; sig: Uint8Array; keys: Uint8Array[]; ixs: { prog: number; accts: number[]; data: Uint8Array }[]; lookups: { table: string; w: number[]; r: number[] }[] }

// Raw parse: no base58 until the caller knows the tx is one it wants. Pending
// V1 transactions can have inadequate resource limits; decode them faithfully
// and let executed metadata determine success, rather than inventing a result.
export function parseWire(b: Uint8Array): WireTx {
  if (b[0] === 0x81) {
    const decoded = decodeV1(b)
    return { version: 1, transactionConfig: decoded.config, sig: decoded.signatures[0], keys: decoded.keys, ixs: decoded.ixs, lookups: [] }
  }
  if (!b.length || b.length > 1232) throw new Error('Invalid legacy/V0 transaction size')
  const o = { i: 0 }
  const take = (size: number) => { if (size < 0 || o.i + size > b.length) throw new Error('Truncated transaction'); const value = b.subarray(o.i, o.i + size); o.i += size; return value }
  const nsig = shortvec(b, o)
  if (nsig < 1 || nsig > 12) throw new Error('Invalid transaction signer count')
  const signatures = take(64 * nsig), sig = signatures.subarray(0, 64)
  let version: 'legacy' | 0 = 'legacy'
  if (b[o.i] & 0x80) { if (take(1)[0] !== 0x80) throw new Error('Unsupported transaction version'); version = 0 }
  const header = take(3)
  const nkeys = shortvec(b, o)
  if (header[0] !== nsig || header[1] >= nsig || nkeys < nsig + header[2] || nkeys > 256) throw new Error('Invalid transaction account counts')
  const keys: Uint8Array[] = []
  for (let k = 0; k < nkeys; k++) keys.push(take(32))
  take(32) // blockhash
  const nix = shortvec(b, o)
  if (nix > 64) throw new Error('Too many transaction instructions')
  const ixs: WireTx['ixs'] = []
  for (let k = 0; k < nix; k++) {
    const prog = take(1)[0]
    const accts = Array.from(take(shortvec(b, o)))
    const data = take(shortvec(b, o))
    ixs.push({ prog, accts, data })
  }
  const lookups: WireTx['lookups'] = []
  if (version === 0) {
    const nl = shortvec(b, o)
    if (nl > 64) throw new Error('Too many address lookup tables')
    for (let k = 0; k < nl; k++) {
      const table = bs58.encode(take(32))
      const w = Array.from(take(shortvec(b, o))), r = Array.from(take(shortvec(b, o)))
      lookups.push({ table, w, r })
    }
  }
  if (o.i !== b.length) throw new Error('Unexpected trailing transaction data')
  const totalKeys = keys.length + lookups.reduce((n, lookup) => n + lookup.w.length + lookup.r.length, 0)
  if (totalKeys > 256 || ixs.some(ix => ix.prog >= keys.length || ix.accts.some(a => a >= totalKeys))) throw new Error('Invalid transaction instruction index')
  return { version, sig, keys, ixs, lookups }
}
