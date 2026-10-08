// Orca Whirlpool exact-in adapter. Pool state and initialized tick arrays
// come directly from FTL's configured RPC, never an Orca route API.
import { PublicKey, type Connection } from '@solana/web3.js'
import BN from 'bn.js'
import { Percentage } from '@orca-so/common-sdk'
import { ORCA_WHIRLPOOL_PROGRAM_ID, WhirlpoolContext, buildWhirlpoolClient,
  swapQuoteByInputToken, SwapUtils, WhirlpoolIx, IGNORE_CACHE } from '@orca-so/whirlpools-sdk'
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import { assertClassicMints, assertPoolOwner, checkedPrice, DirectVenueError,
  exactAmount, mintAta, nativeUnwrapInstructions, nativeWrapInstructions,
  pairIsExact, venueLeg, type DirectIntent, type DirectPool, type DirectPrice } from './direct-adapter.ts'

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
  await assertClassicMints(connection, data.tokenMintA, data.tokenMintB)
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
    const inputAta = mintAta(wallet, new PublicKey(intent.inputMint))
    const outputAta = mintAta(wallet, new PublicKey(intent.outputMint))
    const params = SwapUtils.getSwapParamsFromQuote({ ...quote,
      otherAmountThreshold: new BN(protectedMinimum.toString()) }, ctx, whirlpool,
    inputAta, outputAta, wallet)
    const ix = WhirlpoolIx.swapIx(ctx.program, params)
    if (ix.signers.length) throw new DirectVenueError('Whirlpool requires an unexpected server signer')
    const inputCreate = createAssociatedTokenAccountIdempotentInstruction(wallet,
      inputAta, wallet, new PublicKey(intent.inputMint))
    const outputCreate = createAssociatedTokenAccountIdempotentInstruction(wallet,
      outputAta, wallet, new PublicKey(intent.outputMint))
    const wrap = await nativeWrapInstructions(connection, wallet, intent.inputMint, amount, intent.keepNative)
    const unwrap = await nativeUnwrapInstructions(connection, wallet, intent.outputMint, intent.keepNative)
    // Whirlpool `swap`: discriminator, amount u64, other_amount_threshold u64,
    // sqrt_price_limit u128, flags. The offsets are proven from the built data.
    return venueLeg([inputCreate, outputCreate, ...wrap, ...ix.instructions, ...ix.cleanupInstructions, ...unwrap],
      ORCA_WHIRLPOOL_PROGRAM_ID, amount, protectedMinimum, inputAta, outputAta)
  })
}
