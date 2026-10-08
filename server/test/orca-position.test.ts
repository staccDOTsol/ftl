import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import BN from 'bn.js'
import { ORCA_WHIRLPOOL_PROGRAM_ID, PDAUtil, TickUtil, WhirlpoolContext, WhirlpoolIx } from '@orca-so/whirlpools-sdk'
import { positionTicks } from '../src/solana/orca-position.ts'
import { debit, rawInstructions } from '../src/solana/venue-deposit.ts'
import { proveVenueAdd, WSOL_MINT } from '../src/solana/zap-compose.ts'

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

test('orca range: ±rangeWidthPct in price, widened outward to the spacing; full range when asked or forced', () => {
  // 100% is half to double: ln 2 / ln 1.0001 ≈ 6931.8 ticks each side.
  const { tickLowerIndex, tickUpperIndex, fullRange } = positionTicks(-22_118, 4, { rangeWidthPct: 100 })
  assert.equal(fullRange, false)
  assert.ok(tickLowerIndex % 4 === 0 && tickUpperIndex % 4 === 0, 'both ends initializable at spacing 4')
  assert.ok(tickLowerIndex <= -22_118 - 6931.8 && tickLowerIndex > -22_118 - 6931.8 - 4, 'lower floors outward by under one spacing')
  assert.ok(tickUpperIndex >= -22_118 + 6931.8 && tickUpperIndex < -22_118 + 6931.8 + 4, 'upper ceils outward by under one spacing')
  // A string width (parameters travel as JSON) and a narrow range still bracket the current tick strictly.
  const narrow = positionTicks(1_000, 64, { rangeWidthPct: '0.1' })
  assert.ok(narrow.tickLowerIndex < 1_000 && narrow.tickUpperIndex > 1_000)
  assert.deepEqual([narrow.tickLowerIndex, narrow.tickUpperIndex], [960, 1_024])
  const full = TickUtil.getFullRangeTickIndex(64)
  assert.deepEqual(positionTicks(1_000, 64, { fullRange: true }), { tickLowerIndex: full[0], tickUpperIndex: full[1], fullRange: true })
  // Splash pools (spacing ≥ 32768) only take full-range positions.
  const splash = TickUtil.getFullRangeTickIndex(32_896)
  assert.deepEqual(positionTicks(1_000, 32_896, { rangeWidthPct: 100 }), { tickLowerIndex: splash[0], tickUpperIndex: splash[1], fullRange: true })
  // Near the edge, the range clamps to full range instead of leaving it.
  assert.equal(positionTicks(440_000, 64, { rangeWidthPct: 100 }).tickUpperIndex, full[1])
  assert.throws(() => positionTicks(0, 64, { rangeWidthPct: 0 }))
  assert.throws(() => positionTicks(0, 64, { rangeWidthPct: 'wide' }))
})

test('orca deposit proof: increase_liquidity_v2\'s u128 liquidity is found by its low 8 bytes, both maxima bound', () => {
  // Offline: the instruction is built by the same SDK call the builder uses; no RPC is made.
  const ctx = WhirlpoolContext.from(new Connection('http://127.0.0.1:1'), { publicKey: PublicKey.default } as any)
  const owner = Keypair.generate().publicKey, whirlpool = Keypair.generate().publicKey, mint = Keypair.generate().publicKey
  const position = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, mint).publicKey
  const key = () => Keypair.generate().publicKey
  const tokenAmount = 1_500_000n, liquidity = 15_471_182n, solEstimate = 13_696_293n, solMax = 13_833_256n, tokenMax = 1_515_000n
  // SOL is mint A here, as in the mainnet SOL/USDC whirlpool.
  const ix = WhirlpoolIx.increaseLiquidityV2Ix(ctx.program, { whirlpool, position, positionTokenAccount: key(), positionAuthority: owner,
    tokenMintA: new PublicKey(WSOL_MINT), tokenMintB: new PublicKey(USDC), tokenOwnerAccountA: key(), tokenOwnerAccountB: key(),
    tokenVaultA: key(), tokenVaultB: key(), tokenProgramA: TOKEN_PROGRAM_ID, tokenProgramB: TOKEN_PROGRAM_ID,
    tickArrayLower: key(), tickArrayUpper: key(), liquidityAmount: new BN(liquidity.toString()),
    tokenMaxA: new BN(solMax.toString()), tokenMaxB: new BN(tokenMax.toString()) })
  const instructions = rawInstructions(ix.instructions)
  const data = Buffer.from(instructions[0].data, 'base64')
  assert.equal(data.length, 41, 'discriminator, u128 liquidity, two u64 maxima, None remaining-accounts info')
  assert.equal(data.readBigUInt64LE(16), 0n, 'the u128\'s high half is zero below 2^64')
  const quote = { amounts: [debit(USDC, tokenAmount, tokenMax), debit(WSOL_MINT, solEstimate, solMax)], details: { liquidity: liquidity.toString() } }
  assert.deepEqual(proveVenueAdd(instructions, quote, USDC), { index: 0, patches: [
    { dataOffset: 8, mode: 1, num: 7_735_591, den: 750_000 },   // liquidity follows the real token delta
    { dataOffset: 32, mode: 0 },                                // token_max_b (the token side) becomes the delta
    { dataOffset: 24, mode: 1, num: 1_729_157, den: 187_500 },  // token_max_a (SOL) scales with it
  ] })
})
