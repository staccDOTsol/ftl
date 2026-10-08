import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Linking, StyleSheet, TextInput, View } from 'react-native'
import { VersionedTransaction } from '@solana/web3.js'
import { getWallets } from '@wallet-standard/app'
import type { Wallet, WalletAccount } from '@wallet-standard/base'
import { StandardConnect, StandardDisconnect, StandardEvents, type StandardConnectFeature, type StandardDisconnectFeature, type StandardEventsFeature } from '@wallet-standard/features'
import { SolanaSignTransaction, type SolanaSignTransactionFeature } from '@solana/wallet-standard-features'
import bs58 from 'bs58'
import { C, F } from '@/theme'
import type { FlowEvent, PoolSummary, TokenSummary } from '@/lib/types'
import { balancePercent, fromAtomic, isQuoteFresh, shortMint, SOL_MINT, toAtomic, type SolanaQuote } from '@/lib/solana-trade'
import { assertSignedMessage, buildAndSimulate, decodeTransaction, getRouterStatus, getSolanaQuote, mintDecimals, sendSignedSwap, tokenBalance, transactionStatus, validateMint, type Confirmation } from '@/lib/solana'
import { inspectTransaction, preferredTransactionVersion, type TransactionVersion } from '@/lib/solana-wire'
import { Button, Chip, Seg, Txt } from './ui'
import SolanaLiquidity from './SolanaLiquidity.web'

type Props = { t: TokenSummary; pools: PoolSummary[]; origin?: FlowEvent | null; initialAction?: 'exit' | 'liquidity' }
export interface SolanaSigner { address: string | null; transactionVersion: TransactionVersion | null; connect: () => Promise<void>; disconnect: () => Promise<void>; sign: (bytes: Uint8Array) => Promise<Uint8Array> }
type StandardSolanaWallet = Wallet & { features: StandardConnectFeature & SolanaSignTransactionFeature & Partial<StandardDisconnectFeature & StandardEventsFeature> }
function isStandardSolana(wallet: Wallet): wallet is StandardSolanaWallet {
  return wallet.chains.includes('solana:mainnet') && StandardConnect in wallet.features && SolanaSignTransaction in wallet.features
}
const signingAccount = (accounts: readonly WalletAccount[]) => accounts.find(account => account.chains.includes('solana:mainnet') && account.features.includes(SolanaSignTransaction)) ?? null
interface InjectedWallet {
  publicKey?: { toBase58(): string }
  connect(): Promise<unknown>
  disconnect(): Promise<void>
  signTransaction(tx: VersionedTransaction): Promise<VersionedTransaction>
  on?(event: string, callback: () => void): void
  removeListener?(event: string, callback: () => void): void
}
const EmbeddedWallet = lazy(() => import('./SolanaTradeEmbedded.web'))
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'The operation could not finish. Please try again.'
interface PendingSwap { signature: string; lastValidBlockHeight: number; state: Confirmation }
const PENDING_KEY = 'liquidityxyz.solana.pending.v1'
function readPending(): PendingSwap | null {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null')
    return value?.state === 'pending' && /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value.signature) && Number.isSafeInteger(value.lastValidBlockHeight) ? value : null
  } catch { return null }
}

function injectedWallets(): { name: string; provider: InjectedWallet }[] {
  if (typeof window === 'undefined') return []
  const browser = window as unknown as { phantom?: { solana?: InjectedWallet }; solflare?: InjectedWallet; solana?: InjectedWallet }
  const candidates = [
    { name: 'Phantom', provider: browser.phantom?.solana },
    { name: 'Solflare', provider: browser.solflare },
    { name: 'Browser wallet', provider: browser.solana },
  ]
  const seen = new Set<InjectedWallet>()
  return candidates.filter((entry): entry is { name: string; provider: InjectedWallet } => {
    if (!entry.provider?.signTransaction || seen.has(entry.provider)) return false
    seen.add(entry.provider)
    return true
  })
}

export default function SolanaTradeWeb(props: Props) {
  const [wallets, setWallets] = useState<ReturnType<typeof injectedWallets>>([])
  const [standardWallets, setStandardWallets] = useState<StandardSolanaWallet[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => {
    const registry = getWallets()
    const scan = () => { setWallets(injectedWallets()); setStandardWallets(registry.get().filter(isStandardSolana)) }
    const timer = setTimeout(scan, 0)
    const offRegister = registry.on('register', scan), offUnregister = registry.on('unregister', scan)
    return () => { clearTimeout(timer); offRegister(); offUnregister() }
  }, [])
  const external = wallets.find(wallet => wallet.name === selected)
  const standard = standardWallets.find(wallet => `standard:${wallet.name}` === selected)
  const switchWallet = () => { setSelected(null); setWallets(injectedWallets()) }
  if (selected === 'embedded') return <Suspense fallback={<Txt v="small">Loading embedded wallet…</Txt>}>
    <EmbeddedWallet onBack={switchWallet}>{signer => <WalletActions {...props} signer={signer} onBack={switchWallet} />}</EmbeddedWallet>
  </Suspense>
  if (standard) return <StandardTrade {...props} wallet={standard} onBack={switchWallet} />
  if (external) return <InjectedTrade {...props} provider={external.provider} name={external.name} onBack={switchWallet} />
  return <View style={st.stack}>
    <View style={st.heading}><Txt v="h2">Trade here</Txt><Txt v="label" color={C.accent}>Solana · direct routes</Txt></View>
    <Txt v="small">Buy or sell through available pools, including supported bonding curves. Connect a trading wallet to see your balance.</Txt>
    <WalletActions {...props} signer={null} />
    <View style={st.wrap}>
      {standardWallets.map(wallet => <Button key={wallet.name} label={`${wallet.name}${preferredTransactionVersion(wallet.features[SolanaSignTransaction].supportedTransactionVersions) === '1' ? ' · V1' : ''}`} kind="ghost" onPress={() => setSelected(`standard:${wallet.name}`)} />)}
      {wallets.filter(wallet => !standardWallets.some(standard => standard.name === wallet.name)).map(wallet => <Button key={wallet.name} label={wallet.name} kind="ghost" onPress={() => setSelected(wallet.name)} />)}
      <Button label="Embedded wallet" onPress={() => setSelected('embedded')} />
    </View>
    <Txt v="small">Your trading wallet is separate from your profile key.</Txt>
  </View>
}

function StandardTrade({ wallet, onBack, ...props }: Props & { wallet: StandardSolanaWallet; onBack: () => void }) {
  const [account, setAccount] = useState<WalletAccount | null>(() => signingAccount(wallet.accounts))
  const [, updateCapabilities] = useState(0)
  useEffect(() => wallet.features[StandardEvents]?.on('change', () => {
    setAccount(signingAccount(wallet.accounts)); updateCapabilities(value => value + 1)
  }), [wallet])
  const signer: SolanaSigner = {
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
  }
  return <View style={st.stack}><Txt v="h2">Trade here · {wallet.name}</Txt><WalletActions {...props} signer={signer} onBack={onBack} /></View>
}

function InjectedTrade({ provider, name, onBack, ...props }: Props & { provider: InjectedWallet; name: string; onBack: () => void }) {
  const [address, setAddress] = useState<string | null>(provider.publicKey?.toBase58() ?? null)
  useEffect(() => {
    const update = () => setAddress(provider.publicKey?.toBase58() ?? null)
    provider.on?.('accountChanged', update)
    provider.on?.('disconnect', update)
    return () => { provider.removeListener?.('accountChanged', update); provider.removeListener?.('disconnect', update) }
  }, [provider])
  const signer: SolanaSigner = {
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
  }
  return <View style={st.stack}><Txt v="h2">Trade here · {name}</Txt><WalletActions {...props} signer={signer} onBack={onBack} /></View>
}

function WalletActions(props: Props & { signer: SolanaSigner | null; onBack?: () => void }) {
  const [mode, setMode] = useState<'swap' | 'liquidity'>(() => props.initialAction ? 'liquidity' : 'swap')
  const [exitRequest, setExitRequest] = useState(props.initialAction === 'exit')
  const [locked, setLocked] = useState(false)
  useEffect(() => {
    const restore = setTimeout(() => {
      if (localStorage.getItem('liquidityxyz.solana.liquidity-batch.v1')) setMode('liquidity')
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
    {mode === 'swap' ? <TradeForm {...props} onLockChange={setLocked} /> : <SolanaLiquidity {...props} exitRequest={exitRequest} onLockChange={setLocked} />}
  </View>
}

function TradeForm({ t, pools, signer, onBack, onLockChange }: Props & { signer: SolanaSigner | null; onBack?: () => void; onLockChange: (locked: boolean) => void }) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
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
    try {
      if (value.state === 'pending') localStorage.setItem(PENDING_KEY, JSON.stringify(value))
      else localStorage.removeItem(PENDING_KEY)
    } catch {
      if (value.state === 'pending') throw new Error('Could not save transaction recovery state. Nothing was submitted. Enable local storage and try again.')
    }
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
    if (localStorage.getItem(PENDING_KEY)) throw new Error('Resolve the pending wallet transaction before starting another trade.')
    const selected = currentSigner.current
    if (!selected?.address || !quote || !isQuoteFresh(quote.at) || quote.wallet !== selected.address) throw new Error('Connect your wallet and request a fresh quote.')
    const owner = selected.address
    const request = seq.current
    setPhase('Requoting and simulating…')
    if (selected.transactionVersion === null) throw new Error('This wallet does not advertise V0 or V1 transaction signing. Choose a compatible wallet.')
    const built = await buildAndSimulate(quote.response, owner, selected.transactionVersion)
    if (!mounted.current || request !== seq.current || currentSigner.current?.address !== owner || !isQuoteFresh(quote.at)) throw new Error('The quote or wallet changed. Request a fresh quote.')
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
      <View style={st.wrap}>{[10, 25, 50, 100].map(percent => <Button key={percent} kind="quiet" label={`${percent}%`} disabled={locked || balance === null || decimals[inputMint] === undefined} onPress={() => {
        if (balance !== null) editAmount(fromAtomic(balancePercent(balance, percent, inputMint === SOL_MINT), decimals[inputMint]))
      }} style={{ flex: 1 }} />)}</View>
      {inputMint === SOL_MINT && address ? <Txt v="monoSmall">Shortcuts leave 0.01 SOL for network fees and account rent.</Txt> : null}
    </View>
    <View style={st.heading}><Txt v="small">Slippage tolerance</Txt><View style={st.wrap}>{[50, 100, 300].map(bps => <Chip key={bps} label={`${bps / 100}%`} active={slippageBps === bps} onPress={() => { if (!locked) { setSlippageBps(bps); editAmount(amount) } }} />)}</View></View>
    {quote ? <View style={st.quote}>
      <View style={st.heading}><Txt v="label">You receive · estimated</Txt><Txt v="monoSmall" color={fresh ? C.accent : C.warn}>{fresh ? `${Math.max(0, 30 - Math.floor((now - quote.at) / 1000))}s to refresh` : 'Refresh quote'}</Txt></View>
      <Txt v="h1">{fromAtomic(quote.response.outAmount, decimals[outputMint])} {label(outputMint)}</Txt>
      <Txt v="small">Minimum received: {fromAtomic(quote.response.otherAmountThreshold, decimals[outputMint])} {label(outputMint)}</Txt>
      <Txt v="small">Price impact: {quote.response.priceImpactPct === null || !Number.isFinite(Number(quote.response.priceImpactPct)) ? 'unavailable' : `${Number(quote.response.priceImpactPct).toFixed(2)}%`}</Txt>
      {quote.response.platformFee ? <Txt v="small">Platform fee: {quote.response.platformFee.feeBps / 100}%</Txt> : null}
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
      {address ? <Button label={side === 'buy' ? 'Review & buy' : 'Review & sell'} disabled={locked || !fresh || signer?.transactionVersion === null} onPress={() => void act(trade)} style={{ flex: 1 }} /> : null}
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
