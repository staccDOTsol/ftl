// Token name / symbol / image / description.
//  Solana:    DAS getAssetBatch on the Triton RPC (100 mints a call), falling back to the
//             Token-2022 metadata extension / Metaplex PDA for anything DAS has not indexed.
//             Launches are named from their own instruction args before either answers.
//  Robinhood: name/symbol/decimals plus Pons getTokenInfo() (logo, description, socials), batched.

import crypto from 'node:crypto'
import bs58 from 'bs58'
import { ed25519 } from '@noble/curves/ed25519.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { config } from './config.ts'
import { db } from './db.ts'
import { QUOTES, bus, setTokenMeta } from './hub.ts'
import type { Chain, TokenMeta } from '../../shared/types.ts'

const METAPLEX = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'

// ipfs.io / dweb.link answer 429 under load; filebase serves the same CIDs fast
const GATEWAY = 'https://ipfs.filebase.io/ipfs/'
export function httpImage(uri: string | undefined | null): string | undefined {
  if (!uri) return undefined
  const u = uri.trim()
  if (u.startsWith('ipfs://')) return GATEWAY + u.slice(7).replace(/^ipfs\//, '')
  if (u.startsWith('ar://')) return 'https://arweave.net/' + u.slice(5)
  const path = u.match(/^https?:\/\/[^/]+\/ipfs\/(.+)$/)
  if (path && !/filebase/.test(u)) return GATEWAY + path[1]
  const sub = u.match(/^https?:\/\/([a-z0-9]{46,})\.ipfs\.[^/]+\/?(.*)$/)
  if (sub) return GATEWAY + sub[1] + (sub[2] ? '/' + sub[2] : '')
  if (/^https?:\/\//.test(u)) return u
  if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z2-7]{50,})/.test(u)) return GATEWAY + u
  return undefined
}

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

async function solRpc(method: string, params: unknown): Promise<any> {
  const r = await fetch(config.solanaRpc!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000) })
  const j = await r.json() as any
  if (j.error) throw new Error(j.error.message)
  return j.result
}

async function dasBatch(mints: string[]): Promise<Map<string, TokenMeta>> {
  const out = new Map<string, TokenMeta>()
  const res = await solRpc('getAssetBatch', { ids: mints })
  for (const a of res ?? []) {
    if (!a?.id) continue
    const md = a.content?.metadata ?? {}
    const image = httpImage(a.content?.links?.image ?? a.content?.files?.find((f: any) => /^image\//.test(f?.mime ?? ''))?.uri ?? a.content?.files?.[0]?.uri)
    out.set(a.id, {
      name: md.name || undefined, symbol: md.symbol || undefined, image,
      decimals: a.token_info?.decimals ?? undefined, description: md.description || undefined,
    })
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

async function onchainSolana(mint: string): Promise<TokenMeta | null> {
  const r = await solRpc('getMultipleAccounts', [[mint, pda([Buffer.from('metadata'), bs58.decode(METAPLEX), bs58.decode(mint)], METAPLEX)], { encoding: 'base64' }])
  const [mintAcct, mdAcct] = r?.value ?? []
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
const retried = new Set<string>()
let flushing = false

export function enrich(chain: Chain, address: string, force = false) {
  if (QUOTES[chain][address] || pending[chain].has(address)) return
  if (!force) {
    const row = db.prepare('SELECT meta_ts FROM tokens WHERE chain = ? AND address = ?').get(chain, address) as any
    if (row?.meta_ts) return
  }
  pending[chain].add(address)
}

async function flush() {
  if (flushing) return
  flushing = true
  try {
    if (pending.solana.size && config.solanaRpc) {
      const batch = [...pending.solana].slice(0, 100)
      for (const m of batch) pending.solana.delete(m)
      let got = new Map<string, TokenMeta>()
      try { got = await dasBatch(batch) } catch (e) { console.error('[meta] das', String(e).slice(0, 120)) }
      for (const mint of batch) {
        const m = got.get(mint)
        if (m && (m.name || m.symbol)) { setTokenMeta('solana', mint, m); continue }
        // brand-new mints take DAS a few seconds; one retry, then read the chain directly
        if (!retried.has(mint)) { retried.add(mint); setTimeout(() => pending.solana.add(mint), 4000); continue }
        onchainSolana(mint).then(x => { if (x) setTokenMeta('solana', mint, x) }).catch(() => {})
      }
      if (retried.size > 50_000) retried.clear()
    }
    if (pending.robinhood.size && config.rhHttp) {
      const batch = [...pending.robinhood].slice(0, 25)
      for (const a of batch) pending.robinhood.delete(a)
      try { for (const [a, m] of await robinhoodMeta(batch)) setTokenMeta('robinhood', a, m) } catch (e) { console.error('[meta] rh', String(e).slice(0, 120)) }
    }
  } finally { flushing = false }
}
setInterval(() => void flush(), 250).unref()

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
