// Real yield estimates for Solana liquidity pools, read from each venue's own
// public pool-stats API (the same endpoints their websites call). Everything is
// normalized to USD and percent; see pool-stats.md for the per-venue field map.
// Upstream URLs never appear in replies or error messages.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { validPublicKey } from './router.ts'

export const POOL_STATS_VENUES = ['raydium-cpmm', 'raydium-clmm', 'raydium-amm-v4', 'orca', 'meteora-dlmm', 'meteora-damm', 'meteora-damm-v2', 'pumpswap'] as const
export type PoolStatsVenue = typeof POOL_STATS_VENUES[number]
export interface PoolStats {
  venue: PoolStatsVenue; pool: string
  tvlUsd: number | null; volume24hUsd: number | null; fees24hUsd: number | null
  feeRateBps: number | null
  /** Percent. 24h fees annualized: the venue's own figure when it publishes one, else fees24h / tvl * 365 * 100. */
  feeApr: number | null
  /** Percent. Farm / emission rewards as the venue reports them (null when the venue reports none). */
  rewardApr: number | null
  totalApr: number | null
  /** Orca only: the whirlpool's tick spacing (32896 marks a Splash pool). */
  tickSpacing?: number | null
  source: string; fetchedAt: number
}
export type PoolStatsFetcher = (url: string, init: RequestInit) => Promise<Response>
export interface PoolStatsOptions { now?: () => number; timeoutMs?: number }
export class PoolStatsError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status } }

const CACHE_TTL = 60_000
const CACHE_MAX = 5_000
const TIMEOUT = 8_000
const MAX_RESPONSE = 2_000_000
const MAX_BATCH = 20
const RATE_CEILING = 60
const RAYDIUM_PROGRAMS: Record<string, PoolStatsVenue> = {
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'raydium-cpmm',
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'raydium-clmm',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'raydium-amm-v4',
}
// PumpSwap's HTTP API carries no fee field. These are the LP shares of the
// on-chain pump-fees FeeConfig read on 2026-10-08: flat 25 bps for pools that
// are not canonical pump graduations, 20 bps on every canonical tier above the
// sub-420-SOL launch tier (pool-stats.md records the full schedule).
export const PUMPSWAP_LP_FEE_BPS = { flat: 25, canonical: 20 } as const

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
const pct = (v: unknown): number | null => { const n = num(v); return n === null ? null : n }
const bad = (): never => { throw new PoolStatsError(502, 'Pool stats service returned an unexpected response') }
const notFound = (venue: string): never => { throw new PoolStatsError(404, `Pool was not found on ${venue}`) }
/** Annualize one day of fees over TVL, in percent; null when either side is unknown or TVL is zero. */
export function annualize(fees24hUsd: number | null, tvlUsd: number | null): number | null {
  if (fees24hUsd === null || tvlUsd === null || tvlUsd <= 0) return null
  return fees24hUsd / tvlUsd * 365 * 100
}
/** Expected yearly fee income in USD for a deposit at today's volume (feeApr percent x deposit). */
export function estimateShare(stats: Pick<PoolStats, 'feeApr'>, depositUsd: number): number | null {
  if (stats.feeApr === null || !Number.isFinite(depositUsd) || depositUsd < 0) return null
  return depositUsd * stats.feeApr / 100
}

function finish(base: Omit<PoolStats, 'feeApr' | 'totalApr' | 'fetchedAt'> & { feeApr?: number | null }, fetchedAt: number): PoolStats {
  const feeApr = base.feeApr ?? annualize(base.fees24hUsd, base.tvlUsd)
  const totalApr = feeApr === null && base.rewardApr === null ? null : (feeApr ?? 0) + (base.rewardApr ?? 0)
  return { venue: base.venue, pool: base.pool, tvlUsd: base.tvlUsd, volume24hUsd: base.volume24hUsd, fees24hUsd: base.fees24hUsd,
    feeRateBps: base.feeRateBps, feeApr, rewardApr: base.rewardApr, totalApr, ...(base.tickSpacing !== undefined ? { tickSpacing: base.tickSpacing } : {}), source: base.source, fetchedAt }
}

type Upstream = (url: string) => Promise<any>
const venues: Record<PoolStatsVenue, (pool: string, get: Upstream) => Promise<Omit<PoolStats, 'fetchedAt' | 'feeApr' | 'totalApr'> & { feeApr?: number | null; tickSpacing?: number | null }>> = {
  'raydium-cpmm': (pool, get) => raydium('raydium-cpmm', pool, get),
  'raydium-clmm': (pool, get) => raydium('raydium-clmm', pool, get),
  'raydium-amm-v4': (pool, get) => raydium('raydium-amm-v4', pool, get),
  async orca(pool, get) {
    const data = (await get(`https://api.orca.so/v2/solana/pools/${pool}`))?.data
    if (!object(data) || data.address !== pool) notFound('orca')
    const day = object(data.stats) && object(data.stats['24h']) ? data.stats['24h'] : {}
    const tvlUsd = num(data.tvlUsdc), fees24hUsd = num(day.fees), rewards = num(day.rewards)
    const feeRate = num(data.feeRate) // hundredths of a basis point (1600 = 0.16%)
    return { venue: 'orca', pool, tvlUsd, volume24hUsd: num(day.volume), fees24hUsd,
      feeRateBps: feeRate === null ? null : feeRate / 100, rewardApr: rewards && rewards > 0 ? annualize(rewards, tvlUsd) : null, tickSpacing: num(data.tickSpacing), source: 'api.orca.so' }
  },
  'meteora-dlmm': (pool, get) => meteoraDatapi('meteora-dlmm', 'https://dlmm.datapi.meteora.ag', pool, get),
  'meteora-damm-v2': (pool, get) => meteoraDatapi('meteora-damm-v2', 'https://damm-v2.datapi.meteora.ag', pool, get),
  async 'meteora-damm'(pool, get) {
    const rows = await get(`https://damm-api.meteora.ag/pools?address=${pool}`)
    const data = Array.isArray(rows) ? rows.find(r => object(r) && r.pool_address === pool) : null
    if (!data) notFound('meteora-damm')
    const feePct = num(data.total_fee_pct), farm = num(data.farming_apy)
    // `apr` is the venue's own 24h-fee annualized figure (trade_apy is the compounded one).
    return { venue: 'meteora-damm', pool, tvlUsd: num(data.pool_tvl), volume24hUsd: num(data.trading_volume), fees24hUsd: num(data.fee_volume),
      feeRateBps: feePct === null ? null : feePct * 100, feeApr: pct(data.apr), rewardApr: farm && farm > 0 ? farm : null, source: 'damm-api.meteora.ag' }
  },
  async pumpswap(pool, get) {
    const data = await get(`https://swap-api.pump.fun/v1/pools/${pool}`)
    if (!object(data) || data.address !== pool) notFound('pumpswap')
    if (!validPublicKey(data.baseMint) || !validPublicKey(data.quoteMint)) bad()
    // Volume only comes back on the pair listing (what the deposit page calls).
    const pair = await get(`https://swap-api.pump.fun/v1/pools/pair?${new URLSearchParams({ mintA: data.quoteMint, mintB: data.baseMint, sort: 'liquidity', include_vol: 'true' })}`)
    const row = Array.isArray(pair) ? pair.find(r => object(r) && r.address === pool) : null
    const tvlUsd = num(row?.liquidityUSD ?? data.liquidityUSD), volume24hUsd = num(row?.volumeUSD)
    const feeRateBps = row?.isCanonical === true ? PUMPSWAP_LP_FEE_BPS.canonical : PUMPSWAP_LP_FEE_BPS.flat
    return { venue: 'pumpswap', pool, tvlUsd, volume24hUsd, fees24hUsd: volume24hUsd === null ? null : volume24hUsd * feeRateBps / 10_000,
      feeRateBps, rewardApr: null, source: 'swap-api.pump.fun' }
  },
}
async function raydium(venue: PoolStatsVenue, pool: string, get: Upstream) {
  const body = await get(`https://api-v3.raydium.io/pools/info/ids?ids=${pool}`)
  const data = Array.isArray(body?.data) ? body.data.find((r: unknown) => object(r) && r.id === pool) : null
  if (!data || RAYDIUM_PROGRAMS[String(data.programId)] !== venue) notFound(venue)
  const day = object(data.day) ? data.day : {}
  const feeRate = num(data.feeRate) // fraction (0.0025 = 0.25%)
  const rewardAprs = Array.isArray(day.rewardApr) ? day.rewardApr.map(num).filter((n: number | null): n is number => n !== null) : []
  const rewardApr = rewardAprs.length ? rewardAprs.reduce((a: number, b: number) => a + b, 0) : null
  return { venue, pool, tvlUsd: num(data.tvl), volume24hUsd: num(day.volume), fees24hUsd: num(day.volumeFee),
    feeRateBps: feeRate === null ? null : feeRate * 10_000, feeApr: pct(day.feeApr ?? day.apr), rewardApr: rewardApr && rewardApr > 0 ? rewardApr : null, source: 'api-v3.raydium.io' }
}
async function meteoraDatapi(venue: PoolStatsVenue, host: string, pool: string, get: Upstream) {
  const data = await get(`${host}/pools/${pool}`)
  if (!object(data) || data.address !== pool) notFound(venue)
  const cfg = object(data.pool_config) ? data.pool_config : {}
  const basePct = num(cfg.base_fee_pct), dynPct = num(data.dynamic_fee_pct) ?? 0, farm = num(data.farm_apr)
  // Meteora's `apr` here is the raw 24h fee/TVL ratio (not annualized), so annualize ourselves.
  return { venue, pool, tvlUsd: num(data.tvl), volume24hUsd: num(object(data.volume) ? data.volume['24h'] : null), fees24hUsd: num(object(data.fees) ? data.fees['24h'] : null),
    feeRateBps: basePct === null ? null : (basePct + dynPct) * 100, rewardApr: data.has_farm === true && farm && farm > 0 ? farm : null, source: new URL(host).host }
}

const cache = new Map<string, { at: number; value: PoolStats }>()
const inflight = new Map<string, Promise<PoolStats>>()
export function clearPoolStatsCache() { cache.clear(); inflight.clear() }
function upstream(fetcher: PoolStatsFetcher, timeoutMs: number): Upstream {
  return async url => {
    let r: Response
    try { r = await fetcher(url, { redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) }) } catch { throw new PoolStatsError(503, 'Pool stats are temporarily unavailable; retry shortly') }
    if (r.status === 404) throw new PoolStatsError(404, 'Pool was not found on this venue')
    if (!r.ok) throw new PoolStatsError(r.status === 429 ? 429 : 503, r.status === 429 ? 'Pool stats service is rate limited; retry shortly' : 'Pool stats are temporarily unavailable; retry shortly')
    const reader = r.body?.getReader()
    if (!reader) throw new PoolStatsError(502, 'Pool stats service returned an empty response')
    const chunks: Uint8Array[] = []; let size = 0
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_RESPONSE) { await reader.cancel(); throw new Error() } chunks.push(value) } } catch { throw new PoolStatsError(502, 'Pool stats service returned an invalid response') }
    try { return JSON.parse(Buffer.concat(chunks, size).toString()) } catch { throw new PoolStatsError(502, 'Pool stats service returned invalid JSON') }
  }
}
export function isPoolStatsVenue(v: unknown): v is PoolStatsVenue { return typeof v === 'string' && (POOL_STATS_VENUES as readonly string[]).includes(v) }
export async function fetchPoolStats(venue: PoolStatsVenue, pool: string, fetcher: PoolStatsFetcher = fetch, options: PoolStatsOptions = {}): Promise<PoolStats> {
  if (!isPoolStatsVenue(venue)) throw new PoolStatsError(400, 'Invalid liquidity venue')
  if (!validPublicKey(pool)) throw new PoolStatsError(400, 'Invalid Solana address')
  const now = options.now ?? Date.now, key = `${venue}:${pool}`, time = now()
  const hit = cache.get(key)
  if (hit && time - hit.at < CACHE_TTL) return hit.value
  const pending = inflight.get(key)
  if (pending) return pending
  const run = (async () => {
    const value = finish(await venues[venue](pool, upstream(fetcher, options.timeoutMs ?? TIMEOUT)), now())
    if (cache.size >= CACHE_MAX) { for (const [k, v] of cache) if (now() - v.at >= CACHE_TTL) cache.delete(k); if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!) }
    cache.set(key, { at: now(), value })
    return value
  })()
  inflight.set(key, run)
  try { return await run } finally { inflight.delete(key) }
}

// ---- HTTP: GET /api/pool-stats/solana?venue=&pool=  |  ?pools=venue:pool,venue:pool (<= 20)
function reply(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(JSON.stringify(data))
}
export function createPoolStatsHandler(options: PoolStatsOptions & { fetch?: PoolStatsFetcher } = {}) {
  const fetcher = options.fetch ?? fetch, now = options.now ?? Date.now
  const buckets = new Map<string, { until: number; count: number }>()
  function limit(key: string, ceiling: number) {
    const time = now(), b = buckets.get(key)
    if (b && b.until > time) { if (++b.count > ceiling) throw new PoolStatsError(429, 'Pool stats request limit reached; retry shortly'); return }
    if (buckets.size > 10_000) { for (const [k, v] of buckets) if (v.until <= time) buckets.delete(k); if (buckets.size > 10_000) throw new PoolStatsError(429, 'Pool stats request limit reached; retry shortly') }
    buckets.set(key, { until: time + 60_000, count: 1 })
  }
  function entry(venue: unknown, pool: unknown): { venue: PoolStatsVenue; pool: string } {
    if (!isPoolStatsVenue(venue)) throw new PoolStatsError(400, 'Invalid liquidity venue')
    if (!validPublicKey(pool)) throw new PoolStatsError(400, 'Invalid Solana address')
    return { venue, pool }
  }
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (req.method !== 'GET' || url.pathname !== '/api/pool-stats/solana') return false
    try {
      const peer = String(req.headers['fly-client-ip'] ?? req.socket.remoteAddress ?? 'unknown').slice(0, 100)
      limit(`ip:${peer}`, RATE_CEILING); limit('global', RATE_CEILING * 20)
      const q = url.searchParams
      if (q.has('pools')) {
        const raw = q.get('pools')!.split(',').map(s => s.trim()).filter(Boolean)
        if (!raw.length || raw.length > MAX_BATCH) throw new PoolStatsError(400, `pools must list 1 to ${MAX_BATCH} venue:pool entries`)
        const entries = raw.map(s => { const i = s.indexOf(':'); return entry(i < 0 ? '' : s.slice(0, i), i < 0 ? '' : s.slice(i + 1)) })
        const settled = await Promise.allSettled(entries.map(e => fetchPoolStats(e.venue, e.pool, fetcher, options)))
        reply(res, 200, { results: settled.map((r, i) => r.status === 'fulfilled' ? { ...entries[i], stats: r.value }
          : { ...entries[i], stats: null, error: r.reason instanceof PoolStatsError ? r.reason.message : 'Pool stats are temporarily unavailable' }) })
      } else {
        const e = entry(q.get('venue'), q.get('pool'))
        reply(res, 200, await fetchPoolStats(e.venue, e.pool, fetcher, options))
      }
    } catch (e) {
      const status = e instanceof PoolStatsError ? e.status : 503
      if (status === 429) res.setHeader('retry-after', '60')
      reply(res, status, { error: e instanceof PoolStatsError ? e.message : 'Pool stats are temporarily unavailable' })
    }
    return true
  }
}
