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

export interface SwapLink { inputMint: string; outputMint: string | null; amount: string }
// /swap?in=<mint|SOL>&out=<mint>&amount=<decimal>. Unusable values fall back
// to SOL in, nothing out, empty amount; equal sides drop the output.
export function parseSwapLink(params: { in?: string | string[]; out?: string | string[]; amount?: string | string[] } | null | undefined): SwapLink {
  const inputMint = resolveMintParam(params?.in) ?? SOL_MINT
  let outputMint = resolveMintParam(params?.out)
  if (outputMint === inputMint) outputMint = null
  const rawAmount = (Array.isArray(params?.amount) ? params?.amount[0] : params?.amount ?? '').trim()
  const amount = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(rawAmount) && Number(rawAmount) > 0 ? rawAmount : ''
  return { inputMint, outputMint, amount }
}

export function swapLink(inputMint: string, outputMint?: string | null, amount?: string | null): string {
  const query = new URLSearchParams()
  query.set('in', inputMint === SOL_MINT ? 'SOL' : inputMint)
  if (outputMint) query.set('out', outputMint === SOL_MINT ? 'SOL' : outputMint)
  if (amount && Number(amount) > 0) query.set('amount', amount)
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
