import test from 'node:test'
import assert from 'node:assert/strict'
import { aprLabel, estimateShare } from '../src/lib/solana-liquidity-model.ts'

const stats = (feeApr, totalApr = feeApr) => ({ venue: 'orca', pool: 'p', tvlUsd: 84_000, volume24hUsd: 310_000, fees24hUsd: 1_200, feeRateBps: 16, feeApr, rewardApr: null, totalApr, source: 'api.orca.so', fetchedAt: 0 })

test('aprLabel prefers total APR, scales digits, and is null without data', () => {
  assert.equal(aprLabel(stats(12.4)), 'Est. APR 12.4%')
  assert.equal(aprLabel(stats(6.8, 9.3)), 'Est. APR 9.30%')
  assert.equal(aprLabel(stats(0.1764)), 'Est. APR 0.18%')
  assert.equal(aprLabel(stats(29224.449)), 'Est. APR 29224%')
  assert.equal(aprLabel(stats(2e6)), 'Est. APR >1M%')
  assert.equal(aprLabel(stats(0)), 'Est. APR 0.00%')
  assert.equal(aprLabel(stats(null, null)), null)
  assert.equal(aprLabel(null), null)
  assert.equal(aprLabel(stats(NaN, NaN)), null)
})

test('estimateShare is feeApr percent times the deposit, in USD per year', () => {
  assert.equal(estimateShare(stats(12.4), 1000), 124)
  assert.equal(estimateShare(stats(64.39122567804017), 250), 250 * 64.39122567804017 / 100)
  assert.equal(estimateShare(stats(null, null), 1000), null)
  assert.equal(estimateShare(stats(5), -1), null)
  assert.equal(estimateShare(null, 1000), null)
})
