// Pure helpers for the swap terminal: deep links, rate lines, well-known mints.
// Dependency-free on purpose so `node --test` can load it without a bundler.
export const SOL_MINT = 'So11111111111111111111111111111111111111112'

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'

export interface KnownToken { mint: string; symbol: string; name: string; decimals: number }
export const KNOWN_TOKENS: KnownToken[] = [
  { mint: SOL_MINT, symbol: 'SOL', name: 'Solana', decimals: 9 },
  { mint: USDC_MINT, symbol: 'USDC', name: 'USD Coin', decimals: 6 },
  { mint: USDT_MINT, symbol: 'USDT', name: 'Tether USD', decimals: 6 },
]

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
export const isMintLike = (value: string) => BASE58.test(value.trim())

// Accepts a symbol from the quick list (case-insensitive) or a base58 mint.
export function resolveMintParam(value: string | string[] | null | undefined): string | null {
  const text = (Array.isArray(value) ? value[0] : value ?? '').trim()
  if (!text) return null
  const known = KNOWN_TOKENS.find(token => token.symbol.toLowerCase() === text.toLowerCase())
  if (known) return known.mint
  return isMintLike(text) ? text : null
}

export type SwapMode = 'swap' | 'liquidity'
export type SwapLinkAction = 'exit' | null
export interface SwapLink { inputMint: string; outputMint: string | null; amount: string; mode: SwapMode; pool: string | null; action: SwapLinkAction; advanced: boolean }
type LinkParam = string | string[] | undefined
const first = (value: LinkParam) => (Array.isArray(value) ? value[0] : value ?? '').trim()
// /swap?in=<mint|SOL>&out=<mint>&amount=<decimal>[&mode=liquidity&pool=<address>&action=exit&advanced=1].
// Unusable values fall back to SOL in, nothing out, empty amount, Swap mode;
// equal sides drop the output. `pool`, `action` and `advanced` only matter in
// Liquidity mode: Simple deposit by default, `action=exit` opens Simple
// withdraw, `advanced=1` opens the venue/pool/range form.
export function parseSwapLink(params: { in?: LinkParam; out?: LinkParam; amount?: LinkParam; mode?: LinkParam; pool?: LinkParam; action?: LinkParam; advanced?: LinkParam } | null | undefined): SwapLink {
  const inputMint = resolveMintParam(params?.in) ?? SOL_MINT
  let outputMint = resolveMintParam(params?.out)
  if (outputMint === inputMint) outputMint = null
  const rawAmount = first(params?.amount)
  const amount = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(rawAmount) && Number(rawAmount) > 0 ? rawAmount : ''
  const mode: SwapMode = first(params?.mode).toLowerCase() === 'liquidity' ? 'liquidity' : 'swap'
  const rawPool = first(params?.pool)
  const pool = mode === 'liquidity' && isMintLike(rawPool) ? rawPool : null
  const action: SwapLinkAction = mode === 'liquidity' && first(params?.action).toLowerCase() === 'exit' ? 'exit' : null
  const advanced = mode === 'liquidity' && ['1', 'true'].includes(first(params?.advanced).toLowerCase())
  return { inputMint, outputMint, amount, mode, pool, action, advanced }
}

export function swapLink(inputMint: string, outputMint?: string | null, amount?: string | null, options?: { mode?: SwapMode; pool?: string | null; action?: SwapLinkAction; advanced?: boolean }): string {
  const query = new URLSearchParams()
  if (options?.mode === 'liquidity') query.set('mode', 'liquidity')
  query.set('in', inputMint === SOL_MINT ? 'SOL' : inputMint)
  if (outputMint) query.set('out', outputMint === SOL_MINT ? 'SOL' : outputMint)
  if (amount && Number(amount) > 0) query.set('amount', amount)
  if (options?.mode === 'liquidity' && options.pool) query.set('pool', options.pool)
  if (options?.mode === 'liquidity' && options.action) query.set('action', options.action)
  if (options?.mode === 'liquidity' && options.advanced) query.set('advanced', '1')
  return `/swap?${query}`
}
// Liquidity mode on one token: /swap?mode=liquidity&out=<mint>[&pool=<address>][&action=exit][&advanced=1]
export function liquidityLink(mint: string, pool?: string | null, action?: SwapLinkAction, advanced = false): string {
  const query = new URLSearchParams({ mode: 'liquidity', out: mint })
  if (pool) query.set('pool', pool)
  if (action) query.set('action', action)
  if (advanced) query.set('advanced', '1')
  return `/swap?${query}`
}

// "1 X ≈ Y Z": out/in with exact integer arithmetic, trimmed to a readable
// precision. Returns null when either side is zero.
export function rateString(inRaw: string | bigint, inDecimals: number, outRaw: string | bigint, outDecimals: number): string | null {
  const input = BigInt(inRaw), output = BigInt(outRaw)
  if (input <= 0n || output <= 0n) return null
  const PRECISION = 12
  // output per one whole input unit, carried at PRECISION extra decimals
  const scaled = output * 10n ** BigInt(inDecimals + PRECISION) / input
  return trimSignificant(decimalString(scaled, outDecimals + PRECISION), 6)
}

function decimalString(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals)
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${value / scale}${fraction ? `.${fraction}` : ''}`
}

// Keeps up to `digits` significant figures after any leading zeros, so tiny
// rates like 0.0000012345 stay meaningful while 1234.5678 shortens to 1234.57.
export function trimSignificant(text: string, digits: number): string {
  const [whole, fraction = ''] = text.split('.')
  if (!fraction) return whole
  const keep = whole !== '0' ? Math.max(0, digits - whole.length) : digits + (fraction.match(/^0*/)?.[0].length ?? 0)
  const cut = fraction.slice(0, keep).replace(/0+$/, '')
  return cut ? `${whole}.${cut}` : whole
}

export const formatBps = (bps: number) => `${(bps / 100).toString()}%`
