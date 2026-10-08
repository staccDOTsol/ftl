import { request, solanaRpc, decodeTransaction, encodeTransaction } from './solana'
import { inspectTransaction, type TransactionVersion } from './solana-wire'

import type { LiquidityIntent, LiquidityQuote, LiquidityVenue, LiquidityPosition, LiquidityBuild, LiquidityTransaction, PoolStatsResult } from './solana-liquidity-model'
export * from './solana-liquidity-model'

const endpoint = '/api/liquidity/solana'
export const liquidityCapabilities = () => request<{ venues: LiquidityVenue[] }>(`${endpoint}/capabilities`)
export const liquidityPositions = (owner: string, venue?: string, pool?: string) => request<{ positions: LiquidityPosition[]; errors?: { venue: string; error: string }[] }>(`${endpoint}/positions?${new URLSearchParams({ owner, ...(venue ? { venue } : {}), ...(pool ? { pool } : {}) })}`)
export const liquidityQuote = (intent: LiquidityIntent) => request<LiquidityQuote>(`${endpoint}/quote`, intent)
export const liquidityBuild = (quoteId: string, owner: string, transactionVersion: TransactionVersion) => request<LiquidityBuild>(`${endpoint}/build`, { quoteId, owner, transactionVersion })

export function assertLiquidityTransactionIntent(transaction: LiquidityTransaction, owner: string, version: TransactionVersion) {
  if (!Number.isSafeInteger(transaction.lastValidBlockHeight) || transaction.lastValidBlockHeight <= 0) throw new Error('The liquidity transaction has no valid expiry.')
  const wire = inspectTransaction(decodeTransaction(transaction.transaction))
  if (wire.version !== version || wire.feePayer !== owner || JSON.stringify(wire.signerKeys) !== JSON.stringify(transaction.expectedSigners)) throw new Error('The liquidity transaction has unexpected signers or a different transaction version.')
  return wire
}
export async function simulateLiquidity(transaction: LiquidityTransaction, owner: string, version: TransactionVersion) {
  const wire = assertLiquidityTransactionIntent(transaction, owner, version)
  const simulation = await solanaRpc<{ value: { err: unknown } }>('simulateTransaction', [transaction.transaction, { encoding: 'base64', commitment: 'confirmed', sigVerify: false, replaceRecentBlockhash: true }])
  if (simulation.value.err) throw new Error(`Liquidity simulation failed (${JSON.stringify(simulation.value.err)}). No transaction was sent.`)
  const fee = await solanaRpc<{ value: number | null }>('getFeeForMessage', [encodeTransaction(wire.message), { commitment: 'confirmed' }])
  if (fee.value === null || !Number.isSafeInteger(fee.value) || fee.value < 0) throw new Error('Could not verify the transaction network fee.')
  return fee.value
}

/** Venue-published TVL, 24h volume/fees and fee APR for up to 20 pools in one call. */
export const poolStats = (entries: { venue: string; pool: string }[]) => request<{ results: PoolStatsResult[] }>(`/api/pool-stats/solana?${new URLSearchParams({ pools: entries.slice(0, 20).map(e => `${e.venue}:${e.pool}`).join(',') })}`)
