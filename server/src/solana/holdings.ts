// "What can I do with what I'm holding": read one wallet's native SOL, SPL
// token accounts (Token and Token-2022) and liquidity positions, enrich with
// FTL's own token and pool knowledge, and rank concrete in-app next actions.
// The RPC URL is used only here on the server and never appears in a reply.
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PoolSummary, TokenSummary } from '../../../shared/types.ts'
import { validPublicKey } from './router.ts'

export const SOL_MINT = 'So11111111111111111111111111111111111111112'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const MAX_RESPONSE = 4_000_000
const MAX_ACTIONS = 40
const MAX_BUYS = 5
const MAX_POOLS_PER_MINT = 20
const BUY_MIN_LAMPORTS = 20_000_000n // 0.02 SOL
const RATE_CEILING = 30

export type TokenProgram = 'token' | 'token-2022'
export interface HoldingToken {
  account: string; mint: string; amount: string; decimals: number; program: TokenProgram; wrappedSol: boolean
  token: TokenSummary | null; pools: PoolSummary[]
}
export interface HoldingPosition {
  venue: string; pool: string; position: string; mintA: string; mintB: string
  liquidity?: string | null; removalMode?: 'percentage' | 'liquidity'
  amounts?: { mint: string; decimals: number; amount?: string; raw?: string }[]
}
export type ActionKind = 'exit' | 'unwrap' | 'sell' | 'add' | 'buy'
export interface HoldingAction { kind: ActionKind; title: string; detail: string; href: string }
export interface Holdings {
  owner: string
  sol: { lamports: string }
  tokens: HoldingToken[]
  positions: { positions: HoldingPosition[]; errors: { venue: string; error: string }[]; error?: string }
  actions: HoldingAction[]
}
export interface HoldingsCatalog {
  token: (mint: string) => TokenSummary | null
  pools: (mint: string, limit: number) => PoolSummary[]
  hot: (limit: number) => TokenSummary[]
}
type Options = {
  rpcUrl?: string
  catalog: HoldingsCatalog
  positions?: (owner: string) => Promise<unknown>
  fetch?: typeof fetch
  now?: () => number
}

class RequestError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status } }
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const integer = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(v)
function address(v: unknown): string { if (!validPublicKey(v)) throw new RequestError(400, 'Invalid Solana address'); return v as string }

// jsonParsed getTokenAccountsByOwner → nonzero token accounts. Malformed rows
// are skipped rather than failing the whole wallet.
export function parseTokenAccounts(value: unknown, program: TokenProgram): Omit<HoldingToken, 'token' | 'pools'>[] {
  if (!Array.isArray(value)) return []
  const out: Omit<HoldingToken, 'token' | 'pools'>[] = []
  for (const row of value) {
    if (!object(row) || !validPublicKey(row.pubkey)) continue
    const info = row.account?.data?.parsed?.info
    if (!object(info) || row.account?.data?.parsed?.type !== 'account' || !validPublicKey(info.mint) || !object(info.tokenAmount)) continue
    const amount = info.tokenAmount.amount, decimals = info.tokenAmount.decimals
    if (!integer(amount) || BigInt(amount) === 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) continue
    out.push({ account: row.pubkey, mint: info.mint, amount, decimals, program, wrappedSol: info.mint === SOL_MINT || info.isNative === true })
  }
  return out
}

export function parsePositions(data: unknown): { positions: HoldingPosition[]; errors: { venue: string; error: string }[] } {
  const positions: HoldingPosition[] = []
  const errors: { venue: string; error: string }[] = []
  if (!object(data)) return { positions, errors }
  if (Array.isArray(data.positions)) for (const p of data.positions) {
    if (!object(p) || typeof p.venue !== 'string' || !validPublicKey(p.pool) || !validPublicKey(p.position) || !validPublicKey(p.mintA) || !validPublicKey(p.mintB)) continue
    const position: HoldingPosition = { venue: p.venue.slice(0, 40), pool: p.pool, position: p.position, mintA: p.mintA, mintB: p.mintB }
    if (integer(p.liquidity)) position.liquidity = p.liquidity
    else if (p.liquidity === null) position.liquidity = null
    if (p.removalMode === 'percentage' || p.removalMode === 'liquidity') position.removalMode = p.removalMode
    if (Array.isArray(p.amounts)) position.amounts = p.amounts.flatMap((a: unknown) => object(a) && validPublicKey(a.mint) && Number.isInteger(a.decimals)
      ? [{ mint: a.mint, decimals: a.decimals, ...(integer(a.amount) ? { amount: a.amount } : {}), ...(integer(a.raw) ? { raw: a.raw } : {}) }] : [])
    positions.push(position)
  }
  if (Array.isArray(data.errors)) for (const e of data.errors) {
    if (!object(e) || typeof e.venue !== 'string') continue
    // Provider error strings may embed URLs; keep text, drop any endpoint.
    const error = typeof e.error === 'string' ? e.error.replace(/https?:\/\/[^\s]+/g, '[provider]').slice(0, 300) : 'Positions unavailable for this venue'
    errors.push({ venue: e.venue.slice(0, 40), error })
  }
  return { positions, errors }
}

const hasLiquidity = (p: HoldingPosition) => integer(p.liquidity ?? '') ? BigInt(p.liquidity!) > 0n
  : p.removalMode === 'percentage' || (p.amounts ?? []).some(a => (integer(a.raw) && BigInt(a.raw!) > 0n) || (integer(a.amount) && BigInt(a.amount!) > 0n))
const ui = (amount: string, decimals: number) => Number(amount) / 10 ** decimals
function uiText(amount: string, decimals: number): string {
  const value = BigInt(amount), scale = 10n ** BigInt(decimals)
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${value / scale}${fraction ? `.${fraction}` : ''}`
}
const shortMint = (mint: string) => mint === SOL_MINT ? 'SOL' : `${mint.slice(0, 4)}…${mint.slice(-4)}`
const nameOf = (mint: string, token: TokenSummary | null) => token?.symbol ? `$${token.symbol.slice(0, 14)}` : shortMint(mint)

// Exits first, then sells/adds (and unwrap) by held balance, then buys. Cap 40.
export function rankActions(input: { lamports: string; tokens: HoldingToken[]; positions: HoldingPosition[]; hot: TokenSummary[] }): HoldingAction[] {
  const actions: HoldingAction[] = []
  const seenExit = new Set<string>()
  for (const p of input.positions) {
    if (!hasLiquidity(p) || seenExit.has(p.position)) continue
    seenExit.add(p.position)
    const mint = p.mintA !== SOL_MINT ? p.mintA : p.mintB !== SOL_MINT ? p.mintB : p.mintA
    const token = input.tokens.find(t => t.mint === mint)?.token ?? null
    actions.push({ kind: 'exit', title: `Exit ${nameOf(mint, token)} liquidity on ${p.venue}`,
      detail: `${shortMint(p.mintA)} / ${shortMint(p.mintB)} · pool ${shortMint(p.pool)} · ${p.removalMode === 'percentage' ? 'bin position' : `${p.liquidity ?? 'unknown'} liquidity units`}`,
      href: `/token/solana/${mint}?action=exit` })
  }
  // One row per mint; several accounts of one mint are summed for ranking.
  const byMint = new Map<string, { mint: string; total: bigint; decimals: number; token: TokenSummary | null; pools: PoolSummary[]; wrappedSol: boolean }>()
  for (const t of input.tokens) {
    const row = byMint.get(t.mint) ?? { mint: t.mint, total: 0n, decimals: t.decimals, token: t.token, pools: t.pools, wrappedSol: t.wrappedSol }
    row.total += BigInt(t.amount)
    row.wrappedSol ||= t.wrappedSol
    byMint.set(t.mint, row)
  }
  const held = [...byMint.values()].sort((a, b) => ui(b.total.toString(), b.decimals) - ui(a.total.toString(), a.decimals))
  for (const h of held) {
    const balance = uiText(h.total.toString(), h.decimals)
    if (h.wrappedSol) {
      actions.push({ kind: 'unwrap', title: `Unwrap ${balance} wrapped SOL`, detail: 'This balance sits in a wrapped SOL token account. Closing it returns native SOL to your wallet for fees, rent and trades.', href: `/token/solana/${SOL_MINT}` })
      continue
    }
    if (!h.pools.length) continue
    const name = nameOf(h.mint, h.token), funded = h.pools.filter(p => p.funded)
    actions.push({ kind: 'sell', title: `Sell ${name}`, detail: `${balance} held · ${h.pools.length} FTL-known pool${h.pools.length === 1 ? '' : 's'}${funded.length ? ` (${funded.length} funded)` : ''}`, href: `/token/solana/${h.mint}?action=sell` })
    if (funded.length) actions.push({ kind: 'add', title: `Add ${name} liquidity`, detail: `${balance} held · ${funded.length} funded pool${funded.length === 1 ? '' : 's'} on ${[...new Set(funded.map(p => p.venue))].join(', ')}`, href: `/token/solana/${h.mint}?action=liquidity` })
  }
  if (BigInt(input.lamports) > BUY_MIN_LAMPORTS) {
    const sol = uiText(input.lamports, 9)
    let buys = 0
    for (const t of input.hot) {
      if (buys >= MAX_BUYS || t.chain !== 'solana' || byMint.has(t.address)) continue
      buys++
      actions.push({ kind: 'buy', title: `Buy ${nameOf(t.address, t)} with SOL`, detail: `${sol} SOL available · hot on FTL: ${t.pools} pool${t.pools === 1 ? '' : 's'}, ${t.fundedPools} funded, score ${Math.round(t.score)}`, href: `/token/solana/${t.address}` })
    }
  }
  return actions.slice(0, MAX_ACTIONS)
}

function reply(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(JSON.stringify(data))
}

export function createSolanaHoldingsHandler(options: Options) {
  const fetcher = options.fetch ?? fetch, now = options.now ?? Date.now
  const buckets = new Map<string, { until: number; count: number }>()
  function limit(key: string, ceiling: number) {
    const time = now(), b = buckets.get(key)
    if (b && b.until > time) { if (++b.count > ceiling) throw new RequestError(429, 'Holdings request limit reached; retry shortly'); return }
    if (buckets.size > 10_000) { for (const [k, v] of buckets) if (v.until <= time) buckets.delete(k); if (buckets.size > 10_000) throw new RequestError(429, 'Holdings request limit reached; retry shortly') }
    buckets.set(key, { until: time + 60_000, count: 1 })
  }
  // Every upstream failure collapses to a fixed message: provider errors can
  // carry the keyed endpoint and must never reach a client.
  async function rpc(method: string, params: unknown[]): Promise<any> {
    let r: Response
    try {
      r = await fetcher(options.rpcUrl!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), redirect: 'error', signal: AbortSignal.timeout(20_000) })
    } catch { throw new RequestError(503, 'Solana wallet reads are temporarily unavailable; retry shortly') }
    if (!r.ok) throw new RequestError(r.status === 429 ? 429 : 503, 'Solana wallet reads are temporarily unavailable; retry shortly')
    const reader = r.body?.getReader()
    if (!reader) throw new RequestError(502, 'Solana RPC returned an empty response')
    const chunks: Uint8Array[] = []; let size = 0
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_RESPONSE) { await reader.cancel(); throw new Error() } chunks.push(value) } } catch { throw new RequestError(502, 'Solana RPC returned an invalid response') }
    let data: any
    try { data = JSON.parse(Buffer.concat(chunks, size).toString()) } catch { throw new RequestError(502, 'Solana RPC returned invalid JSON') }
    if (!object(data) || data.jsonrpc !== '2.0' || data.error || !('result' in data)) throw new RequestError(502, 'Solana RPC request failed; retry shortly')
    return data.result
  }
  async function holdings(owner: string): Promise<Holdings> {
    const [balance, token, token2022, positionsResult] = await Promise.all([
      rpc('getBalance', [owner, { commitment: 'confirmed' }]),
      rpc('getTokenAccountsByOwner', [owner, { programId: TOKEN_PROGRAM }, { encoding: 'jsonParsed', commitment: 'confirmed' }]),
      rpc('getTokenAccountsByOwner', [owner, { programId: TOKEN_2022_PROGRAM }, { encoding: 'jsonParsed', commitment: 'confirmed' }]),
      options.positions ? Promise.resolve().then(() => options.positions!(owner)).then(data => ({ ok: true as const, data }))
        // Router errors are already client-safe (no endpoints); anything else collapses to a fixed message.
        .catch((e: unknown) => ({ ok: false as const, error: object(e) && Number.isInteger(e.status) && typeof e.message === 'string' ? e.message.slice(0, 300) : 'Liquidity positions are temporarily unavailable' })) : Promise.resolve(null),
    ])
    const lamports = object(balance) ? balance.value : balance
    if (!Number.isSafeInteger(lamports) || lamports < 0) throw new RequestError(502, 'Solana RPC returned an invalid balance')
    const tokens: HoldingToken[] = [...parseTokenAccounts(object(token) ? token.value : null, 'token'), ...parseTokenAccounts(object(token2022) ? token2022.value : null, 'token-2022')]
      .map(t => ({ ...t, token: t.wrappedSol ? null : options.catalog.token(t.mint), pools: t.wrappedSol ? [] : options.catalog.pools(t.mint, MAX_POOLS_PER_MINT) }))
    const positions = positionsResult === null ? { positions: [], errors: [], error: 'Liquidity positions are not configured on this server' }
      : positionsResult.ok ? parsePositions(positionsResult.data)
      : { positions: [], errors: [], error: positionsResult.error }
    const hot = BigInt(lamports) > BUY_MIN_LAMPORTS ? options.catalog.hot(MAX_BUYS * 3) : []
    return { owner, sol: { lamports: String(lamports) }, tokens, positions, actions: rankActions({ lamports: String(lamports), tokens, positions: positions.positions, hot }) }
  }
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const parts = url.pathname.split('/').filter(Boolean)
    if (req.method !== 'GET' || parts.length !== 4 || parts[0] !== 'api' || parts[1] !== 'holdings' || parts[2] !== 'solana') return false
    try {
      let raw = parts[3]
      try { raw = decodeURIComponent(raw) } catch { throw new RequestError(400, 'Invalid Solana address') }
      const owner = address(raw)
      if (!options.rpcUrl) throw new RequestError(503, 'Solana holdings are not configured on this server yet')
      const peer = String(req.headers['fly-client-ip'] ?? req.socket.remoteAddress ?? 'unknown').slice(0, 100)
      limit(`ip:${peer}`, RATE_CEILING); limit('global', RATE_CEILING * 20)
      reply(res, 200, await holdings(owner))
    } catch (e) {
      const status = e instanceof RequestError ? e.status : 503
      if (status === 429) res.setHeader('retry-after', '60')
      reply(res, status, { error: e instanceof RequestError ? e.message : 'Holdings are temporarily unavailable' })
    }
    return true
  }
}
