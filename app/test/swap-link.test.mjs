import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSwapLink, swapLink, liquidityLink, rateString, trimSignificant, resolveMintParam, formatBps, USDC_MINT } from '../src/lib/swap-link.ts'
import { parsePending, PENDING_KEY } from '../src/lib/solana-pending.ts'
import { SOL_MINT } from '../src/lib/solana-trade.ts'

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
const POOL = '3KphxamdB1apYohQStGATZrKGpk7Yf31G9H18Gpp8He7'
const swap = { mode: 'swap', pool: null, action: null, advanced: false }

test('deep links resolve symbols and mints, and drop junk', () => {
  assert.deepEqual(parseSwapLink({ in: 'SOL', out: MINT, amount: '1.5' }), { inputMint: SOL_MINT, outputMint: MINT, amount: '1.5', ...swap })
  assert.deepEqual(parseSwapLink({ in: 'usdc', out: 'sol' }), { inputMint: USDC_MINT, outputMint: SOL_MINT, amount: '', ...swap })
  assert.deepEqual(parseSwapLink({ in: 'not-a-mint', out: 'javascript:alert(1)', amount: '-3' }), { inputMint: SOL_MINT, outputMint: null, amount: '', ...swap })
  assert.deepEqual(parseSwapLink({ in: MINT, out: MINT, amount: '0' }), { inputMint: MINT, outputMint: null, amount: '', ...swap })
  assert.deepEqual(parseSwapLink({ in: ['SOL', 'USDC'], amount: ['2'] }), { inputMint: SOL_MINT, outputMint: null, amount: '2', ...swap })
  assert.deepEqual(parseSwapLink(undefined), { inputMint: SOL_MINT, outputMint: null, amount: '', ...swap })
  assert.equal(resolveMintParam('1e5'), null)
})

test('liquidity deep links carry mode, pool and action; pool and action only count in Liquidity mode', () => {
  assert.deepEqual(parseSwapLink({ mode: 'liquidity', out: MINT }), { inputMint: SOL_MINT, outputMint: MINT, amount: '', mode: 'liquidity', pool: null, action: null, advanced: false })
  assert.deepEqual(parseSwapLink({ mode: 'liquidity', out: MINT, pool: POOL, action: 'exit' }), { inputMint: SOL_MINT, outputMint: MINT, amount: '', mode: 'liquidity', pool: POOL, action: 'exit', advanced: false })
  assert.deepEqual(parseSwapLink({ mode: 'LIQUIDITY', out: MINT, pool: 'not-a-pool', action: 'drain' }), { inputMint: SOL_MINT, outputMint: MINT, amount: '', mode: 'liquidity', pool: null, action: null, advanced: false })
  assert.deepEqual(parseSwapLink({ mode: 'swap', out: MINT, pool: POOL, action: 'exit' }), { inputMint: SOL_MINT, outputMint: MINT, amount: '', ...swap })
  assert.deepEqual(parseSwapLink({ mode: 'bogus', out: MINT }), { inputMint: SOL_MINT, outputMint: MINT, amount: '', ...swap })
  assert.deepEqual(parseSwapLink({ mode: 'liquidity', out: MINT, advanced: '1' }), { inputMint: SOL_MINT, outputMint: MINT, amount: '', mode: 'liquidity', pool: null, action: null, advanced: true })
  assert.equal(parseSwapLink({ mode: 'liquidity', out: MINT, advanced: 'yes' }).advanced, false)
  assert.equal(parseSwapLink({ out: MINT, advanced: '1' }).advanced, false, 'advanced only counts in Liquidity mode')
  assert.equal(liquidityLink(MINT, null, null, true), `/swap?mode=liquidity&out=${MINT}&advanced=1`)
  assert.equal(swapLink(SOL_MINT, MINT, null, { mode: 'liquidity', advanced: true }), `/swap?mode=liquidity&in=SOL&out=${MINT}&advanced=1`)
  assert.equal(liquidityLink(MINT), `/swap?mode=liquidity&out=${MINT}`)
  assert.equal(liquidityLink(MINT, POOL), `/swap?mode=liquidity&out=${MINT}&pool=${POOL}`)
  assert.equal(liquidityLink(MINT, POOL, 'exit'), `/swap?mode=liquidity&out=${MINT}&pool=${POOL}&action=exit`)
  const link = liquidityLink(MINT, POOL, 'exit')
  assert.deepEqual(parseSwapLink(Object.fromEntries(new URLSearchParams(link.slice('/swap?'.length)))), { inputMint: SOL_MINT, outputMint: MINT, amount: '', mode: 'liquidity', pool: POOL, action: 'exit', advanced: false })
  assert.equal(swapLink(SOL_MINT, MINT, null, { mode: 'liquidity', pool: POOL }), `/swap?mode=liquidity&in=SOL&out=${MINT}&pool=${POOL}`)
  assert.equal(swapLink(SOL_MINT, MINT, '1', { mode: 'swap', pool: POOL, action: 'exit' }), `/swap?in=SOL&out=${MINT}&amount=1`)
})

test('swap links round-trip through the parser', () => {
  const link = swapLink(SOL_MINT, MINT, '0.25')
  assert.equal(link, `/swap?in=SOL&out=${MINT}&amount=0.25`)
  const params = Object.fromEntries(new URLSearchParams(link.slice('/swap?'.length)))
  assert.deepEqual(parseSwapLink(params), { inputMint: SOL_MINT, outputMint: MINT, amount: '0.25', ...swap })
  assert.equal(swapLink(MINT), `/swap?in=${MINT}`)
  assert.equal(swapLink(SOL_MINT, null, '0'), '/swap?in=SOL')
})

test('rate lines divide exactly and keep significant digits', () => {
  // 1 SOL (9 dp) → 150 USDC (6 dp)
  assert.equal(rateString('1000000000', 9, '150000000', 6), '150')
  // 2 SOL → 1 token with 6 dp: 0.5 per SOL
  assert.equal(rateString('2000000000', 9, '1000000', 6), '0.5')
  // reverse direction: 1 USDC ≈ 0.00666666 SOL
  assert.equal(rateString('150000000', 6, '1000000000', 9), '0.00666666')
  // tiny rate stays meaningful
  assert.equal(rateString('1000000000', 9, '1', 9), '0.000000001')
  assert.equal(rateString('1000000000', 9, '123456789012', 6), '123456')
  assert.equal(rateString('0', 9, '1', 6), null)
  assert.equal(trimSignificant('1234.56789', 6), '1234.56')
  assert.equal(trimSignificant('0.000123456789', 6), '0.000123456')
  assert.equal(trimSignificant('42', 6), '42')
  assert.equal(formatBps(50), '0.5%')
  assert.equal(formatBps(10), '0.1%')
})

test('pending swaps only restore a well-formed pending record under the shared key', () => {
  assert.equal(PENDING_KEY, 'liquidityxyz.solana.pending.v1')
  const signature = '5'.repeat(88)
  assert.deepEqual(parsePending(JSON.stringify({ signature, lastValidBlockHeight: 123, state: 'pending' })), { signature, lastValidBlockHeight: 123, state: 'pending' })
  assert.equal(parsePending(JSON.stringify({ signature, lastValidBlockHeight: 123, state: 'confirmed' })), null)
  assert.equal(parsePending(JSON.stringify({ signature: '0'.repeat(88), lastValidBlockHeight: 123, state: 'pending' })), null)
  assert.equal(parsePending(JSON.stringify({ signature, lastValidBlockHeight: 1.5, state: 'pending' })), null)
  assert.equal(parsePending('{not json'), null)
  assert.equal(parsePending(null), null)
})
