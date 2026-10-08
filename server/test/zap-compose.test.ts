import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PublicKey } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { composeZap, decodeCompose, FEE_RECIPIENT, type ZapComposeStep } from '../src/solana/compose.ts'
import { assembleComposedZap, proveVenueAdd, proveVenueSwap, u32Ratio, WSOL_MINT } from '../src/solana/zap-compose.ts'
import type { RawInstruction } from '../src/solana/zap.ts'

const OWNER = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB'
const TOKEN_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
const SYSTEM = '11111111111111111111111111111111'
const VENUE = '4xp7kN4nVt19caq4kM629vL8vJEqpSFVdZAh27wvYPh8'
const COMPOSER = 'BHYw1FAWPriW9Gh7BG49X4UVe96CDjaxFrFFUtGSQmRx'

const u64 = (value: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(value); return b }
const ix = (programId: string, data: Buffer): RawInstruction => ({ programId, keys: [], data: data.toString('base64') })
const swapIx = (amountIn: bigint, minOut: bigint) => ix(VENUE, Buffer.concat([Buffer.from([9]), u64(amountIn), u64(minOut), Buffer.from([7])]))

const DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'
test('u32 ratio: exact when the reduced fraction fits, dyadic downward otherwise, null when unreachable', () => {
  assert.deepEqual(u32Ratio(1n, 1n), { num: 1, den: 1 })
  assert.deepEqual(u32Ratio(6n, 4n), { num: 3, den: 2 })
  assert.deepEqual(u32Ratio(100n, 10_000_000_000n), { num: 1, den: 100_000_000 }, 'small exact ratios reduce')
  assert.equal(u32Ratio(0n, 5n), null)
  assert.equal(u32Ratio(5n, 0n), null)
  // 10000.0000000001 needs a dyadic approximation: the first scale whose
  // numerator fits u32 is 2048, giving 20480/2048, still under ~0.1% off.
  const scaled = u32Ratio(10_000_000_000_001n, 10_000_000_000n)!
  assert.deepEqual(scaled, { num: 4194304000, den: 4194304 })
  assert.ok(BigInt(scaled.num) * 10_000_000_000n <= BigInt(scaled.den) * 10_000_000_000_001n, 'never scales up')
  assert.equal(u32Ratio(100n, 1_000_000_000_000n), null, 'precision below 1/1024 is refused')
  assert.equal(u32Ratio((1n << 40n) + 3n, 1n), null, 'ratios beyond u32 are refused')
})

test('venue swap proof: one instruction holding both quoted amounts exactly once; ambiguity and absence fail', () => {
  const amountIn = 497_500_000n, minOut = 985_050_000n
  const wrap = ix(SYSTEM, Buffer.concat([Buffer.from([2]), u64(amountIn)]))
  const proof = proveVenueSwap([wrap, swapIx(amountIn, minOut)], amountIn, minOut)
  assert.deepEqual(proof, { index: 1, amountInOffset: 1, minOutOffset: 9 })
  assert.equal(proveVenueSwap([wrap], amountIn, minOut), null, 'no swap instruction')
  assert.equal(proveVenueSwap([ix(VENUE, Buffer.concat([Buffer.from([9]), u64(amountIn), u64(amountIn), Buffer.from([7])]))], amountIn, minOut), null, 'overlapping amounts')
  assert.equal(proveVenueSwap([swapIx(amountIn, minOut), ix(SYSTEM, Buffer.concat([Buffer.from([3]), u64(minOut), u64(amountIn)]))], amountIn, minOut), null, 'two candidates')
})

test('venue add proof: liquidity-driven deposits rescale and re-bound; amount-driven deposits take the delta', () => {
  const expected = 995_000_000n, liquidity = 6_965_000_000n
  const solExpected = 447_500_000n, tokenLimit = 995_000_000n, solLimit = 497_500_000n
  const quote = { amounts: [
    { mint: TOKEN_MINT, direction: 'debit', expectedRaw: expected.toString(), limitRaw: tokenLimit.toString() },
    { mint: WSOL_MINT, direction: 'debit', expectedRaw: solExpected.toString(), limitRaw: solLimit.toString() },
  ], details: { liquidity: liquidity.toString() } }
  const data = Buffer.concat([Buffer.from([8]), u64(liquidity), u64(tokenLimit), u64(solLimit)])
  const proof = proveVenueAdd([ix(SYSTEM, Buffer.from([1])), ix(VENUE, data)], quote, TOKEN_MINT)
  assert.equal(proof!.index, 1)
  assert.deepEqual(proof!.patches, [
    { dataOffset: 1, mode: 1, num: 7, den: 1 },        // liquidity rescaled to the real delta (7/1 exact here)
    { dataOffset: 9, mode: 0 },                         // token-side bound becomes the raw delta
    { dataOffset: 17, mode: 1, num: 1, den: 2 },        // SOL-side bound follows the same scaling
  ])
  assert.equal(proveVenueAdd([ix(VENUE, Buffer.concat([Buffer.from([8]), u64(liquidity + 1n)]))], quote, TOKEN_MINT), null, 'liquidity not locatable')

  const amountQuote = { amounts: [
    { mint: TOKEN_MINT, direction: 'debit', expectedRaw: expected.toString(), limitRaw: expected.toString() },
    { mint: WSOL_MINT, direction: 'debit', expectedRaw: solExpected.toString(), limitRaw: solLimit.toString() },
  ], details: {} }
  const amountData = Buffer.concat([Buffer.from([5]), u64(expected), u64(solExpected)])
  const amountProof = proveVenueAdd([ix(VENUE, amountData)], amountQuote, TOKEN_MINT)
  assert.deepEqual(amountProof!.patches, [
    { dataOffset: 1, mode: 0 },
    { dataOffset: 9, mode: 1, num: 179, den: 398 },     // 447.5m/995m reduces exactly
  ])
  assert.equal(proveVenueAdd([ix(VENUE, Buffer.from([5]))], amountQuote, TOKEN_MINT), null, 'amounts not locatable')
})

test('zap in assembly: the swap feeds a fee\'d token account, the deposit is patched from its real delta', () => {
  const amountIn = 497_500_000n, minOut = 985_050_000n, expected = 995_000_000n, liquidity = 6_965_000_000n
  const tokenLimit = 995_000_000n, solLimit = 497_500_000n
  const setup = ix(SYSTEM, Buffer.from([2, 3])), cleanup = ix(SYSTEM, Buffer.from([4]))
  const addData = Buffer.concat([Buffer.from([8]), u64(liquidity), u64(tokenLimit), u64(solLimit)])
  const assembly = assembleComposedZap({ direction: 'in', owner: OWNER, tokenMint: TOKEN_MINT, tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    swap: { instructions: [setup, swapIx(amountIn, minOut), cleanup], amountIn, minOut },
    add: { instructions: [ix(SYSTEM, Buffer.from([1])), ix(VENUE, addData), ix(SYSTEM, Buffer.from([5]))],
      quote: { amounts: [
        { mint: TOKEN_MINT, direction: 'debit', expectedRaw: expected.toString(), limitRaw: tokenLimit.toString() },
        { mint: WSOL_MINT, direction: 'debit', expectedRaw: '447500000', limitRaw: solLimit.toString() },
      ], details: { liquidity: liquidity.toString() } } } })
  assert.ok(assembly)
  const steps = assembly!.steps
  assert.equal(steps.length, 2)
  const composed = composeZap(steps, { programId: new PublicKey(COMPOSER), payer: new PublicKey(OWNER) })
  const before = composed.before, after = composed.after
  assert.deepEqual(before.map(b => Buffer.from(b.data, 'base64')), [Buffer.from([2, 3]), Buffer.from([1])], 'setup hoists in step order')
  assert.deepEqual(after.map(a => Buffer.from(a.data, 'base64')), [Buffer.from([4]), Buffer.from([5])], 'cleanup rides after in step order')
  const description = decodeCompose(Buffer.from(composed.compose.data))
  assert.equal(description.steps.length, 2)
  assert.equal(description.checks.length, 0, 'no static check: the venue minimums guard a dynamic deposit')
  assert.equal(description.watch.length, 1, 'the token account is the only watch')
  assert.ok(description.steps[0].fee, 'the swap step is fee\'d in kind')
  assert.equal(description.steps[0].fee!.watchSlot, 0)
  assert.equal(description.steps[0].patches.length, 0)
  assert.deepEqual(description.steps[1].fee, null)
  assert.deepEqual(description.steps[1].patches.map(p => ({ mode: p.mode, num: p.num, den: p.den })), [
    { mode: 1, num: 7, den: 1 }, { mode: 0, num: 0, den: 0 }, { mode: 1, num: 1, den: 2 }])
  // The fee's mint and ATA accounts ride the compose instruction's keys.
  const keys = composed.compose.keys.map(k => k.pubkey.toBase58())
  assert.ok(keys.includes(FEE_RECIPIENT.toBase58()))
})

test('zap out assembly: the withdrawal\'s venue instructions are steps, and the swap back spends exactly what arrived', () => {
  const amountIn = 5_000_000n, minOut = 2_475_000n
  // Account plumbing around the venue instructions rides outside the compose call, in order.
  const createAta = ix(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), Buffer.from([1]))
  const remove = ix(DLMM_PROGRAM, Buffer.from([5, 5, 5, 5])), claim = ix(DLMM_PROGRAM, Buffer.from([6, 6]))
  const closeWsol = ix(TOKEN_PROGRAM_ID.toBase58(), Buffer.from([9]))
  const wrap = ix(SYSTEM, Buffer.from([6]))
  const assembly = assembleComposedZap({ direction: 'out', owner: OWNER, tokenMint: TOKEN_MINT, tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    remove: { instructions: [createAta, remove, claim, closeWsol] },
    swap: { instructions: [wrap, swapIx(amountIn, minOut), ix(SYSTEM, Buffer.from([7]))], amountIn, minOut } })
  assert.ok(assembly)
  const steps: ZapComposeStep[] = assembly!.steps
  assert.equal(steps.length, 3, 'the two venue instructions and the swap back')
  const composed = composeZap(steps, { programId: new PublicKey(COMPOSER), payer: new PublicKey(OWNER) })
  assert.deepEqual(composed.before.map(i => i.data[0]), [1, 6], 'the token account is made first, then the swap\'s own setup')
  assert.deepEqual(composed.after.map(i => i.data[0]), [9, 7], 'wrapped SOL closes after the compose call')
  const description = decodeCompose(Buffer.from(composed.compose.data))
  assert.equal(description.steps.length, 3)
  assert.equal(description.watch.length, 2, 'the token account feeds the patches, the WSOL account the fee')
  assert.deepEqual([description.steps[0].fee, description.steps[1].fee], [null, null], 'the withdrawal itself is not fee\'d')
  const swapBack = description.steps[2]
  assert.equal(swapBack.patches.length, 2)
  assert.equal(swapBack.patches[0].mode, 0, 'the swap spends the raw token delta')
  assert.deepEqual({ mode: swapBack.patches[1].mode, num: swapBack.patches[1].num, den: swapBack.patches[1].den },
    { mode: 1, num: 99, den: 200 }, 'the minimum out scales with what arrived')
  assert.ok(swapBack.fee, 'the swap back is fee\'d in kind')
  assert.equal(swapBack.fee!.watchSlot, 1)
  assert.equal(swapBack.patches[0].fromStep, 0)
  assert.equal(swapBack.patches[1].fromStep, 0)
})

test('zap out assembly refuses a withdrawal with no venue instruction', () => {
  const amountIn = 5_000_000n, minOut = 2_475_000n
  assert.equal(assembleComposedZap({ direction: 'out', owner: OWNER, tokenMint: TOKEN_MINT, tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    remove: { instructions: [ix(SYSTEM, Buffer.from([5]))] }, swap: { instructions: [swapIx(amountIn, minOut)], amountIn, minOut } }), null)
})

test('zap out assembly refuses a minimum it cannot scale', () => {
  const amountIn = 1_000_000_000_000n, minOut = 1n // minOut/in = 1e-12: below 1/1024 precision
  const assembly = assembleComposedZap({ direction: 'out', owner: OWNER, tokenMint: TOKEN_MINT, tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    remove: { instructions: [ix(DLMM_PROGRAM, Buffer.from([5]))] },
    swap: { instructions: [swapIx(amountIn, minOut)], amountIn, minOut } })
  assert.equal(assembly, null)
})
