import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Keypair, PublicKey, type Connection } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { CLMM_PROGRAM_ID, PoolInfoLayout, TickUtil, getPdaPersonalPositionAddress } from '@raydium-io/raydium-sdk-v2'
import BN from 'bn.js'
import { clmmTickRange, newClmmDeposit } from '../src/solana/clmm-position.ts'
import { proveVenueAdd, WSOL_MINT } from '../src/solana/zap-compose.ts'

const OWNER = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB'
const TOKEN_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
const POOL = Keypair.generate().publicKey

/** A pool account as the CLMM program stores it, and a connection that serves only it, the token mint and rent. */
function fakeChain({ tokenIsA, tokenProgram = TOKEN_PROGRAM_ID, status = 0, mintB = WSOL_MINT }: { tokenIsA: boolean; tokenProgram?: PublicKey; status?: number; mintB?: string }) {
  const pool = PoolInfoLayout.decode(Buffer.alloc(PoolInfoLayout.span))
  const [a, b] = tokenIsA ? [TOKEN_MINT, mintB] : [WSOL_MINT, TOKEN_MINT]
  Object.assign(pool, { mintA: new PublicKey(a), mintB: new PublicKey(b), vaultA: Keypair.generate().publicKey, vaultB: Keypair.generate().publicKey,
    configId: Keypair.generate().publicKey, mintDecimalsA: tokenIsA ? 5 : 9, mintDecimalsB: tokenIsA ? 9 : 5, tickSpacing: 60, status,
    tickCurrent: -22_011, sqrtPriceX64: TickUtil.getSqrtPriceAtTick(-22_011).add(new BN(12_345)) })
  const data = Buffer.alloc(PoolInfoLayout.span)
  PoolInfoLayout.encode(pool, data)
  return { getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(key => key.equals(POOL) ? { owner: CLMM_PROGRAM_ID, data, lamports: 1, executable: false }
      : key.toBase58() === TOKEN_MINT ? { owner: tokenProgram, data: Buffer.alloc(82), lamports: 1, executable: false } : null),
    getMinimumBalanceForRentExemption: async () => 2_039_280 } as unknown as Connection
}
const input = { pool: POOL.toBase58(), owner: OWNER, tokenMint: TOKEN_MINT, tokenAmount: 995_000_000n, solAmount: 497_500_000n,
  slippageBps: 100, parameters: { rangeWidthPct: 100, wrapSol: true } }

test('CLMM range: ±width as ×/÷ (1 + width), aligned outward to the tick spacing', () => {
  assert.deepEqual(clmmTickRange(-22_011, 60, 100), { tickLower: -28_980, tickUpper: -15_060 }) // ±6932 ticks is ×/÷ 2
  assert.deepEqual(clmmTickRange(0, 1, 100), { tickLower: -6_932, tickUpper: 6_932 })
  assert.deepEqual(clmmTickRange(7, 10, 0.0001), { tickLower: 0, tickUpper: 10 }, 'never narrower than one tick each side')
  assert.deepEqual(clmmTickRange(443_000, 60, 100), { tickLower: 436_020, tickUpper: 443_580 }, 'kept inside the tick bounds')
  assert.throws(() => clmmTickRange(0, 1, 0))
})

for (const tokenIsA of [false, true]) test(`CLMM deposit (token as mint ${tokenIsA ? 'A' : 'B'}): one signer, a provable liquidity and both bounds`, async () => {
  const tokenProgram = tokenIsA ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
  const deposit = await newClmmDeposit(fakeChain({ tokenIsA, tokenProgram }), input)
  const [nftMint] = deposit.signers
  assert.equal(deposit.signers.length, 1)
  assert.equal(deposit.position, getPdaPersonalPositionAddress(CLMM_PROGRAM_ID, nftMint.publicKey).publicKey.toBase58())
  const open = deposit.instructions.findIndex(ix => ix.programId === CLMM_PROGRAM_ID.toBase58())
  assert.deepEqual(deposit.instructions[open].keys.filter(k => k.isSigner).map(k => k.pubkey), [OWNER, nftMint.publicKey.toBase58()])
  const tokenAccount = getAssociatedTokenAddressSync(new PublicKey(TOKEN_MINT), new PublicKey(OWNER), false, tokenProgram).toBase58()
  assert.equal(deposit.instructions[open].keys[tokenIsA ? 9 : 10].pubkey, tokenAccount, 'the token side spends from the wallet ATA')
  assert.equal(deposit.instructions.at(-1)!.programId, TOKEN_PROGRAM_ID.toBase58(), 'the temporary WSOL account closes afterwards')

  const [token, sol] = deposit.quote.amounts
  assert.deepEqual([token.mint, token.expectedRaw, token.limitRaw, sol.mint, sol.limitRaw], [TOKEN_MINT, '995000000', '995000000', NATIVE_MINT.toBase58(), '497500000'])
  assert.ok(BigInt(sol.expectedRaw) <= 497_500_000n * 10_000n / 10_100n, 'liquidity leaves the slippage headroom on the SOL side')
  const { tickLower, tickUpper } = deposit.quote.details as { tickLower: number; tickUpper: number }
  assert.ok(tickLower % 60 === 0 && tickUpper % 60 === 0 && tickLower < -22_011 && -22_011 < tickUpper)

  const proof = proveVenueAdd(deposit.instructions, deposit.quote, TOKEN_MINT)
  assert.ok(proof, 'the composer can prove the deposit')
  assert.equal(proof!.index, open)
  const data = Buffer.from(deposit.instructions[open].data, 'base64')
  assert.equal(data.readBigUInt64LE(24), BigInt(deposit.quote.details.liquidity!), 'liquidity is the u128 at 24, below 2^64')
  assert.deepEqual(proof!.patches.map(p => [p.dataOffset, p.mode]), [[24, 1], [tokenIsA ? 40 : 48, 0], [tokenIsA ? 48 : 40, 1]])
})

test('CLMM deposit refuses a pool that is not token/SOL or has opening disabled', async () => {
  await assert.rejects(newClmmDeposit(fakeChain({ tokenIsA: true, mintB: Keypair.generate().publicKey.toBase58() }), input), /does not pair this token with SOL/)
  await assert.rejects(newClmmDeposit(fakeChain({ tokenIsA: false, status: 1 }), input), /opening positions disabled/)
})
