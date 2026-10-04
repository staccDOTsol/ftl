// Token name / symbol / image. Solana: Token-2022 metadata extension, then the
// Metaplex metadata PDA, then the off-chain JSON for the image. Robinhood:
// ERC-20 name/symbol/decimals in one batch.

import crypto from 'node:crypto'
import bs58 from 'bs58'
import { ed25519 } from '@noble/curves/ed25519.js'
import { config } from './config.ts'
import { db } from './db.ts'
import { QUOTES, setTokenMeta } from './hub.ts'
import type { Chain } from '../../shared/types.ts'

const METAPLEX = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'

function onCurve(b: Uint8Array): boolean {
  try { ed25519.Point.fromBytes(b); return true } catch { return false }
}
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
function borshStr(b: Buffer, o: { i: number }): string {
  const n = b.readUInt32LE(o.i); o.i += 4
  const s = b.subarray(o.i, o.i + n).toString('utf8'); o.i += n
  return clean(s)
}

async function solRpc(method: string, params: unknown[]): Promise<any> {
  const r = await fetch(config.solanaRpc!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(8000) })
  const j = await r.json() as any
  return j.result
}

function ipfs(uri: string): string {
  if (uri.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + uri.slice(7)
  return uri
}

async function offchainImage(uri: string): Promise<string | undefined> {
  if (!/^(https?|ipfs):\/\//.test(uri)) return undefined
  try {
    const r = await fetch(ipfs(uri), { signal: AbortSignal.timeout(5000) })
    if (!r.ok) return undefined
    const ct = r.headers.get('content-type') ?? ''
    if (ct.startsWith('image/')) return ipfs(uri)
    const j = await r.json() as any
    return typeof j?.image === 'string' ? ipfs(j.image) : undefined
  } catch { return undefined }
}

async function solanaMeta(mint: string) {
  const [mintAcct, mdAcct] = await solRpc('getMultipleAccounts', [[mint, pda([Buffer.from('metadata'), bs58.decode(METAPLEX), bs58.decode(mint)], METAPLEX)], { encoding: 'base64' }]).then(r => r?.value ?? [])
  if (!mintAcct) return null
  const m = Buffer.from(mintAcct.data[0], 'base64')
  const decimals = m.length >= 45 ? m[44] : undefined
  let name: string | undefined, symbol: string | undefined, uri: string | undefined
  // Token-2022: TLV extensions after the 165-byte account + 1 type byte; TokenMetadata is type 19
  if (m.length > 166) {
    let o = 166
    while (o + 4 <= m.length) {
      const type = m.readUInt16LE(o), len = m.readUInt16LE(o + 2)
      if (type === 19) {
        const p = { i: o + 4 + 64 }
        name = borshStr(m, p); symbol = borshStr(m, p); uri = borshStr(m, p)
        break
      }
      if (type === 0 && len === 0) break
      o += 4 + len
    }
  }
  if (!name && mdAcct) {
    const d = Buffer.from(mdAcct.data[0], 'base64')
    const p = { i: 1 + 32 + 32 }
    name = borshStr(d, p); symbol = borshStr(d, p); uri = borshStr(d, p)
  }
  const image = uri ? await offchainImage(uri) : undefined
  return { name, symbol, image, decimals }
}

function abiString(hex: string | null): string | undefined {
  if (!hex || hex === '0x') return undefined
  const b = Buffer.from(hex.slice(2), 'hex')
  if (b.length >= 64) {
    const off = Number(b.readBigUInt64BE(24))
    const len = Number(b.readBigUInt64BE(off + 24))
    if (off + 32 + len <= b.length) return clean(b.subarray(off + 32, off + 32 + len).toString('utf8'))
  }
  return clean(b.toString('utf8')) || undefined   // bytes32-style names
}

async function robinhoodMeta(tokens: string[]) {
  const calls = tokens.flatMap(t => ['0x06fdde03', '0x95d89b41', '0x313ce567'].map((data, k) => ({ jsonrpc: '2.0', id: tokens.indexOf(t) * 3 + k, method: 'eth_call', params: [{ to: t, data }, 'latest'] })))
  const r = await fetch(config.rhHttp!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls), signal: AbortSignal.timeout(10_000) })
  const arr = await r.json() as any[]
  const by = new Map(arr.map(x => [x.id, x.result]))
  return tokens.map((t, i) => ({
    address: t,
    name: abiString(by.get(i * 3) ?? null),
    symbol: abiString(by.get(i * 3 + 1) ?? null),
    decimals: by.get(i * 3 + 2) && by.get(i * 3 + 2) !== '0x' ? Number(BigInt(by.get(i * 3 + 2))) : undefined,
  }))
}

// ---- queue ------------------------------------------------------------------

const queued = new Set<string>()
const queue: { chain: Chain; address: string }[] = []
let running = 0

export function enrich(chain: Chain, address: string, force = false) {
  const key = `${chain}:${address}`
  if (queued.has(key)) return
  if (QUOTES[chain][address]) return
  if (!force) {
    const row = db.prepare('SELECT meta_ts FROM tokens WHERE chain = ? AND address = ?').get(chain, address) as any
    if (row?.meta_ts) return
  }
  queued.add(key)
  queue.push({ chain, address })
  pump()
}

function pump() {
  while (running < 6 && queue.length) {
    // Robinhood batches; Solana goes one by one
    const head = queue[0]
    if (head.chain === 'robinhood') {
      const batch = queue.filter(q => q.chain === 'robinhood').slice(0, 30)
      for (const b of batch) queue.splice(queue.indexOf(b), 1)
      running++
      robinhoodMeta(batch.map(b => b.address))
        .then(rows => { for (const r of rows) setTokenMeta('robinhood', r.address, { name: r.name, symbol: r.symbol, decimals: r.decimals }) })
        .catch(() => {})
        .finally(() => { running--; for (const b of batch) queued.delete(`robinhood:${b.address}`); pump() })
    } else {
      queue.shift()
      running++
      solanaMeta(head.address)
        .then(m => { if (m) setTokenMeta('solana', head.address, m) })
        .catch(() => {})
        .finally(() => { running--; queued.delete(`solana:${head.address}`); pump() })
    }
  }
}

// quote assets never need a lookup
for (const chain of Object.keys(QUOTES) as Chain[])
  for (const [address, q] of Object.entries(QUOTES[chain]))
    db.prepare('INSERT OR IGNORE INTO tokens (chain, address, symbol, name, decimals, meta_ts) VALUES (?,?,?,?,?,?)').run(chain, address, q.symbol, q.symbol, q.decimals, Date.now())

export function canEnrich(chain: Chain) { return chain === 'solana' ? !!config.solanaRpc : !!config.rhHttp }
