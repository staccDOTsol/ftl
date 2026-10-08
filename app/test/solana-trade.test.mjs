import test from 'node:test'
import assert from 'node:assert/strict'
import { toAtomic, fromAtomic, balancePercent, assertQuoteMatches, isQuoteFresh, SOL_MINT, composerHopFees, unacknowledgedComposedBuild, unacknowledgedDecodedBuild } from '../src/lib/solana-trade.ts'

test('decimal conversion preserves precision above JavaScript safe integers', () => {
  assert.equal(toAtomic('9007199254.740993001', 9), '9007199254740993001')
  assert.equal(fromAtomic('9007199254740993001', 9), '9007199254.740993001')
  assert.equal(toAtomic('.000001', 6), '1')
  assert.equal(toAtomic('18446744073709551615', 0), '18446744073709551615')
})

test('amount parsing rejects truncation, scientific notation and u64 overflow', () => {
  for (const value of ['1.0000001', '1e5', '-1', '0', 'Infinity', '1,000']) assert.throws(() => toAtomic(value, 6))
  assert.throws(() => toAtomic('18446744073709551616', 0))
  assert.throws(() => toAtomic('1', 19))
})

test('balance shortcuts floor units, preserve a SOL reserve, and never go negative', () => {
  assert.equal(balancePercent('101', 25, false), '25')
  assert.equal(balancePercent('1000000000', 100, true), '990000000')
  assert.equal(balancePercent('9000000', 100, true), '0')
  assert.equal(balancePercent('999999999999999999', 100, false), '999999999999999999')
})

const intent = { inputMint: SOL_MINT, outputMint: 'token', amount: '1000000', slippageBps: 100 }
const quote = { ...intent, inAmount: intent.amount, outAmount: '500', otherAmountThreshold: '495', swapMode: 'ExactIn', routePlan: [{ percent: 100 }] }
test('quote must bind input, output, amount, slippage and nonzero minimum', () => {
  assert.doesNotThrow(() => assertQuoteMatches(quote, intent))
  for (const patch of [{ inputMint: 'other' }, { outputMint: 'other' }, { inAmount: '2000000' }, { slippageBps: 300 }, { swapMode: 'ExactOut' }, { routePlan: [] }, { otherAmountThreshold: '0' }, { otherAmountThreshold: '501' }]) {
    assert.throws(() => assertQuoteMatches({ ...quote, ...patch }, intent))
  }
})

test('quotes expire at 30 seconds and future timestamps are not accepted', () => {
  assert.equal(isQuoteFresh(1000, 30999), true)
  assert.equal(isQuoteFresh(1000, 31000), false)
  assert.equal(isQuoteFresh(1000, 999), false)
  assert.equal(isQuoteFresh(0, 1), false)
})

const composedQuote = (extra = {}) => ({ composed: true, hops: 2, composerFeeBps: 10, composerProgramId: 'Comp1111111111111111111111111111111111111111',
  routePlan: [{ percent: 100, swapInfo: { outputMint: 'X', outAmount: '2000000' } }, { percent: 100, swapInfo: { outputMint: 'B', outAmount: '5999999' } }], ...extra })

test('composer hop fees are fee bps of each hop gross output, in that hop token, and absent for direct routes', () => {
  assert.deepEqual(composerHopFees(composedQuote()), [{ mint: 'X', amount: '2000' }, { mint: 'B', amount: '5999' }])
  assert.equal(composerHopFees({ ...composedQuote(), composed: false }), null)
  assert.equal(composerHopFees(composedQuote({ composerFeeBps: undefined })), null)
  assert.equal(composerHopFees(composedQuote({ routePlan: [{ percent: 100, swapInfo: { outputMint: 'X', outAmount: '1.5' } }] })), null)
})

test('a composed build is held back unless its own composer program was acknowledged', () => {
  const built = { composed: true, quoteResponse: composedQuote() }
  assert.equal(unacknowledgedComposedBuild({ composed: false, quoteResponse: composedQuote() }, null), null)
  assert.equal(unacknowledgedComposedBuild(built, null), built.quoteResponse)
  assert.equal(unacknowledgedComposedBuild(built, 'Comp1111111111111111111111111111111111111111'), null)
  // A different program needs its own acknowledgement.
  assert.equal(unacknowledgedComposedBuild(built, 'Other111111111111111111111111111111111111111'), built.quoteResponse)
  // Unreported program ids are acknowledged under their own key, never as a match for a named program.
  assert.equal(unacknowledgedComposedBuild({ composed: true, quoteResponse: composedQuote({ composerProgramId: undefined }) }, 'unreported'), null)
})

test('a decoded build is held back unless its own decoded program was acknowledged', () => {
  const built = { decoded: true, decodedProgramId: 'Learned111111111111111111111111111111111111111',
    quoteResponse: { decoded: true, decodedProgramId: 'Learned111111111111111111111111111111111111111' } }
  assert.equal(unacknowledgedDecodedBuild({ decoded: false, quoteResponse: built.quoteResponse }, null), null)
  assert.equal(unacknowledgedDecodedBuild(built, null), built.quoteResponse)
  assert.equal(unacknowledgedDecodedBuild(built, 'Learned111111111111111111111111111111111111111'), null)
  // A different program needs its own acknowledgement.
  assert.equal(unacknowledgedDecodedBuild(built, 'Other1111111111111111111111111111111111111111'), built.quoteResponse)
  assert.equal(unacknowledgedDecodedBuild({ decoded: true, quoteResponse: { decoded: true } }, 'unreported'), null)
})
