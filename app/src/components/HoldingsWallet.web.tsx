// Connect-only wallet picker for the holdings screen. Same wallet sources as
// the trade panel (wallet-standard, injected Phantom/Solflare, Helius
// embedded), but nothing here ever asks for a signature.
import { lazy, Suspense, useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { getWallets } from '@wallet-standard/app'
import { StandardConnect } from '@wallet-standard/features'
import { C } from '@/theme'
import { injectedWallets, isStandardSolana, signingAccount, type InjectedWallet, type SolanaSigner, type StandardSolanaWallet } from './SolanaTrade.web'
import { Button, Txt } from './ui'
import { selectWallet, updateWalletSession } from '@/lib/wallet-session'

const EmbeddedWallet = lazy(() => import('./SolanaTradeEmbedded.web'))
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Wallet connection failed. Try again.'

export default function HoldingsWallet({ onAddress }: { onAddress: (address: string) => void }) {
  const [wallets, setWallets] = useState<ReturnType<typeof injectedWallets>>([])
  const [standardWallets, setStandardWallets] = useState<StandardSolanaWallet[]>([])
  const [embedded, setEmbedded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const registry = getWallets()
    const scan = () => { setWallets(injectedWallets()); setStandardWallets(registry.get().filter(isStandardSolana)) }
    const timer = setTimeout(scan, 0)
    const offRegister = registry.on('register', scan), offUnregister = registry.on('unregister', scan)
    return () => { clearTimeout(timer); offRegister(); offUnregister() }
  }, [])
  async function connect(name: string, key: string, run: () => Promise<string | null | undefined>) {
    if (busy) return
    setBusy(name); setError(null)
    try {
      const address = await run()
      if (!address) throw new Error('The wallet did not return a Solana mainnet account.')
      selectWallet(key)
      updateWalletSession(key, address, name)
      onAddress(address)
    } catch (e) { setError(messageOf(e)) } finally { setBusy(null) }
  }
  const connectStandard = (wallet: StandardSolanaWallet) => connect(wallet.name, `standard:${wallet.name}`, async () => {
    const result = await wallet.features[StandardConnect].connect()
    return (signingAccount(result.accounts) ?? result.accounts.find(account => account.chains.includes('solana:mainnet')))?.address
  })
  const connectInjected = (name: string, provider: InjectedWallet) => connect(name, name, async () => { await provider.connect(); return provider.publicKey?.toBase58() })

  if (embedded) return <Suspense fallback={<Txt v="small">Loading embedded wallet…</Txt>}>
    <EmbeddedWallet title="Your embedded wallet" onBack={() => setEmbedded(false)}>{signer => <EmbeddedConnect signer={signer} onAddress={onAddress} onBack={() => setEmbedded(false)} />}</EmbeddedWallet>
  </Suspense>
  return <View style={st.stack}>
    <Txt v="small">Connect to read your balances. No signature needed.</Txt>
    <View style={st.wrap}>
      {standardWallets.map(wallet => <Button key={wallet.name} label={wallet.name} kind="ghost" busy={busy === wallet.name} disabled={!!busy} onPress={() => void connectStandard(wallet)} />)}
      {wallets.filter(wallet => !standardWallets.some(standard => standard.name === wallet.name)).map(wallet => <Button key={wallet.name} label={wallet.name} kind="ghost" busy={busy === wallet.name} disabled={!!busy} onPress={() => void connectInjected(wallet.name, wallet.provider)} />)}
      <Button label="Create or sign in to a wallet" disabled={!!busy} onPress={() => setEmbedded(true)} />
    </View>
    {!standardWallets.length && !wallets.length ? <Txt v="small" color={C.faint}>No browser wallet detected. Paste an address above or use the embedded wallet.</Txt> : null}
    {error ? <Txt v="small" color={C.warn}>{error}</Txt> : null}
  </View>
}

function EmbeddedConnect({ signer, onAddress, onBack }: { signer: SolanaSigner; onAddress: (address: string) => void; onBack: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const address = signer.address
  useEffect(() => { if (address) { selectWallet('embedded'); updateWalletSession('embedded', address, 'Embedded wallet'); onAddress(address) } }, [address, onAddress])
  return <View style={st.stack}>
    <Txt v="small">{address ? `Connected ${address.slice(0, 4)}…${address.slice(-4)}. Nothing is signed from this screen.` : 'Sign in to your embedded wallet to read its holdings.'}</Txt>
    {error ? <Txt v="small" color={C.warn}>{error}</Txt> : null}
    <View style={st.wrap}>
      {!address ? <Button label="Connect embedded wallet" busy={busy} onPress={() => void (async () => { setBusy(true); setError(null); try { await signer.connect() } catch (e) { setError(messageOf(e)) } finally { setBusy(false) } })()} /> : null}
      <Button label="Choose another wallet" kind="quiet" disabled={busy} onPress={onBack} />
    </View>
  </View>
}

const st = StyleSheet.create({
  stack: { gap: 10 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
})
