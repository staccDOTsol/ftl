// One implementation of Solana wallet discovery and signer adapters, shared by
// the token-page trade form and the swap terminal. Sources: wallet-standard
// registry, injected Phantom/Solflare/window.solana, Helius embedded wallet.
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { VersionedTransaction } from '@solana/web3.js'
import { getWallets } from '@wallet-standard/app'
import type { Wallet, WalletAccount } from '@wallet-standard/base'
import { StandardConnect, StandardDisconnect, StandardEvents, type StandardConnectFeature, type StandardDisconnectFeature, type StandardEventsFeature } from '@wallet-standard/features'
import { SolanaSignTransaction, type SolanaSignTransactionFeature } from '@solana/wallet-standard-features'
import { inspectTransaction, preferredTransactionVersion, type TransactionVersion } from '@/lib/solana-wire'
import { Button, Txt } from './ui'

export interface SolanaSigner { address: string | null; transactionVersion: TransactionVersion | null; connect: () => Promise<void>; disconnect: () => Promise<void>; sign: (bytes: Uint8Array) => Promise<Uint8Array> }
export type StandardSolanaWallet = Wallet & { features: StandardConnectFeature & SolanaSignTransactionFeature & Partial<StandardDisconnectFeature & StandardEventsFeature> }
export function isStandardSolana(wallet: Wallet): wallet is StandardSolanaWallet {
  return wallet.chains.includes('solana:mainnet') && StandardConnect in wallet.features && SolanaSignTransaction in wallet.features
}
export const signingAccount = (accounts: readonly WalletAccount[]) => accounts.find(account => account.chains.includes('solana:mainnet') && account.features.includes(SolanaSignTransaction)) ?? null
export interface InjectedWallet {
  publicKey?: { toBase58(): string }
  connect(): Promise<unknown>
  disconnect(): Promise<void>
  signTransaction(tx: VersionedTransaction): Promise<VersionedTransaction>
  on?(event: string, callback: () => void): void
  removeListener?(event: string, callback: () => void): void
}
export type InjectedEntry = { name: string; provider: InjectedWallet }

export function injectedWallets(): InjectedEntry[] {
  if (typeof window === 'undefined') return []
  const browser = window as unknown as { phantom?: { solana?: InjectedWallet }; solflare?: InjectedWallet; solana?: InjectedWallet }
  const candidates = [
    { name: 'Phantom', provider: browser.phantom?.solana },
    { name: 'Solflare', provider: browser.solflare },
    { name: 'Browser wallet', provider: browser.solana },
  ]
  const seen = new Set<InjectedWallet>()
  return candidates.filter((entry): entry is InjectedEntry => {
    if (!entry.provider?.signTransaction || seen.has(entry.provider)) return false
    seen.add(entry.provider)
    return true
  })
}

// Selection keys: `standard:<name>`, `<injected name>`, or `embedded`.
export type WalletKey = string
export const EMBEDDED_KEY: WalletKey = 'embedded'
export const standardKey = (wallet: StandardSolanaWallet): WalletKey => `standard:${wallet.name}`

export interface SolanaWallets { standard: StandardSolanaWallet[]; injected: InjectedEntry[]; rescan: () => void }
export function useSolanaWallets(): SolanaWallets {
  const [injected, setInjected] = useState<InjectedEntry[]>([])
  const [standard, setStandard] = useState<StandardSolanaWallet[]>([])
  useEffect(() => {
    const registry = getWallets()
    const scan = () => { setInjected(injectedWallets()); setStandard(registry.get().filter(isStandardSolana)) }
    const timer = setTimeout(scan, 0)
    const offRegister = registry.on('register', scan), offUnregister = registry.on('unregister', scan)
    return () => { clearTimeout(timer); offRegister(); offUnregister() }
  }, [])
  const rescan = useCallback(() => setInjected(injectedWallets()), [])
  return { standard, injected, rescan }
}

// Injected providers that also registered through wallet-standard are listed once.
export const uniqueInjected = (wallets: SolanaWallets) => wallets.injected.filter(wallet => !wallets.standard.some(standard => standard.name === wallet.name))
export const walletVersionBadge = (wallet: StandardSolanaWallet) => preferredTransactionVersion(wallet.features[SolanaSignTransaction].supportedTransactionVersions) === '1' ? ' · V1' : ''

export function walletName(key: WalletKey | null, wallets: SolanaWallets): string | null {
  if (!key) return null
  if (key === EMBEDDED_KEY) return 'Embedded wallet'
  return wallets.standard.find(wallet => standardKey(wallet) === key)?.name ?? wallets.injected.find(wallet => wallet.name === key)?.name ?? null
}

export function WalletPicker({ wallets, onSelect, disabled, embeddedKind = 'primary' }: { wallets: SolanaWallets; onSelect: (key: WalletKey) => void; disabled?: boolean; embeddedKind?: 'primary' | 'ghost' }) {
  return <View style={st.wrap}>
    {wallets.standard.map(wallet => <Button key={wallet.name} label={`${wallet.name}${walletVersionBadge(wallet)}`} kind="ghost" disabled={disabled} onPress={() => onSelect(standardKey(wallet))} />)}
    {uniqueInjected(wallets).map(wallet => <Button key={wallet.name} label={wallet.name} kind="ghost" disabled={disabled} onPress={() => onSelect(wallet.name)} />)}
    <Button label="Embedded wallet" kind={embeddedKind} disabled={disabled} onPress={() => onSelect(EMBEDDED_KEY)} />
  </View>
}

export function useStandardSigner(wallet: StandardSolanaWallet): SolanaSigner {
  const [account, setAccount] = useState<WalletAccount | null>(() => signingAccount(wallet.accounts))
  const [capabilities, updateCapabilities] = useState(0)
  useEffect(() => wallet.features[StandardEvents]?.on('change', () => {
    setAccount(signingAccount(wallet.accounts)); updateCapabilities(value => value + 1)
  }), [wallet])
  return useMemo<SolanaSigner>(() => ({
    address: account?.address ?? null,
    transactionVersion: preferredTransactionVersion(wallet.features[SolanaSignTransaction].supportedTransactionVersions),
    connect: async () => {
      const result = await wallet.features[StandardConnect].connect()
      const selected = signingAccount(result.accounts)
      if (!selected) throw new Error('Choose a Solana mainnet account with transaction signing enabled.')
      setAccount(selected)
    },
    disconnect: async () => { await wallet.features[StandardDisconnect]?.disconnect(); setAccount(null) },
    sign: async bytes => {
      const current = wallet.accounts.find(candidate => candidate.address === account?.address)
      if (!current || !current.chains.includes('solana:mainnet') || !current.features.includes(SolanaSignTransaction)) throw new Error('Wallet account changed. Connect again.')
      const version = inspectTransaction(bytes).version
      if (version === 'legacy' || !wallet.features[SolanaSignTransaction].supportedTransactionVersions.includes(Number(version) as 0 | 1)) throw new Error('Wallet transaction support changed. Reconnect and request a fresh quote.')
      const results = await wallet.features[SolanaSignTransaction].signTransaction({ account: current, transaction: bytes, chain: 'solana:mainnet', options: { preflightCommitment: 'confirmed' } })
      if (results.length !== 1) throw new Error('Wallet did not return the requested transaction.')
      return results[0].signedTransaction
    },
  // `capabilities` forces a re-read of wallet.features after a change event.
  }), [wallet, account, capabilities])
}

export function useInjectedSigner(provider: InjectedWallet): SolanaSigner {
  const [address, setAddress] = useState<string | null>(provider.publicKey?.toBase58() ?? null)
  useEffect(() => {
    const update = () => setAddress(provider.publicKey?.toBase58() ?? null)
    provider.on?.('accountChanged', update)
    provider.on?.('disconnect', update)
    return () => { provider.removeListener?.('accountChanged', update); provider.removeListener?.('disconnect', update) }
  }, [provider])
  return useMemo<SolanaSigner>(() => ({
    address,
    transactionVersion: '0',
    connect: async () => { await provider.connect(); setAddress(provider.publicKey?.toBase58() ?? null) },
    disconnect: async () => { await provider.disconnect(); setAddress(null) },
    sign: async bytes => {
      if (!address || provider.publicKey?.toBase58() !== address) throw new Error('Wallet changed. Connect again and request a fresh quote.')
      const signed = await provider.signTransaction(VersionedTransaction.deserialize(bytes))
      if (provider.publicKey?.toBase58() !== address) throw new Error('Wallet changed before signing completed.')
      return signed.serialize()
    },
  }), [provider, address])
}

const EmbeddedWallet = lazy(() => import('./SolanaTradeEmbedded.web'))
type SessionChild = (signer: SolanaSigner, name: string) => ReactNode

function StandardSession({ wallet, children }: { wallet: StandardSolanaWallet; children: SessionChild }) {
  const signer = useStandardSigner(wallet)
  return <>{children(signer, wallet.name)}</>
}
function InjectedSession({ entry, children }: { entry: InjectedEntry; children: SessionChild }) {
  const signer = useInjectedSigner(entry.provider)
  return <>{children(signer, entry.name)}</>
}

// Resolves a selected wallet key to a live signer and renders `children` with
// it. `embeddedTitle` is the heading the embedded wallet shows above its
// children (null hides it). Returns null when the key matches no wallet.
export function WalletSession({ selected, wallets, onBack, embeddedTitle, children }: { selected: WalletKey | null; wallets: SolanaWallets; onBack: () => void; embeddedTitle?: string | null; children: SessionChild }) {
  if (selected === EMBEDDED_KEY) return <Suspense fallback={<Txt v="small">Loading embedded wallet…</Txt>}>
    <EmbeddedWallet onBack={onBack} title={embeddedTitle}>{signer => children(signer, 'Embedded wallet')}</EmbeddedWallet>
  </Suspense>
  const standard = wallets.standard.find(wallet => standardKey(wallet) === selected)
  if (standard) return <StandardSession key={standard.name} wallet={standard}>{children}</StandardSession>
  const injected = wallets.injected.find(wallet => wallet.name === selected)
  if (injected) return <InjectedSession key={injected.name} entry={injected}>{children}</InjectedSession>
  return null
}

const st = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
})
