import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import bs58 from 'bs58'
import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { buildWrap, createSolanaWrapHandler, validateWrapRequest } from '../src/solana/wrap.ts'
import { decodeV1 } from '../src/solana/transaction-v1.ts'
import { transaction, transactionVersion } from '../src/solana/router.ts'

const OWNER = '53cTDPa69sUXtn4FiuXiKEipJGkUUaNxoisBiuSFkd5i'
const ATA = getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(OWNER), false, TOKEN_PROGRAM_ID).toBase58()
const BLOCKHASH = bs58.encode(Buffer.alloc(32, 9))
const SYSTEM = '11111111111111111111111111111111'
const TOKEN = TOKEN_PROGRAM_ID.toBase58()
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'
const RPC = 'https://rpc.example/?api-key=private-key'

type Scenario = { ata?: boolean; wsol?: string; blockhash?: unknown }
function fakeFetch(scenario: Scenario, calls: { method: string; params: any[] }[] = []): typeof fetch {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    calls.push({ method: body.method, params: body.params })
    const result = body.method === 'getLatestBlockhash' ? (scenario.blockhash ?? { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 4242 } })
      : body.method === 'getAccountInfo' ? { context: { slot: 1 }, value: scenario.ata === false ? null : { owner: TOKEN, lamports: 2039280, data: ['', 'base64'], executable: false, rentEpoch: 0 } }
      : body.method === 'getTokenAccountBalance' ? { context: { slot: 1 }, value: { amount: scenario.wsol ?? '1500000000', decimals: 9 } }
      : null
    return Response.json({ jsonrpc: '2.0', id: 1, result })
  }
}
// Program id + first account per instruction, and the signer set, for either wire version.
function decode(wire: string) {
  const bytes = Buffer.from(wire, 'base64')
  if (bytes[0] === 0x81) {
    const v1 = decodeV1(bytes, { requireResources: true })
    const keys = v1.keys.map(k => bs58.encode(k))
    return { version: '1', signers: keys.slice(0, v1.required), programs: v1.ixs.map(ix => keys[ix.prog]), accounts: v1.ixs.map(ix => ix.accts.map(i => keys[i])), data: v1.ixs.map(ix => Buffer.from(ix.data)), compute: v1.config.computeUnitLimit }
  }
  const tx = VersionedTransaction.deserialize(bytes)
  const keys = tx.message.staticAccountKeys.map(k => k.toBase58())
  return { version: '0', signers: keys.slice(0, tx.message.header.numRequiredSignatures), programs: tx.message.compiledInstructions.map(ix => keys[ix.programIdIndex]),
    accounts: tx.message.compiledInstructions.map(ix => ix.accountKeyIndexes.map(i => keys[i])), data: tx.message.compiledInstructions.map(ix => Buffer.from(ix.data)), compute: null }
}

for (const version of ['1', '0'] as const) {
  test(`wrap V${version} with a missing token account creates it, transfers and syncs`, async () => {
    const calls: { method: string; params: any[] }[] = []
    const built = await buildWrap({ owner: OWNER, direction: 'wrap', lamports: '250000000', transactionVersion: version, rpcUrl: RPC, fetch: fakeFetch({ ata: false }, calls) })
    assert.equal(built.transactionVersion, version)
    assert.equal(transactionVersion(built.transaction), version)
    transaction(built.transaction, false)
    assert.equal(built.lastValidBlockHeight, 4242)
    assert.deepEqual(built.expectedSigners, [OWNER])
    assert.deepEqual(built.summary, { direction: 'wrap', lamports: '250000000', tokenAccount: ATA, createsTokenAccount: true })
    const d = decode(built.transaction)
    assert.deepEqual(d.signers, [OWNER])
    assert.deepEqual(d.programs, version === '0' ? [COMPUTE_BUDGET, ATA_PROGRAM, SYSTEM, TOKEN] : [ATA_PROGRAM, SYSTEM, TOKEN])
    const offset = version === '0' ? 1 : 0
    assert.deepEqual(d.accounts[offset].slice(0, 4), [OWNER, ATA, OWNER, NATIVE_MINT.toBase58()])
    assert.equal(d.data[offset][0], 1, 'create idempotent discriminator')
    assert.deepEqual(d.accounts[offset + 1], [OWNER, ATA])
    assert.equal(d.data[offset + 1].readUInt32LE(0), 2, 'system transfer')
    assert.equal(d.data[offset + 1].readBigUInt64LE(4), 250000000n)
    assert.deepEqual(d.accounts[offset + 2], [ATA])
    assert.deepEqual([...d.data[offset + 2]], [17], 'sync native')
    if (version === '1') assert.equal(d.compute, 100_000)
    assert.deepEqual(calls.map(c => c.method).sort(), ['getAccountInfo', 'getLatestBlockhash'])
    assert.equal(calls.find(c => c.method === 'getAccountInfo')!.params[0], ATA)
  })
  test(`wrap V${version} with an existing token account skips the create`, async () => {
    const built = await buildWrap({ owner: OWNER, direction: 'wrap', lamports: '1', transactionVersion: version, rpcUrl: RPC, fetch: fakeFetch({ ata: true }) })
    const d = decode(built.transaction)
    assert.deepEqual(d.programs, version === '0' ? [COMPUTE_BUDGET, SYSTEM, TOKEN] : [SYSTEM, TOKEN])
    assert.deepEqual(d.signers, [OWNER])
    assert.equal(built.summary.createsTokenAccount, false)
  })
  test(`unwrap V${version} closes the token account and reports the current balance`, async () => {
    const calls: { method: string; params: any[] }[] = []
    const built = await buildWrap({ owner: OWNER, direction: 'unwrap', lamports: '999', transactionVersion: version, rpcUrl: RPC, fetch: fakeFetch({ ata: true, wsol: '777000000' }, calls) })
    assert.equal(transactionVersion(built.transaction), version)
    assert.deepEqual(built.summary, { direction: 'unwrap', lamports: '777000000', tokenAccount: ATA, createsTokenAccount: false })
    const d = decode(built.transaction)
    assert.deepEqual(d.signers, [OWNER])
    assert.deepEqual(d.programs, version === '0' ? [COMPUTE_BUDGET, TOKEN] : [TOKEN])
    const close = version === '0' ? 1 : 0
    assert.deepEqual(d.accounts[close], [ATA, OWNER, OWNER])
    assert.deepEqual([...d.data[close]], [9], 'close account')
    assert.equal(calls.find(c => c.method === 'getTokenAccountBalance')!.params[0], ATA)
  })
}
test('unwrap without a wrapped SOL account is refused before any transaction is built', async () => {
  await assert.rejects(buildWrap({ owner: OWNER, direction: 'unwrap', transactionVersion: '1', rpcUrl: RPC, fetch: fakeFetch({ ata: false }) }), (e: any) => e.status === 409 && /no wrapped SOL/.test(e.message))
})
test('RPC failures never leak the endpoint', async () => {
  const failing: typeof fetch = async () => { throw new Error(`connect ${RPC} refused`) }
  await assert.rejects(buildWrap({ owner: OWNER, direction: 'wrap', lamports: '1', transactionVersion: '1', rpcUrl: RPC, fetch: failing }), (e: any) => e.status === 503 && !e.message.includes('rpc.example') && !e.message.includes('private-key'))
  const bad = fakeFetch({ blockhash: { value: { blockhash: 'nope', lastValidBlockHeight: 1 } } })
  await assert.rejects(buildWrap({ owner: OWNER, direction: 'wrap', lamports: '1', transactionVersion: '0', rpcUrl: RPC, fetch: bad }), (e: any) => e.status === 502 && !e.message.includes('rpc.example'))
})
test('validates wrap requests', () => {
  assert.deepEqual(validateWrapRequest({ owner: OWNER, direction: 'wrap', lamports: '5' }), { owner: OWNER, direction: 'wrap', lamports: '5', transactionVersion: '1' })
  assert.deepEqual(validateWrapRequest({ owner: OWNER, direction: 'unwrap', transactionVersion: '0', lamports: 'ignored' }), { owner: OWNER, direction: 'unwrap', transactionVersion: '0' })
  for (const body of [null, [], { owner: 'bad', direction: 'wrap', lamports: '1' }, { owner: OWNER, direction: 'sideways' }, { owner: OWNER, direction: 'wrap' }, { owner: OWNER, direction: 'wrap', lamports: '0' },
    { owner: OWNER, direction: 'wrap', lamports: 5 }, { owner: OWNER, direction: 'wrap', lamports: '1.5' }, { owner: OWNER, direction: 'wrap', lamports: '18446744073709551616' }, { owner: OWNER, direction: 'wrap', lamports: '1', transactionVersion: 'legacy' }]) {
    assert.throws(() => validateWrapRequest(body), (e: any) => e.status === 400, JSON.stringify(body))
  }
})
async function withServer(options: { rpcUrl?: string; scenario?: Scenario; now?: () => number }, run: (post: (body: unknown, raw?: boolean) => Promise<{ status: number; data: any; headers: Headers }>) => Promise<void>) {
  const handler = createSolanaWrapHandler({ rpcUrl: options.rpcUrl, fetch: fakeFetch(options.scenario ?? {}), now: options.now })
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    if (!await handler(req, res, new URL(req.url ?? '/', 'http://localhost'), body)) res.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const post = async (body: unknown, raw = false) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/wrap/solana`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ? String(body) : JSON.stringify(body) })
    return { status: r.status, data: await r.json(), headers: r.headers }
  }
  try { await run(post) } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
}
test('route builds, validates, reports 503 without RPC and rate limits per IP', async () => {
  await withServer({ rpcUrl: RPC, scenario: { ata: false } }, async post => {
    const ok = await post({ owner: OWNER, direction: 'wrap', lamports: '100000000', transactionVersion: '0' })
    assert.equal(ok.status, 200)
    assert.equal(ok.data.transactionVersion, '0')
    assert.deepEqual(decode(ok.data.transaction).signers, [OWNER])
    assert.equal(ok.data.summary.tokenAccount, ATA)
    assert.equal((await post('{not json', true)).status, 400)
    assert.equal((await post({ owner: OWNER, direction: 'wrap' })).status, 400)
    assert.equal((await post({ owner: OWNER, direction: 'unwrap' })).status, 409)
  })
  await withServer({ rpcUrl: undefined }, async post => {
    const r = await post({ owner: OWNER, direction: 'wrap', lamports: '1' })
    assert.equal(r.status, 503)
    assert.match(r.data.error, /not configured/)
  })
  let time = 0
  await withServer({ rpcUrl: RPC, scenario: { ata: true }, now: () => time }, async post => {
    for (let i = 0; i < 30; i++) assert.equal((await post({ owner: OWNER, direction: 'wrap', lamports: '1' })).status, 200)
    const limited = await post({ owner: OWNER, direction: 'wrap', lamports: '1' })
    assert.equal(limited.status, 429)
    assert.equal(limited.headers.get('retry-after'), '60')
    time += 60_001
    assert.equal((await post({ owner: OWNER, direction: 'wrap', lamports: '1' })).status, 200)
  })
})
