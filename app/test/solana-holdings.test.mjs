import test from 'node:test'
import assert from 'node:assert/strict'
import { holdingLabel, isActionHref, isSolanaAddress, SOL_MINT, shortAddress } from '../src/lib/solana-holdings-model.ts'

test('wallet address validation checks decoded length, not only characters', () => {
  assert.equal(isSolanaAddress(SOL_MINT), true)
  assert.equal(isSolanaAddress(`  ${SOL_MINT}  `), true)
  assert.equal(isSolanaAddress('1'.repeat(44)), false)
  assert.equal(isSolanaAddress('0xabc'), false)
  assert.equal(isSolanaAddress(''), false)
})

test('holding labels prefer the FTL symbol, then wrapped SOL, then a short mint', () => {
  assert.equal(holdingLabel({ mint: SOL_MINT, wrappedSol: true, token: null }), 'Wrapped SOL')
  assert.equal(holdingLabel({ mint: '53cTDPa69sUXtn4FiuXiKEipJGkUUaNxoisBiuSFkd5i', wrappedSol: false, token: { symbol: 'BREAD' } }), '$BREAD')
  assert.equal(holdingLabel({ mint: '53cTDPa69sUXtn4FiuXiKEipJGkUUaNxoisBiuSFkd5i', wrappedSol: false, token: null }), '53cT…kd5i')
  assert.equal(shortAddress(SOL_MINT), 'SOL')
})

test('only in-app token routes are followed as actions', () => {
  assert.equal(isActionHref(`/token/solana/${SOL_MINT}`), true)
  assert.equal(isActionHref('/token/solana/53cTDPa69sUXtn4FiuXiKEipJGkUUaNxoisBiuSFkd5i?action=sell'), true)
  assert.equal(isActionHref('/token/solana/53cTDPa69sUXtn4FiuXiKEipJGkUUaNxoisBiuSFkd5i?action=exit'), true)
  assert.equal(isActionHref('https://evil.example/token/solana/x'), false)
  assert.equal(isActionHref('/token/robinhood/0xabc'), false)
  assert.equal(isActionHref('/token/solana/53cTDPa69sUXtn4FiuXiKEipJGkUUaNxoisBiuSFkd5i?action=drain'), false)
})
