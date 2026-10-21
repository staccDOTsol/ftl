// Direct Solana swaps: single pools, and (only when the lp-zap composer is
// configured) bounded two-hop routes composed on chain. Pool discovery is
// FTL's durable liquidity log; prices, account ownership and executable
// instructions come from the current chain state through our configured RPC.
// No route/transaction API.
import { Connection, ComputeBudgetProgram, PublicKey, SYSVAR_CLOCK_PUBKEY, TransactionMessage,
  VersionedTransaction, type AddressLookupTableAccount, type TransactionInstruction } from '@solana/web3.js'
import { CpAmm, CP_AMM_PROGRAM_ID, SwapMode, getTokenProgram } from '@meteora-ag/cp-amm-sdk'
import { OnlinePumpAmmSdk, PUMP_AMM_SDK, PUMP_AMM_PROGRAM_ID,
  buyQuoteInput, sellBaseInput, supportsTradeV2 } from '@pump-fun/pump-swap-sdk'
import BN from 'bn.js'
import { NATIVE_MINT, createCloseAccountInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { db } from '../db.ts'
import { decodeV1 } from './transaction-v1.ts'
import { DirectVenueError, mintAta, programOf, stripNativeWrapping, swapMints, venueLeg,
  type DirectLeg, type DirectPrice, type SwapMint } from './direct-adapter.ts'
import { ComposeError, FEE_BPS, FEE_RECIPIENT, afterComposerFee, composeRoute, finalHopMinimum, type ComposeLeg } from './compose.ts'
import { marketsByMint, positionTail } from './position.ts'
import { quoteMeteoraDlmm } from './direct-meteora-dlmm.ts'
import { quoteOrcaWhirlpool } from './direct-orca.ts'
import { quoteRaydiumCpmm } from './direct-raydium-cpmm.ts'
import { quoteRaydiumClmm } from './direct-raydium-clmm.ts'
import { replayDecodedSwap, tokenAccountAmount } from './direct-decoded.ts'
import { decodedSwapTemplates, type DecodedSwapTemplate } from './program-service.ts'
// KNOWN (2026-10-13): the decoded-route source below reads `config` without importing it. The ReferenceError is caught
// by its caller, so decoded routes have never run in production since the last commit. Do not just add the import: quotes
// run in their own worker (quote-boot.mjs), and decodedSwapTemplates() there would spawn a SECOND program-index worker,
// a second writer on programs.db with its own retention, learning loop and disk floor. Turn it on only by reading
// templates read-only from the quote worker, or by asking the main thread's index over the gate channel.
import { discoverPools } from './birdeye-markets.ts'
import { RATE_LIMITED_MESSAGE, RATE_LIMITED_RETRY_AFTER_S, createResilientFetch, isTransientRpcError,
  rpcScope, runInRpcScope, type ResilientFetch, type ResilientFetchOptions } from './rpc-resilience.ts'

const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
const ASSOCIATED_TOKEN = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const SYSTEM = new PublicKey('11111111111111111111111111111111')
const COMPUTE_BUDGET = ComputeBudgetProgram.programId
const ALLOWED_PROGRAMS = new Set([TOKEN, TOKEN_2022, ASSOCIATED_TOKEN, SYSTEM,
  COMPUTE_BUDGET, CP_AMM_PROGRAM_ID, PUMP_AMM_PROGRAM_ID,
  new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'),
  new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'),
  new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'),
  new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK')].map(p => p.toBase58()))
const U64_MAX = (1n << 64n) - 1n
const VENUE_LABELS: Record<string, string> = {
  'meteora-damm-v2': 'Meteora DAMM v2', pumpswap: 'PumpSwap',
  'meteora-dlmm': 'Meteora DLMM', orca: 'Orca Whirlpool',
  'raydium-cpmm': 'Raydium CPMM', 'raydium-clmm': 'Raydium CLMM',
}
export const DIRECT_SOLANA_VENUES = Object.keys(VENUE_LABELS)

type Pool = { address: string; venue: string; mint_a: string; mint_b: string; liq_events: number }
export type LocalIntent = { inputMint: string; outputMint: string; amount: string;
  slippageBps: number; transactionVersion: '0' | '1'; keepNative?: 'input' | 'output' | 'both'
  /** Flip which mint is longed and which is shorted. */
  badBeat?: boolean
  /** ?ref= wallet. Its r-fstacc account receives the stake-pool referral slice. */
  ref?: string }
export type Priced = { pool: Pool; out: bigint; minimum: bigint; fee: bigint; feeMint: string;
  instructions: (wallet: PublicKey, minimum: bigint) => Promise<TransactionInstruction[]>;
  leg: (wallet: PublicKey, minimum: bigint) => Promise<DirectLeg> }
type RoutePlanEntry = { percent: number; swapInfo: { ammKey: string; label: string; inputMint: string;
  outputMint: string; inAmount: string; outAmount: string; feeAmount: string; feeMint: string } }
/** What a candidate builds: outer instructions, any extra outer program the
 * emitter must allow (the composer), and the compute budget to request. */
export type BuiltRoute = { instructions: TransactionInstruction[]; allowPrograms: PublicKey[];
  computeUnitLimit: number
  /** More signatures after the first, when the 100× buys do not fit beside the swap. */
  followups?: { instructions: TransactionInstruction[]; allowPrograms: PublicKey[]; computeUnitLimit: number }[]
  /** A decoded route: the wallet's output token account and its pre-replay
   * balance, so the simulated outcome can be checked against the floor. */
  output?: { address: string; preAmount: bigint } }
/** One executable route: a single pool, several pools composed into one
 * on-chain composer call whose later hops are sized from real deltas, or one
 * landed swap replayed through a program FTL learned by observation. */
export type Candidate = { out: bigint; minimum: bigint; hops: number; plan: RoutePlanEntry[];
  decoded?: { program: string; name: string | null }
  /** The lp-zap composer is the outer program, including a one-hop swap. */
  composed?: boolean
  build: (wallet: PublicKey, floor: bigint) => Promise<BuiltRoute> }
export const MAX_INTERMEDIATES = 2
export const MAX_POOLS_PER_HOP = 2
/** Pools we actually read on chain. The long tail is dust next to the busiest edge. */
const MAX_PRICED_POOLS = 1
/** An edge quieter than this share of the busiest pool is not priced. */
const EDGE_SHARE = 0.05
/** A pair whose busiest pool has been touched this little is one pool, not a hop hub. */
const THIN_EVENTS = 8

/** Busiest edges only. The leader is always kept, so a one-pool coin still quotes. */
export function fatEdges(rows: Pool[]): Pool[] {
  if (!rows.length) return []
  const floor = Math.max(1, Math.floor(rows[0].liq_events * EDGE_SHARE))
  return rows.filter((row, i) => i === 0 || row.liq_events >= floor).slice(0, MAX_PRICED_POOLS)
}

// A pair with its own (single or quiet) pool routes there and skips the via hunt. A pair with no pool of its own is not
// thin: the two-hop route through a common mint is the only route it has.
const thinPair = (rows: Pool[]) => rows.length >= 1 && (rows.length === 1 || rows[0].liq_events < THIN_EVENTS)
/** The pre-2026-10-13 route-level 100× tail (position.ts). Off: legs are per hop now (router.ts attachLegs). */
const ROUTE_TAIL = process.env.ROUTE_POSITION_TAIL === '1'
const SINGLE_CU = 800_000
const COMPOSED_CU = 1_400_000

async function quotePool(connection: Connection, pool: Pool, intent: LocalIntent): Promise<Priced> {
  if (pool.venue === 'meteora-damm-v2') return quoteDamm(connection, pool, intent)
  if (pool.venue === 'pumpswap') return quotePump(connection, pool, intent)
  const adapters: Record<string, (connection: Connection, pool: Pool,
    intent: LocalIntent) => Promise<DirectPrice>> = {
    'meteora-dlmm': quoteMeteoraDlmm,
    orca: quoteOrcaWhirlpool,
    'raydium-cpmm': quoteRaydiumCpmm,
    'raydium-clmm': quoteRaydiumClmm,
  }
  const adapter = adapters[pool.venue]
  if (!adapter) return noRoute(`Direct swaps are not implemented for ${pool.venue}`)
  return { pool, ...await adapter(connection, pool, intent) }
}

export function rankDirectCandidates<T extends { out: bigint; minimum: bigint }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.out === b.out
    ? a.minimum === b.minimum ? 0 : a.minimum > b.minimum ? -1 : 1
    : a.out > b.out ? -1 : 1)
}

export class DirectRouteError extends Error {
  readonly status: number
  /** Seconds a client should wait; set only on transient (rate-limited) failures. */
  readonly retryAfter: number | undefined
  /** The failure says nothing about whether a route exists: RPC was unavailable. */
  readonly transient: boolean
  constructor(status: number, message: string, retryAfter?: number) {
    super(message); this.status = status; this.retryAfter = retryAfter; this.transient = retryAfter !== undefined
  }
}
/** Candidate pools exist but RPC failures kept every attempt from pricing them. */
export const rateLimited = () => new DirectRouteError(503, RATE_LIMITED_MESSAGE, RATE_LIMITED_RETRY_AFTER_S)
const isRateLimited = (error: unknown) => error instanceof DirectRouteError && error.transient
const noRoute = (reason = 'No executable direct pool route is available for this pair and amount'):
  never => { throw new DirectRouteError(404, reason) }
const atomic = (value: string): bigint => {
  if (!/^[1-9][0-9]{0,19}$/.test(value)) throw new DirectRouteError(400, 'Invalid atomic amount')
  const n = BigInt(value)
  if (n > U64_MAX) throw new DirectRouteError(400, 'Atomic amount exceeds u64')
  return n
}
const bn = (n: bigint): BN => new BN(n.toString())
const pctMinimum = (out: bigint, bps: number) => out * BigInt(10_000 - bps) / 10_000n
/** A leg around instructions an SDK built with its own SOL wrapping: strip
 * the wrapping keepNative asks to skip, then prove the swap's offsets. The
 * wallet accounts are the ATAs under each pool mint's own token program. */
const sdkLeg = (instructions: TransactionInstruction[], wallet: PublicKey, program: PublicKey,
  intent: LocalIntent, amount: bigint, floor: bigint, mints: readonly SwapMint[]): DirectLeg => {
  const outputProgram = programOf(mints, intent.outputMint)
  return venueLeg(stripNativeWrapping(instructions, wallet, intent.keepNative), program, amount, floor,
    mintAta(wallet, new PublicKey(intent.inputMint), programOf(mints, intent.inputMint)),
    mintAta(wallet, new PublicKey(intent.outputMint), outputProgram), outputProgram)
}
const toBig = (value: { toString(): string }): bigint => BigInt(value.toString())
const pairMatches = (a: string, b: string, intent: LocalIntent) =>
  (a === intent.inputMint && b === intent.outputMint) ||
  (a === intent.outputMint && b === intent.inputMint)

function poolRows(intent: Pick<LocalIntent, 'inputMint' | 'outputMint'>): Pool[] {
  return db.prepare(`SELECT address,venue,mint_a,mint_b,liq_events FROM pools
    WHERE chain='solana' AND funded=1 AND mint_a IS NOT NULL AND mint_b IS NOT NULL
      AND ((mint_a=? AND mint_b=?) OR (mint_a=? AND mint_b=?))
    ORDER BY liq_events DESC, created_ts DESC LIMIT 16`).all(intent.inputMint, intent.outputMint,
      intent.outputMint, intent.inputMint) as Pool[]
}
/** Mints that have a funded, supported pool against both ends of the pair,
 * most active first. Only the composer path reads this. */
export function intermediateMints(inputMint: string, outputMint: string, limit = MAX_INTERMEDIATES): string[] {
  const venues = DIRECT_SOLANA_VENUES.map(() => '?').join(',')
  return (db.prepare(`WITH edges AS (
      SELECT CASE WHEN mint_a=? THEN mint_b ELSE mint_a END AS via, liq_events, 0 AS side FROM pools
        WHERE chain='solana' AND funded=1 AND liq_events >= 4 AND venue IN (${venues}) AND (mint_a=? OR mint_b=?)
      UNION ALL
      SELECT CASE WHEN mint_a=? THEN mint_b ELSE mint_a END AS via, liq_events, 1 AS side FROM pools
        WHERE chain='solana' AND funded=1 AND liq_events >= 4 AND venue IN (${venues}) AND (mint_a=? OR mint_b=?))
    SELECT via FROM edges WHERE via IS NOT NULL AND via NOT IN (?, ?)
    GROUP BY via HAVING COUNT(DISTINCT side)=2
    ORDER BY SUM(liq_events) DESC LIMIT ?`).all(
    inputMint, ...DIRECT_SOLANA_VENUES, inputMint, inputMint,
    outputMint, ...DIRECT_SOLANA_VENUES, outputMint, outputMint,
    inputMint, outputMint, limit) as { via: string }[]).map(row => row.via)
}

/** Both pool mints with their real token programs: classic SPL, or Token-2022
 * carrying only extensions that leave exact-in pricing and in-kind fees intact. */
async function poolMints(connection: Connection, a: PublicKey, b: PublicKey): Promise<[SwapMint, SwapMint]> {
  try { return await swapMints(connection, a, b) } catch (error) {
    if (error instanceof DirectVenueError) noRoute(error.message)
    throw error
  }
}

async function chainPoint(connection: Connection, activationType: number): Promise<BN> {
  // The Clock sysvar gives both slot and validator-derived Unix time in one
  // current-state read. getBlockTime(latest confirmed slot) often returns
  // "Block not available" even while the pool and slot are current.
  const { context, value } = await connection.getAccountInfoAndContext(SYSVAR_CLOCK_PUBKEY, 'confirmed')
  if (!value || value.data.length < 40) return noRoute('Current on-chain clock is unavailable')
  const slot = value.data.readBigUInt64LE(0)
  const unixTime = value.data.readBigInt64LE(32)
  if (slot > BigInt(context.slot) || BigInt(context.slot) - slot > 32n ||
    unixTime <= 0n || unixTime > BigInt(Number.MAX_SAFE_INTEGER))
    noRoute('Current on-chain clock is stale or invalid')
  return bn(activationType === 0 ? slot : unixTime)
}

async function quoteDamm(connection: Connection, pool: Pool, intent: LocalIntent): Promise<Priced> {
  const key = new PublicKey(pool.address)
  const account = await connection.getAccountInfo(key, 'confirmed')
  if (!account?.owner.equals(CP_AMM_PROGRAM_ID)) noRoute('FTL pool owner does not match Meteora DAMM v2')
  const amm = new CpAmm(connection)
  const state = await amm.fetchPoolState(key)
  const a = state.tokenAMint, b = state.tokenBMint
  if (!pairMatches(a.toBase58(), b.toBase58(), intent) ||
    !pairMatches(pool.mint_a, pool.mint_b, intent)) noRoute('FTL pool mints do not match chain state')
  const mints = await poolMints(connection, a, b)
  // The pool's own token flags must name the program that owns each mint.
  if (!getTokenProgram(state.tokenAFlag).equals(mints[0].tokenProgram) ||
    !getTokenProgram(state.tokenBFlag).equals(mints[1].tokenProgram))
    noRoute('DAMM v2 pool token programs do not match its mints')
  const point = await chainPoint(connection, state.activationType)
  const amount = atomic(intent.amount)
  const result = amm.getQuote2({ inputTokenMint: new PublicKey(intent.inputMint),
    slippage: intent.slippageBps / 100, currentPoint: point, poolState: state,
    tokenADecimal: mints[0].decimals, tokenBDecimal: mints[1].decimals, hasReferral: false,
    swapMode: SwapMode.ExactIn, amountIn: bn(amount) })
  const out = toBig(result.outputAmount)
  const minimum = toBig(result.minimumAmountOut ?? bn(pctMinimum(out, intent.slippageBps)))
  const fee = toBig(result.claimingFee) + toBig(result.protocolFee) +
    toBig(result.compoundingFee) + toBig(result.referralFee)
  if (out <= 0n || minimum <= 0n || minimum > out) noRoute('Pool cannot fill this amount')
  // DAMM v2 `swap2`: discriminator, amount_0 (exact in) u64, amount_1
  // (minimum out) u64, swap_mode. The leg proves both offsets from the data.
  const leg = async (wallet: PublicKey, protectedMinimum: bigint): Promise<DirectLeg> => {
    // Re-fetching the pool for the swap and the router's requote occurs at
    // request time; the chain instruction enforces the older stricter floor.
    const tx = await amm.swap2({ payer: wallet, pool: key,
      inputTokenMint: new PublicKey(intent.inputMint),
      outputTokenMint: new PublicKey(intent.outputMint),
      tokenAMint: a, tokenBMint: b, tokenAVault: state.tokenAVault,
      tokenBVault: state.tokenBVault, tokenAProgram: mints[0].tokenProgram,
      tokenBProgram: mints[1].tokenProgram,
      referralTokenAccount: null, poolState: state, swapMode: SwapMode.ExactIn,
      amountIn: bn(amount), minimumAmountOut: bn(protectedMinimum) })
    return sdkLeg(tx.instructions, wallet, CP_AMM_PROGRAM_ID, intent, amount, protectedMinimum, mints)
  }
  return { pool, out, minimum, fee, feeMint: intent.inputMint, leg,
    instructions: async (wallet, protectedMinimum) => (await leg(wallet, protectedMinimum)).instructions }
}

async function quotePump(connection: Connection, pool: Pool, intent: LocalIntent): Promise<Priced> {
  const key = new PublicKey(pool.address)
  const account = await connection.getAccountInfo(key, 'confirmed')
  if (!account?.owner.equals(PUMP_AMM_PROGRAM_ID)) noRoute('FTL pool owner does not match PumpSwap')
  // Quote pricing is independent of the user. The actual wallet state is
  // fetched again during build so ATA creation and wSOL wrapping are exact.
  const online = new OnlinePumpAmmSdk(connection)
  const state = await online.swapSolanaState(key, SYSTEM)
  const base = state.baseMint.toBase58(), quote = state.pool.quoteMint.toBase58()
  if (!pairMatches(base, quote, intent) || !pairMatches(pool.mint_a, pool.mint_b, intent))
    noRoute('FTL pool mints do not match chain state')
  // Pump coins are Token-2022. Benign extensions (metadata, an unset hook)
  // price and settle like classic mints; anything else is refused here.
  const mints = await poolMints(connection, state.baseMint, state.pool.quoteMint)
  if (!state.baseTokenProgram.equals(mints[0].tokenProgram) || !state.quoteTokenProgram.equals(mints[1].tokenProgram))
    noRoute('PumpSwap token programs do not match the pool mints')
  if (state.poolBaseAmount.isZero() || state.poolQuoteAmount.isZero()) noRoute('Pool has no swap reserves')
  // Pump's V2 SDK randomly selects a listed buyback fee recipient. Several
  // listed recipients can lack the required quote ATA; those randomly built
  // swaps fail on chain. Require a live, canonical ATA and pin that recipient.
  const buybackRecipient = supportsTradeV2(state.pool)
    ? await validBuybackRecipient(connection, state) : null
  const amount = bn(atomic(intent.amount))
  const params = { baseReserve: state.poolBaseAmount, quoteReserve: state.poolQuoteAmount,
    virtualQuoteReserves: state.pool.virtualQuoteReserves,
    globalConfig: state.globalConfig, baseMintAccount: state.baseMintAccount,
    baseMint: state.baseMint, coinCreator: state.pool.coinCreator, creator: state.pool.creator,
    feeConfig: state.feeConfig, quoteMint: state.pool.quoteMint,
    isMayhemMode: state.pool.isMayhemMode, creatorFeeBps: state.pool.creatorFeeBps }
  const buy = intent.inputMint === quote
  if (buy && !supportsTradeV2(state.pool))
    noRoute('This PumpSwap pool does not support exact quote-in buys')
  const result = buy ? buyQuoteInput({ ...params, quote: amount, slippage: 0 })
    : sellBaseInput({ ...params, base: amount, slippage: 0,
      feeBucketsTotal: state.pool.protocolFees.add(state.pool.creatorFees) })
  const out = toBig(buy ? (result as ReturnType<typeof buyQuoteInput>).base
    : (result as ReturnType<typeof sellBaseInput>).uiQuote)
  const minimum = pctMinimum(out, intent.slippageBps)
  const fee = buy ? toBig(amount) - toBig((result as ReturnType<typeof buyQuoteInput>).internalQuoteWithoutFees)
    : toBig((result as ReturnType<typeof sellBaseInput>).internalQuoteAmountOut) - out
  if (out <= 0n || minimum <= 0n || fee < 0n) noRoute('Pool cannot fill this amount')
  // PumpSwap `buy_exact_quote_in_v2` / `sell(_v2)`: discriminator, exact
  // amount in u64, minimum out u64. The leg proves both offsets from the data.
  const leg = async (wallet: PublicKey, protectedMinimum: bigint): Promise<DirectLeg> => {
    const fresh = await online.swapSolanaState(key, wallet)
    if (!fresh.baseMint.equals(state.baseMint) || !fresh.pool.quoteMint.equals(state.pool.quoteMint) ||
      !fresh.baseTokenProgram.equals(state.baseTokenProgram) || !fresh.quoteTokenProgram.equals(state.quoteTokenProgram))
      noRoute('Pool mints changed before swap build')
    const pinned = supportsTradeV2(fresh.pool) ? {
      ...fresh,
      globalConfig: { ...fresh.globalConfig,
        buybackFeeRecipients: [await validBuybackRecipient(connection, fresh, buybackRecipient)] },
    } : fresh
    const instructions = await (buy
      ? PUMP_AMM_SDK.buyExactQuoteInV2Instructions(pinned, amount, bn(protectedMinimum))
      : supportsTradeV2(pinned.pool)
        ? PUMP_AMM_SDK.sellV2Instructions(pinned, amount, bn(protectedMinimum))
        : PUMP_AMM_SDK.sellInstructions(fresh, amount, bn(protectedMinimum)))
    return sdkLeg(instructions, wallet, PUMP_AMM_PROGRAM_ID, intent, toBig(amount), protectedMinimum, mints)
  }
  return { pool, out, minimum, fee, feeMint: quote, leg,
    instructions: async (wallet, protectedMinimum) => (await leg(wallet, protectedMinimum)).instructions }
}

async function validBuybackRecipient(connection: Connection,
  state: Awaited<ReturnType<OnlinePumpAmmSdk['swapSolanaState']>>,
  preferred: PublicKey | null = null): Promise<PublicKey> {
  const recipients = state.globalConfig.buybackFeeRecipients
  if (!recipients.length) noRoute('PumpSwap has no buyback fee recipient')
  const ordered = preferred && recipients.some(x => x.equals(preferred))
    ? [preferred, ...recipients.filter(x => !x.equals(preferred))] : recipients
  const accounts = await connection.getMultipleAccountsInfo(ordered.map(recipient =>
    getAssociatedTokenAddressSync(state.pool.quoteMint, recipient, true, state.quoteTokenProgram)),
    'confirmed')
  for (let i = 0; i < accounts.length; i++) {
    const info = accounts[i]
    if (info?.owner.equals(state.quoteTokenProgram) && info.data.length >= 165 &&
      info.data.subarray(0, 32).equals(state.pool.quoteMint.toBuffer()) &&
      info.data.subarray(32, 64).equals(ordered[i].toBuffer()) && info.data[108] === 1)
      return ordered[i]
  }
  return noRoute('PumpSwap buyback fee accounts are unavailable for this quote mint')
}

export type EmitOptions = { allowPrograms?: PublicKey[] }
function validateInstructions(instructions: TransactionInstruction[], payer: PublicKey,
  options: EmitOptions = {}): void {
  if (!instructions.length || instructions.length > 64) throw new DirectRouteError(422, 'Unsupported transaction instruction count')
  const extra = new Set((options.allowPrograms ?? []).map(p => p.toBase58()))
  for (const ix of instructions) {
    if (!ALLOWED_PROGRAMS.has(ix.programId.toBase58()) && !extra.has(ix.programId.toBase58()))
      throw new DirectRouteError(422, 'Direct pool SDK produced an unsupported program')
    if (ix.keys.some(key => key.isSigner && !key.pubkey.equals(payer)))
      throw new DirectRouteError(422, 'Direct swap unexpectedly requires another signer')
  }
}

export function unsignedV1(payer: PublicKey, blockhash: string,
  instructions: TransactionInstruction[], computeUnitLimit = 800_000, options: EmitOptions = {}): string {
  validateInstructions(instructions, payer, options)
  const flags = new Map<string, { key: PublicKey; writable: boolean }>()
  flags.set(payer.toBase58(), { key: payer, writable: true })
  for (const ix of instructions) {
    for (const meta of ix.keys) {
      const id = meta.pubkey.toBase58(), old = flags.get(id)
      if (!old) flags.set(id, { key: meta.pubkey, writable: meta.isWritable })
      else old.writable ||= meta.isWritable
    }
    const id = ix.programId.toBase58()
    if (!flags.has(id)) flags.set(id, { key: ix.programId, writable: false })
  }
  const entries = [...flags.values()].filter(x => !x.key.equals(payer))
  const writable = entries.filter(x => x.writable), readonly = entries.filter(x => !x.writable)
  const keys = [{ key: payer, writable: true }, ...writable, ...readonly]
  if (keys.length > 64) throw new DirectRouteError(422, 'Direct swap needs too many accounts for V1')
  const index = new Map(keys.map((x, i) => [x.key.toBase58(), i]))
  const headers = Buffer.alloc(instructions.length * 4)
  const payload: Buffer[] = []
  for (let i = 0; i < instructions.length; i++) {
    const ix = instructions[i]
    if (ix.keys.length > 255 || ix.data.length > 65_535)
      throw new DirectRouteError(422, 'Direct swap instruction exceeds V1 limits')
    headers[i * 4] = index.get(ix.programId.toBase58())!
    headers[i * 4 + 1] = ix.keys.length
    headers.writeUInt16LE(ix.data.length, i * 4 + 2)
    payload.push(Buffer.from(ix.keys.map(k => index.get(k.pubkey.toBase58())!)), Buffer.from(ix.data))
  }
  const config = Buffer.alloc(8)
  config.writeUInt32LE(computeUnitLimit, 0)
  config.writeUInt32LE(64 * 1024 * 1024, 4)
  const head = Buffer.alloc(42)
  head[0] = 0x81; head[1] = 1; head[2] = 0; head[3] = readonly.length
  head.writeUInt32LE(12, 4)
  new PublicKey(blockhash).toBuffer().copy(head, 8)
  head[40] = instructions.length; head[41] = keys.length
  const wire = Buffer.concat([head, ...keys.map(x => x.key.toBuffer()), config,
    headers, ...payload, Buffer.alloc(64)])
  if (wire.length > 4096) throw new DirectRouteError(422, 'Direct swap exceeds the 4096-byte V1 limit')
  decodeV1(wire, { requireResources: true })
  return wire.toString('base64')
}

export function unsignedV0(payer: PublicKey, blockhash: string, instructions: TransactionInstruction[],
  computeUnitLimit = 800_000, options: EmitOptions & { addressLookupTables?: AddressLookupTableAccount[] } = {}): string {
  validateInstructions(instructions, payer, options)
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }), ...instructions] })
    .compileToV0Message(options.addressLookupTables)
  const wire = Buffer.from(new VersionedTransaction(message).serialize())
  if (wire.length > 1232) throw new DirectRouteError(422, 'Direct swap exceeds the V0 transaction limit; use a V1 wallet')
  return wire.toString('base64')
}

const SIZE_HASH = PublicKey.default.toBase58()
/** True when the instructions fit one v0 packet or one hand-rolled v1 packet. */
function packetFits(payer: PublicKey, instructions: TransactionInstruction[], allow: PublicKey[], cu: number): boolean {
  const opts = { allowPrograms: allow }
  try {
    unsignedV0(payer, SIZE_HASH, instructions, cu, opts)
    return true
  } catch (error) {
    const msg = error instanceof Error ? error.message : ''
    if (!/overruns|V0 transaction limit|use a V1/i.test(msg)) throw error
  }
  try {
    unsignedV1(payer, SIZE_HASH, instructions, cu, opts)
    return true
  } catch (error) {
    const msg = error instanceof Error ? error.message : ''
    if (/too many accounts|4096|V1/i.test(msg)) return false
    throw error
  }
}

function emitWire(payer: PublicKey, blockhash: string, instructions: TransactionInstruction[],
  allow: PublicKey[], cu: number): string {
  const opts = { allowPrograms: allow }
  try { return unsignedV0(payer, blockhash, instructions, cu, opts) }
  catch (error) {
    const msg = error instanceof Error ? error.message : ''
    if (!/overruns|V0 transaction limit|use a V1/i.test(msg)) throw error
    return unsignedV1(payer, blockhash, instructions, cu, opts)
  }
}

export function directRouterCoverage() {
  const rows = db.prepare(`SELECT venue,COUNT(*) AS pools FROM pools
    WHERE chain='solana' AND funded=1 GROUP BY venue ORDER BY pools DESC`).all() as
    { venue: string; pools: number }[]
  return { source: 'FTL-funded pools + current on-chain state via configured Solana RPC',
    supportedVenues: DIRECT_SOLANA_VENUES,
    fundedPoolsByVenue: Object.fromEntries(rows.map(r => [r.venue, r.pools])),
    unsupportedFundedVenues: rows.filter(r => !DIRECT_SOLANA_VENUES.includes(r.venue))
      .map(r => ({ venue: r.venue, pools: r.pools })) }
}

export type DirectRouterOptions = {
  /** lp-zap composer program id. Two-hop routes are discovered only when set. */
  composerProgramId?: string
  /** Source of landed swaps through decoded programs (tests inject fakes). */
  decodedSwapSource?: (inputMint: string, outputMint: string, limit: number) => Promise<DecodedSwapTemplate[]>
  /** RPC wrapper overrides (tests: underlying fetch, clock, sleep). */
  rpc?: ResilientFetchOptions
}
type Attempt = { ok: Priced } | { error: unknown; transient: boolean }
const reasonOf = (error: unknown, fallback: string) =>
  error instanceof DirectRouteError || error instanceof DirectVenueError || error instanceof ComposeError
    ? error.message : fallback

export class DirectSolanaRouter {
  private readonly connection: Connection
  private readonly rpcUrl: string
  private readonly composer: PublicKey | null
  /** Landed swaps through decoded programs; returns [] when discovery is off. */
  private readonly decodedSource: (inputMint: string, outputMint: string, limit: number) => Promise<DecodedSwapTemplate[]>
  /** Retrying, de-duplicating, scope-memoizing fetch behind the Connection. */
  readonly rpcFetch: ResilientFetch
  /** Prices one pool; an instance field so tests can supply fake pool state. */
  private quotePool: (pool: Pool, intent: LocalIntent) => Promise<Priced>
  constructor(rpcUrl: string, options: DirectRouterOptions = {}) {
    this.rpcUrl = rpcUrl
    this.rpcFetch = createResilientFetch(options.rpc)
    this.connection = new Connection(rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true,
      fetch: this.rpcFetch as any })
    this.composer = options.composerProgramId ? new PublicKey(options.composerProgramId) : null
    // Only a discovery-enabled process consults the frontier; anywhere else
    // (tests, a discovery-off deploy) the source stays empty.
    this.decodedSource = options.decodedSwapSource ?? ((inputMint, outputMint, limit) =>
      config.programDiscovery ? decodedSwapTemplates(inputMint, outputMint, limit) : Promise.resolve([]))
    this.quotePool = (pool, intent) => quotePool(this.connection, pool, intent)
  }
  /** Prices one pool inside a memo scope (pool/config reads may be served
   * from the short memo; no wallet is involved in pricing) and says whether a
   * failure came from RPC unavailability rather than from the pool. */
  private async attemptPool(row: Pool, intent: LocalIntent): Promise<Attempt> {
    const scope = rpcScope({ memo: true })
    try {
      return { ok: await runInRpcScope(scope, () => this.quotePool(row, intent)) }
    } catch (error) {
      return { error, transient: scope.transient > 0 || isTransientRpcError(error) }
    }
  }
  /** Reads outside pricing (slot, blockhash): an RPC give-up becomes the 503. */
  private async rpcRead<T>(read: () => Promise<T>): Promise<T> {
    try { return await read() } catch (error) { throw isTransientRpcError(error) ? rateLimited() : error }
  }
  private async singlePool(intent: LocalIntent): Promise<Priced[]> {
    const local = poolRows(intent)
    const supportedLocal = local.filter(row => row.venue in VENUE_LABELS)
    // Indexed young pools win. Birdeye is only the miss: established pairs such as SOL/USDT.
    const discovered = supportedLocal.length ? [] : await discoverPools(intent.inputMint, intent.outputMint)
    const supported = supportedLocal.length ? supportedLocal : discovered
    if (!supported.length) {
      if (!local.length) return noRoute()
      const venues = [...new Set(local.map(row => row.venue))].sort().join(', ')
      return noRoute(`FTL has funded pools for this pair, but direct swaps are not implemented for: ${venues}`)
    }
    let lastReason: string | null = null, transient = 0
    const priced: Priced[] = []
    // Dust edges are not priced. A discovered pair tries the few deepest supported pools.
    const edges = discovered.length ? supported.slice(0, 3) : fatEdges(supported)
    const results = await Promise.all(edges.map(row => this.attemptPool(row, intent)))
    for (const result of results) {
      if ('ok' in result) priced.push(result.ok)
      else if (result.transient) transient++
      else lastReason = reasonOf(result.error, 'Pool state or quote is unavailable')
    }
    if (priced.length) return rankDirectCandidates(priced)
    // A pool whose state could not be read has not shown it cannot fill;
    // "no route" would be a false answer while the RPC is rate-limiting.
    if (transient) throw rateLimited()
    const missing = [...new Set(local.filter(row => !(row.venue in VENUE_LABELS))
      .map(row => row.venue))].sort()
    return noRoute([lastReason ?? 'No supported pool can fill this amount',
      ...(missing.length ? [`Other funded venues still lack direct swap support: ${missing.join(', ')}`] : [])]
      .join('. '))
  }
  private single(priced: Priced, intent: LocalIntent): Candidate {
    const composer = this.composer
    if (!composer) return { out: priced.out, minimum: priced.minimum, hops: 1,
      plan: [planEntry(priced, intent.inputMint, intent.outputMint, intent.amount)],
      build: async (wallet, floor) => ({ instructions: await priced.instructions(wallet, floor),
        allowPrograms: [], computeUnitLimit: SINGLE_CU }) }
    const out = afterComposerFee(priced.out)
    return { out, minimum: pctMinimum(out, intent.slippageBps), hops: 1, composed: true,
      plan: [planEntry(priced, intent.inputMint, intent.outputMint, intent.amount)],
      build: async (wallet, floor) => {
        const leg = await priced.leg(wallet, finalHopMinimum(floor))
        return this.finish([{ leg, outputMint: new PublicKey(intent.outputMint) }], wallet, floor, intent, false)
      } }
  }
  /** Venue hops through the composer, then the 10 bp long/short when both
   * 100x markets are listed. `closeEmptyVia` returns rent on an intermediate
   * WSOL account this route created, unless the position tail already closes it. */
  private async finish(legs: ComposeLeg[], wallet: PublicKey, floor: bigint, intent: LocalIntent,
    closeEmptyVia: boolean): Promise<BuiltRoute> {
    const composer = this.composer
    if (!composer) throw new DirectRouteError(500, 'Composer is not configured')
    const last = legs[legs.length - 1]
    const outputIsSol = last.outputMint.equals(NATIVE_MINT)
    // The 10 bp 100× legs are per hop now and come from 100x.broker (router.ts attachLegs), funded in SOL as their own
    // transactions. The old route-level tail (one long/short on the route's two ends, skipped whenever SOL was an end)
    // stays off so a swap is never charged twice.
    let plan: Awaited<ReturnType<typeof positionTail>> = null
    if (ROUTE_TAIL) try {
      plan = await positionTail({
        connection: this.connection, wallet,
        soldMint: intent.inputMint, boughtMint: intent.outputMint,
        outputAccount: last.leg.outputAccount, outputIsSol, hopStep: legs.length - 1, floor,
        badBeat: intent.badBeat === true,
        ref: intent.ref ? new PublicKey(intent.ref) : null,
        slice: outputIsSol ? null : async () => {
          const amount = floor > 10_000n ? floor / 100n : floor
          const hop = await this.bestHop({ ...intent, inputMint: intent.outputMint,
            outputMint: NATIVE_MINT.toBase58(), amount: amount.toString(), keepNative: 'output' })
          if (!hop.best) return null
          const leg = await hop.best.leg(wallet, hop.best.minimum > 0n ? hop.best.minimum : 1n)
          return { leg, quotedIn: amount, solMin: hop.best.minimum }
        },
      })
    } catch (error) {
      throw error instanceof DirectRouteError ? error
        : new DirectRouteError(422, error instanceof Error ? error.message : '100× position failed')
    }
    const tail = plan?.compose
    const used = tail && outputIsSol ? legs.map((leg, i) => i === legs.length - 1 ? dropWsolClose(leg) : leg) : legs
    const route = composeRoute(used, wallet, floor, composer, tail)
    const combined = [...route.before, route.compose, ...route.after]
    // The venue hop plus both DBC buys locks more than 64 accounts. Sign the
    // swap first, then the slice, the stake deposit, and each 100× buy.
    if (plan && !packetFits(wallet, combined, [composer], COMPOSED_CU)) {
      const bare = composeRoute(legs, wallet, floor, composer)
      const bareAfter = [...bare.after]
      if (closeEmptyVia) {
        const wsol = mintAta(wallet, NATIVE_MINT)
        if (!await this.connection.getAccountInfo(wsol, 'confirmed'))
          bareAfter.push(createCloseAccountInstruction(wsol, wallet, wallet))
      }
      return { instructions: [...bare.before, bare.compose, ...bareAfter],
        allowPrograms: [composer], computeUnitLimit: COMPOSED_CU,
        followups: plan.batches.map(batch => ({ instructions: batch.instructions,
          allowPrograms: batch.allow, computeUnitLimit: SINGLE_CU })) }
    }
    const after = [...route.after]
    if (!tail && closeEmptyVia) {
      const wsol = mintAta(wallet, NATIVE_MINT)
      if (!await this.connection.getAccountInfo(wsol, 'confirmed'))
        after.push(createCloseAccountInstruction(wsol, wallet, wallet))
    }
    return { instructions: [...route.before, route.compose, ...after],
      allowPrograms: [composer], computeUnitLimit: COMPOSED_CU }
  }
  /** Best of at most MAX_POOLS_PER_HOP supported pools for one hop. */
  private async bestHop(intent: LocalIntent): Promise<{ best: Priced | null; transient: boolean }> {
    const local = poolRows(intent).filter(row => row.venue in VENUE_LABELS)
    // Same miss path as a direct quote: Birdeye when the local index has no supported pool.
    const rows = (local.length ? local : await discoverPools(intent.inputMint, intent.outputMint)).slice(0, MAX_POOLS_PER_HOP)
    const results = await Promise.all(rows.map(row => this.attemptPool(row, intent)))
    const priced = results.flatMap(r => 'ok' in r ? [r.ok] : [])
    return { best: priced.length ? rankDirectCandidates(priced)[0] : null,
      transient: results.some(r => !('ok' in r) && r.transient) }
  }
  /** Bounded two-hop discovery through the lp-zap composer: A→X with the full
   * amount, X→B with what is left after the composer's 1 bp fee on X, and the
   * final output net of the fee on B. Off unless the composer is configured. */
  private async composed(intent: LocalIntent): Promise<{ routes: Candidate[]; transient: boolean }> {
    const composer = this.composer
    if (!composer) return { routes: [], transient: false }
    // The final check watches the destination token account; a native SOL
    // destination would be unwrapped (closed), so those routes stay single-pool.
    if (intent.outputMint === NATIVE_MINT.toBase58()) return { routes: [], transient: false }
    const vias = intermediateMints(intent.inputMint, intent.outputMint, MAX_INTERMEDIATES)
    let transient = false
    const found = await Promise.all(vias.map(async (via): Promise<Candidate | null> => {
      try {
        const hop0 = await this.bestHop({ ...intent, outputMint: via, keepNative: 'output' })
        if (hop0.transient) transient = true
        const first = hop0.best
        if (!first) return null
        const middle = afterComposerFee(first.out)
        if (middle <= 0n) return null
        const hop1 = await this.bestHop({ ...intent, inputMint: via, amount: middle.toString(),
          keepNative: 'input' })
        if (hop1.transient) transient = true
        const second = hop1.best
        if (!second) return null
        const out = afterComposerFee(second.out)
        const minimum = pctMinimum(out, intent.slippageBps)
        if (out <= 0n || minimum <= 0n) return null
        return { out, minimum, hops: 2,
          plan: [planEntry(first, intent.inputMint, via, intent.amount),
            planEntry(second, via, intent.outputMint, middle.toString())],
          build: async (wallet, floor) => {
            // Hop 0 is built with its own quoted floor so both amount offsets
            // are provable; composeRoute then rewrites that floor to 0.
            const leg0 = await first.leg(wallet, first.minimum)
            const leg1 = await second.leg(wallet, finalHopMinimum(floor))
            return this.finish([{ leg: leg0, outputMint: new PublicKey(via) },
              { leg: leg1, outputMint: new PublicKey(intent.outputMint) }], wallet, floor, intent,
              via === NATIVE_MINT.toBase58())
          } }
      } catch (error) {
        if (isTransientRpcError(error)) transient = true
        return null
      }
    }))
    return { routes: found.filter((c): c is Candidate => c !== null), transient }
  }
  /** Landed swaps through decoded programs, the last resort for pairs with no
   * supported pool: the landing's ratio at this size quotes the route, and
   * the build replays it for the wallet with only its own accounts re-pointed
   * and the amount patched at its proven offset. Only exact-amount proofs
   * participate; the outcome is simulated before anything is signed. */
  private async decoded(intent: LocalIntent): Promise<Candidate[]> {
    let items: DecodedSwapTemplate[]
    try { items = await this.decodedSource(intent.inputMint, intent.outputMint, 2) } catch { return [] }
    const amount = atomic(intent.amount)
    const found: Candidate[] = []
    for (const item of items) {
      const template = item.template
      if (template.amountProof !== 'exact') continue
      const landedIn = BigInt(template.amountIn), landedOut = BigInt(template.amountOut)
      if (landedIn <= 0n || landedOut <= 0n) continue
      const out = landedOut * amount / landedIn
      if (out <= 0n) continue
      const label = `Decoded ${item.programName ?? template.program.slice(0, 4) + '…' + template.program.slice(-4)}`
      found.push({ out, minimum: pctMinimum(out, intent.slippageBps), hops: 1,
        decoded: { program: template.program, name: item.programName },
        plan: [{ percent: 100, swapInfo: { ammKey: template.program, label, inputMint: intent.inputMint,
          outputMint: intent.outputMint, inAmount: intent.amount, outAmount: out.toString(),
          feeAmount: '0', feeMint: intent.inputMint } }],
        build: async wallet => {
          const replay = await replayDecodedSwap(item, wallet, amount, this.connection)
          if (!replay) throw new DirectRouteError(422, 'The decoded swap could not be replayed for this wallet')
          return { instructions: replay.instructions, allowPrograms: replay.allowPrograms,
            computeUnitLimit: replay.computeUnitLimit, output: replay.output }
        } })
    }
    return found
  }
  private async candidates(intent: LocalIntent): Promise<Candidate[]> {
    const edges = fatEdges(poolRows(intent).filter(row => row.venue in VENUE_LABELS))
    // A thin pair is its own pool. Hunting two-hop vias walks every quiet SOL edge and is what makes the quote stall.
    const composed = thinPair(edges)
      ? Promise.resolve({ routes: [] as Candidate[], transient: false })
      : this.composed(intent).catch(error => ({ routes: [] as Candidate[], transient: isTransientRpcError(error) }))
    let singles: Candidate[] = [], failure: unknown = null
    try {
      singles = (await this.singlePool(intent)).map(priced => this.single(priced, intent))
    } catch (error) {
      failure = error
    }
    const multi = await composed
    const all = rankDirectCandidates([...singles, ...multi.routes])
    if (all.length) return all
    if (isRateLimited(failure)) throw failure
    // Two-hop pools exist but could not be read: the route is undetermined.
    if (multi.transient) throw rateLimited()
    // Pairs with no supported pool may still route through a program the
    // frontier learned and a landed swap proved.
    const decodedRoutes = await this.decoded(intent)
    if (decodedRoutes.length) return decodedRoutes
    throw failure ?? new DirectRouteError(404, 'No executable direct pool route is available for this pair and amount')
  }
  private quoteFor(intent: LocalIntent, route: Candidate, slot: number) {
    return { inputMint: intent.inputMint, outputMint: intent.outputMint,
      inAmount: intent.amount, outAmount: route.out.toString(),
      otherAmountThreshold: route.minimum.toString(), swapMode: 'ExactIn',
      slippageBps: intent.slippageBps, transactionVersion: intent.transactionVersion,
      priceImpactPct: null, contextSlot: slot, routePlan: route.plan,
      // A composed route names the program the wallet will call and who its fee pays.
      ...(route.composed || route.hops > 1 ? { composed: true, hops: route.hops, composerFeeBps: Number(FEE_BPS),
        composerProgramId: this.composer?.toBase58(), composerFeeRecipient: FEE_RECIPIENT.toBase58() } : {}),
      // A decoded route names the learned program the wallet will call.
      ...(route.decoded ? { decoded: true, decodedProgramId: route.decoded.program,
        ...(route.decoded.name ? { decodedProgramName: route.decoded.name } : {}) } : {}) }
  }
  async quote(intent: LocalIntent): Promise<{ quote: any; priced: Candidate }> {
    const route = (await this.candidates(intent))[0]
    const slot = await this.rpcRead(() => this.connection.getSlot('confirmed'))
    const quote = this.quoteFor(intent, route, slot)
    // The old route-level tail took another 10 bp of the post-fee output; the per-hop legs are paid in SOL instead and do
    // not touch the output, so the quote stays whole unless the old tail is switched back on.
    if (this.composer && ROUTE_TAIL) {
      const book = await marketsByMint()
      if (book.has(intent.inputMint) && book.has(intent.outputMint)) {
        const scale = (s: string) => { const n = BigInt(s) * 9989n / 9999n; return n > 0n ? n.toString() : s }
        quote.outAmount = scale(quote.outAmount)
        quote.otherAmountThreshold = scale(quote.otherAmountThreshold)
        quote.positionBps = 10
      }
    }
    return { quote, priced: route }
  }
  private async simulate(wire: string): Promise<boolean> {
    let response: Response
    try {
      response = await fetch(this.rpcUrl, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'simulateTransaction',
          params: [wire, { encoding: 'base64', sigVerify: false,
            replaceRecentBlockhash: true, commitment: 'confirmed' }] }),
        signal: AbortSignal.timeout(12_000) })
      if (!response.ok) throw new Error('rpc status')
      const raw = await response.text()
      if (raw.length > 2_000_000) throw new Error('rpc response size')
      const result = JSON.parse(raw)
      if (result.error || !result.result?.value) throw new Error('rpc result')
      return result.result.value.err === null
    } catch {
      throw new DirectRouteError(503, 'On-chain swap simulation is temporarily unavailable')
    }
  }
  /** A decoded route's simulated output: the wallet's output token account
   * after the replay minus its balance before, or null when the simulation
   * fails. The replayed program has no minimum of its own, so this is what
   * the quoted floor is measured against. */
  private async simulateOutcome(wire: string, output: { address: string; preAmount: bigint }): Promise<bigint | null> {
    let response: Response
    try {
      response = await fetch(this.rpcUrl, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'simulateTransaction',
          params: [wire, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true,
            commitment: 'confirmed', accounts: { addresses: [output.address], encoding: 'base64' } }] }),
        signal: AbortSignal.timeout(12_000) })
      if (!response.ok) throw new Error('rpc status')
      const raw = await response.text()
      if (raw.length > 2_000_000) throw new Error('rpc response size')
      const result = JSON.parse(raw)
      if (result.error || !result.result?.value) throw new Error('rpc result')
      if (result.result.value.err !== null) return null
      const data = result.result.value.accounts?.[0]?.data
      const post = Array.isArray(data) ? tokenAccountAmount(data[0]) : null
      return post === null ? null : post - output.preAmount
    } catch {
      throw new DirectRouteError(503, 'On-chain swap simulation is temporarily unavailable')
    }
  }
  async swap(intent: LocalIntent, wallet: string, minimum: string) {
    const candidates = await this.candidates(intent)
    const protectedMinimum = atomic(minimum)
    if (candidates[0].out < protectedMinimum)
      throw new DirectRouteError(409, 'The price moved beyond your minimum received. Refresh the quote.')
    const payer = new PublicKey(wallet)
    const latest = await this.rpcRead(() => this.connection.getLatestBlockhash('confirmed'))
    const slot = await this.rpcRead(() => this.connection.getSlot('confirmed'))
    let lastReason = 'No quoted direct pool passed current on-chain simulation'
    for (const route of candidates) {
      if (route.out < protectedMinimum) break
      const floor = protectedMinimum > route.minimum ? protectedMinimum : route.minimum
      // Building reads the wallet's own accounts: no memo scope here.
      const scope = rpcScope({ memo: false })
      try {
        const built = await runInRpcScope(scope, () => route.build(payer, floor))
        const pieces = [{ instructions: built.instructions, allowPrograms: built.allowPrograms,
          computeUnitLimit: built.computeUnitLimit }, ...(built.followups ?? [])]
        const swapTransactions = pieces.map(piece => intent.transactionVersion === '1'
          ? unsignedV1(payer, latest.blockhash, piece.instructions, piece.computeUnitLimit, { allowPrograms: piece.allowPrograms })
          : emitWire(payer, latest.blockhash, piece.instructions, piece.allowPrograms, piece.computeUnitLimit))
        const swapTransaction = swapTransactions[0]
        // A decoded route has no venue minimum of its own: its simulated
        // outcome must cover the floor before anything is offered to sign.
        if (route.decoded && built.output) {
          const out = await this.simulateOutcome(swapTransaction, built.output)
          if (out === null || out < floor) { lastReason = 'The decoded route no longer fills this amount'; continue }
        }
        return { transactionVersion: intent.transactionVersion, swapTransaction, swapTransactions,
          lastValidBlockHeight: latest.lastValidBlockHeight,
          prioritizationFeeLamports: 0,
          ...(route.composed || route.hops > 1 ? { composed: true, hops: route.hops } : {}),
          ...(route.decoded ? { decoded: true, decodedProgramId: route.decoded.program,
            ...(route.decoded.name ? { decodedProgramName: route.decoded.name } : {}) } : {}),
          quoteResponse: { ...this.quoteFor(intent, route, slot),
            otherAmountThreshold: floor.toString() } }
      } catch (error) {
        if (error instanceof DirectRouteError && error.status === 503) throw error
        if (scope.transient > 0 || isTransientRpcError(error)) throw rateLimited()
        lastReason = reasonOf(error, error instanceof Error && error.message ? error.message : 'Current pool state cannot build an executable swap')
      }
    }
    noRoute(lastReason)
  }
}

/** Drop a trailing close of this leg's output so the position tail can close it inside the compose. */
function dropWsolClose(leg: ComposeLeg): ComposeLeg {
  const out = leg.leg.outputAccount
  const instructions = leg.leg.instructions.filter((ix, i) => i <= leg.leg.swapIndex ||
    !(ix.programId.equals(TOKEN) && ix.data[0] === 9 && ix.keys[0]?.pubkey.equals(out)))
  return { ...leg, leg: { ...leg.leg, instructions } }
}

function planEntry(priced: Priced, inputMint: string, outputMint: string, inAmount: string): RoutePlanEntry {
  return { percent: 100, swapInfo: { ammKey: priced.pool.address, label: VENUE_LABELS[priced.pool.venue],
    inputMint, outputMint, inAmount, outAmount: priced.out.toString(),
    feeAmount: priced.fee.toString(), feeMint: priced.feeMint } }
}
