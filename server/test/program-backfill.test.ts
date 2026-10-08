import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import bs58 from 'bs58'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ftl-program-backfill-'))
process.env.DATA_DIR = directory
process.env.HOLDER_PROGRAM_RPC_DAILY_LIMIT = '2'
const { db, getCursor } = await import('../src/db.ts')
const { startHolders, holderStatus, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } = await import('../src/solana/holders.ts')
const { FIXED_LAUNCH_PROGRAMS, stepProgramBackfill, programBackfillStatus } = await import('../src/solana/program-backfill.ts')
after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); delete process.env.HOLDER_PROGRAM_RPC_DAILY_LIMIT })

const mint = (byte: number) => bs58.encode(Buffer.alloc(32, byte))
function rawMint(types: number[] = []): [string, string] {
  const bytes = Buffer.alloc(types.length ? 166 + types.length * 5 : 82)
  bytes[45] = 1
  if (types.length) {
    bytes[165] = 1
    for (let i = 0; i < types.length; i++) {
      bytes.writeUInt16LE(types[i], 166 + i * 5)
      bytes.writeUInt16LE(1, 168 + i * 5)
      bytes[170 + i * 5] = 1
    }
  }
  return [bytes.toString('base64'), 'base64']
}
function event(token: string, venue: string, ix: string, stage = 'confirmed') {
  db.prepare(`INSERT INTO events(id,chain,kind,stage,lane,venue,ix,token,wallet,amounts,tx,slot,ts,flags)
    VALUES(?, 'solana','launch',?,'geyser-primary',?,?,?,?,'{}',?,1,1,'[]')`)
    .run(`launch-${token}`, stage, venue, ix, token, mint(99), mint(98))
}

test('only fixed token-program accounts in venue IDLs are inferred from confirmed launches', () => {
  const cases = [
    ['pump.json', 'create', 'token_program', TOKEN_PROGRAM],
    ['pump.json', 'create_v2', 'token_program', TOKEN_2022_PROGRAM],
    ['meteora_dbc.json', 'initialize_virtual_pool_with_spl_token', 'token_program', TOKEN_PROGRAM],
    ['meteora_dbc.json', 'initialize_virtual_pool_with_token2022', 'token_program', TOKEN_2022_PROGRAM],
    ['meteora_dbc.json', 'initialize_virtual_pool_with_token2022_transfer_hook', 'token_program', TOKEN_2022_PROGRAM],
    ['raydium_launchpad.json', 'initialize_with_token_2022', 'base_token_program', TOKEN_2022_PROGRAM],
  ] as const
  for (const [file, ix, role, program] of cases) {
    const idl = JSON.parse(fs.readFileSync(new URL(`../idl/${file}`, import.meta.url), 'utf8'))
    assert.equal(idl.instructions.find((entry: { name: string }) => entry.name === ix)
      ?.accounts.find((account: { name: string }) => account.name === role)?.address, program)
  }
  assert.equal(FIXED_LAUNCH_PROGRAMS['raydium-launchlab:initialize_v2'], undefined)
})

test('historical launch evidence precedes one raw mint read for residual and Token-2022 mints', async () => {
  const pump = mint(61), meteora = mint(62), raydium = mint(63)
  const ambiguous = mint(64), noEvent = mint(65), missing = mint(66), unconfirmed = mint(67)
  for (const address of [pump, meteora, raydium, ambiguous, noEvent, missing, unconfirmed])
    db.prepare("INSERT INTO research_tokens(chain,address,first_seen_ts) VALUES('solana',?,1)").run(address)
  event(pump, 'pumpfun', 'create_v2')
  event(meteora, 'meteora-dbc', 'initialize_virtual_pool_with_spl_token')
  event(raydium, 'raydium-launchlab', 'initialize_with_token_2022')
  event(ambiguous, 'raydium-launchlab', 'initialize_v2')
  event(unconfirmed, 'pumpfun', 'create', 'seen')
  const stop = startHolders()
  try {
    const first = await stepProgramBackfill()
    assert.equal(first.phase, 'events')
    assert.equal(first.mapped, 3)
    assert.equal(holderStatus(pump)?.programSource, 'confirmed-launch:pumpfun:create_v2')
    assert.equal(holderStatus(pump)?.state, 'pending')
    assert.equal(holderStatus(meteora)?.programId, TOKEN_PROGRAM)
    assert.equal(holderStatus(raydium)?.programId, TOKEN_2022_PROGRAM)
    assert.equal(holderStatus(ambiguous)?.programId, null)
    assert.equal(holderStatus(unconfirmed)?.programId, null)

    let calls = 0
    const fetcher = async (_url: unknown, request: RequestInit) => {
      calls++
      const body = JSON.parse(request.body as string)
      assert.equal(body.method, 'getMultipleAccounts')
      assert.equal(body.params[1].commitment, 'finalized')
      assert.deepEqual(new Set(body.params[0]), new Set([pump, raydium, ambiguous, noEvent, missing, unconfirmed]))
      const accounts: Record<string, unknown> = {
        [ambiguous]: { owner: TOKEN_PROGRAM, data: rawMint() },
        [noEvent]: { owner: TOKEN_2022_PROGRAM, data: rawMint() },
        [unconfirmed]: { owner: TOKEN_PROGRAM, data: rawMint() },
        [pump]: { owner: TOKEN_2022_PROGRAM, data: rawMint([18]) },
        [raydium]: { owner: TOKEN_2022_PROGRAM, data: rawMint([4]) },
      }
      return new Response(JSON.stringify({ result: { context: { slot: 100 },
        value: body.params[0].map((id: string) => accounts[id] ?? null),
      } }), { status: 200 })
    }
    const second = await stepProgramBackfill({ rpcUrl: 'https://example.invalid', fetcher: fetcher as typeof fetch })
    assert.equal(second.phase, 'rpc')
    assert.equal(second.attempts, 6)
    assert.equal(second.mapped, 5)
    assert.equal(calls, 1)
    assert.equal(holderStatus(ambiguous)?.programSource, 'raw-mint-account:100')
    assert.equal(holderStatus(noEvent)?.state, 'pending')
    assert.equal(holderStatus(noEvent)?.extensionVerdict, 'transparent')
    assert.equal(holderStatus(pump)?.extensionVerdict, 'transparent')
    assert.equal(holderStatus(raydium)?.extensionVerdict, 'confidential')
    assert.equal(holderStatus(missing)?.programId, null)
    assert.equal((await stepProgramBackfill({ rpcUrl: 'https://example.invalid', fetcher: fetcher as typeof fetch })).phase, 'done')
    assert.equal(calls, 1)
    const status = programBackfillStatus()
    assert.equal(status.eventScanDone, true)
    assert.equal(status.rpcCalls, 1)
    assert.equal(status.rpcAttempts, 6)
    assert.equal(status.extensionTransparentMints, 2)
    assert.equal(status.extensionConfidentialMints, 1)
    assert.equal(status.estimatedRpcCredits, 1)
    assert.equal(status.responseBytes > 0, true)
    assert.equal(Number(getCursor(`meta:rpc:${new Date().toISOString().slice(0, 10)}`)), 1)

    const transientMint = mint(68)
    db.prepare("INSERT INTO research_tokens(chain,address,first_seen_ts) VALUES('solana',?,2)").run(transientMint)
    db.prepare('INSERT INTO research_holder_state(mint,first_seen_ts) VALUES(?,2)').run(transientMint)
    process.env.HOLDER_PROGRAM_RPC_DAILY_LIMIT = '0'
    const failed = await stepProgramBackfill({ rpcUrl: 'https://example.invalid',
      fetcher: (async () => new Response('', { status: 503 })) as typeof fetch })
    assert.equal(failed.phase, 'rpc')
    assert.match(failed.reason ?? '', /503/)
    assert.equal(programBackfillStatus().retryMints, 1)
    assert.equal((await stepProgramBackfill({ rpcUrl: 'https://example.invalid', fetcher: fetcher as typeof fetch })).phase, 'paused')
    db.prepare('UPDATE research_holder_program_backfill_attempts SET next_retry_at=0 WHERE mint=?').run(transientMint)
    let retried = 0
    const recovered = await stepProgramBackfill({ rpcUrl: 'https://example.invalid', fetcher: (async () => {
      retried++
      return new Response(JSON.stringify({ result: { context: { slot: 101 },
        value: [{ owner: TOKEN_PROGRAM, data: rawMint() }] } }), { status: 200 })
    }) as typeof fetch })
    assert.equal(recovered.mapped, 1)
    assert.equal(retried, 1)
    assert.equal(programBackfillStatus().retryMints, 0)
    assert.equal(holderStatus(transientMint)?.programSource, 'raw-mint-account:101')

    const partialMint = mint(69)
    db.prepare("INSERT INTO research_tokens(chain,address,first_seen_ts) VALUES('solana',?,3)").run(partialMint)
    db.prepare('INSERT INTO research_holder_state(mint,first_seen_ts) VALUES(?,3)').run(partialMint)
    const partial = await stepProgramBackfill({ rpcUrl: 'https://example.invalid', fetcher: (async () =>
      new Response(JSON.stringify({ result: { context: { slot: 102 },
        value: [{ error: 'temporary provider error' }] } }),
        { status: 200 })) as typeof fetch })
    assert.equal(partial.phase, 'rpc')
    assert.equal(programBackfillStatus().retryMints, 1)
    assert.equal(holderStatus(partialMint)?.programId, null)
    db.prepare('UPDATE research_holder_program_backfill_attempts SET next_retry_at=0 WHERE mint=?').run(partialMint)
    const recoveredPartial = await stepProgramBackfill({ rpcUrl: 'https://example.invalid', fetcher: (async () =>
      new Response(JSON.stringify({ result: { context: { slot: 103 },
        value: [{ owner: TOKEN_PROGRAM, data: rawMint() }] } }), { status: 200 })) as typeof fetch })
    assert.equal(recoveredPartial.mapped, 1)
    assert.equal(programBackfillStatus().retryMints, 0)

    const malformedMint = mint(70)
    db.prepare("INSERT INTO research_tokens(chain,address,first_seen_ts) VALUES('solana',?,4)").run(malformedMint)
    db.prepare('INSERT INTO research_holder_state(mint,first_seen_ts) VALUES(?,4)').run(malformedMint)
    const malformed = await stepProgramBackfill({ rpcUrl: 'https://example.invalid', fetcher: (async () =>
      new Response(JSON.stringify({ result: { context: { slot: 104 }, value: [] } }),
        { status: 200 })) as typeof fetch })
    assert.equal(malformed.phase, 'rpc')
    assert.equal(programBackfillStatus().blockedMints, 1)
    let repeated = 0
    assert.equal((await stepProgramBackfill({ rpcUrl: 'https://example.invalid', fetcher: (async () => {
      repeated++
      throw Error('unexpected second read')
    }) as typeof fetch })).phase, 'done')
    assert.equal(repeated, 0)
  } finally { stop() }
})
