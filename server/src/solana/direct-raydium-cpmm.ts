// Raydium CPMM exact-in adapter. Raydium's official SDK reads/quotes the
// current pool over our RPC; the official on-chain IDL defines the one swap
// instruction, assembled here to keep every signer on the user's wallet.
import { PublicKey, TransactionInstruction, type Connection } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { CurveCalculator, FeeOn, Raydium } from '@raydium-io/raydium-sdk-v2'
import BN from 'bn.js'
import { assertClassicMints, assertPoolOwner, checkedPrice, DirectVenueError,
  exactAmount, mintAta, nativeUnwrapInstructions, nativeWrapInstructions,
  pairIsExact, type DirectIntent, type DirectPool, type DirectPrice } from './direct-adapter.ts'

const PROGRAM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C')
const SWAP_BASE_INPUT = Buffer.from([143, 190, 90, 218, 196, 30, 51, 222])
const integer = (value: { toString(): string }): bigint => BigInt(value.toString())

export async function quoteRaydiumCpmm(connection: Connection, row: DirectPool,
  intent: DirectIntent): Promise<DirectPrice> {
  if (row.venue !== 'raydium-cpmm') throw new DirectVenueError('Wrong direct venue')
  const amount = exactAmount(intent), address = new PublicKey(row.address)
  await assertPoolOwner(connection, address, PROGRAM)
  const raydium = await Raydium.load({ connection, cluster: 'mainnet',
    owner: PublicKey.default, disableFeatureCheck: true, disableLoadToken: true })
  const { poolInfo, poolKeys, rpcData } = await raydium.cpmm.getPoolInfoFromRpc(row.address)
  const mintA = new PublicKey(poolInfo.mintA.address), mintB = new PublicKey(poolInfo.mintB.address)
  if (!pairIsExact(row, intent, mintA, mintB) || poolInfo.programId !== PROGRAM.toBase58() ||
    !rpcData.programId.equals(PROGRAM))
    throw new DirectVenueError('FTL pool mints or owner do not match Raydium chain state')
  await assertClassicMints(connection, mintA, mintB)
  if (!rpcData.configInfo || rpcData.baseReserve.isZero() || rpcData.quoteReserve.isZero())
    throw new DirectVenueError('CPMM pool configuration or swap reserves are missing')
  const baseIn = intent.inputMint === mintA.toBase58()
  const [inputVault, outputVault] = baseIn
    ? [new PublicKey(poolKeys.vault.A), new PublicKey(poolKeys.vault.B)]
    : [new PublicKey(poolKeys.vault.B), new PublicKey(poolKeys.vault.A)]
  // Validate the current vault accounts. Their first 32 bytes encode mint.
  const [inputInfo, outputInfo] = await connection.getMultipleAccountsInfo([inputVault, outputVault], 'confirmed')
  if (!inputInfo?.owner.equals(TOKEN_PROGRAM_ID) || !outputInfo?.owner.equals(TOKEN_PROGRAM_ID) ||
    inputInfo.data.length < 72 || outputInfo.data.length < 72 ||
    !new PublicKey(inputInfo.data.subarray(0, 32)).equals(new PublicKey(intent.inputMint)) ||
    !new PublicKey(outputInfo.data.subarray(0, 32)).equals(new PublicKey(intent.outputMint)))
    throw new DirectVenueError('CPMM vault owner or mint does not match chain state')
  const result = CurveCalculator.swapBaseInput(new BN(amount.toString()),
    baseIn ? rpcData.baseReserve : rpcData.quoteReserve,
    baseIn ? rpcData.quoteReserve : rpcData.baseReserve,
    rpcData.configInfo.tradeFeeRate, rpcData.configInfo.creatorFeeRate,
    rpcData.configInfo.protocolFeeRate, rpcData.configInfo.fundFeeRate,
    rpcData.feeOn === FeeOn.BothToken || rpcData.feeOn === FeeOn.OnlyTokenB)
  const out = integer(result.outputAmount)
  const minimum = out * BigInt(10_000 - intent.slippageBps) / 10_000n
  const feeOnInput = rpcData.feeOn === FeeOn.BothToken || rpcData.feeOn === FeeOn.OnlyTokenB
  // Trade fee is always paid from the input reserve. A creator fee charged
  // from output is already reflected in `outputAmount`; do not label the
  // input trade fee as though it were an output-token fee.
  const fee = integer(result.tradeFee) + (feeOnInput ? integer(result.creatorFee) : 0n)
  const feeMint = intent.inputMint
  return checkedPrice(out, minimum, fee, feeMint, async (wallet, protectedMinimum) => {
    const inputMint = new PublicKey(intent.inputMint), outputMint = new PublicKey(intent.outputMint)
    const inputAta = mintAta(wallet, inputMint), outputAta = mintAta(wallet, outputMint)
    const instructionData = Buffer.alloc(24)
    SWAP_BASE_INPUT.copy(instructionData)
    instructionData.writeBigUInt64LE(amount, 8)
    instructionData.writeBigUInt64LE(protectedMinimum, 16)
    // Account order matches Raydium's published `swap_base_input` IDL.
    const swap = new TransactionInstruction({ programId: PROGRAM, data: instructionData, keys: [
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(poolKeys.authority), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(poolKeys.config.id), isSigner: false, isWritable: false },
      { pubkey: address, isSigner: false, isWritable: true },
      { pubkey: inputAta, isSigner: false, isWritable: true },
      { pubkey: outputAta, isSigner: false, isWritable: true },
      { pubkey: inputVault, isSigner: false, isWritable: true },
      { pubkey: outputVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: inputMint, isSigner: false, isWritable: false },
      { pubkey: outputMint, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(poolKeys.observationId), isSigner: false, isWritable: true },
    ] })
    const wrap = await nativeWrapInstructions(connection, wallet, intent.inputMint, amount)
    const unwrap = await nativeUnwrapInstructions(connection, wallet, intent.outputMint)
    return [createAssociatedTokenAccountIdempotentInstruction(wallet, inputAta, wallet, inputMint),
      createAssociatedTokenAccountIdempotentInstruction(wallet, outputAta, wallet, outputMint),
      ...wrap, swap, ...unwrap]
  })
}
