// USD marks for the quote assets so every liquidity move reads in dollars.
export const prices: Record<string, number> = { USDC: 1, USDT: 1, USDG: 1, USD1: 1, PYUSD: 1 }

async function refresh() {
  for (const [sym, pair] of [['SOL', 'SOL-USD'], ['ETH', 'ETH-USD']] as const) {
    try {
      const r = await fetch(`https://api.coinbase.com/v2/prices/${pair}/spot`, { signal: AbortSignal.timeout(8000) })
      const j = await r.json() as any
      const v = Number(j?.data?.amount)
      if (v > 0) { prices[sym] = v; if (sym === 'ETH') prices.WETH = v }
    } catch {}
  }
}
void refresh()
setInterval(refresh, 60_000).unref()
