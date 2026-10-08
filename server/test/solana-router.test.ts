import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import nacl from 'tweetnacl'
import { createSolanaRouterHandler, transaction, transactionVersion, validateRpc, validPublicKey, validateLiquidityRequest } from '../src/solana/router.ts'

const SOL = 'So11111111111111111111111111111111111111112'
const BREAD = '53cTDPa69sUXtn4FiuXiKEipJGkUUaNxoisBiuSFkd5i'
const q = { inputMint: SOL, outputMint: BREAD, inAmount: '1000000', outAmount: '2000000', otherAmountThreshold: '1980000', swapMode: 'ExactIn', slippageBps: 100, routePlan: [{ percent: 100, swapInfo: { label: 'DBC', inputMint: SOL, outputMint: BREAD } }], contextSlot: 42, timeTaken: 0.1, accounts: [{ secret: 'do not forward account snapshots' }] }
function encodedTx(signed = false) {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7))
  const message = Buffer.concat([Buffer.from([128, 1, 0, 0, 1]), Buffer.from(kp.publicKey), Buffer.alloc(32, 1), Buffer.from([0, 0])])
  const signature = signed ? nacl.sign.detached(message, kp.secretKey) : new Uint8Array(64)
  return Buffer.concat([Buffer.from([1]), Buffer.from(signature), message]).toString('base64')
}
function encodedV1(signed = false, options: { payloadSize?: number; signerCount?: number } = {}) {
  const signerCount = options.signerCount ?? 1
  const signers = Array.from({ length: signerCount }, (_, i) => nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7 + i)))
  const header = Buffer.alloc(42)
  header.set([0x81, signerCount, 0, 1])
  header.writeUInt32LE(15, 4)
  header.fill(1, 8, 40)
  header[40] = 1; header[41] = signerCount + 1
  const limits = Buffer.alloc(16)
  limits.writeBigUInt64LE(1000n, 0); limits.writeUInt32LE(200000, 8); limits.writeUInt32LE(67108864, 12)
  const instruction = Buffer.from([signerCount, 1, 0, 0])
  instruction.writeUInt16LE(options.payloadSize ?? 4, 2)
  const message = Buffer.concat([header, ...signers.map(kp => Buffer.from(kp.publicKey)), Buffer.alloc(32, 0), limits, instruction, Buffer.from([0]), Buffer.alloc(options.payloadSize ?? 4, 5)])
  return Buffer.concat([message, ...signers.map(kp => signed ? Buffer.from(nacl.sign.detached(message, kp.secretKey)) : Buffer.alloc(64))]).toString('base64')
}
async function withServer(run: (request: (path: string, body?: unknown) => Promise<{ status: number; data: any }>, calls: Array<{ url: string; body: any }>) => Promise<void>, responder?: (url: string, body: any) => Response, options: { configured?: boolean } = {}) {
  const calls: Array<{ url: string; body: any }> = []
  const handler = createSolanaRouterHandler({ routerUrl: options.configured === false ? undefined : 'http://router.example', rpcUrl: 'https://rpc.example/?api-key=private-key', fetch: async (input, init) => {
    const url = String(input), body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url, body })
    if (responder) return responder(url, body)
    if (url.includes('/quote?')) return Response.json(q)
    if (url.endsWith('/swap')) return Response.json({ swapTransaction: body.transactionVersion === '1' ? encodedV1() : encodedTx(), transactionVersion: body.transactionVersion, lastValidBlockHeight: 999, priorizationFeeLamports: 100 })
    if (url.endsWith('/health')) return Response.json({ status: 'ok', discovery: { dbc: 'ready' } })
    return Response.json({ jsonrpc: '2.0', id: 1, result: 10 })
  } })
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    if (!await handler(req, res, new URL(req.url ?? '/', 'http://localhost'), body)) res.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const request = async (path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: r.status, data: await r.json() }
  }
  try { await run(request, calls) } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
}
const query = `/api/quote/solana?${new URLSearchParams({ inputMint: SOL, outputMint: BREAD, amount: '1000000', slippageBps: '100' })}`

test('validates decoded public key size, not only base58 characters', () => {
  assert.equal(validPublicKey(SOL), true)
  assert.equal(validPublicKey('1'.repeat(44)), false)
})
test('quote forwards validated intent and strips account snapshots', async () => withServer(async (request, calls) => {
  const r = await request(query)
  assert.equal(r.status, 200); assert.equal(r.data.outAmount, '2000000'); assert.equal(r.data.accounts, undefined)
  assert.equal(new URL(calls[0].url).searchParams.get('swapMode'), 'ExactIn')
  assert.equal(new URL(calls[0].url).searchParams.get('transactionVersion'), '1')
  assert.equal(r.data.transactionVersion, '1')
}))
test('rejects overflow, fractional and zero amounts and excessive slippage before upstream', async () => withServer(async (request, calls) => {
  for (const value of ['0', '1.5', '-1', '18446744073709551616']) assert.equal((await request(query.replace('amount=1000000', `amount=${value}`))).status, 400)
  assert.equal((await request(query.replace('slippageBps=100', 'slippageBps=1001'))).status, 400)
  assert.equal(calls.length, 0)
}))
test('swap replaces tampered route plan and strips fee/destination overrides', async () => withServer(async (request, calls) => {
  const r = await request('/api/swap/solana', { userPublicKey: SOL, quoteResponse: { ...q, routePlan: [{ malicious: true }] }, feeAccount: BREAD, destinationTokenAccount: BREAD })
  assert.equal(r.status, 200); assert.equal(calls.length, 2)
  const build = calls[1].body
  assert.deepEqual(build.quoteResponse.routePlan, q.routePlan)
  assert.equal(build.destinationTokenAccount, undefined); assert.equal(build.feeAccount, undefined)
  assert.equal(build.quoteResponse.accounts, undefined)
  assert.equal(r.data.prioritizationFeeLamports, 100)
  assert.equal(r.data.lastValidBlockHeight, 999)
}))
test('a worsening requote cannot lower the user minimum', async () => withServer(async (request, calls) => {
  const r = await request('/api/swap/solana', { userPublicKey: SOL, quoteResponse: q })
  assert.equal(r.status, 409); assert.equal(calls.length, 1)
}, () => Response.json({ ...q, outAmount: '1900000', otherAmountThreshold: '1881000' })))
test('a still-acceptable requote preserves the stricter previous minimum', async () => withServer(async (request, calls) => {
  const r = await request('/api/swap/solana', { userPublicKey: SOL, quoteResponse: q })
  assert.equal(r.status, 200); assert.equal(calls[1].body.quoteResponse.otherAmountThreshold, q.otherAmountThreshold)
}, url => url.includes('/quote?') ? Response.json({ ...q, outAmount: '1990000', otherAmountThreshold: '1970100' }) : Response.json({ swapTransaction: encodedV1(), transactionVersion: '1', lastValidBlockHeight: 999 })))
test('upstream errors never expose the RPC credential or endpoint', async () => withServer(async request => {
  const r = await request('/api/solana/rpc', { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [SOL] })
  assert.equal(r.status, 200)
  assert.equal(JSON.stringify(r.data).includes('private-key'), false)
  assert.equal(JSON.stringify(r.data).includes('rpc.example'), false)
}, () => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'https://rpc.example/?api-key=private-key' } })))
test('RPC denies expensive scans, batches and unsupported shapes', () => {
  for (const body of [[], { jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [SOL] }, { jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [SOL, {}] }, { jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [SOL, { encoding: 'base58' }] }]) assert.throws(() => validateRpc(body))
})
test('RPC normalizes safe wallet reads and simulation config', () => {
  assert.deepEqual(validateRpc({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [SOL, { mint: BREAD }] }).params, [SOL, { mint: BREAD }, { encoding: 'jsonParsed', commitment: 'confirmed' }])
  const p = validateRpc({ jsonrpc: '2.0', id: 1, method: 'simulateTransaction', params: [encodedTx()] }).params
  assert.deepEqual(p[1], { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' })
})
test('fee estimates accept only bounded supported transaction messages', () => {
  const message = Buffer.from(encodedTx(), 'base64').subarray(65).toString('base64')
  assert.deepEqual(validateRpc({ jsonrpc: '2.0', id: 1, method: 'getFeeForMessage', params: [message] }).params, [message, { commitment: 'confirmed' }])
  assert.throws(() => validateRpc({ jsonrpc: '2.0', id: 1, method: 'getFeeForMessage', params: ['bad'] }))
})
test('signed send validates signatures and enforces preflight', () => {
  assert.throws(() => transaction(encodedTx(), true), /wallet signatures/)
  assert.equal(transaction(encodedTx(true), true), encodedTx(true))
  assert.throws(() => validateRpc({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [encodedTx(true), { skipPreflight: true }] }), /Preflight/)
  const p = validateRpc({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [encodedTx(true)] }).params
  assert.deepEqual(p[1], { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 2 })
})
test('request size and per-client quote limits prevent unbounded forwarding', async () => withServer(async (request, calls) => {
  assert.equal((await request('/api/swap/solana', { x: 'x'.repeat(33000) })).status, 413)
  for (let i = 0; i < 40; i++) assert.equal((await request(query)).status, 200)
  assert.equal((await request(query)).status, 429)
  assert.equal(calls.length, 40)
}))
test('unconfigured deployment reports honest availability without calling upstream', async () => withServer(async (request, calls) => {
  assert.deepEqual((await request('/api/router/solana')).data, { configured: false, status: 'unavailable' })
  assert.equal((await request(query)).status, 503)
  assert.equal(calls.length, 0)
}, undefined, { configured: false }))

test('enabled direct router uses only its local quote/build path and ignores client route data', async () => {
  const calls: unknown[] = []
  const direct = {
    async quote(intent: any) {
      calls.push(['quote', intent])
      return { quote: { ...q, inputMint: intent.inputMint, outputMint: intent.outputMint,
        inAmount: intent.amount, slippageBps: intent.slippageBps,
        transactionVersion: intent.transactionVersion }, priced: {} as any }
    },
    async swap(intent: any, wallet: string, minimum: string) {
      calls.push(['swap', intent, wallet, minimum])
      return { swapTransaction: encodedV1(), transactionVersion: '1',
        lastValidBlockHeight: 999, quoteResponse: { ...q, transactionVersion: '1' } }
    },
  }
  const handler = createSolanaRouterHandler({ routerUrl: 'http://unwanted.example', rpcUrl: 'https://rpc.example',
    localRouter: direct, fetch: async () => { throw new Error('external router must not be called') } })
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    if (!await handler(req, res, new URL(req.url ?? '/', 'http://localhost'), body)) res.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    const quote = await fetch(`http://127.0.0.1:${port}${query}`).then(r => r.json())
    assert.equal(quote.outAmount, q.outAmount)
    const r = await fetch(`http://127.0.0.1:${port}/api/swap/solana`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userPublicKey: SOL,
        quoteResponse: { ...q, routePlan: [{ malicious: true }] }, destinationTokenAccount: BREAD }) })
    assert.equal(r.status, 200)
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1], ['swap', { inputMint: SOL, outputMint: BREAD,
      amount: '1000000', slippageBps: 100, transactionVersion: '1' }, SOL, q.otherAmountThreshold])
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('V1 validates signatures at the tail over the entire message including config', () => {
  const signed = encodedV1(true, { signerCount: 2 })
  assert.equal(transaction(signed, true), signed)
  assert.equal(transactionVersion(signed), '1')
  assert.throws(() => transaction(encodedV1(), true), /wallet signatures/)
  const changed = Buffer.from(signed, 'base64'); changed[8] ^= 1
  assert.throws(() => transaction(changed.toString('base64'), true), /wallet signatures/)
  changed[8] ^= 1; changed[changed.length - 1] ^= 1
  assert.throws(() => transaction(changed.toString('base64'), true), /wallet signatures/)
})
test('V1 accepts large transactions but preserves the V0 1232 byte limit', () => {
  const big = encodedV1(true, { payloadSize: 2000 })
  assert.ok(Buffer.from(big, 'base64').length > 1232)
  assert.equal(transaction(big, true), big)
  assert.throws(() => transaction(encodedV1(false, { payloadSize: 4000 }), false), /size|4096/)
  const oversizedV0 = Buffer.concat([Buffer.from(encodedTx(), 'base64'), Buffer.alloc(1232)])
  assert.throws(() => transaction(oversizedV0.toString('base64'), false), /1232/)
})
test('V1 rejects malformed masks, missing resource limits, bad headers, duplicate keys and indexes', () => {
  const mutate = (fn: (b: Buffer) => void) => { const bytes = Buffer.from(encodedV1(), 'base64'); fn(bytes); assert.throws(() => transaction(bytes.toString('base64'), false)) }
  mutate(b => b.writeUInt32LE(47, 4)) // unknown bit
  mutate(b => b.writeUInt32LE(13, 4)) // incomplete priority fee field
  mutate(b => b.writeUInt32LE(3, 4)) // omitted required resource fields
  mutate(b => b.writeUInt32LE(0, 114)) // zero CU
  mutate(b => b.writeUInt32LE(0, 118)) // zero loaded data
  mutate(b => b[1] = 13)
  mutate(b => b[2] = 1) // readonly payer
  mutate(b => b[40] = 65)
  mutate(b => b[41] = 65)
  mutate(b => b.copy(b, 74, 42, 74)) // duplicate account
  mutate(b => b[122] = 0) // payer as program
  mutate(b => b[122] = 2) // out-of-range program
  mutate(b => b[126] = 2) // out-of-range instruction account
  mutate(b => b.writeUInt16LE(999, 124)) // truncated payload
  assert.throws(() => transaction(Buffer.concat([Buffer.from(encodedV1(), 'base64'), Buffer.from([0])]).toString('base64'), false), /trailing/)
})
test('V1 fee estimation, simulation and signed submission retain the V1 bytes', () => {
  const signed = encodedV1(true), message = Buffer.from(signed, 'base64').subarray(0, -64).toString('base64')
  assert.equal(validateRpc({ jsonrpc: '2.0', id: 1, method: 'getFeeForMessage', params: [message] }).params[0], message)
  assert.equal(validateRpc({ jsonrpc: '2.0', id: 1, method: 'simulateTransaction', params: [encodedV1(false, { payloadSize: 2000 })] }).params[0], encodedV1(false, { payloadSize: 2000 }))
  assert.equal(validateRpc({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [signed] }).params[0], signed)
})
test('swap defaults to V1, while V0 requires explicit selection', async () => withServer(async (request, calls) => {
  const current = await request('/api/swap/solana', { userPublicKey: SOL, quoteResponse: q })
  assert.equal(current.status, 200); assert.equal(current.data.transactionVersion, '1'); assert.equal(calls[1].body.transactionVersion, '1')
  const fallback = await request('/api/swap/solana', { userPublicKey: SOL, quoteResponse: q, transactionVersion: 0 })
  assert.equal(fallback.status, 200); assert.equal(fallback.data.transactionVersion, '0'); assert.equal(calls[3].body.transactionVersion, '0')
  assert.equal(new URL(calls[2].url).searchParams.get('transactionVersion'), '0')
  assert.equal((await request('/api/swap/solana', { userPublicKey: SOL, quoteResponse: q, transactionVersion: 2 })).status, 400)
}))
test('swap rejects an upstream silent version downgrade', async () => withServer(async request => {
  const response = await request('/api/swap/solana', { userPublicKey: SOL, quoteResponse: q, transactionVersion: '1' })
  assert.equal(response.status, 502)
  assert.match(response.data.error, /different transaction version/)
}, url => url.includes('/quote?') ? Response.json(q) : Response.json({ swapTransaction: encodedTx(), lastValidBlockHeight: 999 })))

test('V1 accepts exactly 4096 bytes and rejects one extra byte', () => {
  const exact = encodedV1(false, { payloadSize: 3905 })
  assert.equal(Buffer.from(exact, 'base64').length, 4096)
  assert.equal(transaction(exact, false), exact)
  assert.throws(() => transaction(encodedV1(false, { payloadSize: 3906 }), false), /4096|size/)
})
test('V1 parses all instruction headers before their payloads and validates heap config', () => {
  const old = Buffer.from(encodedV1(), 'base64'), prefix = Buffer.from(old.subarray(0, 122))
  prefix[40] = 2
  const message = Buffer.concat([prefix, Buffer.from([1, 1, 4, 0, 1, 1, 2, 0]), Buffer.from([0, 5, 5, 5, 5, 0, 6, 6])])
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7))
  const signed = Buffer.concat([message, Buffer.from(nacl.sign.detached(message, kp.secretKey))]).toString('base64')
  assert.equal(transaction(signed, true), signed)
  const heap = Buffer.alloc(4); heap.writeUInt32LE(32768)
  const withHeap = Buffer.concat([old.subarray(0, 122), heap, old.subarray(122)])
  withHeap.writeUInt32LE(31, 4)
  assert.equal(transaction(withHeap.toString('base64'), false), withHeap.toString('base64'))
  withHeap.writeUInt32LE(32000, 122)
  assert.throws(() => transaction(withHeap.toString('base64'), false), /heap/)
})

const lpIntent={owner:SOL,venue:'orca',operation:'add',pool:BREAD,mintA:SOL,mintB:BREAD,amountA:'1000000',amountB:'0',slippageBps:50,transactionVersion:'1',parameters:{tickLowerIndex:-100,tickUpperIndex:100}}
const lpQuote={...lpIntent,quoteId:'12345678-1234-1234-1234-123456789abc',expiresAt:Date.now()+60000,amounts:[]}
test('liquidity intent preserves explicit mints, one-sided amounts and strips injected instructions',()=>{
  const validated=validateLiquidityRequest({...lpIntent,instructions:['fake'],feeAccount:BREAD})
  assert.deepEqual(validated,lpIntent)
  assert.throws(()=>validateLiquidityRequest({...lpIntent,amountA:'1.1'}))
  assert.throws(()=>validateLiquidityRequest({...lpIntent,liquidity:'0'}))
  assert.throws(()=>validateLiquidityRequest({...lpIntent,amountA:(1n<<128n).toString()}))
  assert.throws(()=>validateLiquidityRequest({...lpIntent,parameters:{nested:{bad:true}}}))
  assert.deepEqual(validateLiquidityRequest({...lpQuote,instructions:['fake']},true),{owner:SOL,transactionVersion:'1',quoteId:lpQuote.quoteId})
})
test('LP capabilities, positions and quote share bounded upstream transport',async()=>withServer(async(request,calls)=>{
 assert.equal((await request('/api/liquidity/solana/capabilities')).status,200)
 assert.equal((await request(`/api/liquidity/solana/positions?owner=${SOL}&pool=${BREAD}&venue=orca`)).status,200)
 assert.equal((await request('/api/liquidity/solana/quote',{...lpIntent,instructions:['fake']})).status,200)
 assert.equal(calls[2].body.instructions,undefined)
 assert.equal(calls[2].body.amountB,'0')
},url=>Response.json(url.endsWith('/quote')?lpQuote:url.includes('/positions')?{positions:[]}:{venues:[]})))
test('LP builder cannot change requested owner, version or signer declaration',async()=>withServer(async(request)=>{
 const result=await request('/api/liquidity/solana/build',{owner:SOL,transactionVersion:'1',quoteId:lpQuote.quoteId})
 assert.equal(result.status,502)
},()=>Response.json({pool:BREAD,quote:lpQuote,transactions:[{transaction:encodedV1(),transactionVersion:'1',lastValidBlockHeight:123,expectedSigners:[SOL]}]})))
