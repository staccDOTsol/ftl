// A new Orca Whirlpool position and its deposit, built here instead of by the
// liquidity service so a composed zap can carry them in one transaction. An
// Orca position is an NFT: opening one needs the position mint's own key to
// sign, and the service signs with a key it keeps, which a composed
// transaction (a new message) cannot reuse. This mint key only authorises
// creating the NFT: the position belongs to the wallet (it holds the NFT)
// from then on, and the key is never stored.
//
// The NFT is the Token-2022 variant with Orca's metadata extension
// (open_position_with_token_extensions) — what Orca's current SDK and app
// open by default, and its rent all comes back when the position closes. The
// 0.22 SDK's own `openPosition` defaults to the classic Token program and
// deposits through increase_liquidity_by_token_amounts_v2, whose liquidity is
// computed on chain and so leaves no encoded liquidity to prove; the
// instructions are built one by one below instead.
import { Keypair, PublicKey, SystemProgram, type Connection } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction,
  createSyncNativeInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import BN from 'bn.js'
import { Percentage } from '@orca-so/common-sdk'
import { IGNORE_CACHE, ORCA_WHIRLPOOL_PROGRAM_ID, PDAUtil, TickArrayUtil, TickUtil, TokenExtensionUtil,
  WhirlpoolContext, WhirlpoolIx, increaseLiquidityQuoteByInputTokenWithParams } from '@orca-so/whirlpools-sdk'
import { assertPoolOwner } from './direct-adapter.ts'
import { debit, rawInstructions, type VenueDepositBuilder } from './venue-deposit.ts'

const integer = (value: { toString(): string }): bigint => BigInt(value.toString())
/** Ticks per unit of ln(price): each tick is a 0.01% price step. */
const TICKS_PER_LN = 1 / Math.log(1.0001)

/** The position's ticks. Full range when asked for, or when the pool allows
 * nothing else (splash pools, spacing ≥ 32768). Otherwise `rangeWidthPct` w
 * spans price/(1+w) to price·(1+w) around the current tick — 100 is half to
 * double — widened outward to the tick spacing and clamped to full range, so
 * the current price is always strictly inside and both sides deposit. */
export function positionTicks(tickCurrentIndex: number, tickSpacing: number,
  parameters: Record<string, string | number | boolean>): { tickLowerIndex: number; tickUpperIndex: number; fullRange: boolean } {
  const [minTick, maxTick] = TickUtil.getFullRangeTickIndex(tickSpacing)
  if (parameters.fullRange === true || parameters.fullRange === 'true' || TickUtil.isFullRangeOnly(tickSpacing))
    return { tickLowerIndex: minTick, tickUpperIndex: maxTick, fullRange: true }
  const width = Number(parameters.rangeWidthPct ?? 100)
  if (!Number.isFinite(width) || width <= 0) throw new Error('Orca rangeWidthPct must be a positive number')
  const span = Math.log(1 + width / 100) * TICKS_PER_LN
  const tickLowerIndex = Math.max(minTick, Math.floor((tickCurrentIndex - span) / tickSpacing) * tickSpacing)
  const tickUpperIndex = Math.min(maxTick, Math.ceil((tickCurrentIndex + span) / tickSpacing) * tickSpacing)
  if (tickLowerIndex >= tickUpperIndex) throw new Error('Orca position range is empty at this tick spacing')
  return { tickLowerIndex, tickUpperIndex, fullRange: tickLowerIndex === minTick && tickUpperIndex === maxTick }
}

/** A new position across the range `parameters` names, with a deposit sized
 * by the SDK's increase-liquidity quote: the liquidity `tokenAmount` buys,
 * unless its SOL maximum (slippage included) would pass `solAmount`, in which
 * case the liquidity whose SOL maximum fits `solAmount`. That maximum is
 * wrapped up front and the wrapped-SOL account is closed afterwards, so
 * nothing beyond `solAmount` ever leaves the wallet's SOL for the deposit.
 *
 * The quote has the liquidity service's shape so the composed assembly proves
 * it the same way: `details.liquidity` is the u128 increase_liquidity_v2
 * encodes (below 2^64, so its low 8 bytes are the located u64), and each
 * debit's `limitRaw` is the maximum it encodes for that side. The token
 * debit's `expectedRaw` is `tokenAmount` — the delta the composer rescales
 * from — so at exactly that delta the patched instruction is the one built
 * here; the SDK's own token estimate is `details.tokenEstimateRaw`. */
export const newOrcaDeposit: VenueDepositBuilder = async (connection: Connection, input) => {
  const address = new PublicKey(input.pool), owner = new PublicKey(input.owner)
  if (input.tokenAmount <= 0n || input.solAmount <= 0n) throw new Error('Orca deposit needs both a token and a SOL amount')
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps >= 10_000)
    throw new Error('Orca deposit slippage must be whole basis points below 100%')
  await assertPoolOwner(connection, address, ORCA_WHIRLPOOL_PROGRAM_ID)
  // As in direct-orca.ts: the context wallet only reads; the wallet's own key
  // is passed to the builders, and no server key ever signs or sends.
  const readonlyWallet = {
    publicKey: PublicKey.default,
    signTransaction: async () => { throw new Error('Server cannot sign') },
    signAllTransactions: async () => { throw new Error('Server cannot sign') },
  }
  const ctx = WhirlpoolContext.from(connection, readonlyWallet as any)
  const pool = await ctx.fetcher.getPool(address, IGNORE_CACHE)
  if (!pool) throw new Error('Orca Whirlpool not found')
  const sol = NATIVE_MINT.toBase58(), a = pool.tokenMintA.toBase58(), b = pool.tokenMintB.toBase58()
  const tokenIsA = a === input.tokenMint
  if (!(tokenIsA ? b === sol : a === sol && b === input.tokenMint)) throw new Error('Orca Whirlpool does not pair this token with SOL')

  const { tickLowerIndex, tickUpperIndex, fullRange } = positionTicks(pool.tickCurrentIndex, pool.tickSpacing, input.parameters)
  // Token programs, transfer fees (Token-2022) and the epoch they apply in.
  const tokenExtensionCtx = await TokenExtensionUtil.buildTokenExtensionContext(ctx.fetcher, pool, IGNORE_CACHE)
  const slippageTolerance = Percentage.fromFraction(input.slippageBps, 10_000)
  const quoteBy = (mint: PublicKey, amount: bigint) => increaseLiquidityQuoteByInputTokenWithParams({
    inputTokenMint: mint, inputTokenAmount: new BN(amount.toString()), tokenMintA: pool.tokenMintA, tokenMintB: pool.tokenMintB,
    tickCurrentIndex: pool.tickCurrentIndex, sqrtPrice: pool.sqrtPrice, tickLowerIndex, tickUpperIndex, tokenExtensionCtx, slippageTolerance })
  const solMaxOf = (q: ReturnType<typeof quoteBy>) => integer(tokenIsA ? q.tokenMaxB : q.tokenMaxA)
  let quote = quoteBy(new PublicKey(input.tokenMint), input.tokenAmount)
  // The SDK's maximum is the estimate plus slippage (rounded down), so a SOL
  // input of solAmount/(1+slippage) keeps the SOL maximum within solAmount.
  if (solMaxOf(quote) > input.solAmount) quote = quoteBy(NATIVE_MINT, input.solAmount * 10_000n / BigInt(10_000 + input.slippageBps))
  const liquidity = integer(quote.liquidityAmount)
  const tokenEstimate = integer(tokenIsA ? quote.tokenEstA : quote.tokenEstB), tokenMax = integer(tokenIsA ? quote.tokenMaxA : quote.tokenMaxB)
  const solEstimate = integer(tokenIsA ? quote.tokenEstB : quote.tokenEstA), solMax = solMaxOf(quote)
  if (liquidity <= 0n || tokenEstimate <= 0n || solEstimate <= 0n) throw new Error('Orca deposit is too small for this range')
  if (solMax > input.solAmount || tokenEstimate > input.tokenAmount) throw new Error('Orca deposit quote exceeds the amounts given')

  const positionMint = Keypair.generate()
  const positionPda = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, positionMint.publicKey)
  const positionTokenAccount = getAssociatedTokenAddressSync(positionMint.publicKey, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
  const programA = tokenExtensionCtx.tokenMintWithProgramA.tokenProgram, programB = tokenExtensionCtx.tokenMintWithProgramB.tokenProgram
  const ataA = getAssociatedTokenAddressSync(pool.tokenMintA, owner, false, programA, ASSOCIATED_TOKEN_PROGRAM_ID)
  const ataB = getAssociatedTokenAddressSync(pool.tokenMintB, owner, false, programB, ASSOCIATED_TOKEN_PROGRAM_ID)
  const wsolAta = tokenIsA ? ataB : ataA
  if (!(tokenIsA ? programB : programA).equals(TOKEN_PROGRAM_ID)) throw new Error('Orca Whirlpool wrapped SOL is not a classic token mint')

  // Both tick arrays must exist before liquidity lands in them. Missing ones
  // are created as dynamic arrays (the SDK's default, cheaper rent) and
  // idempotently, so one created by someone else meanwhile is no failure.
  const missing = await TickArrayUtil.getUninitializedArraysPDAs([tickLowerIndex, tickUpperIndex],
    ORCA_WHIRLPOOL_PROGRAM_ID, address, pool.tickSpacing, ctx.fetcher, IGNORE_CACHE)
  const tickArrays = missing.flatMap(({ startIndex, pda }) => WhirlpoolIx.initDynamicTickArrayIx(ctx.program,
    { whirlpool: address, tickArrayPda: pda, startTick: startIndex, funder: owner, idempotent: true }).instructions)
  const open = WhirlpoolIx.openPositionWithTokenExtensionsIx(ctx.program, { whirlpool: address, owner, funder: owner,
    positionPda, positionMint: positionMint.publicKey, positionTokenAccount, tickLowerIndex, tickUpperIndex,
    withTokenMetadataExtension: true })
  // The wallet's accounts for both sides (idempotent, so the swap's own create
  // dedupes or no-ops) and the SOL side wrapped to its maximum.
  const accounts = [
    createAssociatedTokenAccountIdempotentInstruction(owner, ataA, owner, pool.tokenMintA, programA, ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(owner, ataB, owner, pool.tokenMintB, programB, ASSOCIATED_TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsolAta, lamports: solMax }),
    createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM_ID),
  ]
  const tickArrayLower = PDAUtil.getTickArrayFromTickIndex(tickLowerIndex, pool.tickSpacing, address, ORCA_WHIRLPOOL_PROGRAM_ID).publicKey
  const tickArrayUpper = PDAUtil.getTickArrayFromTickIndex(tickUpperIndex, pool.tickSpacing, address, ORCA_WHIRLPOOL_PROGRAM_ID).publicKey
  // v2 takes either token program for each side, transfer fees and hooks.
  const hooks = await TokenExtensionUtil.getExtraAccountMetasForTransferHookForPool(connection, tokenExtensionCtx,
    ataA, pool.tokenVaultA, owner, ataB, pool.tokenVaultB, owner)
  const increase = WhirlpoolIx.increaseLiquidityV2Ix(ctx.program, { whirlpool: address, position: positionPda.publicKey,
    positionTokenAccount, positionAuthority: owner, tokenMintA: pool.tokenMintA, tokenMintB: pool.tokenMintB,
    tokenOwnerAccountA: ataA, tokenOwnerAccountB: ataB, tokenVaultA: pool.tokenVaultA, tokenVaultB: pool.tokenVaultB,
    tokenProgramA: programA, tokenProgramB: programB, tickArrayLower, tickArrayUpper, ...hooks,
    liquidityAmount: quote.liquidityAmount, tokenMaxA: quote.tokenMaxA, tokenMaxB: quote.tokenMaxB })
  // Leftover wrapped SOL goes back as SOL; the same close the swap's own
  // cleanup carries, so the composed assembly hoists it once.
  const unwrap = createCloseAccountInstruction(wsolAta, owner, owner, [], TOKEN_PROGRAM_ID)

  return {
    instructions: rawInstructions([...tickArrays, ...open.instructions, ...accounts, ...increase.instructions, unwrap]),
    signers: [positionMint], position: positionPda.publicKey.toBase58(),
    quote: { amounts: [debit(input.tokenMint, input.tokenAmount, tokenMax), debit(sol, solEstimate, solMax)],
      details: { liquidity: liquidity.toString(), tokenEstimateRaw: tokenEstimate.toString(), tickLowerIndex, tickUpperIndex,
        fullRange, positionMint: positionMint.publicKey.toBase58(), positionTokenProgram: TOKEN_2022_PROGRAM_ID.toBase58() } },
  }
}
