import { Connection, PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction,
  createSyncNativeInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'

export type DirectPool = { address: string; venue: string; mint_a: string; mint_b: string; liq_events: number }
export type DirectIntent = { inputMint: string; outputMint: string; amount: string;
  slippageBps: number; transactionVersion: '0' | '1';
  /** Multi-hop legs keep native SOL as the wallet's WSOL token account on
   * the named side: 'input' skips the wrap (the previous hop already paid
   * WSOL into the ATA), 'output' skips the close (the next hop spends it). */
  keepNative?: 'input' | 'output' | 'both' }
/** Byte offsets of the two u64 fields inside one venue swap instruction's
 * data: exact amount in and minimum amount out. Null when the builder could
 * not prove them for this instruction (an on-chain composer must not patch). */
export type SwapOffsets = { amountInOffset: number; minOutOffset: number }
/** One built swap leg: every instruction the venue needs, which of them is the
 * venue swap, the wallet token accounts it spends from and pays into, and the
 * proven data offsets of its amounts. */
export type DirectLeg = { instructions: TransactionInstruction[]; swapIndex: number;
  offsets: SwapOffsets | null; inputAccount: PublicKey; outputAccount: PublicKey }
export type DirectPrice = { out: bigint; minimum: bigint; fee: bigint; feeMint: string;
  instructions: (wallet: PublicKey, minimum: bigint) => Promise<TransactionInstruction[]>;
  leg: (wallet: PublicKey, minimum: bigint) => Promise<DirectLeg> }

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
  leg: DirectPrice['leg']): DirectPrice {
  if (out <= 0n || out > MAX_U64 || minimum <= 0n || minimum > out || fee < 0n || fee > MAX_U64)
    throw new DirectVenueError('Pool cannot fill this exact-in amount')
  return { out, minimum, fee, feeMint, leg,
    instructions: async (wallet, protectedMinimum) => (await leg(wallet, protectedMinimum)).instructions }
}

/** The single byte offset at which `value` appears little-endian in `data`,
 * or null when it appears zero or several times (ambiguous: never patch). */
export function locateU64(data: Uint8Array, value: bigint): number | null {
  if (value < 0n || value > MAX_U64) return null
  const needle = Buffer.alloc(8)
  needle.writeBigUInt64LE(value)
  const haystack = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  let found: number | null = null
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (found !== null) return null
    found = at
  }
  return found
}

/** Offsets derived from the instruction the venue builder just produced: the
 * exact amounts it was asked to encode are located in its data at build
 * time. The two fields must be distinct, unique and non-overlapping. */
export function swapOffsets(data: Uint8Array, amountIn: bigint, minOut: bigint): SwapOffsets | null {
  const amountInOffset = locateU64(data, amountIn), minOutOffset = locateU64(data, minOut)
  if (amountInOffset === null || minOutOffset === null || amountInOffset === minOutOffset ||
    Math.abs(amountInOffset - minOutOffset) < 8 || data.length > 65_535) return null
  return { amountInOffset, minOutOffset }
}

/** Assemble a leg around SDK-built instructions: the venue swap is the one
 * instruction owned by `program`; its amount offsets are proven from the data. */
export function venueLeg(instructions: TransactionInstruction[], program: PublicKey,
  amountIn: bigint, minOut: bigint, inputAccount: PublicKey, outputAccount: PublicKey): DirectLeg {
  const owned = instructions.flatMap((ix, index) => ix.programId.equals(program) ? [index] : [])
  if (owned.length !== 1) throw new DirectVenueError('Venue built an unexpected number of swap instructions')
  const swapIndex = owned[0]
  return { instructions, swapIndex, inputAccount, outputAccount,
    offsets: swapOffsets(instructions[swapIndex].data, amountIn, minOut) }
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
  inputMint: string, amount: bigint, keepNative?: DirectIntent['keepNative']): Promise<TransactionInstruction[]> {
  if (inputMint !== NATIVE_MINT.toBase58() || keepNative === 'input' || keepNative === 'both') return []
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
  outputMint: string, keepNative?: DirectIntent['keepNative']): Promise<TransactionInstruction[]> {
  if (outputMint !== NATIVE_MINT.toBase58() || keepNative === 'output' || keepNative === 'both') return []
  const ata = mintAta(wallet, NATIVE_MINT)
  // Closing a pre-existing ATA would unwrap the user's unrelated WSOL.
  // Leaving it open would incorrectly promise native SOL output. Reject this
  // route until a wallet-derived temporary output account is supported.
  if (await connection.getAccountInfo(ata, 'confirmed'))
    throw new DirectVenueError('Native SOL output requires no existing wallet WSOL account')
  return [createCloseAccountInstruction(ata, wallet, wallet)]
}

/** SDKs that wrap SOL themselves (fund + sync before, close after) get the
 * same treatment as our own helpers: drop the fixed-amount funding and sync on
 * the input side, and the close on the output side, while keeping the
 * idempotent ATA creation. Only instructions on the wallet's WSOL ATA go. */
export function stripNativeWrapping(instructions: TransactionInstruction[], wallet: PublicKey,
  keepNative: DirectIntent['keepNative']): TransactionInstruction[] {
  if (!keepNative) return instructions
  const ata = mintAta(wallet, NATIVE_MINT)
  const keepInput = keepNative === 'input' || keepNative === 'both'
  const keepOutput = keepNative === 'output' || keepNative === 'both'
  return instructions.filter(ix => {
    if (ix.programId.equals(SystemProgram.programId) && keepInput && ix.data.length >= 4 &&
      ix.data.readUInt32LE(0) === 2 && ix.keys[1]?.pubkey.equals(ata)) return false
    if (!ix.programId.equals(TOKEN_PROGRAM_ID) || !ix.keys[0]?.pubkey.equals(ata)) return true
    if (keepInput && ix.data[0] === 17) return false
    if (keepOutput && ix.data[0] === 9) return false
    return true
  })
}
