import test from 'node:test'
import assert from 'node:assert/strict'
import { getWalletSession, selectWallet, updateWalletSession } from '../src/lib/wallet-session.ts'

test('a route change can reuse an explicitly selected wallet without selecting a watched address', () => {
  selectWallet(null)
  updateWalletSession('standard:Phantom', 'watched-address', 'Phantom')
  assert.equal(getWalletSession().address, null)
  selectWallet('standard:Phantom')
  updateWalletSession('standard:Phantom', 'connected-address', 'Phantom')
  assert.equal(getWalletSession().address, 'connected-address')
  selectWallet('standard:Phantom')
  assert.equal(getWalletSession().address, 'connected-address')
  selectWallet('Solflare')
  assert.equal(getWalletSession().address, null)
  updateWalletSession('standard:Phantom', 'late-result', 'Phantom')
  assert.equal(getWalletSession().address, null)
  selectWallet(null)
  assert.deepEqual(getWalletSession(), { key: null, address: null, name: null })
})
