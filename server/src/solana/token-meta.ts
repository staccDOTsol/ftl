// Token metadata for any Solana mint, on demand: FTL's own token row first,
// then one DAS getAsset through the configured DAS endpoint, then the mint
// account's decimals over the standard RPC. Results are cached for ten
// minutes; anything learned from DAS is written back to the tokens table so
// the feed, holdings and token pages name the token too. Neither endpoint URL
// ever appears in a reply: every upstream failure collapses to a fixed message.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TokenMeta, TokenSummary } from '../../../shared/types.ts'
import { validPublicKey } from './router.ts'

export type TokenProgram = 'token' | 'token-2022'
export type TokenMetaSource = 'ftl' | 'das' | 'chain'
export interface TokenMetaRecord {
  mint: string; symbol: string | null; name: string | null; image: string | null
  decimals: number | null; tokenProgram: TokenProgram | null; source: TokenMetaSource
}
export interface TokenMetaCatalog {
  token: (mint: string) => TokenSummary | null
  tokenProgram?: (mint: string) => string | null | undefined
  // Persist what DAS taught us (symbol, name, image, decimals), like meta.ts settle().
  learn?: (mint: string, meta: TokenMeta, complete: boolean) => void
}
type Options = { dasUrl?: string; rpcUrl?: string; catalog: TokenMetaCatalog; fetch?: typeof fetch; now?: () => number; ttlMs?: number }

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
export const MAX_BATCH = 50
const MAX_RESPONSE = 2_000_000
const MAX_CACHE = 20_000
const RATE_CEILING = 60
const TTL_MS = 10 * 60_000

class RequestError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status } }
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max: number) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined
const tokenProgramOf = (programId: unknown): TokenProgram | null => programId === TOKEN_PROGRAM_ID ? 'token' : programId === TOKEN_2022_PROGRAM_ID ? 'token-2022' : null

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

// One DAS asset (getAsset / getAssetBatch element) → FTL token meta. Shared
// with the background enrichment queue in meta.ts.
export function parseDasAsset(asset: unknown): { meta: TokenMeta; tokenProgram: string | null } | null {
  if (!object(asset) || typeof asset.id !== 'string') return null
  const md = object(asset.content?.metadata) ? asset.content.metadata : {}
  const files: any[] = Array.isArray(asset.content?.files) ? asset.content.files : []
  const image = httpImage(asset.content?.links?.image ?? files.find(f => /^image\//.test(f?.mime ?? ''))?.uri ?? files[0]?.uri)
  const decimals = asset.token_info?.decimals
  return {
    meta: { name: text(md.name, 64), symbol: text(md.symbol, 24), image, description: text(md.description, 400),
      decimals: Number.isInteger(decimals) && decimals >= 0 && decimals <= 18 ? decimals : undefined },
    tokenProgram: typeof asset.token_info?.token_program === 'string' ? asset.token_info.token_program : null,
  }
}

function reply(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': status === 200 ? 'public, max-age=60' : 'no-store', 'x-content-type-options': 'nosniff' }).end(JSON.stringify(data))
}

export function createTokenMetaHandler(options: Options) {
  const fetcher = options.fetch ?? fetch, now = options.now ?? Date.now, ttl = options.ttlMs ?? TTL_MS
  const cache = new Map<string, { until: number; record: TokenMetaRecord | null }>()
  const inflight = new Map<string, Promise<TokenMetaRecord | null>>()
  const buckets = new Map<string, { until: number; count: number }>()
  function limit(key: string, ceiling: number) {
    const time = now(), b = buckets.get(key)
    if (b && b.until > time) { if (++b.count > ceiling) throw new RequestError(429, 'Token metadata request limit reached; retry shortly'); return }
    if (buckets.size > 10_000) { for (const [k, v] of buckets) if (v.until <= time) buckets.delete(k); if (buckets.size > 10_000) throw new RequestError(429, 'Token metadata request limit reached; retry shortly') }
    buckets.set(key, { until: time + 60_000, count: 1 })
  }
  async function rpc(url: string, method: string, params: unknown, unavailable: string): Promise<any> {
    let r: Response
    try {
      r = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), redirect: 'error', signal: AbortSignal.timeout(12_000) })
    } catch { throw new RequestError(503, unavailable) }
    if (!r.ok) throw new RequestError(r.status === 429 ? 429 : 503, unavailable)
    const reader = r.body?.getReader()
    if (!reader) throw new RequestError(502, unavailable)
    const chunks: Uint8Array[] = []; let size = 0
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_RESPONSE) { await reader.cancel(); throw new Error() } chunks.push(value) } } catch { throw new RequestError(502, unavailable) }
    let data: any
    try { data = JSON.parse(Buffer.concat(chunks, size).toString()) } catch { throw new RequestError(502, unavailable) }
    if (!object(data) || data.jsonrpc !== '2.0' || data.error || !('result' in data)) throw new RequestError(502, unavailable)
    return data.result
  }

  function fromFtl(mint: string): TokenMetaRecord | null {
    const row = options.catalog.token(mint)
    if (!row?.symbol) return null
    return { mint, symbol: row.symbol, name: row.name ?? null, image: row.image ?? null, decimals: row.decimals ?? null,
      tokenProgram: tokenProgramOf(options.catalog.tokenProgram?.(mint)), source: 'ftl' }
  }
  async function fromDas(mint: string): Promise<TokenMetaRecord | null> {
    if (!options.dasUrl) return null
    const asset = await rpc(options.dasUrl, 'getAsset', { id: mint, displayOptions: { showFungible: true } }, 'Token metadata is temporarily unavailable; retry shortly')
    const parsed = parseDasAsset(asset)
    if (!parsed || parsed.meta.symbol === undefined && parsed.meta.name === undefined && parsed.meta.image === undefined) return null
    const { meta } = parsed
    options.catalog.learn?.(mint, meta, !!(meta.symbol && meta.image))
    const known = options.catalog.token(mint)
    return { mint, symbol: meta.symbol ?? null, name: meta.name ?? null, image: meta.image ?? null,
      decimals: meta.decimals ?? known?.decimals ?? null, tokenProgram: tokenProgramOf(parsed.tokenProgram), source: 'das' }
  }
  async function fromChain(mint: string): Promise<TokenMetaRecord | null> {
    if (!options.rpcUrl) return null
    const result = await rpc(options.rpcUrl, 'getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }], 'Solana RPC is temporarily unavailable; retry shortly')
    const account = object(result) ? result.value : null
    const program = tokenProgramOf(account?.owner)
    const decimals = account?.data?.parsed?.info?.decimals
    if (!program || account?.data?.parsed?.type !== 'mint' || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null
    const known = options.catalog.token(mint)
    return { mint, symbol: null, name: known?.name ?? null, image: known?.image ?? null, decimals, tokenProgram: program, source: 'chain' }
  }
  async function resolve(mint: string): Promise<TokenMetaRecord | null> {
    const ftl = fromFtl(mint)
    if (ftl) return ftl
    let das: TokenMetaRecord | null = null, dasError: unknown = null
    try { das = await fromDas(mint) } catch (e) { dasError = e }
    if (das) return das
    try {
      const chain = await fromChain(mint)
      if (chain || !dasError) return chain
    } catch (e) { if (!dasError) throw e }
    throw dasError
  }
  // Ten-minute memo, shared across single and batch calls; misses are memoised too.
  function lookup(mint: string): Promise<TokenMetaRecord | null> {
    const time = now(), hit = cache.get(mint)
    if (hit && hit.until > time) return Promise.resolve(hit.record)
    const running = inflight.get(mint)
    if (running) return running
    const task = resolve(mint).then(record => {
      if (cache.size >= MAX_CACHE) { for (const [k, v] of cache) if (v.until <= time) cache.delete(k); if (cache.size >= MAX_CACHE) cache.clear() }
      cache.set(mint, { until: now() + ttl, record })
      return record
    }).finally(() => inflight.delete(mint))
    inflight.set(mint, task)
    return task
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const parts = url.pathname.split('/').filter(Boolean)
    if (req.method !== 'GET' || parts[0] !== 'api' || parts[1] !== 'meta' || parts[2] !== 'solana' || parts.length > 4) return false
    try {
      const peer = String(req.headers['fly-client-ip'] ?? req.socket.remoteAddress ?? 'unknown').slice(0, 100)
      limit(`ip:${peer}`, RATE_CEILING); limit('global', RATE_CEILING * 20)
      if (parts.length === 4) {
        let raw = parts[3]
        try { raw = decodeURIComponent(raw) } catch { throw new RequestError(400, 'Invalid Solana address') }
        if (!validPublicKey(raw)) throw new RequestError(400, 'Invalid Solana address')
        const record = await lookup(raw)
        if (!record) throw new RequestError(404, 'This address is not a token mint')
        reply(res, 200, record)
        return true
      }
      const mints = [...new Set((url.searchParams.get('mints') ?? '').split(',').map(s => s.trim()).filter(Boolean))]
      if (!mints.length) throw new RequestError(400, 'mints is required: a comma-separated list of Solana mint addresses')
      if (mints.length > MAX_BATCH) throw new RequestError(400, `At most ${MAX_BATCH} mints per request`)
      if (mints.some(mint => !validPublicKey(mint))) throw new RequestError(400, 'Invalid Solana address')
      const records = await Promise.all(mints.map(mint => lookup(mint).catch(() => null)))
      reply(res, 200, { tokens: records.filter((record): record is TokenMetaRecord => !!record) })
    } catch (e) {
      const status = e instanceof RequestError ? e.status : 503
      if (status === 429) res.setHeader('retry-after', '60')
      reply(res, status, { error: e instanceof RequestError ? e.message : 'Token metadata is temporarily unavailable' })
    }
    return true
  }
  return Object.assign(handle, { lookup })
}
