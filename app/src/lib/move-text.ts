// Words for a move: the tag on a post's move card, its amounts line, and the
// one-line body ShareMove prefills. Pure and import-free (type imports only)
// like the other models under test, so `node --test test/` can load it.
import type { Move } from './types'

const TAG: Record<Move['operation'], string> = { add: 'ADDED LP', remove: 'PULLED LP', initialize: 'OPENED POOL', swap: 'SWAPPED' }
const VERB: Record<Move['operation'], string> = { add: 'Added liquidity to', remove: 'Pulled liquidity from', initialize: 'Opened a pool for', swap: 'Swapped' }
const VENUE: Record<Move['venue'], string | null> = {
  'raydium-cpmm': 'Raydium CPMM', 'raydium-clmm': 'Raydium CLMM', 'raydium-amm-v4': 'Raydium AMM v4', orca: 'Orca',
  'meteora-dlmm': 'Meteora DLMM', 'meteora-damm': 'Meteora DAMM', 'meteora-damm-v2': 'Meteora DAMM v2', pumpswap: 'PumpSwap', swap: null,
}

export const moveVenue = (m: Move) => VENUE[m.venue] ?? (m.venue === 'swap' ? null : m.venue)

// "ADDED LP · Raydium CLMM"; a venue-less swap is just "SWAPPED"
export function moveTag(m: Move): string {
  const at = moveVenue(m)
  return at ? `${TAG[m.operation]} · ${at}` : TAG[m.operation]
}

// the same compaction as format.num, for decimal-string amounts
function compact(s: string): string {
  const x = Number(s)
  if (s === '' || !Number.isFinite(x)) return s
  const a = Math.abs(x)
  if (a === 0) return '0'
  if (a >= 1e9) return (x / 1e9).toFixed(2) + 'B'
  if (a >= 1e6) return (x / 1e6).toFixed(2) + 'M'
  if (a >= 1e4) return (x / 1e3).toFixed(1) + 'K'
  if (a >= 100) return x.toFixed(0)
  if (a >= 1) return x.toFixed(2).replace(/\.?0+$/, '')
  if (a >= 0.001) return x.toFixed(4).replace(/0+$/, '')
  return x.toExponential(1)
}
const shortMint = (a: string) => (a.length > 11 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a)

// "1.23K FTL + 0.25 SOL"
export function moveAmounts(m: Move): string | null {
  if (!m.amounts?.length) return null
  return m.amounts.map(a => `${compact(a.amount)} ${a.symbol ?? shortMint(a.mint)}`).join(' + ')
}

// The body ShareMove starts with. `label` is "$SYM" or a short address.
export function moveText(m: Move, label: string, side?: 'buy' | 'sell'): string {
  const at = moveVenue(m)
  if (m.operation === 'swap') return `${side === 'sell' ? 'Sold' : 'Bought'} ${label}${at ? ` on ${at}` : ''}`
  return `${VERB[m.operation]} ${label}${at ? ` on ${at}` : ''}`
}

export const txUrl = (tx: string) => `https://solscan.io/tx/${tx}`
