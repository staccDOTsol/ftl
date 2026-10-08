// One-transaction zaps through the lp-zap composer. The planner's two steps
// (swap + add, or remove + swap) are rebuilt against live state exactly as the
// sequential flow builds them, then run as one composed transaction: the venue
// swap becomes a composed step, and the deposit or the swap back is sized from
// the real token-account delta the step before it left. Every data offset
// that gets patched is proven from the bytes the venue builders just produced —
// located, never guessed — and anything unprovable returns null so the caller
// falls back to one transaction per step.
import { ComputeBudgetProgram, PublicKey } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { locateU64 } from './direct-adapter.ts'
import type { PatchMode, ZapComposeStep } from './compose.ts'
import type { RawInstruction } from './zap.ts'

export const WSOL_MINT = NATIVE_MINT.toBase58()
const U32_MAX = 0xffff_ffffn
/** Smallest scaled numerator the ratio helper accepts: the relative error of a
 * dyadic approximation is under 1/this, so 1024 keeps it under ~0.1%. */
const MIN_RATIO_PRECISION = 1024n
const integer = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(v)
const gcd = (a: bigint, b: bigint): bigint => b ? gcd(b, a % b) : a

/** The best u32 num/den at or below num/den, the only scale the composer's
 * patches carry. Exact when the reduced fraction fits u32; otherwise the
 * largest power-of-two denominator whose scaled numerator still fits. Always
 * rounds down — a smaller deposit or a looser minimum can leave dust but can
 * never overspend — and null when the ratio or its precision is out of reach. */
export function u32Ratio(num: bigint, den: bigint): { num: number; den: number } | null {
  if (num <= 0n || den <= 0n || num > (1n << 64n)) return null
  const common = gcd(num, den)
  const reducedNum = num / common, reducedDen = den / common
  if (reducedNum <= U32_MAX && reducedDen <= U32_MAX) return { num: Number(reducedNum), den: Number(reducedDen) }
  for (let scale = 1n << 31n; scale >= 1n; scale /= 2n) {
    const scaled = num * scale / den
    if (scaled > U32_MAX) continue
    return scaled >= MIN_RATIO_PRECISION ? { num: Number(scaled), den: Number(scale) } : null
  }
  return null
}

/** The venue swap instruction: the single instruction whose data holds the
 * exact amount in and minimum out just quoted, each exactly once, distinct
 * and not overlapping — the same proof the direct router's legs use, so a
 * split or composed swap (whose pieces carry other amounts) never matches. */
export type SwapProof = { index: number; amountInOffset: number; minOutOffset: number }
export function proveVenueSwap(instructions: RawInstruction[], amountIn: bigint, minOut: bigint): SwapProof | null {
  let proof: SwapProof | null = null
  for (let index = 0; index < instructions.length; index++) {
    const data = Buffer.from(instructions[index].data, 'base64')
    const amountInOffset = locateU64(data, amountIn), minOutOffset = locateU64(data, minOut)
    if (amountInOffset === null || minOutOffset === null || amountInOffset === minOutOffset ||
      Math.abs(amountInOffset - minOutOffset) < 8 || data.length > 65_535) continue
    if (proof) return null
    proof = { index, amountInOffset, minOutOffset }
  }
  return proof
}

/** One proven patch site: where in the deposit's data, and how the value is
 * derived from the watched token-account delta. */
export type AddPatch = { dataOffset: number; mode: PatchMode; num?: number; den?: number }

/** A spend bound or maximum the quote also encoded, rewritten to the raw
 * delta (mode 0): the deposit may spend at most what really arrived. */
function deltaBound(data: Buffer, limitRaw: unknown): AddPatch | null {
  if (!integer(limitRaw)) return null
  const dataOffset = locateU64(data, BigInt(limitRaw))
  return dataOffset === null ? null : { dataOffset, mode: 0 }
}

/** A bound or maximum rescaled to the real delta by the quoted ratio of the
 * value to the token side (mode 1). */
function ratioBound(data: Buffer, value: unknown, anchor: bigint): AddPatch | null {
  if (!integer(value)) return null
  const dataOffset = locateU64(data, BigInt(value)), ratio = u32Ratio(BigInt(value), anchor)
  return dataOffset === null || !ratio ? null : { dataOffset, mode: 1, ...ratio }
}

/** The venue deposit instruction and its patches. Liquidity-driven venues
 * (Raydium CPMM/CLMM/AMM v4, Orca, PumpSwap) size the deposit from a
 * liquidity amount their quote reports, so that amount is rescaled to the
 * real token delta and every bound the builder encoded alongside it follows
 * the same scaling. Amount-driven venues (Meteora DLMM) cap each side with
 * the quoted amounts, so the token side becomes the delta itself and the SOL
 * side the same share of it. Unprovable means null, never a guess. */
export function proveVenueAdd(instructions: RawInstruction[], quote: any, tokenMint: string): { index: number; patches: AddPatch[] } | null {
  const debitOf = (mint: string) => (Array.isArray(quote?.amounts) ? quote.amounts : []).find((a: any) =>
    a && typeof a === 'object' && a.mint === mint && a.direction === 'debit' && integer(a.expectedRaw))
  const token = debitOf(tokenMint), sol = debitOf(WSOL_MINT)
  if (!token || BigInt(token.expectedRaw) <= 0n) return null
  const expected = BigInt(token.expectedRaw)
  const liquidity = integer(quote?.details?.liquidity) ? BigInt(quote.details.liquidity) : null
  const liquidityRatio = liquidity && liquidity > 0n ? u32Ratio(liquidity, expected) : null
  let found: { index: number; patches: AddPatch[] } | null = null
  for (let index = 0; index < instructions.length; index++) {
    const data = Buffer.from(instructions[index].data, 'base64')
    let patches: AddPatch[] | null = null
    if (liquidityRatio) {
      const liquidityOffset = locateU64(data, liquidity!)
      if (liquidityOffset === null) continue
      patches = [{ dataOffset: liquidityOffset, mode: 1, ...liquidityRatio }]
      const bound = deltaBound(data, token.limitRaw)
      if (bound && bound.dataOffset !== liquidityOffset) patches.push(bound)
      const scaled = ratioBound(data, sol?.limitRaw, expected)
      if (scaled && scaled.dataOffset !== liquidityOffset && (!bound || scaled.dataOffset !== bound.dataOffset)) patches.push(scaled)
    } else {
      const tokenOffset = locateU64(data, expected)
      if (tokenOffset === null) continue
      patches = [{ dataOffset: tokenOffset, mode: 0 }]
      const scaled = ratioBound(data, sol?.expectedRaw, expected)
      if (scaled && scaled.dataOffset !== tokenOffset) patches.push(scaled)
    }
    if (found) return null
    found = { index, patches }
  }
  return found
}

// ---- assembly ---------------------------------------------------------------

export type ComposedSwap = { instructions: RawInstruction[]; amountIn: bigint; minOut: bigint }
export type ZapInAssembly = { direction: 'in'; owner: string; tokenMint: string; tokenProgram: string;
  swap: ComposedSwap; add: { instructions: RawInstruction[]; quote: any } }
export type ZapOutAssembly = { direction: 'out'; owner: string; tokenMint: string; tokenProgram: string;
  remove: { instructions: RawInstruction[] }; swap: ComposedSwap }
export type ComposedZap = { steps: ZapComposeStep[] }

const dropBudget = (instructions: RawInstruction[]) => instructions.filter(ix => ix.programId !== ComputeBudgetProgram.programId.toBase58())
const tokenAccount = (owner: string, mint: string, program: string) =>
  getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), false, new PublicKey(program), ASSOCIATED_TOKEN_PROGRAM_ID).toBase58()

/** The composed step list for a zap. Zap in: the venue swap step feeds its
 * fee'd token output to the deposit step, whose proven fields are patched
 * from the token account's real delta since the start. Zap out: every
 * instruction of the withdrawal runs as steps so its credits are inside the
 * composer's view, then the swap back spends exactly the tokens that arrived
 * and its minimum out is scaled to them. Setup and cleanup instructions ride
 * with their own step and hoist outside the compose call. Null when a proof
 * fails or the minimum cannot be scaled.
 *
 * Boundary both ways: the deposit's SOL-side wrap is funded once, to the
 * quoted limit, so a swap that delivers more than the add's slippage
 * headroom fails the whole transaction on chain — atomic, fee-only, and
 * retried with a fresh quote — exactly the venue's own max-amount rule. */
export function assembleComposedZap(input: ZapInAssembly | ZapOutAssembly): ComposedZap | null {
  const swapInstructions = dropBudget(input.swap.instructions)
  const swapProof = proveVenueSwap(swapInstructions, input.swap.amountIn, input.swap.minOut)
  if (!swapProof) return null
  const swap = swapInstructions[swapProof.index]
  if (input.direction === 'in') {
    const addInstructions = dropBudget(input.add.instructions)
    const addProof = proveVenueAdd(addInstructions, input.add.quote, input.tokenMint)
    if (!addProof) return null
    const tokenAta = tokenAccount(input.owner, input.tokenMint, input.tokenProgram)
    return { steps: [
      { action: swap, setup: swapInstructions.slice(0, swapProof.index), cleanup: swapInstructions.slice(swapProof.index + 1),
        output: { account: tokenAta, mint: input.tokenMint, tokenProgram: input.tokenProgram } },
      { action: addInstructions[addProof.index], setup: addInstructions.slice(0, addProof.index), cleanup: addInstructions.slice(addProof.index + 1),
        amountFrom: addProof.patches.map(patch => ({ ...patch, account: tokenAta, step: 0 })) },
    ] }
  }
  const minimum = u32Ratio(input.swap.minOut, input.swap.amountIn)
  if (!minimum) return null
  const tokenAta = tokenAccount(input.owner, input.tokenMint, input.tokenProgram)
  const wsolAta = tokenAccount(input.owner, WSOL_MINT, TOKEN_PROGRAM_ID.toBase58())
  return { steps: [
    ...dropBudget(input.remove.instructions).map(action => ({ action })),
    { action: swap, setup: swapInstructions.slice(0, swapProof.index), cleanup: swapInstructions.slice(swapProof.index + 1),
      amountFrom: [
        { dataOffset: swapProof.amountInOffset, account: tokenAta, step: 0 },
        { dataOffset: swapProof.minOutOffset, account: tokenAta, step: 0, mode: 1 as PatchMode, ...minimum },
      ],
      output: { account: wsolAta, mint: WSOL_MINT, tokenProgram: TOKEN_PROGRAM_ID.toBase58() } },
  ] }
}

/** The token program that owns a mint (fees and watch accounts need it), or
 * null. `owner` here is the RPC account owner, not a wallet. */
export async function mintTokenProgram(read: (method: string, params: unknown[]) => Promise<any>, mint: string): Promise<string | null> {
  const account = await read('getAccountInfo', [mint, { encoding: 'base64', commitment: 'confirmed' }])
  const owner = account?.value?.owner
  if (owner !== TOKEN_PROGRAM_ID.toBase58() && owner !== TOKEN_2022_PROGRAM_ID.toBase58()) return null
  return owner as string
}
