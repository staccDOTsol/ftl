import { useEffect } from 'react'
import { getWallets } from '@wallet-standard/app'
import { StandardEvents } from '@wallet-standard/features'
import { getWalletSession, selectWallet, updateWalletSession, useWalletSession } from '@/lib/wallet-session'
import { injectedWallets, isStandardSolana, signingAccount, standardKey } from './SolanaWallet.web'

// Observe permission/account changes across the whole workspace, including
// while a read-only portfolio is visible. This never connects or signs.
export default function WalletObserver() {
  const { key } = useWalletSession()
  useEffect(() => {
    if (!key || key === 'embedded') return
    const registry = getWallets()
    let detach = () => {}
    const attach = () => {
      detach()
      const standard = registry.get().filter(isStandardSolana).find(wallet => standardKey(wallet) === key)
      if (standard) {
        const update = () => {
          const account = signingAccount(standard.accounts)
          if (account) updateWalletSession(key, account.address, standard.name)
          else if (getWalletSession().key === key && getWalletSession().address) selectWallet(null)
        }
        detach = standard.features[StandardEvents]?.on('change', update) ?? (() => {})
        return
      }
      const injected = injectedWallets().find(wallet => wallet.name === key)
      if (!injected) return
      const update = () => {
        const address = injected.provider.publicKey?.toBase58() ?? null
        if (address) updateWalletSession(key, address, injected.name)
        else if (getWalletSession().key === key) selectWallet(null)
      }
      injected.provider.on?.('accountChanged', update)
      injected.provider.on?.('disconnect', update)
      detach = () => { injected.provider.removeListener?.('accountChanged', update); injected.provider.removeListener?.('disconnect', update) }
    }
    attach()
    const register = registry.on('register', attach)
    const unregister = registry.on('unregister', attach)
    return () => { detach(); register(); unregister() }
  }, [key])
  return null
}
