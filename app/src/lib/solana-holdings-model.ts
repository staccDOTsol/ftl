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

// Only in-app token routes (and the swap terminal's Liquidity mode) are
// followed; anything else from the server is ignored.
const TOKEN_HREF = /^\/token\/solana\/([1-9A-HJ-NP-Za-km-z]{32,44})(\?action=(exit|sell|liquidity))?$/
const LIQUIDITY_HREF = /^\/swap\?mode=liquidity&out=[1-9A-HJ-NP-Za-km-z]{32,44}(&pool=[1-9A-HJ-NP-Za-km-z]{32,44})?(&action=exit)?$/
export const isActionHref = (href: string) => TOKEN_HREF.test(href) || LIQUIDITY_HREF.test(href)
// The mint a server action points at, when it is a token-page link.
export const actionMint = (href: string): string | null => href.match(TOKEN_HREF)?.[1] ?? null
// The token page 404s for a mint FTL has no row for; "add" and "exit" then go
// to the swap terminal's Liquidity mode instead (with the position's pool).
export function liquidityActionHref(action: Pick<HoldingAction, 'kind' | 'href' | 'detail'>, seen: (mint: string) => boolean, positions: Pick<LiquidityPosition, 'mintA' | 'mintB' | 'pool'>[]): string {
  const mint = actionMint(action.href)
  if (!mint || (action.kind !== 'add' && action.kind !== 'exit') || seen(mint)) return action.href
  const pool = action.kind === 'exit' ? positions.find(p => (p.mintA === mint || p.mintB === mint) && action.detail.includes(shortAddress(p.pool)))?.pool : null
  const query = new URLSearchParams({ mode: 'liquidity', out: mint })
  if (pool) query.set('pool', pool)
  if (action.kind === 'exit') query.set('action', 'exit')
  return `/swap?${query}`
}

export const ACTION_LABEL: Record<HoldingActionKind, string> = { exit: 'Exit', unwrap: 'Unwrap', sell: 'Sell', add: 'Add liquidity', buy: 'Buy' }
