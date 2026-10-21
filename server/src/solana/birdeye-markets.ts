// Lazy pool discovery for pairs FTL does not index. Young-liquidity rows miss
// established markets (SOL/USDT). One Birdeye market list, cached, and only
// the venues the direct router can already price.
import { PublicKey } from '@solana/web3.js'
import { canonicalPumpPoolPda } from '@pump-fun/pump-swap-sdk'
import type { DirectPool } from './direct-adapter.ts'

const BIRDEYE = 'https://public-api.birdeye.so/defi/v2/markets'
const TTL_MS = 60_000
const MISS_MS = 15_000
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

type Cache = { at: number; rows: DirectPool[] }
const cache = new Map<string, Cache>()

/** Birdeye `source` → a venue this process can quote and build. Unknown venues stay out. */
export function venueOfSource(source: string): string | null {
  const s = source.trim().toLowerCase()
  if (s.includes('clamm') || s.includes('clmm')) return 'raydium-clmm'
  if (s.includes('cpmm') || s.includes('cp swap')) return 'raydium-cpmm'
  if (s.includes('whirlpool') || s === 'orca') return 'orca'
  if (s.includes('dlmm')) return 'meteora-dlmm'
  if (s.includes('damm v2') || s.includes('damm-v2')) return 'meteora-damm-v2'
  if (s.includes('pumpswap') || s.includes('pump amm') || s.includes('pump.fun amm')) return 'pumpswap'
  return null
}

function mintOf(side: unknown): string | null {
  if (!side || typeof side !== 'object') return null
  const address = (side as { address?: unknown }).address
  return typeof address === 'string' && B58.test(address) ? address : null
}

const WSOL = 'So11111111111111111111111111111111111111112'
/** A pump.fun coin graduates into one canonical PumpSwap pool against WSOL, derivable from the mint alone. Birdeye's
 *  market list often misses it for young coins, so a SOL pair always gets it as a candidate (a coin that never graduated
 *  has no account there and the quote simply skips it). */
function canonicalPump(inputMint: string, outputMint: string): DirectPool[] {
  const coin = inputMint === WSOL ? outputMint : outputMint === WSOL ? inputMint : null
  // only pump.fun launches graduate there, and their mints carry the `pump` vanity suffix
  if (!coin || coin === WSOL || !coin.endsWith('pump')) return []
  try {
    return [{ address: canonicalPumpPoolPda(new PublicKey(coin)).toBase58(), venue: 'pumpswap', mint_a: coin, mint_b: WSOL, liq_events: 1 }]
  } catch { return [] }
}
const withCanonical = (rows: DirectPool[], inputMint: string, outputMint: string) => {
  const extra = canonicalPump(inputMint, outputMint).filter(c => !rows.some(r => r.address === c.address))
  return [...rows, ...extra]
}

/** Deepest supported pools for this exact pair, plus the canonical PumpSwap pool of a SOL pair. */
export async function discoverPools(inputMint: string, outputMint: string, fetcher: typeof fetch = fetch): Promise<DirectPool[]> {
  const key = process.env.BIRDEYE_API_KEY?.trim()
  if (!B58.test(inputMint) || !B58.test(outputMint) || inputMint === outputMint) return []
  if (!key) return canonicalPump(inputMint, outputMint)
  const id = inputMint < outputMint ? `${inputMint}:${outputMint}` : `${outputMint}:${inputMint}`
  const hit = cache.get(id)
  const now = Date.now()
  if (hit && now - hit.at < (hit.rows.length ? TTL_MS : MISS_MS)) return withCanonical(hit.rows, inputMint, outputMint)
  // Markets are listed per token, top 20 by liquidity. Ask for the side whose list the pair can make: a quote
  // asset (SOL, USDC, USDT) has thousands of markets and the coin's pool rarely makes its top 20, so ask the coin.
  const QUOTES = new Set(['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'])
  const asked = QUOTES.has(inputMint) && !QUOTES.has(outputMint) ? outputMint
    : QUOTES.has(outputMint) && !QUOTES.has(inputMint) ? inputMint
    : inputMint === 'So11111111111111111111111111111111111111112' ? outputMint : inputMint
  let rows: DirectPool[] = []
  try {
    const url = `${BIRDEYE}?address=${asked}&sort_by=liquidity&sort_type=desc&offset=0&limit=20`
    const response = await fetcher(url, {
      headers: { 'X-API-KEY': key, 'x-chain': 'solana', accept: 'application/json' },
      signal: AbortSignal.timeout(4_000),
    })
    if (response.ok) {
      const body = await response.json() as { data?: { items?: unknown[] } }
      const items = Array.isArray(body?.data?.items) ? body.data.items : []
      const found: DirectPool[] = []
      for (const item of items) {
        if (!item || typeof item !== 'object') continue
        const row = item as { address?: unknown; source?: unknown; liquidity?: unknown; base?: unknown; quote?: unknown }
        const address = typeof row.address === 'string' && B58.test(row.address) ? row.address : null
        const venue = typeof row.source === 'string' ? venueOfSource(row.source) : null
        const a = mintOf(row.base), b = mintOf(row.quote)
        if (!address || !venue || !a || !b) continue
        if (!((a === inputMint && b === outputMint) || (a === outputMint && b === inputMint))) continue
        const liquidity = typeof row.liquidity === 'number' && Number.isFinite(row.liquidity) ? row.liquidity : 0
        found.push({ address, venue, mint_a: a, mint_b: b, liq_events: Math.max(1, Math.round(liquidity)) })
      }
      found.sort((x, y) => y.liq_events - x.liq_events)
      rows = found.slice(0, 3)
    }
  } catch {
    rows = []
  }
  cache.set(id, { at: now, rows })
  if (cache.size > 400) {
    for (const [k, v] of cache) if (now - v.at > TTL_MS) cache.delete(k)
  }
  return withCanonical(rows, inputMint, outputMint)
}
