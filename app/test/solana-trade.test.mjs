import test from 'node:test'
import assert from 'node:assert/strict'
import { toAtomic, fromAtomic, balancePercent, assertQuoteMatches, isQuoteFresh, SOL_MINT } from '../src/lib/solana-trade.ts'

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
