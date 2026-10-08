import test from 'node:test'
import assert from 'node:assert/strict'
import { moveAmounts, moveTag, moveText, txUrl } from '../src/lib/move-text.ts'

const SOL = 'So11111111111111111111111111111111111111112'
const add = { venue: 'raydium-clmm', operation: 'add', pool: 'pool', amounts: [{ mint: 'mint', amount: '1234.5', symbol: 'FTL' }, { mint: SOL, amount: '0.25', symbol: 'SOL' }] }

test('move tag pairs the operation with the venue label, and drops the venue for a plain swap', () => {
  assert.equal(moveTag(add), 'ADDED LP · Raydium CLMM')
  assert.equal(moveTag({ venue: 'orca', operation: 'remove' }), 'PULLED LP · Orca')
  assert.equal(moveTag({ venue: 'meteora-dlmm', operation: 'initialize' }), 'OPENED POOL · Meteora DLMM')
  assert.equal(moveTag({ venue: 'raydium-amm-v4', operation: 'swap' }), 'SWAPPED · Raydium AMM v4')
  assert.equal(moveTag({ venue: 'swap', operation: 'swap' }), 'SWAPPED')
})

test('amounts line is compact and falls back to a short mint without a symbol', () => {
  assert.equal(moveAmounts(add), '1235 FTL + 0.25 SOL')
  assert.equal(moveAmounts({ venue: 'swap', operation: 'swap' }), null)
  assert.equal(moveAmounts({ venue: 'swap', operation: 'swap', amounts: [] }), null)
  assert.equal(moveAmounts({ venue: 'swap', operation: 'swap', amounts: [{ mint: '7rLy8n6iETLdQrWgpv8XejNjLwrhKHNDrwb2kibnpump', amount: '12' }] }), '12 7rLy…pump')
})

test('prefilled text reads as a sentence for every operation', () => {
  assert.equal(moveText(add, '$FTL'), 'Added liquidity to $FTL on Raydium CLMM')
  assert.equal(moveText({ venue: 'orca', operation: 'remove' }, '$FTL'), 'Pulled liquidity from $FTL on Orca')
  assert.equal(moveText({ venue: 'pumpswap', operation: 'initialize' }, '$FTL'), 'Opened a pool for $FTL on PumpSwap')
  assert.equal(moveText({ venue: 'swap', operation: 'swap' }, '$FTL'), 'Bought $FTL')
  assert.equal(moveText({ venue: 'swap', operation: 'swap' }, '$FTL', 'sell'), 'Sold $FTL')
  assert.equal(moveText({ venue: 'raydium-cpmm', operation: 'swap' }, '$FTL', 'buy'), 'Bought $FTL on Raydium CPMM')
})

test('tx link opens the signature on Solscan', () => {
  assert.equal(txUrl('5abc'), 'https://solscan.io/tx/5abc')
})
