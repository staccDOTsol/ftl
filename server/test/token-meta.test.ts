import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { createTokenMetaHandler, httpImage, MAX_BATCH, parseDasAsset, type TokenMetaCatalog } from '../src/solana/token-meta.ts'
import type { TokenMeta, TokenSummary } from '../../shared/types.ts'

const KNOWN = '53cTDPa69sUXtn4FiuXiKEipJGkUUaNxoisBiuSFkd5i'      // FTL row with a symbol
const UNNAMED = 'A9ECbJ9UKSgf92A5QTW7dcJMcA14mUw3g3c4SMkNKnH4'    // FTL row, no symbol → DAS
const FRESH = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'      // nothing anywhere but the mint account
const WALLET = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy'     // a system account, not a mint
const DAS = 'https://das.example/?api-key=das-secret-key'
const RPC = 'https://rpc.example/?api-key=rpc-secret-key'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

const row = (address: string, symbol?: string, extra: Partial<TokenSummary> = {}): TokenSummary => ({ chain: 'solana', address, symbol, name: symbol ? `${symbol} coin` : undefined, image: symbol ? `https://img.example/${symbol}.png` : undefined, decimals: 6,
  launchedTs: null, launchVenue: null, graduatedTs: null, firstPoolTs: null, pools: 0, fundedPools: 0, lpWallets: 0, events: 0, lastTs: 0, score: 0, flags: [], ...extra })
const dasAsset = (id: string) => ({ id, content: { metadata: { name: 'Bread Token', symbol: 'BREAD', description: 'carbs' }, links: { image: 'ipfs://QmBreadImageCid' }, files: [] }, token_info: { decimals: 9, token_program: TOKEN_2022 } })
const mintAccount = (decimals: number, owner = TOKEN_PROGRAM) => ({ context: { slot: 1 }, value: { owner, lamports: 1, executable: false, rentEpoch: 0, data: { program: 'spl-token', parsed: { type: 'mint', info: { decimals, supply: '1', isInitialized: true } } } } })
const rpcResult = (result: unknown) => Response.json({ jsonrpc: '2.0', id: 1, result })

type Scenario = { das?: (mint: string) => unknown; chain?: (mint: string) => unknown; dasFails?: boolean }
function fakeFetch(scenario: Scenario, calls: { url: string; method: string; mint: string }[]): typeof fetch {
  return async (input, init) => {
    const url = String(input), body = JSON.parse(String(init?.body))
    const mint = body.method === 'getAsset' ? body.params.id : body.params[0]
    calls.push({ url, method: body.method, mint })
    if (url === DAS) {
      if (scenario.dasFails) return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: `DAS down at ${DAS}` } })
      return rpcResult(scenario.das ? scenario.das(mint) : null)
    }
    if (url === RPC) return rpcResult(scenario.chain ? scenario.chain(mint) : { context: { slot: 1 }, value: null })
    return new Response('nope', { status: 500 })
  }
}

async function withServer(scenario: Scenario, run: (request: (path: string, headers?: Record<string, string>) => Promise<{ status: number; data: any; text: string; headers: Headers }>, calls: { url: string; method: string; mint: string }[], learned: { mint: string; meta: TokenMeta; complete: boolean }[]) => Promise<void>, options: { dasUrl?: string; rpcUrl?: string; now?: () => number } = {}) {
  const calls: { url: string; method: string; mint: string }[] = []
  const learned: { mint: string; meta: TokenMeta; complete: boolean }[] = []
  const rows = new Map<string, TokenSummary>([[KNOWN, row(KNOWN, 'KNOWN')], [UNNAMED, row(UNNAMED, undefined, { pools: 2, fundedPools: 2 })]])
  const catalog: TokenMetaCatalog = {
    token: mint => rows.get(mint) ?? null,
    tokenProgram: mint => mint === KNOWN ? TOKEN_PROGRAM : null,
    learn: (mint, meta, complete) => { learned.push({ mint, meta, complete }); rows.set(mint, { ...(rows.get(mint) ?? row(mint)), ...meta }) },
  }
  const handler = createTokenMetaHandler({ dasUrl: 'dasUrl' in options ? options.dasUrl : DAS, rpcUrl: 'rpcUrl' in options ? options.rpcUrl : RPC, catalog, fetch: fakeFetch(scenario, calls), now: options.now })
  const server = http.createServer(async (req, res) => {
    if (!await handler(req, res, new URL(req.url ?? '/', 'http://localhost'))) res.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const request = async (path: string, headers: Record<string, string> = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers })
    const text = await r.text()
    return { status: r.status, data: text ? JSON.parse(text) : null, text, headers: r.headers }
  }
  try { await run(request, calls, learned) } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
}

test('an FTL row with a symbol answers without any upstream call', async () => withServer({}, async (request, calls, learned) => {
  const r = await request(`/api/meta/solana/${KNOWN}`)
  assert.equal(r.status, 200)
  assert.deepEqual(r.data, { mint: KNOWN, symbol: 'KNOWN', name: 'KNOWN coin', image: 'https://img.example/KNOWN.png', decimals: 6, tokenProgram: 'token', source: 'ftl' })
  assert.equal(calls.length, 0)
  assert.equal(learned.length, 0)
}))

test('a DAS hit names the mint, persists what it learned and is cached for ten minutes', async () => {
  let clock = 1_000_000
  await withServer({ das: dasAsset }, async (request, calls, learned) => {
    const r = await request(`/api/meta/solana/${UNNAMED}`)
    assert.equal(r.status, 200)
    assert.deepEqual(r.data, { mint: UNNAMED, symbol: 'BREAD', name: 'Bread Token', image: 'https://ipfs.filebase.io/ipfs/QmBreadImageCid', decimals: 9, tokenProgram: 'token-2022', source: 'das' })
    assert.deepEqual(calls, [{ url: DAS, method: 'getAsset', mint: UNNAMED }])
    assert.deepEqual(learned, [{ mint: UNNAMED, meta: { name: 'Bread Token', symbol: 'BREAD', image: 'https://ipfs.filebase.io/ipfs/QmBreadImageCid', description: 'carbs', decimals: 9 }, complete: true }])
    // second read inside the TTL: memo, no upstream call
    clock += 9 * 60_000
    assert.equal((await request(`/api/meta/solana/${UNNAMED}`)).data.symbol, 'BREAD')
    assert.equal(calls.length, 1)
    // the persisted row now answers as an FTL hit once the memo expires
    clock += 2 * 60_000
    const again = await request(`/api/meta/solana/${UNNAMED}`)
    assert.equal(again.data.source, 'ftl'); assert.equal(again.data.symbol, 'BREAD')
    assert.equal(calls.length, 1)
  }, { now: () => clock })
})

test('without DAS metadata the mint account still yields decimals and the token program, symbol null', async () => withServer({ chain: () => mintAccount(5, TOKEN_2022) }, async (request, calls, learned) => {
  const r = await request(`/api/meta/solana/${FRESH}`)
  assert.equal(r.status, 200)
  assert.deepEqual(r.data, { mint: FRESH, symbol: null, name: null, image: null, decimals: 5, tokenProgram: 'token-2022', source: 'chain' })
  assert.deepEqual(calls.map(c => c.method), ['getAsset', 'getAccountInfo'])
  assert.equal(learned.length, 0)
}))

test('a DAS outage falls through to decimals, and neither endpoint URL ever reaches the client', async () => {
  await withServer({ dasFails: true, chain: () => mintAccount(6) }, async (request, calls) => {
    const r = await request(`/api/meta/solana/${FRESH}`)
    assert.equal(r.status, 200); assert.equal(r.data.source, 'chain'); assert.equal(r.data.decimals, 6)
    assert.deepEqual(calls.map(c => c.method), ['getAsset', 'getAccountInfo'])
  })
  // DAS down and no mint account found: unknown, not "not a mint"
  await withServer({ dasFails: true }, async (request) => {
    const r = await request(`/api/meta/solana/${FRESH}`)
    assert.equal(r.status, 502)
    assert.ok(!r.text.includes('secret'), r.text)
    assert.equal(r.data.error, 'Token metadata is temporarily unavailable; retry shortly')
  })
  await withServer({ dasFails: true }, async (request) => {
    const r = await request(`/api/meta/solana/${FRESH}`)
    assert.equal(r.status, 502)
    assert.ok(!r.text.includes('secret'), r.text)
    assert.equal(r.data.error, 'Token metadata is temporarily unavailable; retry shortly')
  }, { rpcUrl: undefined })
})

test('a non-mint account is a 404 and bad addresses are rejected before any upstream call', async () => withServer({ chain: () => ({ context: { slot: 1 }, value: { owner: '11111111111111111111111111111111', data: ['', 'base64'] } }) }, async (request, calls) => {
  for (const bad of ['abc', '1'.repeat(44), 'not-base58-!', encodeURIComponent('%zz')]) {
    const r = await request(`/api/meta/solana/${bad}`)
    assert.equal(r.status, 400); assert.equal(r.data.error, 'Invalid Solana address')
  }
  assert.equal(calls.length, 0)
  const r = await request(`/api/meta/solana/${WALLET}`)
  assert.equal(r.status, 404); assert.equal(r.data.error, 'This address is not a token mint')
  assert.equal((await request('/api/meta/robinhood/0xabc')).status, 404)
  assert.equal((await request(`/api/meta/solana/${WALLET}/more`)).status, 404)
}))

test('batch form resolves many mints at once, drops unknowns, caps at 50 and validates every address', async () => withServer({ das: mint => mint === UNNAMED ? dasAsset(mint) : null, chain: mint => mint === FRESH ? mintAccount(2) : { context: { slot: 1 }, value: null } }, async (request, calls) => {
  const r = await request(`/api/meta/solana?mints=${[KNOWN, UNNAMED, FRESH, WALLET, KNOWN].join(',')}`)
  assert.equal(r.status, 200)
  assert.deepEqual(r.data.tokens.map((t: any) => [t.mint, t.symbol, t.source]), [[KNOWN, 'KNOWN', 'ftl'], [UNNAMED, 'BREAD', 'das'], [FRESH, null, 'chain']])
  assert.equal(calls.filter(c => c.mint === KNOWN).length, 0)
  const many = Array.from({ length: MAX_BATCH + 1 }, () => KNOWN).map((m, i) => i === 0 ? m : `${m.slice(0, -2)}${String(i).padStart(2, '0')}`)
  const over = await request(`/api/meta/solana?mints=${many.join(',')}`)
  assert.equal(over.status, 400); assert.equal(over.data.error, `At most ${MAX_BATCH} mints per request`)
  const mixed = await request(`/api/meta/solana?mints=${KNOWN},garbage`)
  assert.equal(mixed.status, 400); assert.equal(mixed.data.error, 'Invalid Solana address')
  const empty = await request('/api/meta/solana?mints=')
  assert.equal(empty.status, 400)
}))

test('per-IP rate limit answers 429 with retry-after', async () => withServer({}, async (request) => {
  for (let i = 0; i < 60; i++) assert.equal((await request(`/api/meta/solana/${KNOWN}`, { 'fly-client-ip': '203.0.113.9' })).status, 200)
  const limited = await request(`/api/meta/solana/${KNOWN}`, { 'fly-client-ip': '203.0.113.9' })
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60')
  assert.equal((await request(`/api/meta/solana/${KNOWN}`, { 'fly-client-ip': '203.0.113.10' })).status, 200)
}))

test('parseDasAsset and httpImage are the shared DAS → meta mapping', () => {
  assert.equal(parseDasAsset(null), null)
  assert.equal(parseDasAsset({ content: {} }), null)
  const parsed = parseDasAsset({ id: FRESH, content: { metadata: { name: '  Spaced  ', symbol: '' }, files: [{ uri: 'https://x.example/a.json', mime: 'application/json' }, { uri: 'ar://abc', mime: 'image/png' }] }, token_info: { decimals: 99 } })
  assert.deepEqual(parsed, { meta: { name: 'Spaced', symbol: undefined, image: 'https://arweave.net/abc', description: undefined, decimals: undefined }, tokenProgram: null })
  assert.equal(httpImage('https://gateway.pinata.cloud/ipfs/QmX/1.png'), 'https://ipfs.filebase.io/ipfs/QmX/1.png')
  assert.equal(httpImage('javascript:alert(1)'), undefined)
})
