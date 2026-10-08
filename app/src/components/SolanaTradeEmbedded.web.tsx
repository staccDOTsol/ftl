import { useEffect, useState, type ReactNode } from 'react'
import { View } from 'react-native'
import { HeliusWalletProvider, useHeliusWallet } from 'helius-wallet-kit'
import 'helius-wallet-kit/ui/styles.css'
import { C } from '@/theme'
import { Button, Txt } from './ui'
import type { SolanaSigner } from './SolanaTrade.web'

const config = { cluster: 'mainnet-beta' as const, theme: { darkMode: true, primaryColor: C.accent } }
type Props = { onBack: () => void; children: (signer: SolanaSigner) => ReactNode }

function Connected({ children }: Props) {
  const wallet = useHeliusWallet()
  // Wallet Kit 1.1 does not advertise V1 support. Negotiate V0 explicitly.
  const signer: SolanaSigner = { address: wallet.address, transactionVersion: '0', connect: wallet.login, disconnect: wallet.logout, sign: wallet.signTransaction }
  return <View style={{ gap: 12 }}><Txt v="h2">Trade here · embedded wallet</Txt>{children(signer)}</View>
}

export default function SolanaTradeEmbedded(props: Props) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [error, setError] = useState('')
  useEffect(() => {
    let mounted = true
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 15_000)
    fetch('/api/helius/waas/config', { signal: abort.signal, cache: 'no-store' }).then(async response => {
      const data = await response.json()
      if (!response.ok || !data.organizationId || !data.authProxyConfigId) throw new Error(data.message || 'Embedded wallet is not configured on this host.')
      if (mounted) setState('ready')
    }).catch(error => { if (mounted) { setError(abort.signal.aborted ? 'Wallet connection timed out. Try another wallet or reconnect.' : error instanceof Error ? error.message : 'Wallet unavailable.'); setState('failed') } })
      .finally(() => clearTimeout(timer))
    return () => { mounted = false; clearTimeout(timer); abort.abort() }
  }, [])
  if (state !== 'ready') return <View style={{ gap: 12 }}>
    <Txt v="h2">Embedded wallet</Txt><Txt v="small" color={state === 'failed' ? C.warn : C.muted}>{state === 'loading' ? 'Connecting to Helius Wallet Kit…' : error}</Txt>
    <Button label="Choose another wallet" kind="ghost" onPress={props.onBack} />
  </View>
  return <HeliusWalletProvider config={config}><Connected {...props} /></HeliusWalletProvider>
}
