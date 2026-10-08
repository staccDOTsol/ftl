import test from 'node:test'
import assert from 'node:assert/strict'
import { cachedMeta, clearMetaCache, chunk, knownMeta, metaSymbol, missingMints, rememberMeta, retitle, uniqueMints } from '../src/lib/token-meta-model.ts'
import { SOL_MINT } from '../src/lib/solana-trade.ts'

const A = 'A9ECbJ9UKSgf92A5QTW7dcJMcA14mUw3g3c4SMkNKnH4'
const B = '53cTDPa69sUXtn4FiuXiKEipJGkUUaNxoisBiuSFkd5i'
const record = (mint, symbol) => ({ mint, symbol, name: symbol ? `${symbol} coin` : null, image: null, decimals: 6, tokenProgram: 'token', source: symbol ? 'das' : 'chain' })

test('mint lists are deduplicated, validated and never include SOL', () => {
  assert.deepEqual(uniqueMints([A, ' ' + A + ' ', SOL_MINT, null, undefined, '', 'junk', B, A]), [A, B])
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
})

test('the cache remembers hits and misses, expires after ten minutes and reports what is missing', () => {
  clearMetaCache()
  assert.deepEqual(missingMints([A, B]), [A, B])
  rememberMeta({ [A]: record(A, 'BREAD'), [B]: null }, 1_000)
  assert.equal(cachedMeta(A, 1_000).symbol, 'BREAD')
  assert.equal(cachedMeta(B, 1_000), null)
  assert.deepEqual(missingMints([A, B], 1_000), [])
  assert.deepEqual(Object.keys(knownMeta([A, B], 1_000)), [A])
  assert.deepEqual(missingMints([A, B], 1_000 + 10 * 60_000 + 1), [A, B])
  clearMetaCache()
})

test('labels prefer the symbol and fall back to the short mint; titles swap the short mint for $SYMBOL', () => {
  const meta = { [A]: record(A, 'BREAD'), [B]: record(B, null) }
  assert.equal(metaSymbol(A, meta), 'BREAD')
  assert.equal(metaSymbol(B, meta), '53cT…kd5i')
  assert.equal(metaSymbol(B, meta, 'ROW'), 'ROW')
  assert.equal(metaSymbol(SOL_MINT, meta), 'SOL')
  assert.equal(metaSymbol(A, null), 'A9EC…KnH4')
  assert.equal(retitle('Sell A9EC…KnH4', A, meta), 'Sell $BREAD')
  assert.equal(retitle('Exit A9EC…KnH4 liquidity on orca', A, meta), 'Exit $BREAD liquidity on orca')
  assert.equal(retitle('Exit 53cT…kd5i liquidity on orca', B, meta), 'Exit 53cT…kd5i liquidity on orca')
  assert.equal(retitle('Sell A9EC…KnH4', A, { [A]: record(A, 'X'.repeat(20)) }), 'Sell $' + 'X'.repeat(14))
})
