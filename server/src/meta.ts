// Token name / symbol / image / description.
//  Solana:    Helius DAS getAssetBatch (20 mints a call), falling back to the
//             Token-2022 metadata extension / Metaplex PDA for anything DAS has not indexed.
//             Launches are named from their own instruction args before either answers.
//  Robinhood: name/symbol/decimals plus Pons getTokenInfo() (logo, description, socials), batched.

import crypto from 'node:crypto'
import bs58 from 'bs58'
import { ed25519 } from '@noble/curves/ed25519.js'
import { keccak_256 } from '@noble/hashes-v2/sha3.js'
import { config } from './config.ts'
import { db, getCursor, setCursor } from './db.ts'
import { QUOTES, bus, setTokenMeta } from './hub.ts'
import { recordKnownTokenProgram } from './solana/holders.ts'
import { httpImage, parseDasAsset } from './solana/token-meta.ts'
import { createBackgroundRpc } from './solana/rpc-resilience.ts'
import type { Chain, TokenMeta } from '../../shared/types.ts'

const METAPLEX = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'

async function offchain(uri: string): Promise<{ image?: string; description?: string; twitter?: string; website?: string }> {
  const url = httpImage(uri)
  if (!url) return {}
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) })
    if (!r.ok) return {}
    if ((r.headers.get('content-type') ?? '').startsWith('image/')) return { image: url }
    const j = await r.json() as any
    return {
      image: httpImage(typeof j?.image === 'string' ? j.image : undefined),
      description: typeof j?.description === 'string' ? j.description : undefined,
      twitter: typeof j?.twitter === 'string' ? j.twitter : j?.extensions?.twitter,
      website: typeof j?.website === 'string' ? j.website : j?.extensions?.website,
    }
  } catch { return {} }
}

// ---- Solana ---------------------------------------------------------------

function metadataRpcBudget() {
  const day = new Date().toISOString().slice(0, 10)
  const budgetKey = `meta:rpc:${day}`
  const used = Number(getCursor(budgetKey) ?? 0)
  // Zero records usage without stopping metadata for newly seen tokens.
  const limit = Math.max(0, Number(process.env.META_RPC_DAILY_LIMIT ?? 0))
  return { budgetKey, used, limit }
}

// Metadata enrichment shares the RPC with quoting in some deployments. Keep
// it to two requests in flight, retry 5xx/network failures with the shared
// bounded backoff, and stop for 30 s after any 429 instead of hammering.
export const META_RPC_CONCURRENCY = 2
export const META_RPC_COOLDOWN_MS = 30_000
const metaRpc = createBackgroundRpc({ concurrency: META_RPC_CONCURRENCY, cooldownMs: META_RPC_COOLDOWN_MS })

async function solRpc(method: string, params: unknown): Promise<any> {
  const { budgetKey, used, limit } = metadataRpcBudget()
  if (limit > 0 && used >= limit) throw new Error('metadata RPC daily budget exhausted')
  const url = method === 'getAssetBatch' ? config.solanaDasRpc : config.solanaRpc
  if (!url) throw new Error(`no Solana RPC endpoint for ${method}`)
  if (metaRpc.coolingDown()) throw new Error('metadata RPC cooling down after a rate limit')
  setCursor(budgetKey, String(used + 1))
  const r = await metaRpc.call(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000) })
  if (!r.ok) throw new Error(`Solana RPC HTTP ${r.status}`)
  const j = await r.json() as any
  if (j.error) throw new Error(j.error.message)
  return j.result
}

async function dasBatch(mints: string[]): Promise<Map<string, TokenMeta>> {
  const out = new Map<string, TokenMeta>()
  const res = await solRpc('getAssetBatch', { ids: mints, displayOptions: { showFungible: true } })
  for (const a of res ?? []) {
    const parsed = parseDasAsset(a)
    if (!parsed) continue
    if (parsed.tokenProgram) recordKnownTokenProgram(a.id, parsed.tokenProgram, 'das-getAssetBatch')
    out.set(a.id, parsed.meta)
  }
  return out
}

function onCurve(b: Uint8Array): boolean { try { ed25519.Point.fromBytes(b); return true } catch { return false } }
function pda(seeds: Uint8Array[], program: string): string {
  const pid = bs58.decode(program)
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash('sha256')
    for (const s of seeds) h.update(s)
    h.update(Uint8Array.of(bump)); h.update(pid); h.update(Buffer.from('ProgramDerivedAddress'))
    const d = h.digest()
    if (!onCurve(d)) return bs58.encode(d)
  }
  throw new Error('no pda')
}
const clean = (s: string) => s.replace(/\0/g, '').trim()
function borshStr(b: Buffer, o: { i: number }): string { const n = b.readUInt32LE(o.i); o.i += 4; const s = b.subarray(o.i, o.i + n).toString('utf8'); o.i += n; return clean(s) }

async function parseOnchainSolana(mintAcct: any, mdAcct: any): Promise<TokenMeta | null> {
  if (!mintAcct) return null
  const m = Buffer.from(mintAcct.data[0], 'base64')
  const decimals = m.length >= 45 ? m[44] : undefined
  let name: string | undefined, symbol: string | undefined, uri: string | undefined
  if (m.length > 166) {
    let o = 166
    while (o + 4 <= m.length) {
      const type = m.readUInt16LE(o), len = m.readUInt16LE(o + 2)
      if (type === 19) { const p = { i: o + 4 + 64 }; name = borshStr(m, p); symbol = borshStr(m, p); uri = borshStr(m, p); break }
      if (type === 0 && len === 0) break
      o += 4 + len
    }
  }
  if (!name && mdAcct) { const d = Buffer.from(mdAcct.data[0], 'base64'); const p = { i: 65 }; name = borshStr(d, p); symbol = borshStr(d, p); uri = borshStr(d, p) }
  return { name, symbol, decimals, ...(uri ? await offchain(uri) : {}) }
}

// One account read covers up to 20 mints and their Metaplex PDAs. This is the
// fallback for assets that DAS has not indexed yet, not one RPC per mint.
async function onchainSolanaBatch(mints: string[]): Promise<Map<string, TokenMeta>> {
  const accounts = mints.flatMap(mint => [mint, pda([Buffer.from('metadata'), bs58.decode(METAPLEX), bs58.decode(mint)], METAPLEX)])
  const r = await solRpc('getMultipleAccounts', [accounts, { encoding: 'base64' }])
  const values: any[] = r?.value ?? []
  const out = new Map<string, TokenMeta>()
  for (let i = 0; i < mints.length; i += 4) {
    await Promise.all(mints.slice(i, i + 4).map(async (mint, offset) => {
      const mintAccount = values[(i + offset) * 2]
      if (typeof mintAccount?.owner === 'string') recordKnownTokenProgram(mint, mintAccount.owner, 'mint-account-owner')
      const meta = await parseOnchainSolana(mintAccount, values[(i + offset) * 2 + 1])
      if (meta) out.set(mint, meta)
    }))
  }
  return out
}

// ---- Robinhood ------------------------------------------------------------

const sel = (sig: string) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(sig)).slice(0, 4)).toString('hex')
const SEL = { name: sel('name()'), symbol: sel('symbol()'), decimals: sel('decimals()'), info: sel('getTokenInfo()') }

function abiStringAt(b: Buffer, off: number): string | undefined {
  if (off + 32 > b.length) return undefined
  const len = Number(b.readBigUInt64BE(off + 24))
  if (len > 4096 || off + 32 + len > b.length) return undefined
  return clean(b.subarray(off + 32, off + 32 + len).toString('utf8')) || undefined
}
function abiString(hex: string | null): string | undefined {
  if (!hex || hex === '0x') return undefined
  const b = Buffer.from(hex.slice(2), 'hex')
  if (b.length >= 64) return abiStringAt(b, Number(b.readBigUInt64BE(24)))
  return clean(b.toString('utf8')) || undefined
}
// getTokenInfo() -> (address deployer, string logo, string description, (twitter, telegram, discord, website, farcaster))
function tokenInfo(hex: string | null): Partial<TokenMeta> {
  if (!hex || hex.length < 2 + 64 * 4) return {}
  try {
    const b = Buffer.from(hex.slice(2), 'hex')
    const logo = abiStringAt(b, Number(b.readBigUInt64BE(32 + 24)))
    const description = abiStringAt(b, Number(b.readBigUInt64BE(64 + 24)))
    const so = Number(b.readBigUInt64BE(96 + 24))
    const str = (i: number) => abiStringAt(b, so + Number(b.readBigUInt64BE(so + i * 32 + 24)))
    return { image: httpImage(logo), description, twitter: str(0), website: str(3) }
  } catch { return {} }
}

async function robinhoodMeta(tokens: string[]): Promise<Map<string, TokenMeta>> {
  const keys = ['name', 'symbol', 'decimals', 'info'] as const
  const calls = tokens.flatMap((t, i) => keys.map((k, j) => ({ jsonrpc: '2.0', id: i * 4 + j, method: 'eth_call', params: [{ to: t, data: SEL[k] }, 'latest'] })))
  const r = await fetch(config.rhHttp!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls), signal: AbortSignal.timeout(12_000) })
  const arr = await r.json() as any[]
  const by = new Map(arr.map(x => [x.id, x.result ?? null]))
  const out = new Map<string, TokenMeta>()
  tokens.forEach((t, i) => {
    const dec = by.get(i * 4 + 2)
    out.set(t, {
      name: abiString(by.get(i * 4) ?? null),
      symbol: abiString(by.get(i * 4 + 1) ?? null),
      decimals: dec && dec !== '0x' ? Number(BigInt(dec)) : undefined,
      ...tokenInfo(by.get(i * 4 + 3) ?? null),
    })
  })
  return out
}

// ---- queue ----------------------------------------------------------------

const pending = { solana: new Set<string>(), robinhood: new Set<string>() }
const attempts = new Map<string, number>()
const inflight = new Set<string>()
const retryAt = new Map<string, number>()
const RETRY_MS = [4_000, 20_000, 90_000, 5 * 60_000, 20 * 60_000]
let flushing = false

export function enrich(chain: Chain, address: string, force = false) {
  const key = `${chain}:${address}`
  if (QUOTES[chain][address] || pending[chain].has(address) || inflight.has(key) || (retryAt.get(key) ?? 0) > Date.now()) return
  if (!force) {
    const row = db.prepare('SELECT meta_ts FROM tokens WHERE chain = ? AND address = ?').get(chain, address) as any
    if (row?.meta_ts) return
  }
  pending[chain].add(address)
}

// a token is done once it has a symbol and an image; otherwise ask again on a backoff
function settle(chain: Chain, address: string, m: TokenMeta | null | undefined) {
  const key = `${chain}:${address}`
  const n = attempts.get(key) ?? 0
  const complete = !!(m?.symbol && m?.image)
  const last = n >= RETRY_MS.length
  if (m && (m.name || m.symbol || m.image || m.description)) setTokenMeta(chain, address, m, complete || last)
  else if (last) setTokenMeta(chain, address, {}, true)
  inflight.delete(key)
  if (complete || last) { attempts.delete(key); retryAt.delete(key); return }
  attempts.set(key, n + 1)
  const at = Date.now() + RETRY_MS[n]
  retryAt.set(key, at)
  setTimeout(() => {
    if (retryAt.get(key) !== at) return
    retryAt.delete(key)
    enrich(chain, address)
  }, RETRY_MS[n]).unref()
  if (attempts.size > 100_000) attempts.clear()
}

async function flush() {
  if (flushing) return
  flushing = true
  try {
    const budget = metadataRpcBudget()
    // While cooling down after a 429, pending mints simply wait their turn.
    if (pending.solana.size && config.solanaRpc && !metaRpc.coolingDown() && (budget.limit === 0 || budget.used < budget.limit)) {
      const batch = [...pending.solana].slice(0, 20)
      for (const m of batch) { pending.solana.delete(m); inflight.add(`solana:${m}`) }
      let got = new Map<string, TokenMeta>()
      if (config.solanaDasRpc) {
        try { got = await dasBatch(batch) } catch (e) { console.error('[meta] das', String(e).slice(0, 120)) }
      }
      const fallback = batch.filter(mint => !got.get(mint)?.symbol || !got.get(mint)?.image)
      let onchain = new Map<string, TokenMeta>()
      if (fallback.length) {
        try { onchain = await onchainSolanaBatch(fallback) }
        catch (e) { console.error('[meta] accounts', String(e).slice(0, 120)) }
      }
      const currentBudget = metadataRpcBudget()
      const budgetExhausted = currentBudget.limit > 0 && currentBudget.used >= currentBudget.limit
      for (const mint of batch) {
        const m = got.get(mint)
        const x = onchain.get(mint)
        // A daily budget boundary is not a metadata miss. Keep incomplete
        // mints pending for the next UTC day instead of marking them done.
        if (budgetExhausted && (!m?.symbol || !m?.image) && !x?.image) {
          inflight.delete(`solana:${mint}`)
          pending.solana.add(mint)
          continue
        }
        settle('solana', mint, { ...x, ...Object.fromEntries(Object.entries(m ?? {}).filter(([, v]) => v !== undefined)) })
      }
    }
    if (pending.robinhood.size && config.rhHttp) {
      const batch = [...pending.robinhood].slice(0, 25)
      for (const a of batch) pending.robinhood.delete(a)
      try { for (const [a, m] of await robinhoodMeta(batch)) settle('robinhood', a, m) }
      catch (e) { console.error('[meta] rh', String(e).slice(0, 120)); for (const a of batch) settle('robinhood', a, null) }
    }
  } finally { flushing = false }
}
setInterval(() => void flush(), 1000).unref()

// launches name themselves from their args; their image comes from the metadata uri
const uriQueue: { chain: Chain; token: string; uri: string }[] = []
let uriRunning = 0
bus.on('launchUri', (chain: Chain, token: string, uri: string) => { uriQueue.push({ chain, token, uri }); if (uriQueue.length > 5000) uriQueue.shift(); pumpUris() })
function pumpUris() {
  while (uriRunning < 12 && uriQueue.length) {
    const j = uriQueue.pop()!   // newest first: the feed shows the newest launches
    uriRunning++
    offchain(j.uri).then(m => { if (m.image || m.description) setTokenMeta(j.chain, j.token, m) }).finally(() => { uriRunning--; pumpUris() })
  }
}

for (const chain of Object.keys(QUOTES) as Chain[])
  for (const [address, q] of Object.entries(QUOTES[chain]))
    db.prepare('INSERT OR IGNORE INTO tokens (chain, address, symbol, name, decimals, meta_ts) VALUES (?,?,?,?,?,?)').run(chain, address, q.symbol, q.symbol, q.decimals, Date.now())
