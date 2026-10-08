// Pure types and rules for Simple liquidity (zap in from SOL, zap out to SOL).
// Mirrors server/src/solana/zap.ts for classification and the split so the UI
// can label and sanity-check a plan; no network or platform imports, so
// `node --test test/` loads it directly.
import type { LiquidityQuote, LiquidityTransaction, PoolStats } from './solana-liquidity-model'

export type PoolKind = 'constant' | 'splash' | 'concentrated'
export type ZapPreference = 'auto' | 'constant' | 'splash' | 'concentrated'
export type ZapDirection = 'in' | 'out'
/** 'sequential' = one prebuilt transaction per step; a later 'composed' mode will carry the same steps as raw instructions. */
export type ZapMode = 'sequential'
export interface RawInstruction { programId: string; keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }
export const SOL_MINT = 'So11111111111111111111111111111111111111112'
export const CONSTANT_VENUES: ReadonlySet<string> = new Set(['pumpswap', 'raydium-cpmm', 'raydium-amm-v4', 'meteora-damm', 'meteora-damm-v2'])
export const SPLASH_TICK_SPACING = 32896
export const SPLIT_BUFFER_BPS = 50n
export const ZAP_KEY = 'liquidityxyz.solana.zap.v1'
export const KIND_LABEL: Record<PoolKind, string> = { constant: 'Constant product', splash: 'Splash pool', concentrated: 'Concentrated · auto range' }
export const PREFERENCE_OPTIONS: { value: ZapPreference; label: string }[] = [{ value: 'auto', label: 'Auto' }, { value: 'constant', label: 'Constant' }, { value: 'splash', label: 'Splash' }, { value: 'concentrated', label: 'Concentrated' }]
/** Venues whose positions only list per pool; the withdraw list reads those for the token's own pools. */
export const POOL_SCOPED_VENUES: ReadonlySet<string> = new Set(['raydium-cpmm', 'raydium-amm-v4', 'meteora-damm', 'pumpswap'])

export interface ZapSwapStep { kind: 'swap'; title: string; inputMint: string; outputMint: string; amount: string; expectedOut: string; minOut: string; slippageBps: number }
export interface ZapAddStep { kind: 'add'; title: string; venue: string; pool: string; mintA: string; mintB: string; tokenAmount: string; solAmount: string; parameters: Record<string, string | number | boolean>; quote: LiquidityQuote }
export interface ZapRemoveStep { kind: 'remove'; title: string; venue: string; pool: string; position: string; quote: LiquidityQuote }
export type ZapStep = ZapSwapStep | ZapAddStep | ZapRemoveStep
export interface ZapPoolChoice { venue: string; pool: string; kind: PoolKind; mintA: string; mintB: string; stats?: PoolStats | null; reason: string }
export interface ZapAlternative { venue: string; pool: string; kind: PoolKind; stats?: PoolStats | null }
export interface ZapEstimate { depositSol?: string; positionValueSol?: string; receiveSol?: string; tokenExpected?: string; tokenDecimals?: number; networkFeeSolApprox: string }
export interface ZapPlan {
  planId: string; mode?: ZapMode; direction: ZapDirection; mint: string; owner: string; transactionVersion: '1' | '0'; slippageBps: number
  pool: ZapPoolChoice; alternatives: ZapAlternative[]; steps: ZapStep[]; estimate: ZapEstimate; expiresAt: number
}
export interface ZapBuild { step: number; mode?: ZapMode; kind: ZapStep['kind']; transactions: (LiquidityTransaction & { instructions?: RawInstruction[] | null })[]; quote: any; pool?: string; position?: string; note?: string }
export interface ZapPlanRequest { owner: string; mint: string; direction: ZapDirection; amount?: string; position?: { venue: string; pool: string; position?: string }; preference?: ZapPreference; slippageBps?: number; transactionVersion?: '1' | '0' }

export const routingVenue = (id: string) => id === 'raydium-amm' ? 'raydium-amm-v4' : id
export function classifyPool(venue: string, stats?: Pick<PoolStats, 'tickSpacing'> | null): PoolKind {
  const id = routingVenue(venue)
  if (CONSTANT_VENUES.has(id)) return 'constant'
  if (id === 'orca' && stats?.tickSpacing === SPLASH_TICK_SPACING) return 'splash'
  return 'concentrated'
}
/** Same arithmetic as the server: 0.5% buffer, then half swaps and half stays SOL. */
export function splitDeposit(lamports: bigint): { swap: bigint; keep: bigint; buffer: bigint } {
  if (lamports <= 0n) throw new Error('Enter a positive SOL amount.')
  const buffer = lamports * SPLIT_BUFFER_BPS / 10_000n
  const usable = lamports - buffer
  const swap = usable / 2n
  return { swap, keep: usable - swap, buffer }
}

// ---- display helpers --------------------------------------------------------
// Same rule as swap-link.trimSignificant (kept local so this module stays import-free).
function trimSignificant(text: string, digits: number): string {
  const [whole, fraction = ''] = text.split('.')
  if (!fraction) return whole
  const keep = whole !== '0' ? Math.max(0, digits - whole.length) : digits + (fraction.match(/^0*/)?.[0].length ?? 0)
  const cut = fraction.slice(0, keep).replace(/0+$/, '')
  return cut ? `${whole}.${cut}` : whole
}
const decimalText = (raw: string | bigint, decimals: number) => {
  const value = BigInt(raw), scale = 10n ** BigInt(decimals)
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${value / scale}${fraction ? `.${fraction}` : ''}`
}
/** "1,234.56" style: thousands groups in the whole part, up to six significant fraction digits. */
export function compactAmount(raw: string | bigint, decimals: number): string {
  const text = trimSignificant(decimalText(raw, decimals), 6)
  const [whole, fraction] = text.split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fraction ? `${grouped}.${fraction}` : grouped
}
const amountOf = (quote: LiquidityQuote | undefined, mint: string, direction: 'debit' | 'credit') => quote?.amounts?.find(a => a.mint === mint && a.direction === direction)
/** "≈ 0.4975 SOL + 1,200 $SYM as LP" for a deposit, "≈ 0.0325 SOL" for a withdrawal. */
export function estimateLine(plan: ZapPlan, symbol: string): string {
  if (plan.direction === 'out') return plan.estimate.receiveSol ? `≈ ${trimSignificant(plan.estimate.receiveSol, 6)} SOL` : 'Estimating…'
  const add = plan.steps.find((s): s is ZapAddStep => s.kind === 'add')
  const swap = plan.steps.find((s): s is ZapSwapStep => s.kind === 'swap')
  const sol = amountOf(add?.quote, SOL_MINT, 'debit'), token = amountOf(add?.quote, plan.mint, 'debit')
  const solText = sol ? compactAmount(sol.expectedRaw, sol.decimals) : plan.estimate.positionValueSol && swap ? trimSignificant(plan.estimate.positionValueSol, 6) : null
  const tokenText = token ? compactAmount(token.expectedRaw, token.decimals) : swap && plan.estimate.tokenDecimals !== undefined ? compactAmount(swap.expectedOut, plan.estimate.tokenDecimals) : null
  if (!solText || !tokenText) return 'Estimating…'
  return `≈ ${solText} SOL + ${tokenText} ${symbol} as LP`
}
/** "1/2 Swapping 0.05 SOL → $SYM" */
export const stepLabel = (index: number, total: number, title: string) => `${index + 1}/${total} ${title}`

// ---- resumable progress (localStorage) --------------------------------------
export interface ZapDone { step: number; kind: ZapStep['kind']; quote: any; pool?: string; position?: string; signatures: string[] }
export interface ZapProgress {
  planId: string; owner: string; version: '1' | '0'; direction: ZapDirection; mint: string; venue: string; pool: string
  titles: string[]; step: number; confirmed: string[]; done: ZapDone[]; expiresAt: number
  built?: { step: number; kind?: ZapStep['kind']; transactions: LiquidityTransaction[]; next: number; quote: any; pool?: string; position?: string; note?: string }
  pending?: { signature: string; lastValidBlockHeight: number }
}
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/
export function parseZapProgress(stored: string | null | undefined): ZapProgress | null {
  try {
    const v = JSON.parse(stored || 'null')
    if (!v || typeof v !== 'object' || typeof v.planId !== 'string' || typeof v.owner !== 'string' || !['1', '0'].includes(v.version) || !['in', 'out'].includes(v.direction) || typeof v.mint !== 'string' || typeof v.venue !== 'string' || typeof v.pool !== 'string') return null
    if (!Array.isArray(v.titles) || !v.titles.length || v.titles.length > 4 || !Number.isInteger(v.step) || v.step < 0 || v.step > v.titles.length || !Array.isArray(v.confirmed) || !v.confirmed.every((s: unknown) => typeof s === 'string' && SIGNATURE.test(s)) || !Array.isArray(v.done) || !Number.isSafeInteger(v.expiresAt)) return null
    if (v.built !== undefined && (!v.built || v.built.step !== v.step || !Array.isArray(v.built.transactions) || !v.built.transactions.length || v.built.transactions.length > 12 || !Number.isInteger(v.built.next) || v.built.next < 0 || v.built.next > v.built.transactions.length)) return null
    if (v.pending !== undefined && (!v.pending || typeof v.pending.signature !== 'string' || !SIGNATURE.test(v.pending.signature) || !Number.isSafeInteger(v.pending.lastValidBlockHeight))) return null
    return v as ZapProgress
  } catch { return null }
}
