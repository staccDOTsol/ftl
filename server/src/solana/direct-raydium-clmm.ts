// Raydium CLMM exact-in adapter using current on-chain pool/tick state and
// the official SDK's local swap simulator and instruction constructor.
import { PublicKey, SYSVAR_CLOCK_PUBKEY, type Connection } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { CLMM_PROGRAM_ID, ClmmInstrument, Raydium, TickArrayBitmapExtensionLayout,
  getPdaExBitmapAccount, swapInternal } from '@raydium-io/raydium-sdk-v2'
import BN from 'bn.js'
import { assertClassicMints, assertPoolOwner, checkedPrice, DirectVenueError,
  exactAmount, mintAta, nativeUnwrapInstructions, nativeWrapInstructions,
  pairIsExact, venueLeg, type DirectIntent, type DirectPool, type DirectPrice } from './direct-adapter.ts'

const PROGRAM = CLMM_PROGRAM_ID
const integer = (value: { toString(): string }): bigint => BigInt(value.toString())

export async function quoteRaydiumClmm(connection: Connection, row: DirectPool,
  intent: DirectIntent): Promise<DirectPrice> {
  if (row.venue !== 'raydium-clmm') throw new DirectVenueError('Wrong direct venue')
  const amount = exactAmount(intent), address = new PublicKey(row.address)
  await assertPoolOwner(connection, address, PROGRAM)
  const raydium = await Raydium.load({ connection, cluster: 'mainnet',
    owner: PublicKey.default, disableFeatureCheck: true, disableLoadToken: true })
  const first = await raydium.clmm.getSimplePoolInfo(row.address)
  const mintA = new PublicKey(first.poolInfo.mintA.address)
  const mintB = new PublicKey(first.poolInfo.mintB.address)
  if (first.poolInfo.programId !== PROGRAM.toBase58() ||
    !pairIsExact(row, intent, mintA, mintB) || !first.rpcData.programId.equals(PROGRAM))
    throw new DirectVenueError('FTL pool mints or owner do not match Raydium CLMM chain state')
  await assertClassicMints(connection, mintA, mintB)
  const zeroForOne = intent.inputMint === mintA.toBase58()
  const { poolInfo, rpcData, configInfo, tickArrays } = await raydium.clmm.getSwapPoolInfo(row.address, zeroForOne)
  if (!pairIsExact(row, intent, new PublicKey(poolInfo.mintA.address),
    new PublicKey(poolInfo.mintB.address)) || !rpcData.liquidity.gtn(0) || !tickArrays.length)
    throw new DirectVenueError('CLMM has no validated swap liquidity or tick arrays')
  const [vaultA, vaultB] = [rpcData.vaultA, rpcData.vaultB]
  const [vaultAInfo, vaultBInfo] = await connection.getMultipleAccountsInfo([vaultA, vaultB], 'confirmed')
  if (!vaultAInfo?.owner.equals(TOKEN_PROGRAM_ID) || !vaultBInfo?.owner.equals(TOKEN_PROGRAM_ID) ||
    vaultAInfo.data.length < 72 || vaultBInfo.data.length < 72 ||
    !new PublicKey(vaultAInfo.data.subarray(0, 32)).equals(mintA) ||
    !new PublicKey(vaultBInfo.data.subarray(0, 32)).equals(mintB))
    throw new DirectVenueError('CLMM vault owner or mint does not match chain state')
  const bitmapAddress = getPdaExBitmapAccount(PROGRAM, address).publicKey
  const bitmapInfo = await connection.getAccountInfo(bitmapAddress, 'confirmed')
  if (bitmapInfo && !bitmapInfo.owner.equals(PROGRAM))
    throw new DirectVenueError('CLMM tick bitmap owner does not match venue program')
  // An unallocated extension means every out-of-range bitmap bit is zero.
  const bitmap = TickArrayBitmapExtensionLayout.decode(bitmapInfo?.data ??
    Buffer.alloc(TickArrayBitmapExtensionLayout.span))
  // The on-chain Clock sysvar is available even when an RPC cannot answer
  // getBlockTime for its latest confirmed slot. Reject a stale clock because
  // CLMM dynamic fees depend on this timestamp.
  const clock = await connection.getAccountInfoAndContext(SYSVAR_CLOCK_PUBKEY, 'confirmed')
  if (!clock.value || clock.value.data.length < 40)
    throw new DirectVenueError('Current Solana clock is unavailable for CLMM fees')
  const clockSlot = clock.value.data.readBigUInt64LE(0)
  const blockTime = clock.value.data.readBigInt64LE(32)
  if (clockSlot > BigInt(clock.context.slot) ||
    BigInt(clock.context.slot) - clockSlot > 32n ||
    blockTime <= 0n || blockTime > BigInt(Number.MAX_SAFE_INTEGER))
    throw new DirectVenueError('Current Solana clock is stale or invalid')
  const blockTimestamp = Number(blockTime)
  const simulation = swapInternal({ programId: PROGRAM, poolId: address,
    poolInfo: rpcData, configInfo, tickArrays, tickarrayBitmapExtension: bitmap,
    amountSpecified: new BN(amount.toString()), sqrtPriceLimitX64: new BN(0),
    zeroForOne, isBaseInput: true, blockTimestamp, includeExtraTickArrays: true })
  if (!simulation.allTrade || !simulation.amountSpecifiedRemaining.isZero())
    throw new DirectVenueError('CLMM cannot consume the full exact-in amount')
  const out = integer(simulation.amountCalculated)
  const minimum = out * BigInt(10_000 - intent.slippageBps) / 10_000n
  const fee = integer(simulation.feeAmount)
  return checkedPrice(out, minimum, fee, intent.inputMint, async (wallet, protectedMinimum) => {
    const inputMint = new PublicKey(intent.inputMint), outputMint = new PublicKey(intent.outputMint)
    const inputAta = mintAta(wallet, inputMint), outputAta = mintAta(wallet, outputMint)
    const instructions = ClmmInstrument.makeSwapBaseInInstructions({
      poolInfo, poolKeys: { vault: { A: vaultA.toBase58(), B: vaultB.toBase58() },
        lookupTableAccount: '' },
      observationId: rpcData.observationId,
      ownerInfo: { wallet, tokenAccountA: mintAta(wallet, mintA), tokenAccountB: mintAta(wallet, mintB) },
      inputMint, amountIn: new BN(amount.toString()),
      amountOutMin: new BN(protectedMinimum.toString()), sqrtPriceLimitX64: new BN(0),
      remainingAccounts: simulation.accounts,
    })
    if (instructions.signers.length) throw new DirectVenueError('CLMM requires an unexpected server signer')
    const wrap = await nativeWrapInstructions(connection, wallet, intent.inputMint, amount, intent.keepNative)
    const unwrap = await nativeUnwrapInstructions(connection, wallet, intent.outputMint, intent.keepNative)
    // CLMM `swap_v2`: discriminator, amount u64, other_amount_threshold u64,
    // sqrt_price_limit_x64 u128, is_base_input. Offsets proven from the data.
    return venueLeg([createAssociatedTokenAccountIdempotentInstruction(wallet, inputAta, wallet, inputMint),
      createAssociatedTokenAccountIdempotentInstruction(wallet, outputAta, wallet, outputMint),
      ...wrap, ...instructions.instructions, ...unwrap], PROGRAM, amount, protectedMinimum, inputAta, outputAta)
  })
}
