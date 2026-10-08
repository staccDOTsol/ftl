import { useEffect, useRef, useState } from 'react'
import { Linking, Platform, StyleSheet, TextInput, View } from 'react-native'
import { C, F } from '@/theme'
import { ApiError } from '@/lib/api'
import { connect, hasInjected, quote, routePools, send, transactionState, WalletContextError, type Quote } from '@/lib/evm'
import { num, solanaExplorerAddr } from '@/lib/format'
import type { FlowEvent, PoolSummary, TokenSummary } from '@/lib/types'
import { Button, Chip, Txt } from './ui'
import SolanaTrade from './SolanaTrade'
import { webData } from '@/lib/web-props'

// Deep-link presets: exit opens Liquidity on remove, liquidity opens Liquidity, sell opens Swap on the sell side.
export type TradeAction = 'exit' | 'liquidity' | 'sell'

const open = (url: string) => Linking.openURL(url)

function rawTokens(raw: string, decimals: number): number | null {
  if (!/^\d+$/.test(raw) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null
  const amount = Number(raw) / 10 ** decimals
  return Number.isFinite(amount) ? amount : null
}

export function Trade({ t, pools, origin, initialAction }: { t: TokenSummary; pools: PoolSummary[]; origin?: FlowEvent | null; initialAction?: TradeAction }) {
  const traps = pools.filter(p => (p.feeBps ?? 0) >= 7000)
  return (
    <View style={st.card} {...webData({ tradecard: true })}>
      {traps.length ? (
        <View style={st.warn}>
          <Txt v="small" color={C.warn}>{traps.length} of {pools.length} pools on this token charge 70% or more. Check which pool a route uses before you sign.</Txt>
        </View>
      ) : null}
      {t.chain === 'solana' ? <><SolanaTrade t={t} pools={pools} origin={origin} initialAction={initialAction} /><SolanaLinks t={t} /></> : <RobinhoodBuy t={t} trapAddrs={new Set(traps.map(p => p.address))} />}
    </View>
  )
}

function SolanaLinks({ t }: { t: TokenSummary }) {
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <Chip label="Dexscreener" onPress={() => open(`https://dexscreener.com/solana/${t.address}`)} />
        <Chip label="Solscan" onPress={() => open(solanaExplorerAddr(t.address))} />
      </View>
    </View>
  )
}

function RobinhoodBuy({ t, trapAddrs }: { t: TokenSummary; trapAddrs: Set<string> }) {
  const [amount, setAmount] = useState('0.01')
  const [q, setQ] = useState<Quote | null>(null)
  const [account, setAccount] = useState<string | null>(null)
  const [quotedFor, setQuotedFor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [sentTx, setSentTx] = useState<string | null>(null)
  const [sentState, setSentState] = useState<'pending' | 'confirmed' | 'reverted' | 'unavailable' | 'wrong_chain'>('pending')
  const [quoteBlocked, setQuoteBlocked] = useState(false)
  const requestSeq = useRef(0)
  const web = Platform.OS === 'web'
  const decimals = t.decimals ?? 18
  const minReceived = q?.source === 'pons-v2-curve' && q.minTokensOut
    ? rawTokens(q.minTokensOut, decimals) : null

  useEffect(() => {
    if (!web || !account) return
    const provider = (window as any).ethereum
    if (!provider?.on) return
    const walletChanged = () => {
      requestSeq.current++
      setAccount(null)
      setQuotedFor(null)
      setQ(null)
      setQuoteBlocked(false)
      setMsg('Wallet selection changed. Connect again for a fresh quote.')
      setBusy(false)
    }
    provider.on('accountsChanged', walletChanged)
    provider.on('chainChanged', walletChanged)
    return () => {
      provider.removeListener?.('accountsChanged', walletChanged)
      provider.removeListener?.('chainChanged', walletChanged)
    }
  }, [account, web])

  useEffect(() => {
    if (!sentTx || !web) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = async () => {
      try {
        const next = await transactionState(sentTx)
        if (!active) return
        setSentState(next)
        if (next === 'pending') timer = setTimeout(() => void check(), 5_000)
      } catch (error) {
        if (!active) return
        setSentState(error instanceof WalletContextError && error.message.startsWith('Switch your wallet') ? 'wrong_chain' : 'unavailable')
        timer = setTimeout(() => void check(), 5_000)
      }
    }
    void check()
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [sentTx, web])

  const changeAmount = (value: string) => {
    requestSeq.current++
    setAmount(value)
    setQ(null)
    setQuotedFor(null)
    setQuoteBlocked(false)
    setMsg(null)
    setBusy(false)
  }

  const disconnect = () => {
    requestSeq.current++
    setAccount(null)
    setQ(null)
    setQuotedFor(null)
    setQuoteBlocked(false)
    setMsg(null)
    setBusy(false)
  }

  const getQuote = async () => {
    if (!account) {
      setMsg('Connect your wallet to quote for the right recipient.')
      return
    }
    if (!/^\d+(?:\.\d{0,18})?$/.test(amount.trim()) || Number(amount) <= 0) {
      setMsg('Enter a positive ETH amount with at most 18 decimal places.')
      return
    }
    const seq = ++requestSeq.current
    setBusy(true); setMsg(null); setQ(null); setQuotedFor(null)
    try {
      const next = await quote(t.address, amount, account)
      if (!next || !Number.isFinite(Number(next.quoteDecimals)) || !next.methodParameters)
        throw new Error('UNUSABLE_QUOTE')
      if (seq === requestSeq.current) { setQ(next); setQuotedFor(account); setQuoteBlocked(false) }
    } catch (e) {
      if (seq !== requestSeq.current) return
      if (e instanceof WalletContextError) {
        setQuoteBlocked(false)
        setMsg(e.message)
        return
      }
      const noRoute = (e instanceof ApiError && e.status === 404) ||
        /NO_ROUTE|No route|No live ETH pool/i.test(e instanceof Error ? e.message : '')
      const cannotFill = e instanceof ApiError && e.status === 409
      setQuoteBlocked(true)
      setMsg(noRoute
        ? 'No live ETH pool can fill this quote right now. Try a smaller amount or check again when liquidity changes.'
        : cannotFill ? 'This live route cannot fill that amount. Try a smaller amount or check again when liquidity changes.'
          : 'The in-site quote is temporarily unavailable. Try again shortly.')
    } finally {
      if (seq === requestSeq.current) setBusy(false)
    }
  }
  const pools = q ? routePools(q) : []
  const viaTrap = pools.some(p => trapAddrs.has(p.address.toLowerCase()) || p.fee >= 700000)

  return (
    <View style={{ gap: 10 }}>
      {web ? (
        <>
          <View style={st.inputRow}>
            <TextInput value={amount} onChangeText={changeAmount} keyboardType="decimal-pad" style={st.input} placeholderTextColor={C.faint} />
            <Txt v="mono">ETH</Txt>
          </View>
          {account ? (
            <View style={{ gap: 6 }}>
              <Txt v="small">Connected Robinhood Chain wallet</Txt>
              <Txt v="monoSmall" selectable style={{ color: C.text, flexWrap: 'wrap' }}>{account}</Txt>
              <Button kind="quiet" label="Disconnect wallet" disabled={busy} onPress={disconnect} />
            </View>
          ) : null}
          {account ? <Txt v="small">Disconnect clears this app’s wallet session. Revoke site access in your wallet extension if needed.</Txt> : null}
          {q ? <Txt v="mono">≈ {num(Number(q.quoteDecimals))} {t.symbol ?? 'tokens'}{q.source === 'pons-v2-curve' ? ' · live Pons V2 curve' : ` · ${pools.length} hop${pools.length === 1 ? '' : 's'}`}</Txt> : null}
          {minReceived !== null ? <Txt v="small">Minimum received at 5% slippage: {num(minReceived)} {t.symbol ?? 'tokens'}</Txt> : null}
          {q?.source === 'pons-v2-curve' && q.feeBps !== undefined && q.creatorTaxBps !== undefined ? <Txt v="small">Curve fee {(q.feeBps / 100).toFixed(2)}% · creator tax {(q.creatorTaxBps / 100).toFixed(2)}%</Txt> : null}
          {q && quotedFor ? <Txt v="small">Quote recipient: {quotedFor}</Txt> : null}
          {viaTrap ? <Txt v="small" color={C.bad}>This route runs through a pool charging 70% or more. Do not send it.</Txt> : null}
          {msg ? <Txt v="small" color={sentTx ? C.good : C.warn}>{msg}</Txt> : null}
          {sentTx ? <View style={{ gap: 6 }}>
            <Txt v="label">Last submitted transaction</Txt>
            <Txt v="monoSmall" selectable>{sentTx}</Txt>
            <Txt v="small" color={sentState === 'confirmed' ? C.good : sentState === 'reverted' ? C.bad : C.muted}>
              {sentState === 'confirmed' ? 'Confirmed on Robinhood Chain' : sentState === 'reverted' ? 'Transaction reverted on Robinhood Chain' : sentState === 'wrong_chain' ? 'Switch your wallet to Robinhood Chain to check status.' : sentState === 'unavailable' ? 'Checking transaction status…' : 'Waiting for on-chain confirmation…'}
            </Txt>
          </View> : null}
          {!hasInjected() ? <Txt v="small">Open this page in a wallet browser (MetaMask, Coinbase Wallet, Rabby) to swap.</Txt> : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {!account && hasInjected() ? <Button label="Connect wallet" onPress={async () => {
              setBusy(true); setMsg(null)
              try { setAccount(await connect()) } catch { setMsg('Wallet connection failed. Check your wallet and try again.') }
              finally { setBusy(false) }
            }} busy={busy} style={{ flex: 1 }} /> : null}
            {account ? <Button kind={q?.methodParameters ? 'ghost' : 'primary'} label={quoteBlocked ? 'Retry quote' : 'Get quote'} disabled={busy} busy={busy && !q} onPress={getQuote} style={{ flex: 1 }} /> : null}
            {q?.methodParameters && account && quotedFor === account && !viaTrap ? <Button label="Swap here" busy={busy} onPress={async () => {
              setBusy(true); setSentTx(null)
              try {
                const h = await send(q, account)
                requestSeq.current++
                setQ(null)
                setQuotedFor(null)
                setSentTx(h)
                setSentState('pending')
                setMsg('Transaction sent. You can check its status here or continue using FTL.')
              }
              catch (e) { setQ(null); setQuotedFor(null); setMsg(e instanceof WalletContextError ? e.message : 'Swap could not be sent. Check your wallet and request a fresh quote.') }
              setBusy(false)
            }} style={{ flex: 1 }} /> : null}
          </View>
        </>
      ) : (
        <Button label="Open FTL web trade" onPress={() => void open(`https://${process.env.EXPO_PUBLIC_WEB_HOST ?? 'liquidityxyz.fun'}/token/robinhood/${t.address}`)} />
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <Chip label="pools.xyz" onPress={() => open(`https://pools.xyz/t/robinhood/${t.address}`)} />
      </View>
      <Txt v="monoSmall">decimals {decimals}</Txt>
    </View>
  )
}

const st = StyleSheet.create({
  card: { marginHorizontal: 16, marginTop: 20, padding: 16, gap: 12, borderRadius: 18, backgroundColor: C.surface, borderWidth: 1, borderColor: C.lineStrong, shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 24, shadowOffset: { width: 0, height: 12 } },
  warn: { padding: 10, borderRadius: 10, backgroundColor: C.warn + '14', borderWidth: 1, borderColor: C.warn + '44' },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: C.lineStrong, borderRadius: 10, paddingHorizontal: 12, backgroundColor: C.bg },
  input: { flex: 1, height: 44, color: C.text, fontFamily: F.monoBold, fontSize: 16 },
})
