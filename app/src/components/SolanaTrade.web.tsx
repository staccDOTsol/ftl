import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Linking, StyleSheet, TextInput, View } from 'react-native'
import { router } from 'expo-router'
import bs58 from 'bs58'
import { C, F } from '@/theme'
import type { FlowEvent, PoolSummary, TokenSummary } from '@/lib/types'
import { acknowledgeComposer, acknowledgeDecodedProgram, balancePercent, COMPOSED_BUILD_MESSAGE, composerAcknowledged, composerFeeLabel, DECODED_BUILD_MESSAGE, decodedProgramAcknowledged, fromAtomic, isQuoteFresh, shortMint, SOL_MINT, toAtomic, unacknowledgedComposedBuild, unacknowledgedDecodedBuild, type SolanaQuote } from '@/lib/solana-trade'
import { assertSignedMessage, buildAndSimulate, decodeTransaction, getRouterStatus, getSolanaQuote, mintDecimals, sendSignedSwap, tokenBalance, transactionStatus, validateMint } from '@/lib/solana'
import { hasPending, readPending, writePending, type PendingSwap } from '@/lib/solana-pending'
import { swapLink } from '@/lib/swap-link'
import { inspectTransaction } from '@/lib/solana-wire'
import { Button, Chip, Seg, Txt } from './ui'
import ZapLiquidity from './ZapLiquidity.web'
import ComposerRouteNotice from './ComposerRouteNotice.web'
import DecodedRouteNotice from './DecodedRouteNotice.web'
import { useSolanaWallets, walletName, WalletPicker, WalletSession, type SolanaSigner } from './SolanaWallet.web'
import { useWalletSelection } from '@/lib/wallet-session'
import type { TradeAction } from './Trade'

// Wallet discovery and signer adapters live in SolanaWallet.web.tsx; these
// re-exports keep the historical import path working for other components.
export { injectedWallets, isStandardSolana, signingAccount, type InjectedWallet, type SolanaSigner, type StandardSolanaWallet } from './SolanaWallet.web'

type Props = { t: TokenSummary; pools: PoolSummary[]; origin?: FlowEvent | null; initialAction?: TradeAction }
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'The operation could not finish. Please try again.'

export default function SolanaTradeWeb(props: Props) {
  const wallets = useSolanaWallets()
  const [selected, setSelected] = useWalletSelection()
  const switchWallet = () => { setSelected(null); wallets.rescan() }
  if (selected && walletName(selected, wallets)) return <WalletSession selected={selected} wallets={wallets} onBack={switchWallet}>
    {(signer, name) => <View style={st.stack}><Txt v="h2">Trade here · {name}</Txt><WalletActions {...props} signer={signer} onBack={switchWallet} /></View>}
  </WalletSession>
  return <View style={st.stack}>
    <View style={st.heading}><Txt v="h2">Trade here</Txt><Txt v="label" color={C.accent}>Solana · direct routes</Txt></View>
    <Txt v="small">Buy or sell through available pools, including supported bonding curves. Connect a trading wallet to see your balance.</Txt>
    <WalletActions {...props} signer={null} />
    <WalletPicker wallets={wallets} onSelect={setSelected} />
    <Txt v="small">Your trading wallet is separate from your profile key.</Txt>
  </View>
}

function WalletActions(props: Props & { signer: SolanaSigner | null; onBack?: () => void }) {
  const [mode, setMode] = useState<'swap' | 'liquidity'>(() => props.initialAction && props.initialAction !== 'sell' ? 'liquidity' : 'swap')
  const [exitRequest, setExitRequest] = useState(props.initialAction === 'exit')
  const [locked, setLocked] = useState(false)
  useEffect(() => {
    const restore = setTimeout(() => {
      if (localStorage.getItem('liquidityxyz.solana.liquidity-batch.v1') || localStorage.getItem('liquidityxyz.solana.zap.v1')) setMode('liquidity')
    }, 0)
    return () => clearTimeout(restore)
  }, [])
  return <View style={st.stack}>
    {props.origin ? <View style={st.quote}>
      <Txt v="label">Opened from {props.origin.kind === 'liq_remove' ? 'a liquidity pull' : props.origin.kind === 'liq_add' ? 'a liquidity add' : props.origin.kind === 'pool_init' ? 'a new pool' : 'a launch event'} · {props.origin.stage}</Txt>
      <Txt v="small">{props.origin.venue} · observed wallet {shortMint(props.origin.wallet)}</Txt>
      {props.origin.pool ? <Txt v="monoSmall" selectable>Pool {props.origin.pool}</Txt> : null}
      <Button kind="quiet" label="View originating transaction ↗" onPress={() => void Linking.openURL(`https://solscan.io/tx/${props.origin!.tx}`)} />
      {props.origin.kind === 'liq_remove' ? <><Txt v="small">Check your own position and exit quote. The observed wallet never becomes your signer.</Txt><Button label="Check my exit" disabled={locked} onPress={() => { setExitRequest(true); setMode('liquidity') }} /></> : null}
    </View> : null}
    <Seg value={mode} options={[{ value: 'swap', label: 'Swap' }, { value: 'liquidity', label: 'Liquidity' }]} onChange={value => { if (!locked) setMode(value) }} />
    {mode === 'swap' ? <TradeForm {...props} onLockChange={setLocked} /> : <ZapLiquidity {...props} exitRequest={exitRequest} onLockChange={setLocked} />}
  </View>
}

function TradeForm({ t, pools, signer, onBack, onLockChange, initialAction }: Props & { signer: SolanaSigner | null; onBack?: () => void; onLockChange: (locked: boolean) => void }) {
  const [side, setSide] = useState<'buy' | 'sell'>(() => initialAction === 'sell' ? 'sell' : 'buy')
  const [pair, setPair] = useState(SOL_MINT)
  const [customMint, setCustomMint] = useState('')
  const [amount, setAmount] = useState('')
  const [slippageBps, setSlippageBps] = useState(100)
  const [decimals, setDecimals] = useState<Record<string, number>>({ [SOL_MINT]: 9 })
  const [balanceResult, setBalanceResult] = useState<{ owner: string; mint: string; raw: string } | null>(null)
  const [quoteResult, setQuote] = useState<{ response: SolanaQuote; at: number; wallet: string | null } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [routerMessage, setRouterMessage] = useState('Checking route service…')
  const [pending, setPending] = useState<PendingSwap | null>(null)
  const seq = useRef(0)
  const operation = useRef(false)
  const mounted = useRef(true)
  const currentSigner = useRef(signer)
  const address = signer?.address ?? null
  const inputMint = side === 'buy' ? pair : t.address
  const outputMint = side === 'buy' ? t.address : pair
  const transactionVersion = signer?.transactionVersion ?? '1'
  const quote = quoteResult?.wallet === address && quoteResult.response.inputMint === inputMint && quoteResult.response.outputMint === outputMint && quoteResult.response.slippageBps === slippageBps && quoteResult.response.transactionVersion === transactionVersion ? quoteResult : null
  const currentInput = useRef(inputMint)
  useEffect(() => { currentSigner.current = signer; currentInput.current = inputMint }, [signer, inputMint])
  const balance = balanceResult?.owner === address && balanceResult.mint === inputMint ? balanceResult.raw : null
  const pairMints = useMemo(() => [...new Set([SOL_MINT, ...pools.flatMap(pool => pool.quote && pool.quote !== t.address ? [pool.quote] : [])])], [pools, t.address])
  const label = (mint: string) => mint === t.address ? (t.symbol || shortMint(mint)) : shortMint(mint)
  const amountOf = (mint: string, atomic: string) => decimals[mint] !== undefined ? fromAtomic(atomic, decimals[mint]) : null
  // A composed route needs one acknowledgement per browser and composer program.
  const [ackedProgram, setAckedProgram] = useState<string | null>(null)
  const composedRoute = !!quote && composerFeeLabel(quote.response) !== null
  const composerAck = composedRoute && (ackedProgram === (quote!.response.composerProgramId ?? 'unreported') || composerAcknowledged(quote!.response.composerProgramId))
  const decodedRoute = !!quote && quote.response.decoded === true
  const decodedAck = decodedRoute && (ackedProgram === (quote!.response.decodedProgramId ?? 'unreported') || decodedProgramAcknowledged(quote!.response.decodedProgramId))
  const unresolved = pending?.state === 'pending'
  const locked = busy || unresolved
  const fresh = !!quote && isQuoteFresh(quote.at, now)
  useEffect(() => { onLockChange(locked); return () => onLockChange(false) }, [locked, onLockChange])

  useEffect(() => {
    mounted.current = true
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => { mounted.current = false; clearInterval(timer) }
  }, [])

  useEffect(() => {
    const restore = () => setPending(readPending())
    const timer = setTimeout(restore, 0)
    window.addEventListener('storage', restore)
    return () => { clearTimeout(timer); window.removeEventListener('storage', restore) }
  }, [])
  function savePending(value: PendingSwap) {
    writePending(value)
    if (mounted.current) setPending(value)
  }

  useEffect(() => {
    let alive = true
    void getRouterStatus().then(status => {
      if (alive) setRouterMessage(status.configured === false || status.available === false || status.status !== 'ok' ? (status.message || 'Route service is unavailable.') : 'Direct routes · quote before signing')
    }).catch(() => { if (alive) setRouterMessage('Route service is reconnecting. You can retry a quote.') })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    seq.current++
    let alive = true
    void Promise.all([inputMint, outputMint].map(async mint => [mint, await mintDecimals(mint)] as const))
      .then(values => { if (alive) setDecimals(old => ({ ...old, ...Object.fromEntries(values) })) })
      .catch(error => { if (alive) setError(messageOf(error)) })
    return () => { alive = false }
  }, [address, inputMint, outputMint, slippageBps, transactionVersion])

  const refreshBalance = useCallback(async () => {
    if (!address) return
    const value = await tokenBalance(address, inputMint)
    if (mounted.current && currentSigner.current?.address === address && currentInput.current === inputMint) setBalanceResult({ owner: address, mint: inputMint, raw: value })
  }, [address, inputMint])
  useEffect(() => {
    let active = true
    const refresh = () => { void refreshBalance().catch(error => { if (active) setError(`Balance unavailable: ${messageOf(error)}`) }) }
    refresh()
    const timer = setInterval(refresh, 20_000)
    return () => { active = false; clearInterval(timer) }
  }, [refreshBalance])

  function editAmount(value: string) { seq.current++; setAmount(value); setQuote(null); setError(null) }
  async function act(fn: () => Promise<void>) {
    if (locked || operation.current) return
    operation.current = true
    setBusy(true); setError(null)
    try { await fn() } catch (error) { if (mounted.current) setError(messageOf(error)) }
    finally { operation.current = false; if (mounted.current) { setBusy(false); setPhase('') } }
  }
  async function requestQuote() {
    const request = ++seq.current
    setQuote(null); setPhase('Finding a route…')
    if (decimals[inputMint] === undefined || decimals[outputMint] === undefined) throw new Error('Waiting for token details. Try again shortly.')
    const raw = toAtomic(amount, decimals[inputMint])
    if (balance !== null && BigInt(raw) > BigInt(balance)) throw new Error('Amount exceeds your available balance.')
    const result = await getSolanaQuote({ inputMint, outputMint, amount: raw, slippageBps, transactionVersion })
    if (request === seq.current && mounted.current) { setQuote({ response: result, at: Date.now(), wallet: address }); setNow(Date.now()) }
  }

  async function checkPending(tx = pending) {
    if (!tx) return
    const state = await transactionStatus(tx.signature, tx.lastValidBlockHeight)
    if (!mounted.current) return
    savePending({ ...tx, state })
    if (state === 'confirmed') { setQuote(null); await refreshBalance() }
    if (state === 'failed') setError('The transaction failed on-chain. Refresh your balance and request a new quote.')
    if (state === 'expired') setError('The transaction expired without confirmation. Request a new quote.')
    return state
  }

  async function trade() {
    if (hasPending()) throw new Error('Resolve the pending wallet transaction before starting another trade.')
    const selected = currentSigner.current
    if (!selected?.address || !quote || !isQuoteFresh(quote.at) || quote.wallet !== selected.address) throw new Error('Connect your wallet and request a fresh quote.')
    const owner = selected.address
    const request = seq.current
    setPhase('Requoting and simulating…')
    if (selected.transactionVersion === null) throw new Error('This wallet does not advertise V0 or V1 transaction signing. Choose a compatible wallet.')
    const built = await buildAndSimulate(quote.response, owner, selected.transactionVersion)
    if (!mounted.current || request !== seq.current || currentSigner.current?.address !== owner || !isQuoteFresh(quote.at)) throw new Error('The quote or wallet changed. Request a fresh quote.')
    const composedInstead = unacknowledgedComposedBuild(built, ackedProgram)
    if (composedInstead) { setQuote({ ...quote, response: composedInstead, at: Date.now() }); throw new Error(COMPOSED_BUILD_MESSAGE) }
    const decodedInstead = unacknowledgedDecodedBuild(built, ackedProgram)
    if (decodedInstead) { setQuote({ ...quote, response: decodedInstead, at: Date.now() }); throw new Error(DECODED_BUILD_MESSAGE) }
    setPhase(`Approve in your wallet · network fee ${fromAtomic(String(built.networkFeeLamports), 9)} SOL`)
    const signed = await selected.sign(decodeTransaction(built.swapTransaction))
    assertSignedMessage(built.swapTransaction, signed)
    if (!mounted.current || currentSigner.current?.address !== owner) throw new Error('Wallet changed or the trade was closed. Nothing was sent.')
    const signatureBytes = inspectTransaction(signed).signatures[0]
    if (!signatureBytes?.some(byte => byte !== 0)) throw new Error('Wallet did not sign this transaction.')
    const signature = bs58.encode(signatureBytes)
    const tx = { signature, lastValidBlockHeight: built.lastValidBlockHeight, state: 'pending' as const }
    // Preserve the signature before sending: a network timeout may still have landed.
    savePending(tx); setQuote(null); setPhase('Submitting transaction…')
    try {
      const returned = await sendSignedSwap(signed, built.lastValidBlockHeight)
      if (returned !== signature) throw new Error('Unexpected RPC signature. Check the transaction status below.')
    } catch (error) {
      setError(`Submission needs a status check: ${messageOf(error)} Do not submit another trade until its status is resolved.`)
    }
    setPhase('Waiting for confirmation…')
    for (let i = 0; i < 20 && mounted.current; i++) {
      const status = await checkPending(tx)
      if (status !== 'pending') break
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
  }

  return <View style={st.stack}>
    <Txt v="monoSmall" color={C.muted}>{routerMessage}</Txt>
    {signer ? <Txt v="monoSmall" color={signer.transactionVersion === '1' ? C.accent : C.muted}>{signer.transactionVersion === '1' ? 'Wallet supports V1 · up to 4,096 bytes' : signer.transactionVersion === '0' ? 'Wallet uses V0 · routes must fit 1,232 bytes' : 'This wallet cannot sign supported transaction versions.'}</Txt> : null}
    <Seg value={side} options={[{ value: 'buy', label: `Buy ${t.symbol || 'token'}` }, { value: 'sell', label: 'Sell' }]} onChange={value => { if (!locked) { setSide(value); editAmount('') } }} />
    <Txt v="label">{side === 'buy' ? 'Pay with' : 'Receive'}</Txt>
    <View style={st.wrap}>
      {pairMints.map(mint => <Chip key={mint} label={label(mint)} active={pair === mint} onPress={() => { if (!locked) { setPair(mint); editAmount('') } }} />)}
    </View>
    <View style={st.inputRow}>
      <TextInput accessibilityLabel="Custom payment mint" placeholder="Or paste a token mint" placeholderTextColor={C.faint} value={customMint} onChangeText={setCustomMint} editable={!locked} autoCapitalize="none" style={[st.input, st.mintInput]} />
      <Button kind="quiet" label="Use" disabled={locked || !customMint.trim()} onPress={() => {
        try { const mint = validateMint(customMint); if (mint === t.address) throw new Error('Choose a different token for the other side of this trade.'); setPair(mint); editAmount(''); setCustomMint('') }
        catch (error) { setError(messageOf(error)) }
      }} />
    </View>
    {!pairMints.includes(pair) ? <Txt v="monoSmall" selectable>Selected: {pair}</Txt> : null}
    <View style={st.inputBox}>
      <View style={st.heading}><Txt v="label">You pay</Txt><Txt v="small">{balance !== null && decimals[inputMint] !== undefined ? `Balance ${fromAtomic(balance, decimals[inputMint])}` : address ? 'Loading balance…' : 'Connect to see balance'}</Txt></View>
      <View style={st.inputRow}>
        <TextInput accessibilityLabel="Trade amount" value={amount} onChangeText={editAmount} editable={!locked} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={C.faint} style={st.amount} />
        <Txt v="mono">{label(inputMint)}</Txt>
      </View>
      <View style={st.wrap}>{[10, 25, 50, 100].map(percent => <Chip key={percent} label={`${percent}%`} onPress={() => {
        if (!locked && balance !== null && decimals[inputMint] !== undefined) editAmount(fromAtomic(balancePercent(balance, percent, inputMint === SOL_MINT), decimals[inputMint]))
      }} />)}</View>
      {inputMint === SOL_MINT && address ? <Txt v="monoSmall">Shortcuts leave 0.01 SOL for network fees and account rent.</Txt> : null}
    </View>
    <View style={st.wrap}><Chip label="Open in swap terminal ↗" onPress={() => router.push(swapLink(SOL_MINT, t.address) as never)} /></View>
    <View style={st.heading}><Txt v="small">Slippage tolerance</Txt><View style={st.wrap}>{[50, 100, 300].map(bps => <Chip key={bps} label={`${bps / 100}%`} active={slippageBps === bps} onPress={() => { if (!locked) { setSlippageBps(bps); editAmount(amount) } }} />)}</View></View>
    {quote ? <View style={st.quote}>
      <View style={st.heading}><Txt v="label">You receive · estimated</Txt><Txt v="monoSmall" color={fresh ? C.accent : C.warn}>{fresh ? `${Math.max(0, 30 - Math.floor((now - quote.at) / 1000))}s to refresh` : 'Refresh quote'}</Txt></View>
      <Txt v="h1">{fromAtomic(quote.response.outAmount, decimals[outputMint])} {label(outputMint)}</Txt>
      <Txt v="small">Minimum received: {fromAtomic(quote.response.otherAmountThreshold, decimals[outputMint])} {label(outputMint)}</Txt>
      <Txt v="small">Price impact: {quote.response.priceImpactPct === null || !Number.isFinite(Number(quote.response.priceImpactPct)) ? 'unavailable' : `${Number(quote.response.priceImpactPct).toFixed(2)}%`}</Txt>
      {quote.response.platformFee ? <Txt v="small">Platform fee: {quote.response.platformFee.feeBps / 100}%</Txt> : null}
      {composedRoute ? <ComposerRouteNotice quote={quote.response} label={label} amountOf={amountOf} acknowledged={composerAck}
        onAcknowledge={() => { acknowledgeComposer(quote.response.composerProgramId); setAckedProgram(quote.response.composerProgramId ?? 'unreported') }} /> : null}
      {decodedRoute ? <DecodedRouteNotice quote={quote.response} acknowledged={decodedAck}
        onAcknowledge={() => { acknowledgeDecodedProgram(quote.response.decodedProgramId); setAckedProgram(quote.response.decodedProgramId ?? 'unreported') }} /> : null}
      {quote.response.routePlan.map((leg, i) => leg.swapInfo ? <View key={`${i}-${leg.swapInfo.ammKey}`} style={{ gap: 3 }}>
        <Txt v="small">{i + 1}. {leg.swapInfo.label || 'Pool'} · {label(leg.swapInfo.inputMint)} → {label(leg.swapInfo.outputMint)}</Txt>
        <Txt v="monoSmall">Pool fee: {decimals[leg.swapInfo.feeMint] !== undefined ? fromAtomic(leg.swapInfo.feeAmount, decimals[leg.swapInfo.feeMint]) : `${leg.swapInfo.feeAmount} atomic units`} {label(leg.swapInfo.feeMint)}</Txt>
      </View> : null)}
      <Txt v="monoSmall">Network fees and account rent are additional. Wallet approval follows simulation.</Txt>
    </View> : null}
    {address ? <View style={st.heading}><Txt v="monoSmall">Wallet {shortMint(address)}</Txt><Button label="Disconnect" kind="quiet" disabled={locked} onPress={() => void act(async () => { await signer?.disconnect(); setQuote(null) })} /></View> : null}
    {error ? <Txt v="small" color={C.warn}>{error}</Txt> : null}
    {phase ? <Txt v="small" color={C.accent}>{phase}</Txt> : null}
    {pending ? <View style={st.quote}>
      <Txt v="h2" color={pending.state === 'confirmed' ? C.accent : C.muted}>{pending.state === 'confirmed' ? 'Trade confirmed' : pending.state === 'pending' ? 'Submitted · awaiting confirmation' : `Transaction ${pending.state}`}</Txt>
      <Button kind="quiet" label="View transaction ↗" onPress={() => void Linking.openURL(`https://solscan.io/tx/${pending.signature}`)} />
      {pending.state === 'pending' ? <Button kind="ghost" label="Check confirmation" disabled={busy} onPress={() => { void checkPending().catch(error => setError(messageOf(error))) }} /> : null}
    </View> : null}
    <View style={st.wrap}>
      <Button kind={quote ? 'ghost' : 'primary'} label={quote ? 'Refresh quote' : 'Get quote'} busy={busy && phase === 'Finding a route…'} disabled={locked || !amount.trim()} onPress={() => void act(requestQuote)} style={{ flex: 1 }} />
      {signer && !address ? <Button label="Connect wallet" busy={busy && !phase} disabled={locked} onPress={() => void act(signer.connect)} style={{ flex: 1 }} /> : null}
      {address ? <Button label={composedRoute && !composerAck ? 'Acknowledge the composed route' : decodedRoute && !decodedAck ? 'Acknowledge the decoded route' : side === 'buy' ? 'Review & buy' : 'Review & sell'} disabled={locked || !fresh || signer?.transactionVersion === null || composedRoute && !composerAck || decodedRoute && !decodedAck} onPress={() => void act(trade)} style={{ flex: 1 }} /> : null}
    </View>
    {onBack ? <Button label="Choose another wallet" kind="quiet" disabled={locked} onPress={onBack} /> : null}
  </View>
}

const st = StyleSheet.create({
  stack: { gap: 12 },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  inputBox: { padding: 12, borderRadius: 12, borderWidth: 1, borderColor: C.lineStrong, backgroundColor: C.bg, gap: 8 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  input: { flex: 1, minWidth: 0, height: 44, color: C.text, fontFamily: F.mono, fontSize: 13 },
  mintInput: { paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: C.line },
  amount: { flex: 1, minWidth: 0, height: 48, color: C.text, fontFamily: F.monoBold, fontSize: 24 },
  quote: { gap: 8, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.bg },
})
