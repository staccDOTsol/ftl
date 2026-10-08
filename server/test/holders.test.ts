import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import bs58 from 'bs58'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ftl-holders-test-'))
process.env.DATA_DIR = directory
const { db } = await import('../src/db.ts')
const { TOKEN_PROGRAM, TOKEN_2022_PROGRAM, startHolders, recordKnownTokenProgram, onHolderStreamEvent,
  onHolderStreamBatch, recordToken2022RawEvidence, attemptHolderBootstrap, onHolderTransaction, onHolderMetadataGap,
  holderStatus } = await import('../src/solana/holders.ts')
const stop = startHolders()
after(() => { stop(); db.close(); fs.rmSync(directory, { recursive: true, force: true }) })

function key(byte: number): string { return bs58.encode(Buffer.alloc(32, byte)) }
function accountData(mint: string, owner: string, amount: bigint): [string, string] {
  const data = Buffer.alloc(109)
  Buffer.from(bs58.decode(mint)).copy(data, 0)
  Buffer.from(bs58.decode(owner)).copy(data, 32)
  data.writeBigUInt64LE(amount, 64)
  data[108] = 1
  return [data.toString('base64'), 'base64']
}
function rawMint(types: number[] = []): Buffer {
  const data = Buffer.alloc(types.length ? 166 + 5 * types.length : 82)
  data[45] = 1
  if (types.length) {
    data[165] = 1
    for (let i = 0; i < types.length; i++) {
      data.writeUInt16LE(types[i], 166 + 5 * i)
      data.writeUInt16LE(1, 168 + 5 * i)
      data[170 + 5 * i] = 1
    }
  }
  return data
}
function enroll(mint: string) {
  db.prepare("INSERT INTO research_tokens(chain,address,first_seen_ts) VALUES('solana',?,?)").run(mint, Date.now())
  assert.equal(recordKnownTokenProgram(mint, TOKEN_PROGRAM), true)
  onHolderStreamEvent({ t: 'open', lane: 'laserstream', token: mint, ts: Date.now() })
}

test('bulk filter acknowledgement opens each pending mint without a holder read', () => {
  const mints = [key(200), key(201)]
  for (const mint of mints) {
    db.prepare("INSERT INTO research_tokens(chain,address,first_seen_ts) VALUES('solana',?,?)")
      .run(mint, Date.now())
    assert.equal(recordKnownTokenProgram(mint, TOKEN_PROGRAM), true)
  }
  onHolderStreamBatch(mints.map(token => ({ t: 'open', lane: 'laserstream', token, ts: Date.now() })))
  for (const mint of mints) {
    const row = db.prepare('SELECT state,stream_ok,attempted_at FROM research_holder_state WHERE mint=?')
      .get(mint) as { state: string; stream_ok: number; attempted_at: number | null }
    assert.deepEqual({ ...row }, { state: 'pending', stream_ok: 1, attempted_at: null })
  }
})

test('one complete read plus finalized absolute balances yields real owner retention', async () => {
  const mint = key(8), first = key(9), second = key(10), third = key(11)
  const ownerA = key(12), ownerB = key(13), ownerC = key(14)
  enroll(mint)
  let calls = 0
  const result = { jsonrpc: '2.0', id: 1, result: { context: { slot: 100 }, value: [
      { pubkey: first, account: { owner: TOKEN_PROGRAM, data: accountData(mint, ownerA, 1000n) } },
      { pubkey: second, account: { owner: TOKEN_PROGRAM, data: accountData(mint, ownerB, 1000n) } },
    ] } }
  const fetcher = async (_url: unknown, request: RequestInit) => {
    calls++
    const body = JSON.parse(request.body as string)
    assert.equal(body.method, 'getProgramAccounts')
    assert.equal(body.params[1].limit, undefined)
    assert.equal(body.params[1].withContext, true)
    assert.equal(body.params[1].commitment, 'finalized')
    assert.deepEqual(body.params[1].dataSlice, { offset: 0, length: 109 })
    assert.deepEqual(body.params[1].filters, [{ memcmp: { offset: 0, bytes: mint } }])
    return new Response(JSON.stringify(result), { status: 200 })
  }
  let status = await attemptHolderBootstrap(mint, { rpcUrl: 'https://example.invalid', fetcher: fetcher as typeof fetch })
  assert.equal(calls, 1)
  assert.equal(status?.state, 'live')
  assert.equal(status?.ownerCount, 2)
  assert.equal(status?.baselineTop20SharePct, 100)
  assert.equal(status?.baselineRetentionPct, 100)
  assert.equal(status?.bootstrapPageAccounts, 2)
  assert.equal((status?.bootstrapResponseBytes ?? 0) > 0, true)
  assert.equal((status?.bootstrapDbGrowthBytes ?? -1) >= 0, true)
  assert.deepEqual({ ...db.prepare(`SELECT pagination_key_present,has_next_page,total_results
    FROM research_holder_bootstrap_usage WHERE mint=?`).get(mint) },
    { pagination_key_present: 0, has_next_page: 0, total_results: 2 })
  assert.equal(status?.source, 'helius-getProgramAccounts+laserstream')

  const update = { slot: 101, transaction: { index: 1,
    transaction: { message: { accountKeys: [Buffer.from(bs58.decode(first)), Buffer.from(bs58.decode(third))] } },
    meta: { err: null, loadedWritableAddresses: [], loadedReadonlyAddresses: [],
      preTokenBalances: [{ accountIndex: 0, mint, owner: ownerA, programId: TOKEN_PROGRAM, uiTokenAmount: { amount: '1000' } }],
      postTokenBalances: [
        { accountIndex: 0, mint, owner: ownerA, programId: TOKEN_PROGRAM, uiTokenAmount: { amount: '500' } },
        { accountIndex: 1, mint, owner: ownerC, programId: TOKEN_PROGRAM, uiTokenAmount: { amount: '500' } },
      ],
    },
  } }
  onHolderTransaction(update)
  onHolderTransaction(update) // inclusive replay duplicate must not regress balances
  status = holderStatus(mint)
  assert.equal(status?.state, 'live')
  assert.equal(status?.baselineRetentionPct, 75)
  assert.equal(status?.ownerCount, 3)
  assert.equal(status?.lastSlot, 101)

  onHolderStreamEvent({ t: 'pulse', lane: 'laserstream', ts: Date.now(), coveredThroughSlot: 101 })
  assert.equal(holderStatus(mint)?.coveredThroughSlot, 101)
  onHolderStreamEvent({ t: 'close', lane: 'laserstream', token: mint, ts: Date.now() })
  assert.equal(holderStatus(mint)?.state, 'stale')
  onHolderStreamEvent({ t: 'resume', lane: 'laserstream', token: mint, ts: Date.now(), fromSlot: 101 })
  assert.equal(holderStatus(mint)?.state, 'live')
  onHolderStreamEvent({ t: 'close', lane: 'laserstream', token: mint, ts: Date.now() })
  onHolderStreamEvent({ t: 'gap', lane: 'laserstream', ts: Date.now(), reason: 'unreplayed slot' })
  assert.equal(holderStatus(mint)?.state, 'unavailable')
  assert.equal(holderStatus(mint)?.top20SharePct, null)
  await attemptHolderBootstrap(mint, { rpcUrl: 'https://example.invalid', fetcher: fetcher as typeof fetch })
  assert.equal(calls, 1)
})

test('a paginated response shape cannot be mistaken for a complete account set', async () => {
  const mint = key(21)
  enroll(mint)
  let calls = 0
  const fetcher = async () => {
    calls++
    return new Response(JSON.stringify({ result: { context: { slot: 200 }, value: {
      accounts: [], paginationKey: key(22), totalResults: 12_000,
    } } }), { status: 200 })
  }
  const result = await attemptHolderBootstrap(mint, { rpcUrl: 'https://example.invalid', fetcher: fetcher as typeof fetch })
  assert.equal(calls, 1)
  assert.equal(result?.state, 'unavailable')
  assert.match(result?.reason ?? '', /omitted finalized context or accounts/)
  assert.equal(result?.bootstrapAttemptedAt !== null, true)
  assert.equal(result?.bootstrapPageAccounts, 0)
  assert.equal((result?.bootstrapResponseBytes ?? 0) > 0, true)
  assert.deepEqual({ ...db.prepare(`SELECT pagination_key_present,has_next_page,total_results
    FROM research_holder_bootstrap_usage WHERE mint=?`).get(mint) },
    { pagination_key_present: 0, has_next_page: 0, total_results: 0 })
})

test('an empty complete account array is valid without a second read', async () => {
  const mint = key(23)
  enroll(mint)
  let calls = 0
  const fetcher = async () => {
    calls++
    return new Response(JSON.stringify({ result: { context: { slot: 201 }, value: [] } }), { status: 200 })
  }
  const result = await attemptHolderBootstrap(mint, { rpcUrl: 'https://example.invalid', fetcher: fetcher as typeof fetch })
  assert.equal(calls, 1)
  assert.equal(result?.state, 'live')
  assert.equal(result?.bootstrapPageAccounts, 0)
  assert.deepEqual({ ...db.prepare(`SELECT pagination_key_present,has_next_page,total_results
    FROM research_holder_bootstrap_usage WHERE mint=?`).get(mint) },
    { pagination_key_present: 0, has_next_page: 0, total_results: 0 })
})

test('a response without finalized context fails closed after one read', async () => {
  const mint = key(24)
  enroll(mint)
  let calls = 0
  const fetcher = async () => {
    calls++
    return new Response(JSON.stringify({ result: [] }), { status: 200 })
  }
  const result = await attemptHolderBootstrap(mint, { rpcUrl: 'https://example.invalid', fetcher: fetcher as typeof fetch })
  assert.equal(calls, 1)
  assert.equal(result?.state, 'unavailable')
  assert.match(result?.reason ?? '', /omitted finalized context or accounts/)
})

test('unknown token program remains pending without a bootstrap request', async () => {
  const mint = key(31)
  db.prepare("INSERT INTO research_tokens(chain,address,first_seen_ts) VALUES('solana',?,?)").run(mint, Date.now())
  onHolderStreamEvent({ t: 'open', lane: 'laserstream', token: mint, ts: Date.now() })
  let calls = 0
  const result = await attemptHolderBootstrap(mint, { rpcUrl: 'https://example.invalid', fetcher: (async () => { calls++; throw Error('unexpected') }) as typeof fetch })
  assert.equal(calls, 0)
  assert.equal(result?.state, 'pending')
  assert.equal(result?.programId, null)
})

test('pending finalized balances learn program once without per-transaction holder writes', () => {
  const mint = key(52), owner = key(53)
  db.prepare("INSERT INTO research_tokens(chain,address,first_seen_ts) VALUES('solana',?,?)").run(mint, Date.now())
  onHolderStreamEvent({ t: 'open', lane: 'laserstream', token: mint, ts: Date.now() })
  const balance = { accountIndex: 0, mint, owner, programId: TOKEN_PROGRAM, uiTokenAmount: { amount: '1' } }
  const update = { slot: 500, transaction: { index: 0,
    transaction: { message: { accountKeys: [Buffer.from(bs58.decode(key(54)))] } },
    meta: { err: null, preTokenBalances: [balance], postTokenBalances: [balance] },
  } }
  onHolderTransaction(update)
  assert.equal(holderStatus(mint)?.programId, TOKEN_PROGRAM)
  assert.equal(holderStatus(mint)?.programSource, 'finalized-token-balance')
  const before = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
  for (let i = 0; i < 100; i++) onHolderTransaction(update)

  const after = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
  assert.equal(after, before)
  assert.equal(holderStatus(mint)?.accountCount, 0)
  assert.equal(holderStatus(mint)?.state, 'pending')
})

test('Token-2022 needs one complete raw mint extension verdict before its one holder read', async () => {
  const mint = key(32), account = key(55), owner = key(56)
  db.prepare("INSERT INTO research_tokens(chain,address,first_seen_ts) VALUES('solana',?,?)").run(mint, Date.now())
  assert.equal(recordKnownTokenProgram(mint, TOKEN_2022_PROGRAM), true)
  onHolderStreamEvent({ t: 'open', lane: 'laserstream', token: mint, ts: Date.now() })
  let calls = 0
  const fetcher = async () => {
    calls++
    return new Response(JSON.stringify({ result: { context: { slot: 600 }, value: [
      { pubkey: account, account: { owner: TOKEN_2022_PROGRAM,
        data: accountData(mint, owner, 42n) } },
    ] } }), { status: 200 })
  }
  const result = await attemptHolderBootstrap(mint, { rpcUrl: 'https://example.invalid', fetcher: fetcher as typeof fetch })
  assert.equal(calls, 0)
  assert.equal(result?.state, 'pending')
  assert.match(result?.reason ?? '', /one-time raw Token-2022 mint-extension/)
  assert.equal(recordToken2022RawEvidence(mint, rawMint([18])), 'transparent')
  assert.equal(holderStatus(mint)?.extensionVerdict, 'transparent')
  assert.equal((await attemptHolderBootstrap(mint, { rpcUrl: 'https://example.invalid', fetcher: fetcher as typeof fetch }))?.state, 'live')
  assert.equal(calls, 1)
  assert.equal(recordToken2022RawEvidence(mint, rawMint([4])), 'transparent')
  assert.equal(holderStatus(mint)?.extensionVerdict, 'transparent') // persisted first verdict is immutable
})

test('confidential or omitted Token-2022 extension evidence cannot yield holder scores', async () => {
  const confidential = [key(57), key(59), key(60)], inconclusive = key(58)
  for (const mint of [...confidential, inconclusive]) {
    db.prepare("INSERT INTO research_tokens(chain,address,first_seen_ts) VALUES('solana',?,?)").run(mint, Date.now())
    recordKnownTokenProgram(mint, TOKEN_2022_PROGRAM)
    onHolderStreamEvent({ t: 'open', lane: 'laserstream', token: mint, ts: Date.now() })
  }
  for (const [i, type] of [4, 16, 24].entries())
    assert.equal(recordToken2022RawEvidence(confidential[i], rawMint([type])), 'confidential')
  assert.equal(recordToken2022RawEvidence(inconclusive, rawMint([60_000])), 'inconclusive')
  let calls = 0
  const fetcher = async () => { calls++; throw Error('unexpected') }
  for (const mint of [...confidential, inconclusive]) {
    const status = await attemptHolderBootstrap(mint, { rpcUrl: 'https://example.invalid', fetcher: fetcher as typeof fetch })
    assert.equal(status?.state, 'pending')
    assert.equal(status?.baselineRetentionPct, null)
  }
  assert.equal(calls, 0)
  assert.match(holderStatus(confidential[0])?.reason ?? '', /confidential balances/)
  assert.match(holderStatus(inconclusive)?.reason ?? '', /unknown extension/)
})

test('resume without a verified covered-through slot cannot revive a persisted baseline', async () => {
  const mint = key(33), account = key(34), owner = key(35)
  enroll(mint)
  const fetcher = async () => new Response(JSON.stringify({ result: { context: { slot: 300 }, value: [
    { pubkey: account, account: { owner: TOKEN_PROGRAM, data: accountData(mint, owner, 1n) } },
  ] } }), { status: 200 })
  assert.equal((await attemptHolderBootstrap(mint, { rpcUrl: 'https://example.invalid', fetcher: fetcher as typeof fetch }))?.state, 'live')
  onHolderStreamEvent({ t: 'close', lane: 'laserstream', token: mint, ts: Date.now() })
  onHolderStreamEvent({ t: 'resume', lane: 'laserstream', token: mint, ts: Date.now(), fromSlot: 0 })
  assert.equal(holderStatus(mint)?.state, 'unavailable')
  assert.equal(holderStatus(mint)?.baselineRetentionPct, null)
})

test('a fresh open after an existing baseline is an unreplayed gap, even after later pulses', async () => {
  const mint = key(42), account = key(43), owner = key(44)
  enroll(mint)
  const fetcher = async () => new Response(JSON.stringify({ result: { context: { slot: 500 }, value: [
    { pubkey: account, account: { owner: TOKEN_PROGRAM, data: accountData(mint, owner, 1n) } },
  ] } }), { status: 200 })
  assert.equal((await attemptHolderBootstrap(mint, { rpcUrl: 'https://example.invalid', fetcher: fetcher as typeof fetch }))?.state, 'live')
  onHolderStreamEvent({ t: 'pulse', lane: 'laserstream', ts: Date.now(), coveredThroughSlot: 501 })
  onHolderStreamEvent({ t: 'close', lane: 'laserstream', token: mint, ts: Date.now() })
  onHolderStreamEvent({ t: 'open', lane: 'laserstream', token: mint, ts: Date.now() })
  onHolderStreamEvent({ t: 'pulse', lane: 'laserstream', ts: Date.now(), coveredThroughSlot: 600 })
  onHolderStreamEvent({ t: 'close', lane: 'laserstream', token: mint, ts: Date.now() })
  onHolderStreamEvent({ t: 'resume', lane: 'laserstream', token: mint, ts: Date.now(), fromSlot: 500 })
  assert.equal(holderStatus(mint)?.state, 'unavailable')
  assert.match(holderStatus(mint)?.reason ?? '', /without replaying/)
})

test('an unaccountable finalized transaction invalidates a complete baseline', async () => {
  const mint = key(36), account = key(37), owner = key(38)
  enroll(mint)
  const fetcher = async () => new Response(JSON.stringify({ result: { context: { slot: 400 }, value: [
    { pubkey: account, account: { owner: TOKEN_PROGRAM, data: accountData(mint, owner, 1n) } },
  ] } }), { status: 200 })
  assert.equal((await attemptHolderBootstrap(mint, { rpcUrl: 'https://example.invalid', fetcher: fetcher as typeof fetch }))?.state, 'live')
  onHolderMetadataGap()
  assert.equal(holderStatus(mint)?.state, 'unavailable')
  assert.equal(holderStatus(mint)?.top20SharePct, null)
})

test('a global gap clears pending mint coverage before its one read', async () => {
  const mint = key(39)
  enroll(mint)
  onHolderStreamEvent({ t: 'gap', lane: 'laserstream', ts: Date.now(), reason: 'replay failed' })
  let calls = 0
  const result = await attemptHolderBootstrap(mint, { rpcUrl: 'https://example.invalid', fetcher: (async () => { calls++; throw Error('unexpected') }) as typeof fetch })
  assert.equal(calls, 0)
  assert.equal(result?.state, 'pending')
  assert.match(result?.reason ?? '', /waiting for verified/i)
})

test('one-mint operator probe cannot spend a read on another enrolled mint', async () => {
  const probeMint = key(40), otherMint = key(41)
  enroll(probeMint)
  enroll(otherMint)
  process.env.HOLDER_BOOTSTRAP_PROBE_MINT = probeMint
  try {
    let calls = 0
    const fetcher = async () => { calls++; throw Error('unexpected') }
    const other = await attemptHolderBootstrap(otherMint, {
      rpcUrl: 'https://example.invalid', fetcher: fetcher as typeof fetch,
    })
    assert.equal(calls, 0)
    assert.equal(other?.state, 'pending')
    process.env.HOLDER_BOOTSTRAP = '1'
    process.env.SOLANA_DAS_URL = 'https://example.invalid'
    assert.match(holderStatus(otherMint)?.reason ?? '', /one-mint holder bootstrap probe/i)
    assert.equal(holderStatus(otherMint)?.bootstrapAttemptedAt, null)
  } finally {
    delete process.env.HOLDER_BOOTSTRAP_PROBE_MINT
    delete process.env.HOLDER_BOOTSTRAP
    delete process.env.SOLANA_DAS_URL
  }
})
