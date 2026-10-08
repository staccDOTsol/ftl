import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { PublicKey } from '@solana/web3.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ftl-route-class-'))
process.env.DATA_DIR = tmp
after(() => fs.rmSync(tmp, { recursive: true, force: true }))
const { db } = await import('../src/db.ts')
const { DirectSolanaRouter, DirectRouteError, rateLimited } = await import('../src/solana/self-router.ts')
const { DirectVenueError } = await import('../src/solana/direct-adapter.ts')
const { createSolanaRouterHandler } = await import('../src/solana/router.ts')
const { RATE_LIMITED_MESSAGE } = await import('../src/solana/rpc-resilience.ts')

const SOL = 'So11111111111111111111111111111111111111112'
const TOKEN = '6Mix12LiHrQFojaQEnfPUC65Qkwd6X4Y5Qg93oFbordr'
const LONELY = '53cTDPa69sUXtn4FiuXiKEipJGkUUaNxoisBiuSFkd5i'
const POOL = 'Gf7sXMoP8iRw4iiXmJ1nq4vxcRycbGXy5RL8a8LnTd3v'
const RPC = 'https://rpc.example/?api-key=private-key'
db.prepare(`INSERT INTO pools (chain,address,venue,mint_a,mint_b,liq_events,funded,created_ts)
  VALUES ('solana',?,'pumpswap',?,?,5,1,?)`).run(POOL, TOKEN, SOL, Date.now())
const intent = { inputMint: SOL, outputMint: TOKEN, amount: '10000000', slippageBps: 100, transactionVersion: '1' as const }

/** A direct router whose RPC is a fake and whose pool pricer reads the pool
 * account through the router's real Connection (so the wrapper is exercised). */
function router(rpcStatus: () => number, price: (out: bigint) => any = out => out) {
  const methods: string[] = []
  const r = new DirectSolanaRouter(RPC, { rpc: { sleep: async () => {}, fetch: async (_u, init) => {
    const request = JSON.parse(String(init?.body))
    methods.push(request.method)
    const status = rpcStatus()
    if (status !== 200) return new Response('Too many requests', { status })
    const result = request.method === 'getSlot' ? 77 : { context: { slot: 77 }, value: { data: ['', 'base64'],
      executable: false, lamports: 1, owner: '11111111111111111111111111111111', rentEpoch: 0, space: 0 } }
    return Response.json({ jsonrpc: '2.0', id: request.id, result })
  } } })
  ;(r as any).quotePool = async (pool: any) => {
    const account = await (r as any).connection.getAccountInfo(new PublicKey(pool.address), 'confirmed')
    if (!account) throw new DirectVenueError('missing pool')
    const out = price(1_000n)
    if (out instanceof Error) throw out
    return { pool, out, minimum: out - 10n, fee: 1n, feeMint: SOL,
      instructions: async () => [], leg: async () => { throw new Error('unused') } }
  }
  return { r, methods }
}

test('direct router: candidate pools that only fail on RPC rate limits surface the 503, URL-free', async () => {
  const { r, methods } = router(() => 429)
  const error = await r.quote(intent).then(() => null, e => e)
  assert.ok(error instanceof DirectRouteError)
  assert.equal(error.status, 503)
  assert.equal(error.message, RATE_LIMITED_MESSAGE)
  assert.equal(error.retryAfter, 2)
  assert.equal(error.transient, true)
  assert.equal(JSON.stringify({ m: error.message, s: String(error.stack) }).includes('private-key'), false)
  assert.equal(methods.length, 3) // one pool read, three bounded attempts
})

test('direct router: genuine no-pool and cannot-fill stay 404', async () => {
  const noPool = router(() => 200)
  const missing = await noPool.r.quote({ ...intent, outputMint: LONELY }).then(() => null, e => e)
  assert.equal(missing.status, 404)
  assert.equal(noPool.methods.length, 0)
  const cannotFill = router(() => 200, () => new DirectVenueError('Pool cannot fill this exact-in amount'))
  const unfilled = await cannotFill.r.quote(intent).then(() => null, e => e)
  assert.equal(unfilled.status, 404)
  assert.match(unfilled.message, /cannot fill/)
})

test('direct router: a burst of quotes for the same pool reads pool state once within the memo TTL', async () => {
  const { r, methods } = router(() => 200)
  const first = await r.quote(intent)
  const second = await r.quote(intent)
  assert.equal(first.quote.outAmount, '1000')
  assert.equal(second.quote.contextSlot, 77)
  assert.deepEqual(methods.filter(m => m === 'getAccountInfo'), ['getAccountInfo'])
  assert.equal(methods.filter(m => m === 'getSlot').length, 2) // slot is never memoized
})

const externalQuote = { inputMint: SOL, outputMint: TOKEN, inAmount: '10000000', outAmount: '900', otherAmountThreshold: '890',
  swapMode: 'ExactIn', slippageBps: 100, routePlan: [{ percent: 100, swapInfo: { label: 'X', inputMint: SOL, outputMint: TOKEN } }] }
async function serve(directError: Error, external: (() => Response) | null,
  run: (get: () => Promise<{ status: number; data: any; retryAfter: string | null }>) => Promise<void>) {
  const handler = createSolanaRouterHandler({ routerUrl: external ? 'http://router.example' : undefined, rpcUrl: RPC,
    localRouter: { quote: async () => { throw directError }, swap: async () => { throw directError } },
    fetch: async () => external!() })
  const server = http.createServer(async (req, res) => {
    if (!await handler(req, res, new URL(req.url ?? '/', 'http://localhost'), '')) res.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const query = new URLSearchParams({ inputMint: SOL, outputMint: TOKEN, amount: '10000000', slippageBps: '100', transactionVersion: '1' })
  try {
    await run(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/api/quote/solana?${query}`)
      return { status: r.status, data: await r.json(), retryAfter: r.headers.get('retry-after') }
    })
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
}

test('bestQuote prefers a successful external quote when the direct router is rate-limited', () =>
  serve(rateLimited(), () => Response.json(externalQuote), async get => {
    const r = await get()
    assert.equal(r.status, 200)
    assert.equal(r.data.outAmount, '900')
  }))

test('bestQuote returns 503 rate-limited with retry-after 2 only when both sources failed transiently', async () => {
  for (const status of [429, 500, 503]) {
    await serve(rateLimited(), () => new Response('busy', { status }), async get => {
      const r = await get()
      assert.equal(r.status, 503)
      assert.equal(r.data.error, RATE_LIMITED_MESSAGE)
      assert.equal(r.retryAfter, '2')
    })
  }
  // Direct-only deployments: the direct router's transient failure is the answer.
  await serve(rateLimited(), null, async get => {
    const r = await get()
    assert.equal(r.status, 503)
    assert.equal(r.retryAfter, '2')
  })
})

test('bestQuote keeps 404 when either source genuinely has no route', async () => {
  await serve(rateLimited(), () => Response.json({ error: 'no route' }, { status: 404 }), async get => {
    assert.equal((await get()).status, 404)
  })
  await serve(new DirectRouteError(404, 'No executable direct pool route'), () => new Response('busy', { status: 429 }), async get => {
    const r = await get()
    assert.equal(r.status, 404)
    assert.equal(r.data.error, 'No executable route is available for this pair and amount')
  })
})

test('SOLANA_QUOTE_RPC_URL falls back to SOLANA_RPC_URL and is redacted like it', async () => {
  const saved = ['SOLANA_RPC_URL', 'SOLANA_QUOTE_RPC_URL', 'DRPC_KEY'].map(k => [k, process.env[k]] as const)
  try {
    delete process.env.DRPC_KEY
    process.env.SOLANA_RPC_URL = 'https://main.example/?api-key=main-secret-key'
    delete process.env.SOLANA_QUOTE_RPC_URL
    const fallback = (await import('../src/config.ts?quote-rpc=fallback')).config
    assert.equal(fallback.solanaQuoteRpc, process.env.SOLANA_RPC_URL)
    process.env.SOLANA_QUOTE_RPC_URL = 'https://quote.example/?api-key=quote-secret-key'
    const own = await import('../src/config.ts?quote-rpc=own')
    assert.equal(own.config.solanaQuoteRpc, 'https://quote.example/?api-key=quote-secret-key')
    assert.equal(own.config.solanaRpc, 'https://main.example/?api-key=main-secret-key')
    assert.equal(own.redact('failed at https://quote.example/?api-key=quote-secret-key').includes('quote-secret-key'), false)
  } finally {
    for (const [k, v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

test('the direct router uses the quote RPC; the wallet RPC proxy keeps the main endpoint', async () => {
  const urls: string[] = [], directUrls: string[] = []
  const handler = createSolanaRouterHandler({ rpcUrl: 'https://main.example/?api-key=m', quoteRpcUrl: 'https://quote.example/?api-key=q',
    selfRouter: true,
    fetch: async (input, init) => { urls.push(String(input)); return Response.json({ jsonrpc: '2.0', id: JSON.parse(String(init?.body)).id, result: 1 }) } })
  const original = globalThis.fetch
  // The direct router's Connection reads through the shared wrapper over globalThis.fetch.
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    if (!String(input).startsWith('https://')) return original(input, init)
    directUrls.push(String(input))
    const request = JSON.parse(String(init?.body))
    return Response.json({ jsonrpc: '2.0', id: request.id, result: { context: { slot: 1 }, value: null } })
  }) as typeof fetch
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    if (!await handler(req, res, new URL(req.url ?? '/', 'http://localhost'), body)) res.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/solana/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [SOL] }) })
    assert.equal(r.status, 200)
    assert.deepEqual(urls, ['https://main.example/?api-key=m'])
    const q = new URLSearchParams({ inputMint: SOL, outputMint: TOKEN, amount: '10000000', slippageBps: '100' })
    const quote = await fetch(`http://127.0.0.1:${port}/api/quote/solana?${q}`)
    assert.equal(quote.status, 404) // the fake pool account is missing: a genuine no-route
    assert.ok(directUrls.length > 0)
    assert.ok(directUrls.every(u => u === 'https://quote.example/?api-key=q'))
    assert.equal(JSON.stringify(await quote.json()).includes('api-key'), false)
  } finally {
    globalThis.fetch = original
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
