import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import { createSolanaRouterHandler } from '../src/solana/router.ts'
import { addParameters, classifyPool, createSolanaZapHandler, eligiblePools, PLAN_TTL, rankCandidates, removeIntent, resolvePosition, SOL_MINT, splitDeposit, type ZapCandidate } from '../src/solana/zap.ts'
import type { PoolStats } from '../src/solana/pool-stats.ts'
import type { PoolSummary } from '../../shared/types.ts'

// The seed-7 keypair signs every fake transaction, so it is the only valid owner.
const OWNER = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB'
const OTHER = '53cTDPa69sUXtn4FiuXiKEipJGkUUaNxoisBiuSFkd5i'
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const DAMM = '4xp7kN4nVt19caq4kM629vL8vJEqpSFVdZAh27wvYPh8'
const DLMM = '8j9Um4D4WLinJn4znDwAGv7CNShFZ2bSajvhUSJcsQQB'
const DLMM2 = 'FTmwv748VxVVrRohjYzvdfyL4SXP3C6QTnHSem5QhewZ'
const ORCA = '7YU4bvisQQfNfpXa28jAD5RfQ3njpVQJn5eZRFnPuc4B'
const SPLASH = '21gTfxAnhUDjJGZJDkTXctGFKT8TeiXx6pN1CEg9K1uW'
const PUMP = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'
const TRAP = '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP'
const POSITION = 'DKTmfB2gTKBCYSfnzJWgP44VK9J8Nh8eoPArqq11bNi6'
const POSITION2 = '3skpwfyrkzV9dQerRvk3pGosvYHx5xD2tNQANcdcT1YJ'
const RPC = 'https://rpc.example/?api-key=private-key'
const ROUTER = 'http://router.example/secret-path'
const SIG = (n: number) => bs58.encode(Buffer.alloc(64, n))

function encodedV1() {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7))
  const header = Buffer.alloc(42)
  header.set([0x81, 1, 0, 1]); header.writeUInt32LE(15, 4); header.fill(1, 8, 40); header[40] = 1; header[41] = 2
  const limits = Buffer.alloc(16)
  limits.writeBigUInt64LE(1000n, 0); limits.writeUInt32LE(200000, 8); limits.writeUInt32LE(67108864, 12)
  const instruction = Buffer.from([1, 1, 0, 0]); instruction.writeUInt16LE(4, 2)
  const message = Buffer.concat([header, Buffer.from(kp.publicKey), Buffer.alloc(32, 0), limits, instruction, Buffer.from([0]), Buffer.alloc(4, 5)])
  return Buffer.concat([message, Buffer.alloc(64)]).toString('base64')
}
const pool = (address: string, venue: string, extra: Partial<PoolSummary> = {}): PoolSummary => ({ chain: 'solana', address, venue, token: MINT, quote: SOL_MINT, feeBps: null, createdTs: 1, creator: null, liqEvents: 2, funded: true, ...extra })
const stats = (venue: string, poolAddress: string, tvlUsd: number | null, feeRateBps: number | null = 25, tickSpacing?: number): PoolStats => ({ venue: venue as any, pool: poolAddress, tvlUsd, volume24hUsd: 1, fees24hUsd: 1, feeRateBps, feeApr: 1, rewardApr: null, totalApr: 1, ...(tickSpacing !== undefined ? { tickSpacing } : {}), source: 'x', fetchedAt: 1 })

test('classification: constant venues, Orca splash by tick spacing, everything else concentrated', () => {
  assert.equal(classifyPool('raydium-amm', null), 'constant')
  assert.equal(classifyPool('pumpswap', null), 'constant')
  assert.equal(classifyPool('meteora-damm-v2', null), 'constant')
  assert.equal(classifyPool('orca', { tickSpacing: 32896 }), 'splash')
  assert.equal(classifyPool('orca', { tickSpacing: 64 }), 'concentrated')
  assert.equal(classifyPool('orca', null), 'concentrated')
  assert.equal(classifyPool('meteora-dlmm', { tickSpacing: 32896 }), 'concentrated')
  assert.equal(classifyPool('raydium-clmm', null), 'concentrated')
})
test('ranking: constant beats splash beats concentrated, TVL then fee break ties, missing stats count as zero', () => {
  const rows: ZapCandidate[] = [
    { venue: 'meteora-dlmm', pool: DLMM2, kind: 'concentrated', stats: stats('meteora-dlmm', DLMM2, 900_000), feeBps: null },
    { venue: 'orca', pool: SPLASH, kind: 'splash', stats: stats('orca', SPLASH, 500_000, 30, 32896), feeBps: null },
    { venue: 'pumpswap', pool: PUMP, kind: 'constant', stats: null, feeBps: 25 },
    { venue: 'meteora-damm-v2', pool: DAMM, kind: 'constant', stats: stats('meteora-damm-v2', DAMM, 1_000, 25), feeBps: null },
    { venue: 'raydium-cpmm', pool: TRAP, kind: 'constant', stats: stats('raydium-cpmm', TRAP, 1_000, 100), feeBps: null },
  ]
  assert.deepEqual(rankCandidates(rows, 'auto').map(r => r.pool), [DAMM, TRAP, PUMP, SPLASH, DLMM2])
  assert.deepEqual(rankCandidates(rows, 'constant').map(r => r.pool), [DAMM, TRAP, PUMP, SPLASH, DLMM2])
  assert.deepEqual(rankCandidates(rows, 'splash').map(r => r.pool), [SPLASH, DAMM, TRAP, PUMP, DLMM2])
  assert.deepEqual(rankCandidates(rows, 'concentrated').map(r => r.pool), [DLMM2, DAMM, TRAP, PUMP, SPLASH])
  assert.deepEqual(rows.map(r => r.pool), [DLMM2, SPLASH, PUMP, DAMM, TRAP], 'input order is not mutated')
})
test('eligible pools: funded, SOL-paired, supported venue, below the honeypot fee', () => {
  const rows = eligiblePools([
    pool(DAMM, 'meteora-damm-v2'), pool(TRAP, 'raydium-cpmm', { feeBps: 7000 }), pool(DLMM, 'meteora-dlmm', { funded: false }),
    pool(DLMM2, 'meteora-dlmm', { quote: USDC }), pool(PUMP, 'raydium-amm', { feeBps: 25 }), pool(ORCA, 'meteora-dbc'), pool(DAMM, 'meteora-damm-v2'),
  ])
  assert.deepEqual(rows, [{ venue: 'meteora-damm-v2', pool: DAMM, feeBps: null }, { venue: 'raydium-amm-v4', pool: PUMP, feeBps: 25 }])
})
test('split arithmetic: half each side after a 0.5% buffer, exact in lamports', () => {
  assert.deepEqual(splitDeposit(1_000_000_000n), { swap: 497_500_000n, keep: 497_500_000n, buffer: 5_000_000n })
  const odd = splitDeposit(123_456_789n)
  assert.equal(odd.swap + odd.keep + odd.buffer, 123_456_789n)
  assert.equal(odd.buffer, 617_283n)
  assert.ok(odd.keep - odd.swap <= 1n && odd.keep >= odd.swap)
  assert.deepEqual(splitDeposit(3n), { swap: 1n, keep: 2n, buffer: 0n })
  assert.throws(() => splitDeposit(0n), /positive/)
  assert.deepEqual(addParameters('raydium-clmm'), { wrapSol: true, rangeWidthPct: 100 })
  assert.deepEqual(addParameters('orca'), { rangeWidthPct: 100 })
  assert.deepEqual(addParameters('meteora-dlmm'), { binCount: 60 })
  assert.deepEqual(addParameters('meteora-damm-v2'), {})
  assert.deepEqual(addParameters('raydium-amm'), { wrapSol: true })
})
test('position resolution: exactly one active position or the named one; remove intents use ALL semantics', () => {
  const rows = [
    { venue: 'meteora-dlmm', pool: DLMM, position: POSITION, mintA: MINT, mintB: SOL_MINT, liquidity: null, removalMode: 'percentage' as const },
    { venue: 'orca', pool: ORCA, position: POSITION2, mintA: SOL_MINT, mintB: MINT, liquidity: '0' },
    { venue: 'orca', pool: ORCA, position: TRAP, mintA: SOL_MINT, mintB: MINT, liquidity: '777' },
    { venue: 'raydium-clmm', pool: PUMP, position: DAMM, mintA: MINT, mintB: SOL_MINT, liquidity: '5' },
    { venue: 'raydium-clmm', pool: PUMP, position: DLMM2, mintA: MINT, mintB: SOL_MINT, liquidity: '6' },
  ]
  assert.equal(resolvePosition(rows, { venue: 'meteora-dlmm', pool: DLMM }).position, POSITION)
  assert.equal(resolvePosition(rows, { venue: 'orca', pool: ORCA }).position, TRAP, 'empty positions are skipped')
  assert.throws(() => resolvePosition(rows, { venue: 'orca', pool: ORCA, position: POSITION2 }), /not found with liquidity/)
  assert.throws(() => resolvePosition(rows, { venue: 'raydium-clmm', pool: PUMP }), /several positions/)
  assert.equal(resolvePosition(rows, { venue: 'raydium-clmm', pool: PUMP, position: DLMM2 }).liquidity, '6')
  assert.throws(() => resolvePosition(rows, { venue: 'pumpswap', pool: PUMP }), /No active position/)
  assert.deepEqual(removeIntent(rows[0], OWNER, 100, '1'), { venue: 'meteora-dlmm', operation: 'remove', owner: OWNER, pool: DLMM, position: POSITION, slippageBps: 100, transactionVersion: '1', parameters: { removeBps: 10000 } })
  assert.deepEqual(removeIntent(rows[2], OWNER, 50, '0'), { venue: 'orca', operation: 'remove', owner: OWNER, pool: ORCA, position: TRAP, slippageBps: 50, transactionVersion: '0', liquidity: '777', parameters: {} })
  assert.deepEqual(removeIntent(rows[4], OWNER, 100, '1').parameters, { wrapSol: true })
})

// ---- HTTP: fake router + fake RPC behind the real router handler ------------
type Scenario = {
  pools?: PoolSummary[]; stats?: Record<string, PoolStats | Error>
  sol?: number; token?: string; statuses?: Record<string, { err: unknown; confirmationStatus: string } | null>
  positions?: unknown[]; failQuote?: boolean; failAdd?: string[]
}
async function withZap(scenario: Scenario, run: (request: (path: string, body: unknown) => Promise<{ status: number; data: any; text: string }>, calls: { url: string; body: any }[], clock: { now: number }) => Promise<void>) {
  const calls: { url: string; body: any }[] = []
  const clock = { now: 1_700_000_000_000 }
  const quotes = new Map<string, any>()
  let quoteSeq = 0
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input), body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url, body })
    if (url.startsWith(RPC)) {
      if (body.method === 'getBalance') return Response.json({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: scenario.sol ?? 2_000_000_000 } })
      if (body.method === 'getTokenAccountsByOwner') return Response.json({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: scenario.token === undefined ? [] : [{ pubkey: TRAP, account: { data: { parsed: { type: 'account', info: { mint: body.params[1].mint, tokenAmount: { amount: scenario.token, decimals: 6 } } } } } }] } })
      if (body.method === 'getSignatureStatuses') return Response.json({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: body.params[0].map((s: string) => scenario.statuses?.[s] ?? null) } })
      return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: `unknown method at ${RPC}` } })
    }
    const u = new URL(url)
    if (u.pathname.endsWith('/secret-path/quote')) {
      if (scenario.failQuote) return Response.json({ error: 'no route' }, { status: 404 })
      const q = Object.fromEntries(u.searchParams), amount = BigInt(q.amount)
      const out = q.inputMint === SOL_MINT ? amount * 2n : amount / 2n
      return Response.json({ inputMint: q.inputMint, outputMint: q.outputMint, inAmount: q.amount, outAmount: out.toString(), otherAmountThreshold: (out * 99n / 100n).toString(), swapMode: 'ExactIn', slippageBps: Number(q.slippageBps), priceImpactPct: null, contextSlot: 1, routePlan: [{ percent: 100, swapInfo: { ammKey: DAMM, label: 'Meteora DAMM v2', inputMint: q.inputMint, outputMint: q.outputMint, inAmount: q.amount, outAmount: out.toString(), feeAmount: '1', feeMint: q.inputMint } }] })
    }
    if (u.pathname.endsWith('/swap')) return Response.json({ swapTransaction: encodedV1(), transactionVersion: body.transactionVersion, lastValidBlockHeight: 999, prioritizationFeeLamports: 100 })
    if (u.pathname.endsWith('/liquidity/positions')) return Response.json({ positions: scenario.positions ?? [], errors: [] })
    if (u.pathname.endsWith('/liquidity/quote')) {
      if (scenario.failAdd?.includes(body.pool)) return Response.json({ message: `Pool is frozen; see ${ROUTER}/docs` }, { status: 422 })
      const quoteId = `00000000-0000-4000-8000-${String(++quoteSeq).padStart(12, '0')}`
      const amounts = body.operation === 'add'
        ? [{ mint: body.mintA, decimals: 6, expectedRaw: body.amountA, limitRaw: body.amountA, direction: 'debit' }, { mint: body.mintB, decimals: 9, expectedRaw: (BigInt(body.amountB) * 9n / 10n).toString(), limitRaw: body.amountB, direction: 'debit' }]
        : [{ mint: MINT, decimals: 6, expectedRaw: '5000000', limitRaw: '4950000', direction: 'credit' }, { mint: SOL_MINT, decimals: 9, expectedRaw: '30000000', limitRaw: '29700000', direction: 'credit' }]
      const quote = { quoteId, expiresAt: clock.now + 60_000, owner: body.owner, venue: body.venue, operation: body.operation, pool: body.pool, mintA: body.mintA ?? MINT, mintB: body.mintB ?? SOL_MINT, position: body.position ?? POSITION, slot: 1, transactionVersion: body.transactionVersion, amounts, details: body.venue === 'meteora-dlmm' ? { inferredRange: true, priceLower: '1', priceUpper: '2', binCount: body.parameters?.binCount } : {} }
      quotes.set(quoteId, { quote, request: body })
      return Response.json(quote)
    }
    if (u.pathname.endsWith('/liquidity/build')) {
      const saved = quotes.get(body.quoteId)
      if (!saved) return Response.json({ message: 'Quote expired' }, { status: 409 })
      return Response.json({ transactions: [{ transaction: encodedV1(), lastValidBlockHeight: 999, transactionVersion: '1', expectedSigners: [OWNER] }], pool: saved.quote.pool, position: saved.quote.position, quote: saved.quote })
    }
    return Response.json({ error: `unexpected ${url}` }, { status: 500 })
  }
  const router = createSolanaRouterHandler({ routerUrl: ROUTER, rpcUrl: RPC, fetch: fetcher, now: () => clock.now })
  const handler = createSolanaZapHandler({ rpcUrl: RPC, router, fetch: fetcher, now: () => clock.now,
    poolStats: async (_venue, p) => { const s = scenario.stats?.[p]; if (!s) throw new Error(`no stats https://api.orca.so/${p}`); if (s instanceof Error) throw s; return s },
    catalog: { token: mint => mint === MINT ? { chain: 'solana', address: MINT, symbol: 'BORDR', decimals: 6, launchedTs: null, launchVenue: null, graduatedTs: null, firstPoolTs: 1, pools: 1, fundedPools: 1, lpWallets: 1, events: 1, lastTs: 1, score: 1, flags: [] } : null, pools: () => scenario.pools ?? [] } })
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    if (!await handler(req, res, new URL(req.url ?? '/', 'http://localhost'), body)) res.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const request = async (path: string, body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const text = await r.text()
    assert.ok(!/router\.example|rpc\.example|secret-path|api-key|orca\.so/.test(text), `no upstream URL leaks: ${text}`)
    return { status: r.status, data: text ? JSON.parse(text) : null, text }
  }
  try { await run(request, calls, clock) } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
}
const bordr: Scenario = {
  pools: [pool(DLMM, 'meteora-dlmm'), pool(DLMM2, 'meteora-dlmm'), pool(ORCA, 'orca'), pool(DAMM, 'meteora-damm-v2'), pool(SPLASH, 'orca'), pool(TRAP, 'raydium-cpmm', { feeBps: 9000 }), pool(PUMP, 'pumpswap', { quote: USDC })],
  stats: { [DLMM]: stats('meteora-dlmm', DLMM, 93_000, 368), [DLMM2]: stats('meteora-dlmm', DLMM2, 18_000, 214), [DAMM]: stats('meteora-damm-v2', DAMM, 137_609, 250), [SPLASH]: stats('orca', SPLASH, 400_000, 100, 32896), [TRAP]: stats('raydium-cpmm', TRAP, 9_000_000, 9000) },
  sol: 2_000_000_000, token: '990000000',
}
const planIn = (extra: Record<string, unknown> = {}) => ({ owner: OWNER, mint: MINT, direction: 'in', amount: '1000000000', ...extra })

test('plan in: picks the deepest constant-product SOL pool, splits, quotes swap and add, lists alternatives', async () => withZap(bordr, async (request, calls) => {
  const r = await request('/api/zap/solana/plan', planIn())
  assert.equal(r.status, 200, r.text)
  const plan = r.data
  assert.match(plan.planId, /^[0-9a-f-]{36}$/)
  assert.equal(plan.direction, 'in')
  assert.deepEqual({ venue: plan.pool.venue, pool: plan.pool.pool, kind: plan.pool.kind }, { venue: 'meteora-damm-v2', pool: DAMM, kind: 'constant' })
  assert.equal(plan.pool.reason, 'Constant-product Meteora DAMM v2 pool, the one constant-product pool for this token: $138k TVL, 2.5% fee.')
  assert.deepEqual(plan.alternatives.map((a: any) => [a.venue, a.kind]), [['orca', 'splash'], ['meteora-dlmm', 'concentrated'], ['meteora-dlmm', 'concentrated'], ['orca', 'concentrated']])
  assert.equal(plan.alternatives[3].stats, null, 'missing stats are tolerated')
  const picked = await request('/api/zap/solana/plan', planIn({ pool: DLMM2 }))
  assert.equal(picked.status, 200, picked.text)
  assert.deepEqual([picked.data.pool.pool, picked.data.pool.kind], [DLMM2, 'concentrated'])
  assert.match(picked.data.pool.reason, /\(your pick\)\.$/)
  assert.equal((await request('/api/zap/solana/plan', planIn({ pool: TRAP }))).status, 409, 'a honeypot cannot be picked by hand')
  assert.equal(plan.steps.length, 2)
  const [swap, add] = plan.steps
  assert.deepEqual({ kind: swap.kind, inputMint: swap.inputMint, outputMint: swap.outputMint, amount: swap.amount, expectedOut: swap.expectedOut, minOut: swap.minOut }, { kind: 'swap', inputMint: SOL_MINT, outputMint: MINT, amount: '497500000', expectedOut: '995000000', minOut: '985050000' })
  assert.equal(swap.title, 'Swapping 0.4975 SOL → $BORDR')
  assert.deepEqual({ kind: add.kind, venue: add.venue, pool: add.pool, tokenAmount: add.tokenAmount, solAmount: add.solAmount }, { kind: 'add', venue: 'meteora-damm-v2', pool: DAMM, tokenAmount: '995000000', solAmount: '497500000' })
  assert.equal(add.quote.quoteId.length, 36)
  const addRequest = calls.find(c => c.url.endsWith('/liquidity/quote'))!.body
  assert.deepEqual({ amountA: addRequest.amountA, amountB: addRequest.amountB, mintA: addRequest.mintA, mintB: addRequest.mintB, parameters: addRequest.parameters, owner: addRequest.owner }, { amountA: '985050000', amountB: '497500000', mintA: MINT, mintB: SOL_MINT, parameters: {}, owner: OWNER })
  assert.deepEqual(plan.estimate, { depositSol: '1', positionValueSol: '0.94525', tokenExpected: '995000000', tokenDecimals: 6, networkFeeSolApprox: '0.00002' })
  assert.equal(plan.expiresAt, 1_700_000_000_000 + PLAN_TTL)
  assert.equal(new URL(calls.find(c => c.url.includes('/quote?'))!.url).searchParams.get('amount'), '497500000')
}))
test('plan in: preference and concentrated parameters; honeypot and non-SOL pools never win', async () => withZap(bordr, async (request, calls) => {
  const splash = await request('/api/zap/solana/plan', planIn({ preference: 'splash' }))
  assert.equal(splash.status, 200, splash.text)
  assert.deepEqual([splash.data.pool.venue, splash.data.pool.kind, splash.data.pool.pool], ['orca', 'splash', SPLASH])
  assert.match(splash.data.pool.reason, /^Splash Orca pool, deepest liquidity for this token: \$400k TVL, 1% fee\.$/)
  assert.deepEqual(calls.filter(c => c.url.endsWith('/liquidity/quote')).at(-1)!.body.parameters, { rangeWidthPct: 100 })
  const dlmm = await request('/api/zap/solana/plan', planIn({ preference: 'concentrated' }))
  assert.deepEqual([dlmm.data.pool.venue, dlmm.data.pool.pool], ['meteora-dlmm', DLMM])
  assert.deepEqual(calls.filter(c => c.url.endsWith('/liquidity/quote')).at(-1)!.body.parameters, { binCount: 60 })
  assert.match(dlmm.data.pool.reason, /range is set automatically/)
  assert.equal(dlmm.data.steps[1].quote.details.inferredRange, true)
  assert.ok(!JSON.stringify([splash.data, dlmm.data]).includes(TRAP), 'the 90% fee pool is never offered')
  assert.ok(!JSON.stringify([splash.data, dlmm.data]).includes(PUMP), 'the USDC-paired pool is never offered')
}))
test('plan in: falls through to the next candidate when a venue cannot quote; 409 with a suggestion when no SOL pool exists', async () => {
  await withZap({ ...bordr, failAdd: [DAMM] }, async (request) => {
    const r = await request('/api/zap/solana/plan', planIn())
    assert.equal(r.status, 200, r.text)
    assert.deepEqual([r.data.pool.venue, r.data.pool.pool], ['orca', SPLASH])
  })
  await withZap({ ...bordr, failAdd: [DAMM, SPLASH, DLMM] }, async (request) => {
    const r = await request('/api/zap/solana/plan', planIn())
    assert.equal(r.status, 409)
    assert.equal(r.data.error, 'Pool is frozen; see [provider]')
  })
  await withZap({ pools: [pool(PUMP, 'pumpswap', { quote: USDC }), pool(TRAP, 'raydium-cpmm', { feeBps: 7000 }), pool(DLMM, 'meteora-dlmm', { funded: false })] }, async (request) => {
    const r = await request('/api/zap/solana/plan', planIn())
    assert.equal(r.status, 409)
    assert.deepEqual(r.data, { error: 'No SOL pool for this token yet', suggest: { venue: 'meteora-damm-v2', operation: 'initialize' } })
  })
  await withZap({ ...bordr, failQuote: true }, async (request) => {
    const r = await request('/api/zap/solana/plan', planIn())
    assert.equal(r.status, 404)
  })
})
test('plan validation rejects bad input before any upstream call', async () => withZap(bordr, async (request, calls) => {
  for (const body of [planIn({ amount: '0' }), planIn({ amount: 1 }), planIn({ amount: '1000' }), planIn({ direction: 'sideways' }), planIn({ preference: 'cheap' }), planIn({ slippageBps: 1001 }), planIn({ transactionVersion: '2' }), planIn({ owner: 'nope' }), planIn({ mint: SOL_MINT }), { owner: OWNER, mint: MINT, direction: 'out' }, { owner: OWNER, mint: MINT, direction: 'out', position: { venue: 'uniswap', pool: DAMM } }]) {
    const r = await request('/api/zap/solana/plan', body)
    assert.equal(r.status, 400, JSON.stringify(body))
  }
  assert.equal(calls.length, 0)
}))
test('build: step 0 swaps against the live SOL balance; later steps need confirmed signatures, the same owner and an unexpired plan', async () => withZap({ ...bordr, sol: 400_000_000, token: '600000000', statuses: { [SIG(1)]: { err: null, confirmationStatus: 'confirmed' }, [SIG(2)]: { err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }, [SIG(3)]: { err: null, confirmationStatus: 'processed' } } }, async (request, calls, clock) => {
  const plan = (await request('/api/zap/solana/plan', planIn())).data
  const build = (step: number, extra: Record<string, unknown> = {}) => request('/api/zap/solana/build', { planId: plan.planId, owner: OWNER, step, ...extra })
  const first = await build(0)
  assert.equal(first.status, 200, first.text)
  assert.deepEqual({ step: first.data.step, kind: first.data.kind, n: first.data.transactions.length, signers: first.data.transactions[0].expectedSigners, height: first.data.transactions[0].lastValidBlockHeight }, { step: 0, kind: 'swap', n: 1, signers: [OWNER], height: 999 })
  assert.equal(first.data.quote.inAmount, '390000000', 'capped at balance minus the 0.01 SOL reserve')
  assert.equal(first.data.mode, 'sequential'); assert.equal(plan.mode, 'sequential')
  assert.deepEqual(first.data.transactions[0].instructions, [{ programId: '11111111111111111111111111111111', keys: [{ pubkey: OWNER, isSigner: true, isWritable: true }], data: 'BQUFBQ==' }], 'raw instructions ride along for a composer')
  assert.match(first.data.note, /0\.39 SOL/)
  assert.equal(calls.filter(c => c.url.endsWith('/swap')).at(-1)!.body.userPublicKey, OWNER)
  assert.equal((await build(1)).status, 409, 'no confirmations yet')
  assert.equal((await build(1, { confirmed: [SIG(9)] })).status, 409, 'unknown signature')
  assert.equal((await build(1, { confirmed: [SIG(2)] })).status, 409, 'failed transaction')
  assert.equal((await build(1, { confirmed: [SIG(3)] })).status, 409, 'processed is not confirmed')
  assert.equal((await build(1, { confirmed: ['not-a-signature'] })).status, 400)
  assert.equal((await build(1, { confirmed: [SIG(1)], owner: OTHER })).status, 409, 'owner bound')
  assert.equal((await build(2, { confirmed: [SIG(1)] })).status, 400, 'no such step')
  const second = await build(1, { confirmed: [SIG(1)] })
  assert.equal(second.status, 200, second.text)
  assert.deepEqual({ step: second.data.step, kind: second.data.kind, pool: second.data.pool, position: second.data.position, n: second.data.transactions.length }, { step: 1, kind: 'add', pool: DAMM, position: POSITION, n: 1 })
  const requote = calls.filter(c => c.url.endsWith('/liquidity/quote')).at(-1)!.body
  assert.deepEqual({ amountA: requote.amountA, amountB: requote.amountB }, { amountA: '600000000', amountB: '390000000' }, 'live token balance and SOL minus reserve, both under the planned amounts')
  assert.equal(calls.filter(c => c.url.endsWith('/liquidity/build')).at(-1)!.body.quoteId, second.data.quote.quoteId)
  clock.now += PLAN_TTL + 1
  const late = await build(1, { confirmed: [SIG(1)] })
  assert.equal(late.status, 409); assert.match(late.data.error, /expired/)
  assert.equal((await request('/api/zap/solana/build', { planId: '11111111-1111-4111-8111-111111111111', owner: OWNER, step: 0 })).status, 409)
}))
test('plan out: resolves the position, removes all of it, quotes the swap back to SOL, and builds the swap from the live token balance', async () => withZap({ ...bordr, token: '4800000', statuses: { [SIG(4)]: { err: null, confirmationStatus: 'finalized' } }, positions: [
  { venue: 'meteora-dlmm', pool: DLMM, position: POSITION, mintA: MINT, mintB: SOL_MINT, liquidity: null, removalMode: 'percentage', owner: OWNER },
  { venue: 'meteora-dlmm', pool: DLMM2, position: POSITION2, mintA: MINT, mintB: SOL_MINT, liquidity: null, removalMode: 'percentage', owner: OWNER },
] }, async (request, calls) => {
  const r = await request('/api/zap/solana/plan', { owner: OWNER, mint: MINT, direction: 'out', position: { venue: 'meteora-dlmm', pool: DLMM } })
  assert.equal(r.status, 200, r.text)
  const plan = r.data
  assert.deepEqual([plan.pool.venue, plan.pool.pool, plan.pool.kind], ['meteora-dlmm', DLMM, 'concentrated'])
  assert.deepEqual(plan.steps.map((s: any) => s.kind), ['remove', 'swap'])
  assert.equal(plan.steps[0].position, POSITION)
  assert.equal(plan.steps[0].intent, undefined, 'the raw intent stays server-side')
  const remove = calls.find(c => c.url.endsWith('/liquidity/quote'))!.body
  assert.deepEqual({ operation: remove.operation, position: remove.position, parameters: remove.parameters, liquidity: remove.liquidity }, { operation: 'remove', position: POSITION, parameters: { removeBps: 10000 }, liquidity: undefined })
  assert.deepEqual({ amount: plan.steps[1].amount, expectedOut: plan.steps[1].expectedOut }, { amount: '5000000', expectedOut: '2500000' })
  assert.deepEqual(plan.estimate, { positionValueSol: '0.0325', receiveSol: '0.0325', tokenExpected: '5000000', tokenDecimals: 6, networkFeeSolApprox: '0.00002' })
  const positionsUrl = new URL(calls.find(c => c.url.includes('/liquidity/positions'))!.url)
  assert.deepEqual([positionsUrl.searchParams.get('venue'), positionsUrl.searchParams.get('pool')], ['meteora-dlmm', DLMM])
  const first = await request('/api/zap/solana/build', { planId: plan.planId, owner: OWNER, step: 0 })
  assert.equal(first.status, 200, first.text); assert.equal(first.data.kind, 'remove')
  const second = await request('/api/zap/solana/build', { planId: plan.planId, owner: OWNER, step: 1, confirmed: [SIG(4)] })
  assert.equal(second.status, 200, second.text)
  assert.equal(second.data.quote.inAmount, '4800000', 'the balance that actually arrived, under the planned credit')
  const wrong = await request('/api/zap/solana/plan', { owner: OWNER, mint: MINT, direction: 'out', position: { venue: 'meteora-dlmm', pool: DLMM, position: POSITION2 } })
  assert.equal(wrong.status, 409)
  const none = await request('/api/zap/solana/plan', { owner: OWNER, mint: MINT, direction: 'out', position: { venue: 'orca', pool: ORCA } })
  assert.equal(none.status, 409); assert.match(none.data.error, /No active position/)
}))
test('RPC failures and oversized bodies collapse to fixed client-safe messages', async () => withZap({ ...bordr, statuses: {} }, async (request) => {
  const plan = (await request('/api/zap/solana/plan', planIn())).data
  const r = await request('/api/zap/solana/build', { planId: plan.planId, owner: OWNER, step: 1, confirmed: [SIG(1)] })
  assert.equal(r.status, 409)
  const big = await request('/api/zap/solana/plan', { ...planIn(), pad: 'x'.repeat(40_000) })
  assert.equal(big.status, 413)
}))
