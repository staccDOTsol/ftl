import { useEffect, useState } from 'react'
import { ScrollView, View } from 'react-native'
import { HeliusWalletProvider, useHeliusWallet, type EnhancedTransaction } from 'helius-wallet-kit'
import 'helius-wallet-kit/ui/styles.css'
import { C } from '@/theme'
import { Button, Screen, Section, Txt } from '@/components/ui'

const config = { cluster: 'mainnet-beta' as const, theme: { darkMode: true, primaryColor: '#5d84ff' } }

function WalletContents() {
  const wallet = useHeliusWallet()
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<EnhancedTransaction[] | null>(null)
  const [busy, setBusy] = useState(false)

  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : 'Wallet operation failed') }
    finally { setBusy(false) }
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
        <View style={{ padding: 20, gap: 10 }}>
          <Txt v="title">Embedded wallet</Txt>
          <Txt v="small">A non-custodial Solana wallet powered by Helius. Sign in with the methods enabled in the Helius dashboard.</Txt>
          <Txt v="small">This trading wallet is separate from your FTL profile key, which signs follows, calls, and likes.</Txt>
          <Txt v="monoSmall" color={C.muted}>Mainnet · {wallet.status}</Txt>
        </View>

        <Section title="Wallet">
          <View style={{ paddingHorizontal: 16, gap: 10 }}>
            {wallet.address ? (
              <>
                <Txt v="small">Solana address</Txt>
                <Txt v="monoSmall" selectable>{wallet.address}</Txt>
                <Button label="View recent transactions" kind="ghost" busy={busy} onPress={() => void act(async () => setHistory(await wallet.getTransactions({ limit: 10 })))} />
                <Button label="Export wallet" kind="ghost" busy={busy} onPress={() => void act(wallet.exportWallet)} />
                <Button label="Sign out" kind="ghost" busy={busy} onPress={() => void act(async () => { await wallet.logout(); setHistory(null) })} />
              </>
            ) : (
              <Button label="Create or sign in" busy={busy || wallet.status === 'loading'} onPress={() => void act(wallet.login)} />
            )}
            {error ? <Txt v="small" color={C.bad}>{error}</Txt> : null}
          </View>
        </Section>

        {history ? <Section title="Recent transactions">
          <View style={{ paddingHorizontal: 16, gap: 12 }}>
            {history.length === 0 ? <Txt v="small">No recent transactions.</Txt> : history.map(tx => (
              <View key={tx.signature} style={{ gap: 3 }}>
                <Txt v="small">{tx.description || tx.type || 'Transaction'}</Txt>
                <Txt v="monoSmall" selectable>{tx.signature}</Txt>
              </View>
            ))}
          </View>
        </Section> : null}
      </ScrollView>
    </Screen>
  )
}

export default function EmbeddedWalletWeb() {
  const [state, setState] = useState<'checking' | 'ready' | 'unavailable'>('checking')
  const [message, setMessage] = useState('')

  useEffect(() => {
    let alive = true
    fetch('/api/helius/waas/config', { cache: 'no-store' })
      .then(async r => {
        if (!(r.headers.get('content-type') ?? '').includes('application/json')) {
          throw new Error('Embedded wallet is unavailable on this host.')
        }
        const data = await r.json()
        if (!r.ok || !data.organizationId || !data.authProxyConfigId) throw new Error(data.message || data.error || 'Helius WaaS is not configured')
        if (alive) setState('ready')
      })
      .catch(e => { if (alive) { setMessage(e instanceof Error ? e.message : 'Helius WaaS unavailable'); setState('unavailable') } })
    return () => { alive = false }
  }, [])

  if (state !== 'ready') return (
    <Screen>
      <View style={{ padding: 20, gap: 10 }}>
        <Txt v="title">Embedded wallet</Txt>
        <Txt v="small" color={state === 'unavailable' ? C.bad : C.muted}>{state === 'checking' ? 'Checking Helius Wallet Kit…' : message}</Txt>
      </View>
    </Screen>
  )
  return <HeliusWalletProvider config={config}><WalletContents /></HeliusWalletProvider>
}
