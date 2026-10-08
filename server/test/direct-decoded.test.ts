import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { DirectSolanaRouter } from '../src/solana/self-router.ts'
import { replayDecodedSwap, tokenAccountAmount } from '../src/solana/direct-decoded.ts'
import { decodeV1 } from '../src/solana/transaction-v1.ts'
import bs58 from 'bs58'

const program = Keypair.generate().publicKey
const landedSigner = Keypair.generate().publicKey
const wallet = Keypair.generate().publicKey
const inputMint = Keypair.generate().publicKey
const outputMint = Keypair.generate().publicKey
const seed = Keypair.generate().publicKey.toBuffer()
const pdaOf = (owner: PublicKey) => PublicKey.findProgramAddressSync([seed, owner.toBuffer()], program)[0]
const inputAta = (owner: PublicKey) => getAssociatedTokenAddressSync(inputMint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
const outputAta = (owner: PublicKey) => getAssociatedTokenAddressSync(outputMint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
const TOKEN = TOKEN_PROGRAM_ID.toBase58()
const tokenAccount = (amount: bigint) => Buffer.concat([Buffer.alloc(64), (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(amount); return b })(), Buffer.alloc(93)]).toString('base64')
const mintAccount = () => Buffer.alloc(82).toString('base64')

/** A landed token swap: the signer spent 1000 for 900 through one unknown
 * program, its accounts named, its amount proven at offset 8. */
function decoded() {
  const data = Buffer.concat([Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(1000n); return b })(), Buffer.alloc(4)])
  const accounts = [
    { address: landedSigner.toBase58(), signer: true, writable: true },
    { address: inputAta(landedSigner).toBase58(), signer: false, writable: true },
    { address: outputAta(landedSigner).toBase58(), signer: false, writable: true },
    { address: pdaOf(landedSigner).toBase58(), signer: false, writable: true },
  ]
  const instruction = { name: 'swap_v2', accounts: [
    { name: 'account_0', signer: true, writable: true },
    { name: 'account_1', writable: true },
    { name: 'account_2', writable: true },
    { name: 'account_3', writable: true, pda: { program: { kind: 'const', value: [...program.toBuffer()] },
      seeds: [{ kind: 'const', value: [...seed] }, { kind: 'account', path: 'account_0' }] } }] }
  return { template: { program: program.toBase58(), signature: 'landed-one', slot: 1, ts: 1,
    data: data.toString('base64'), accounts, signer: landedSigner.toBase58(),
    inputMint: inputMint.toBase58(), outputMint: outputMint.toBase58(),
    amountIn: '1000', amountOut: '900', amountOffset: 8, amountProof: 'exact' as const,
    nativeIn: null, nativeOut: null,
    tokenAccounts: [{ address: inputAta(landedSigner).toBase58(), mint: inputMint.toBase58() },
      { address: outputAta(landedSigner).toBase58(), mint: outputMint.toBase58() }], lookupTables: [] },
    programName: 'Obscure AMM', idlSource: 'composer', instruction }
}

/** The chain state the replay reads: both mints are SPL, the wallet's input
 * account exists with 500 raw, its output account does not. */
function fakeConnection(): Connection {
  const accounts = new Map<string, { owner: string; data: [string, string] } | null>([
    [inputAta(wallet).toBase58(), { owner: TOKEN, data: [tokenAccount(500n), 'base64'] }],
    [outputAta(wallet).toBase58(), null],
  ])
  const fetcher: typeof fetch = async input => {
    const body = JSON.parse(String((input as RequestInit & { init?: RequestInit }).init?.body ?? (input as any).init?.body ?? '{}'))
    void body
    return new Response('{}')
  }
  void fetcher
  const rpc: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    if (body.method === 'getMultipleAccounts')
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 }, value: body.params[0].map(() => ({ owner: TOKEN, data: [mintAccount(), 'base64'], lamports: 1_000_000, executable: false, rentEpoch: 0 })) } })
    if (body.method === 'getAccountInfo') {
      const key = body.params[0] === inputAta(wallet).toBase58() ? inputAta(wallet).toBase58()
        : body.params[0] === outputAta(wallet).toBase58() ? outputAta(wallet).toBase58() : body.params[0]
      const found = accounts.get(key) ?? null
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 }, value: found && { owner: found.owner, data: found.data, lamports: 1_000_000, executable: false, rentEpoch: 0 } } })
    }
    return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `unexpected ${body.method}` } })
  }
  return new Connection('https://rpc.example/', { commitment: 'confirmed', fetch: rpc as any })
}

test('a landed swap replays for another wallet: signer, token accounts and owner-seeded PDAs re-point, the amount patches, absent accounts are created', async () => {
  const replay = await replayDecodedSwap(decoded(), wallet, 250n, fakeConnection())!
  assert.ok(replay, 'the replay builds')
  assert.deepEqual(replay.allowPrograms.map(p => p.toBase58()), [program.toBase58()])
  assert.equal(replay.computeUnitLimit, 1_400_000)
  // The missing output account is created idempotently before the swap.
  assert.equal(replay.instructions.length, 2)
  assert.equal(replay.instructions[0].programId.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58())
  assert.equal(replay.instructions[1].programId.toBase58(), program.toBase58())
  const keys = replay.instructions[1].keys
  assert.deepEqual([keys[0].pubkey.toBase58(), keys[0].isSigner, keys[0].isWritable], [wallet.toBase58(), true, true])
  assert.equal(keys[1].pubkey.toBase58(), inputAta(wallet).toBase58())
  assert.equal(keys[2].pubkey.toBase58(), outputAta(wallet).toBase58())
  assert.equal(keys[3].pubkey.toBase58(), pdaOf(wallet).toBase58(), 'the PDA re-derives for this wallet')
  const data = Buffer.from(replay.instructions[1].data)
  assert.equal(data.readBigUInt64LE(8), 250n, 'the exact-in amount is patched at its proven offset')
  assert.deepEqual(replay.output, { address: outputAta(wallet).toBase58(), preAmount: 0n })
})

test('a recipe that does not reproduce the landing, a bounded amount, or a mis-shaped interface is never replayed', async () => {
  const wrong = decoded()
  wrong.template.accounts[3] = { ...wrong.template.accounts[3], address: Keypair.generate().publicKey.toBase58() }
  assert.equal(await replayDecodedSwap(wrong, wallet, 250n, fakeConnection()), null, 'the PDA no longer reproduces')
  const bounded = decoded()
  bounded.template.amountProof = 'bounded'
  assert.equal(await replayDecodedSwap(bounded, wallet, 250n, fakeConnection()), null, 'only exact amounts are replayed')
  const misShaped = decoded()
  misShaped.instruction.accounts.push({ name: 'account_4' })
  assert.equal(await replayDecodedSwap(misShaped, wallet, 250n, fakeConnection()), null, 'the interface must match the landed accounts')
})

test('the direct router quotes and builds decoded routes only when no pool routes, with the simulated outcome checked against the floor', async () => {
  let simulated = 0
  let simulatedAmount = 895n
  const rpc: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    if (body.method === 'getMultipleAccounts')
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 }, value: body.params[0].map(() => ({ owner: TOKEN, data: [mintAccount(), 'base64'], lamports: 1_000_000, executable: false, rentEpoch: 0 })) } })
    if (body.method === 'getAccountInfo') {
      const input = body.params[0] === inputAta(wallet).toBase58()
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 },
        value: input ? { owner: TOKEN, data: [tokenAccount(500n), 'base64'], lamports: 1_000_000, executable: false, rentEpoch: 0 } : null } })
    }
    if (body.method === 'getLatestBlockhash') return Response.json({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 }, value: { blockhash: bs58.encode(Buffer.alloc(32, 1)), lastValidBlockHeight: 999 } } })
    if (body.method === 'getSlot') return Response.json({ jsonrpc: '2.0', id: body.id, result: 1 })
    if (body.method === 'simulateTransaction') {
      simulated++
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 },
        value: { err: null, accounts: [{ address: outputAta(wallet).toBase58(), data: [tokenAccount(simulatedAmount), 'base64'] }] } } })
    }
    return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `unexpected ${body.method}` } })
  }
  const router = new DirectSolanaRouter('https://rpc.example/', { rpc: { fetch: rpc as any },
    decodedSwapSource: async (_input, _output, limit) => limit < 1 ? [] : [decoded()] })
  const original = globalThis.fetch
  globalThis.fetch = rpc as any
  try {
    const intent = { inputMint: inputMint.toBase58(), outputMint: outputMint.toBase58(),
      amount: '250', slippageBps: 100, transactionVersion: '1' as const }
    const quote = await router.quote(intent)
    assert.equal(quote.quote.decoded, true)
    assert.equal(quote.quote.decodedProgramId, program.toBase58())
    assert.equal(quote.quote.decodedProgramName, 'Obscure AMM')
    assert.equal(quote.quote.routePlan[0].swapInfo!.label, 'Decoded Obscure AMM')
    assert.equal(quote.quote.outAmount, '225', 'the landed ratio at this size')
    assert.equal(quote.quote.otherAmountThreshold, '222', 'the same slippage as shipped venues')
    const built = await router.swap(intent, wallet.toBase58(), '220')
    assert.equal(simulated, 1, 'the outcome was simulated once')
    assert.equal(built.decoded, true)
    assert.equal(built.decodedProgramId, program.toBase58())
    assert.equal(built.quoteResponse.decodedProgramName, 'Obscure AMM')
    assert.equal(built.quoteResponse.otherAmountThreshold, '222', 'the floor the simulation had to cover')
    const message = decodeV1(Buffer.from(built.swapTransaction, 'base64'), { requireResources: true })
    assert.equal(bs58.encode(message.keys[message.ixs[message.ixs.length - 1].prog]), program.toBase58())
    assert.ok(built.swapTransaction)
    // When the simulation cannot cover the floor, nothing is offered to sign:
    // the estimate still clears it, the landing no longer does.
    simulatedAmount = 100n
    const thin = decoded()
    thin.template.amountOut = '880'
    const starved = new DirectSolanaRouter('https://rpc.example/', { rpc: { fetch: rpc as any }, decodedSwapSource: async () => [thin] })
    await assert.rejects(starved.swap(intent, wallet.toBase58(), '220'), /no longer fills|No quoted/)
  } finally { globalThis.fetch = original }
})

test('a token account holds its raw balance at offset 64 for either token program', () => {
  assert.equal(tokenAccountAmount(tokenAccount(123n)), 123n)
  assert.equal(tokenAccountAmount('not base64?!'), null)
  assert.equal(tokenAccountAmount(undefined), null)
})
