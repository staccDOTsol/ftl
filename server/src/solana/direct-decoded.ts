// Swaps through programs FTL learned by observation, not shipped venue
// adapters: a landed swap is replayed for another wallet with only that
// wallet's own accounts re-pointed and the exact-in amount patched at its
// proven offset. Every PDA the learned interface reconstructs is re-derived
// and verified against the landed addresses first; a recipe that does not
// reproduce the landing is dropped, never guessed around.
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import type { DecodedSwapTemplate } from './program-service.ts'
import { mintAta, nativeUnwrapInstructions, nativeWrapInstructions } from './direct-adapter.ts'

export const DECODED_CU = 1_400_000
const WSOL = NATIVE_MINT.toBase58()

/** A fixed 32-byte seed or program id the learned interface reported. */
const bytes32 = (value: unknown): Buffer | null =>
  Array.isArray(value) && value.length === 32 && value.every(byte => typeof byte === 'number' && byte >= 0 && byte <= 255)
    ? Buffer.from(value as number[]) : null

/** The raw SPL token balance of an account's data, whatever program owns it. */
export function tokenAccountAmount(data: unknown): bigint | null {
  if (typeof data !== 'string') return null
  try {
    const bytes = Buffer.from(data, 'base64')
    return bytes.length >= 72 ? bytes.readBigUInt64LE(64) : null
  } catch { return null }
}

export type SwapReplay = {
  /** Wrap + the replayed swap + unwrap, in execution order, no compute budget. */
  instructions: TransactionInstruction[]
  allowPrograms: PublicKey[]
  computeUnitLimit: number
  /** The wallet's output token account and its balance before the replay, so
   * the simulated outcome can be measured against the quoted minimum. Null
   * when the swap pays native SOL: no account to measure. */
  output: { address: string; preAmount: bigint } | null
}

/** One landed swap replayed for `wallet`. The signer and every token account
 * the signer owned become the wallet's; PDAs the learned interface carries are
 * re-derived from the new accounts after the recipe reproduces the landing;
 * everything else stays exactly as it landed. Native SOL sides ride the same
 * wrap/unwrap helpers the shipped venues use. Null whenever any account
 * cannot be re-pointed with proof. */
export async function replayDecodedSwap(decoded: DecodedSwapTemplate, wallet: PublicKey,
  amountIn: bigint, connection: Connection): Promise<SwapReplay | null> {
  const template = decoded.template
  if (template.amountProof !== 'exact' || amountIn <= 0n || amountIn >= 1n << 64n) return null
  const program = new PublicKey(template.program)
  const learned = decoded.instruction.accounts
  if (learned.length !== template.accounts.length) return null
  const original = template.accounts.map(account => account.address)
  const addresses = [...original]
  const flags = template.accounts.map(account => ({ isSigner: account.signer, isWritable: account.writable }))

  // 1. The signer and its token accounts become this wallet's.
  const rePointed = new Map<number, string>() // index -> mint
  for (let i = 0; i < addresses.length; i++) {
    if (addresses[i] === template.signer) addresses[i] = wallet.toBase58()
    else {
      const owned = template.tokenAccounts.find(account => account.address === addresses[i])
      if (owned) rePointed.set(i, owned.mint)
    }
  }
  // Resolve the wallet's own accounts for each named mint; mints the wallet
  // has no account for get an idempotent create so the program can use them.
  const mints = [...new Set([...rePointed.values()])]
  const mintInfos = mints.length && mints.some(mint => mint !== WSOL)
    ? await connection.getMultipleAccountsInfo(mints.filter(mint => mint !== WSOL).map(mint => new PublicKey(mint)), 'confirmed') : []
  const mintProgram = new Map<string, PublicKey>()
  mints.filter(mint => mint !== WSOL).forEach((mint, i) => {
    const owner = mintInfos[i]?.owner
    if (owner && (owner.equals(TOKEN_PROGRAM_ID) || owner.equals(TOKEN_2022_PROGRAM_ID))) mintProgram.set(mint, owner)
  })
  const walletAccount = (mint: string): PublicKey | null =>
    mint === WSOL ? mintAta(wallet, NATIVE_MINT)
      : mintProgram.has(mint) ? getAssociatedTokenAddressSync(new PublicKey(mint), wallet, false, mintProgram.get(mint)!, ASSOCIATED_TOKEN_PROGRAM_ID)
      : null
  const creates: TransactionInstruction[] = []
  let output: { address: string; preAmount: bigint } | null = null
  for (const [index, mint] of rePointed) {
    const account = walletAccount(mint)
    if (!account) return null
    const info = await connection.getAccountInfo(account, 'confirmed')
    if (info && !(info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID))) return null
    const preAmount = info ? tokenAccountAmount(info.data.toString('base64')) ?? 0n : 0n
    // The WSOL input account is funded by the wrap below; other accounts the
    // program touches are created idempotently so it can use them.
    if (!info) creates.push(createAssociatedTokenAccountIdempotentInstruction(wallet, account, wallet,
      new PublicKey(mint), mintProgram.get(mint) ?? TOKEN_PROGRAM_ID))
    addresses[index] = account.toBase58()
    if (mint === template.outputMint) output = { address: account.toBase58(), preAmount }
  }
  // A native-SOL output has no token account to measure; simulation alone covers it.

  // 2. PDAs: the recipe must reproduce the landed address from the landed
  // inputs before it may re-derive anything for this wallet.
  const byName = new Map(learned.map((account: any, index: number) => [account.name as string, index]))
  const resolve = (value: any, from: string[]): PublicKey | null => {
    if (value?.kind === 'const') { const bytes = bytes32(value.value); return bytes ? new PublicKey(bytes) : null }
    if (value?.kind === 'account' && typeof value.path === 'string') { const at = byName.get(value.path); return at === undefined || !from[at] ? null : new PublicKey(from[at]) }
    return null
  }
  const derive = (pda: any, from: string[]): PublicKey | null => {
    const seeds: Buffer[] = []
    for (const seed of pda?.seeds ?? []) {
      const key = resolve(seed, from)
      if (!key) return null
      seeds.push(key.toBuffer())
    }
    const owner = resolve(pda?.program, from)
    if (!owner || seeds.length > 16 || seeds.reduce((sum, seed) => sum + seed.length, 0) > 1280) return null
    try { return PublicKey.findProgramAddressSync(seeds, owner)[0] } catch { return null }
  }
  for (const account of learned as any[]) {
    if (!account.pda) continue
    const index = byName.get(account.name)!
    if (!derive(account.pda, original)?.equals(new PublicKey(original[index]))) return null
  }
  for (let pass = 0; pass < learned.length; pass++) {
    let changed = false
    for (const account of learned as any[]) {
      if (!account.pda) continue
      const index = byName.get(account.name)!
      const derived = derive(account.pda, addresses)
      if (!derived) return null
      if (derived.toBase58() !== addresses[index]) { addresses[index] = derived.toBase58(); changed = true }
    }
    if (!changed) break
  }

  // 3. The instruction: the landed bytes with this wallet's amount at its proven offset.
  const data = Buffer.from(template.data, 'base64')
  data.writeBigUInt64LE(amountIn, template.amountOffset)
  const keys = addresses.map((address, i) => ({ pubkey: new PublicKey(address), isSigner: flags[i].isSigner, isWritable: flags[i].isWritable }))
  const swap = new TransactionInstruction({ programId: program, keys, data })

  // 4. Native SOL sides through the same wrap and unwrap the shipped venues use.
  const before: TransactionInstruction[] = [...creates]
  if (template.nativeIn === 'wsol') before.push(...await nativeWrapInstructions(connection, wallet, WSOL, amountIn))
  let after: TransactionInstruction[] = []
  if (template.nativeOut === 'wsol') {
    try { after = await nativeUnwrapInstructions(connection, wallet, WSOL) } catch { after = [] } // a pre-existing WSOL account is left alone
  }
  return { instructions: [...before, swap, ...after], allowPrograms: [program], computeUnitLimit: DECODED_CU, output }
}
