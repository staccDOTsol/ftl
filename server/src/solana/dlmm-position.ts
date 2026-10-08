// A new Meteora DLMM position and its deposit, built here instead of by the
// liquidity service so a composed zap can carry them in one transaction. The
// service creates the position account with a keypair it signs with itself,
// and a composed transaction is a new message that signature does not cover.
// This keypair only authorises creating the account: the position belongs to
// the wallet (its `owner`) from then on, and the key is never stored.
import { ComputeBudgetProgram, Keypair, PublicKey, type Connection, type Transaction } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { createRequire } from 'node:module'
import BN from 'bn.js'
import type { RawInstruction } from './zap.ts'

type DlmmPool = {
  tokenX: { publicKey: PublicKey }; tokenY: { publicKey: PublicKey }
  getActiveBin: () => Promise<{ binId: number }>
  initializePositionAndAddLiquidityByStrategy: (params: { positionPubKey: PublicKey; totalXAmount: BN; totalYAmount: BN;
    strategy: { minBinId: number; maxBinId: number; strategyType: number }; user: PublicKey; slippage?: number }) => Promise<Transaction>
}
// The CJS entry, as in direct-meteora-dlmm.ts: the ESM one imports a directory path.
const DLMM = createRequire(import.meta.url)('@meteora-ag/dlmm') as {
  create: (connection: Connection, address: PublicKey, options: { cluster: 'mainnet-beta' }) => Promise<DlmmPool>
  StrategyType: { Spot: number }
}

export type NewDlmmDeposit = { instructions: RawInstruction[]; position: Keypair
  quote: { amounts: { mint: string; direction: 'debit'; expectedRaw: string; limitRaw: string }[]; details: { binCount: number; minBinId: number } } }

/** A Spot deposit of `tokenAmount` and `solAmount` across `binCount` bins
 * centred on the active bin, into a new position the wallet owns. The quote
 * names both debits the way the liquidity service's quotes do, so the
 * composed assembly proves and patches them the same way. */
export async function newDlmmDeposit(connection: Connection, input: { pool: string; owner: string; tokenMint: string;
  tokenAmount: bigint; solAmount: bigint; binCount: number; slippageBps: number }): Promise<NewDlmmDeposit> {
  const pool = await DLMM.create(connection, new PublicKey(input.pool), { cluster: 'mainnet-beta' })
  const x = pool.tokenX.publicKey.toBase58(), y = pool.tokenY.publicKey.toBase58(), sol = NATIVE_MINT.toBase58()
  const tokenIsX = x === input.tokenMint
  if (!(tokenIsX ? y === sol : x === sol && y === input.tokenMint)) throw new Error('DLMM pool does not pair this token with SOL')
  const { binId } = await pool.getActiveBin()
  const minBinId = binId - Math.floor(input.binCount / 2)
  const position = Keypair.generate()
  const transaction = await pool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: position.publicKey, user: new PublicKey(input.owner), slippage: input.slippageBps / 100,
    totalXAmount: new BN((tokenIsX ? input.tokenAmount : input.solAmount).toString()),
    totalYAmount: new BN((tokenIsX ? input.solAmount : input.tokenAmount).toString()),
    strategy: { minBinId, maxBinId: minBinId + input.binCount - 1, strategyType: DLMM.StrategyType.Spot },
  })
  const instructions = transaction.instructions.filter(ix => !ix.programId.equals(ComputeBudgetProgram.programId)).map(ix => ({
    programId: ix.programId.toBase58(), data: Buffer.from(ix.data).toString('base64'),
    keys: ix.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })) }))
  const debit = (mint: string, raw: bigint) => ({ mint, direction: 'debit' as const, expectedRaw: raw.toString(), limitRaw: raw.toString() })
  return { instructions, position, quote: { amounts: [debit(input.tokenMint, input.tokenAmount), debit(sol, input.solAmount)],
    details: { binCount: input.binCount, minBinId } } }
}
