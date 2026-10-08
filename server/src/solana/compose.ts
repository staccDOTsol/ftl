// Client for the lp-zap composer program: one `compose` instruction that CPIs
// a sequence of opaque venue instructions, patches later amounts from real
// balance deltas, charges 0.1% in kind per fee'd hop and checks the outcome.
// The byte layout mirrors lp-zap/src/layout.rs exactly; every structural
// limit the program enforces is enforced here first so a bad description
// never reaches a wallet.
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction,
  type AccountMeta, type AddressLookupTableAccount } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync } from '@solana/spl-token'
import type { DirectLeg } from './direct-adapter.ts'
import { unsignedV0, unsignedV1 } from './self-router.ts'

/** Hardcoded in lp-zap/src/fee.rs: owner of every fee ATA. */
export const FEE_RECIPIENT = new PublicKey('331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth')
/** Program id declared in lp-zap/src/lib.rs. Deployments pick theirs from
 * LP_ZAP_PROGRAM_ID; this constant is only the source's declared id. */
export const LP_ZAP_DECLARED_PROGRAM_ID = 'BHYw1FAWPriW9Gh7BG49X4UVe96CDjaxFrFFUtGSQmRx'
export const FEE_BPS = 10n
export const BPS_DENOMINATOR = 10_000n

export const TAG_COMPOSE = 0
export const LIMITS = { watch: 8, steps: 8, stepAccounts: 48, patches: 8, stepData: 1024, checks: 16 } as const
export const PATCH_LEN = 21
export const CHECK_LEN = 10
export const FEE_LEN = 6
/** 0 delta, 1 delta*num/den, 2 delta*num/den - sub (saturating), 3 min(delta, num). */
export type PatchMode = 0 | 1 | 2 | 3
/** 0 = final delta >= bound, 1 = final delta <= bound. */
export type CheckKind = 0 | 1

const U64_MAX = (1n << 64n) - 1n
const I64_MIN = -(1n << 63n), I64_MAX = (1n << 63n) - 1n
const U32_MAX = 0xffff_ffff

// ---- description (index-level, byte-for-byte the instruction data) ---------

/** Rewrites 8 bytes at `dataOffset` of this step's data with a value derived
 * from the change of watch slot `watchSlot` between the snapshot taken before
 * step `fromStep` and the one taken before this step. */
export type ComposePatch = { dataOffset: number; watchSlot: number; fromStep: number; mode: PatchMode;
  num: number; den: number; sub: bigint }
/** After the step runs, FEE_BPS of the watched slot's positive delta moves to
 * the fee recipient's ATA (created idempotently). Indices are outer accounts. */
export type ComposeFee = { watchSlot: number; feeAtaIndex: number; mintIndex: number;
  tokenProgramIndex: number; ataProgramIndex: number; systemProgramIndex: number }
export type ComposeStep = { programIndex: number; accounts: number[]; data: Uint8Array;
  patches: ComposePatch[]; fee: ComposeFee | null }
/** Final-vs-initial delta of one watch slot, checked after the last step. */
export type ComposeCheck = { watchSlot: number; kind: CheckKind; bound: bigint }
/** The whole `compose` payload. `watch` holds outer account indices. */
export type ComposeDescription = { watch: number[]; steps: ComposeStep[]; checks: ComposeCheck[] }

export class ComposeError extends Error {}
const bad = (message: string): never => { throw new ComposeError(message) }
const u8 = (v: number, what: string) => {
  if (!Number.isInteger(v) || v < 0 || v > 255) bad(`${what} must be a u8`)
  return v
}

function validate(desc: ComposeDescription): void {
  if (desc.watch.length > LIMITS.watch) bad('Too many watched accounts')
  if (desc.steps.length > LIMITS.steps) bad('Too many composed steps')
  if (desc.checks.length > LIMITS.checks) bad('Too many final checks')
  desc.watch.forEach(w => u8(w, 'Watched account index'))
  desc.steps.forEach((step, index) => {
    u8(step.programIndex, 'Step program index')
    if (step.accounts.length > LIMITS.stepAccounts) bad('Composed step has too many accounts')
    step.accounts.forEach(a => u8(a, 'Step account index'))
    if (step.data.length > LIMITS.stepData) bad('Composed step data is too long')
    if (step.patches.length > LIMITS.patches) bad('Composed step has too many patches')
    for (const p of step.patches) {
      if (!Number.isInteger(p.dataOffset) || p.dataOffset < 0 || p.dataOffset + 8 > step.data.length)
        bad('Patch offset lies outside the step data')
      if (p.watchSlot >= desc.watch.length || !Number.isInteger(p.fromStep) || p.fromStep < 0 || p.fromStep >= index)
        bad('Patch watch slot or source step is out of range')
      if (![0, 1, 2, 3].includes(p.mode)) bad('Unknown patch mode')
      if (!Number.isInteger(p.num) || p.num < 0 || p.num > U32_MAX || !Number.isInteger(p.den) || p.den < 0 || p.den > U32_MAX)
        bad('Patch num/den must be u32')
      if ((p.mode === 1 || p.mode === 2) && p.den === 0) bad('Scaled patch needs a non-zero denominator')
      if (p.sub < 0n || p.sub > U64_MAX) bad('Patch sub must be a u64')
    }
    if (step.fee) {
      if (step.fee.watchSlot >= desc.watch.length) bad('Fee watch slot is out of range')
      for (const k of ['feeAtaIndex', 'mintIndex', 'tokenProgramIndex', 'ataProgramIndex', 'systemProgramIndex'] as const)
        u8(step.fee[k], 'Fee account index')
    }
  })
  for (const c of desc.checks) {
    if (c.watchSlot >= desc.watch.length) bad('Check watch slot is out of range')
    if (c.kind !== 0 && c.kind !== 1) bad('Unknown check kind')
    if (c.bound < I64_MIN || c.bound > I64_MAX) bad('Check bound must be an i64')
  }
}

/** Serialize a description into `compose` instruction data (little-endian). */
export function encodeCompose(desc: ComposeDescription): Buffer {
  validate(desc)
  const out: number[] = []
  const push16 = (v: number) => out.push(v & 0xff, (v >> 8) & 0xff)
  const push32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); out.push(...b) }
  const push64 = (v: bigint, signed = false) => {
    const b = Buffer.alloc(8)
    if (signed) b.writeBigInt64LE(v); else b.writeBigUInt64LE(v)
    out.push(...b)
  }
  out.push(TAG_COMPOSE, desc.watch.length, ...desc.watch, desc.steps.length)
  for (const step of desc.steps) {
    out.push(step.programIndex, step.accounts.length, ...step.accounts)
    push16(step.data.length)
    out.push(...step.data, step.patches.length)
    for (const p of step.patches) {
      push16(p.dataOffset)
      out.push(p.watchSlot, p.fromStep, p.mode)
      push32(p.num); push32(p.den); push64(p.sub)
    }
    if (step.fee) out.push(1, step.fee.watchSlot, step.fee.feeAtaIndex, step.fee.mintIndex,
      step.fee.tokenProgramIndex, step.fee.ataProgramIndex, step.fee.systemProgramIndex)
    else out.push(0)
  }
  out.push(desc.checks.length)
  for (const c of desc.checks) { out.push(c.watchSlot, c.kind); push64(c.bound, true) }
  return Buffer.from(out)
}

/** Inverse of encodeCompose, with the same structural checks as the program. */
export function decodeCompose(bytes: Uint8Array): ComposeDescription {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  const take = (n: number) => { if (at + n > b.length) bad('Truncated compose data'); const s = b.subarray(at, at + n); at += n; return s }
  const byte = () => take(1)[0]
  if (byte() !== TAG_COMPOSE) bad('Not a compose instruction')
  const watch = [...take(byte())]
  const steps: ComposeStep[] = []
  for (let i = 0, n = byte(); i < n; i++) {
    const programIndex = byte(), accounts = [...take(byte())]
    const data = Buffer.from(take(take(2).readUInt16LE(0)))
    const patches: ComposePatch[] = []
    for (let j = 0, m = byte(); j < m; j++) {
      const p = take(PATCH_LEN)
      patches.push({ dataOffset: p.readUInt16LE(0), watchSlot: p[2], fromStep: p[3], mode: p[4] as PatchMode,
        num: p.readUInt32LE(5), den: p.readUInt32LE(9), sub: p.readBigUInt64LE(13) })
    }
    const present = byte()
    if (present > 1) bad('Invalid fee flag')
    const f = present ? take(FEE_LEN) : null
    steps.push({ programIndex, accounts, data, patches, fee: f ? { watchSlot: f[0], feeAtaIndex: f[1],
      mintIndex: f[2], tokenProgramIndex: f[3], ataProgramIndex: f[4], systemProgramIndex: f[5] } : null })
  }
  const checks: ComposeCheck[] = []
  for (let i = 0, n = byte(); i < n; i++) {
    const c = take(CHECK_LEN)
    checks.push({ watchSlot: c[0], kind: c[1] as CheckKind, bound: c.readBigInt64LE(2) })
  }
  if (at !== b.length) bad('Trailing compose data')
  const desc = { watch, steps, checks }
  validate(desc)
  return desc
}

// ---- fee helpers ------------------------------------------------------------

/** The fee the program takes from a hop's positive delta (floor, 10 bps). */
export const composerFee = (delta: bigint): bigint => delta > 0n ? delta * FEE_BPS / BPS_DENOMINATOR : 0n
/** What the next hop (or the wallet) actually sees after the in-kind fee. */
export const afterComposerFee = (delta: bigint): bigint => delta - composerFee(delta)
/** Per-hop gross output, fee and net (net feeds the next hop's quote). */
export function hopEstimates(grossOuts: bigint[]): { gross: bigint; fee: bigint; net: bigint }[] {
  return grossOuts.map(gross => ({ gross, fee: composerFee(gross), net: afterComposerFee(gross) }))
}
/** Venue min_out for the final hop so that min_out minus the fee still
 * covers the user's minimum: ceil(userMin * 1000 / 999). */
export const finalHopMinimum = (userMin: bigint): bigint => (userMin * 1000n + 998n) / 999n

/** The fee recipient's canonical ATA for a Token or Token-2022 mint. */
export function feeAta(mint: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM_ID): PublicKey {
  if (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID))
    bad('Composer fees support only Token and Token-2022 mints')
  return getAssociatedTokenAddressSync(mint, FEE_RECIPIENT, true, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID)
}

// ---- account-level assembly -------------------------------------------------

export type ComposeStepInput = {
  instruction: TransactionInstruction
  /** Patch `dataOffset` from the delta of `watch` since step `fromStep`.
   * Defaults: mode 0 (raw delta), num 0, den 0, sub 0. */
  patches?: { dataOffset: number; watch: PublicKey; fromStep: number; mode?: PatchMode; num?: number;
    den?: number; sub?: bigint }[]
  /** Charge the composer fee on the delta this step produced in `watch`. */
  fee?: { watch: PublicKey; mint: PublicKey; tokenProgram?: PublicKey } | null
}
export type ComposeCheckInput = { watch: PublicKey; kind: 'min' | 'max'; bound: bigint }

/** One `compose` instruction from account-level steps. The payer is outer
 * account 0 (writable signer: it pays fee ATA rent and authorises the fee
 * transfer); every other account is deduplicated with its writable/signer
 * flags OR-ed across uses; watched accounts get slots in first-use order; the
 * fee recipient, its ATA, the mint and the token/ATA/system programs are
 * appended once per fee mint; every step index is rewritten to the outer list.
 * The composer itself may never appear as a step program or account. */
export function composeInstructions({ programId, payer, steps, checks = [] }: { programId: PublicKey;
  payer: PublicKey; steps: ComposeStepInput[]; checks?: ComposeCheckInput[] }): TransactionInstruction {
  if (!steps.length) bad('Nothing to compose')
  const keys: AccountMeta[] = [{ pubkey: payer, isSigner: true, isWritable: true }]
  const index = new Map<string, number>([[payer.toBase58(), 0]])
  const add = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean): number => {
    if (pubkey.equals(programId)) bad('The composer cannot compose itself')
    if (isSigner && !pubkey.equals(payer)) bad('Composed step unexpectedly requires another signer')
    const id = pubkey.toBase58(), at = index.get(id)
    if (at !== undefined) { keys[at].isWritable ||= isWritable; return at }
    if (keys.length >= 256) bad('Composed instruction needs more than 256 accounts')
    keys.push({ pubkey, isSigner, isWritable })
    index.set(id, keys.length - 1)
    return keys.length - 1
  }
  const watch: number[] = []
  const slot = (pubkey: PublicKey, writable: boolean): number => {
    const outer = add(pubkey, false, writable)
    const existing = watch.indexOf(outer)
    if (existing !== -1) return existing
    watch.push(outer)
    return watch.length - 1
  }
  const described: ComposeStep[] = steps.map((step, i) => {
    const ix = step.instruction
    if (ix.programId.equals(programId)) bad('The composer cannot compose itself')
    const programIndex = add(ix.programId, false, false)
    const accounts = ix.keys.map(k => add(k.pubkey, k.isSigner, k.isWritable))
    const patches: ComposePatch[] = (step.patches ?? []).map(p => {
      if (p.fromStep >= i) bad('A patch can only read deltas from earlier steps')
      return { dataOffset: p.dataOffset, watchSlot: slot(p.watch, false), fromStep: p.fromStep,
        mode: p.mode ?? 0, num: p.num ?? 0, den: p.den ?? 0, sub: p.sub ?? 0n }
    })
    let fee: ComposeFee | null = null
    if (step.fee) {
      const tokenProgram = step.fee.tokenProgram ?? TOKEN_PROGRAM_ID
      const ata = feeAta(step.fee.mint, tokenProgram)
      const watchSlot = slot(step.fee.watch, true)
      fee = { watchSlot, feeAtaIndex: add(ata, false, true), mintIndex: add(step.fee.mint, false, false),
        tokenProgramIndex: add(tokenProgram, false, false),
        ataProgramIndex: add(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
        systemProgramIndex: add(SystemProgram.programId, false, false) }
      add(FEE_RECIPIENT, false, false)
    }
    return { programIndex, accounts, data: Buffer.from(ix.data), patches, fee }
  })
  const described_checks: ComposeCheck[] = checks.map(c => ({ watchSlot: slot(c.watch, false),
    kind: c.kind === 'min' ? 0 : 1, bound: c.bound }))
  const data = encodeCompose({ watch, steps: described, checks: described_checks })
  return new TransactionInstruction({ programId, keys, data })
}

// ---- transactions -----------------------------------------------------------

/** Wraps setup + compose + cleanup into the same unsigned V1/V0 wire the
 * direct router emits; the composer is the only extra outer program allowed.
 * Inner step programs travel as accounts of the compose instruction. */
export function buildComposedTransaction({ payer, blockhash, version, programId, before = [], compose,
  after = [], computeUnitLimit = 1_400_000, addressLookupTables }: { payer: PublicKey; blockhash: string;
  version: '0' | '1'; programId: PublicKey; before?: TransactionInstruction[]; compose: TransactionInstruction;
  after?: TransactionInstruction[]; computeUnitLimit?: number;
  addressLookupTables?: AddressLookupTableAccount[] }): string {
  if (!compose.programId.equals(programId)) bad('Compose instruction targets a different program')
  const instructions = [...before, compose, ...after]
  const options = { allowPrograms: [programId] }
  return version === '1' ? unsignedV1(payer, blockhash, instructions, computeUnitLimit, options)
    : unsignedV0(payer, blockhash, instructions, computeUnitLimit, { ...options, addressLookupTables })
}

/** A built venue leg plus the mint it pays into (needed for the fee ATA). */
export type ComposeLeg = { leg: DirectLeg; outputMint: PublicKey; outputTokenProgram?: PublicKey }
export type ComposedRoute = { before: TransactionInstruction[]; compose: TransactionInstruction;
  after: TransactionInstruction[]; hops: number }

const sameInstruction = (a: TransactionInstruction, b: TransactionInstruction) =>
  a.programId.equals(b.programId) && Buffer.from(a.data).equals(Buffer.from(b.data)) &&
  a.keys.length === b.keys.length && a.keys.every((k, i) => k.pubkey.equals(b.keys[i].pubkey) &&
    k.isSigner === b.keys[i].isSigner && k.isWritable === b.keys[i].isWritable)
const hoist = (instructions: TransactionInstruction[]) => instructions.reduce<TransactionInstruction[]>((all, ix) =>
  ix.programId.equals(ComputeBudgetProgram.programId) || all.some(x => sameInstruction(x, ix)) ? all : [...all, ix], [])

/** Chain exact-in venue legs through the composer. Each leg's setup (ATA
 * creation, wrapping) runs before the compose call and its cleanup after;
 * the venue swaps become steps. Hop i>0 spends the real net delta hop i-1
 * left in the shared token account (amount_in patched, mode 0); every
 * intermediate min_out is rewritten to 0 because the one final check guards
 * the outcome; the last hop's min_out is ceil(userMin*1000/999) so the
 * venue already fails before the fee if the user's floor is unreachable;
 * every hop pays the 0.1% fee on the token account it fills; one check
 * requires the destination's final delta >= userMin. */
export function composeRoute(legs: ComposeLeg[], owner: PublicKey, userMin: bigint,
  programId: PublicKey): ComposedRoute {
  if (legs.length < 1 || legs.length > LIMITS.steps) bad('Unsupported composed hop count')
  if (userMin <= 0n || userMin > I64_MAX) bad('Composed minimum must be a positive i64')
  legs.forEach(({ leg }, i) => {
    if (!leg.offsets) bad('A venue leg has unproven amount offsets and cannot be composed')
    if (i > 0 && !leg.inputAccount.equals(legs[i - 1].leg.outputAccount))
      bad('Composed legs do not share their intermediate token account')
  })
  const last = legs.length - 1
  const steps: ComposeStepInput[] = legs.map(({ leg, outputMint, outputTokenProgram }, i) => {
    const swap = leg.instructions[leg.swapIndex], offsets = leg.offsets!
    const data = Buffer.from(swap.data)
    data.writeBigUInt64LE(i === last ? finalHopMinimum(userMin) : 0n, offsets.minOutOffset)
    return { instruction: new TransactionInstruction({ programId: swap.programId, keys: swap.keys, data }),
      patches: i === 0 ? [] : [{ dataOffset: offsets.amountInOffset, watch: legs[i - 1].leg.outputAccount, fromStep: i - 1 }],
      fee: { watch: leg.outputAccount, mint: outputMint, tokenProgram: outputTokenProgram } }
  })
  const compose = composeInstructions({ programId, payer: owner, steps,
    checks: [{ watch: legs[last].leg.outputAccount, kind: 'min', bound: userMin }] })
  return { compose, hops: legs.length,
    before: hoist(legs.flatMap(({ leg }) => leg.instructions.slice(0, leg.swapIndex))),
    after: hoist(legs.flatMap(({ leg }) => leg.instructions.slice(leg.swapIndex + 1))) }
}

// ---- zap hook ---------------------------------------------------------------

/** Account-level instruction as zap.ts already emits it (`RawInstruction`
 * from `instructionsOf`: base58 keys, base64 data). */
export type RawComposeInstruction = { programId: string;
  keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }
/**
 * One zap step for the composer. Expected shape from zap.ts:
 *
 *   { setup:   RawInstruction[]   // ATA creates / WSOL wrap, run before compose
 *     action:  RawInstruction     // the venue swap or add-liquidity instruction
 *     cleanup: RawInstruction[]   // unwraps / closes, run after compose
 *     amountFrom?: {              // size this action from an earlier step's real output
 *       dataOffset: number        // proven u64 offset in action.data (never guessed)
 *       account: string           // token account (or System account) that step filled
 *       step: number              // index of that earlier step
 *       mode?: 0|1|2|3, num?, den?, sub?   // e.g. mode 1 num/den to spend a share of it
 *     }[]
 *     output?: { account: string; mint: string; tokenProgram?: string }  // fee'd, watched
 *   }
 *
 * SOL → LP is [swap SOL→token (output = token ATA), add (amountFrom token ATA
 * delta at the add's token-amount offset)]. zap.ts today only has opaque
 * transactions without proven add-liquidity offsets, so it stays 'sequential'
 * until each add builder reports its offsets the way the swap legs do.
 */
export type ZapComposeStep = { setup?: RawComposeInstruction[]; action: RawComposeInstruction;
  cleanup?: RawComposeInstruction[]; amountFrom?: { dataOffset: number; account: string; step: number;
    mode?: PatchMode; num?: number; den?: number; sub?: bigint }[];
  output?: { account: string; mint: string; tokenProgram?: string } | null }
const fromRaw = (ix: RawComposeInstruction) => new TransactionInstruction({ programId: new PublicKey(ix.programId),
  keys: ix.keys.map(k => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
  data: Buffer.from(ix.data, 'base64') })

export function composeZap(steps: ZapComposeStep[], { programId, payer, checks = [] }: { programId: PublicKey;
  payer: PublicKey; checks?: ComposeCheckInput[] }): ComposedRoute {
  const compose = composeInstructions({ programId, payer, checks, steps: steps.map(step => ({
    instruction: fromRaw(step.action),
    patches: (step.amountFrom ?? []).map(p => ({ ...p, watch: new PublicKey(p.account), fromStep: p.step })),
    fee: step.output ? { watch: new PublicKey(step.output.account), mint: new PublicKey(step.output.mint),
      tokenProgram: step.output.tokenProgram ? new PublicKey(step.output.tokenProgram) : undefined } : null,
  })) })
  return { compose, hops: steps.length, before: hoist(steps.flatMap(s => (s.setup ?? []).map(fromRaw))),
    after: hoist(steps.flatMap(s => (s.cleanup ?? []).map(fromRaw))) }
}
