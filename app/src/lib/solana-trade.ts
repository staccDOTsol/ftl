// Pure amount and quote rules. Keep all executable amounts in integer units.
export const SOL_MINT = 'So11111111111111111111111111111111111111112'
export const QUOTE_TTL_MS = 30_000
export const SOL_RESERVE = 10_000_000n
const MAX_U64 = 18_446_744_073_709_551_615n

export function toAtomic(value: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('Unsupported token decimals.')
  const text = value.trim()
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) throw new Error('Enter a positive amount.')
  const [whole = '', fraction = ''] = text.split('.')
  if (fraction.length > decimals) throw new Error(`This token supports ${decimals} decimal places.`)
  const raw = BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')
  if (raw <= 0n || raw > MAX_U64) throw new Error('Amount is outside this token’s supported range.')
  return raw.toString()
}

export function fromAtomic(raw: string | bigint, decimals: number): string {
  const value = BigInt(raw)
  const scale = 10n ** BigInt(decimals)
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${value / scale}${fraction ? `.${fraction}` : ''}`
}

export function balancePercent(raw: string, percent: number, isSol: boolean): string {
  if (![10, 25, 50, 100].includes(percent)) throw new Error('Invalid balance percentage.')
  const spendable = BigInt(raw) - (isSol ? SOL_RESERVE : 0n)
  return ((spendable > 0n ? spendable : 0n) * BigInt(percent) / 100n).toString()
}

export interface SolanaQuote {
  inputMint: string
  outputMint: string
  inAmount: string
  outAmount: string
  otherAmountThreshold: string
  swapMode: string
  slippageBps: number
  priceImpactPct: string | null
  platformFee?: { amount: string; feeBps: number } | null
  composed?: boolean
  hops?: number
  composerFeeBps?: number
  contextSlot: number
  transactionVersion?: '0' | '1'
  routePlan: { percent: number; swapInfo?: {
    ammKey: string; label?: string; inputMint: string; outputMint: string
    inAmount: string; outAmount: string; feeAmount: string; feeMint: string
  } | null }[]
}

// Only show an atomic/composer claim when the quote advertises the capability.
// The server quotes composed outputs net of each hop's in-kind fee.
export function composerFeeLabel(quote: Pick<SolanaQuote, 'composed' | 'hops' | 'composerFeeBps'>): string | null {
  if (quote.composed !== true || !Number.isInteger(quote.hops) || quote.hops! < 2 || quote.hops! > 8) return null
  if (!Number.isInteger(quote.composerFeeBps) || quote.composerFeeBps! < 0 || quote.composerFeeBps! > 10_000) return 'Fee not reported'
  return `${quote.composerFeeBps! / 100}% per hop · ${quote.hops} hops · in kind`
}

export interface QuoteIntent { inputMint: string; outputMint: string; amount: string; slippageBps: number; transactionVersion?: '0' | '1' }

export function assertQuoteMatches(quote: SolanaQuote, intent: QuoteIntent) {
  if (quote.inputMint !== intent.inputMint || quote.outputMint !== intent.outputMint || quote.inAmount !== intent.amount ||
      quote.swapMode !== 'ExactIn' || quote.slippageBps !== intent.slippageBps || (intent.transactionVersion !== undefined && quote.transactionVersion !== intent.transactionVersion) || !quote.routePlan?.length ||
      !/^\d+$/.test(quote.outAmount) || !/^\d+$/.test(quote.otherAmountThreshold) ||
      BigInt(quote.outAmount) <= 0n || BigInt(quote.otherAmountThreshold) <= 0n ||
      BigInt(quote.otherAmountThreshold) > BigInt(quote.outAmount)) {
    throw new Error('The quote does not match this trade. Request a fresh quote.')
  }
}

export function isQuoteFresh(receivedAt: number, now = Date.now()) {
  return receivedAt > 0 && now >= receivedAt && now - receivedAt < QUOTE_TTL_MS
}

export const shortMint = (mint: string) => mint === SOL_MINT ? 'SOL' : `${mint.slice(0, 4)}…${mint.slice(-4)}`
