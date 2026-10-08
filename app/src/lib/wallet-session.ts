import { useSyncExternalStore } from 'react'

// A connection chosen by the person follows them between workspaces. This is
// deliberately memory-only: a pasted address never selects a signer, and a
// fresh page load never opens a wallet permission prompt on its own.
type Session = { key: string | null; address: string | null; name: string | null }
let session: Session = { key: null, address: null, name: null }
const listeners = new Set<() => void>()
const emit = () => { for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const getWalletSession = () => session
export function selectWallet(key: string | null) {
  if (key === session.key) return
  session = { key, address: null, name: null }
  emit()
}
export function updateWalletSession(key: string, address: string | null, name: string) {
  if (session.key !== key || session.address === address && session.name === name) return
  session = { key, address, name }
  emit()
}
export function useWalletSession() { return useSyncExternalStore(subscribe, getWalletSession, getWalletSession) }
export function useWalletSelection(): [string | null, (key: string | null) => void] {
  return [useWalletSession().key, selectWallet]
}
