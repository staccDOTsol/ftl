// Simple liquidity ("zap"): one SOL amount in, one LP position out, and the
// reverse. The planner picks the pool (constant product first, then Splash,
// then concentrated), splits the SOL, quotes the swap and the add through the
// same paths the router handler uses, and the builder re-quotes every step
// against the wallet's live balances right before it is signed. The browser
// signs; nothing here holds a key, and no upstream URL reaches a reply.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import bs58 from 'bs58'
import { PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import type { PoolSummary, TokenSummary } from '../../../shared/types.ts'
import { validPublicKey } from './router.ts'
import { decodeV1 } from './transaction-v1.ts'
import { parsePositions, type HoldingPosition } from './holdings.ts'
import { fetchPoolStats, isPoolStatsVenue, POOL_STATS_VENUES, type PoolStats, type PoolStatsVenue } from './pool-stats.ts'
import { buildComposedTransaction, composeZap, FEE_BPS, FEE_RECIPIENT } from './compose.ts'
import { assembleComposedZap, mintTokenProgram } from './zap-compose.ts'

export const SOL_MINT = 'So11111111111111111111111111111111111111112'
export type PoolKind = 'constant' | 'splash' | 'concentrated'
export type ZapPreference = 'auto' | 'constant' | 'splash' | 'concentrated'
export type ZapDirection = 'in' | 'out'
/** How the steps execute. 'sequential' = one prebuilt transaction per step, confirmed in order. 'composed' = both steps run as one transaction through the on-chain lp-zap composer, the second sized from the first's real balance delta; builds that cannot prove every offset fall back to 'sequential'. */
export type ZapMode = 'sequential' | 'composed'
export interface RawInstruction { programId: string; keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }
export const CONSTANT_VENUES: ReadonlySet<string> = new Set(['pumpswap', 'raydium-cpmm', 'raydium-amm-v4', 'meteora-damm', 'meteora-damm-v2'])
/** Orca Splash pools are whirlpools created with this tick spacing. */
export const SPLASH_TICK_SPACING = 32896
export const HONEYPOT_FEE_BPS = 7000
/** Share of the deposit held back from the split for swap fees and slippage. */
export const SPLIT_BUFFER_BPS = 50n
export const SOL_RESERVE = 10_000_000n
export const MIN_DEPOSIT_LAMPORTS = 1_000_000n
export const PLAN_TTL = 5 * 60_000
const MAX_PLANS = 2_000
const MAX_RESPONSE = 4_000_000
const MAX_ALTERNATIVES = 4
const MAX_CANDIDATE_QUOTES = 3
const MAX_CONFIRMED = 8
const RATE_CEILING = 30
const U64_MAX = (1n << 64n) - 1n
const VENUE_LABEL: Record<string, string> = {
  'raydium-cpmm': 'Raydium CPMM', 'raydium-clmm': 'Raydium CLMM', 'raydium-amm-v4': 'Raydium AMM v4', orca: 'Orca',
  'meteora-dlmm': 'Meteora DLMM', 'meteora-damm': 'Meteora DAMM', 'meteora-damm-v2': 'Meteora DAMM v2', pumpswap: 'PumpSwap',
}
const KIND_LABEL: Record<PoolKind, string> = { constant: 'Constant-product', splash: 'Splash', concentrated: 'Concentrated-liquidity' }
/** Venues whose remove step takes an explicit "unwrap WSOL" flag. */
const UNWRAP_ON_REMOVE = new Set(['raydium-clmm', 'raydium-amm-v4'])

export class RequestError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status } }
const fail = (message: string): never => { throw new RequestError(400, message) }
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const integer = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(v)
function address(v: unknown): string { if (!validPublicKey(v)) fail('Invalid Solana address'); return v as string }
function amount(v: unknown): string {
  if (typeof v !== 'string' || !/^[1-9][0-9]{0,19}$/.test(v) || BigInt(v) > U64_MAX) fail('Amount must be a positive integer in lamports')
  return v as string
}
function signature(v: unknown): string {
  if (typeof v !== 'string' || v.length > 90) fail('Invalid transaction signature')
  try { if (bs58.decode(v as string).length !== 64) fail('Invalid transaction signature') } catch { fail('Invalid transaction signature') }
  return v as string
}
export const venueLabel = (id: string) => VENUE_LABEL[id] ?? id
export const routingVenue = (id: string) => id === 'raydium-amm' ? 'raydium-amm-v4' : id
export function uiText(raw: string | bigint, decimals: number): string {
  const value = BigInt(raw), scale = 10n ** BigInt(decimals)
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${value / scale}${fraction ? `.${fraction}` : ''}`
}
const shortMint = (mint: string) => mint === SOL_MINT ? 'SOL' : `${mint.slice(0, 4)}…${mint.slice(-4)}`
const usd = (x: number) => x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(0)}k` : `$${x.toFixed(0)}`
const feeText = (bps: number | null) => bps === null ? null : `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}% fee`

// ---- pure rules: classification, ranking, split ----------------------------

/** constant = full-range AMMs; splash = Orca pools at the Splash tick spacing; everything else is concentrated. */
export function classifyPool(venue: string, stats?: Pick<PoolStats, 'tickSpacing'> | null): PoolKind {
  const id = routingVenue(venue)
  if (CONSTANT_VENUES.has(id)) return 'constant'
  if (id === 'orca' && stats?.tickSpacing === SPLASH_TICK_SPACING) return 'splash'
  return 'concentrated'
}
export function classOrder(preference: ZapPreference): PoolKind[] {
  if (preference === 'splash') return ['splash', 'constant', 'concentrated']
  if (preference === 'concentrated') return ['concentrated', 'constant', 'splash']
  return ['constant', 'splash', 'concentrated']
}
export interface ZapCandidate { venue: PoolStatsVenue; pool: string; kind: PoolKind; stats: PoolStats | null; feeBps: number | null }
/** Preference class first, then TVL (missing stats count as 0), then the lower fee. Stable for ties. */
export function rankCandidates<T extends { kind: PoolKind; stats: Pick<PoolStats, 'tvlUsd' | 'feeRateBps'> | null; feeBps: number | null }>(candidates: T[], preference: ZapPreference = 'auto'): T[] {
  const order = classOrder(preference)
  const tvl = (c: T) => c.stats?.tvlUsd ?? 0
  const fee = (c: T) => c.stats?.feeRateBps ?? c.feeBps ?? Number.POSITIVE_INFINITY
  return candidates.map((c, i) => ({ c, i })).sort((a, b) => order.indexOf(a.c.kind) - order.indexOf(b.c.kind) || tvl(b.c) - tvl(a.c) || fee(a.c) - fee(b.c) || a.i - b.i).map(x => x.c)
}
/** Funded SOL-paired pools on supported venues, honeypot fees excluded. */
export function eligiblePools(pools: PoolSummary[]): { venue: PoolStatsVenue; pool: string; feeBps: number | null }[] {
  const seen = new Set<string>()
  const out: { venue: PoolStatsVenue; pool: string; feeBps: number | null }[] = []
  for (const p of pools) {
    const venue = routingVenue(p.venue)
    if (!p.funded || p.quote !== SOL_MINT || (p.feeBps ?? 0) >= HONEYPOT_FEE_BPS || !isPoolStatsVenue(venue) || !validPublicKey(p.address) || seen.has(p.address)) continue
    seen.add(p.address)
    out.push({ venue, pool: p.address, feeBps: p.feeBps })
  }
  return out
}
/** Half of the deposit swaps into the token; the rest stays SOL for the add. A 0.5% buffer covers swap fees and slippage. */
export function splitDeposit(lamports: bigint): { swap: bigint; keep: bigint; buffer: bigint } {
  if (lamports <= 0n) throw new RequestError(400, 'Deposit must be a positive amount of SOL')
  const buffer = lamports * SPLIT_BUFFER_BPS / 10_000n
  const usable = lamports - buffer
  const swap = usable / 2n
  return { swap, keep: usable - swap, buffer }
}
/** Venue parameters that make a concentrated add behave close to constant product; wrapSol where the venue has it. */
export function addParameters(venue: string): Record<string, string | number | boolean> {
  const id = routingVenue(venue)
  const parameters: Record<string, string | number | boolean> = {}
  if (['raydium-cpmm', 'raydium-amm-v4', 'raydium-clmm'].includes(id)) parameters.wrapSol = true
  if (id === 'raydium-clmm' || id === 'orca') parameters.rangeWidthPct = 100
  if (id === 'meteora-dlmm') parameters.binCount = 60
  return parameters
}
export function describeChoice(chosen: ZapCandidate, ranked: ZapCandidate[]): string {
  const head = `${KIND_LABEL[chosen.kind]} ${venueLabel(chosen.venue)} pool`
  const fee = feeText(chosen.stats?.feeRateBps ?? chosen.feeBps)
  const tail = chosen.kind === 'concentrated' ? '; the price range is set automatically around the current price' : ''
  if (!chosen.stats || chosen.stats.tvlUsd === null) return `${head}, the only kind available for this token right now${fee ? ` (${fee})` : ''}${tail}.`
  const deepestOverall = ranked.every(c => (c.stats?.tvlUsd ?? 0) <= (chosen.stats?.tvlUsd ?? 0))
  const sameKind = ranked.filter(c => c.kind === chosen.kind)
  const why = deepestOverall ? 'deepest liquidity for this token' : sameKind.length > 1 ? `deepest ${chosen.kind === 'constant' ? 'constant-product' : chosen.kind} pool for this token` : `the one ${chosen.kind === 'constant' ? 'constant-product' : chosen.kind} pool for this token`
  return `${head}, ${why}: ${usd(chosen.stats.tvlUsd)} TVL${fee ? `, ${fee}` : ''}${tail}.`
}
const hasLiquidity = (p: HoldingPosition) => integer(p.liquidity ?? '') ? BigInt(p.liquidity!) > 0n
  : p.removalMode === 'percentage' || (p.amounts ?? []).some(a => (integer(a.raw) && BigInt(a.raw!) > 0n) || (integer(a.amount) && BigInt(a.amount!) > 0n))
/** Exactly one active owned position for venue+pool, or the one the client named. */
export function resolvePosition(rows: HoldingPosition[], request: { venue: string; pool: string; position?: string }): HoldingPosition {
  const active = rows.filter(p => p.venue === request.venue && p.pool === request.pool && hasLiquidity(p))
  if (request.position) {
    const named = active.find(p => p.position === request.position)
    if (!named) throw new RequestError(409, 'That position was not found with liquidity in this pool. Refresh your positions.')
    return named
  }
  if (!active.length) throw new RequestError(409, 'No active position of yours in this pool')
  if (active.length > 1) throw new RequestError(409, 'You hold several positions in this pool; choose one to withdraw')
  return active[0]
}
export function removeIntent(position: HoldingPosition, owner: string, slippageBps: number, transactionVersion: '1' | '0'): Record<string, any> {
  const venue = routingVenue(position.venue)
  const percentage = position.removalMode === 'percentage' || venue === 'meteora-dlmm'
  if (!percentage && !integer(position.liquidity ?? '')) throw new RequestError(409, 'This position reports no removable liquidity; refresh your positions')
  const parameters: Record<string, string | number | boolean> = {}
  if (percentage) parameters.removeBps = 10_000
  if (UNWRAP_ON_REMOVE.has(venue)) parameters.wrapSol = true
  return { venue, operation: 'remove', owner, pool: position.pool, position: position.position, slippageBps, transactionVersion,
    ...(percentage ? {} : { liquidity: position.liquidity }), parameters }
}

/** The instructions inside a built transaction as opaque buffers (base64 data, keys with flags), for a composer that patches amounts itself. V0 transactions that depend on address lookup tables return null: resolving them needs an RPC round trip. */
export function instructionsOf(wire: string): RawInstruction[] | null {
  try {
    const bytes = Buffer.from(wire, 'base64')
    if (bytes[0] === 0x81) {
      const v1 = decodeV1(bytes, { requireResources: true })
      const required = bytes[1], readonlySigned = bytes[2], readonlyUnsigned = bytes[3], total = v1.keys.length
      const key = (i: number) => ({ pubkey: bs58.encode(v1.keys[i]), isSigner: i < required, isWritable: i < required - readonlySigned || (i >= required && i < total - readonlyUnsigned) })
      return v1.ixs.map(ix => ({ programId: bs58.encode(v1.keys[ix.prog]), keys: ix.accts.map(key), data: Buffer.from(ix.data).toString('base64') }))
    }
    const message = VersionedTransaction.deserialize(bytes).message
    if ('addressTableLookups' in message && message.addressTableLookups.length) return null
    return TransactionMessage.decompile(message).instructions.map(ix => ({ programId: ix.programId.toBase58(), keys: ix.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(ix.data).toString('base64') }))
  } catch { return null }
}
const withInstructions = (transactions: any[]) => transactions.map(tx => ({ ...tx, instructions: instructionsOf(tx.transaction) }))

// ---- plan records -----------------------------------------------------------

export interface SwapStep { kind: 'swap'; title: string; inputMint: string; outputMint: string; amount: string; expectedOut: string; minOut: string; slippageBps: number }
export interface AddStep { kind: 'add'; title: string; venue: string; pool: string; mintA: string; mintB: string; tokenAmount: string; solAmount: string; parameters: Record<string, string | number | boolean>; quote: any }
export interface RemoveStep { kind: 'remove'; title: string; venue: string; pool: string; position: string; intent: Record<string, any>; quote: any }
export type Step = SwapStep | AddStep | RemoveStep
export interface ZapPool { venue: string; pool: string; kind: PoolKind; mintA: string; mintB: string; stats?: PoolStats | null; reason: string }
export interface ZapPlan {
  planId: string; owner: string; direction: ZapDirection; mint: string; transactionVersion: '1' | '0'; slippageBps: number
  mode: ZapMode
  pool: ZapPool; alternatives: { venue: string; pool: string; kind: PoolKind; stats?: PoolStats | null }[]
  steps: Step[]
  estimate: { depositSol?: string; positionValueSol?: string; receiveSol?: string; tokenExpected?: string; tokenDecimals?: number; networkFeeSolApprox: string }
  /** Set on composed plans so the disclosure names the program the wallet calls. */
  composerProgramId?: string
  createdAt: number; expiresAt: number
}
export interface ZapCatalog { token: (mint: string) => TokenSummary | null; pools: (mint: string, limit: number) => PoolSummary[] }
export interface ZapRouter {
  quote: (q: URLSearchParams) => Promise<any>
  buildSwap: (body: any) => Promise<any>
  liquidityQuote: (intent: unknown) => Promise<any>
  liquidityBuild: (intent: unknown) => Promise<any>
  liquidityPositions: (params: { owner: string; venue?: string; pool?: string }) => Promise<unknown>
}
type Options = {
  rpcUrl?: string; router: ZapRouter; catalog: ZapCatalog
  poolStats?: (venue: PoolStatsVenue, pool: string) => Promise<PoolStats>
  /** lp-zap composer program id; plans it can compose say mode 'composed'. */
  composerProgramId?: string
  fetch?: typeof fetch; now?: () => number
}
/** One transaction when both steps run through the composer; a step each otherwise. */
const composedFee = (steps: Step[]) => uiText(5_000n, 9)
const sequentialFee = (steps: Step[]) => uiText(BigInt(steps.length) * 10_000n, 9)
const publicStep = (step: Step) => step.kind === 'remove' ? { kind: step.kind, title: step.title, venue: step.venue, pool: step.pool, position: step.position, quote: step.quote } : step
const publicPlan = (plan: ZapPlan) => ({ planId: plan.planId, mode: plan.mode, direction: plan.direction, mint: plan.mint, owner: plan.owner, transactionVersion: plan.transactionVersion, slippageBps: plan.slippageBps,
  pool: plan.pool, alternatives: plan.alternatives, steps: plan.steps.map(publicStep), estimate: plan.estimate, expiresAt: plan.expiresAt,
  ...(plan.mode === 'composed' ? { composerProgramId: plan.composerProgramId, composerFeeRecipient: FEE_RECIPIENT.toBase58(), composerFeeBps: Number(FEE_BPS) } : {}) })

function reply(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(JSON.stringify(data))
}
// Errors from the router handler carry a status and a client-safe message;
// anything else collapses to a fixed sentence. URLs never pass through.
function clientError(e: unknown): { status: number; message: string } {
  if (e instanceof RequestError) return { status: e.status, message: e.message }
  if (object(e) && Number.isInteger(e.status) && Number(e.status) >= 400 && Number(e.status) < 600 && typeof e.message === 'string') return { status: Number(e.status), message: e.message.replace(/https?:\/\/[^\s]+/g, '[provider]').slice(0, 500) }
  return { status: 503, message: 'Simple liquidity is temporarily unavailable; retry shortly' }
}

export function createSolanaZapHandler(options: Options) {
  const fetcher = options.fetch ?? fetch, now = options.now ?? Date.now
  const poolStats = options.poolStats ?? ((venue: PoolStatsVenue, pool: string) => fetchPoolStats(venue, pool, fetcher as any, { now }))
  const plans = new Map<string, ZapPlan>()
  const buckets = new Map<string, { until: number; count: number }>()
  function limit(key: string, ceiling: number) {
    const time = now(), b = buckets.get(key)
    if (b && b.until > time) { if (++b.count > ceiling) throw new RequestError(429, 'Liquidity request limit reached; retry shortly'); return }
    if (buckets.size > 10_000) { for (const [k, v] of buckets) if (v.until <= time) buckets.delete(k); if (buckets.size > 10_000) throw new RequestError(429, 'Liquidity request limit reached; retry shortly') }
    buckets.set(key, { until: time + 60_000, count: 1 })
  }
  function prune() { const time = now(); for (const [id, plan] of plans) if (plan.expiresAt <= time) plans.delete(id) }
  async function rpc(method: string, params: unknown[]): Promise<any> {
    if (!options.rpcUrl) throw new RequestError(503, 'Solana wallet RPC is not configured yet')
    let r: Response
    try {
      r = await fetcher(options.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), redirect: 'error', signal: AbortSignal.timeout(20_000) })
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
  async function solBalance(owner: string): Promise<bigint> {
    const balance = await rpc('getBalance', [owner, { commitment: 'confirmed' }])
    const lamports = object(balance) ? balance.value : balance
    if (!Number.isSafeInteger(lamports) || lamports < 0) throw new RequestError(502, 'Solana RPC returned an invalid balance')
    return BigInt(lamports)
  }
  async function tokenBalance(owner: string, mint: string): Promise<bigint> {
    const accounts = await rpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }])
    let total = 0n
    for (const row of Array.isArray(accounts?.value) ? accounts.value : []) {
      const raw = row?.account?.data?.parsed?.info?.tokenAmount?.amount
      if (integer(raw)) total += BigInt(raw)
    }
    return total
  }
  async function swapQuote(inputMint: string, outputMint: string, lamports: string, slippageBps: number, transactionVersion: '1' | '0') {
    return options.router.quote(new URLSearchParams({ inputMint, outputMint, amount: lamports, slippageBps: String(slippageBps), swapMode: 'ExactIn', transactionVersion }))
  }
  const symbolOf = (mint: string) => { const t = options.catalog.token(mint); return t?.symbol ? `$${t.symbol.slice(0, 14)}` : shortMint(mint) }
  const creditOf = (quote: any, mint: string) => (Array.isArray(quote?.amounts) ? quote.amounts : []).find((a: any) => object(a) && a.mint === mint && a.direction === 'credit' && integer(a.expectedRaw))
  const debitOf = (quote: any, mint: string) => (Array.isArray(quote?.amounts) ? quote.amounts : []).find((a: any) => object(a) && a.mint === mint && a.direction === 'debit' && integer(a.expectedRaw))

  async function planIn(input: { owner: string; mint: string; lamports: string; preference: ZapPreference; pool?: string; slippageBps: number; transactionVersion: '1' | '0' }): Promise<ZapPlan> {
    const { owner, mint, slippageBps, transactionVersion } = input
    const lamports = BigInt(input.lamports)
    if (lamports < MIN_DEPOSIT_LAMPORTS) throw new RequestError(400, `Deposit at least ${uiText(MIN_DEPOSIT_LAMPORTS, 9)} SOL`)
    const eligible = eligiblePools(options.catalog.pools(mint, 100))
    if (!eligible.length) throw Object.assign(new RequestError(409, 'No SOL pool for this token yet'), { suggest: { venue: 'meteora-damm-v2', operation: 'initialize' } })
    const stats = await Promise.allSettled(eligible.map(e => poolStats(e.venue, e.pool)))
    const candidates: ZapCandidate[] = eligible.map((e, i) => { const s = stats[i].status === 'fulfilled' ? stats[i].value : null; return { ...e, stats: s, kind: classifyPool(e.venue, s) } })
    let ranked = rankCandidates(candidates, input.preference)
    // An explicit pool (the "change pool" list) goes first; it must still be eligible.
    if (input.pool) {
      const picked = ranked.find(c => c.pool === input.pool)
      if (!picked) throw new RequestError(409, 'That pool is not an eligible SOL pool for this token')
      ranked = [picked, ...ranked.filter(c => c !== picked)]
    }
    const { swap, keep } = splitDeposit(lamports)
    const symbol = symbolOf(mint)
    const quote = await swapQuote(SOL_MINT, mint, swap.toString(), slippageBps, transactionVersion)
    const swapStep: SwapStep = { kind: 'swap', title: `Swapping ${uiText(swap, 9)} SOL → ${symbol}`, inputMint: SOL_MINT, outputMint: mint, amount: swap.toString(), expectedOut: quote.outAmount, minOut: quote.otherAmountThreshold, slippageBps }
    let chosen: ZapCandidate | null = null, addQuote: any = null, lastError: unknown = null
    for (const candidate of ranked.slice(0, MAX_CANDIDATE_QUOTES)) {
      try {
        addQuote = await options.router.liquidityQuote({ venue: candidate.venue, operation: 'add', owner, pool: candidate.pool, mintA: mint, mintB: SOL_MINT, amountA: quote.otherAmountThreshold, amountB: keep.toString(), slippageBps, parameters: addParameters(candidate.venue), transactionVersion })
        chosen = candidate; break
      } catch (e) { lastError = e }
    }
    if (!chosen || !addQuote) throw lastError instanceof Error ? lastError : new RequestError(503, 'No pool could quote this deposit right now')
    const addStep: AddStep = { kind: 'add', title: `Depositing into ${venueLabel(chosen.venue)}`, venue: chosen.venue, pool: chosen.pool, mintA: mint, mintB: SOL_MINT, tokenAmount: quote.outAmount, solAmount: keep.toString(), parameters: addParameters(chosen.venue), quote: addQuote }
    const solDebit = debitOf(addQuote, SOL_MINT), tokenDebit = debitOf(addQuote, mint)
    const positionValue = swap + (solDebit ? BigInt(solDebit.expectedRaw) : keep)
    const plan: ZapPlan = {
      planId: randomUUID(), owner, direction: 'in', mint, transactionVersion, slippageBps,
      mode: options.composerProgramId ? 'composed' : 'sequential', ...(options.composerProgramId ? { composerProgramId: options.composerProgramId } : {}),
      pool: { venue: chosen.venue, pool: chosen.pool, kind: chosen.kind, mintA: addQuote.mintA ?? mint, mintB: addQuote.mintB ?? SOL_MINT, stats: chosen.stats, reason: input.pool === chosen.pool ? `${describeChoice(chosen, ranked).replace(/\.$/, '')} (your pick).` : describeChoice(chosen, ranked) },
      alternatives: ranked.filter(c => c.pool !== chosen!.pool).slice(0, MAX_ALTERNATIVES).map(c => ({ venue: c.venue, pool: c.pool, kind: c.kind, stats: c.stats })),
      steps: [swapStep, addStep],
      estimate: { depositSol: uiText(lamports, 9), positionValueSol: uiText(positionValue, 9), tokenExpected: quote.outAmount, tokenDecimals: tokenDebit?.decimals, networkFeeSolApprox: options.composerProgramId ? composedFee([swapStep, addStep]) : sequentialFee([swapStep, addStep]) },
      createdAt: now(), expiresAt: now() + PLAN_TTL,
    }
    return plan
  }
  async function planOut(input: { owner: string; mint: string; position: { venue: string; pool: string; position?: string }; slippageBps: number; transactionVersion: '1' | '0' }): Promise<ZapPlan> {
    const { owner, mint, slippageBps, transactionVersion } = input
    const venue = routingVenue(input.position.venue)
    const listed = parsePositions(await options.router.liquidityPositions({ owner, venue, pool: input.position.pool }))
    const position = resolvePosition(listed.positions.map(p => ({ ...p, venue: routingVenue(p.venue) })), { venue, pool: input.position.pool, position: input.position.position })
    if (position.mintA !== mint && position.mintB !== mint) throw new RequestError(409, 'That position is not on this token')
    const intent = removeIntent(position, owner, slippageBps, transactionVersion)
    const removeQuote = await options.router.liquidityQuote(intent)
    const symbol = symbolOf(mint)
    const removeStep: RemoveStep = { kind: 'remove', title: `Withdrawing from ${venueLabel(venue)}`, venue, pool: position.pool, position: position.position, intent, quote: removeQuote }
    const tokenCredit = creditOf(removeQuote, mint), solCredit = creditOf(removeQuote, SOL_MINT)
    const steps: Step[] = [removeStep]
    let receive = solCredit ? BigInt(solCredit.expectedRaw) : 0n
    if (tokenCredit && BigInt(tokenCredit.expectedRaw) > 0n) {
      const quote = await swapQuote(mint, SOL_MINT, tokenCredit.expectedRaw, slippageBps, transactionVersion)
      steps.push({ kind: 'swap', title: `Swapping ${symbol} → SOL`, inputMint: mint, outputMint: SOL_MINT, amount: tokenCredit.expectedRaw, expectedOut: quote.outAmount, minOut: quote.otherAmountThreshold, slippageBps })
      receive += BigInt(quote.outAmount)
    }
    const kind = classifyPool(venue, venue === 'orca' ? await poolStats('orca', position.pool).catch(() => null) : null)
    const composed = !!options.composerProgramId && steps.length === 2
    return {
      planId: randomUUID(), owner, direction: 'out', mint, transactionVersion, slippageBps,
      mode: composed ? 'composed' : 'sequential', ...(composed ? { composerProgramId: options.composerProgramId } : {}),
      pool: { venue, pool: position.pool, kind, mintA: position.mintA, mintB: position.mintB, reason: `Your ${venueLabel(venue)} position, withdrawn in full and swapped back to SOL.` },
      alternatives: [], steps,
      estimate: { positionValueSol: uiText(receive, 9), receiveSol: uiText(receive, 9), tokenExpected: tokenCredit?.expectedRaw, tokenDecimals: tokenCredit?.decimals, networkFeeSolApprox: composed ? composedFee(steps) : sequentialFee(steps) },
      createdAt: now(), expiresAt: now() + PLAN_TTL,
    }
  }
  async function verifyConfirmed(signatures: string[]) {
    const statuses = await rpc('getSignatureStatuses', [signatures, { searchTransactionHistory: true }])
    const values = Array.isArray(statuses?.value) ? statuses.value : []
    signatures.forEach((_, i) => {
      const s = values[i]
      if (!object(s) || s.err || !['confirmed', 'finalized'].includes(s.confirmationStatus)) throw new RequestError(409, 'An earlier step has not confirmed on-chain yet; check its status before continuing')
    })
  }
  async function buildStep(plan: ZapPlan, index: number, transactionVersion: '1' | '0') {
    const step = plan.steps[index], owner = plan.owner
    if (step.kind === 'swap') {
      let lamports = BigInt(step.amount)
      if (step.inputMint === SOL_MINT) {
        const spendable = await solBalance(owner) - SOL_RESERVE
        if (spendable <= 0n) throw new RequestError(409, 'Not enough SOL in the wallet for this step (0.01 SOL stays for fees)')
        if (spendable < lamports) lamports = spendable
      } else {
        const held = await tokenBalance(owner, step.inputMint)
        if (held <= 0n) throw new RequestError(409, 'The tokens from the previous step have not arrived yet; wait for confirmation and retry')
        if (held < lamports) lamports = held
      }
      const quote = await swapQuote(step.inputMint, step.outputMint, lamports.toString(), step.slippageBps, transactionVersion)
      const built = await options.router.buildSwap({ quoteResponse: quote, userPublicKey: owner, wrapAndUnwrapSol: true, transactionVersion })
      return { step: index, mode: 'sequential' as ZapMode, kind: 'swap', transactions: withInstructions([{ transaction: built.swapTransaction, lastValidBlockHeight: built.lastValidBlockHeight, expectedSigners: [owner] }]), quote: built.quoteResponse,
        ...(lamports.toString() !== step.amount ? { note: `Swapping ${uiText(lamports, step.inputMint === SOL_MINT ? 9 : plan.estimate.tokenDecimals ?? 0)} ${step.inputMint === SOL_MINT ? 'SOL' : symbolOf(step.inputMint)}, the balance available now` } : {}) }
    }
    if (step.kind === 'add') {
      const [held, sol] = await Promise.all([tokenBalance(owner, step.mintA), solBalance(owner)])
      if (held <= 0n) throw new RequestError(409, 'The tokens from the swap have not arrived yet; wait for confirmation and retry')
      const tokenAmount = held < BigInt(step.tokenAmount) ? held : BigInt(step.tokenAmount)
      const spendable = sol - SOL_RESERVE
      if (spendable <= 0n) throw new RequestError(409, 'Not enough SOL left for the deposit (0.01 SOL stays for fees)')
      const solAmount = spendable < BigInt(step.solAmount) ? spendable : BigInt(step.solAmount)
      const quote = await options.router.liquidityQuote({ venue: step.venue, operation: 'add', owner, pool: step.pool, mintA: step.mintA, mintB: step.mintB, amountA: tokenAmount.toString(), amountB: solAmount.toString(), slippageBps: plan.slippageBps, parameters: step.parameters, transactionVersion })
      const built = await options.router.liquidityBuild({ quoteId: quote.quoteId, owner, transactionVersion })
      return { step: index, mode: 'sequential' as ZapMode, kind: 'add', transactions: withInstructions(built.transactions), quote: built.quote, pool: built.pool, position: built.position, note: 'Deposit sized to the tokens that arrived from the swap and the SOL left in the wallet' }
    }
    const quote = await options.router.liquidityQuote({ ...step.intent, transactionVersion })
    const built = await options.router.liquidityBuild({ quoteId: quote.quoteId, owner, transactionVersion })
    return { step: index, mode: 'sequential' as ZapMode, kind: 'remove', transactions: withInstructions(built.transactions), quote: built.quote, pool: built.pool, position: built.position }
  }
  /** Both steps of a composed plan as one transaction through the lp-zap
   * composer: each step is rebuilt against live state exactly as buildStep
   * does, every amount offset is proven from the bytes the venue builders just
   * produced, and the second step is patched from the first's real delta.
   * Any failure returns null and the caller serves the sequential build. */
  async function buildComposedZap(plan: ZapPlan, version: '1' | '0'): Promise<Record<string, unknown> | null> {
    const programId = options.composerProgramId
    if (!programId || plan.steps.length !== 2) return null
    const owner = plan.owner, payer = new PublicKey(owner)
    try {
      let steps: import('./compose.ts').ZapComposeStep[]
      let quote: any, pool: any, position: any, note: string
      if (plan.direction === 'in') {
        const [swapStep, addStep] = plan.steps as [SwapStep, AddStep]
        if (swapStep.kind !== 'swap' || addStep.kind !== 'add') return null
        const spendable = await solBalance(owner) - SOL_RESERVE
        const lamports = spendable < BigInt(swapStep.amount) ? spendable : BigInt(swapStep.amount)
        if (lamports <= 0n) return null
        const addSol = spendable - lamports
        const solAmount = addSol < BigInt(addStep.solAmount) ? addSol : BigInt(addStep.solAmount)
        if (solAmount <= 0n) return null
        const quoted = await swapQuote(SOL_MINT, plan.mint, lamports.toString(), plan.slippageBps, version)
        const builtSwap = await options.router.buildSwap({ quoteResponse: quoted, userPublicKey: owner, wrapAndUnwrapSol: true, transactionVersion: version })
        if (builtSwap.composed === true) return null // a composer-built swap cannot nest inside the composer
        const swapInstructions = instructionsOf(builtSwap.swapTransaction)
        if (!swapInstructions) return null
        const addQuote = await options.router.liquidityQuote({ venue: addStep.venue, operation: 'add', owner, pool: addStep.pool, mintA: addStep.mintA, mintB: addStep.mintB, amountA: builtSwap.quoteResponse.outAmount, amountB: solAmount.toString(), slippageBps: plan.slippageBps, parameters: addStep.parameters, transactionVersion: version })
        const builtAdd = await options.router.liquidityBuild({ quoteId: addQuote.quoteId, owner, transactionVersion: version })
        const addInstructions = builtAdd.transactions.map((tx: any) => instructionsOf(tx.transaction))
        if (addInstructions.some((ixs: RawInstruction[] | null) => ixs === null)) return null
        const tokenProgram = await mintTokenProgram(rpc, plan.mint)
        if (!tokenProgram) return null
        const assembly = assembleComposedZap({ direction: 'in', owner, tokenMint: plan.mint, tokenProgram,
          swap: { instructions: swapInstructions, amountIn: BigInt(builtSwap.quoteResponse.inAmount), minOut: BigInt(builtSwap.quoteResponse.otherAmountThreshold) },
          add: { instructions: addInstructions.flat(), quote: builtAdd.quote } })
        if (!assembly) return null
        steps = assembly.steps
        quote = builtAdd.quote; pool = builtAdd.pool; position = builtAdd.position
        note = 'One signature: the swap and the deposit run atomically through the composer, the deposit sized from what the swap really delivered'
      } else {
        const [removeStep, swapStep] = plan.steps as [RemoveStep, SwapStep]
        if (removeStep.kind !== 'remove' || swapStep.kind !== 'swap') return null
        const removeQuote = await options.router.liquidityQuote({ ...removeStep.intent, transactionVersion: version })
        const builtRemove = await options.router.liquidityBuild({ quoteId: removeQuote.quoteId, owner, transactionVersion: version })
        const removeInstructions = builtRemove.transactions.map((tx: any) => instructionsOf(tx.transaction))
        if (removeInstructions.some((ixs: RawInstruction[] | null) => ixs === null)) return null
        const fresh = await swapQuote(swapStep.inputMint, swapStep.outputMint, swapStep.amount, plan.slippageBps, version)
        const builtSwap = await options.router.buildSwap({ quoteResponse: fresh, userPublicKey: owner, wrapAndUnwrapSol: true, transactionVersion: version })
        if (builtSwap.composed === true) return null
        const swapInstructions = instructionsOf(builtSwap.swapTransaction)
        if (!swapInstructions) return null
        const tokenProgram = await mintTokenProgram(rpc, plan.mint)
        if (!tokenProgram) return null
        const assembly = assembleComposedZap({ direction: 'out', owner, tokenMint: plan.mint, tokenProgram,
          remove: { instructions: removeInstructions.flat() },
          swap: { instructions: swapInstructions, amountIn: BigInt(builtSwap.quoteResponse.inAmount), minOut: BigInt(builtSwap.quoteResponse.otherAmountThreshold) } })
        if (!assembly) return null
        steps = assembly.steps
        quote = builtRemove.quote; pool = builtRemove.pool; position = builtRemove.position
        note = 'One signature: the withdrawal and the swap back run atomically through the composer, the swap spending exactly what the withdrawal delivered'
      }
      const composed = composeZap(steps, { programId: new PublicKey(programId), payer })
      const latest = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])
      const blockhash = latest?.value?.blockhash, height = latest?.value?.lastValidBlockHeight
      if (typeof blockhash !== 'string' || !validPublicKey(blockhash) || !Number.isSafeInteger(height) || height < 1) return null
      const transaction = buildComposedTransaction({ payer, blockhash, version, programId: new PublicKey(programId), before: composed.before, compose: composed.compose, after: composed.after })
      return { step: 0, mode: 'composed' as ZapMode, kind: plan.direction === 'in' ? 'add' : 'remove',
        transactions: [{ transaction, lastValidBlockHeight: height, transactionVersion: version, expectedSigners: [owner] }],
        quote, pool, position, note }
    } catch { return null }
  }
  function validatePlanRequest(j: unknown) {
    if (!object(j)) fail('Invalid plan request')
    const owner = address(j.owner), mint = address(j.mint)
    if (mint === SOL_MINT) fail('Choose a token other than SOL')
    if (j.direction !== 'in' && j.direction !== 'out') fail('direction must be in or out')
    const preference = j.preference === undefined ? 'auto' : j.preference
    if (!['auto', 'constant', 'splash', 'concentrated'].includes(preference)) fail('preference must be auto, constant, splash or concentrated')
    const slippageBps = j.slippageBps === undefined ? 100 : j.slippageBps
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 1000) fail('Slippage must be 0–1000 basis points')
    const transactionVersion = j.transactionVersion === undefined ? '1' : String(j.transactionVersion)
    if (transactionVersion !== '1' && transactionVersion !== '0') fail('transactionVersion must be 1 or 0')
    if (j.direction === 'in') return { direction: 'in' as const, owner, mint, lamports: amount(j.amount), preference: preference as ZapPreference, ...(j.pool !== undefined ? { pool: address(j.pool) } : {}), slippageBps, transactionVersion }
    if (!object(j.position) || typeof j.position.venue !== 'string' || !isPoolStatsVenue(routingVenue(j.position.venue))) fail('position.venue must be a supported liquidity venue')
    const position = { venue: routingVenue(j.position.venue), pool: address(j.position.pool), ...(j.position.position !== undefined ? { position: address(j.position.position) } : {}) }
    return { direction: 'out' as const, owner, mint, position, slippageBps, transactionVersion }
  }
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, body: string): Promise<boolean> {
    const route = `${req.method}:${url.pathname}`
    if (route !== 'POST:/api/zap/solana/plan' && route !== 'POST:/api/zap/solana/build') return false
    try {
      if (Buffer.byteLength(body) > 32_000) throw new RequestError(413, 'Liquidity request is too large')
      let j: unknown
      try { j = JSON.parse(body) } catch { fail('Invalid JSON body') }
      const peer = String(req.headers['fly-client-ip'] ?? req.socket.remoteAddress ?? 'unknown').slice(0, 100)
      limit(`ip:${peer}:${route}`, RATE_CEILING); limit(`global:${route}`, RATE_CEILING * 20)
      prune()
      if (route.endsWith('/plan')) {
        const request = validatePlanRequest(j)
        const plan = request.direction === 'in' ? await planIn(request) : await planOut(request)
        if (plans.size >= MAX_PLANS) plans.delete(plans.keys().next().value!)
        plans.set(plan.planId, plan)
        reply(res, 200, publicPlan(plan))
      } else {
        if (!object(j) || typeof j.planId !== 'string' || !/^[0-9a-f-]{36}$/i.test(j.planId)) fail('Invalid plan ID')
        const owner = address(j.owner)
        if (!Number.isInteger(j.step) || j.step < 0) fail('Invalid plan step')
        const transactionVersion = j.transactionVersion === undefined ? undefined : String(j.transactionVersion)
        if (transactionVersion !== undefined && transactionVersion !== '1' && transactionVersion !== '0') fail('transactionVersion must be 1 or 0')
        const confirmed = j.confirmed === undefined ? [] : j.confirmed
        if (!Array.isArray(confirmed) || confirmed.length > MAX_CONFIRMED) fail(`confirmed must list up to ${MAX_CONFIRMED} transaction signatures`)
        const signatures = [...new Set(confirmed.map(signature))]
        const plan = plans.get(j.planId)
        if (!plan || plan.expiresAt <= now()) throw new RequestError(409, 'This plan expired. Request a fresh plan to continue.')
        if (plan.owner !== owner) throw new RequestError(409, 'This plan belongs to another wallet')
        if (j.step >= plan.steps.length) fail('Invalid plan step')
        if (j.step > 0) {
          if (signatures.length < j.step) throw new RequestError(409, `Confirm step ${j.step} before continuing`)
          await verifyConfirmed(signatures)
        }
        const version = (transactionVersion ?? plan.transactionVersion) as '1' | '0'
        // A composed plan starts as one transaction through the lp-zap composer;
        // unprovable builds fall through to the sequential stepper below.
        if (plan.mode === 'composed' && j.step === 0 && signatures.length === 0) {
          const composed = await buildComposedZap(plan, version)
          if (composed) { reply(res, 200, composed); return true }
        }
        reply(res, 200, await buildStep(plan, j.step, version))
      }
    } catch (e) {
      const { status, message } = clientError(e)
      if (status === 429) res.setHeader('retry-after', '60')
      reply(res, status, { error: message, ...(object(e) && object(e.suggest) ? { suggest: e.suggest } : {}) })
    }
    return true
  }
  return Object.assign(handle, { plans })
}
