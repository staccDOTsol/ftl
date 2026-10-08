import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ftl-compose-'))
process.env.DATA_DIR = tmp
const { db } = await import('../src/db.ts')
const compose = await import('../src/solana/compose.ts')
const { DirectSolanaRouter } = await import('../src/solana/self-router.ts')
const { cpmmSwapInstruction, RAYDIUM_CPMM_PROGRAM } = await import('../src/solana/direct-raydium-cpmm.ts')
const { mintAta, venueLeg } = await import('../src/solana/direct-adapter.ts')
const { decodeV1 } = await import('../src/solana/transaction-v1.ts')
const { createSolanaRouterHandler } = await import('../src/solana/router.ts')
after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

const { encodeCompose, decodeCompose, composeInstructions, composeRoute, buildComposedTransaction,
  feeAta, hopEstimates, finalHopMinimum, FEE_RECIPIENT } = compose
const key = (seed: number) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey
const COMPOSER = new PublicKey('BHYw1FAWPriW9Gh7BG49X4UVe96CDjaxFrFFUtGSQmRx')
const SOL = 'So11111111111111111111111111111111111111112'
const wallet = key(1), A = key(2), X = key(3), B = key(4)
const hash = new PublicKey('11111111111111111111111111111111').toBase58()

// ---- encoder ---------------------------------------------------------------

type FixtureJson = { name: string; hex: string; description: any }
const fixtureFile = JSON.parse(fs.readFileSync(new URL('./fixtures/compose-fixtures.json', import.meta.url), 'utf8')) as
  { fixtures: FixtureJson[] }
const fromJson = (d: any): import('../src/solana/compose.ts').ComposeDescription => ({ watch: d.watch,
  steps: d.steps.map((s: any) => ({ ...s, data: Buffer.from(s.data, 'hex'),
    patches: s.patches.map((p: any) => ({ ...p, sub: BigInt(p.sub) })) })),
  checks: d.checks.map((c: any) => ({ ...c, bound: BigInt(c.bound) })) })

test('compose encoder reproduces the shared fixtures byte for byte and decodes them back', () => {
  assert.ok(fixtureFile.fixtures.length >= 2)
  for (const f of fixtureFile.fixtures) {
    const desc = fromJson(f.description)
    assert.equal(encodeCompose(desc).toString('hex'), f.hex, f.name)
    assert.deepEqual(decodeCompose(Buffer.from(f.hex, 'hex')), desc, f.name)
  }
})

const layoutRs = '/Users/stacc/lp-zap/src/layout.rs'
test('the layout-rs fixture matches lp-zap/src/layout.rs FIXTURE', { skip: !fs.existsSync(layoutRs) && 'lp-zap source not present' }, () => {
  const source = fs.readFileSync(layoutRs, 'utf8')
  const body = /pub const FIXTURE: &\[u8\] = &\[([\s\S]*?)\];/.exec(source)?.[1]
  assert.ok(body, 'FIXTURE constant not found')
  const bytes = [...body.replace(/\/\/[^\n]*/g, '').matchAll(/0x([0-9a-fA-F]{2})/g)].map(m => parseInt(m[1], 16))
  assert.equal(Buffer.from(bytes).toString('hex'), fixtureFile.fixtures.find(f => f.name === 'layout-rs')!.hex)
})

test('compose encoder enforces the program structural limits', () => {
  const base = fromJson(fixtureFile.fixtures[0].description)
  const withPatch = (patch: object) => ({ ...base, steps: [base.steps[0], { ...base.steps[1],
    patches: [{ ...base.steps[1].patches[0], ...patch }] }] })
  assert.throws(() => encodeCompose(withPatch({ fromStep: 1 })), /source step/)
  assert.throws(() => encodeCompose(withPatch({ dataOffset: 2 })), /outside the step data/)
  assert.throws(() => encodeCompose(withPatch({ den: 0 })), /denominator/)
  assert.throws(() => encodeCompose(withPatch({ watchSlot: 2 })), /out of range/)
  assert.throws(() => encodeCompose({ ...base, checks: [{ watchSlot: 0, kind: 0, bound: 1n << 63n }] }), /i64/)
  assert.throws(() => encodeCompose({ ...base, steps: Array(9).fill(base.steps[0]) }), /Too many composed steps/)
  assert.throws(() => encodeCompose({ ...base, watch: [0, 1, 2, 3, 4, 5, 6, 7, 8] }), /Too many watched/)
  assert.throws(() => decodeCompose(Buffer.concat([Buffer.from(fixtureFile.fixtures[0].hex, 'hex'), Buffer.of(0)])), /Trailing/)
})

// ---- fees ------------------------------------------------------------------

test('fee ATA derives the recipient ATA for Token and Token-2022 and refuses other programs', () => {
  const mint = key(9)
  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const [expected] = PublicKey.findProgramAddressSync([FEE_RECIPIENT.toBuffer(), program.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID)
    assert.ok(feeAta(mint, program).equals(expected))
  }
  assert.ok(!feeAta(mint, TOKEN_PROGRAM_ID).equals(feeAta(mint, TOKEN_2022_PROGRAM_ID)))
  assert.throws(() => feeAta(mint, key(10)), /Token and Token-2022/)
  assert.equal(FEE_RECIPIENT.toBase58(), '331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth')
})

test('hop estimates take the 10 bps fee by floor and the final floor is ceil(min*1000/999)', () => {
  assert.deepEqual(hopEstimates([999n, 1_000n, 1_000_000n]), [
    { gross: 999n, fee: 0n, net: 999n }, { gross: 1_000n, fee: 1n, net: 999n },
    { gross: 1_000_000n, fee: 1_000n, net: 999_000n }])
  assert.equal(finalHopMinimum(999n), 1_000n)
  assert.equal(finalHopMinimum(1_000n), 1_002n)
  for (const min of [1n, 7n, 999_000n, 123_456_789n]) {
    const venueMin = finalHopMinimum(min)
    assert.ok(venueMin - compose.composerFee(venueMin) >= min)
  }
})

// ---- account assembly --------------------------------------------------------

test('composeInstructions puts the payer first, dedupes accounts, ORs flags and rewrites indices', () => {
  const p1 = key(20), p2 = key(21), shared = key(22), only1 = key(23), only2 = key(24)
  const ix1 = new TransactionInstruction({ programId: p1, data: Buffer.alloc(16, 1), keys: [
    { pubkey: shared, isSigner: false, isWritable: false }, { pubkey: only1, isSigner: false, isWritable: true },
    { pubkey: wallet, isSigner: true, isWritable: false }] })
  const ix2 = new TransactionInstruction({ programId: p2, data: Buffer.alloc(16, 2), keys: [
    { pubkey: only2, isSigner: false, isWritable: false }, { pubkey: shared, isSigner: false, isWritable: true },
    { pubkey: p1, isSigner: false, isWritable: false }] })
  const ix = composeInstructions({ programId: COMPOSER, payer: wallet, steps: [{ instruction: ix1 },
    { instruction: ix2, patches: [{ dataOffset: 8, watch: only1, fromStep: 0 }] }],
  checks: [{ watch: shared, kind: 'max', bound: -3n }] })
  assert.ok(ix.programId.equals(COMPOSER))
  assert.ok(ix.keys[0].pubkey.equals(wallet) && ix.keys[0].isSigner && ix.keys[0].isWritable)
  const ids = ix.keys.map(k => k.pubkey.toBase58())
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(ix.keys.filter(k => k.isSigner).length, 1)
  assert.equal(ix.keys.find(k => k.pubkey.equals(shared))!.isWritable, true)
  assert.equal(ix.keys.find(k => k.pubkey.equals(p1))!.isWritable, false)
  const desc = decodeCompose(ix.data)
  const at = (i: number) => ix.keys[i].pubkey
  for (const [s, original] of [[0, ix1], [1, ix2]] as const) {
    assert.ok(at(desc.steps[s].programIndex).equals(original.programId))
    assert.deepEqual(desc.steps[s].accounts.map(i => at(i).toBase58()), original.keys.map(k => k.pubkey.toBase58()))
    assert.deepEqual(Buffer.from(desc.steps[s].data), Buffer.from(original.data))
  }
  assert.deepEqual(desc.watch.map(i => at(i).toBase58()), [only1.toBase58(), shared.toBase58()])
  assert.deepEqual(desc.steps[1].patches, [{ dataOffset: 8, watchSlot: 0, fromStep: 0, mode: 0, num: 0, den: 0, sub: 0n }])
  assert.deepEqual(desc.checks, [{ watchSlot: 1, kind: 1, bound: -3n }])
})

test('composeInstructions refuses itself as a step, foreign signers and forward patches', () => {
  const self = new TransactionInstruction({ programId: COMPOSER, keys: [], data: Buffer.alloc(8) })
  assert.throws(() => composeInstructions({ programId: COMPOSER, payer: wallet, steps: [{ instruction: self }] }), /compose itself/)
  const signer = new TransactionInstruction({ programId: key(30), data: Buffer.alloc(8),
    keys: [{ pubkey: key(31), isSigner: true, isWritable: true }] })
  assert.throws(() => composeInstructions({ programId: COMPOSER, payer: wallet, steps: [{ instruction: signer }] }), /another signer/)
  const plain = new TransactionInstruction({ programId: key(30), keys: [], data: Buffer.alloc(8) })
  assert.throws(() => composeInstructions({ programId: COMPOSER, payer: wallet,
    steps: [{ instruction: plain, patches: [{ dataOffset: 0, watch: key(32), fromStep: 0 }] }] }), /earlier steps/)
})

test('fee accounts are appended once per fee mint with the right program for each', () => {
  const t22 = key(40), classic = key(41), acct1 = key(42), acct2 = key(43)
  const step = (account: PublicKey) => new TransactionInstruction({ programId: key(44), data: Buffer.alloc(8),
    keys: [{ pubkey: account, isSigner: false, isWritable: true }] })
  const ix = composeInstructions({ programId: COMPOSER, payer: wallet, steps: [
    { instruction: step(acct1), fee: { watch: acct1, mint: t22, tokenProgram: TOKEN_2022_PROGRAM_ID } },
    { instruction: step(acct2), fee: { watch: acct2, mint: classic } },
    { instruction: step(acct2), fee: { watch: acct2, mint: classic } }] })
  const desc = decodeCompose(ix.data), at = (i: number) => ix.keys[i].pubkey
  const [f0, f1, f2] = desc.steps.map(s => s.fee!)
  assert.ok(at(f0.feeAtaIndex).equals(feeAta(t22, TOKEN_2022_PROGRAM_ID)) && ix.keys[f0.feeAtaIndex].isWritable)
  assert.ok(at(f0.tokenProgramIndex).equals(TOKEN_2022_PROGRAM_ID))
  assert.ok(at(f1.feeAtaIndex).equals(feeAta(classic, TOKEN_PROGRAM_ID)))
  assert.ok(at(f1.tokenProgramIndex).equals(TOKEN_PROGRAM_ID))
  assert.ok(at(f0.mintIndex).equals(t22) && at(f1.mintIndex).equals(classic))
  assert.ok(at(f0.ataProgramIndex).equals(ASSOCIATED_TOKEN_PROGRAM_ID))
  assert.ok(at(f0.systemProgramIndex).equals(new PublicKey('11111111111111111111111111111111')))
  assert.deepEqual(f1, f2)
  assert.equal(ix.keys.filter(k => k.pubkey.equals(FEE_RECIPIENT)).length, 1)
  assert.equal(ix.keys.filter(k => k.pubkey.equals(feeAta(classic))).length, 1)
})

// ---- two-leg composed route over the real CPMM and venueLeg builders -------

/** A CPMM leg as quoteRaydiumCpmm builds it, over fake pool accounts. */
function cpmmLeg(pool: number, inputMint: PublicKey, outputMint: PublicKey, amountIn: bigint, minOut: bigint) {
  const inputAta = mintAta(wallet, inputMint), outputAta = mintAta(wallet, outputMint)
  const { instruction, offsets } = cpmmSwapInstruction({ wallet, authority: key(pool), config: key(pool + 1),
    pool: key(pool + 2), inputAta, outputAta, inputVault: key(pool + 3), outputVault: key(pool + 4),
    inputMint, outputMint, observation: key(pool + 5) }, amountIn, minOut)
  return { instructions: [createAssociatedTokenAccountIdempotentInstruction(wallet, inputAta, wallet, inputMint),
    createAssociatedTokenAccountIdempotentInstruction(wallet, outputAta, wallet, outputMint), instruction],
  swapIndex: 2, offsets, inputAccount: inputAta, outputAccount: outputAta }
}
/** A Whirlpool-shaped swap (disc, amount, threshold, sqrt limit u128, flags) through venueLeg's offset proof. */
function whirlpoolLeg(inputMint: PublicKey, outputMint: PublicKey, amountIn: bigint, minOut: bigint) {
  const program = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc')
  const data = Buffer.alloc(42)
  data.set([248, 198, 158, 145, 225, 117, 135, 200])
  data.writeBigUInt64LE(amountIn, 8); data.writeBigUInt64LE(minOut, 16)
  data.writeBigUInt64LE(4295048016n, 24); data[40] = 1; data[41] = 1
  const inputAta = mintAta(wallet, inputMint), outputAta = mintAta(wallet, outputMint)
  const swap = new TransactionInstruction({ programId: program, data, keys: [
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: wallet, isSigner: true, isWritable: false },
    { pubkey: key(70), isSigner: false, isWritable: true }, { pubkey: inputAta, isSigner: false, isWritable: true },
    { pubkey: key(71), isSigner: false, isWritable: true }, { pubkey: outputAta, isSigner: false, isWritable: true },
    { pubkey: key(72), isSigner: false, isWritable: true }] })
  return venueLeg([createAssociatedTokenAccountIdempotentInstruction(wallet, outputAta, wallet, outputMint), swap],
    program, amountIn, minOut, inputAta, outputAta)
}

test('two-leg composed route patches hop 1 from the real intermediate delta at the proven offsets', () => {
  const userMin = 1_234_567n
  const leg0 = cpmmLeg(50, A, X, 5_000_000n, 4_900_000n)
  const leg1 = whirlpoolLeg(X, B, 4_995_000n, finalHopMinimum(userMin))
  assert.deepEqual(leg0.offsets, { amountInOffset: 8, minOutOffset: 16 })
  assert.deepEqual(leg1.offsets, { amountInOffset: 8, minOutOffset: 16 })
  const route = composeRoute([{ leg: leg0, outputMint: X }, { leg: leg1, outputMint: B }], wallet, userMin, COMPOSER)
  assert.equal(route.hops, 2)
  const desc = decodeCompose(route.compose.data), at = (i: number) => route.compose.keys[i].pubkey
  assert.equal(desc.steps.length, 2)
  assert.ok(at(desc.steps[0].programIndex).equals(RAYDIUM_CPMM_PROGRAM))
  const s0 = Buffer.from(desc.steps[0].data), s1 = Buffer.from(desc.steps[1].data)
  assert.equal(s0.readBigUInt64LE(8), 5_000_000n)
  assert.equal(s0.readBigUInt64LE(16), 0n, 'intermediate min_out is rewritten to 0')
  assert.equal(s1.readBigUInt64LE(16), finalHopMinimum(userMin))
  assert.equal(s1.readBigUInt64LE(24), 4295048016n, 'unrelated fields are untouched')
  assert.deepEqual(desc.steps[0].patches, [])
  const xAta = mintAta(wallet, X), bAta = mintAta(wallet, B)
  assert.deepEqual(desc.steps[1].patches.map(p => ({ ...p, watch: at(desc.watch[p.watchSlot]).toBase58() })),
    [{ dataOffset: 8, watchSlot: 0, fromStep: 0, mode: 0, num: 0, den: 0, sub: 0n, watch: xAta.toBase58() }])
  assert.ok(at(desc.watch[desc.steps[0].fee!.watchSlot]).equals(xAta))
  assert.ok(at(desc.steps[0].fee!.mintIndex).equals(X) && at(desc.steps[0].fee!.feeAtaIndex).equals(feeAta(X)))
  assert.ok(at(desc.watch[desc.steps[1].fee!.watchSlot]).equals(bAta))
  assert.ok(at(desc.steps[1].fee!.mintIndex).equals(B))
  assert.deepEqual(desc.checks.map(c => ({ ...c, watch: at(desc.watch[c.watchSlot]).toBase58() })),
    [{ watchSlot: desc.steps[1].fee!.watchSlot, kind: 0, bound: userMin, watch: bAta.toBase58() }])
  // Setup is hoisted and the shared intermediate ATA creation appears once.
  assert.equal(route.before.length, 3)
  assert.equal(route.after.length, 0)
  for (const version of ['1', '0'] as const) {
    const wire = buildComposedTransaction({ payer: wallet, blockhash: hash, version, programId: COMPOSER,
      before: route.before, compose: route.compose, after: route.after })
    assert.ok(wire.length > 0)
    if (version === '1') {
      const decoded = decodeV1(Buffer.from(wire, 'base64'), { requireResources: true })
      assert.equal(decoded.required, 1)
      assert.equal(decoded.config.computeUnitLimit, 1_400_000)
      assert.equal(decoded.ixs.length, 4)
    }
  }
  assert.throws(() => composeRoute([{ leg: { ...leg0, offsets: null }, outputMint: X }, { leg: leg1, outputMint: B }],
    wallet, userMin, COMPOSER), /unproven amount offsets/)
  assert.throws(() => composeRoute([{ leg: leg1, outputMint: B }, { leg: leg0, outputMint: X }], wallet, userMin, COMPOSER),
    /intermediate token account/)
})

// ---- router gating and discovery -----------------------------------------------

const insertPool = db.prepare(`INSERT INTO pools (chain,address,venue,mint_a,mint_b,created_ts,liq_events,funded)
  VALUES ('solana',?,?,?,?,1000,?,1)`)
insertPool.run('pool-ax', 'raydium-cpmm', A.toBase58(), X.toBase58(), 9)
insertPool.run('pool-xb', 'orca', X.toBase58(), B.toBase58(), 8)
insertPool.run('pool-xs', 'raydium-cpmm', X.toBase58(), SOL, 3)
insertPool.run('pool-as', 'raydium-cpmm', A.toBase58(), SOL, 3)

const SECRET_RPC = 'https://secret-node.example/?api-key=SUPERSECRETRPCKEY123'
/** Fake pool state: hop A→X doubles, hop X→B triples; legs use the real builders. */
function fakeQuote(calls: string[]) {
  return async (pool: { address: string; venue: string }, intent: any) => {
    calls.push(`${pool.address}:${intent.amount}:${intent.keepNative ?? ''}`)
    const amount = BigInt(intent.amount), inputMint = new PublicKey(intent.inputMint)
    const outputMint = new PublicKey(intent.outputMint)
    const out = pool.address === 'pool-ax' ? amount * 2n : amount * 3n
    const minimum = out * 99n / 100n
    const leg = async (_wallet: PublicKey, floor: bigint) => pool.venue === 'orca'
      ? whirlpoolLeg(inputMint, outputMint, amount, floor) : cpmmLeg(80, inputMint, outputMint, amount, floor)
    return { pool: { ...pool, mint_a: '', mint_b: '', liq_events: 0 }, out, minimum, fee: 7n, feeMint: intent.inputMint,
      leg, instructions: async (w: PublicKey, f: bigint) => (await leg(w, f)).instructions }
  }
}
const intent = { inputMint: A.toBase58(), outputMint: B.toBase58(), amount: '1000000', slippageBps: 100,
  transactionVersion: '1' as const }

test('two-hop discovery is off unless the composer program is configured', async () => {
  const calls: string[] = []
  const router = new DirectSolanaRouter(SECRET_RPC)
  ;(router as any).quotePool = fakeQuote(calls)
  await assert.rejects((router as any).candidates(intent), /No executable direct pool route/)
  assert.deepEqual(calls, [])
})

test('configured composer finds the A→X→B route with fee-adjusted amounts and a two-leg plan', async () => {
  const calls: string[] = []
  const router = new DirectSolanaRouter(SECRET_RPC, { composerProgramId: COMPOSER.toBase58() })
  ;(router as any).quotePool = fakeQuote(calls)
  const [route] = await (router as any).candidates(intent)
  const out1 = 2_000_000n, middle = out1 - out1 / 1000n, out2 = middle * 3n, final = out2 - out2 / 1000n
  assert.deepEqual(calls, ['pool-ax:1000000:output', `pool-xb:${middle}:input`])
  assert.equal(route.hops, 2)
  assert.equal(route.out, final)
  assert.equal(route.minimum, final * 9_900n / 10_000n)
  assert.deepEqual(route.plan.map((p: any) => [p.swapInfo.ammKey, p.swapInfo.label, p.swapInfo.inputMint,
    p.swapInfo.outputMint, p.swapInfo.inAmount, p.swapInfo.outAmount]), [
    ['pool-ax', 'Raydium CPMM', A.toBase58(), X.toBase58(), '1000000', out1.toString()],
    ['pool-xb', 'Orca Whirlpool', X.toBase58(), B.toBase58(), middle.toString(), out2.toString()]])
  const quote = (router as any).quoteFor(intent, route, 1)
  assert.equal(quote.composed, true)
  assert.equal(quote.hops, 2)
  assert.equal(quote.outAmount, final.toString())
  // Disclosure: the wallet sees which program it will call and who the fee pays.
  assert.equal(quote.composerProgramId, COMPOSER.toBase58())
  assert.equal(quote.composerFeeRecipient, FEE_RECIPIENT.toBase58())
  assert.equal(quote.composerFeeBps, 10)
  const floor = route.minimum
  const built = await route.build(wallet, floor)
  assert.ok(built.allowPrograms[0].equals(COMPOSER))
  const composeIx = built.instructions.find((ix: TransactionInstruction) => ix.programId.equals(COMPOSER))
  const desc = decodeCompose(composeIx.data)
  assert.equal(desc.checks[0].bound, floor)
  assert.equal(Buffer.from(desc.steps[1].data).readBigUInt64LE(16), finalHopMinimum(floor))
  assert.equal(desc.steps[1].patches[0].dataOffset, 8)
  const wire = buildComposedTransaction({ payer: wallet, blockhash: hash, version: '1', programId: COMPOSER,
    compose: composeIx, before: built.instructions.filter((ix: TransactionInstruction) => !ix.programId.equals(COMPOSER)) })
  assert.ok(decodeV1(Buffer.from(wire, 'base64')).ixs.length >= 2)
  for (const text of [JSON.stringify(quote), JSON.stringify(route.plan)]) assert.ok(!text.includes('SUPERSECRET'))
})

test('composed routes skip native SOL destinations and never leak the RPC URL in errors', async () => {
  const calls: string[] = []
  const router = new DirectSolanaRouter(SECRET_RPC, { composerProgramId: COMPOSER.toBase58() })
  ;(router as any).quotePool = fakeQuote(calls)
  const toSol = await (router as any).candidates({ ...intent, outputMint: SOL })
  assert.ok(toSol.every((c: any) => c.hops === 1))
  assert.ok(!calls.some(c => c.startsWith('pool-xs')))
  ;(router as any).quotePool = async () => { throw new Error(`fetch failed: ${SECRET_RPC}`) }
  const error = await (router as any).candidates(intent).catch((e: Error) => e)
  assert.ok(error instanceof Error)
  assert.ok(!error.message.includes('SUPERSECRET'))
})

test('buildSwap passes composed: true and hops through only for a composed direct build', async () => {
  const { unsignedV1 } = await import('../src/solana/self-router.ts')
  const transfer = new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, keys: [
    { pubkey: wallet, isSigner: true, isWritable: true }], data: Buffer.of(1) })
  const swapTransaction = unsignedV1(wallet, hash, [transfer])
  const quoteResponse = { inputMint: intent.inputMint, outputMint: intent.outputMint, inAmount: '1000000',
    outAmount: '5000', otherAmountThreshold: '4900', swapMode: 'ExactIn', slippageBps: 100, routePlan: [{}, {}] }
  for (const composed of [true, false]) {
    const handler = createSolanaRouterHandler({ rpcUrl: SECRET_RPC, localRouter: {
      quote: async () => { throw new Error('unused') },
      swap: async () => ({ transactionVersion: '1', swapTransaction, lastValidBlockHeight: 10,
        quoteResponse, ...(composed ? { composed: true, hops: 2 } : {}) }) } as any })
    const built = await handler.buildSwap({ userPublicKey: wallet.toBase58(), quoteResponse })
    assert.equal(built.composed, composed ? true : undefined)
    assert.equal(built.hops, composed ? 2 : undefined)
    assert.ok(!JSON.stringify(built).includes('SUPERSECRET'))
  }
})
