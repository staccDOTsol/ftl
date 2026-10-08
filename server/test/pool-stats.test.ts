import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { PUMPSWAP_LP_FEE_BPS, annualize, clearPoolStatsCache, createPoolStatsHandler, estimateShare, fetchPoolStats, type PoolStatsFetcher } from '../src/solana/pool-stats.ts'

// Trimmed recordings of each venue's own pool-stats endpoint (2026-10-08), see src/solana/pool-stats.md.
const F = JSON.parse(readFileSync(new URL('./fixtures/pool-stats.json', import.meta.url), 'utf8'))
const RAY_CLMM = '2JtkunkYCRbe5YZuGU6kLFmNwN22Ba1pCicHoqW5Eqja', RAY_CPMM = 'fAjTnZ9QqJkUmrr8cXutkYhpVge2qqtSZNt9qKn7YC2', RAY_V4 = 'S2MiN5qmiRS8HBQMXcdJUhLwrBgX9P3naDuo4GkQ63t'
const ORCA = '21gTfxAnhUDjJGZJDkTXctGFKT8TeiXx6pN1CEg9K1uW', DLMM = '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6', DLMM_TARGET = 'GNY3YbGqdhZv8R3kD2NRJQ4NLD6tb3PPthJ2mpUR89Lc'
const DAMM2 = '4xp7kN4nVt19caq4kM629vL8vJEqpSFVdZAh27wvYPh8', DAMM1 = 'E5H5BXLranyJFHEzvR3R2j6kGDQ3Fnx8sPKSsgYqyya8', PUMP = '7GZHLdhvZN1NSutNt1BJs5S9ArBobAdCvyGzwPo22LHA'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
function recorded(): { fetcher: PoolStatsFetcher; calls: string[] } {
  const calls: string[] = []
  const fetcher: PoolStatsFetcher = async (url, init) => {
    calls.push(url)
    assert.equal(init.redirect, 'error')
    assert.ok(init.signal instanceof AbortSignal)
    const u = new URL(url)
    if (u.host === 'api-v3.raydium.io') return json({ ...F.raydium.body, data: F.raydium.body.data.filter((r: any) => u.searchParams.get('ids')!.split(',').includes(r.id)) })
    if (u.host === 'api.orca.so') return u.pathname.endsWith(ORCA) ? json(F.orca.body) : json({ error: 'nope' }, 404)
    if (u.host === 'dlmm.datapi.meteora.ag') return u.pathname.endsWith(DLMM) ? json(F['meteora-dlmm'].body) : u.pathname.endsWith(DLMM_TARGET) ? json(F['meteora-dlmm'].targetPool.body) : new Response('', { status: 404 })
    if (u.host === 'damm-v2.datapi.meteora.ag') return u.pathname.endsWith(DAMM2) ? json(F['meteora-damm-v2'].body) : new Response('', { status: 404 })
    if (u.host === 'damm-api.meteora.ag') return json(u.searchParams.get('address') === DAMM1 ? F['meteora-damm'].body : [])
    if (u.host === 'swap-api.pump.fun') {
      if (u.pathname === '/v1/pools/pair') { assert.equal(u.searchParams.get('include_vol'), 'true'); return json(F.pumpswap.pair.body) }
      return u.pathname.endsWith(PUMP) ? json(F.pumpswap.pool.body) : json({ statusCode: 404 }, 404)
    }
    return new Response('', { status: 500 })
  }
  return { fetcher, calls }
}
const near = (a: number | null, b: number, tol = 1e-6) => { assert.ok(a !== null && Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} !~ ${b}`) }

test('raydium: tvl, day volume/fees in USD, feeRate fraction to bps, day.feeApr percent, program checked per venue', async () => {
  clearPoolStatsCache()
  const { fetcher } = recorded()
  const clmm = await fetchPoolStats('raydium-clmm', RAY_CLMM, fetcher)
  assert.equal(clmm.source, 'api-v3.raydium.io')
  near(clmm.tvlUsd, 1728.52); near(clmm.volume24hUsd, 8.051010986200211); near(clmm.fees24hUsd, 0.3220438528739525)
  near(clmm.feeRateBps, 400); near(clmm.feeApr, 6.8); assert.equal(clmm.rewardApr, null); near(clmm.totalApr, 6.8)
  near(annualize(clmm.fees24hUsd, clmm.tvlUsd), 6.8, 0.01) // the venue's figure is 24h fees annualized
  const cpmm = await fetchPoolStats('raydium-cpmm', RAY_CPMM, fetcher)
  near(cpmm.feeRateBps, 0.5); near(cpmm.feeApr, 8.63); near(cpmm.volume24hUsd, 282.1257171819502)
  const v4 = await fetchPoolStats('raydium-amm-v4', RAY_V4, fetcher)
  near(v4.feeRateBps, 25); near(v4.tvlUsd, 9.48); near(v4.feeApr, 7.48)
  await assert.rejects(fetchPoolStats('raydium-cpmm', RAY_CLMM, fetcher), (e: any) => e.status === 404 && /raydium-cpmm/.test(e.message))
})

test('orca: v2 strings to numbers, feeRate in hundredths of a bp, fee APR annualized from 24h fees over TVL', async () => {
  clearPoolStatsCache()
  const s = await fetchPoolStats('orca', ORCA, recorded().fetcher)
  assert.equal(s.source, 'api.orca.so')
  near(s.tvlUsd, 3456.6701275480299074); near(s.volume24hUsd, 485.05561233351); near(s.fees24hUsd, 0.774207466305375881674)
  near(s.feeRateBps, 16)
  near(s.feeApr, 0.774207466305375881674 / 3456.6701275480299074 * 365 * 100)
  near(s.feeApr, 0.000224463406736003 * 365 * 100, 0.01) // within 1% of the venue's own 24h yieldOverTvl (different TVL snapshot)
  assert.equal(s.rewardApr, null); assert.equal(s.totalApr, s.feeApr)
})

test('meteora dlmm / damm v2: datapi apr is a raw daily ratio, so fee APR is fees.24h / tvl annualized; fee pct to bps', async () => {
  clearPoolStatsCache()
  const { fetcher } = recorded()
  const dlmm = await fetchPoolStats('meteora-dlmm', DLMM, fetcher)
  assert.equal(dlmm.source, 'dlmm.datapi.meteora.ag')
  near(dlmm.tvlUsd, 4574416.897879948); near(dlmm.volume24hUsd, 21403331.54144714); near(dlmm.fees24hUsd, 8069.926323748718)
  near(dlmm.feeRateBps, (0.04 + 3e-7) * 100)
  near(dlmm.feeApr, 64.39122567804017); assert.equal(dlmm.rewardApr, null)
  const empty = await fetchPoolStats('meteora-dlmm', DLMM_TARGET, fetcher)
  near(empty.tvlUsd, 3.6737959769112583); assert.equal(empty.volume24hUsd, 0); assert.equal(empty.fees24hUsd, 0); assert.equal(empty.feeApr, 0)
  const damm2 = await fetchPoolStats('meteora-damm-v2', DAMM2, fetcher)
  assert.equal(damm2.source, 'damm-v2.datapi.meteora.ag')
  near(damm2.tvlUsd, 104813.26147584456); near(damm2.feeRateBps, 250); near(damm2.feeApr, 29224.449263301078)
  await assert.rejects(fetchPoolStats('meteora-damm-v2', DLMM, fetcher), (e: any) => e.status === 404)
})

test('meteora damm v1: string tvl, total_fee_pct to bps, venue apr used as-is', async () => {
  clearPoolStatsCache()
  const s = await fetchPoolStats('meteora-damm', DAMM1, recorded().fetcher)
  assert.equal(s.source, 'damm-api.meteora.ag')
  near(s.tvlUsd, 5783528.718230854); near(s.volume24hUsd, 403388.8484941744); near(s.fees24hUsd, 1210.1665454825225)
  near(s.feeRateBps, 30); near(s.feeApr, 7.930069513624118); assert.equal(s.rewardApr, null)
  await assert.rejects(fetchPoolStats('meteora-damm', DLMM, recorded().fetcher), (e: any) => e.status === 404)
})

test('pumpswap: pool then pair listing for volume; LP fee share from the on-chain flat schedule', async () => {
  clearPoolStatsCache()
  const { fetcher, calls } = recorded()
  const s = await fetchPoolStats('pumpswap', PUMP, fetcher)
  assert.equal(calls.length, 2)
  assert.ok(calls[1].includes('mintA=So11111111111111111111111111111111111111112') && calls[1].includes('mintB=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'))
  assert.equal(s.source, 'swap-api.pump.fun')
  near(s.tvlUsd, 0.000067702191672432); assert.equal(s.volume24hUsd, 0); assert.equal(s.fees24hUsd, 0)
  assert.equal(s.feeRateBps, PUMPSWAP_LP_FEE_BPS.flat); assert.equal(s.feeApr, 0)
  // a busy canonical-less pool from the same listing
  const big = F.pumpswap.pair.body[0]
  const fetcher2: PoolStatsFetcher = async url => new URL(url).pathname === '/v1/pools/pair' ? json(F.pumpswap.pair.body) : json({ ...F.pumpswap.pool.body, address: big.address })
  const b = await fetchPoolStats('pumpswap', big.address, fetcher2)
  near(b.volume24hUsd, 2873168.2296297345); near(b.fees24hUsd, 2873168.2296297345 * 25 / 10_000); near(b.feeApr, annualize(b.fees24hUsd, b.tvlUsd)!)
})

test('estimateShare: yearly fee USD for a deposit at today\'s volume', () => {
  assert.equal(estimateShare({ feeApr: 12.4 }, 1000), 124)
  assert.equal(estimateShare({ feeApr: null }, 1000), null)
  assert.equal(estimateShare({ feeApr: 5 }, -1), null)
  assert.equal(annualize(10, 0), null); assert.equal(annualize(null, 100), null)
})

test('cache: one upstream read per venue:pool for 60s, refreshed after, in-flight calls shared', async () => {
  clearPoolStatsCache()
  let t = 1_000_000
  const { fetcher, calls } = recorded()
  const opts = { now: () => t }
  const [a, b] = await Promise.all([fetchPoolStats('orca', ORCA, fetcher, opts), fetchPoolStats('orca', ORCA, fetcher, opts)])
  assert.equal(calls.length, 1); assert.equal(a, b); assert.equal(a.fetchedAt, t)
  t += 59_000
  assert.equal(await fetchPoolStats('orca', ORCA, fetcher, opts), a); assert.equal(calls.length, 1)
  t += 2_000
  const c = await fetchPoolStats('orca', ORCA, fetcher, opts)
  assert.equal(calls.length, 2); assert.notEqual(c, a); assert.equal(c.fetchedAt, t)
  await fetchPoolStats('raydium-clmm', RAY_CLMM, fetcher, opts); assert.equal(calls.length, 3)
})

test('timeout, oversized and invalid upstream replies map to short errors that never carry a URL', async () => {
  clearPoolStatsCache()
  const hang: PoolStatsFetcher = (_url, init) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted https://api.orca.so/secret?key=1'))))
  await assert.rejects(fetchPoolStats('orca', ORCA, hang, { timeoutMs: 20 }), (e: any) => e.status === 503 && !/http|orca\.so/.test(e.message))
  const huge: PoolStatsFetcher = async () => new Response(new ReadableStream({ start(c) { const chunk = new Uint8Array(500_000); for (let i = 0; i < 5; i++) c.enqueue(chunk); c.close() } }))
  await assert.rejects(fetchPoolStats('orca', ORCA, huge), (e: any) => e.status === 502)
  const garbage: PoolStatsFetcher = async () => new Response('<html>', { status: 200 })
  await assert.rejects(fetchPoolStats('orca', ORCA, garbage), (e: any) => e.status === 502)
  const limited: PoolStatsFetcher = async () => new Response('', { status: 429 })
  await assert.rejects(fetchPoolStats('orca', ORCA, limited), (e: any) => e.status === 429)
  const missing: PoolStatsFetcher = async () => new Response('', { status: 404 })
  await assert.rejects(fetchPoolStats('orca', ORCA, missing), (e: any) => e.status === 404)
  await assert.rejects(fetchPoolStats('nope' as any, ORCA, recorded().fetcher), (e: any) => e.status === 400)
  await assert.rejects(fetchPoolStats('orca', 'not-an-address', recorded().fetcher), (e: any) => e.status === 400)
})

test('GET /api/pool-stats/solana: single, batch of up to 20, validation and per-IP limit', async () => {
  clearPoolStatsCache()
  let t = 5_000_000
  const { fetcher, calls } = recorded()
  const handler = createPoolStatsHandler({ fetch: fetcher, now: () => t })
  const server = http.createServer(async (req, res) => {
    if (!await handler(req, res, new URL(req.url ?? '/', 'http://localhost'))) res.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const get = async (path: string) => { const r = await fetch(`http://127.0.0.1:${port}${path}`); return { status: r.status, data: await r.json().catch(() => null), retry: r.headers.get('retry-after') } }
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/other`)).status, 404)
    const one = await get(`/api/pool-stats/solana?venue=orca&pool=${ORCA}`)
    assert.equal(one.status, 200); assert.equal(one.data.venue, 'orca'); near(one.data.feeRateBps, 16)
    const batch = await get(`/api/pool-stats/solana?pools=raydium-clmm:${RAY_CLMM},meteora-dlmm:${DLMM},orca:${ORCA},pumpswap:${PUMP},meteora-damm:${DLMM}`)
    assert.equal(batch.status, 200); assert.equal(batch.data.results.length, 5)
    assert.equal(batch.data.results[0].stats.venue, 'raydium-clmm'); near(batch.data.results[0].stats.feeApr, 6.8)
    assert.equal(batch.data.results[2].stats, one.data.feeRateBps === 16 ? batch.data.results[2].stats : null)
    assert.equal(batch.data.results[2].stats.fetchedAt, one.data.fetchedAt) // served from cache
    assert.equal(batch.data.results[4].stats, null); assert.match(batch.data.results[4].error, /not found/)
    assert.ok(!JSON.stringify(batch.data).includes('http'))
    assert.equal((await get('/api/pool-stats/solana?venue=orca&pool=bad')).status, 400)
    assert.equal((await get('/api/pool-stats/solana?venue=uniswap&pool=' + ORCA)).status, 400)
    assert.equal((await get(`/api/pool-stats/solana?pools=orca:${ORCA},garbage`)).status, 400)
    assert.equal((await get('/api/pool-stats/solana?pools=' + Array(21).fill(`orca:${ORCA}`).join(','))).status, 400)
    assert.equal((await get('/api/pool-stats/solana?pools=' + Array(20).fill(`orca:${ORCA}`).join(','))).status, 200)
    const before = calls.length
    let last: Awaited<ReturnType<typeof get>> | null = null
    for (let i = 0; i < 60; i++) last = await get(`/api/pool-stats/solana?venue=orca&pool=${ORCA}`)
    assert.equal(last!.status, 429); assert.equal(last!.retry, '60'); assert.equal(calls.length, before)
    t += 61_000
    assert.equal((await get(`/api/pool-stats/solana?venue=orca&pool=${ORCA}`)).status, 200)
  } finally { server.close() }
})
