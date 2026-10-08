import { Connection, PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction,
  createSyncNativeInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'

export type DirectPool = { address: string; venue: string; mint_a: string; mint_b: string; liq_events: number }
export type DirectIntent = { inputMint: string; outputMint: string; amount: string;
  slippageBps: number; transactionVersion: '0' | '1' }
export type DirectPrice = { out: bigint; minimum: bigint; fee: bigint; feeMint: string;
  instructions: (wallet: PublicKey, minimum: bigint) => Promise<TransactionInstruction[]> }

const MAX_U64 = (1n << 64n) - 1n
export class DirectVenueError extends Error {}

export function exactAmount(intent: DirectIntent): bigint {
  if (!/^[1-9][0-9]{0,19}$/.test(intent.amount)) throw new DirectVenueError('Invalid exact-in amount')
  const value = BigInt(intent.amount)
  if (value > MAX_U64) throw new DirectVenueError('Exact-in amount exceeds u64')
  if (!Number.isSafeInteger(intent.slippageBps) || intent.slippageBps < 0 || intent.slippageBps > 5_000)
    throw new DirectVenueError('Invalid slippage')
  return value
}

export function checkedPrice(out: bigint, minimum: bigint, fee: bigint, feeMint: string,
  instructions: DirectPrice['instructions']): DirectPrice {
  if (out <= 0n || out > MAX_U64 || minimum <= 0n || minimum > out || fee < 0n || fee > MAX_U64)
    throw new DirectVenueError('Pool cannot fill this exact-in amount')
  return { out, minimum, fee, feeMint, instructions }
}

export function pairIsExact(pool: DirectPool, intent: DirectIntent, mintA: PublicKey, mintB: PublicKey): boolean {
  const actual = [mintA.toBase58(), mintB.toBase58()].sort().join(':')
  const saved = [pool.mint_a, pool.mint_b].sort().join(':')
  return actual === saved && actual === [intent.inputMint, intent.outputMint].sort().join(':')
}

export async function assertClassicMints(connection: Connection, a: PublicKey, b: PublicKey): Promise<void> {
  const [mintA, mintB] = await connection.getMultipleAccountsInfo([a, b], 'confirmed')
  if (!mintA || !mintB || !mintA.owner.equals(TOKEN_PROGRAM_ID) ||
    !mintB.owner.equals(TOKEN_PROGRAM_ID) || mintA.data.length < 82 || mintB.data.length < 82)
    throw new DirectVenueError('Pool mint requires unsupported Token-2022 pricing')
}

export async function assertPoolOwner(connection: Connection, address: PublicKey, program: PublicKey): Promise<void> {
  const account = await connection.getAccountInfo(address, 'confirmed')
  if (!account?.owner.equals(program)) throw new DirectVenueError('FTL pool owner does not match venue program')
}

export function mintAta(wallet: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, wallet, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
}

// The app's SOL side is native SOL, while venue programs consume wrapped SOL.
// Use a wallet-owned ATA and wallet-only instructions; never introduce an
// ephemeral keypair signer.
export async function nativeWrapInstructions(connection: Connection, wallet: PublicKey,
  inputMint: string, amount: bigint): Promise<TransactionInstruction[]> {
  if (inputMint !== NATIVE_MINT.toBase58()) return []
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new DirectVenueError('SOL amount cannot be encoded safely')
  const ata = mintAta(wallet, NATIVE_MINT)
  const existing = await connection.getAccountInfo(ata, 'confirmed')
  if (existing && !existing.owner.equals(TOKEN_PROGRAM_ID))
    throw new DirectVenueError('Wallet wrapped-SOL account has an unexpected owner')
  return [createAssociatedTokenAccountIdempotentInstruction(wallet, ata, wallet, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: wallet, toPubkey: ata, lamports: Number(amount) }),
    createSyncNativeInstruction(ata)]
}

export async function nativeUnwrapInstructions(connection: Connection, wallet: PublicKey,
  outputMint: string): Promise<TransactionInstruction[]> {
  if (outputMint !== NATIVE_MINT.toBase58()) return []
  const ata = mintAta(wallet, NATIVE_MINT)
  // Closing a pre-existing ATA would unwrap the user's unrelated WSOL.
  // Leaving it open would incorrectly promise native SOL output. Reject this
  // route until a wallet-derived temporary output account is supported.
  if (await connection.getAccountInfo(ata, 'confirmed'))
    throw new DirectVenueError('Native SOL output requires no existing wallet WSOL account')
  return [createCloseAccountInstruction(ata, wallet, wallet)]
}
