import { Connection, PublicKey, SystemProgram, type AccountInfo, type TransactionInstruction } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, AccountState, ExtensionType, NATIVE_MINT, TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction,
  createSyncNativeInstruction, getAssociatedTokenAddressSync, getDefaultAccountState, getExtensionTypes,
  getInterestBearingMintConfigState, getTransferFeeConfig, getTransferHook, unpackMint } from '@solana/spl-token'

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
  offsets: SwapOffsets | null; inputAccount: PublicKey; outputAccount: PublicKey
  /** Token program that owns `outputAccount` (absent: classic SPL Token). The
   * composer's in-kind fee on this leg's output runs under this program. */
  outputTokenProgram?: PublicKey }
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
  amountIn: bigint, minOut: bigint, inputAccount: PublicKey, outputAccount: PublicKey,
  outputTokenProgram: PublicKey = TOKEN_PROGRAM_ID): DirectLeg {
  const owned = instructions.flatMap((ix, index) => ix.programId.equals(program) ? [index] : [])
  if (owned.length !== 1) throw new DirectVenueError('Venue built an unexpected number of swap instructions')
  const swapIndex = owned[0]
  return { instructions, swapIndex, inputAccount, outputAccount,
    ...(outputTokenProgram.equals(TOKEN_PROGRAM_ID) ? {} : { outputTokenProgram }),
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

/** A pool mint the router can price exact-in and charge in kind: the token
 * program that owns it (every ATA and transfer for it runs there) and decimals. */
export type SwapMint = { mint: PublicKey; tokenProgram: PublicKey; decimals: number }

// Token-2022 mint extensions that change nothing about raw amounts or
// transfers: the venue moves exactly what it priced, and the composer's
// in-kind TransferChecked fee needs no extra accounts.
const INERT_EXTENSIONS = new Set<number>([ExtensionType.Uninitialized, ExtensionType.MintCloseAuthority,
  ExtensionType.MetadataPointer, ExtensionType.TokenMetadata, ExtensionType.GroupPointer,
  ExtensionType.TokenGroup, ExtensionType.GroupMemberPointer, ExtensionType.TokenGroupMember])
// Not in this @solana/spl-token's ExtensionType enum; named for the refusal.
const UNLISTED_EXTENSIONS: Record<number, string> = { 16: 'ConfidentialTransferFeeConfig',
  17: 'ConfidentialTransferFeeAmount', 24: 'ConfidentialMintBurn' }

/** Why a Token-2022 mint cannot be priced exact-in with fees taken in kind,
 * or null when every extension it carries is benign. The TLV entries after
 * the 165-byte base and the account-type byte are read with spl-token's own
 * parsers; any extension not known to be benign is refused. */
export function token2022Blocker(mint: PublicKey, info: AccountInfo<Buffer>): string | null {
  let parsed: ReturnType<typeof unpackMint>, types: number[]
  try {
    parsed = unpackMint(mint, info, TOKEN_2022_PROGRAM_ID)
    types = getExtensionTypes(parsed.tlvData)
  } catch { return 'unreadable mint extensions' }
  if (!parsed.isInitialized) return 'uninitialized mint'
  for (const type of types) {
    if (INERT_EXTENSIONS.has(type)) continue
    switch (type) {
      case ExtensionType.TransferFeeConfig: {
        const fee = getTransferFeeConfig(parsed)
        if (!fee || fee.olderTransferFee.transferFeeBasisPoints !== 0 ||
          fee.newerTransferFee.transferFeeBasisPoints !== 0) return 'non-zero transfer fee'
        continue
      }
      case ExtensionType.TransferHook: {
        const hook = getTransferHook(parsed)
        if (!hook || !hook.programId.equals(PublicKey.default)) return 'transfer hook program'
        continue
      }
      case ExtensionType.DefaultAccountState: {
        const state = getDefaultAccountState(parsed)
        if (!state || state.state !== AccountState.Initialized) return 'new token accounts start frozen'
        continue
      }
      case ExtensionType.InterestBearingConfig: {
        const rate = getInterestBearingMintConfigState(parsed)
        if (!rate || rate.currentRate !== 0 || rate.preUpdateAverageRate !== 0) return 'non-zero interest rate'
        continue
      }
      case ExtensionType.NonTransferable: return 'non-transferable'
      case ExtensionType.PermanentDelegate: return 'permanent delegate'
      case ExtensionType.PausableConfig: return 'pausable'
      case ExtensionType.ConfidentialTransferMint: return 'confidential transfers'
      default: return `unsupported extension ${ExtensionType[type] ?? UNLISTED_EXTENSIONS[type] ?? type}`
    }
  }
  return null
}

/** A classic SPL mint, or a Token-2022 mint whose extensions are all benign. */
export function swapMint(mint: PublicKey, info: AccountInfo<Buffer> | null): SwapMint {
  if (!info || info.data.length < 82) throw new DirectVenueError('Pool mint account is missing')
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return { mint, tokenProgram: TOKEN_PROGRAM_ID, decimals: info.data[44] }
  if (!info.owner.equals(TOKEN_2022_PROGRAM_ID)) throw new DirectVenueError('Pool mint is not owned by a token program')
  const blocker = token2022Blocker(mint, info)
  if (blocker) throw new DirectVenueError(`Token-2022 mint ${mint.toBase58()} cannot be swapped directly: ${blocker}`)
  return { mint, tokenProgram: TOKEN_2022_PROGRAM_ID, decimals: info.data[44] }
}

/** Both pool mints, read in one call, each with its real token program. */
export async function swapMints(connection: Connection, a: PublicKey, b: PublicKey): Promise<[SwapMint, SwapMint]> {
  const [infoA, infoB] = await connection.getMultipleAccountsInfo([a, b], 'confirmed')
  return [swapMint(a, infoA), swapMint(b, infoB)]
}

/** The token program of whichever pool mint `mint` is. */
export function programOf(mints: readonly SwapMint[], mint: PublicKey | string): PublicKey {
  const key = typeof mint === 'string' ? mint : mint.toBase58()
  const found = mints.find(m => m.mint.toBase58() === key)
  if (!found) throw new DirectVenueError('Swap mint is not one of the pool mints')
  return found.tokenProgram
}

/** A token account owned by `tokenProgram` holding `mint` (vault checks). */
export function isTokenAccountFor(info: AccountInfo<Buffer> | null, mint: PublicKey, tokenProgram: PublicKey): boolean {
  return !!info && info.owner.equals(tokenProgram) && info.data.length >= 165 &&
    new PublicKey(info.data.subarray(0, 32)).equals(mint)
}

export async function assertPoolOwner(connection: Connection, address: PublicKey, program: PublicKey): Promise<void> {
  const account = await connection.getAccountInfo(address, 'confirmed')
  if (!account?.owner.equals(program)) throw new DirectVenueError('FTL pool owner does not match venue program')
}

/** The wallet's canonical ATA for `mint` under the mint's own token program. */
export function mintAta(wallet: PublicKey, mint: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM_ID): PublicKey {
  return getAssociatedTokenAddressSync(mint, wallet, false, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID)
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
  const existing = await connection.getAccountInfo(ata, 'confirmed')
  if (existing && !existing.owner.equals(TOKEN_PROGRAM_ID))
    throw new DirectVenueError('Wallet wrapped-SOL account has an unexpected owner')
  // Close the wallet WSOL account. That unwraps whatever was already there
  // along with this swap's output.
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
