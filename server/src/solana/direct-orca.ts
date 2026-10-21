// Orca Whirlpool exact-in adapter. Pool state and initialized tick arrays
// come directly from FTL's configured RPC, never an Orca route API.
import { PublicKey, type Connection } from '@solana/web3.js'
import BN from 'bn.js'
import { Percentage } from '@orca-so/common-sdk'
import { ORCA_WHIRLPOOL_PROGRAM_ID, WhirlpoolContext, buildWhirlpoolClient,
  swapQuoteByInputToken, SwapUtils, WhirlpoolIx, IGNORE_CACHE } from '@orca-so/whirlpools-sdk'
import { createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { assertPoolOwner, checkedPrice, DirectVenueError, exactAmount, mintAta,
  nativeUnwrapInstructions, nativeWrapInstructions, pairIsExact, programOf, swapMints, venueLeg,
  type DirectIntent, type DirectPool, type DirectPrice } from './direct-adapter.ts'

const integer = (value: { toString(): string }): bigint => BigInt(value.toString())

export async function quoteOrcaWhirlpool(connection: Connection, row: DirectPool,
  intent: DirectIntent): Promise<DirectPrice> {
  if (row.venue !== 'orca') throw new DirectVenueError('Wrong direct venue')
  const amount = exactAmount(intent), address = new PublicKey(row.address)
  await assertPoolOwner(connection, address, ORCA_WHIRLPOOL_PROGRAM_ID)
  // The context wallet is used only to fetch/quote. The instruction builder
  // receives the actual wallet PublicKey; no server key ever signs or sends.
  const readonlyWallet = {
    publicKey: PublicKey.default,
    signTransaction: async () => { throw new DirectVenueError('Server cannot sign') },
    signAllTransactions: async () => { throw new DirectVenueError('Server cannot sign') },
  }
  const ctx = WhirlpoolContext.from(connection, readonlyWallet)
  const whirlpool = await buildWhirlpoolClient(ctx).getPool(address, IGNORE_CACHE)
  const data = whirlpool.getData()
  if (!pairIsExact(row, intent, data.tokenMintA, data.tokenMintB))
    throw new DirectVenueError('FTL pool mints do not match Whirlpool chain state')
  // Classic SPL, or Token-2022 with only benign extensions. A pool with a
  // Token-2022 side swaps through `swap_v2`, which names both token programs.
  const mints = await swapMints(connection, data.tokenMintA, data.tokenMintB)
  const [programA, programB] = [mints[0].tokenProgram, mints[1].tokenProgram]
  const classic = programA.equals(TOKEN_PROGRAM_ID) && programB.equals(TOKEN_PROGRAM_ID)
  const inputProgram = programOf(mints, intent.inputMint), outputProgram = programOf(mints, intent.outputMint)
  if (integer(whirlpool.getTokenVaultAInfo().amount) <= 0n ||
    integer(whirlpool.getTokenVaultBInfo().amount) <= 0n)
    throw new DirectVenueError('Whirlpool has no swap reserves')
  const quote = await swapQuoteByInputToken(whirlpool, new PublicKey(intent.inputMint),
    new BN(amount.toString()), Percentage.fromFraction(intent.slippageBps, 10_000),
    ctx.program.programId, ctx.fetcher, IGNORE_CACHE)
  if (integer(quote.estimatedAmountIn) !== amount)
    throw new DirectVenueError('Whirlpool quote cannot consume the full exact-in amount')
  const out = integer(quote.estimatedAmountOut)
  const minimum = integer(quote.otherAmountThreshold)
  const fee = integer(quote.estimatedFeeAmount)
  return checkedPrice(out, minimum, fee, intent.inputMint, async (wallet, protectedMinimum) => {
    const inputAta = mintAta(wallet, new PublicKey(intent.inputMint), inputProgram)
    const outputAta = mintAta(wallet, new PublicKey(intent.outputMint), outputProgram)
    const params = SwapUtils.getSwapParamsFromQuote({ ...quote,
      otherAmountThreshold: new BN(protectedMinimum.toString()) }, ctx, whirlpool,
    inputAta, outputAta, wallet)
    // No transfer-hook accounts: a mint with a hook program never gets here.
    const ix = classic ? WhirlpoolIx.swapIx(ctx.program, params)
      : WhirlpoolIx.swapV2Ix(ctx.program, { ...params, tokenMintA: data.tokenMintA,
        tokenMintB: data.tokenMintB, tokenProgramA: programA, tokenProgramB: programB })
    if (ix.signers.length) throw new DirectVenueError('Whirlpool requires an unexpected server signer')
    const inputCreate = createAssociatedTokenAccountIdempotentInstruction(wallet,
      inputAta, wallet, new PublicKey(intent.inputMint), inputProgram)
    const outputCreate = createAssociatedTokenAccountIdempotentInstruction(wallet,
      outputAta, wallet, new PublicKey(intent.outputMint), outputProgram)
    const wrap = await nativeWrapInstructions(connection, wallet, intent.inputMint, amount, intent.keepNative)
    const unwrap = await nativeUnwrapInstructions(connection, wallet, intent.outputMint, intent.keepNative)
    // Whirlpool `swap`: discriminator, amount u64, other_amount_threshold u64,
    // sqrt_price_limit u128, flags. The offsets are proven from the built data.
    return venueLeg([inputCreate, outputCreate, ...wrap, ...ix.instructions, ...ix.cleanupInstructions, ...unwrap],
      ORCA_WHIRLPOOL_PROGRAM_ID, amount, protectedMinimum, inputAta, outputAta, outputProgram)
  })
}
