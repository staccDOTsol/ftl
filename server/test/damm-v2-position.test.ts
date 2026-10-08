import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Connection, PublicKey } from '@solana/web3.js'
import { CpAmm, derivePositionAddress, type PoolState } from '@meteora-ag/cp-amm-sdk'
import BN from 'bn.js'
import { dammV2DepositFrom, liquidityWord, tokenIsA } from '../src/solana/damm-v2-position.ts'
import { proveVenueAdd, WSOL_MINT } from '../src/solana/zap-compose.ts'

const TOKEN = '6Mix12LiHrQFojaQEnfPUC65Qkwd6X4Y5Qg93oFbordr'
const POOL = '4xp7kN4nVt19caq4kM629vL8vJEqpSFVdZAh27wvYPh8'
const OWNER = '6NvKjD476zgAjNavzhpQ1jD2ZAE6hBfdGKDbn5FrjbWw'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
// Never contacted: building from a read pool state is offline.
const amm = new CpAmm(new Connection('http://127.0.0.1:1'))
// The BORDR/SOL pool as read from mainnet (full range, fees in SOL).
const SQRT_PRICE = 1139995300741011863n
const bordrState = (solIsA = false) => ({
  tokenAMint: new PublicKey(solIsA ? WSOL_MINT : TOKEN), tokenBMint: new PublicKey(solIsA ? TOKEN : WSOL_MINT), tokenAFlag: 0, tokenBFlag: 0,
  // Mirroring a full-range pool inverts the price: sqrt(1/p) in Q64 is 2^128 / sqrt(p).
  sqrtPrice: new BN((solIsA ? (1n << 128n) / SQRT_PRICE : SQRT_PRICE).toString()),
  sqrtMinPrice: new BN('4295048016'), sqrtMaxPrice: new BN('79226673521066979257578248091'), collectFeeMode: 1,
  tokenAAmount: new BN(solIsA ? '272984754284' : '71477886271295'), tokenBAmount: new BN(solIsA ? '71477886271295' : '272984754284'),
  liquidity: new BN('81484454442553803590663557505057'),
}) as unknown as PoolState
const input = { pool: POOL, owner: OWNER, tokenMint: TOKEN, tokenAmount: 2_575_479_044n, solAmount: 10_000_000n, slippageBps: 100, parameters: {} }

test('the pool must pair the token with SOL, in either order', () => {
  assert.equal(tokenIsA(TOKEN, WSOL_MINT, TOKEN), true)
  assert.equal(tokenIsA(WSOL_MINT, TOKEN, TOKEN), false)
  assert.throws(() => tokenIsA(TOKEN, USDC, TOKEN), /does not pair this token with SOL/)
  assert.throws(() => tokenIsA(USDC, WSOL_MINT, TOKEN), /does not pair this token with SOL/)
  assert.throws(() => tokenIsA(WSOL_MINT, TOKEN, WSOL_MINT), /must not be SOL/)
})

test('liquidity keeps its Q64.64 integer word and zeroes the fraction', () => {
  const delta = (157_675_014n << 64n) + 12_345n
  assert.deepEqual(liquidityWord(delta), { liquidity: 157_675_014n, encoded: 157_675_014n << 64n })
  assert.equal(liquidityWord((1n << 64n) - 1n).liquidity, 0n, 'under one liquidity unit is nothing')
})

for (const solIsA of [false, true]) {
  test(`deposit proves for the composer with SOL as token ${solIsA ? 'A' : 'B'}`, async () => {
    const deposit = await dammV2DepositFrom(amm, bordrState(solIsA), input)
    const [token, sol] = deposit.quote.amounts
    assert.equal(token.mint, TOKEN); assert.equal(sol.mint, WSOL_MINT)
    assert.ok(BigInt(sol.limitRaw) <= input.solAmount, 'the SOL maximum (and wrap) stays within solAmount')
    assert.equal(BigInt(token.expectedRaw), input.tokenAmount, 'the composer anchors on the token budget')
    const estimate = BigInt(deposit.quote.details.tokenEstimateRaw as string)
    assert.ok(estimate <= input.tokenAmount)
    assert.equal(BigInt(token.limitRaw), estimate * 10_100n / 10_000n)
    const nft = deposit.signers[0].publicKey
    assert.equal(deposit.signers.length, 1)
    assert.equal(deposit.position, derivePositionAddress(nft).toBase58())
    assert.ok(deposit.instructions[0].keys.some(k => k.pubkey === nft.toBase58() && k.isSigner), 'create_position is signed by the NFT mint')
    const proof = proveVenueAdd(deposit.instructions, deposit.quote, TOKEN)
    assert.ok(proof, 'proveVenueAdd finds the deposit')
    const add = Buffer.from(deposit.instructions[proof.index].data, 'base64')
    assert.equal(add.length, 40)
    assert.equal(add.readBigUInt64LE(8), 0n, 'fraction word is zero')
    assert.equal(add.readBigUInt64LE(16).toString(), deposit.quote.details.liquidity)
    const [tokenAt, solAt] = solIsA ? [32, 24] : [24, 32]
    assert.equal(add.readBigUInt64LE(tokenAt).toString(), token.limitRaw)
    assert.equal(add.readBigUInt64LE(solAt).toString(), sol.limitRaw)
    assert.deepEqual(proof.patches.map(p => [p.dataOffset, p.mode]), [[16, 1], [tokenAt, 0], [solAt, 1]])
    // The wrap funds exactly the SOL maximum before the deposit.
    const transfer = deposit.instructions.find(ix => ix.programId === '11111111111111111111111111111111')!
    assert.equal(Buffer.from(transfer.data, 'base64').readBigUInt64LE(4).toString(), sol.limitRaw)
  })
}
