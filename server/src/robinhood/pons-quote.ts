// Direct Pons V2 curve quotes. The old generic router does not support the
// pre-graduation curve; all pricing inputs are read from the live contract.

import { config } from '../config.ts'
import { HttpError } from '../social.ts'

const FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e'
const ZERO = '0x0000000000000000000000000000000000000000'
const SELECTOR = {
  launch: '0x3cf28b5a',       // getLaunchedToken(address)
  reserves: '0x0902f1ac',    // getReserves()
  fee: '0x24a9d853',         // feeBps()
  tax: '0xc1bb8901',         // creatorTaxBps()
  reserved: '0x15a55347',    // reservedTokens()
  pair: '0x3de35b79',        // pairToken()
  graduated: '0xe7c2b772',  // graduated()
  buy: '0x59a87bc1',        // buy(uint256,uint256,address)
} as const

const addressRe = /^0x[0-9a-fA-F]{40}$/
const uintRe = /^(0|[1-9][0-9]*)$/
const word = (n: bigint | string) => typeof n === 'bigint'
  ? n.toString(16).padStart(64, '0')
  : n.toLowerCase().replace(/^0x/, '').padStart(64, '0')
const addressAt = (hex: string, index: number) =>
  `0x${hex.slice(2 + index * 64 + 24, 2 + (index + 1) * 64)}`.toLowerCase()
const uintAt = (hex: string, index: number) => BigInt(`0x${hex.slice(2 + index * 64, 2 + (index + 1) * 64)}`)

interface Call { to: string; data: string }

async function readCalls(calls: Call[]): Promise<string[]> {
  if (!config.rhHttp) throw new HttpError(503, 'Robinhood Chain quote RPC is unavailable')
  try {
    const request = calls.map((call, id) => ({ jsonrpc: '2.0', id,
      method: 'eth_call', params: [call, 'latest'] }))
    const response = await fetch(config.rhHttp, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
      signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`)
    const data = await response.json() as unknown
    if (!Array.isArray(data)) throw new Error('invalid RPC batch')
    const byId = new Map(data.map((item: any) => [item.id, item]))
    return calls.map((_, id) => {
      const result = byId.get(id)?.result
      if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result))
        throw new Error('RPC call failed')
      return result
    })
  } catch {
    throw new HttpError(503, 'Live Robinhood Chain quote is temporarily unavailable')
  }
}

export function curveBuyQuote(amount: bigint, quoteReserve: bigint, tokenReserve: bigint,
  reservedTokens: bigint, feeBps: bigint, creatorTaxBps: bigint): { tokensOut: bigint; spent: bigint } | null {
  if (amount <= 0n || quoteReserve <= 0n || tokenReserve <= reservedTokens ||
    feeBps + creatorTaxBps >= 10_000n) return null
  const net = amount - amount * feeBps / 10_000n - amount * creatorTaxBps / 10_000n
  if (net <= 0n) return null
  let tokensOut = net * tokenReserve / (quoteReserve + net)
  if (tokensOut <= 0n) return null
  let spent = amount
  const sellable = tokenReserve - reservedTokens
  if (tokensOut > sellable) {
    tokensOut = sellable
    // Mirrors the curve's clamped final fill and its round-up input math.
    const requiredNet = tokensOut * quoteReserve / (tokenReserve - tokensOut) + 1n
    spent = (requiredNet * 10_000n + (10_000n - feeBps - creatorTaxBps) - 1n) /
      (10_000n - feeBps - creatorTaxBps)
    if (spent > amount) spent = amount
  }
  return { tokensOut, spent }
}

function formatUnits(raw: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals)
  const whole = raw / base
  const fraction = (raw % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}

export async function quotePonsV2(q: URLSearchParams, tokenDecimals = 18): Promise<unknown | null> {
  const token = q.get('tokenOut') ?? ''
  if (q.get('tokenIn') !== 'ETH' || !addressRe.test(token)) return null
  const amountText = q.get('amount') ?? ''
  if (!uintRe.test(amountText) || amountText.length > 78) throw new HttpError(400, 'invalid ETH amount')
  const amount = BigInt(amountText)
  if (amount <= 0n || amount >= (1n << 256n)) throw new HttpError(400, 'invalid ETH amount')
  const recipient = q.get('recipient')
  if (recipient && !addressRe.test(recipient)) throw new HttpError(400, 'invalid recipient')
  const slippage = Number(q.get('slippage') ?? 5)
  if (!Number.isFinite(slippage) || slippage < 0.1 || slippage > 50)
    throw new HttpError(400, 'slippage must be between 0.1% and 50%')

  const [launch] = await readCalls([{ to: FACTORY, data: SELECTOR.launch + word(token) }])
  if (launch.length < 2 + 15 * 64 || uintAt(launch, 14) !== 1n || addressAt(launch, 0) !== token.toLowerCase())
    return null
  const curve = addressAt(launch, 1)
  if (curve === ZERO) throw new HttpError(503, 'Pons curve address is unavailable')
  // An ETH buy cannot use a curve denominated in another asset. Let the
  // on-chain v4 quote path try any live ETH pool for the same token.
  if (addressAt(launch, 4) !== ZERO) return null
  const [reserves, feeRaw, taxRaw, reservedRaw, pairRaw, graduatedRaw] = await readCalls([
    { to: curve, data: SELECTOR.reserves }, { to: curve, data: SELECTOR.fee },
    { to: curve, data: SELECTOR.tax }, { to: curve, data: SELECTOR.reserved },
    { to: curve, data: SELECTOR.pair }, { to: curve, data: SELECTOR.graduated },
  ])
  if (reserves.length < 2 + 128 || feeRaw.length < 66 || taxRaw.length < 66 ||
    reservedRaw.length < 66 || pairRaw.length < 66 || graduatedRaw.length < 66)
    throw new HttpError(503, 'Pons curve state is unavailable')
  // Graduated Pons tokens trade in their v4 pool, not on the closed curve.
  if (addressAt(pairRaw, 0) !== ZERO || uintAt(graduatedRaw, 0) !== 0n) return null
  const feeBps = uintAt(feeRaw, 0)
  const taxBps = uintAt(taxRaw, 0)
  const quote = curveBuyQuote(amount, uintAt(reserves, 0), uintAt(reserves, 1),
    uintAt(reservedRaw, 0), feeBps, taxBps)
  if (!quote) return null
  const minOut = quote.tokensOut * BigInt(Math.round((100 - slippage) * 100)) / 10_000n
  const calldata = SELECTOR.buy + word(amount) + word(minOut) + word(recipient ?? ZERO)
  return {
    quote: quote.tokensOut.toString(), quoteDecimals: formatUnits(quote.tokensOut, tokenDecimals),
    source: 'pons-v2-curve', curve, feeBps: Number(feeBps), creatorTaxBps: Number(taxBps),
    spent: quote.spent.toString(), minTokensOut: minOut.toString(),
    route: [[{ address: curve, fee: Number(feeBps + taxBps) * 100 }]],
    ...(recipient ? { methodParameters: { calldata, value: `0x${amount.toString(16)}`, to: curve } } : {}),
  }
}
