import { useState } from 'react'
import { Linking, Platform, StyleSheet, TextInput, View } from 'react-native'
import { C, F } from '@/theme'
import { connect, hasInjected, quote, routePools, send, type Quote } from '@/lib/evm'
import { explorerAddr, num } from '@/lib/format'
import type { PoolSummary, TokenSummary } from '@/lib/types'
import { Button, Chip, Txt } from './ui'

const open = (url: string) => Linking.openURL(url)

export function Trade({ t, pools }: { t: TokenSummary; pools: PoolSummary[] }) {
  const traps = pools.filter(p => (p.feeBps ?? 0) >= 7000)
  return (
    <View style={st.card}>
      {traps.length ? (
        <View style={st.warn}>
          <Txt v="small" color={C.warn}>{traps.length} of {pools.length} pools on this token charge 70% or more. Check which pool a route uses before you sign.</Txt>
        </View>
      ) : null}
      {t.chain === 'solana' ? <SolanaLinks t={t} /> : <RobinhoodBuy t={t} trapAddrs={new Set(traps.map(p => p.address))} />}
    </View>
  )
}

function SolanaLinks({ t }: { t: TokenSummary }) {
  return (
    <View style={{ gap: 10 }}>
      <Button label="Swap on Jupiter" onPress={() => open(`https://jup.ag/swap?buy=${t.address}&sell=So11111111111111111111111111111111111111112`)} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {t.launchVenue === 'pumpfun' && !t.graduatedTs ? <Chip label="pump.fun" onPress={() => open(`https://pump.fun/coin/${t.address}`)} /> : null}
        <Chip label="Dexscreener" onPress={() => open(`https://dexscreener.com/solana/${t.address}`)} />
        <Chip label="Solscan" onPress={() => open(explorerAddr('solana', t.address))} />
      </View>
    </View>
  )
}

function RobinhoodBuy({ t, trapAddrs }: { t: TokenSummary; trapAddrs: Set<string> }) {
  const [amount, setAmount] = useState('0.01')
  const [q, setQ] = useState<Quote | null>(null)
  const [account, setAccount] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const web = Platform.OS === 'web'
  const decimals = t.decimals ?? 18

  const getQuote = async () => {
    setBusy(true); setMsg(null); setQ(null)
    try { setQ(await quote(t.address, amount, account ?? undefined)) }
    catch (e: any) { setMsg(/NO_ROUTE|No route/i.test(e.message) ? 'The routing-api has no route to this token yet: its pools are newer than the venues it indexes.' : e.message) }
    setBusy(false)
  }
  const pools = q ? routePools(q) : []
  const viaTrap = pools.some(p => trapAddrs.has(p.address.toLowerCase()) || p.fee >= 700000)

  return (
    <View style={{ gap: 10 }}>
      {web ? (
        <>
          <View style={st.inputRow}>
            <TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad" style={st.input} placeholderTextColor={C.faint} />
            <Txt v="mono">ETH</Txt>
          </View>
          {q ? <Txt v="mono">≈ {num(Number(q.quoteDecimals))} {t.symbol ?? 'tokens'} · {pools.length} hop{pools.length === 1 ? '' : 's'}</Txt> : null}
          {viaTrap ? <Txt v="small" color={C.bad}>This route runs through a pool charging 70% or more. Do not send it.</Txt> : null}
          {msg ? <Txt v="small" color={C.warn}>{msg}</Txt> : null}
          {!hasInjected() ? <Txt v="small">Open this page in a wallet browser (MetaMask, Coinbase Wallet, Rabby) to swap.</Txt> : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {!account && hasInjected() ? <Button kind="ghost" label="Connect wallet" onPress={async () => { try { setAccount(await connect()) } catch (e: any) { setMsg(e.message) } }} style={{ flex: 1 }} /> : null}
            <Button kind={q?.methodParameters ? 'ghost' : 'primary'} label="Quote" busy={busy && !q} onPress={getQuote} style={{ flex: 1 }} />
            {q?.methodParameters && account && !viaTrap ? <Button label="Swap" busy={busy} onPress={async () => {
              setBusy(true)
              try { const h = await send(q, account); setMsg(`Sent ${h.slice(0, 10)}…`); open(`https://robinhoodchain.blockscout.com/tx/${h}`) } catch (e: any) { setMsg(e.message) }
              setBusy(false)
            }} style={{ flex: 1 }} /> : null}
          </View>
        </>
      ) : (
        <Button label="Open in MetaMask to swap" onPress={() => open(`https://metamask.app.link/dapp/${(process.env.EXPO_PUBLIC_WEB_HOST ?? 'liquidityxyz.fun')}/token/robinhood/${t.address}`)} />
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <Chip label="Blockscout" onPress={() => open(explorerAddr('robinhood', t.address))} />
        <Chip label="pools.xyz" onPress={() => open(`https://pools.xyz/t/robinhood/${t.address}`)} />
      </View>
      <Txt v="monoSmall">decimals {decimals}</Txt>
    </View>
  )
}

const st = StyleSheet.create({
  card: { marginHorizontal: 16, padding: 14, gap: 10, borderRadius: 14, backgroundColor: C.surface, borderWidth: 1, borderColor: C.line },
  warn: { padding: 10, borderRadius: 10, backgroundColor: C.warn + '14', borderWidth: 1, borderColor: C.warn + '44' },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: C.lineStrong, borderRadius: 10, paddingHorizontal: 12, backgroundColor: C.bg },
  input: { flex: 1, height: 44, color: C.text, fontFamily: F.monoBold, fontSize: 16 },
})
