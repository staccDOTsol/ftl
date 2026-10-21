// 10 bp of a hop, inside the same composer call as the venue swap.
// Half buys UP (long) on the mint that hop bought, half buys DOWN (short)
// on the mint it sold. badBeat flips the two mints. The buy is the Meteora
// DBC swap the 100x market already uses: r-fstacc in, the side token out.
// r-fstacc is not an AMM coin, so the slice is swapped to SOL, unwrapped,
// and deposited through the stake pool. The deposit's referral account is
// the ?ref= wallet when that wallet already holds r-fstacc.
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction,
  getAssociatedTokenAddressSync } from '@solana/spl-token'
import { DynamicBondingCurveClient, SwapMode, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import BN from 'bn.js'
import { swapOffsets, type DirectLeg } from './direct-adapter.ts'
import type { ComposeStepInput, ComposeTail } from './compose.ts'

const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
const DBC = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const RFSTACC = new PublicKey('pSYRpDqr847kB2nD5ZhjcPsHLV2ZpUxweXm1MwiSTcc')
const STAKE_POOL_PROGRAM = new PublicKey('SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY')
const STAKE_POOL = new PublicKey('SzoSoRxsrL9sbFcwpbjbH5bRrzuvFtuytZTeuqZCfQ6')
const HOUSE = new PublicKey('331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth')
const WITHDRAW_AUTHORITY = PublicKey.findProgramAddressSync(
  [STAKE_POOL.toBuffer(), Buffer.from('withdraw')], STAKE_POOL_PROGRAM)[0]
/** 10 bp of the post-fee hop output. The hop was already charged 1 bp, so
 * 10/9999 of what remains is 10 bp of the gross. */
const SLICE_NUM = 10
const SLICE_DEN = 9999
/** What the destination still holds after that slice: 9989/9999 of the post-fee floor. */
export const keptOf = (postFeeFloor: bigint) => postFeeFloor * 9989n / 9999n
const PLACEHOLDER_IN = 1_234_567_890_123n
const BROKER = 'https://100x.broker/api/markets'

type Market = { mint: string; config: PublicKey; bull: PublicKey; bear: PublicKey; depth: bigint }
let listed: { at: number; by: Map<string, Market> } | null = null

const asKey = (v: unknown) => typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { $p?: unknown }).$p === 'string' ? (v as { $p: string }).$p : ''
const asInt = (v: unknown) => {
  const s = typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { $b?: unknown }).$b === 'string' ? (v as { $b: string }).$b : '0'
  try { return BigInt(s) } catch { return 0n }
}

/** Deepest listed 100x market per underlying mint. Empty when the broker is unreachable. */
export async function marketsByMint(): Promise<Map<string, Market>> {
  if (listed && Date.now() - listed.at < 30_000) return listed.by
  const by = new Map<string, Market>()
  try {
    const r = await fetch(BROKER, { signal: AbortSignal.timeout(4_000) })
    if (!r.ok) return listed?.by ?? by
    const body = await r.json() as { markets?: unknown[] }
    for (const row of body.markets ?? []) {
      if (!row || typeof row !== 'object') continue
      const m = row as { underlyingMint?: unknown; keys?: Record<string, unknown>; side?: { vault?: unknown }[] }
      const mint = asKey(m.underlyingMint)
      const keys = m.keys ?? {}
      const config = asKey(keys.config), bull = asKey(keys.bullMint), bear = asKey(keys.bearMint)
      if (!mint || !config || !bull || !bear) continue
      const depth = (m.side ?? []).reduce((n, s) => n + asInt(s.vault), 0n)
      const prev = by.get(mint)
      if (!prev || depth > prev.depth) by.set(mint, {
        mint, config: new PublicKey(config), bull: new PublicKey(bull), bear: new PublicKey(bear), depth })
    }
    listed = { at: Date.now(), by }
  } catch { /* a quote still stands without the position */ }
  return listed?.by ?? by
}

type PoolAccounts = { reserve: PublicKey; fee: PublicKey; total: bigint; supply: bigint; depositFee: { den: bigint; num: bigint } }
let poolAccounts: PoolAccounts | null = null
function readPool(data: Buffer): PoolAccounts {
  let o = 0
  const u8 = () => data[o++]
  const u64 = () => { const v = data.readBigUInt64LE(o); o += 8; return v }
  const pk = () => { const v = new PublicKey(data.subarray(o, o + 32)); o += 32; return v }
  const fee = () => ({ den: u64(), num: u64() })
  const opt = () => { if (u8()) pk() }
  const future = () => { if (u8()) fee() }
  u8(); pk(); pk(); pk(); u8(); pk()
  const reserve = pk(); pk(); const managerFee = pk()
  pk()
  const total = u64(), supply = u64()
  u64(); o += 48; fee(); future(); opt(); opt(); fee(); fee(); future(); u8()
  opt() // sol deposit authority would have to sign; this pool has none
  const depositFee = fee()
  return { reserve, fee: managerFee, total, supply, depositFee }
}
/** r-fstacc a deposit of `lamports` can be counted on. Fee rounds up, then 1000 units stay behind. */
function mintedFor(lamports: bigint, pool: PoolAccounts): bigint {
  if (lamports <= 0n) return 0n
  const gross = pool.total === 0n ? lamports : lamports * pool.supply / pool.total
  const { num, den } = pool.depositFee
  const fee = den === 0n ? 0n : (gross * num + den - 1n) / den
  const out = gross - fee - 1_000n
  return out > 0n ? out : 0n
}

async function stakeAccounts(connection: Connection): Promise<PoolAccounts> {
  if (poolAccounts) return poolAccounts
  const info = await connection.getAccountInfo(STAKE_POOL, 'confirmed')
  if (!info) throw new Error('stake pool not found')
  poolAccounts = readPool(Buffer.from(info.data))
  return poolAccounts
}

const ata = (mint: PublicKey, owner: PublicKey, program = TOKEN_PROGRAM_ID) =>
  getAssociatedTokenAddressSync(mint, owner, true, program, ASSOCIATED_TOKEN_PROGRAM_ID)

async function referralAta(connection: Connection, wallet: PublicKey, ref: PublicKey | null): Promise<PublicKey> {
  const self = ata(RFSTACC, wallet)
  const candidates = [ref, HOUSE].filter((k): k is PublicKey => !!k && !k.equals(wallet))
  if (!candidates.length) return self
  const atas = candidates.map(k => ata(RFSTACC, k))
  const infos = await connection.getMultipleAccountsInfo(atas, 'confirmed')
  const i = infos.findIndex(Boolean)
  return i >= 0 ? atas[i] : self
}

function depositIx(pool: PoolAccounts, wallet: PublicKey, userAta: PublicKey, referral: PublicKey, lamports: bigint) {
  const data = Buffer.alloc(9)
  data[0] = 14
  data.writeBigUInt64LE(lamports, 1)
  return new TransactionInstruction({
    programId: STAKE_POOL_PROGRAM,
    keys: [
      { pubkey: STAKE_POOL, isSigner: false, isWritable: true },
      { pubkey: WITHDRAW_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: pool.reserve, isSigner: false, isWritable: true },
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: pool.fee, isSigner: false, isWritable: true },
      { pubkey: referral, isSigner: false, isWritable: true },
      { pubkey: RFSTACC, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  })
}

async function dbcBuy(connection: Connection, wallet: PublicKey, market: Market, side: 'bull' | 'bear'): Promise<{ ix: TransactionInstruction; amountOffset: number }> {
  const base = side === 'bull' ? market.bull : market.bear
  const pool = deriveDbcPoolAddress(RFSTACC, base, market.config)
  const client = DynamicBondingCurveClient.create(connection, 'confirmed')
  const tx = await client.pool.swap2WithTransferHook({
    owner: wallet, pool, swapBaseForQuote: false, referralTokenAccount: null, payer: wallet,
    swapMode: SwapMode.ExactIn, amountIn: new BN(PLACEHOLDER_IN.toString()), minimumAmountOut: new BN(1),
  })
  const ix = tx.instructions.find(i => i.programId.equals(DBC))
  if (!ix) throw new Error('DBC swap was not built')
  const offsets = swapOffsets(ix.data, PLACEHOLDER_IN, 1n)
  if (!offsets) throw new Error('DBC swap amount could not be patched')
  const data = Buffer.from(ix.data)
  data.writeBigUInt64LE(0n, offsets.minOutOffset)
  return { ix: new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data }), amountOffset: offsets.amountInOffset }
}

const TOKEN_ACCOUNT_AMOUNT = 64

/** Composer steps for the 10 bp position, or null when either market is not listed. */
export async function positionTail(args: {
  connection: Connection
  wallet: PublicKey
  soldMint: string
  boughtMint: string
  outputAccount: PublicKey
  outputIsSol: boolean
  hopStep: number
  /** Post-fee floor the user was promised. The check is what remains after the 10 bp slice. */
  floor: bigint
  badBeat: boolean
  ref: PublicKey | null
  /** A SOL leg that spends `outputAccount`, quoted at `quotedIn`, with `solMin` WSOL out. */
  slice: (() => Promise<{ leg: DirectLeg; quotedIn: bigint; solMin: bigint } | null>) | null
}): Promise<{ compose: ComposeTail; batches: { instructions: TransactionInstruction[]; allow: PublicKey[] }[] } | null> {
  const book = await marketsByMint()
  const sold = book.get(args.soldMint)
  const bought = book.get(args.boughtMint)
  if (!sold || !bought) return null
  const longMarket = args.badBeat ? sold : bought
  const shortMarket = args.badBeat ? bought : sold
  const wsol = ata(NATIVE_MINT, args.wallet)
  const quoteAta = ata(RFSTACC, args.wallet)
  const longAta = ata(longMarket.bull, args.wallet, TOKEN_2022)
  const shortAta = ata(shortMarket.bear, args.wallet, TOKEN_2022)
  const [wsolInfo, rent, pool, referral, longIx, shortIx, sliceQuote] = await Promise.all([
    args.connection.getAccountInfo(wsol, 'confirmed'),
    args.connection.getMinimumBalanceForRentExemption(165),
    stakeAccounts(args.connection),
    referralAta(args.connection, args.wallet, args.ref),
    dbcBuy(args.connection, args.wallet, longMarket, 'bull'),
    dbcBuy(args.connection, args.wallet, shortMarket, 'bear'),
    args.slice ? args.slice() : Promise.resolve(null),
  ])
  const sliceLeg = sliceQuote?.leg ?? null
  if (!args.outputIsSol && !sliceLeg?.offsets) throw new Error('No SOL route for the 100× slice of this hop')
  if (sliceLeg && !sliceLeg.inputAccount.equals(args.outputAccount)) throw new Error('100× slice does not spend the hop output')
  const prior = wsolInfo && wsolInfo.data.length >= TOKEN_ACCOUNT_AMOUNT + 8
    ? wsolInfo.data.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT) : 0n
  const rentLamports = BigInt(rent)
  let at = args.hopStep + 1
  const steps: ComposeStepInput[] = []
  if (!args.outputIsSol && sliceLeg?.offsets) {
    const swap = sliceLeg.instructions[sliceLeg.swapIndex]
    const data = Buffer.from(swap.data)
    data.writeBigUInt64LE(0n, sliceLeg.offsets.minOutOffset)
    steps.push({
      instruction: new TransactionInstruction({ programId: swap.programId, keys: swap.keys, data }),
      patches: [{ dataOffset: sliceLeg.offsets.amountInOffset, watch: args.outputAccount,
        fromStep: args.hopStep, mode: 1, num: SLICE_NUM, den: SLICE_DEN }],
    })
    at++
  }
  const closeAt = at
  steps.push({ instruction: createCloseAccountInstruction(wsol, args.wallet, args.wallet), patches: [] })
  at++
  const depositAt = at
  // SOL output: the closed account holds the whole hop, so deposit 10 bp of it.
  // Any other output: the close holds only the sliced WSOL plus whatever the
  // wallet already had, and the deposit keeps the pre-existing balance as SOL.
  const depositPatch = args.outputIsSol
    ? { dataOffset: 1, watch: args.wallet, fromStep: closeAt, mode: 2 as const,
      num: SLICE_NUM, den: SLICE_DEN, sub: (prior + rentLamports) * BigInt(SLICE_NUM) / BigInt(SLICE_DEN) }
    : { dataOffset: 1, watch: args.wallet, fromStep: closeAt, mode: 2 as const,
      num: 1, den: 1, sub: prior + rentLamports }
  steps.push({
    instruction: depositIx(pool, args.wallet, quoteAta, referral, PLACEHOLDER_IN),
    patches: [depositPatch],
  })
  at++
  const half = { dataOffset: longIx.amountOffset, watch: quoteAta, fromStep: depositAt, mode: 1 as const, num: 1, den: 2 }
  steps.push({ instruction: longIx.ix, patches: [half] })
  // The second buy sees the r-fstacc left after the first, which is the other half.
  steps.push({ instruction: shortIx.ix, patches: [{ dataOffset: shortIx.amountOffset, watch: quoteAta, fromStep: depositAt }] })
  const before = [
    createAssociatedTokenAccountIdempotentInstruction(args.wallet, wsol, args.wallet, NATIVE_MINT),
    createAssociatedTokenAccountIdempotentInstruction(args.wallet, quoteAta, args.wallet, RFSTACC),
    createAssociatedTokenAccountIdempotentInstruction(args.wallet, longAta, args.wallet, longMarket.bull, TOKEN_2022),
    createAssociatedTokenAccountIdempotentInstruction(args.wallet, shortAta, args.wallet, shortMarket.bear, TOKEN_2022),
    ...(sliceLeg ? sliceLeg.instructions.slice(0, sliceLeg.swapIndex) : []),
  ]
  const kept = keptOf(args.floor)
  // Native SOL output is unwrapped inside the compose, so the token account is
  // gone at the check. Allow the wallet to pay an ATA's rent and still pass.
  const compose: ComposeTail = { steps, before, check: args.outputIsSol
    ? { watch: args.wallet, bound: -3_000_000n }
    : { watch: args.outputAccount, bound: kept > 0n ? kept : 1n } }
  // One compose of every step blows the 64-account cap. These are the same
  // buys as separate transactions: the slice is scaled down to 10 bp, the
  // deposit spends only that SOL, and each DBC buy is its own signature.
  const sliceOf = args.floor * 10n / 9999n
  const batches: { instructions: TransactionInstruction[]; allow: PublicKey[] }[] = []
  let solForDeposit = args.outputIsSol ? sliceOf : 0n
  if (!args.outputIsSol && sliceLeg?.offsets && sliceQuote && sliceQuote.quotedIn > 0n && sliceOf > 0n) {
    const minOut = sliceQuote.solMin * sliceOf / sliceQuote.quotedIn * 9n / 10n
    if (minOut <= 0n) throw new Error('100× slice is too small to price')
    solForDeposit = minOut
    const offsets = sliceLeg.offsets
    batches.push({ allow: [], instructions: sliceLeg.instructions.map((ix, i) => {
      if (i !== sliceLeg.swapIndex) return ix
      const data = Buffer.from(ix.data)
      data.writeBigUInt64LE(sliceOf, offsets.amountInOffset)
      data.writeBigUInt64LE(minOut, offsets.minOutOffset)
      return new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data })
    }) })
  }
  const minted = mintedFor(solForDeposit, pool)
  if (solForDeposit > 0n) batches.push({
    allow: [STAKE_POOL_PROGRAM],
    instructions: [
      createAssociatedTokenAccountIdempotentInstruction(args.wallet, quoteAta, args.wallet, RFSTACC),
      depositIx(pool, args.wallet, quoteAta, referral, solForDeposit),
    ],
  })
  const longAmount = minted / 2n
  const shortAmount = minted - longAmount
  const priced = (built: { ix: TransactionInstruction; amountOffset: number }, amount: bigint) => {
    const data = Buffer.from(built.ix.data)
    data.writeBigUInt64LE(amount, built.amountOffset)
    return new TransactionInstruction({ programId: built.ix.programId, keys: built.ix.keys, data })
  }
  if (longAmount > 0n) batches.push({
    allow: [DBC],
    instructions: [
      createAssociatedTokenAccountIdempotentInstruction(args.wallet, longAta, args.wallet, longMarket.bull, TOKEN_2022),
      priced(longIx, longAmount),
    ],
  })
  if (shortAmount > 0n) batches.push({
    allow: [DBC],
    instructions: [
      createAssociatedTokenAccountIdempotentInstruction(args.wallet, shortAta, args.wallet, shortMarket.bear, TOKEN_2022),
      priced(shortIx, shortAmount),
    ],
  })
  return { compose, batches }
}
