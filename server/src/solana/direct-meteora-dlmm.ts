// Meteora DLMM exact-in adapter. All pool/bin/clock data comes from the
// configured Solana RPC; Meteora's HTTP route and transaction APIs are unused.
import type { Connection, Transaction } from '@solana/web3.js'
import { PublicKey } from '@solana/web3.js'
import { createRequire } from 'node:module'
import type { BinArrayAccount, SwapQuote } from '@meteora-ag/dlmm'
import BN from 'bn.js'
import { assertClassicMints, assertPoolOwner, checkedPrice, DirectVenueError,
  exactAmount, nativeUnwrapInstructions, nativeWrapInstructions, pairIsExact,
  type DirectIntent, type DirectPool, type DirectPrice } from './direct-adapter.ts'

const PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo')
const integer = (value: { toString(): string }): bigint => BigInt(value.toString())
// The published ESM entrypoint currently imports an Anchor directory path,
// which Node's ESM resolver rejects. The package's own CJS entry exports the
// same official class and is usable from this ESM service.
type DlmmPool = {
  pubkey: PublicKey; tokenX: { publicKey: PublicKey }; tokenY: { publicKey: PublicKey }
  getBinArrayForSwap: (forY: boolean, count: number) => Promise<BinArrayAccount[]>
  swapQuote: (amount: BN, forY: boolean, bps: BN, arrays: BinArrayAccount[], partial: boolean) => SwapQuote
  isSwapDisabled: (wallet: PublicKey) => boolean
  swap: (params: { inToken: PublicKey; outToken: PublicKey; inAmount: BN;
    minOutAmount: BN; lbPair: PublicKey; user: PublicKey;
    binArraysPubkey: PublicKey[] }) => Promise<Transaction>
}
const DLMM = createRequire(import.meta.url)('@meteora-ag/dlmm') as {
  create: (connection: Connection, address: PublicKey, options: {
    cluster: 'mainnet-beta'; skipSolWrappingOperation: true }) => Promise<DlmmPool>
}

export async function quoteMeteoraDlmm(connection: Connection, row: DirectPool,
  intent: DirectIntent): Promise<DirectPrice> {
  if (row.venue !== 'meteora-dlmm') throw new DirectVenueError('Wrong direct venue')
  const amount = exactAmount(intent)
  const address = new PublicKey(row.address)
  await assertPoolOwner(connection, address, PROGRAM)
  // Skipping SDK SOL wrapping ensures the returned transaction needs only the
  // wallet signer. Native SOL is wrapped into the wallet ATA below when needed.
  const pool = await DLMM.create(connection, address,
    { cluster: 'mainnet-beta', skipSolWrappingOperation: true })
  const mintX = pool.tokenX.publicKey, mintY = pool.tokenY.publicKey
  if (!pairIsExact(row, intent, mintX, mintY))
    throw new DirectVenueError('FTL pool mints do not match DLMM chain state')
  await assertClassicMints(connection, mintX, mintY)
  const xToY = intent.inputMint === mintX.toBase58()
  // Read initialized bins in the execution direction, including the active
  // bin. The official SDK accounts for the dynamic fee and bin traversal.
  const arrays = await pool.getBinArrayForSwap(xToY, 8)
  const quote = pool.swapQuote(new BN(amount.toString()), xToY,
    new BN(intent.slippageBps), arrays, false)
  const consumed = integer(quote.consumedInAmount)
  if (consumed !== amount)
    throw new DirectVenueError('DLMM quote cannot consume the full exact-in amount')
  const out = integer(quote.outAmount), minimum = integer(quote.minOutAmount)
  const fee = integer(quote.fee)
  const feeMint = quote.feeOnInput ? intent.inputMint : intent.outputMint
  return checkedPrice(out, minimum, fee, feeMint, async (wallet, protectedMinimum) => {
    if (pool.isSwapDisabled(wallet)) throw new DirectVenueError('DLMM pool swap is disabled')
    const transaction = await pool.swap({
      inToken: xToY ? mintX : mintY, outToken: xToY ? mintY : mintX,
      inAmount: new BN(amount.toString()), minOutAmount: new BN(protectedMinimum.toString()),
      lbPair: pool.pubkey, user: wallet, binArraysPubkey: quote.binArraysPubkey,
    })
    const wrap = await nativeWrapInstructions(connection, wallet, intent.inputMint, amount)
    const unwrap = await nativeUnwrapInstructions(connection, wallet, intent.outputMint)
    return [...wrap, ...transaction.instructions, ...unwrap]
  })
}
