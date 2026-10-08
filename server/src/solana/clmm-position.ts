// A new Raydium CLMM position and its deposit, built here instead of by the
// liquidity service so a composed zap can carry them in one transaction.
// Raydium CLMM positions are NFTs: opening one creates the NFT mint, and that
// mint's key has to sign. The service signs with a mint key it generates and
// keeps, and a composed transaction is a new message that signature does not
// cover. This key only authorises creating the mint: the NFT, and so the
// position, belongs to the wallet from then on, and the key is never stored.
import { createHash } from 'node:crypto'
import { Keypair, PublicKey, type Connection } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync, getTransferFeeConfig, unpackMint } from '@solana/spl-token'
import { CLMM_PROGRAM_ID, ClmmInstrument, LiquidityMathUtil, PoolInfoLayout, TickArrayUtil, TickUtil,
  createWSolAccountInstructions, type ClmmKeys } from '@raydium-io/raydium-sdk-v2'
import BN from 'bn.js'
import { debit, rawInstructions, type VenueDepositBuilder } from './venue-deposit.ts'

const U64_MAX = (1n << 64n) - 1n
const big = (value: { toString(): string }) => BigInt(value.toString())
// Anchor discriminator of `open_position_with_token22_nft`, whose data is
// tick_lower i32, tick_upper i32, both tick-array starts i32, liquidity u128,
// amount_0_max u64, amount_1_max u64, with_metadata bool, base_flag Option<bool>.
const OPEN_POSITION = createHash('sha256').update('global:open_position_with_token22_nft').digest().subarray(0, 8)

/** The tick range ±`rangeWidthPct` around the current tick, in price terms
 * ×/÷ (1 + width): 100% is half to double the current price, the same either
 * way round the pair is quoted, so a balanced zap's two halves fit it. Each
 * end is aligned outward to the tick spacing and kept inside the tick bounds. */
export function clmmTickRange(tickCurrent: number, tickSpacing: number, rangeWidthPct: number): { tickLower: number; tickUpper: number } {
  if (!Number.isFinite(rangeWidthPct) || rangeWidthPct <= 0) throw new Error('rangeWidthPct must be a positive number')
  const offset = Math.max(1, Math.round(Math.log1p(rangeWidthPct / 100) / Math.log(1.0001)))
  return { tickLower: Math.max(TickArrayUtil.getMinTick(tickSpacing), Math.floor((tickCurrent - offset) / tickSpacing) * tickSpacing),
    tickUpper: Math.min(TickArrayUtil.getMaxTick(tickSpacing), Math.ceil((tickCurrent + offset) / tickSpacing) * tickSpacing) }
}

/** A position of `tokenAmount` and `solAmount` across `rangeWidthPct` (100 by
 * default) around the current price, into a new position NFT the wallet owns.
 * Liquidity is sized at the current price from both amounts less the
 * slippage share, and each side's maximum is the amount itself, so the
 * deposit tolerates that much drift on either side. The token debit's
 * expected amount is `tokenAmount`, the swap output the composer measures:
 * it rescales the encoded liquidity by the real delta over that amount, so
 * the slippage headroom survives the patch (and about that share of the token
 * stays in the wallet). SOL is wrapped into a temporary account funded to its
 * maximum and closed afterwards, as the Raydium SDK wraps for this
 * instruction: the wallet's own WSOL account, which the swap ahead of it in a
 * composed zap wraps into and may close, is left alone, and whatever SOL the
 * deposit does not take comes back as SOL. */
export const newClmmDeposit: VenueDepositBuilder = async (connection: Connection, input) => {
  const { tokenAmount, solAmount, slippageBps } = input
  if (tokenAmount <= 0n || solAmount <= 0n || tokenAmount > U64_MAX || solAmount > U64_MAX) throw new Error('CLMM deposit amounts must be positive u64 values')
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) throw new Error('slippageBps must be an integer below 10000')
  const owner = new PublicKey(input.owner), poolId = new PublicKey(input.pool), tokenMint = new PublicKey(input.tokenMint)
  // Two RPC requests in parallel: the pool and token mint, and the rent the temporary WSOL account needs.
  const [[poolAccount, mintAccount], wsol] = await Promise.all([
    connection.getMultipleAccountsInfo([poolId, tokenMint], 'confirmed'),
    createWSolAccountInstructions({ connection, owner, payer: owner, amount: solAmount.toString(), commitment: 'confirmed' }),
  ])
  if (!poolAccount?.owner.equals(CLMM_PROGRAM_ID) || poolAccount.data.length < PoolInfoLayout.span) throw new Error('Not a Raydium CLMM pool')
  const pool = PoolInfoLayout.decode(poolAccount.data)
  const sol = NATIVE_MINT.toBase58(), tokenIsA = pool.mintA.equals(tokenMint)
  if (!(tokenIsA ? pool.mintB.toBase58() === sol : pool.mintA.toBase58() === sol && pool.mintB.equals(tokenMint)))
    throw new Error('Raydium CLMM pool does not pair this token with SOL')
  if (pool.status & 1) throw new Error('This Raydium CLMM pool has opening positions disabled')
  const tokenProgram = mintAccount?.owner
  if (!tokenProgram || !(tokenProgram.equals(TOKEN_PROGRAM_ID) || tokenProgram.equals(TOKEN_2022_PROGRAM_ID))) throw new Error('Token mint is not an SPL mint')
  // The token maximum is the amount that arrives; a transfer fee on top of it would breach it.
  const fee = tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? getTransferFeeConfig(unpackMint(tokenMint, mintAccount, tokenProgram)) : null
  if (fee && (fee.olderTransferFee.transferFeeBasisPoints || fee.newerTransferFee.transferFeeBasisPoints)) throw new Error('Token-2022 transfer-fee tokens are not supported for CLMM deposits')

  const rangeWidthPct = Number(input.parameters?.rangeWidthPct ?? 100)
  const { tickLower, tickUpper } = clmmTickRange(pool.tickCurrent, pool.tickSpacing, rangeWidthPct)
  const sqrtLower = TickUtil.getSqrtPriceAtTick(tickLower), sqrtUpper = TickUtil.getSqrtPriceAtTick(tickUpper)
  const [maxA, maxB] = tokenIsA ? [tokenAmount, solAmount] : [solAmount, tokenAmount]
  const sized = (max: bigint) => new BN((max * 10_000n / (10_000n + BigInt(slippageBps))).toString())
  const liquidity = LiquidityMathUtil.getLiquidityFromAmounts(pool.sqrtPriceX64, sqrtLower, sqrtUpper, sized(maxA), sized(maxB))
  // proveVenueAdd finds the liquidity by its low eight bytes, so it has to fit them.
  if (liquidity.isZero() || big(liquidity) > U64_MAX) throw new Error('CLMM deposit liquidity is zero or beyond u64')
  const needed = LiquidityMathUtil.getAmountsForLiquidity(pool.sqrtPriceX64, sqrtLower, sqrtUpper, liquidity, true)
  const [neededA, neededB] = [big(needed.amountA), big(needed.amountB)]
  if (neededA > maxA || neededB > maxB) throw new Error('CLMM deposit needs more than the amounts given')

  const nftMint = Keypair.generate()
  const tokenAccount = getAssociatedTokenAddressSync(tokenMint, owner, false, tokenProgram)
  const solAccount = wsol.addresses.newAccount
  const poolInfo = { id: poolId.toBase58(), programId: CLMM_PROGRAM_ID.toBase58(),
    mintA: { address: pool.mintA.toBase58(), programId: (tokenIsA ? tokenProgram : TOKEN_PROGRAM_ID).toBase58(), decimals: pool.mintDecimalsA },
    mintB: { address: pool.mintB.toBase58(), programId: (tokenIsA ? TOKEN_PROGRAM_ID : tokenProgram).toBase58(), decimals: pool.mintDecimalsB },
    config: { id: pool.configId.toBase58(), tickSpacing: pool.tickSpacing } }
  // The instruction reads only the vaults and mints from the pool keys.
  const poolKeys = { vault: { A: pool.vaultA.toBase58(), B: pool.vaultB.toBase58() },
    mintA: { address: poolInfo.mintA.address }, mintB: { address: poolInfo.mintB.address } } as unknown as ClmmKeys
  // A Token-2022 position NFT; the instruction creates its account and any missing tick array itself.
  const open = await ClmmInstrument.openPositionFromLiquidityInstructions({ poolInfo, poolKeys, tickLower, tickUpper, liquidity,
    ownerInfo: { wallet: owner, tokenAccountA: tokenIsA ? tokenAccount : solAccount, tokenAccountB: tokenIsA ? solAccount : tokenAccount },
    amountMaxA: new BN(maxA.toString()), amountMaxB: new BN(maxB.toString()), base: null, withMetadata: 'create', nft2022: true,
    getEphemeralSigners: async () => [nftMint.publicKey] })
  if (open.signers.length || open.instructions.length !== 1 || !open.address.nftMint.equals(nftMint.publicKey)) throw new Error('CLMM open position used an unexpected signer')
  // Read back what the instruction encodes: the quote must carry exactly these values.
  const data = Buffer.from(open.instructions[0].data)
  if (!data.subarray(0, 8).equals(OPEN_POSITION) || data.length !== 59 || big(liquidity) !==
    (data.readBigUInt64LE(24) | data.readBigUInt64LE(32) << 64n) || data.readBigUInt64LE(40) !== maxA || data.readBigUInt64LE(48) !== maxB)
    throw new Error('CLMM open position instruction does not encode the quoted amounts')

  return { instructions: rawInstructions([createAssociatedTokenAccountIdempotentInstruction(owner, tokenAccount, owner, tokenMint, tokenProgram),
    ...wsol.instructions ?? [], ...open.instructions, ...wsol.endInstructions ?? []]),
  signers: [nftMint], position: open.address.personalPosition.toBase58(),
  quote: { amounts: [debit(input.tokenMint, tokenAmount, tokenAmount), debit(sol, tokenIsA ? neededB : neededA, solAmount)],
    details: { liquidity: liquidity.toString(), tickLower, tickUpper, rangeWidthPct, nftMint: nftMint.publicKey.toBase58() } } }
}
