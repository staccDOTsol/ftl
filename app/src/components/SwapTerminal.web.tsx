// Full-page terminal for the Solana router: one card with a Swap | Liquidity
// switch. Swap is pay and receive panels, a flip, route details and a single
// primary action, in the shape of Jupiter Terminal; Liquidity mounts the same
// liquidity card the token page uses on the receive token, inside the same
// wallet session: Simple (SOL in, LP out; LP in, SOL out) by default, with the
// full open / add / remove form behind its Advanced chip. Wallets come from SolanaWallet.web (shared
// with the token page); the quote → build/simulate → sign → send → confirm
// loop and the pending-transaction recovery follow the token page's TradeForm.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Linking, Modal, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import bs58 from 'bs58'
import { C, F, T } from '@/theme'
import { ApiError, get } from '@/lib/api'
import { short, venue } from '@/lib/format'
import type { PoolSummary, TokenSummary } from '@/lib/types'
import { tokenMetaOne, useTokenMeta, type TokenMetaMap, type TokenMetaRecord } from '@/lib/token-meta'
import { balancePercent, fromAtomic, isQuoteFresh, QUOTE_TTL_MS, shortMint, SOL_MINT, toAtomic, type SolanaQuote } from '@/lib/solana-trade'
import { assertSignedMessage, buildAndSimulate, decodeTransaction, getRouterStatus, getSolanaQuote, mintDecimals, sendSignedSwap, tokenBalance, transactionStatus, validateMint } from '@/lib/solana'
import { hasPending, readPending, writePending, type PendingSwap } from '@/lib/solana-pending'
import { formatBps, isMintLike, KNOWN_TOKENS, rateString, USDC_MINT, type SwapLink, type SwapLinkAction, type SwapMode } from '@/lib/swap-link'
import { inspectTransaction, type TransactionVersion } from '@/lib/solana-wire'
import { Button, Chip, Press, Seg, TokenAvatar, Txt } from './ui'
import { useSolanaWallets, walletName, WalletPicker, WalletSession, type SolanaSigner, type WalletKey } from './SolanaWallet.web'
import ZapLiquidity from './ZapLiquidity.web'

interface Token { mint: string; symbol: string; name?: string; image?: string }
interface WalletState { address: string | null; version: TransactionVersion | null; name: string }
type Phase = 'idle' | 'simulating' | 'approve' | 'submitting' | 'confirming'
const REFRESH_MS = 15_000
const SLIPPAGE_PRESETS = [10, 50, 100, 300]
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'The operation could not finish. Please try again.'
const tokenOf = (mint: string, known?: Partial<Token> | null): Token => {
  const base = KNOWN_TOKENS.find(token => token.mint === mint)
  return { mint, symbol: known?.symbol || base?.symbol || shortMint(mint), name: known?.name ?? base?.name, image: known?.image }
}
const fromSummary = (summary: TokenSummary): Token => tokenOf(summary.address, { symbol: summary.symbol, name: summary.name, image: summary.image })
// Fill symbol / name / image from the metadata endpoint without replacing a
// token that already carries them; same object back when nothing changes.
function withMeta(token: Token, meta: TokenMetaMap): Token {
  const record = meta[token.mint]
  if (!record) return token
  const known = KNOWN_TOKENS.some(known => known.mint === token.mint)
  const symbol = known ? token.symbol : record.symbol || token.symbol
  const name = token.name ?? record.name ?? undefined
  const image = token.image ?? record.image ?? undefined
  return symbol === token.symbol && name === token.name && image === token.image ? token : { ...token, symbol, name, image }
}
const LIQUIDITY_BATCH_KEY = 'liquidityxyz.solana.liquidity-batch.v1'
const priceImpact = (value: string | null) => value === null || !Number.isFinite(Number(value)) ? 'n/a' : `${Number(value).toFixed(2)}%`

// Pushes the live signer up to the terminal without remounting its form, and
// opens the wallet once right after it is chosen.
function SignerBridge({ signer, name, onSigner, onError }: { signer: SolanaSigner; name: string; onSigner: (signer: SolanaSigner | null, name: string | null) => void; onError: (message: string) => void }) {
  const latest = useRef({ signer, onError })
  latest.current = { signer, onError }
  useEffect(() => { onSigner(signer, name) }, [signer, name, onSigner])
  useEffect(() => () => onSigner(null, null), [onSigner])
  useEffect(() => {
    if (latest.current.signer.address) return
    void latest.current.signer.connect().catch(error => latest.current.onError(messageOf(error)))
  }, [])
  return null
}

export default function SwapTerminal({ initial }: { initial: SwapLink }) {
  const wallets = useSolanaWallets()
  const [selected, setSelected] = useState<WalletKey | null>(null)
  const [walletModal, setWalletModal] = useState(false)
  const [walletMenu, setWalletMenu] = useState(false)
  const signerRef = useRef<SolanaSigner | null>(null)
  const [signer, setSigner] = useState<SolanaSigner | null>(null)
  const [wallet, setWallet] = useState<WalletState | null>(null)
  const [mode, setMode] = useState<SwapMode>(initial.mode)
  const [liquidityLocked, setLiquidityLocked] = useState(false)
  const address = wallet?.address ?? null
  const transactionVersion = wallet?.version ?? '1'

  const [input, setInput] = useState<Token>(() => tokenOf(initial.inputMint))
  const [output, setOutput] = useState<Token | null>(() => initial.outputMint ? tokenOf(initial.outputMint) : null)
  const [amount, setAmount] = useState(initial.amount)
  const [slippageBps, setSlippageBps] = useState(50)
  const [customBps, setCustomBps] = useState('')
  const [settings, setSettings] = useState(false)
  const [picker, setPicker] = useState<'in' | 'out' | null>(null)
  const [rateFlipped, setRateFlipped] = useState(false)
  const [decimals, setDecimals] = useState<Record<string, number>>({ [SOL_MINT]: 9 })
  const [balances, setBalances] = useState<Record<string, { owner: string; raw: string }>>({})
  const [quoteResult, setQuoteResult] = useState<{ response: SolanaQuote; at: number; wallet: string | null; key: string } | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [quoteError, setQuoteError] = useState<{ message: string; at: number } | null>(null)
  const [networkFee, setNetworkFee] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [phase, setPhase] = useState<Phase>('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingSwap | null>(null)
  const [routerMessage, setRouterMessage] = useState('Checking route service…')
  const seq = useRef(0)
  const operation = useRef(false)
  const mounted = useRef(true)

  const inputMint = input.mint
  const outputMint = output?.mint ?? null
  const amountRaw = useMemo(() => {
    if (decimals[inputMint] === undefined) return null
    try { return toAtomic(amount, decimals[inputMint]) } catch { return null }
  }, [amount, decimals, inputMint])
  const quoteKey = outputMint && amountRaw ? `${inputMint}|${outputMint}|${amountRaw}|${slippageBps}|${transactionVersion}` : null
  const quote = quoteResult && quoteResult.key === quoteKey && quoteResult.wallet === address ? quoteResult : null
  const fresh = !!quote && isQuoteFresh(quote.at, now)
  const unresolved = pending?.state === 'pending'
  const locked = busy || unresolved || liquidityLocked
  const inputBalance = balances[inputMint]?.owner === address ? balances[inputMint].raw : null
  const outputBalance = outputMint && balances[outputMint]?.owner === address ? balances[outputMint].raw : null

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
  useEffect(() => {
    let alive = true
    void getRouterStatus().then(status => {
      if (alive) setRouterMessage(status.configured === false || status.available === false || status.status !== 'ok' ? (status.message || 'Route service is unavailable.') : 'Direct routes · quote before signing')
    }).catch(() => { if (alive) setRouterMessage('Route service is reconnecting. You can retry a quote.') })
    return () => { alive = false }
  }, [])
  // Deep-linked and pasted mints arrive as bare addresses; the metadata endpoint
  // (FTL row → DAS → mint account) names them, and route legs through other mints.
  const legMints = useMemo(() => quoteResult?.response.routePlan.flatMap(leg => leg.swapInfo ? [leg.swapInfo.inputMint, leg.swapInfo.outputMint] : []) ?? [], [quoteResult])
  const meta = useTokenMeta([inputMint, outputMint, ...legMints])
  useEffect(() => {
    setInput(current => withMeta(current, meta))
    setOutput(current => current ? withMeta(current, meta) : current)
  }, [meta])
  // An interrupted liquidity batch resumes in Liquidity mode, like the token page.
  useEffect(() => {
    const timer = setTimeout(() => { try { if (initial.outputMint && localStorage.getItem(LIQUIDITY_BATCH_KEY)) setMode('liquidity') } catch {} }, 0)
    return () => clearTimeout(timer)
  }, [initial.outputMint])

  useEffect(() => {
    let alive = true
    const mints = [inputMint, outputMint].filter((mint): mint is string => !!mint && decimals[mint] === undefined)
    if (!mints.length) return
    void Promise.all(mints.map(async mint => [mint, await mintDecimals(mint)] as const))
      .then(values => { if (alive) setDecimals(old => ({ ...old, ...Object.fromEntries(values) })) })
      .catch(error => { if (alive) setError(messageOf(error)) })
    return () => { alive = false }
  }, [inputMint, outputMint, decimals])

  const refreshBalances = useCallback(async () => {
    if (!address) return
    const owner = address
    const mints = [inputMint, outputMint].filter((mint): mint is string => !!mint)
    const values = await Promise.all(mints.map(async mint => [mint, await tokenBalance(owner, mint)] as const))
    if (mounted.current && signerRef.current?.address === owner) setBalances(old => ({ ...old, ...Object.fromEntries(values.map(([mint, raw]) => [mint, { owner, raw }])) }))
  }, [address, inputMint, outputMint])
  useEffect(() => {
    let active = true
    const refresh = () => { void refreshBalances().catch(error => { if (active) setError(`Balance unavailable: ${messageOf(error)}`) }) }
    refresh()
    const timer = setInterval(refresh, 20_000)
    return () => { active = false; clearInterval(timer) }
  }, [refreshBalances])

  // Quote on every valid change (debounced) and every 15 s after that while idle.
  const fetchQuote = useCallback(async (key: string) => {
    const [inMint, outMint, raw, bps, version] = key.split('|')
    const request = ++seq.current
    setQuoting(true); setQuoteError(null)
    try {
      const result = await getSolanaQuote({ inputMint: inMint, outputMint: outMint, amount: raw, slippageBps: Number(bps), transactionVersion: version as TransactionVersion })
      if (request === seq.current && mounted.current) { setQuoteResult({ response: result, at: Date.now(), wallet: signerRef.current?.address ?? null, key }); setNow(Date.now()) }
    } catch (error) {
      if (request === seq.current && mounted.current) { setQuoteResult(null); setQuoteError({ message: messageOf(error), at: Date.now() }) }
    } finally { if (request === seq.current && mounted.current) setQuoting(false) }
  }, [])
  // Inputs are disabled while a swap runs, so this never fires mid-swap; the
  // in-flight swap keeps its own `seq` snapshot.
  useEffect(() => {
    seq.current++
    setQuoteResult(null); setQuoteError(null); setQuoting(false); setNetworkFee(null)
    if (!quoteKey) return
    const timer = setTimeout(() => void fetchQuote(quoteKey), 350)
    return () => clearTimeout(timer)
  }, [quoteKey, address, fetchQuote])
  useEffect(() => {
    if (!quoteKey || locked || quoting) return
    const due = quote ? quote.at + REFRESH_MS : quoteError ? quoteError.at + REFRESH_MS : null
    if (due === null) return
    const timer = setTimeout(() => void fetchQuote(quoteKey), Math.max(0, due - Date.now()))
    return () => clearTimeout(timer)
  }, [quoteKey, locked, quoting, quote, quoteError, fetchQuote])

  const onSigner = useCallback((signer: SolanaSigner | null, name: string | null) => {
    signerRef.current = signer
    setSigner(signer)
    const next: WalletState | null = signer && name ? { address: signer.address, version: signer.transactionVersion, name } : null
    setWallet(current => current?.address === next?.address && current?.version === next?.version && current?.name === next?.name ? current : next)
  }, [])
  const chooseWallet = (key: WalletKey) => { setSelected(key); setWalletModal(false); setWalletMenu(false); setError(null) }
  const leaveWallet = () => { setSelected(null); setWalletMenu(false); wallets.rescan() }

  function editAmount(value: string) { setAmount(value); setError(null) }
  function setTokens(nextInput: Token, nextOutput: Token | null) { setInput(nextInput); setOutput(nextOutput); setError(null) }
  function flip() {
    if (locked || !output) return
    const estimated = quote && decimals[output.mint] !== undefined ? fromAtomic(quote.response.outAmount, decimals[output.mint]) : amount
    setTokens(output, input); setAmount(estimated); setRateFlipped(false)
  }
  function pick(side: 'in' | 'out', token: Token) {
    setPicker(null)
    if (side === 'in') {
      if (output?.mint === token.mint) setTokens(token, input)
      else setTokens(token, output)
    } else if (token.mint === input.mint) setTokens(output ?? tokenOf(token.mint === SOL_MINT ? USDC_MINT : SOL_MINT), token)
    else setTokens(input, token)
  }
  function applyCustomBps() {
    const value = Number(customBps)
    if (!Number.isInteger(value) || value < 1 || value > 5000) { setError('Slippage must be a whole number of basis points between 1 and 5000.'); return }
    setSlippageBps(value); setError(null)
  }

  function savePending(value: PendingSwap) {
    writePending(value)
    if (mounted.current) setPending(value)
  }
  async function checkPending(tx = pending) {
    if (!tx) return
    const state = await transactionStatus(tx.signature, tx.lastValidBlockHeight)
    if (!mounted.current) return
    savePending({ ...tx, state })
    if (state === 'confirmed') await refreshBalances()
    if (state === 'failed') setError('The transaction failed on-chain. Refresh your balance and request a new quote.')
    if (state === 'expired') setError('The transaction expired without confirmation. Request a new quote.')
    return state
  }
  async function act(fn: () => Promise<void>) {
    if (operation.current) return
    operation.current = true
    setBusy(true); setError(null)
    try { await fn() } catch (error) { if (mounted.current) setError(messageOf(error)) }
    finally { operation.current = false; if (mounted.current) { setBusy(false); setPhase('idle') } }
  }
  async function swap() {
    if (hasPending()) throw new Error('Resolve the pending wallet transaction before starting another swap.')
    const signer = signerRef.current
    if (!signer?.address || !quote || !isQuoteFresh(quote.at) || quote.wallet !== signer.address) throw new Error('Connect your wallet and wait for a fresh route.')
    const owner = signer.address
    const request = seq.current
    if (signer.transactionVersion === null) throw new Error('This wallet does not advertise V0 or V1 transaction signing. Choose a compatible wallet.')
    setPhase('simulating')
    const built = await buildAndSimulate(quote.response, owner, signer.transactionVersion)
    if (!mounted.current || request !== seq.current || signerRef.current?.address !== owner || !isQuoteFresh(quote.at)) throw new Error('The route or wallet changed. Wait for a fresh route.')
    setNetworkFee(built.networkFeeLamports ?? null)
    setPhase('approve')
    const signed = await signer.sign(decodeTransaction(built.swapTransaction))
    assertSignedMessage(built.swapTransaction, signed)
    if (!mounted.current || signerRef.current?.address !== owner) throw new Error('Wallet changed or the swap was closed. Nothing was sent.')
    const signatureBytes = inspectTransaction(signed).signatures[0]
    if (!signatureBytes?.some(byte => byte !== 0)) throw new Error('Wallet did not sign this transaction.')
    const signature = bs58.encode(signatureBytes)
    const tx: PendingSwap = { signature, lastValidBlockHeight: built.lastValidBlockHeight, state: 'pending' }
    // Preserve the signature before sending: a network timeout may still have landed.
    savePending(tx); seq.current++; setQuoteResult(null); setPhase('submitting')
    try {
      const returned = await sendSignedSwap(signed, built.lastValidBlockHeight)
      if (returned !== signature) throw new Error('Unexpected RPC signature. Check the transaction status below.')
    } catch (error) {
      setError(`Submission needs a status check: ${messageOf(error)} Do not submit another swap until its status is resolved.`)
    }
    setPhase('confirming')
    for (let i = 0; i < 20 && mounted.current; i++) {
      const status = await checkPending(tx)
      if (status !== 'pending') break
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
  }
  function reset() { setPending(null); setAmount(''); setError(null); setNetworkFee(null) }

  const symbol = (mint: string) => mint === input.mint ? input.symbol : mint === output?.mint ? output.symbol : tokenOf(mint, meta[mint] ? { symbol: meta[mint].symbol ?? undefined } : null).symbol
  const outDecimals = outputMint ? decimals[outputMint] : undefined
  const estimated = quote && outDecimals !== undefined ? fromAtomic(quote.response.outAmount, outDecimals) : null
  const rate = quote && output && outDecimals !== undefined && decimals[inputMint] !== undefined
    ? (rateFlipped ? rateString(quote.response.outAmount, outDecimals, quote.response.inAmount, decimals[inputMint]) : rateString(quote.response.inAmount, decimals[inputMint], quote.response.outAmount, outDecimals))
    : null
  const countdown = quote ? Math.max(0, Math.ceil((quote.at + REFRESH_MS - now) / 1000)) : null

  const primary = ((): { label: string; onPress?: () => void; busy?: boolean } => {
    if (unresolved) return { label: 'Confirming…', busy: true }
    if (!wallet) return { label: 'Connect wallet', onPress: () => setWalletModal(true) }
    if (!address) return { label: 'Connect wallet', busy, onPress: () => void act(async () => { await signerRef.current?.connect() }) }
    if (phase === 'simulating') return { label: 'Simulating…', busy: true }
    if (phase === 'approve') return { label: 'Approve in wallet…', busy: true }
    if (phase === 'submitting') return { label: 'Submitting…', busy: true }
    if (phase === 'confirming') return { label: 'Confirming…', busy: true }
    if (!output) return { label: 'Select a token' }
    if (!amountRaw) return { label: 'Enter an amount' }
    if (inputBalance !== null && BigInt(amountRaw) > BigInt(inputBalance)) return { label: 'Insufficient balance' }
    if (quoteError) return { label: 'No route' }
    if (!quote || quoting && !fresh) return { label: 'Fetching route…', busy: true }
    if (wallet.version === null) return { label: 'Wallet cannot sign V0/V1' }
    return { label: 'Swap', onPress: () => void act(swap) }
  })()
  const resolved = pending && pending.state !== 'pending' ? pending : null

  return <View style={st.card}>
    <View style={st.header}>
      <Txt v="h1">{mode === 'liquidity' ? 'Liquidity' : 'Swap'}</Txt>
      <View style={st.headerRight}>
        {mode === 'swap' ? <Press onPress={() => setSettings(value => !value)} accessibilityRole="button" accessibilityLabel="Swap settings" hitSlop={6} style={({ hovered, pressed }) => [st.icon, settings && { borderColor: C.accent + '88', backgroundColor: C.accentDim }, hovered && { backgroundColor: C.hover }, pressed && { opacity: 0.7 }]}>
          <Txt v="mono" color={settings ? C.accent : C.muted}>⚙</Txt>
        </Press> : null}
        {address
          ? <Button kind="ghost" label={shortMint(address)} disabled={locked} onPress={() => setWalletMenu(value => !value)} />
          : <Button kind={wallet ? 'ghost' : 'primary'} label={wallet ? `Connect ${wallet.name}` : 'Connect'} busy={busy && phase === 'idle' && !!wallet} onPress={() => wallet ? void act(async () => { await signerRef.current?.connect() }) : setWalletModal(true)} />}
      </View>
    </View>
    {walletMenu && address ? <View style={st.menu}>
      <Txt v="monoSmall" selectable>{wallet?.name} · {address}</Txt>
      <View style={st.wrap}>
        <Button kind="quiet" label="Disconnect" disabled={locked} onPress={() => void act(async () => { await signerRef.current?.disconnect(); setWalletMenu(false) })} />
        <Button kind="quiet" label="Change wallet" disabled={locked} onPress={leaveWallet} />
      </View>
    </View> : null}
    {selected && walletName(selected, wallets) ? <WalletSession selected={selected} wallets={wallets} onBack={leaveWallet} embeddedTitle={null}>
      {(signer, name) => <SignerBridge signer={signer} name={name} onSigner={onSigner} onError={setError} />}
    </WalletSession> : null}
    <Seg value={mode} options={[{ value: 'swap', label: 'Swap' }, { value: 'liquidity', label: 'Liquidity' }]} onChange={value => { if (!locked) { setMode(value); setError(null) } }} />
    {mode === 'liquidity' ? <>
      <LiquidityPane token={output} pool={initial.pool} action={initial.action} advanced={initial.advanced} signer={signer} meta={meta} locked={locked} onLockChange={setLiquidityLocked} onPickToken={() => setPicker('out')} onConnect={() => wallet ? void act(async () => { await signerRef.current?.connect() }) : setWalletModal(true)} />
      {error ? <Txt v="small" color={C.warn}>{error}</Txt> : null}
    </> : null}
    {mode === 'swap' && settings ? <View style={st.panel}>
      <View style={st.between}><Txt v="label">Slippage tolerance</Txt><Txt v="monoSmall" color={C.accent}>{formatBps(slippageBps)}</Txt></View>
      <View style={st.wrap}>{SLIPPAGE_PRESETS.map(bps => <Chip key={bps} label={formatBps(bps)} active={slippageBps === bps} onPress={() => { if (!locked) { setSlippageBps(bps); setCustomBps('') } }} />)}</View>
      <View style={st.inputRow}>
        <TextInput accessibilityLabel="Custom slippage in basis points" value={customBps} onChangeText={setCustomBps} onSubmitEditing={applyCustomBps} editable={!locked} keyboardType="number-pad" placeholder="Custom bps" placeholderTextColor={C.faint} style={[st.textInput, st.boxed]} />
        <Button kind="quiet" label="Set" disabled={locked || !customBps.trim()} onPress={applyCustomBps} />
      </View>
      <Txt v="monoSmall">{wallet ? wallet.version === '1' ? `${wallet.name} signs V1 transactions · routes up to 4,096 bytes` : wallet.version === '0' ? `${wallet.name} signs V0 transactions · routes must fit 1,232 bytes` : `${wallet.name} does not advertise V0 or V1 signing` : 'V1 wallets fit longer routes (4,096 bytes); V0 wallets are limited to 1,232 bytes.'}</Txt>
    </View> : null}

    {mode === 'swap' ? <>
    <View style={st.panel}>
      <View style={st.between}>
        <Txt v="label">You pay</Txt>
        <View style={st.balanceRow}>
          <Txt v="monoSmall">{inputBalance !== null && decimals[inputMint] !== undefined ? `Balance ${fromAtomic(inputBalance, decimals[inputMint])}` : address ? 'Balance …' : ''}</Txt>
          {inputBalance !== null && decimals[inputMint] !== undefined ? [['HALF', 50], ['MAX', 100]].map(([label, percent]) => (
            <Press key={label} disabled={locked} onPress={() => editAmount(fromAtomic(balancePercent(inputBalance, Number(percent), inputMint === SOL_MINT), decimals[inputMint]))} accessibilityRole="button" style={({ hovered, pressed }) => [st.miniChip, hovered && { backgroundColor: C.hover }, pressed && { opacity: 0.7 }]}>
              <Txt v="label" color={C.accent}>{label}</Txt>
            </Press>
          )) : null}
        </View>
      </View>
      <View style={st.row}>
        <TokenButton token={input} disabled={locked} onPress={() => setPicker('in')} />
        <TextInput accessibilityLabel="Amount to pay" value={amount} onChangeText={editAmount} editable={!locked} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={C.faint} style={st.amount} />
      </View>
      {inputMint === SOL_MINT && address ? <Txt v="monoSmall">HALF and MAX leave 0.01 SOL for fees and rent.</Txt> : null}
    </View>

    <View style={st.flipRow}>
      <View style={st.flipLine} />
      <Press onPress={flip} disabled={locked || !output} accessibilityRole="button" accessibilityLabel="Flip tokens" style={({ hovered, pressed }) => [st.flip, hovered && { borderColor: C.accent + '88', backgroundColor: C.accentDim }, pressed && { transform: [{ rotate: '180deg' }] }]}>
        <Txt v="mono" color={C.accent}>⇅</Txt>
      </Press>
      <View style={st.flipLine} />
    </View>

    <View style={st.panel}>
      <View style={st.between}>
        <Txt v="label">You receive</Txt>
        <Txt v="monoSmall">{outputBalance !== null && outDecimals !== undefined ? `Balance ${fromAtomic(outputBalance, outDecimals)}` : ''}</Txt>
      </View>
      <View style={st.row}>
        <TokenButton token={output} disabled={locked} onPress={() => setPicker('out')} />
        <Txt v="num" style={[st.estimate, !estimated && { color: C.faint }]} numberOfLines={1}>{estimated ?? (quoting ? '…' : '0.00')}</Txt>
      </View>
      {quote ? <View style={st.between}>
        <Txt v="monoSmall" color={fresh ? C.accent : C.warn}>{quoting || !fresh ? 'Refreshing…' : `Refreshes in ${countdown}s`}</Txt>
        <Txt v="monoSmall">Valid {QUOTE_TTL_MS / 1000}s per quote</Txt>
      </View> : null}
    </View>

    {quote && output ? <View style={st.details}>
      {rate ? <Press onPress={() => setRateFlipped(value => !value)} accessibilityRole="button" style={({ hovered }) => [st.between, hovered && { opacity: 0.8 }]}>
        <Txt v="monoSmall" color={C.text}>1 {rateFlipped ? output.symbol : input.symbol} ≈ {rate} {rateFlipped ? input.symbol : output.symbol}</Txt>
        <Txt v="monoSmall" color={C.accent}>⇄</Txt>
      </Press> : null}
      <Detail label="Price impact" value={priceImpact(quote.response.priceImpactPct)} warn={Number(quote.response.priceImpactPct) >= 3} />
      <Detail label="Minimum received" value={outDecimals !== undefined ? `${fromAtomic(quote.response.otherAmountThreshold, outDecimals)} ${output.symbol}` : '…'} />
      <Detail label="Slippage" value={formatBps(quote.response.slippageBps)} />
      <Detail label="Platform fee" value={quote.response.platformFee ? formatBps(quote.response.platformFee.feeBps) : 'none'} />
      <Detail label="Network fee" value={networkFee !== null ? `≈ ${fromAtomic(String(networkFee), 9)} SOL` : 'after simulation'} />
      <View style={{ gap: 4, marginTop: 4 }}>
        <Txt v="label">Route · {quote.response.routePlan.length} {quote.response.routePlan.length === 1 ? 'leg' : 'legs'}</Txt>
        {quote.response.routePlan.map((leg, i) => leg.swapInfo ? <View key={`${i}-${leg.swapInfo.ammKey}`} style={st.leg}>
          <Txt v="monoSmall" color={C.text}>{i + 1}. {venue(leg.swapInfo.label || '') || 'Pool'}{leg.percent !== 100 ? ` · ${leg.percent}%` : ''}</Txt>
          <Txt v="monoSmall">{symbol(leg.swapInfo.inputMint)} → {symbol(leg.swapInfo.outputMint)} · pool {short(leg.swapInfo.ammKey, 4)}</Txt>
        </View> : null)}
      </View>
    </View> : null}

    {quoteError && !quote ? <Txt v="small" color={C.warn}>{quoteError.message}</Txt> : null}
    {error ? <Txt v="small" color={C.warn}>{error}</Txt> : null}

    {resolved ? <View style={[st.details, { borderColor: resolved.state === 'confirmed' ? C.accent + '66' : C.warn + '66' }]}>
      <Txt v="h2" color={resolved.state === 'confirmed' ? C.accent : C.warn}>{resolved.state === 'confirmed' ? 'Swap confirmed' : `Transaction ${resolved.state}`}</Txt>
      <Txt v="monoSmall" selectable numberOfLines={1}>{resolved.signature}</Txt>
      <View style={st.wrap}>
        <Button kind="ghost" label="View on Solscan ↗" onPress={() => void Linking.openURL(`https://solscan.io/tx/${resolved.signature}`)} style={{ flex: 1 }} />
        <Button label="Swap again" onPress={reset} style={{ flex: 1 }} />
      </View>
    </View> : null}
    {unresolved ? <View style={st.details}>
      <Txt v="small">Submitted · awaiting confirmation. No new swap starts until this one resolves.</Txt>
      <View style={st.wrap}>
        <Button kind="ghost" label="View on Solscan ↗" onPress={() => void Linking.openURL(`https://solscan.io/tx/${pending!.signature}`)} style={{ flex: 1 }} />
        <Button kind="ghost" label="Check status" disabled={busy} onPress={() => { void checkPending().catch(error => setError(messageOf(error))) }} style={{ flex: 1 }} />
      </View>
    </View> : null}

    {!resolved ? <Button label={primary.label} busy={primary.busy} disabled={!primary.onPress} onPress={primary.onPress} style={st.primary} /> : null}
    <Txt v="monoSmall" style={{ textAlign: 'center' }}>{routerMessage}</Txt>
    </> : null}

    <Modal visible={walletModal} transparent animationType="fade" onRequestClose={() => setWalletModal(false)}>
      <Press onPress={() => setWalletModal(false)} accessibilityLabel="Close" style={() => st.backdrop}>
        <View style={st.sheet} onStartShouldSetResponder={() => true}>
          <View style={st.between}><Txt v="h2">Connect a wallet</Txt><Button kind="quiet" label="Close" onPress={() => setWalletModal(false)} /></View>
          <WalletPicker wallets={wallets} onSelect={chooseWallet} />
          {!wallets.standard.length && !wallets.injected.length ? <Txt v="small">No browser wallet detected. Install Phantom or Solflare, or use the embedded wallet.</Txt> : null}
          <Txt v="small">Your trading wallet is separate from your profile key.</Txt>
        </View>
      </Press>
    </Modal>
    {picker ? <TokenPicker side={picker} exclude={picker === 'in' ? output?.mint ?? null : input.mint} onClose={() => setPicker(null)} onPick={token => pick(picker, token)} /> : null}
  </View>
}

// Liquidity mode: the token page's liquidity card (Simple by default) on the
// receive token. The token page payload supplies FTL's pools; a token FTL has
// not seen yet (404) gets a minimal summary from the metadata endpoint and an
// empty pool list, so a pool address can still be pasted or a new pool opened.
type LiquidityPage = { mint: string; t: TokenSummary; pools: PoolSummary[]; indexed: boolean }
const synthesizeToken = (mint: string, record: TokenMetaRecord | null, token: Token): TokenSummary => ({
  chain: 'solana', address: mint, symbol: record?.symbol ?? (token.symbol !== shortMint(mint) ? token.symbol : undefined), name: record?.name ?? token.name, image: record?.image ?? token.image, decimals: record?.decimals ?? undefined,
  launchedTs: null, launchVenue: null, graduatedTs: null, firstPoolTs: null, pools: 0, fundedPools: 0, lpWallets: 0, events: 0, lastTs: 0, score: 0, flags: [],
})
function LiquidityPane({ token, pool, action, advanced, signer, meta, locked, onLockChange, onPickToken, onConnect }: { token: Token | null; pool: string | null; action: SwapLinkAction; advanced: boolean; signer: SolanaSigner | null; meta: TokenMetaMap; locked: boolean; onLockChange: (locked: boolean) => void; onPickToken: () => void; onConnect: () => void }) {
  const mint = token?.mint ?? null
  const [page, setPage] = useState<LiquidityPage | null>(null)
  const [failure, setFailure] = useState<{ mint: string; message: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!mint || !token) return
    let alive = true
    void get<{ token: TokenSummary; pools: PoolSummary[] }>(`/api/token/solana/${mint}`)
      .then(result => { if (alive) setPage({ mint, t: result.token, pools: result.pools, indexed: true }) })
      .catch(async (error: unknown) => {
        if (!alive) return
        if (error instanceof ApiError && error.status === 404) {
          const record = await tokenMetaOne(mint).catch(() => null)
          if (alive) setPage({ mint, t: synthesizeToken(mint, record, token), pools: [], indexed: false })
        } else setFailure({ mint, message: messageOf(error) })
      })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mint, attempt])
  const current = page?.mint === mint ? page : null
  const record = mint ? meta[mint] : undefined
  // Pools arrive once per token; the symbol can land later from the metadata endpoint.
  const summary = useMemo<TokenSummary | null>(() => current ? { ...current.t, symbol: current.t.symbol || record?.symbol || undefined, name: current.t.name ?? record?.name ?? undefined, image: current.t.image ?? record?.image ?? undefined } : null, [current, record])
  return <>
    <View style={st.panel}>
      <View style={st.between}>
        <Txt v="label">Token</Txt>
        <Txt v="monoSmall">{!token ? '' : !current ? (failure?.mint === mint ? '' : 'Loading pools…') : current.indexed ? `${current.pools.length} FTL pool${current.pools.length === 1 ? '' : 's'}` : 'not indexed by FTL yet'}</Txt>
      </View>
      <View style={st.row}>
        <TokenButton token={token} disabled={locked} onPress={onPickToken} />
        {token ? <Txt v="monoSmall" selectable numberOfLines={1} style={{ flex: 1, textAlign: 'right' }}>{token.mint}</Txt> : <Txt v="small" style={{ flex: 1 }}>Choose the token whose liquidity you want to open, add to or pull.</Txt>}
      </View>
      {token && record && !record.symbol ? <Txt v="small">Unnamed token: no symbol in DAS or on-chain metadata. Check the mint before adding liquidity.</Txt> : null}
    </View>
    {failure?.mint === mint && !current ? <View style={st.details}>
      <Txt v="small" color={C.warn}>{failure.message}</Txt>
      <Button kind="ghost" label="Retry" onPress={() => { setFailure(null); setAttempt(value => value + 1) }} />
    </View> : null}
    {summary && current ? <ZapLiquidity key={current.mint} t={summary} pools={current.pools} signer={signer} onLockChange={onLockChange} exitRequest={action === 'exit'} initialPool={pool} advanced={advanced} onConnect={onConnect} /> : null}
  </>
}

function Detail({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return <View style={st.between}><Txt v="monoSmall">{label}</Txt><Txt v="monoSmall" color={warn ? C.warn : C.text}>{value}</Txt></View>
}

function TokenButton({ token, disabled, onPress }: { token: Token | null; disabled?: boolean; onPress: () => void }) {
  return <Press onPress={onPress} disabled={disabled} accessibilityRole="button" style={({ hovered, pressed }) => [st.tokenButton, !token && { borderColor: C.accent + '88', backgroundColor: C.accentDim }, hovered && { backgroundColor: C.hover }, pressed && { opacity: 0.7 }]}>
    {token ? <TokenAvatar image={token.image} label={token.symbol} size={24} /> : null}
    <Txt v="num" style={{ fontSize: T.sm }} numberOfLines={1}>{token ? token.symbol : 'Select token'}</Txt>
    <Txt v="monoSmall">▾</Txt>
  </Press>
}

// Search FTL-known tokens, paste any mint, or pick from the quick row.
function TokenPicker({ side, exclude, onClose, onPick }: { side: 'in' | 'out'; exclude: string | null; onClose: () => void; onPick: (token: Token) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Token[]>([])
  const [hot, setHot] = useState<Token[]>([])
  const [searching, setSearching] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const pasted = isMintLike(query)
  const pastedMeta = useTokenMeta(pasted ? [query.trim()] : [])
  const pastedRecord = pasted ? pastedMeta[query.trim()] : undefined
  useEffect(() => {
    let alive = true
    void get<TokenSummary[]>('/api/tokens/hot', { chain: 'solana', hours: 24, limit: 12 }).then(rows => { if (alive) setHot(rows.map(fromSummary)) }).catch(() => {})
    return () => { alive = false }
  }, [])
  useEffect(() => {
    const text = query.trim()
    if (!text) { setResults([]); setSearching(false); return }
    let alive = true
    setSearching(true)
    const timer = setTimeout(() => {
      void get<{ tokens: TokenSummary[] }>('/api/search', { q: text }).then(result => {
        if (alive) setResults(result.tokens.filter(token => token.chain === 'solana').map(fromSummary))
      }).catch(() => { if (alive) setResults([]) }).finally(() => { if (alive) setSearching(false) })
    }, 250)
    return () => { alive = false; clearTimeout(timer) }
  }, [query])
  async function usePasted() {
    try {
      const mint = validateMint(query)
      await mintDecimals(mint)
      onPick(results.find(token => token.mint === mint) ?? tokenOf(mint, pastedRecord ? { symbol: pastedRecord.symbol ?? undefined, name: pastedRecord.name ?? undefined, image: pastedRecord.image ?? undefined } : null))
    } catch (error) { setMessage(messageOf(error)) }
  }
  const quick = [...KNOWN_TOKENS.map(token => tokenOf(token.mint)), ...hot].filter(token => token.mint !== exclude)
  const list = results.filter(token => token.mint !== exclude)
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <Press onPress={onClose} accessibilityLabel="Close" style={() => st.backdrop}>
      <View style={[st.sheet, { maxHeight: '85%' }]} onStartShouldSetResponder={() => true}>
        <View style={st.between}><Txt v="h2">{side === 'in' ? 'Pay with' : 'Receive'}</Txt><Button kind="quiet" label="Close" onPress={onClose} /></View>
        <TextInput accessibilityLabel="Search tokens or paste a mint" value={query} onChangeText={value => { setQuery(value); setMessage(null) }} autoFocus autoCapitalize="none" autoCorrect={false} placeholder="Search by symbol, name or paste a mint" placeholderTextColor={C.faint} style={[st.textInput, st.boxed]} />
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 10 }}>
          {pasted ? <Press onPress={() => void usePasted()} accessibilityRole="button" style={({ hovered, pressed }) => [st.tokenRow, { borderColor: C.accent + '66', backgroundColor: C.accentDim }, hovered && { backgroundColor: C.hover }, pressed && { opacity: 0.7 }]}>
            {pastedRecord ? <TokenAvatar image={pastedRecord.image ?? undefined} label={pastedRecord.symbol ?? shortMint(query.trim())} size={32} chain="solana" /> : null}
            <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
              <Txt v="body" numberOfLines={1}>{pastedRecord?.symbol ? <>Use {pastedRecord.symbol}{pastedRecord.name ? <Txt v="small">  {pastedRecord.name}</Txt> : null}</> : pastedRecord ? 'Use pasted mint · unnamed token' : 'Use pasted mint'}</Txt>
              <Txt v="monoSmall" numberOfLines={1}>{query.trim()}</Txt>
            </View>
            <Txt v="mono" color={C.accent}>→</Txt>
          </Press> : null}
          {message ? <Txt v="small" color={C.warn}>{message}</Txt> : null}
          {!query.trim() ? <>
            <Txt v="label">Quick picks{hot.length ? ' · FTL hot tokens' : ''}</Txt>
            <View style={st.wrap}>{quick.map(token => <Chip key={token.mint} label={token.symbol} onPress={() => onPick(token)} />)}</View>
          </> : null}
          {query.trim() ? <Txt v="label">{searching ? 'Searching…' : `${list.length} ${list.length === 1 ? 'match' : 'matches'} in FTL’s index`}</Txt> : null}
          {list.map(token => <Press key={token.mint} onPress={() => onPick(token)} accessibilityRole="button" style={({ hovered, pressed }) => [st.tokenRow, hovered && { backgroundColor: C.hover }, pressed && { opacity: 0.7 }]}>
            <TokenAvatar image={token.image} label={token.symbol} size={32} chain="solana" />
            <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
              <Txt v="body" numberOfLines={1}>{token.symbol}{token.name ? <Txt v="small">  {token.name}</Txt> : null}</Txt>
              <Txt v="monoSmall" numberOfLines={1}>{shortMint(token.mint)}</Txt>
            </View>
          </Press>)}
        </ScrollView>
      </View>
    </Press>
  </Modal>
}

const st = StyleSheet.create({
  card: { width: '100%', maxWidth: 460, alignSelf: 'center', padding: 14, gap: 10, borderRadius: 18, backgroundColor: C.surface, borderWidth: 1, borderColor: C.line },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  icon: { width: 36, height: 36, borderRadius: 10, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg },
  menu: { gap: 6, padding: 10, borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.bg },
  panel: { padding: 12, borderRadius: 14, borderWidth: 1, borderColor: C.lineStrong, backgroundColor: C.bg, gap: 8 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  balanceRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  miniChip: { paddingHorizontal: 6, height: 20, borderRadius: 6, borderWidth: 1, borderColor: C.accent + '55', alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  textInput: { flex: 1, minWidth: 0, height: 44, color: C.text, fontFamily: F.mono, fontSize: 13 },
  boxed: { paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: C.line, backgroundColor: C.bg },
  amount: { flex: 1, minWidth: 0, height: 48, color: C.text, fontFamily: F.monoBold, fontSize: 26, textAlign: 'right' },
  estimate: { flex: 1, minWidth: 0, fontSize: 26, textAlign: 'right' },
  tokenButton: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 6, paddingRight: 10, height: 40, borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.surface, maxWidth: '55%' },
  flipRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: -4 },
  flipLine: { flex: 1, height: 1, backgroundColor: C.line },
  flip: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: C.lineStrong, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center' },
  details: { gap: 6, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: C.line, backgroundColor: C.bg },
  leg: { gap: 2, paddingLeft: 8, borderLeftWidth: 2, borderLeftColor: C.accent + '66' },
  primary: { height: 52, borderRadius: 14 },
  backdrop: { flex: 1, backgroundColor: '#00000099', alignItems: 'center', justifyContent: 'center', padding: 16 },
  sheet: { width: '100%', maxWidth: 420, gap: 10, padding: 14, borderRadius: 16, backgroundColor: C.surface, borderWidth: 1, borderColor: C.lineStrong },
  tokenRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.bg },
})
