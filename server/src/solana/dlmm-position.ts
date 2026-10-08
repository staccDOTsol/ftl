// A new Meteora DLMM position and its deposit (see venue-deposit.ts for why
// this server builds it). Amount-driven: the quote's debits are the amounts
// the deposit instruction encodes, so no liquidity figure is needed.
import { Keypair, PublicKey, type Connection, type Transaction } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { createRequire } from 'node:module'
import BN from 'bn.js'
import { debit, rawInstructions, type VenueDepositBuilder } from './venue-deposit.ts'

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

/** A Spot deposit across `binCount` bins (default 60) centred on the active
 * bin, into a new position the wallet owns. */
export const newDlmmDeposit: VenueDepositBuilder = async (connection, input) => {
  const binCount = Number(input.parameters.binCount ?? 60)
  const pool = await DLMM.create(connection, new PublicKey(input.pool), { cluster: 'mainnet-beta' })
  const x = pool.tokenX.publicKey.toBase58(), y = pool.tokenY.publicKey.toBase58(), sol = NATIVE_MINT.toBase58()
  const tokenIsX = x === input.tokenMint
  if (!(tokenIsX ? y === sol : x === sol && y === input.tokenMint)) throw new Error('DLMM pool does not pair this token with SOL')
  const { binId } = await pool.getActiveBin()
  const minBinId = binId - Math.floor(binCount / 2)
  const position = Keypair.generate()
  const transaction = await pool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: position.publicKey, user: new PublicKey(input.owner), slippage: input.slippageBps / 100,
    totalXAmount: new BN((tokenIsX ? input.tokenAmount : input.solAmount).toString()),
    totalYAmount: new BN((tokenIsX ? input.solAmount : input.tokenAmount).toString()),
    strategy: { minBinId, maxBinId: minBinId + binCount - 1, strategyType: DLMM.StrategyType.Spot },
  })
  return { instructions: rawInstructions(transaction.instructions), signers: [position], position: position.publicKey.toBase58(),
    quote: { amounts: [debit(input.tokenMint, input.tokenAmount), debit(sol, input.solAmount)], details: { binCount, minBinId } } }
}
