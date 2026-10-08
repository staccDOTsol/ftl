import test from 'node:test'
import assert from 'node:assert/strict'
import { actionMint, holdingLabel, isActionHref, isSolanaAddress, liquidityActionHref, SOL_MINT, shortAddress } from '../src/lib/solana-holdings-model.ts'

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
  assert.equal(isActionHref('/swap?mode=liquidity&out=53cTDPa69sUXtn4FiuXiKEipJGkUUaNxoisBiuSFkd5i'), true)
  assert.equal(isActionHref('/swap?mode=liquidity&out=53cTDPa69sUXtn4FiuXiKEipJGkUUaNxoisBiuSFkd5i&pool=3KphxamdB1apYohQStGATZrKGpk7Yf31G9H18Gpp8He7&action=exit'), true)
  assert.equal(isActionHref('/swap?mode=liquidity&out=53cTDPa69sUXtn4FiuXiKEipJGkUUaNxoisBiuSFkd5i&action=drain'), false)
  assert.equal(isActionHref('/swap?in=SOL&out=53cTDPa69sUXtn4FiuXiKEipJGkUUaNxoisBiuSFkd5i'), false)
  assert.equal(actionMint('/token/solana/53cTDPa69sUXtn4FiuXiKEipJGkUUaNxoisBiuSFkd5i?action=sell'), '53cTDPa69sUXtn4FiuXiKEipJGkUUaNxoisBiuSFkd5i')
  assert.equal(actionMint('/swap?mode=liquidity&out=53cTDPa69sUXtn4FiuXiKEipJGkUUaNxoisBiuSFkd5i'), null)
})

test('add and exit actions on tokens without a token page open the terminal in Liquidity mode', () => {
  const MINT = 'A9ECbJ9UKSgf92A5QTW7dcJMcA14mUw3g3c4SMkNKnH4', POOL = '3KphxamdB1apYohQStGATZrKGpk7Yf31G9H18Gpp8He7', OTHER = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'
  const positions = [{ mintA: MINT, mintB: SOL_MINT, pool: OTHER }, { mintA: SOL_MINT, mintB: MINT, pool: POOL }]
  const exit = { kind: 'exit', href: `/token/solana/${MINT}?action=exit`, detail: `SOL / A9EC…KnH4 · pool ${shortAddress(POOL)} · 5000 liquidity units` }
  const add = { kind: 'add', href: `/token/solana/${MINT}?action=liquidity`, detail: '1 held' }
  const sell = { kind: 'sell', href: `/token/solana/${MINT}?action=sell`, detail: '1 held' }
  const unseen = () => false, known = () => true
  assert.equal(liquidityActionHref(exit, unseen, positions), `/swap?mode=liquidity&out=${MINT}&pool=${POOL}&action=exit`)
  assert.equal(liquidityActionHref({ ...exit, detail: 'no pool here' }, unseen, positions), `/swap?mode=liquidity&out=${MINT}&action=exit`)
  assert.equal(liquidityActionHref(add, unseen, positions), `/swap?mode=liquidity&out=${MINT}`)
  assert.equal(liquidityActionHref(exit, known, positions), exit.href)
  assert.equal(liquidityActionHref(sell, unseen, positions), sell.href)
  assert.ok(isActionHref(liquidityActionHref(exit, unseen, positions)))
})
