import type { Chain, FlowEvent } from './types'

const QUOTES: Record<string, string> = {
  So11111111111111111111111111111111111111112: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB: 'USD1',
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': 'PYUSD',
  '0x0000000000000000000000000000000000000000': 'ETH',
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73': 'WETH',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168': 'USDG',
}
export const quoteSymbol = (mint: string | null | undefined) => (mint ? QUOTES[mint] : undefined)

export function short(a: string | null | undefined, n = 4): string {
  if (!a) return '—'
  return a.length > n * 2 + 3 ? `${a.slice(0, a.startsWith('0x') ? n + 2 : n)}…${a.slice(-n)}` : a
}

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

export function num(x: number | null | undefined, digits = 3): string {
  if (x === null || x === undefined || !isFinite(x)) return '—'
  const a = Math.abs(x)
  if (a === 0) return '0'
  if (a >= 1e9) return (x / 1e9).toFixed(2) + 'B'
  if (a >= 1e6) return (x / 1e6).toFixed(2) + 'M'
  if (a >= 1e4) return (x / 1e3).toFixed(1) + 'K'
  if (a >= 100) return x.toFixed(0)
  if (a >= 1) return x.toFixed(2)
  if (a >= 0.001) return x.toFixed(digits + 1).replace(/0+$/, '')
  return x.toExponential(1)
}

export const pct = (x: number) => `${(x * 100).toFixed(0)}%`

export function tokenLabel(e: { token: string | null; tokenMeta?: { symbol?: string; name?: string } }): string {
  if (e.tokenMeta?.symbol) return '$' + e.tokenMeta.symbol.slice(0, 14)
  return short(e.token)
}

export function quoteLeg(e: FlowEvent): string | null {
  if (e.quoteUi === null || e.quoteUi === undefined) return null
  const q = e.amounts.find(a => QUOTES[a.mint])
  return `${num(e.quoteUi)} ${q ? QUOTES[q.mint] : quoteSymbol(e.quote) ?? ''}`.trim()
}

export function explorerTx(chain: Chain, tx: string) {
  return chain === 'solana' ? `https://solscan.io/tx/${tx}` : `https://robinhoodchain.blockscout.com/tx/${tx}`
}
export function explorerAddr(chain: Chain, a: string) {
  return chain === 'solana' ? `https://solscan.io/account/${a}` : `https://robinhoodchain.blockscout.com/address/${a}`
}

export const VENUE_LABEL: Record<string, string> = {
  orca: 'Orca', 'raydium-clmm': 'Raydium CLMM', 'raydium-cpmm': 'Raydium CPMM', 'raydium-amm': 'Raydium AMM', 'raydium-launchlab': 'LaunchLab',
  'meteora-dlmm': 'Meteora DLMM', 'meteora-damm': 'Meteora DAMM', 'meteora-damm-v2': 'Meteora DAMM v2', 'meteora-dbc': 'Meteora DBC',
  pumpfun: 'pump.fun', pumpswap: 'PumpSwap', 'uniswap-v4': 'Uniswap v4', 'uniswap-v4-hook': 'v4 + hook', pons: 'Pons',
}
export const venue = (v: string) => VENUE_LABEL[v] ?? v

// dollar size of an event's quote leg, from the server's marks
export function usdOf(e: FlowEvent, prices?: Record<string, number>): number | null {
  if (e.quoteUi === null || e.quoteUi === undefined || !prices) return null
  const q = e.amounts.find(a => QUOTES[a.mint])
  const sym = q ? QUOTES[q.mint] : quoteSymbol(e.quote)
  const px = sym ? prices[sym] : undefined
  return px ? e.quoteUi * px : null
}

export function usd(x: number | null | undefined): string {
  if (x === null || x === undefined || !isFinite(x)) return '—'
  const a = Math.abs(x)
  if (a >= 1e6) return '$' + (x / 1e6).toFixed(2) + 'M'
  if (a >= 1e4) return '$' + (x / 1e3).toFixed(1) + 'K'
  if (a >= 1000) return '$' + (x / 1e3).toFixed(2) + 'K'
  if (a >= 10) return '$' + x.toFixed(0)
  if (a >= 0.01) return '$' + x.toFixed(2)
  if (a > 0) return 'dust'
  return '$0'
}

// 0..1 on a log scale from $1 to $100K: how loud a liquidity move is
export const loudness = (usdValue: number | null) => (usdValue && usdValue > 1 ? Math.min(1, Math.log10(usdValue) / 5) : 0)

// token images go through an image CDN: resized, webp, cached at the edge
export function img(url: string | undefined | null, size = 64): string | undefined {
  if (!url) return undefined
  const G = 'https://ipfs.filebase.io/ipfs/'
  const path = url.match(/^https?:\/\/[^/]+\/ipfs\/(.+)$/)
  const sub = url.match(/^https?:\/\/([a-z0-9]{46,})\.ipfs\.[^/]+\/?(.*)$/)
  const u = url.startsWith('ipfs://') ? G + url.slice(7) : path && !/filebase/.test(url) ? G + path[1] : sub ? G + sub[1] + (sub[2] ? '/' + sub[2] : '') : url
  return `https://wsrv.nl/?url=${encodeURIComponent(u)}&w=${size * 2}&h=${size * 2}&fit=cover&output=webp&maxage=7d`
}
