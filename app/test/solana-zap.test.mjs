import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyPool, compactAmount, estimateLine, parseZapProgress, splitDeposit, stepLabel, ZAP_KEY } from '../src/lib/solana-zap-model.ts'

const SOL = 'So11111111111111111111111111111111111111112'
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
const SIG = '5'.repeat(88)

test('split mirrors the server: 0.5% buffer, then half swaps and half stays SOL', () => {
  assert.deepEqual(splitDeposit(1_000_000_000n), { swap: 497_500_000n, keep: 497_500_000n, buffer: 5_000_000n })
  const odd = splitDeposit(123_456_789n)
  assert.equal(odd.swap + odd.keep + odd.buffer, 123_456_789n)
  assert.throws(() => splitDeposit(0n))
})
test('classification mirrors the server', () => {
  assert.equal(classifyPool('meteora-damm-v2'), 'constant')
  assert.equal(classifyPool('raydium-amm'), 'constant')
  assert.equal(classifyPool('orca', { tickSpacing: 32896 }), 'splash')
  assert.equal(classifyPool('orca', { tickSpacing: 128 }), 'concentrated')
  assert.equal(classifyPool('meteora-dlmm', null), 'concentrated')
})
test('estimate and progress lines read like a swap', () => {
  assert.equal(compactAmount('1234567890', 6), '1,234.56')
  assert.equal(compactAmount('497500000', 9), '0.4975')
  assert.equal(compactAmount('5', 9), '0.000000005')
  const plan = { planId: 'p', direction: 'in', mint: MINT, owner: 'o', transactionVersion: '1', slippageBps: 100, pool: { venue: 'meteora-damm-v2', pool: 'x', kind: 'constant', mintA: MINT, mintB: SOL, reason: '' }, alternatives: [], expiresAt: 1,
    estimate: { depositSol: '1', positionValueSol: '0.94525', tokenExpected: '995000000', tokenDecimals: 6, networkFeeSolApprox: '0.00002' },
    steps: [{ kind: 'swap', title: 'Swapping 0.4975 SOL → $BORDR', inputMint: SOL, outputMint: MINT, amount: '497500000', expectedOut: '995000000', minOut: '985050000', slippageBps: 100 },
      { kind: 'add', title: 'Depositing into Meteora DAMM v2', venue: 'meteora-damm-v2', pool: 'x', mintA: MINT, mintB: SOL, tokenAmount: '995000000', solAmount: '497500000', parameters: {}, quote: { quoteId: 'q', expiresAt: 1, venue: 'meteora-damm-v2', operation: 'add', pool: 'x', slot: 1, amounts: [{ mint: MINT, decimals: 6, expectedRaw: '985050000', limitRaw: '985050000', direction: 'debit' }, { mint: SOL, decimals: 9, expectedRaw: '447750000', limitRaw: '497500000', direction: 'debit' }] } }] }
  assert.equal(estimateLine(plan, '$BORDR'), '≈ 0.44775 SOL + 985.05 $BORDR as LP')
  assert.equal(estimateLine({ ...plan, direction: 'out', estimate: { receiveSol: '0.0325', networkFeeSolApprox: '0.00001' } }, '$BORDR'), '≈ 0.0325 SOL')
  assert.equal(stepLabel(0, 2, plan.steps[0].title), '1/2 Swapping 0.4975 SOL → $BORDR')
})
test('resumable progress only restores a well-formed record', () => {
  assert.equal(ZAP_KEY, 'liquidityxyz.solana.zap.v1')
  const good = { planId: 'p', owner: 'o', version: '1', direction: 'in', mint: MINT, venue: 'orca', pool: 'x', titles: ['a', 'b'], step: 1, confirmed: [SIG], done: [], expiresAt: 5 }
  assert.deepEqual(parseZapProgress(JSON.stringify(good)), good)
  assert.deepEqual(parseZapProgress(JSON.stringify({ ...good, built: { step: 1, transactions: [{ transaction: 'x', lastValidBlockHeight: 1, expectedSigners: ['o'] }], next: 0, quote: {} }, pending: { signature: SIG, lastValidBlockHeight: 9 } }))?.pending, { signature: SIG, lastValidBlockHeight: 9 })
  for (const bad of [{ ...good, version: '2' }, { ...good, step: 3 }, { ...good, confirmed: ['nope'] }, { ...good, built: { step: 0, transactions: [], next: 0 } }, { ...good, pending: { signature: 'x', lastValidBlockHeight: 1 } }, { ...good, titles: [] }])
    assert.equal(parseZapProgress(JSON.stringify(bad)), null, JSON.stringify(bad))
  assert.equal(parseZapProgress('{nope'), null)
  assert.equal(parseZapProgress(null), null)
})
