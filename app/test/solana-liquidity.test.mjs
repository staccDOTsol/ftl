import test from 'node:test'
import assert from 'node:assert/strict'
import { assertApprovedLiquidity, assertLiquidityQuote } from '../src/lib/solana-liquidity-model.ts'
const quote = () => ({ quoteId: 'immutable-quote', expiresAt: Date.now() + 30000, venue: 'orca', operation: 'add', pool: 'pool', position: 'position', slot: 1,
  amounts: [{ mint: 'a', decimals: 9, expectedRaw: '9007199254740999', limitRaw: '9007199254741999', direction: 'debit' }, { mint: 'b', decimals: 6, expectedRaw: '123400000', limitRaw: '123400000', direction: 'debit' }] })
const intent = { venue: 'orca', operation: 'add', pool: 'pool', position: 'position' }
test('liquidity quote binds venue, operation, pool, position and expiry', () => {
  assert.doesNotThrow(() => assertLiquidityQuote(quote(), intent))
  for (const field of ['venue', 'operation', 'pool', 'position']) assert.throws(() => assertLiquidityQuote({ ...quote(), [field]: 'changed' }, intent))
  assert.throws(() => assertLiquidityQuote({ ...quote(), expiresAt: Date.now() - 1 }, intent))
})
test('amount limits remain exact beyond JS integer precision and respect direction', () => {
  assert.doesNotThrow(() => assertLiquidityQuote(quote(), intent))
  const bad = quote(); bad.amounts[0].limitRaw = '9007199254740998'
  assert.throws(() => assertLiquidityQuote(bad, intent))
  const credit = quote(); credit.amounts[0].direction = 'credit'; credit.amounts[0].limitRaw = '9007199254740000'
  assert.doesNotThrow(() => assertLiquidityQuote(credit, intent))
  credit.amounts[0].limitRaw = '9007199254741000'
  assert.throws(() => assertLiquidityQuote(credit, intent))
})
test('build cannot expand approved spending, swap positions or silently add a different quote', () => {
  const approved = quote(); const build = () => ({ transactions: [{ transaction: 'base64', expectedSigners: ['wallet'], lastValidBlockHeight: 1 }], pool: approved.pool, position: approved.position, quote: structuredClone(approved) })
  assert.doesNotThrow(() => assertApprovedLiquidity(approved, build()))
  const expanded = build(); expanded.quote.amounts[0].limitRaw = '9007199254742000'
  assert.throws(() => assertApprovedLiquidity(approved, expanded))
  assert.throws(() => assertApprovedLiquidity(approved, { ...build(), position: 'other' }))
  const other = build(); other.quote.quoteId = 'other'
  assert.throws(() => assertApprovedLiquidity(approved, other))
  assert.throws(() => assertApprovedLiquidity(approved, { ...build(), transactions: [] }))
})

test('pool initialization may require only account rent, while add/remove must disclose token amounts', () => {
  const init = { ...quote(), operation: 'initialize', amounts: [] }
  assert.doesNotThrow(() => assertLiquidityQuote(init, { ...intent, operation: 'initialize' }))
  assert.throws(() => assertLiquidityQuote({ ...quote(), amounts: [] }, intent))
})
