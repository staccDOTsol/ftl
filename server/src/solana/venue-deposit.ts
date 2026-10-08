// Deposits this server builds itself so a composed zap carries them in one
// transaction through the lp-zap composer. Venues that open a new position
// account (DLMM) or mint a position NFT (DAMM v2, Orca, Raydium CLMM) need
// that account's own key to sign; the liquidity service signs with a key it
// keeps, which a composed transaction (a new message) cannot reuse. Here the
// key is generated per build, signs the composed transaction before the
// wallet does, and is never stored: it only authorises creating the account,
// and the position belongs to the wallet.
import type { Connection, Keypair } from '@solana/web3.js'
import type { RawInstruction } from './zap.ts'

export type DepositDebit = { mint: string; direction: 'debit'; expectedRaw: string; limitRaw: string }
/** What a builder returns. `quote` has the liquidity service's shape so
 * proveVenueAdd proves it the same way: both debits always; liquidity-driven
 * venues (DAMM v2, Orca, Raydium CLMM) also `details.liquidity`, the exact
 * value the deposit instruction encodes, with each debit's `limitRaw` equal
 * to the maximum that instruction encodes for that side. */
export type VenueDeposit = { instructions: RawInstruction[]; signers: Keypair[]; position: string
  quote: { amounts: DepositDebit[]; details: { liquidity?: string } & Record<string, unknown> } }
export type VenueDepositInput = { pool: string; owner: string; tokenMint: string; tokenAmount: bigint; solAmount: bigint
  slippageBps: number; parameters: Record<string, string | number | boolean> }
export type VenueDepositBuilder = (connection: Connection, input: VenueDepositInput) => Promise<VenueDeposit>

/** web3.js instructions in the composer client's raw shape, compute budget dropped (the emitter owns it). */
export function rawInstructions(instructions: { programId: { toBase58(): string; equals(other: any): boolean };
  keys: { pubkey: { toBase58(): string }; isSigner: boolean; isWritable: boolean }[]; data: Uint8Array }[]): RawInstruction[] {
  return instructions.filter(ix => ix.programId.toBase58() !== 'ComputeBudget111111111111111111111111111111').map(ix => ({
    programId: ix.programId.toBase58(), data: Buffer.from(ix.data).toString('base64'),
    keys: ix.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })) }))
}
export const debit = (mint: string, expected: bigint, limit = expected): DepositDebit =>
  ({ mint, direction: 'debit', expectedRaw: expected.toString(), limitRaw: limit.toString() })
