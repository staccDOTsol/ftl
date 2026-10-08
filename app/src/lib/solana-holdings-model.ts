// Pure types and helpers for "What can I do with what I'm holding". No network
// or platform imports, so these are unit-tested under plain node.
import bs58 from 'bs58'
import type { LiquidityPosition } from './solana-liquidity-model'
import type { PoolSummary, TokenSummary } from './types'

export type HoldingActionKind = 'exit' | 'unwrap' | 'sell' | 'add' | 'buy'
export interface HoldingAction { kind: HoldingActionKind; title: string; detail: string; href: string }
export interface HoldingToken {
  account: string; mint: string; amount: string; decimals: number; program: 'token' | 'token-2022'; wrappedSol: boolean
  token: TokenSummary | null; pools: PoolSummary[]
}
export interface Holdings {
  owner: string
  sol: { lamports: string }
  tokens: HoldingToken[]
  positions: { positions: LiquidityPosition[]; errors: { venue: string; error: string }[]; error?: string }
  actions: HoldingAction[]
}

export const SOL_MINT = 'So11111111111111111111111111111111111111112'

export function isSolanaAddress(value: string): boolean {
  const text = value.trim()
  if (text.length < 32 || text.length > 44) return false
  try { return bs58.decode(text).length === 32 } catch { return false }
}

export const shortAddress = (value: string) => value === SOL_MINT ? 'SOL' : `${value.slice(0, 4)}…${value.slice(-4)}`
export const holdingLabel = (holding: Pick<HoldingToken, 'mint' | 'wrappedSol' | 'token'>) =>
  holding.wrappedSol ? 'Wrapped SOL' : holding.token?.symbol ? `$${holding.token.symbol.slice(0, 14)}` : shortAddress(holding.mint)

// Only in-app token routes are followed; anything else from the server is ignored.
export const isActionHref = (href: string) => /^\/token\/solana\/[1-9A-HJ-NP-Za-km-z]{32,44}(\?action=(exit|sell|liquidity))?$/.test(href)

export const ACTION_LABEL: Record<HoldingActionKind, string> = { exit: 'Exit', unwrap: 'Unwrap', sell: 'Sell', add: 'Add liquidity', buy: 'Buy' }
