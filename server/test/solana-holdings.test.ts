import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { createSolanaHoldingsHandler, parseTokenAccounts, rankActions, SOL_MINT, type HoldingsCatalog } from '../src/solana/holdings.ts'
import { createSolanaRouterHandler } from '../src/solana/router.ts'

const OWNER = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy'
const BREAD = '53cTDPa69sUXtn4FiuXiKEipJGkUUaNxoisBiuSFkd5i'
const DUST = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const HOT_A = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const HOT_B = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const POOL = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'
const POSITION = '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const RPC = 'https://rpc.example/?api-key=private-key'
const ACC_BREAD = 'GhFJh9xhWQULf6W1WJLNTViiTWEs4wAj3FevZ616wxL2'
const ACC_EMPTY = 'HqznL4EpJTbWZmqqetb4sJPftBUN1s6uNdQURBAfAsBr'
const ACC_WSOL = '2iXtA8oeZqUU5pofxK971TCEvFGfems2AcDRaZHKD2pQ'
const ACC_DUST = '5eUm8K9YiCqAxtyZgmmN1NGhmD3D2C9Azp2Za7nxwhiN'

const tokenRow = (address: string, symbol: string, pools = 1, fundedPools = 1, score = 10) => ({ chain: 'solana' as const, address, symbol, name: symbol, image: undefined, decimals: 6, launchedTs: null, launchVenue: null, graduatedTs: null, firstPoolTs: 1, pools, fundedPools, lpWallets: 1, events: 1, lastTs: 1, score, flags: [] })
const poolRow = (address: string, token: string, funded: boolean, venue = 'orca') => ({ chain: 'solana' as const, address, venue, token, quote: SOL_MINT, feeBps: 30, createdTs: 1, creator: null, liqEvents: 1, funded })
const catalog: HoldingsCatalog = {
  token: mint => mint === BREAD ? tokenRow(BREAD, 'BREAD') : mint === DUST ? tokenRow(DUST, 'DUST', 1, 0) : null,
  pools: mint => mint === BREAD ? [poolRow(POOL, BREAD, true), poolRow(POSITION, BREAD, false, 'raydium-cpmm')] : mint === DUST ? [poolRow(HOT_B, DUST, false)] : [],
  hot: () => [tokenRow(HOT_A, 'HOTA', 3, 2, 90), tokenRow(BREAD, 'BREAD'), tokenRow(HOT_B, 'HOTB', 1, 1, 50)],
}
const account = (pubkey: string, mint: string, amount: string, decimals = 6, extra: Record<string, unknown> = {}, program = TOKEN_PROGRAM) => ({ pubkey, account: { owner: program, data: { program: program === TOKEN_PROGRAM ? 'spl-token' : 'spl-token-2022', parsed: { type: 'account', info: { mint, owner: OWNER, tokenAmount: { amount, decimals, uiAmountString: amount }, ...extra } } } } })
const rpcResult = (result: unknown) => Response.json({ jsonrpc: '2.0', id: 1, result })

type Responder = (body: any, url: string) => Response
function defaultResponder(body: any, url: string): Response {
  if (url.includes('/liquidity/positions')) return Response.json({ positions: [{ venue: 'orca', pool: POOL, position: POSITION, mintA: SOL_MINT, mintB: BREAD, liquidity: '5000' }, { venue: 'meteora-dlmm', pool: HOT_A, position: HOT_B, mintA: BREAD, mintB: SOL_MINT, liquidity: null, removalMode: 'percentage' }, { venue: 'raydium-clmm', pool: POOL, position: DUST, mintA: BREAD, mintB: SOL_MINT, liquidity: '0' }], errors: [{ venue: 'pumpswap', error: 'pool address required https://router.example/secret' }] })
  if (body.method === 'getBalance') return rpcResult({ context: { slot: 1 }, value: 1_500_000_000 })
  if (body.method === 'getTokenAccountsByOwner') {
    const program = body.params[1].programId
    if (program === TOKEN_PROGRAM) return rpcResult({ context: { slot: 1 }, value: [account(ACC_BREAD, BREAD, '2500000'), account(ACC_EMPTY, DUST, '0'), account(ACC_WSOL, SOL_MINT, '300000000', 9, { isNative: true })] })
    if (program === TOKEN_2022) return rpcResult({ context: { slot: 1 }, value: [account(ACC_DUST, DUST, '42000000', 6, {}, TOKEN_2022)] })
  }
  return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: `unknown method at ${RPC}` } })
}
async function withServer(run: (request: (path: string) => Promise<{ status: number; data: any; text: string }>, calls: { url: string; body: any }[]) => Promise<void>, responder: Responder = defaultResponder, options: { rpc?: string | undefined; router?: boolean } = {}) {
  const calls: { url: string; body: any }[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input), body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url, body })
    return responder(body, url)
  }
  const router = createSolanaRouterHandler({ routerUrl: options.router === false ? undefined : 'http://router.example', rpcUrl: RPC, fetch: fetcher })
  const handler = createSolanaHoldingsHandler({ rpcUrl: 'rpc' in options ? options.rpc : RPC, catalog, positions: router.positions, fetch: fetcher })
  const server = http.createServer(async (req, res) => {
    if (!await handler(req, res, new URL(req.url ?? '/', 'http://localhost'))) res.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const request = async (path: string) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`)
    const text = await r.text()
    return { status: r.status, data: text ? JSON.parse(text) : null, text }
  }
  try { await run(request, calls) } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
}

test('holdings rejects invalid owners before any upstream call and ignores other routes', async () => withServer(async (request, calls) => {
  for (const owner of ['abc', '1'.repeat(44), 'not-base58-!', encodeURIComponent('%zz')]) {
    const r = await request(`/api/holdings/solana/${owner}`)
    assert.equal(r.status, 400); assert.equal(r.data.error, 'Invalid Solana address')
  }
  assert.equal((await request('/api/holdings/robinhood/0xabc')).status, 404)
  assert.equal((await request(`/api/holdings/solana/${OWNER}/extra`)).status, 404)
  assert.equal(calls.length, 0)
}))

test('token accounts are parsed for both token programs, zero balances dropped, wrapped SOL flagged', async () => withServer(async (request, calls) => {
  const r = await request(`/api/holdings/solana/${OWNER}`)
  assert.equal(r.status, 200)
  assert.equal(r.data.owner, OWNER)
  assert.deepEqual(r.data.sol, { lamports: '1500000000' })
  const programs = calls.filter(c => c.body?.method === 'getTokenAccountsByOwner').map(c => c.body.params[1].programId).sort()
  assert.deepEqual(programs, [TOKEN_PROGRAM, TOKEN_2022].sort())
  assert.ok(calls.filter(c => c.body?.method === 'getTokenAccountsByOwner').every(c => c.body.params[2].encoding === 'jsonParsed'))
  assert.deepEqual(r.data.tokens.map((t: any) => [t.mint, t.amount, t.decimals, t.program, t.wrappedSol]), [
    [BREAD, '2500000', 6, 'token', false], [SOL_MINT, '300000000', 9, 'token', true], [DUST, '42000000', 6, 'token-2022', false]])
  const bread = r.data.tokens.find((t: any) => t.mint === BREAD)
  assert.equal(bread.token.symbol, 'BREAD'); assert.equal(bread.pools.length, 2)
  assert.equal(r.data.tokens.find((t: any) => t.wrappedSol).token, null)
  assert.equal(r.data.positions.positions.length, 3)
  assert.deepEqual(r.data.positions.errors, [{ venue: 'pumpswap', error: 'pool address required [provider]' }])
  const positionsCall = calls.find(c => c.url.includes('/liquidity/positions'))!
  assert.equal(new URL(positionsCall.url).searchParams.get('owner'), OWNER)
  assert.equal(new URL(positionsCall.url).searchParams.has('venue'), false)
}))

test('actions rank exits, then sells/adds by balance, then buys, with in-app hrefs', async () => withServer(async request => {
  const r = await request(`/api/holdings/solana/${OWNER}`)
  const actions = r.data.actions as { kind: string; href: string; title: string }[]
  assert.deepEqual(actions.map(a => a.kind), ['exit', 'exit', 'sell', 'sell', 'add', 'unwrap', 'buy', 'buy'])
  assert.equal(actions[0].href, `/token/solana/${BREAD}?action=exit`)
  assert.equal(actions[1].href, `/token/solana/${BREAD}?action=exit`)
  assert.equal(actions.filter(a => a.kind === 'exit').length, 2, 'zero-liquidity position has no exit')
  // by held UI balance: DUST 42 > BREAD 2.5 > wrapped SOL 0.3
  assert.equal(actions[2].href, `/token/solana/${DUST}?action=sell`)
  assert.equal(actions[3].href, `/token/solana/${BREAD}?action=sell`)
  assert.equal(actions[4].href, `/token/solana/${BREAD}?action=liquidity`)
  assert.equal(actions[5].href, `/token/solana/${SOL_MINT}`)
  assert.ok(!actions.some(a => a.kind === 'add' && a.href.includes(DUST)), 'tokens without a funded pool get no add action')
  assert.deepEqual(actions.filter(a => a.kind === 'buy').map(a => a.href), [`/token/solana/${HOT_A}`, `/token/solana/${HOT_B}`], 'held mints are not suggested as buys')
  for (const a of actions) { assert.ok(a.href.startsWith('/token/solana/')); assert.ok(a.title && (a as any).detail) }
}))

test('pure ranking caps at 40, skips buys under 0.02 SOL, and sorts by held balance', () => {
  const tokens = Array.from({ length: 30 }, (_, i) => ({ account: `a${i}`, mint: `mint${i}`, amount: String((i + 1) * 1_000_000), decimals: 6, program: 'token' as const, wrappedSol: false, token: null, pools: [poolRow(POOL, `mint${i}`, true)] }))
  const ranked = rankActions({ lamports: '20000000', tokens, positions: [], hot: [tokenRow(HOT_A, 'HOTA')] })
  assert.equal(ranked.length, 40)
  assert.equal(ranked[0].href, '/token/solana/mint29?action=sell')
  assert.equal(ranked[1].href, '/token/solana/mint29?action=liquidity')
  assert.ok(!ranked.some(a => a.kind === 'buy'))
  const rich = rankActions({ lamports: '20000001', tokens: [], positions: [], hot: Array.from({ length: 8 }, (_, i) => tokenRow(`hot${i}`, `H${i}`)) })
  assert.equal(rich.filter(a => a.kind === 'buy').length, 5)
  const bin = rankActions({ lamports: '0', tokens: [], positions: [{ venue: 'meteora-dlmm', pool: POOL, position: POSITION, mintA: SOL_MINT, mintB: BREAD, removalMode: 'percentage' }], hot: [] })
  assert.equal(bin.length, 1); assert.equal(bin[0].href, `/token/solana/${BREAD}?action=exit`)
})

test('token account parsing tolerates malformed rows', () => {
  const parsed = parseTokenAccounts([account(ACC_BREAD, BREAD, '1'), { pubkey: 'bad' }, { pubkey: OWNER, account: { data: { parsed: { type: 'mint', info: {} } } } }, account(ACC_EMPTY, BREAD, '1.5')], 'token-2022')
  assert.deepEqual(parsed, [{ account: ACC_BREAD, mint: BREAD, amount: '1', decimals: 6, program: 'token-2022', wrappedSol: false }])
  assert.deepEqual(parseTokenAccounts(null, 'token'), [])
})

test('RPC endpoint and credentials never appear in any response or error', async () => {
  const leak = (text: string) => assert.ok(!text.includes('rpc.example') && !text.includes('private-key') && !text.includes('router.example'), text)
  await withServer(async request => { const r = await request(`/api/holdings/solana/${OWNER}`); assert.equal(r.status, 200); leak(r.text) })
  await withServer(async request => { const r = await request(`/api/holdings/solana/${OWNER}`); assert.equal(r.status, 502); leak(r.text) },
    () => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: `rate limited at ${RPC}` } }))
  await withServer(async request => { const r = await request(`/api/holdings/solana/${OWNER}`); assert.equal(r.status, 503); leak(r.text) },
    () => { throw new Error(`connect ECONNREFUSED ${RPC}`) })
  await withServer(async request => { const r = await request(`/api/holdings/solana/${OWNER}`); assert.equal(r.status, 503); leak(r.text) },
    () => new Response(`<html>${RPC}</html>`, { status: 500 }))
  // Positions failing must not fail the wallet read, and must not leak either.
  await withServer(async request => {
    const r = await request(`/api/holdings/solana/${OWNER}`)
    assert.equal(r.status, 200); leak(r.text)
    assert.deepEqual(r.data.positions.positions, [])
    assert.equal(r.data.positions.error, 'boom [provider]')
    assert.equal(r.data.actions.filter((a: any) => a.kind === 'exit').length, 0)
  }, (body, url) => url.includes('/liquidity/positions') ? Response.json({ message: `boom ${RPC}` }, { status: 500 }) : defaultResponder(body, url))
})

test('unconfigured RPC answers 503 without calling upstream; unconfigured router reports positions honestly', async () => {
  await withServer(async (request, calls) => {
    const r = await request(`/api/holdings/solana/${OWNER}`)
    assert.equal(r.status, 503); assert.match(r.data.error, /not configured/); assert.equal(calls.length, 0)
  }, defaultResponder, { rpc: undefined })
  await withServer(async (request, calls) => {
    const r = await request(`/api/holdings/solana/${OWNER}`)
    assert.equal(r.status, 200)
    assert.match(r.data.positions.error, /not configured/)
    assert.ok(!calls.some(c => c.url.includes('/liquidity/positions')))
  }, defaultResponder, { router: false })
})

test('per-client holdings reads are limited to 30 per minute', async () => withServer(async request => {
  for (let i = 0; i < 30; i++) assert.equal((await request(`/api/holdings/solana/${OWNER}`)).status, 200)
  const r = await request(`/api/holdings/solana/${OWNER}`)
  assert.equal(r.status, 429); assert.match(r.data.error, /limit/)
}))
