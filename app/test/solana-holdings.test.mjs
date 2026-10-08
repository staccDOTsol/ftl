import test from 'node:test'
import assert from 'node:assert/strict'
import { actionMint, heldTokens, holdingLabel, isActionHref, isSolanaAddress, liquidityActionHref, SOL_MINT, shortAddress } from '../src/lib/solana-holdings-model.ts'

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

test('held tokens: native SOL and nonzero SPL balances per mint, by USD value then balance', () => {
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', BREAD = '53cTDPa69sUXtn4FiuXiKEipJGkUUaNxoisBiuSFkd5i', DUST = 'A9ECbJ9UKSgf92A5QTW7dcJMcA14mUw3g3c4SMkNKnH4'
  const account = (mint, amount, decimals, extra = {}) => ({ account: mint, mint, amount, decimals, program: 'token', wrappedSol: false, token: null, pools: [], ...extra })
  const tokens = [account(BREAD, '5000000', 6, { token: { symbol: 'BREAD' } }), account(USDC, '2500000', 6), account(BREAD, '1000000', 6), account(DUST, '0', 6), account(SOL_MINT, '9000000000', 9, { wrappedSol: true }), account(DUST, '7', 0)]
  const rows = heldTokens({ sol: { lamports: '1500000000' }, tokens }, mint => ({ [SOL_MINT]: 100, [USDC]: 1 })[mint])
  assert.deepEqual(rows.map(row => [row.mint, row.amount, row.usd]), [[SOL_MINT, '1500000000', 150], [USDC, '2500000', 2.5], [DUST, '7', null], [BREAD, '6000000', null]])
  assert.equal(rows[3].token.symbol, 'BREAD')
  assert.deepEqual(heldTokens({ sol: { lamports: '0' }, tokens: [] }), [])
  assert.deepEqual(heldTokens({ sol: { lamports: '0' }, tokens: [account(BREAD, '1', 0)] }).map(row => row.usd), [null])
})
