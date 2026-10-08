import type { TransactionVersion } from './solana-wire'

export type LiquidityOperation = 'initialize' | 'add' | 'remove'
export interface LiquidityParameter {
  name: string; label: string; type: string; required: boolean; default?: string | number | boolean
  options?: (string | { value: string | number; label: string })[]
  min?: number; max?: number
}
export interface LiquidityVenue {
  id: string; programIds: string[]; capabilities: LiquidityOperation[]
  parameters: Partial<Record<LiquidityOperation, LiquidityParameter[]>>
  reason?: string; note?: string
}
export interface LiquidityPosition {
  venue: string; pool: string; position: string; mintA: string; mintB: string; liquidity?: string | null
  removalMode?: 'percentage' | 'liquidity'
  amounts?: { mint: string; decimals: number; amount?: string; raw?: string }[]
}
export interface LiquidityIntent {
  venue: string; operation: LiquidityOperation; owner: string; pool?: string; mintA?: string; mintB?: string
  amountA?: string; amountB?: string; position?: string; liquidity?: string
  slippageBps: number; parameters: Record<string, string | number | boolean>; transactionVersion: TransactionVersion
}
export interface LiquidityQuote {
  quoteId: string; expiresAt: number; venue: string; operation: LiquidityOperation; pool: string
  mintA?: string; mintB?: string
  amounts: { mint: string; decimals: number; expectedRaw: string; limitRaw: string; direction: 'debit' | 'credit' }[]
  position?: string; slot: number; warnings?: string[]
  details?: Record<string, string | number | boolean | null>
}
export interface LiquidityTransaction { transaction: string; lastValidBlockHeight: number; expectedSigners: string[] }
export interface LiquidityBuild { transactions: LiquidityTransaction[]; pool: string; position?: string; quote: LiquidityQuote }
export function assertLiquidityQuote(quote: LiquidityQuote, intent: Pick<LiquidityIntent, 'venue' | 'operation' | 'pool' | 'position'>, now = Date.now()) {
  if (!quote.quoteId || quote.venue !== intent.venue || quote.operation !== intent.operation || (intent.pool && quote.pool !== intent.pool) ||
    (intent.position && quote.position !== intent.position) || !Number.isSafeInteger(quote.expiresAt) || quote.expiresAt <= now || !Array.isArray(quote.amounts) || (!quote.amounts.length && quote.operation !== 'initialize')) throw new Error('Liquidity quote changed or expired. Request a fresh quote.')
  for (const amount of quote.amounts) {
    if (!/^[0-9]+$/.test(amount.expectedRaw) || !/^[0-9]+$/.test(amount.limitRaw) || !Number.isInteger(amount.decimals) || amount.decimals < 0 || amount.decimals > 18 || !['debit', 'credit'].includes(amount.direction)) throw new Error('The venue returned invalid token amounts.')
    if ((amount.direction === 'debit' && BigInt(amount.limitRaw) < BigInt(amount.expectedRaw)) || (amount.direction === 'credit' && BigInt(amount.limitRaw) > BigInt(amount.expectedRaw))) throw new Error('The venue returned inconsistent amount limits.')
  }
}
export function assertApprovedLiquidity(approved: LiquidityQuote, built: LiquidityBuild) {
  assertLiquidityQuote(built.quote, approved)
  if (built.quote.quoteId !== approved.quoteId || built.pool !== approved.pool || built.position !== approved.position || !built.transactions.length || built.transactions.length > 12 ||
    JSON.stringify(built.quote.amounts) !== JSON.stringify(approved.amounts)) throw new Error('Liquidity instructions changed the approved amounts or position. Request a new quote.')
}

// ---- venue-published pool yield (server: /api/pool-stats/solana) -----------
export type PoolStatsVenue = 'raydium-cpmm' | 'raydium-clmm' | 'raydium-amm-v4' | 'orca' | 'meteora-dlmm' | 'meteora-damm' | 'meteora-damm-v2' | 'pumpswap'
export interface PoolStats {
  venue: PoolStatsVenue; pool: string
  tvlUsd: number | null; volume24hUsd: number | null; fees24hUsd: number | null
  feeRateBps: number | null
  /** Percent, 24h fees annualized (venue figure when it publishes one, else fees24h / tvl * 365 * 100). */
  feeApr: number | null; rewardApr: number | null; totalApr: number | null
  source: string; fetchedAt: number
}
export interface PoolStatsResult { venue: PoolStatsVenue; pool: string; stats: PoolStats | null; error?: string }
/** "Est. APR 12.4%" style label, or null when the venue gave nothing usable. */
export function aprLabel(stats: Pick<PoolStats, 'feeApr' | 'totalApr'> | null | undefined): string | null {
  const apr = stats?.totalApr ?? stats?.feeApr ?? null
  if (apr === null || !Number.isFinite(apr)) return null
  const digits = Math.abs(apr) >= 100 ? 0 : Math.abs(apr) >= 10 ? 1 : 2
  return `Est. APR ${apr >= 1_000_000 ? '>1M' : apr.toFixed(digits)}%`
}
/** Expected yearly fee income in USD for a deposit at today's volume (feeApr percent x deposit). */
export function estimateShare(stats: Pick<PoolStats, 'feeApr'> | null | undefined, depositUsd: number): number | null {
  if (!stats || stats.feeApr === null || !Number.isFinite(depositUsd) || depositUsd < 0) return null
  return depositUsd * stats.feeApr / 100
}
