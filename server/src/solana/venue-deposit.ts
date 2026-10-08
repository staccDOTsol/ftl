// Deposits this server builds itself so a composed zap carries them in one
// transaction through the lp-zap composer. Venues that open a new position
// account (DLMM) or mint a position NFT (DAMM v2, Orca, Raydium CLMM) need
// that account's own key to sign; the liquidity service signs with a key it
// keeps, which a composed transaction (a new message) cannot reuse. Here the
// key is generated per build, signs the composed transaction before the
// wallet does, and is never stored: it only authorises creating the account,
// and the position belongs to the wallet.
import type { AccountInfo, Connection, Keypair } from '@solana/web3.js'
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

type Key = { toBase58(): string }
/** The chain as a composed deposit will meet it: reads of the accounts in
 * `after` (each one's state once the swap ahead of the deposit has run, read
 * by simulating that swap) return that state, and everything else passes
 * through. A swap through the deposit's own pool moves its price, so a
 * deposit sized from the pool as it is now asks the wrong price. */
export function afterSwap(connection: Connection, after: Map<string, AccountInfo<Buffer> | null>): Connection {
  const pick = (key: Key, live: AccountInfo<Buffer> | null) => after.has(key.toBase58()) ? after.get(key.toBase58()) ?? null : live
  const reads: Record<string, (...args: any[]) => Promise<unknown>> = {
    getAccountInfo: async (key: Key, config?: any) => after.has(key.toBase58()) ? pick(key, null) : connection.getAccountInfo(key as any, config),
    getAccountInfoAndContext: async (key: Key, config?: any) => {
      const read = await connection.getAccountInfoAndContext(key as any, config)
      return { ...read, value: pick(key, read.value) }
    },
    getMultipleAccountsInfo: async (keys: Key[], config?: any) => {
      const live = keys.filter(key => !after.has(key.toBase58()))
      const read = live.length ? await connection.getMultipleAccountsInfo(live as any, config) : []
      return keys.map(key => after.has(key.toBase58()) ? pick(key, null) : read[live.indexOf(key)])
    },
    getMultipleAccountsInfoAndContext: async (keys: Key[], config?: any) => {
      const read = await connection.getMultipleAccountsInfoAndContext(keys as any, config)
      return { ...read, value: read.value.map((value, i) => pick(keys[i], value)) }
    },
  }
  return new Proxy(connection, { get(target, property) {
    if (typeof property === 'string' && Object.hasOwn(reads, property)) return reads[property]
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}
