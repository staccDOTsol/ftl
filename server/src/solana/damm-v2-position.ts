// A new Meteora DAMM v2 position and its deposit (see venue-deposit.ts for why
// this server builds it). A DAMM v2 position is an NFT: create_position mints
// it from a fresh mint key that must sign, the wallet holds it, and the
// position account is a PDA of that mint. The key is generated per build and
// never stored.
//
// Liquidity-driven: add_liquidity encodes a liquidity delta and a maximum per
// side, nothing else. The delta is u128 Q64.64 fixed point (the SDK's
// "liquidity delta in Q64"), so any real deposit is far above 2^64 and the
// composer, which rewrites u64 words by a u32 ratio, cannot scale the full
// value. It can scale the integer word: the delta is built with its
// fractional word zeroed (under one liquidity unit, a ~1/liquidity share of
// the deposit), so rescaling the high u64 word rescales the whole delta, and
// that word is the `liquidity` the quote reports. `liquidityQ64` is the u128
// the instruction carries (liquidity x 2^64).
import { Keypair, PublicKey, type Connection } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, getTransferFeeConfig, unpackMint, type Mint } from '@solana/spl-token'
import { CpAmm, CP_AMM_PROGRAM_ID, Rounding, calculateTransferFeeIncludedAmount, derivePositionAddress,
  getAmountAFromLiquidityDelta, getAmountBFromLiquidityDelta, getTokenProgram, type PoolState } from '@meteora-ag/cp-amm-sdk'
import BN from 'bn.js'
import { debit, rawInstructions, type VenueDeposit, type VenueDepositBuilder, type VenueDepositInput } from './venue-deposit.ts'

const SOL = NATIVE_MINT.toBase58()
const BPS = 10_000n
const big = (value: BN): bigint => BigInt(value.toString())
const bn = (value: bigint): BN => new BN(value.toString())
const min = (a: bigint, b: bigint) => a < b ? a : b
type TokenInfo = { mint: Mint; currentEpoch: number }

/** Whether the token is the pool's token A; throws unless the pool pairs it with SOL. */
export function tokenIsA(tokenAMint: string, tokenBMint: string, tokenMint: string): boolean {
  if (tokenMint === SOL) throw new Error('DAMM v2 deposit token must not be SOL itself')
  if (tokenAMint === tokenMint && tokenBMint === SOL) return true
  if (tokenAMint === SOL && tokenBMint === tokenMint) return false
  throw new Error('DAMM v2 pool does not pair this token with SOL')
}

/** A Q64.64 liquidity delta split for the composer: `liquidity` is the
 * integer word (the u64 the quote reports and the composer rescales), and
 * `encoded` the u128 the instruction carries, its fractional word zeroed. */
export function liquidityWord(delta: bigint): { liquidity: bigint; encoded: bigint } {
  const liquidity = delta >> 64n
  return { liquidity, encoded: liquidity << 64n }
}

/** The deposit against an already-read pool state. Sized by the SDK's deposit
 * quote from each side: the smaller liquidity wins, and the SOL side is
 * quoted at solAmount less the slippage headroom so its maximum — which is
 * also what gets wrapped — never exceeds solAmount. The token debit's
 * expected is the token budget the liquidity was sized from (as Orca's), the
 * anchor the composer scales by: when the SOL side binds, add_liquidity takes
 * fewer tokens than arrive, and anchoring on that smaller amount would scale
 * the deposit past the SOL wrapped. What it takes at the read price is
 * details.tokenEstimateRaw. Each limit is the maximum the instruction encodes
 * (the at-price amount plus slippageBps). Builds offline. */
export async function dammV2DepositFrom(amm: CpAmm, state: PoolState, input: VenueDepositInput, tokenInfo?: TokenInfo): Promise<VenueDeposit> {
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps > 10_000) throw new Error('slippageBps must be an integer from 0 to 10000')
  if (input.tokenAmount <= 0n || input.solAmount <= 0n) throw new Error('DAMM v2 deposit needs positive token and SOL amounts')
  const isA = tokenIsA(state.tokenAMint.toBase58(), state.tokenBMint.toBase58(), input.tokenMint)
  const slippage = BigInt(input.slippageBps), headroom = (raw: bigint) => raw * (BPS + slippage) / BPS
  const curve = { minSqrtPrice: state.sqrtMinPrice, maxSqrtPrice: state.sqrtMaxPrice, sqrtPrice: state.sqrtPrice,
    collectFeeMode: state.collectFeeMode, tokenAAmount: state.tokenAAmount, tokenBAmount: state.tokenBAmount, liquidity: state.liquidity }
  const fromToken = big(amm.getDepositQuote({ ...curve, inAmount: bn(input.tokenAmount), isTokenA: isA, inputTokenInfo: tokenInfo }).liquidityDelta)
  const fromSol = big(amm.getDepositQuote({ ...curve, inAmount: bn(input.solAmount * BPS / (BPS + slippage)), isTokenA: !isA }).liquidityDelta)
  const { liquidity, encoded } = liquidityWord(min(fromToken, fromSol))
  // What add_liquidity charges for this delta at the read price (rounded up, as on chain).
  const amountA = big(getAmountAFromLiquidityDelta(state.sqrtPrice, state.sqrtMaxPrice, bn(encoded), Rounding.Up,
    state.collectFeeMode, state.tokenAAmount, state.liquidity))
  const amountB = big(getAmountBFromLiquidityDelta(state.sqrtMinPrice, state.sqrtPrice, bn(encoded), Rounding.Up,
    state.collectFeeMode, state.tokenBAmount, state.liquidity))
  const tokenRaw = isA ? amountA : amountB, solExpected = isA ? amountB : amountA
  // A Token-2022 transfer fee is charged on top of what the pool receives.
  const tokenExpected = tokenInfo ? big(calculateTransferFeeIncludedAmount(bn(tokenRaw), tokenInfo.mint, tokenInfo.currentEpoch).amount) : tokenRaw
  if (liquidity === 0n || tokenExpected <= 0n || solExpected <= 0n) throw new Error('Deposit is too small for this DAMM v2 pool')
  if (tokenExpected > input.tokenAmount || solExpected > input.solAmount) throw new Error('DAMM v2 deposit quote exceeds the amounts given')
  const tokenMax = headroom(tokenExpected), solMax = min(headroom(solExpected), input.solAmount)
  const positionNft = Keypair.generate()
  const transaction = await amm.createPositionAndAddLiquidity({
    owner: new PublicKey(input.owner), pool: new PublicKey(input.pool), positionNft: positionNft.publicKey, liquidityDelta: bn(encoded),
    // maxAmountToken* only size the SDK's SOL wrap; the thresholds are what add_liquidity enforces.
    maxAmountTokenA: bn(isA ? tokenMax : solMax), maxAmountTokenB: bn(isA ? solMax : tokenMax),
    tokenAAmountThreshold: bn(isA ? tokenMax : solMax), tokenBAmountThreshold: bn(isA ? solMax : tokenMax),
    tokenAMint: state.tokenAMint, tokenBMint: state.tokenBMint,
    tokenAProgram: getTokenProgram(state.tokenAFlag), tokenBProgram: getTokenProgram(state.tokenBFlag),
  })
  return { instructions: rawInstructions(transaction.instructions), signers: [positionNft],
    position: derivePositionAddress(positionNft.publicKey).toBase58(),
    quote: { amounts: [debit(input.tokenMint, input.tokenAmount, tokenMax), debit(SOL, solExpected, solMax)],
      details: { liquidity: liquidity.toString(), liquidityQ64: encoded.toString(), tokenEstimateRaw: tokenExpected.toString(),
        positionNftMint: positionNft.publicKey.toBase58() } } }
}

/** A deposit into a new full-pool-range DAMM v2 position the wallet owns.
 * `position` is the position account (the PDA DAMM v2 and its SDK address
 * positions by); the NFT mint is details.positionNftMint. Reads the pool and
 * the token mint in one call, plus the epoch for a Token-2022 transfer fee.
 * DAMM v2 takes no venue parameters. */
export const newDammV2Deposit: VenueDepositBuilder = async (connection: Connection, input) => {
  const [poolAccount, mintAccount] = await connection.getMultipleAccountsInfo([new PublicKey(input.pool), new PublicKey(input.tokenMint)], 'confirmed')
  if (!poolAccount?.owner.equals(CP_AMM_PROGRAM_ID)) throw new Error('Pool is not a Meteora DAMM v2 pool')
  if (!mintAccount) throw new Error('Token mint not found')
  const amm = new CpAmm(connection)
  const state = amm._program.coder.accounts.decode('pool', poolAccount.data) as PoolState
  const isA = tokenIsA(state.tokenAMint.toBase58(), state.tokenBMint.toBase58(), input.tokenMint)
  const tokenProgram = getTokenProgram(isA ? state.tokenAFlag : state.tokenBFlag)
  if (!mintAccount.owner.equals(tokenProgram)) throw new Error('Token mint program does not match the DAMM v2 pool')
  let tokenInfo: TokenInfo | undefined
  if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    const mint = unpackMint(new PublicKey(input.tokenMint), mintAccount, TOKEN_2022_PROGRAM_ID)
    if (getTransferFeeConfig(mint)) tokenInfo = { mint, currentEpoch: (await connection.getEpochInfo('confirmed')).epoch }
  }
  return dammV2DepositFrom(amm, state, input, tokenInfo)
}
