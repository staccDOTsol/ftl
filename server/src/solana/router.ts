// Public, bounded trading transport. The browser signs; this service never holds
// a wallet key. Client-supplied route instructions are never used to build swaps.
import type { IncomingMessage, ServerResponse } from 'node:http'
import bs58 from 'bs58'
import nacl from 'tweetnacl'
import { decodeV1 } from './transaction-v1.ts'
import type { DirectSolanaRouter, LocalIntent } from './self-router.ts'
import { RATE_LIMITED_MESSAGE, RATE_LIMITED_RETRY_AFTER_S } from './rpc-resilience.ts'

const U64_MAX = (1n << 64n) - 1n
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'])
const MAX_RESPONSE = 2_000_000
const METHODS = new Set(['getAccountInfo', 'getBalance', 'getTokenAccountsByOwner', 'getSignatureStatuses', 'getBlockHeight', 'getLatestBlockhash', 'getFeeForMessage', 'simulateTransaction', 'sendTransaction'])
type Options = { routerUrl?: string; rpcUrl?: string; selfRouter?: boolean;
  /** RPC endpoint for the direct router's pool reads; falls back to rpcUrl. */
  quoteRpcUrl?: string;
  /** lp-zap composer program id; enables composed multi-hop direct routes. */
  composerProgramId?: string;
  localRouter?: Pick<DirectSolanaRouter, 'quote' | 'swap'>; fetch?: typeof fetch; now?: () => number }
class RequestError extends Error {
  status: number; retryAfter: number | undefined
  constructor(status: number, message: string, retryAfter?: number) { super(message); this.status = status; this.retryAfter = retryAfter }
}
const fail = (message: string): never => { throw new RequestError(400, message) }
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
export function validPublicKey(v: unknown): v is string {
  if (typeof v !== 'string' || v.length < 32 || v.length > 44) return false
  try { return bs58.decode(v).length === 32 } catch { return false }
}
function address(v: unknown): string { if (!validPublicKey(v)) fail('Invalid Solana address'); return v as string }
function amount(v: unknown): string {
  if (typeof v !== 'string' || !/^[1-9][0-9]{0,19}$/.test(v) || BigInt(v) > U64_MAX) fail('Amount must be a positive integer in token base units')
  return v as string
}
function config(v: unknown, allowed: string[]): Record<string, any> {
  if (v === undefined) return {}
  if (!object(v) || Object.keys(v).some(k => !allowed.includes(k))) fail('Unsupported RPC options')
  if (v.commitment !== undefined && !['processed', 'confirmed', 'finalized'].includes(v.commitment)) fail('Invalid commitment')
  if (v.minContextSlot !== undefined && (!Number.isSafeInteger(v.minContextSlot) || v.minContextSlot < 0)) fail('Invalid context slot')
  return v
}
function signature(v: unknown): string {
  if (typeof v !== 'string' || v.length > 90) fail('Invalid transaction signature')
  try { if (bs58.decode(v as string).length !== 64) fail('Invalid transaction signature') } catch { fail('Invalid transaction signature') }
  return v as string
}
function shortvec(bytes: Buffer, cursor: { i: number }): number {
  let n = 0
  for (let shift = 0; shift < 21; shift += 7) {
    if (cursor.i >= bytes.length) fail('Invalid transaction encoding')
    const b = bytes[cursor.i++]
    n |= (b & 127) << shift
    if (!(b & 128)) return n
  }
  return fail('Invalid transaction encoding')
}
// SIMD-0385: V1 is identified at transaction byte zero and signs the entire
// prefix through the last instruction payload. Its signatures are at the tail.
// https://solana.com/docs/core/transactions/versioned-transactions
function v1Layout(bytes: Buffer, withSignatures: boolean, signed = false) {
  let decoded: ReturnType<typeof decodeV1>
  try { decoded = decodeV1(bytes, { messageOnly: !withSignatures, requireResources: true }) } catch (e) { return fail(e instanceof Error ? e.message : 'Invalid V1 transaction') }
  if (signed) for (let i = 0; i < decoded.required; i++) {
    if (!nacl.sign.detached.verify(decoded.message, decoded.signatures[i], decoded.keys[i])) fail('Transaction requires valid wallet signatures')
  }
  return { messageEnd: decoded.messageEnd, required: decoded.required }
}
function wireBase64(v: unknown, label: string): Buffer {
  if (typeof v !== 'string') fail(`Expected a base64 Solana ${label}`)
  if (v.length > 5464) fail(`${label} exceeds 4096 bytes`)
  if (!B64.test(v)) fail(`Expected a base64 Solana ${label}`)
  const bytes = Buffer.from(v as string, 'base64')
  if (!bytes.length || bytes.length > 4096 || bytes.toString('base64') !== v) fail(`Invalid ${label} size or encoding`)
  return bytes
}
export function transactionVersion(v: unknown): '1' | '0' | 'legacy' {
  const bytes = wireBase64(v, 'transaction')
  if (bytes[0] === 0x81) return '1'
  const cursor = { i: 0 }, count = shortvec(bytes, cursor)
  return bytes[cursor.i + count * 64] === 0x80 ? '0' : 'legacy'
}
export function transaction(v: unknown, signed: boolean): string {
  const bytes = wireBase64(v, 'transaction')
  if (bytes[0] === 0x81) { v1Layout(bytes, true, signed); return v as string }
  if (bytes.length < 100 || bytes.length > 1232) fail('Legacy and V0 transactions must fit in 1232 bytes')
  if (bytes[0] & 128) fail('Unsupported transaction version')
  const c = { i: 0 }, count = shortvec(bytes, c), signaturesAt = c.i
  if (count < 1 || count > 16) fail('Invalid transaction signer count')
  c.i += count * 64
  const messageAt = c.i
  if (messageAt + 3 >= bytes.length) fail('Invalid transaction message')
  if (bytes[c.i] & 128) { if (bytes[c.i++] !== 128) fail('Unsupported transaction version') }
  const required = bytes[c.i], readonlySigned = bytes[c.i + 1], readonlyUnsigned = bytes[c.i + 2]
  c.i += 3
  const keyCount = shortvec(bytes, c)
  if (required !== count || readonlySigned >= count || keyCount < count + readonlyUnsigned || keyCount > 256 || c.i + keyCount * 32 + 32 >= bytes.length) fail('Invalid transaction accounts')
  if (signed) for (let i = 0; i < count; i++) {
    if (!nacl.sign.detached.verify(bytes.subarray(messageAt), bytes.subarray(signaturesAt + i * 64, signaturesAt + (i + 1) * 64), bytes.subarray(c.i + i * 32, c.i + (i + 1) * 32))) fail('Transaction requires valid wallet signatures')
  }
  return v as string
}
export function validateRpc(body: unknown): { jsonrpc: '2.0'; id: string | number | null; method: string; params: unknown[] } {
  if (!object(body) || body.jsonrpc !== '2.0' || !METHODS.has(body.method)) fail('Unsupported Solana RPC method')
  if (body.id !== null && typeof body.id !== 'string' && !Number.isSafeInteger(body.id)) fail('Invalid RPC id')
  if (typeof body.id === 'string' && body.id.length > 80) fail('Invalid RPC id')
  const p = body.params ?? [], method = body.method as string
  if (!Array.isArray(p)) fail('RPC params must be an array')
  let params: unknown[]
  if (method === 'getBalance' || method === 'getAccountInfo') {
    if (p.length < 1 || p.length > 2) fail('Invalid RPC params')
    const c = config(p[1], ['commitment', 'minContextSlot', ...(method === 'getAccountInfo' ? ['encoding'] : [])])
    if (c.encoding !== undefined && !['base64', 'jsonParsed'].includes(c.encoding)) fail('Unsupported account encoding')
    params = [address(p[0]), { ...c, commitment: c.commitment ?? 'confirmed', ...(method === 'getAccountInfo' ? { encoding: c.encoding ?? 'jsonParsed' } : {}) }]
  } else if (method === 'getTokenAccountsByOwner') {
    if (p.length < 2 || p.length > 3 || !object(p[1]) || Object.keys(p[1]).length !== 1) fail('A mint or token program filter is required')
    const f = p[1]
    if (f.mint !== undefined) address(f.mint)
    else if (!TOKEN_PROGRAMS.has(f.programId)) fail('Unsupported token program')
    const c = config(p[2], ['commitment', 'minContextSlot', 'encoding'])
    if (c.encoding !== undefined && c.encoding !== 'jsonParsed') fail('Use jsonParsed token account encoding')
    params = [address(p[0]), f, { ...c, encoding: 'jsonParsed', commitment: c.commitment ?? 'confirmed' }]
  } else if (method === 'getSignatureStatuses') {
    if (p.length < 1 || p.length > 2 || !Array.isArray(p[0]) || p[0].length < 1 || p[0].length > 8) fail('Provide 1–8 transaction signatures')
    const c = config(p[1], ['searchTransactionHistory'])
    if (c.searchTransactionHistory !== undefined && typeof c.searchTransactionHistory !== 'boolean') fail('Invalid history option')
    params = [p[0].map(signature), { searchTransactionHistory: c.searchTransactionHistory ?? false }]
  } else if (method === 'getFeeForMessage') {
    if (p.length < 1 || p.length > 2) fail('Expected a base64 transaction message')
    const message = wireBase64(p[0], 'transaction message')
    if (message[0] === 0x81) v1Layout(message, false)
    else {
      if (message.length < 38 || message.length > 1232) fail('Invalid transaction message')
      const versioned = !!(message[0] & 128)
      if (versioned && message[0] !== 128) fail('Unsupported transaction version')
      const count = message[versioned ? 1 : 0]
      transaction(Buffer.concat([Buffer.from([count]), Buffer.alloc(count * 64), message]).toString('base64'), false)
    }
    const c = config(p[1], ['commitment', 'minContextSlot'])
    params = [p[0], { ...c, commitment: c.commitment ?? 'confirmed' }]
  } else if (method === 'getBlockHeight' || method === 'getLatestBlockhash') {
    if (p.length > 1) fail('Invalid RPC params')
    const c = config(p[0], ['commitment', 'minContextSlot'])
    params = [{ ...c, commitment: c.commitment ?? 'confirmed' }]
  } else {
    if (p.length < 1 || p.length > 2) fail('Invalid RPC params')
    const send = method === 'sendTransaction'
    const c = config(p[1], send ? ['encoding', 'skipPreflight', 'preflightCommitment', 'maxRetries', 'minContextSlot'] : ['encoding', 'sigVerify', 'replaceRecentBlockhash', 'commitment', 'minContextSlot'])
    if (c.encoding !== undefined && c.encoding !== 'base64') fail('Use base64 transaction encoding')
    if (send) {
      if (c.skipPreflight === true) fail('Preflight cannot be skipped')
      if (c.preflightCommitment !== undefined && !['confirmed', 'finalized'].includes(c.preflightCommitment)) fail('Invalid preflight commitment')
      if (c.maxRetries !== undefined && (!Number.isInteger(c.maxRetries) || c.maxRetries < 0 || c.maxRetries > 3)) fail('Invalid retry limit')
      params = [transaction(p[0], true), { ...c, encoding: 'base64', skipPreflight: false, preflightCommitment: c.preflightCommitment ?? 'confirmed', maxRetries: c.maxRetries ?? 2 }]
    } else {
      if (c.sigVerify !== undefined && c.sigVerify !== false) fail('Unsigned simulation requires sigVerify=false')
      if (c.replaceRecentBlockhash !== undefined && c.replaceRecentBlockhash !== true) fail('Simulation requires a current blockhash')
      params = [transaction(p[0], false), { ...c, encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: c.commitment ?? 'confirmed' }]
    }
  }
  return { jsonrpc: '2.0', id: body.id, method, params }
}
function quoteParams(q: URLSearchParams): URLSearchParams {
  const inputMint = address(q.get('inputMint')), outputMint = address(q.get('outputMint'))
  if (inputMint === outputMint) fail('Choose two different tokens')
  const slippage = q.get('slippageBps') ?? '100'
  if (!/^\d{1,4}$/.test(slippage) || Number(slippage) > 1000) fail('Slippage must be between 0 and 1000 basis points')
  if (q.get('swapMode') && q.get('swapMode') !== 'ExactIn') fail('Only ExactIn routes are supported')
  const version = q.get('transactionVersion') ?? '1'
  if (version !== '1' && version !== '0') fail('transactionVersion must be 1 or 0')
  return new URLSearchParams({ inputMint, outputMint, amount: amount(q.get('amount')), slippageBps: String(Number(slippage)), swapMode: 'ExactIn', transactionVersion: version })
}
function publicQuote(data: any, q: URLSearchParams) {
  if (!object(data) || data.inputMint !== q.get('inputMint') || data.outputMint !== q.get('outputMint') || data.inAmount !== q.get('amount') || data.swapMode !== 'ExactIn' || data.slippageBps !== Number(q.get('slippageBps')) || !Array.isArray(data.routePlan) || data.routePlan.length < 1 || data.routePlan.length > 16) throw new RequestError(502, 'Router returned an invalid quote')
  amount(data.outAmount)
  amount(data.otherAmountThreshold)
  if (BigInt(data.otherAmountThreshold) > BigInt(data.outAmount)) throw new RequestError(502, 'Router returned an invalid minimum received')
  const { accounts: _accounts, ...safe } = data
  return { ...safe, transactionVersion: q.get('transactionVersion') }
}
const LP_VENUES = new Set(['raydium-cpmm','raydium-clmm','raydium-amm','raydium-amm-v4','orca','meteora-dlmm','meteora-damm','meteora-damm-v2','pumpswap'])
export function validateLiquidityRequest(value: unknown, build = false): Record<string, any> {
  if (!object(value)) fail('Invalid liquidity request')
  const owner = address(value.owner), transactionVersion = value.transactionVersion ?? '1'
  if (!['1','0'].includes(transactionVersion)) fail('transactionVersion must be 1 or 0')
  if (build) {
    if (typeof value.quoteId !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.quoteId)) fail('Invalid liquidity quote ID')
    return { owner, transactionVersion, quoteId: value.quoteId }
  }
  if (!LP_VENUES.has(value.venue) || !['initialize','add','remove'].includes(value.operation)) fail('Invalid liquidity venue or operation')
  if (!Number.isInteger(value.slippageBps) || value.slippageBps < 0 || value.slippageBps > 1000) fail('Slippage must be 0–1000 basis points')
  const safe: Record<string, any> = { owner, transactionVersion, venue:value.venue === 'raydium-amm' ? 'raydium-amm-v4' : value.venue, operation:value.operation, slippageBps:value.slippageBps }
  for (const k of ['pool','mintA','mintB','position']) if (value[k] !== undefined) safe[k] = address(value[k])
  for (const k of ['amountA','amountB','liquidity']) if (value[k] !== undefined) {
    const v = value[k]
    if (typeof v !== 'string' || !/^(0|[1-9][0-9]{0,38})$/.test(v) || BigInt(v) >= 1n << 128n || (k === 'liquidity' && v === '0')) fail('Liquidity amounts must use atomic integer strings')
    safe[k] = v
  }
  if (value.parameters !== undefined) {
    if (!object(value.parameters) || Object.keys(value.parameters).length > 20) fail('Invalid liquidity parameters')
    for (const [key,v] of Object.entries(value.parameters)) {
      if (!/^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(key) || !['string','number','boolean'].includes(typeof v) || (typeof v === 'string' && v.length > 128) || (typeof v === 'number' && !Number.isFinite(v))) fail('Invalid liquidity parameter')
    }
    safe.parameters = value.parameters
  }
  return safe
}
function liquiditySigners(wire: string): string[] {
  const bytes = Buffer.from(wire,'base64')
  if (bytes[0] === 0x81) { const decoded = decodeV1(bytes, { requireResources:true }); return decoded.keys.slice(0,decoded.required).map(k=>bs58.encode(k)) }
  const c={i:0},n=shortvec(bytes,c); c.i+=n*64
  if (bytes[c.i]===0x80) c.i++
  const required=bytes[c.i]; c.i+=3;shortvec(bytes,c)
  return Array.from({length:required},(_,i)=>bs58.encode(bytes.subarray(c.i+i*32,c.i+(i+1)*32)))
}
function validateLiquidityBuild(data:any, intent:Record<string,any>) {
  if (!object(data) || !Array.isArray(data.transactions) || !data.transactions.length || data.transactions.length>16 || !object(data.quote) || data.quote.quoteId!==intent.quoteId || data.quote.owner!==intent.owner || data.quote.transactionVersion!==intent.transactionVersion) throw new RequestError(502,'Liquidity service returned a different operation')
  address(data.pool)
  for (const tx of data.transactions) {
    if (!object(tx) || !Number.isSafeInteger(tx.lastValidBlockHeight) || tx.lastValidBlockHeight<=0) throw new RequestError(502,'Invalid liquidity transaction expiry')
    transaction(tx.transaction,false)
    const signers=liquiditySigners(tx.transaction)
    if (tx.transactionVersion!==intent.transactionVersion || transactionVersion(tx.transaction)!==intent.transactionVersion || signers[0]!==intent.owner || JSON.stringify(tx.expectedSigners)!==JSON.stringify(signers)) throw new RequestError(502,'Liquidity service returned unexpected transaction signers or version')
  }
  return data
}
/** The direct router's own RPC-unavailable failure (DirectRouteError, checked
 * structurally so this module never loads the venue SDKs eagerly). */
const directTransient = (e: unknown) => object(e) && e.transient === true && e.status === 503
/** External router failures that say nothing about route existence. */
const externalTransient = (e: unknown) => e instanceof RequestError && (e.status === 429 || e.status === 503)
function reply(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(JSON.stringify(data))
}
export function createSolanaRouterHandler(options: Options) {
  const fetcher = options.fetch ?? fetch, now = options.now ?? Date.now
  const quoteRpcUrl = options.quoteRpcUrl ?? options.rpcUrl
  const directEnabled = !!options.localRouter || (!!options.selfRouter && !!quoteRpcUrl)
  let directPromise: Promise<Pick<DirectSolanaRouter, 'quote' | 'swap'>> | null = null
  async function direct() {
    if (options.localRouter) return options.localRouter
    if (!quoteRpcUrl) throw new RequestError(503, 'Solana trading RPC is not configured')
    directPromise ??= import('./self-router.ts').then(module => new module.DirectSolanaRouter(quoteRpcUrl, { composerProgramId: options.composerProgramId }))
    return directPromise
  }
  function localIntent(q: URLSearchParams): LocalIntent {
    return { inputMint: q.get('inputMint')!, outputMint: q.get('outputMint')!,
      amount: q.get('amount')!, slippageBps: Number(q.get('slippageBps')),
      transactionVersion: q.get('transactionVersion') as '0' | '1' }
  }
  const buckets = new Map<string, { until: number; count: number }>()
  let inflight = 0
  function limit(key: string, ceiling: number) {
    const time = now(), b = buckets.get(key)
    if (b && b.until > time) { if (++b.count > ceiling) throw new RequestError(429, 'Trading request limit reached; retry shortly'); return }
    if (buckets.size > 10_000) { for (const [k, v] of buckets) if (v.until <= time) buckets.delete(k); if (buckets.size > 10_000) throw new RequestError(429, 'Trading request limit reached; retry shortly') }
    buckets.set(key, { until: time + 60_000, count: 1 })
  }
  async function upstream(url: string, init: RequestInit, timeout: number, liquidity = false): Promise<any> {
    let r: Response
    try { r = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeout) }) } catch { throw new RequestError(503, 'Trading service is temporarily unavailable; retry shortly') }
    if (!r.ok && !liquidity) throw new RequestError(r.status === 429 ? 429 : r.status === 404 ? 404 : 503, r.status === 404 ? 'No executable route is available for this pair and amount' : 'Trading service could not complete this request; refresh the quote')
    const reader = r.body?.getReader()
    if (!reader) throw new RequestError(502, 'Trading service returned an empty response')
    const chunks: Uint8Array[] = []; let size = 0
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_RESPONSE) { await reader.cancel(); throw new Error() } chunks.push(value) } } catch { throw new RequestError(502, 'Trading service returned an invalid response') }
    let data: any
    try { data = JSON.parse(Buffer.concat(chunks,size).toString()) } catch { throw new RequestError(502,'Trading service returned invalid JSON') }
    if (!r.ok) {
      const error = typeof data?.message==='string' ? data.message.replace(/https?:\/\/[^\s]+/g,'[provider]').slice(0,500) : 'Liquidity operation could not be prepared; refresh the quote'
      throw new RequestError(r.status===429?429:409,error)
    }
    return data
  }
  function router(path: string): string {
    if (!options.routerUrl) throw new RequestError(503, 'Solana trading is not configured yet')
    const u = new URL(options.routerUrl)
    if (!['http:', 'https:'].includes(u.protocol)) throw new RequestError(503, 'Solana trading is not configured correctly')
    u.pathname = u.pathname.replace(/\/$/, '') + path
    return u.toString()
  }
  const externalEnabled = !!options.routerUrl
  // Best execution across both route sources. The direct venue router knows
  // FTL-observed young pools immediately; the external router covers deep
  // established markets. Either may lack a pair; whichever quotes more output
  // wins, and the swap is built from that same source.
  async function bestQuote(q: URLSearchParams): Promise<{ quote: any; source: 'direct' | 'external' }> {
    const attempts: Promise<{ quote: any; source: 'direct' | 'external' }>[] = []
    if (directEnabled) attempts.push(direct().then(async r => ({ quote: publicQuote((await r.quote(localIntent(q))).quote, q), source: 'direct' as const })))
    if (externalEnabled) attempts.push(upstream(`${router('/quote')}?${q}`, {}, directEnabled ? 12_000 : 25_000).then(data => ({ quote: publicQuote(data, q), source: 'external' as const })))
    if (!attempts.length) throw new RequestError(503, 'Solana trading is not configured yet')
    const settled = await Promise.allSettled(attempts)
    const winners = settled.flatMap(r => r.status === 'fulfilled' ? [r.value] : []).sort((a, b) => BigInt(a.quote.outAmount) < BigInt(b.quote.outAmount) ? 1 : BigInt(a.quote.outAmount) > BigInt(b.quote.outAmount) ? -1 : 0)
    if (!winners.length) {
      const reasons = settled.map(r => (r as PromiseRejectedResult).reason)
      // Rate-limited only when the direct router could not read its candidate
      // pools AND the external router (when configured) also failed transiently.
      if (directEnabled && directTransient(reasons[0]) && (!externalEnabled || externalTransient(reasons[1])))
        throw new RequestError(503, RATE_LIMITED_MESSAGE, RATE_LIMITED_RETRY_AFTER_S)
      throw reasons[0] instanceof RequestError ? reasons[0] : new RequestError(404, 'No executable route is available for this pair and amount')
    }
    return winners[0]
  }
  async function getQuote(q: URLSearchParams) { return (await bestQuote(q)).quote }
  // All-venue positions for one owner over the same bounded transport. Used by
  // the holdings endpoint; errors carry the RequestError status, never a URL.
  const positions = (owner: string) => upstream(`${router('/liquidity/positions')}?${new URLSearchParams({ owner: address(owner) })}`, {}, 65_000, true)
  // Positions narrowed to one venue and pool (venues that only list LP holdings per pool).
  function liquidityPositions(params: { owner: string; venue?: string; pool?: string }) {
    const q = new URLSearchParams({ owner: address(params.owner) })
    if (params.pool !== undefined) q.set('pool', address(params.pool))
    if (params.venue !== undefined) { if (!LP_VENUES.has(params.venue)) fail('Invalid liquidity venue'); q.set('venue', params.venue === 'raydium-amm' ? 'raydium-amm-v4' : params.venue) }
    return upstream(`${router('/liquidity/positions')}?${q}`, {}, 65_000, true)
  }
  // Validated liquidity quote / build round trips; shared with the zap planner.
  async function liquidityQuote(value: unknown): Promise<any> {
    const intent = validateLiquidityRequest(value)
    const data = await upstream(router('/liquidity/quote'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(intent) }, 65_000, true)
    if (!object(data) || data.owner !== intent.owner || data.venue !== intent.venue || data.operation !== intent.operation || !Array.isArray(data.amounts) || !Number.isSafeInteger(data.expiresAt) || typeof data.quoteId !== 'string') throw new RequestError(502, 'Liquidity service returned a different quote')
    return data
  }
  async function liquidityBuild(value: unknown): Promise<any> {
    const intent = validateLiquidityRequest(value, true)
    const data = await upstream(router('/liquidity/build'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(intent) }, 65_000, true)
    return validateLiquidityBuild(data, intent)
  }
  // POST /api/swap/solana body → built swap. Only the user's trade intent and
  // minimum survive; route plans, accounts, destination overrides and fee
  // recipients supplied by clients do not.
  async function buildSwap(j: any): Promise<any> {
    if (!object(j) || !object(j.quoteResponse) || (j.wrapAndUnwrapSol !== undefined && j.wrapAndUnwrapSol !== true)) fail('Invalid swap request')
    const requestedVersion = j.transactionVersion === undefined ? '1' : String(j.transactionVersion)
    if (requestedVersion !== '1' && requestedVersion !== '0') fail('transactionVersion must be 1 or 0')
    const wallet = address(j.userPublicKey), old = j.quoteResponse
    const q = quoteParams(new URLSearchParams({ inputMint: old.inputMint, outputMint: old.outputMint, amount: old.inAmount, slippageBps: String(old.slippageBps), swapMode: old.swapMode, transactionVersion: requestedVersion }))
    const minimum = amount(old.otherAmountThreshold)
    let fresh: any, data: any, fromDirect = false
    // Build on the direct router and quote the external router in parallel;
    // the external route wins only when it returns strictly more output.
    const [builtDirect, external] = await Promise.allSettled([
      directEnabled ? direct().then(r => r.swap(localIntent(q), wallet, minimum)) : Promise.reject(new RequestError(503, 'Direct routing is not configured')),
      externalEnabled ? upstream(`${router('/quote')}?${q}`, {}, directEnabled ? 12_000 : 25_000).then(d => publicQuote(d, q)) : Promise.reject(new RequestError(503, 'Solana trading is not configured yet')),
    ])
    const directOut = builtDirect.status === 'fulfilled' ? BigInt(publicQuote(builtDirect.value.quoteResponse, q).outAmount) : null
    const externalOut = external.status === 'fulfilled' ? BigInt(external.value.outAmount) : null
    if (directOut === null && externalOut === null) throw builtDirect.reason instanceof RequestError ? builtDirect.reason : external.reason instanceof RequestError ? external.reason : new RequestError(404, 'No executable route is available for this pair and amount')
    if (directOut !== null && (externalOut === null || directOut >= externalOut)) {
      data = (builtDirect as PromiseFulfilledResult<any>).value
      fresh = publicQuote(data.quoteResponse, q)
      fromDirect = true
    } else {
      fresh = (external as PromiseFulfilledResult<any>).value
      if (BigInt(fresh.outAmount) < BigInt(minimum)) throw new RequestError(409, 'The price moved beyond your minimum received. Refresh the quote.')
      if (BigInt(fresh.otherAmountThreshold) < BigInt(minimum)) fresh.otherAmountThreshold = minimum
      data = await upstream(router('/swap'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userPublicKey: wallet, transactionVersion: requestedVersion, wrapAndUnwrapSol: true, autoCreateOutAta: true, quoteResponse: fresh }) }, 30_000)
    }
    if (!object(data) || typeof data.swapTransaction !== 'string' || !Number.isSafeInteger(data.lastValidBlockHeight) || data.lastValidBlockHeight < 1) throw new RequestError(502, 'Router returned an invalid transaction')
    transaction(data.swapTransaction, false)
    if (transactionVersion(data.swapTransaction) !== requestedVersion || (data.transactionVersion !== undefined && String(data.transactionVersion) !== requestedVersion)) throw new RequestError(502, 'Router returned a different transaction version than requested')
    // A composed (multi-hop, on-chain composer) direct route says so; only the
    // direct router can produce one, so external responses never carry it.
    const composed = fromDirect && data.composed === true && Number.isSafeInteger(data.hops) && data.hops > 1 && data.hops <= 8
    return { transactionVersion: requestedVersion, swapTransaction: data.swapTransaction, lastValidBlockHeight: data.lastValidBlockHeight, prioritizationFeeLamports: data.prioritizationFeeLamports ?? data.priorizationFeeLamports ?? 0, ...(composed ? { composed: true, hops: data.hops } : {}), quoteResponse: fresh }
  }
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, body: string): Promise<boolean> {
    const route = `${req.method}:${url.pathname}`
    if (!['GET:/api/quote/solana', 'POST:/api/swap/solana', 'GET:/api/router/solana', 'POST:/api/solana/rpc', 'GET:/api/liquidity/solana/capabilities', 'GET:/api/liquidity/solana/positions', 'POST:/api/liquidity/solana/quote', 'POST:/api/liquidity/solana/build'].includes(route)) return false
    let counted = false
    try {
      if (Buffer.byteLength(body) > 32_000) throw new RequestError(413, 'Trading request is too large')
      const peer = String(req.headers['fly-client-ip'] ?? req.socket.remoteAddress ?? 'unknown').slice(0, 100)
      const ceiling = route.includes('/rpc') ? 120 : route.includes('/swap/') ? 12 : 40
      limit(`ip:${peer}:${route}`, ceiling); limit(`global:${route}`, ceiling * 20)
      if (inflight >= 24) throw new RequestError(429, 'Trading service is busy; retry shortly')
      inflight++; counted = true
      let data: any
      if (route === 'GET:/api/liquidity/solana/capabilities') {
        data = await upstream(router('/liquidity/capabilities'),{},15_000,true)
      } else if (route === 'GET:/api/liquidity/solana/positions') {
        const q=new URLSearchParams({owner:address(url.searchParams.get('owner'))})
        if(url.searchParams.has('pool'))q.set('pool',address(url.searchParams.get('pool')))
        if(url.searchParams.has('venue')) {const venue=url.searchParams.get('venue')!;if(!LP_VENUES.has(venue))fail('Invalid liquidity venue');q.set('venue',venue==='raydium-amm'?'raydium-amm-v4':venue)}
        data=await upstream(`${router('/liquidity/positions')}?${q}`,{},65_000,true)
      } else if (route === 'POST:/api/liquidity/solana/quote' || route === 'POST:/api/liquidity/solana/build') {
        let j:unknown;try{j=JSON.parse(body)}catch{fail('Invalid JSON body')}
        data = route.endsWith('/build') ? await liquidityBuild(j) : await liquidityQuote(j)
      } else if (route === 'GET:/api/router/solana') {
        if (directEnabled) {
          const { directRouterCoverage } = await import('./self-router.ts')
          data = { configured: true, status: 'ok', discovery: directRouterCoverage() }
        } else if (!options.routerUrl) data = { configured: false, status: 'unavailable' }
        else { const health = await upstream(router('/health'), {}, 5_000); data = { configured: true, status: health.status === 'ok' ? 'ok' : 'unavailable', discovery: health.discovery ?? null } }
      } else if (route === 'GET:/api/quote/solana') data = await getQuote(quoteParams(url.searchParams))
      else {
        let j: any
        try { j = JSON.parse(body) } catch { fail('Invalid JSON body') }
        if (route === 'POST:/api/swap/solana') data = await buildSwap(j)
        else {
          if (!options.rpcUrl) throw new RequestError(503, 'Solana wallet RPC is not configured yet')
          const request = validateRpc(j)
          limit(`rpc:${peer}:${request.method}`, request.method === 'sendTransaction' ? 10 : request.method === 'simulateTransaction' ? 20 : 90)
          data = await upstream(options.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) }, 15_000)
          if (!object(data) || data.jsonrpc !== '2.0') throw new RequestError(502, 'Invalid Solana RPC response')
          // Provider errors can include credential-bearing URLs. Preserve only
          // structured simulation evidence, never the upstream message string.
          if (data.error) data = { jsonrpc: '2.0', id: request.id, error: { code: Number.isInteger(data.error.code) ? data.error.code : -32000, message: request.method === 'sendTransaction' ? 'Transaction was not accepted; simulate again and check balances, fees and expiry.' : 'Solana RPC request failed; retry shortly', ...(object(data.error.data) && data.error.data.err !== undefined ? { data: { err: data.error.data.err } } : {}) } }
          else data = { jsonrpc: '2.0', id: request.id, result: data.result }
        }
      }
      reply(res, 200, data)
    } catch (e) {
      const status = e instanceof RequestError ? e.status :
        object(e) && Number.isInteger(e.status) && Number(e.status) >= 400 && Number(e.status) < 600
          ? Number(e.status) : 503
      const retryAfter = object(e) && Number.isSafeInteger(e.retryAfter) && Number(e.retryAfter) > 0 ? Number(e.retryAfter) : status === 429 ? 60 : null
      if (retryAfter !== null) res.setHeader('retry-after', String(retryAfter))
      reply(res, status, { error: e instanceof RequestError || (object(e) && typeof e.message === 'string' && Number.isInteger(e.status))
        ? String(e.message) : 'Trading service is temporarily unavailable' })
    } finally { if (counted) inflight-- }
    return true
  }
  return Object.assign(handle, { positions, liquidityPositions, liquidityQuote, liquidityBuild, quote: (q: URLSearchParams) => getQuote(quoteParams(q)), buildSwap, upstream, router })
}
