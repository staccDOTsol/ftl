import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Linking, StyleSheet, TextInput, View } from 'react-native'
import bs58 from 'bs58'
import { C, F } from '@/theme'
import type { FlowEvent, PoolSummary, TokenSummary } from '@/lib/types'
import { assertSignedMessage, decodeTransaction, mintDecimals, sendSignedSwap, tokenBalance, transactionStatus } from '@/lib/solana'
import { balancePercent, fromAtomic, shortMint, SOL_MINT, toAtomic } from '@/lib/solana-trade'
import { inspectTransaction } from '@/lib/solana-wire'
import { assertApprovedLiquidity, assertLiquidityQuote, assertLiquidityTransactionIntent, liquidityBuild, liquidityCapabilities, liquidityPositions, liquidityQuote, simulateLiquidity, type LiquidityBuild, type LiquidityOperation, type LiquidityParameter, type LiquidityPosition, type LiquidityQuote, type LiquidityTransaction, type LiquidityVenue } from '@/lib/solana-liquidity'
import type { SolanaSigner } from './SolanaTrade.web'
import { Button, Chip, Seg, Txt } from './ui'

type Props = { t: TokenSummary; pools: PoolSummary[]; signer: SolanaSigner | null; onBack?: () => void; onLockChange: (locked: boolean) => void; origin?: FlowEvent | null; initialAction?: 'exit' | 'liquidity'; exitRequest?: boolean }
type Batch = { build: LiquidityBuild; owner: string; version: '1' | '0'; next: number; confirmed: string[]; pending?: { signature: string; lastValidBlockHeight: number } }
const BATCH_KEY = 'liquidityxyz.solana.liquidity-batch.v1'
const PENDING_KEY = 'liquidityxyz.solana.pending.v1'
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Liquidity request failed. Try again.'
const title = (operation: LiquidityOperation) => operation === 'initialize' ? 'Initialize pool' : operation === 'add' ? 'Add liquidity' : 'Remove liquidity'
const venueName = (id: string) => id.replaceAll('-', ' ')
const routingVenue = (id: string) => id === 'raydium-amm' ? 'raydium-amm-v4' : id
function readBatch(): Batch | null {
  try {
    const value = JSON.parse(localStorage.getItem(BATCH_KEY) || 'null')
    return value && typeof value.owner === 'string' && ['1', '0'].includes(value.version) && Array.isArray(value.build?.transactions) && value.build.transactions.length <= 12 && Number.isInteger(value.next) && value.next >= 0 && value.next <= value.build.transactions.length && Array.isArray(value.confirmed) ? value : null
  } catch { return null }
}

export default function SolanaLiquidity({ t, pools, signer, onBack, onLockChange, origin, exitRequest }: Props) {
  const [venues, setVenues] = useState<LiquidityVenue[]>([])
  const [loaded, setLoaded] = useState(false)
  const [venue, setVenue] = useState('')
  const [operation, setOperation] = useState<LiquidityOperation>(exitRequest ? 'remove' : 'add')
  const [pool, setPool] = useState('')
  const [mintA, setMintA] = useState(t.address)
  const [mintB, setMintB] = useState(SOL_MINT)
  const [amountA, setAmountA] = useState('')
  const [amountB, setAmountB] = useState('')
  const [liquidity, setLiquidity] = useState('')
  const [positions, setPositions] = useState<{ owner: string; rows: LiquidityPosition[]; errors: { venue: string; error: string }[] } | null>(null)
  const [positionError, setPositionError] = useState<{ owner: string; message: string } | null>(null)
  const [positionId, setPositionId] = useState('')
  const [parameters, setParameters] = useState<Record<string, string>>({})
  const [slippageBps, setSlippageBps] = useState(100)
  const [tokens, setTokens] = useState<Record<string, { decimals: number; raw: string | null; owner: string | null; nativeSol: boolean }>>({})
  const [quoteState, setQuote] = useState<{ quote: LiquidityQuote; key: string } | null>(null)
  const [batch, setBatch] = useState<Batch | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ pool: string; position?: string; signatures: string[]; operation: LiquidityOperation } | null>(null)
  const owner = signer?.address ?? null
  const version = signer?.transactionVersion ?? null
  const current = useRef({ signer, key: '' })
  const mounted = useRef(true)
  const acting = useRef(false)
  const appliedOrigin = useRef('')
  const selectedVenue = venues.find(item => item.id === venue)
  const walletPositions = positions?.owner === owner ? positions.rows : []
  const selectedPosition = walletPositions.find(item => item.position === positionId && item.pool === pool && item.venue === venue)
  const knownPools = useMemo(() => pools.filter(item => routingVenue(item.venue) === venue), [pools, venue])
  const schema = selectedVenue?.parameters?.[operation] ?? []
  const wrapField = schema.find(field => field.name === 'wrapSol')
  const nativeSol = !wrapField || (parameters.wrapSol ?? String(wrapField.default ?? false)) === 'true'
  const percentageRemoval = selectedPosition?.removalMode === 'percentage' || schema.some(field => field.name === 'removeBps')
  const removeBps = parameters.removeBps ?? String(schema.find(field => field.name === 'removeBps')?.default ?? '')
  const key = JSON.stringify({ owner, version, venue, operation, pool, mintA, mintB, amountA, amountB, liquidity, positionId, parameters, slippageBps })
  const quote = quoteState?.key === key ? quoteState.quote : null
  const locked = busy || !!batch
  const canOperate = !!selectedVenue?.capabilities.includes(operation)
  useEffect(() => { current.current = { signer, key } }, [signer, key])
  useEffect(() => { onLockChange(locked); return () => onLockChange(false) }, [locked, onLockChange])
  useEffect(() => {
    mounted.current = true
    const timer = setInterval(() => setNow(Date.now()), 1000)
    const restore = setTimeout(() => setBatch(readBatch()), 0)
    return () => { mounted.current = false; clearInterval(timer); clearTimeout(restore) }
  }, [])
  useEffect(() => {
    const contextKey = `${origin?.id}:${exitRequest}`
    if (!origin || !loaded || appliedOrigin.current === contextKey || locked) return
    const timer = setTimeout(() => {
      appliedOrigin.current = contextKey; setVenue(routingVenue(origin.venue)); setPool(origin.pool ?? ''); setPositionId(''); setParameters({})
      if (origin.token) setMintA(origin.token)
      if (origin.quote) setMintB(origin.quote)
      setOperation(exitRequest ? 'remove' : 'add')
    }, 0)
    return () => clearTimeout(timer)
  }, [origin, exitRequest, loaded, locked])
  useEffect(() => {
    let alive = true
    void liquidityCapabilities().then(response => { if (alive) { setVenues(response.venues); setLoaded(true); setVenue(response.venues.find(item => item.capabilities.length)?.id ?? '') } }).catch(error => { if (alive) { setError(errorMessage(error)); setLoaded(true) } })
    return () => { alive = false }
  }, [])
  const refreshPositions = useCallback(async () => {
    if (!owner) return
    try {
      const response = await liquidityPositions(owner)
      if (mounted.current && current.current.signer?.address === owner) { setPositions({ owner, rows: response.positions, errors: response.errors ?? [] }); setPositionError(null) }
    } catch (error) {
      if (mounted.current && current.current.signer?.address === owner) setPositionError({ owner, message: errorMessage(error) })
      throw error
    }
  }, [owner])
  useEffect(() => { void refreshPositions().catch(error => { if (mounted.current) setError(errorMessage(error)) }) }, [refreshPositions])
  useEffect(() => {
    let alive = true
    void Promise.all([...new Set([mintA, mintB])].filter(Boolean).map(async mint => {
      const decimals = await mintDecimals(mint)
      const raw = owner ? await tokenBalance(owner, mint, nativeSol) : null
      return [mint, { decimals, raw, owner, nativeSol }] as const
    })).then(entries => { if (alive) setTokens(Object.fromEntries(entries)) }).catch(error => { if (alive) setError(errorMessage(error)) })
    return () => { alive = false }
  }, [mintA, mintB, owner, result, nativeSol])

  function chooseVenue(value: string) { setVenue(value); setPool(''); setPositionId(''); setParameters({}); setQuote(null); setError('') }
  function choosePool(value: string) {
    setPool(value); setPositionId(''); setQuote(null); setError('')
    const known = pools.find(item => item.address === value)
    if (known?.token) setMintA(known.token)
    if (known?.quote) setMintB(known.quote)
  }
  function choosePosition(value: LiquidityPosition) {
    setVenue(value.venue); setPositionId(value.position); setPool(value.pool); setMintA(value.mintA); setMintB(value.mintB); setLiquidity(''); setQuote(null)
  }
  async function act(fn: () => Promise<void>) {
    if (acting.current) return
    acting.current = true; setBusy(true); setError('')
    try { await fn() } catch (error) { if (mounted.current) setError(errorMessage(error)) }
    finally { acting.current = false; if (mounted.current) { setBusy(false); setPhase('') } }
  }
  function persist(value: Batch | null) {
    // Refuse to submit if recovery state cannot be saved before a network send.
    if (value) localStorage.setItem(BATCH_KEY, JSON.stringify(value)); else localStorage.removeItem(BATCH_KEY)
    if (value?.pending) localStorage.setItem(PENDING_KEY, JSON.stringify({ ...value.pending, state: 'pending' }))
    else localStorage.removeItem(PENDING_KEY)
    if (mounted.current) setBatch(value)
  }
  function parameterValues() {
    const values: Record<string, string | number | boolean> = {}
    for (const field of schema) {
      const value = parameters[field.name] ?? (field.default === undefined ? '' : String(field.default))
      if (!value && field.required) throw new Error(`Enter ${field.label}.`)
      if (!value) continue
      if (['number', 'integer'].includes(field.type)) {
        const number = Number(value)
        if (!Number.isFinite(number) || (field.type === 'integer' && !Number.isSafeInteger(number)) || (field.min !== undefined && number < field.min) || (field.max !== undefined && number > field.max)) throw new Error(`Enter a valid ${field.label}${field.min !== undefined || field.max !== undefined ? ` (${field.min ?? 'no minimum'} to ${field.max ?? 'no maximum'})` : ''}.`)
        values[field.name] = number
      } else if (field.type === 'boolean') values[field.name] = value === 'true'
      else values[field.name] = value
    }
    return values
  }
  async function requestQuote() {
    if (!owner || !version || !canOperate) throw new Error('Connect a supported wallet and choose an available operation.')
    if (operation !== 'initialize' && !pool) throw new Error('Choose a pool first.')
    const intent = { venue, operation, owner, ...(operation !== 'initialize' ? { pool } : {}), mintA, mintB,
      ...(positionId ? { position: positionId } : {}), slippageBps, parameters: parameterValues(), transactionVersion: version }
    if (operation === 'remove') {
      if (!selectedPosition) throw new Error('Choose one of your positions before removing liquidity.')
      if (percentageRemoval) {
        if (!/^\d+$/.test(removeBps) || Number(removeBps) < 1 || Number(removeBps) > 10000) throw new Error('Choose the share of your position to withdraw.')
      } else if (!selectedPosition.liquidity || !/^[0-9]+$/.test(liquidity) || BigInt(liquidity) <= 0n || BigInt(liquidity) > BigInt(selectedPosition.liquidity)) throw new Error('Choose an amount within your position liquidity.')
    }
    const raw = (value: string, mint: string) => {
      if (!value.trim() || Number(value) === 0) return '0'
      if (!tokens[mint] || (mint === SOL_MINT && tokens[mint].nativeSol !== nativeSol)) throw new Error('Waiting for token decimals and balances. Try again shortly.')
      const amount = toAtomic(value, tokens[mint].decimals)
      if (tokens[mint].owner === owner && tokens[mint].raw !== null && BigInt(amount) > BigInt(tokens[mint].raw!)) throw new Error(`Amount exceeds the ${shortMint(mint)} balance.`)
      return amount
    }
    setPhase('Quoting liquidity…'); setQuote(null)
    const response = await liquidityQuote({ ...intent, ...(operation === 'remove' ? (percentageRemoval ? { parameters: { ...intent.parameters, removeBps: Number(removeBps) } } : { liquidity }) : { amountA: raw(amountA, mintA), amountB: raw(amountB, mintB) }) })
    assertLiquidityQuote(response, intent)
    if (mounted.current && current.current.key === key) setQuote({ quote: response, key })
  }
  async function settle(value: Batch) {
    if (!value.pending) return value
    const state = await transactionStatus(value.pending.signature, value.pending.lastValidBlockHeight)
    if (state === 'pending') { setPhase('Awaiting on-chain confirmation. Check again before continuing.'); return null }
    if (state !== 'confirmed') { persist(null); await refreshPositions(); throw new Error(`Transaction ${state}. ${value.confirmed.length} earlier transaction(s) confirmed. Refresh your positions before another operation.`) }
    const next = { ...value, next: value.next + 1, confirmed: [...value.confirmed, value.pending.signature], pending: undefined }
    persist(next); return next
  }
  async function execute(initial: Batch) {
    let value: Batch | null = await settle(initial)
    if (!value) return
    while (value.next < value.build.transactions.length) {
      const wallet = current.current.signer
      if (!mounted.current || !wallet?.address || wallet.address !== value.owner || wallet.transactionVersion !== value.version) throw new Error('Reconnect the same wallet to continue this liquidity operation.')
      const transaction: LiquidityTransaction = value.build.transactions[value.next]
      setPhase(`Simulating transaction ${value.next + 1} of ${value.build.transactions.length}…`)
      const fee = await simulateLiquidity(transaction, value.owner, value.version)
      if (!mounted.current || current.current.signer?.address !== value.owner) throw new Error('Wallet changed. Nothing was sent.')
      setPhase(`Approve ${value.next + 1}/${value.build.transactions.length} · network fee ${fromAtomic(String(fee), 9)} SOL`)
      const signed = await wallet.sign(decodeTransaction(transaction.transaction))
      assertSignedMessage(transaction.transaction, signed)
      if (!mounted.current || current.current.signer?.address !== value.owner) throw new Error('Wallet changed. Nothing was sent.')
      const signature = bs58.encode(inspectTransaction(signed).signatures[0])
      value = { ...value, pending: { signature, lastValidBlockHeight: transaction.lastValidBlockHeight } }
      persist(value)
      setPhase(`Submitting transaction ${value.next + 1}…`)
      try { const sent = await sendSignedSwap(signed, transaction.lastValidBlockHeight); if (sent !== signature) throw new Error('Unexpected transaction signature.') }
      catch (error) { setError(`Submission needs a status check: ${errorMessage(error)} Do not repeat this operation.`); return }
      for (let i = 0; i < 20 && mounted.current; i++) {
        const settled = await settle(value)
        if (settled) { value = settled; break }
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
      if (value.pending || !mounted.current) return
    }
    persist(null); setQuote(null); setPool(value.build.pool); setResult({ pool: value.build.pool, position: value.build.position, signatures: value.confirmed, operation: value.build.quote.operation }); await refreshPositions()
  }
  async function start() {
    if (localStorage.getItem(PENDING_KEY)) throw new Error('Resolve the pending wallet transaction before starting another operation.')
    if (!quote || !owner || !version || current.current.key !== key) throw new Error('Request a fresh liquidity quote.')
    assertLiquidityQuote(quote, { venue, operation, ...(operation !== 'initialize' ? { pool } : {}), ...(positionId ? { position: positionId } : {}) })
    setPhase('Building approved liquidity instructions…')
    const built = await liquidityBuild(quote.quoteId, owner, version)
    assertApprovedLiquidity(quote, built)
    built.transactions.forEach(transaction => assertLiquidityTransactionIntent(transaction, owner, version))
    if (!mounted.current || current.current.key !== key) throw new Error('Wallet or form changed. Request a fresh quote.')
    const value = { build: built, owner, version, next: 0, confirmed: [] }
    persist(value)
  }
  function amountField(mint: string, amount: string, change: (value: string) => void) {
    const token = tokens[mint], balance = token?.owner === owner && (mint !== SOL_MINT || token.nativeSol === nativeSol) ? token.raw : null
    return <View style={st.box}>
      <View style={st.row}><Txt v="monoSmall">{mint === SOL_MINT ? nativeSol ? 'SOL' : 'WSOL' : mint === t.address ? t.symbol || shortMint(mint) : shortMint(mint)}</Txt><Txt v="small">{balance !== null && token ? `Balance ${fromAtomic(balance, token.decimals)}` : owner ? 'Loading balance…' : 'Connect to see balance'}</Txt></View>
      <TextInput accessibilityLabel={`Liquidity amount ${mint === mintA ? 'A' : 'B'}`} value={amount} onChangeText={change} keyboardType="decimal-pad" editable={!locked} placeholder="0.00" placeholderTextColor={C.faint} style={st.amount} />
      <View style={st.row}>{[10, 25, 50, 100].map(percent => <Button key={percent} label={`${percent}%`} kind="quiet" disabled={locked || balance === null || !token} onPress={() => change(fromAtomic(balancePercent(balance!, percent, mint === SOL_MINT && nativeSol), token.decimals))} style={{ flex: 1 }} />)}</View>
      {mint === SOL_MINT ? <Txt v="monoSmall">{nativeSol ? 'Native SOL. Shortcuts reserve 0.01 SOL for fees and rent.' : 'Wrapped SOL token balance. Enable native SOL below to wrap during this operation.'}</Txt> : null}
    </View>
  }
  return <View style={st.stack}>
    <Txt v="h2">Liquidity</Txt><Txt v="small">Initialize a pool, add funds or withdraw your position. Each step uses the selected wallet.</Txt>
    <Txt v="small">Multi-transaction operations commit one step at a time. You review the full sequence before signing; later steps cannot undo earlier confirmations.</Txt>
    {!loaded ? <Txt v="small">Loading venue capabilities…</Txt> : null}
    {['meteora-dbc', 'raydium-launchlab', 'pumpfun'].includes(venue) ? <Txt v="small">This is a launch curve. Use Swap to trade it; its protocol manages launch and migration. Choose an AMM below to initialize an independent liquidity pool.</Txt> : null}
    <View style={st.row}>{venues.map(item => <Chip key={item.id} label={venueName(item.id)} active={item.id === venue} onPress={() => { if (!locked) chooseVenue(item.id) }} />)}</View>
    {selectedVenue?.note || selectedVenue?.reason ? <Txt v="small">{selectedVenue.note || selectedVenue.reason}</Txt> : null}
    {!selectedVenue ? <Txt v="small">Choose an available venue after its capabilities load.</Txt> : !selectedVenue.capabilities.length ? <Txt v="small">This venue has no direct LP operations. Pre-bond launch curves use their protocol’s launch and migration flow.</Txt> : <>
      <Seg value={operation} options={(['initialize', 'add', 'remove'] as const).map(value => ({ value, label: value === 'initialize' ? 'New pool' : value === 'add' ? 'Add' : 'Remove' }))} onChange={value => { if (!locked) { setOperation(value); setParameters({}); setError('') } }} />
      {!canOperate && selectedVenue ? <Txt v="small">{title(operation)} is unavailable for this venue.</Txt> : null}
      {operation !== 'initialize' ? <>
        <Txt v="label">Pool</Txt><View style={st.row}>{knownPools.map(item => <Chip key={item.address} label={shortMint(item.address)} active={pool === item.address} onPress={() => { if (!locked) choosePool(item.address) }} />)}</View>
        <TextInput accessibilityLabel="Liquidity pool address" value={pool} onChangeText={choosePool} editable={!locked} placeholder="Pool account address" placeholderTextColor={C.faint} autoCapitalize="none" style={st.input} />
        <View style={st.row}><Txt v="label">Your positions</Txt><Button label="Refresh positions" kind="quiet" disabled={busy || !owner} onPress={() => void act(refreshPositions)} /></View>
        {positions?.owner === owner && positions?.errors.some(item => item.venue === venue) ? <Txt v="small" color={C.warn}>This venue could not return all positions. Refresh before treating an empty result as no position.</Txt> : null}
        {!owner ? <Txt v="small">Connect your wallet to load positions.</Txt> : positions?.owner !== owner ? <Txt v="small">{positionError?.owner === owner ? 'Positions unavailable. Refresh to try again.' : 'Loading your positions…'}</Txt> : walletPositions.filter(item => item.venue === venue && (!pool || item.pool === pool)).length === 0 ? <Txt v="small">No positions returned for this wallet and pool.</Txt> : walletPositions.filter(item => item.venue === venue && (!pool || item.pool === pool)).map(item => <Button key={item.position} kind={positionId === item.position ? 'primary' : 'ghost'} label={`${shortMint(item.position)}${item.removalMode === 'percentage' ? ' · bin position' : ` · ${item.liquidity ?? '—'} liquidity units`}`} disabled={locked} onPress={() => choosePosition(item)} />)}
      </> : null}
      {operation !== 'remove' ? <>
        <Txt v="label">Token mints</Txt>
        <TextInput accessibilityLabel="Liquidity mint A" value={mintA} onChangeText={setMintA} editable={!locked} autoCapitalize="none" style={st.input} />
        <TextInput accessibilityLabel="Liquidity mint B" value={mintB} onChangeText={setMintB} editable={!locked} autoCapitalize="none" style={st.input} />
        {amountField(mintA, amountA, setAmountA)}{amountField(mintB, amountB, setAmountB)}
        {operation === 'initialize' ? <View style={st.box}><Txt v="label">Seed ratio · token B per token A</Txt><Txt v="monoSmall" selectable>A: {mintA}</Txt><Txt v="monoSmall" selectable>B: {mintB}</Txt><Txt v="small">{Number(amountA) > 0 && Number(amountB) > 0 ? `Entered amount ratio: ${Number(amountB) / Number(amountA)} B per A` : 'This venue may initialize without a deposit. Set its initial price below when required.'}</Txt></View> : null}
      </> : percentageRemoval ? <View style={st.box}><Txt v="label">Share of position to withdraw</Txt><Txt v="h2">{removeBps ? `${Number(removeBps) / 100}%` : 'Choose a share'}</Txt><Txt v="small">Applies to the liquidity across this position’s bin range.</Txt><View style={st.row}>{[10, 25, 50, 100].map(percent => <Button key={percent} kind="quiet" label={`${percent}%`} disabled={locked || !selectedPosition} onPress={() => setParameters(previous => ({ ...previous, removeBps: String(percent * 100) }))} style={{ flex: 1 }} />)}</View></View> : <View style={st.box}><Txt v="label">Position liquidity to withdraw</Txt><Txt v="small">Balance {selectedPosition?.liquidity ?? '—'} liquidity units</Txt><TextInput accessibilityLabel="Liquidity units to remove" value={liquidity} onChangeText={setLiquidity} editable={!locked} keyboardType="number-pad" placeholder="0" placeholderTextColor={C.faint} style={st.amount} /><View style={st.row}>{[10, 25, 50, 100].map(percent => <Button key={percent} kind="quiet" label={`${percent}%`} disabled={locked || !selectedPosition?.liquidity} onPress={() => setLiquidity(balancePercent(selectedPosition!.liquidity!, percent, false).toString())} style={{ flex: 1 }} />)}</View></View>}
      {schema.filter(field => !(percentageRemoval && field.name === 'removeBps')).map(field => <Parameter key={`${operation}:${field.name}`} field={field} value={parameters[field.name] ?? String(field.default ?? '')} disabled={locked} change={value => setParameters(previous => ({ ...previous, [field.name]: value }))} />)}
      <View style={st.row}><Txt v="small">Slippage</Txt>{[50, 100, 300].map(value => <Chip key={value} label={`${value / 100}%`} active={slippageBps === value} onPress={() => { if (!locked) setSlippageBps(value) }} />)}</View>
    </>}
    {quote ? <View style={st.box}>
      <View style={st.row}><Txt v="h2">{title(quote.operation)}</Txt><Txt v="monoSmall" color={quote.expiresAt > now ? C.accent : C.warn}>{quote.expiresAt > now ? `${Math.ceil((quote.expiresAt - now) / 1000)}s remaining` : 'Quote expired'}</Txt></View>
      {quote.operation === 'initialize' ? <Txt v="small">Seed amounts below belong to their displayed mint. Any initial price is token B per token A as entered above; check both sides before approving.</Txt> : null}
      {!quote.amounts.length ? <Txt v="small">This step initializes the pool without a token deposit.</Txt> : null}
      {quote.mintA && quote.mintB ? <View style={st.stack}><Txt v="label">Pool token order</Txt><Txt v="monoSmall" selectable>A: {quote.mintA}</Txt><Txt v="monoSmall" selectable>B: {quote.mintB}</Txt></View> : null}
      {quote.amounts.map((amount, index) => <View key={`${amount.mint}:${index}`} style={st.stack}><Txt v="mono">{amount.direction === 'debit' ? 'Pay' : 'Receive'} {fromAtomic(amount.expectedRaw, amount.decimals)} {shortMint(amount.mint)}</Txt><Txt v="monoSmall" selectable>{amount.mint}</Txt><Txt v="small">{amount.direction === 'debit' ? 'Maximum debit' : 'Minimum received'}: {fromAtomic(amount.limitRaw, amount.decimals)} {shortMint(amount.mint)}</Txt></View>)}
      {quote.warnings?.map(warning => <Txt key={warning} v="small" color={C.warn}>{warning}</Txt>)}
      <Txt v="monoSmall">Network fees and account rent are additional. Each transaction is simulated before wallet approval.</Txt>
    </View> : null}
    {phase ? <Txt v="small" color={C.accent}>{phase}</Txt> : null}{error ? <Txt v="small" color={C.warn}>{error}</Txt> : null}
    {batch ? <View style={st.box}>
      <Txt v="label">{title(batch.build.quote.operation)} · {venueName(batch.build.quote.venue)}</Txt>
      <Txt v="monoSmall" selectable>Pool {batch.build.pool}</Txt>
      {batch.build.quote.amounts.map((amount, index) => <View key={`${amount.mint}:${index}`} style={st.stack}><Txt v="small">{amount.direction === 'debit' ? 'Maximum debit' : 'Minimum received'} {fromAtomic(amount.limitRaw, amount.decimals)} {shortMint(amount.mint)}</Txt><Txt v="monoSmall" selectable>{amount.mint}</Txt></View>)}
      <Txt v="h2">{batch.confirmed.length}/{batch.build.transactions.length} transactions confirmed</Txt>
      {batch.build.transactions.length > 1 ? <Txt v="small" color={C.warn}>This operation is not atomic. Each transaction commits separately; a later failure does not reverse earlier confirmed steps.</Txt> : null}
      <Txt v="small">{batch.pending ? 'Waiting for this transaction before any next step.' : 'Continue the approved operation with the same wallet.'}</Txt>
      {batch.pending ? <Button kind="quiet" label="View pending transaction ↗" onPress={() => void Linking.openURL(`https://solscan.io/tx/${batch.pending!.signature}`)} /> : null}
      <Button label={batch.pending ? 'Check confirmation & continue' : `Review & sign ${batch.next + 1}/${batch.build.transactions.length}`} disabled={busy || owner !== batch.owner} onPress={() => void act(() => execute(batch))} />
      {!batch.pending ? <Button kind="quiet" label="Stop remaining steps" disabled={busy} onPress={() => { persist(null); setQuote(null); void refreshPositions() }} /> : null}
    </View> : <View style={st.row}>
      <Button label="Quote liquidity" disabled={busy || !owner || !version || !canOperate} onPress={() => void act(requestQuote)} style={{ flex: 1 }} />
      {quote ? <Button label="Review & sign" disabled={busy || quote.expiresAt <= now} onPress={() => void act(start)} style={{ flex: 1 }} /> : null}
    </View>}
    {result ? <View style={st.box}><Txt v="h2" color={C.accent}>{result.operation === 'initialize' ? 'Pool initialized' : 'Liquidity confirmed'}</Txt><Txt v="monoSmall" selectable>Pool: {result.pool}</Txt>{result.position ? <Txt v="monoSmall" selectable>Position: {result.position}</Txt> : null}{result.signatures.map((signature, i) => <Button key={signature} kind="quiet" label={`Transaction ${i + 1} ↗`} onPress={() => void Linking.openURL(`https://solscan.io/tx/${signature}`)} />)}{result.operation === 'initialize' ? <Button label="Add liquidity to this pool" disabled={locked} onPress={() => { setPool(result.pool); setOperation('add'); setParameters({}); setQuote(null) }} /> : null}</View> : null}
    <View style={st.box}>
      <View style={st.row}><Txt v="h2">My positions</Txt><Button kind="quiet" label="Refresh" disabled={busy || !owner} onPress={() => void act(refreshPositions)} /></View>
      <Txt v="small">{owner ? `Connected wallet ${shortMint(owner)}` : 'Connect your wallet to check your positions.'}</Txt>
      {positionError?.owner === owner ? <Txt v="small" color={C.warn}>Positions could not refresh: {positionError.message}</Txt> : null}
      {positions?.owner === owner ? positions.errors.map(item => <Txt key={item.venue} v="small" color={C.warn}>{venueName(item.venue)} positions unavailable: {item.error}</Txt>) : null}
      {owner && positions?.owner !== owner && positionError?.owner !== owner ? <Txt v="small">Loading positions…</Txt> : null}
      {walletPositions.filter(position => position.mintA === t.address || position.mintB === t.address || position.pool === result?.pool).map(position => <View key={`${position.venue}:${position.position}`} style={st.stack}><Txt v="monoSmall" selectable>{venueName(position.venue)} · {position.position}</Txt><Txt v="small">{shortMint(position.mintA)} / {shortMint(position.mintB)} · {position.removalMode === 'percentage' ? 'Bin position' : `${position.liquidity ?? '—'} liquidity units`}</Txt><Button kind="ghost" label="Check my exit" disabled={locked} onPress={() => { choosePosition(position); setOperation('remove'); setParameters({}) }} /></View>)}
      {owner && positions?.owner === owner && !walletPositions.some(position => position.mintA === t.address || position.mintB === t.address || position.pool === result?.pool) ? <Txt v="small">No positions for this token were returned for your connected wallet.</Txt> : null}
    </View>
    {signer && !owner ? <Button label="Connect wallet" disabled={busy} onPress={() => void act(signer.connect)} /> : null}
    {owner ? <Txt v="monoSmall">Wallet {shortMint(owner)} · V{version}</Txt> : <Txt v="small">Choose a wallet to quote and manage liquidity.</Txt>}
    {onBack ? <Button kind="quiet" label="Choose another wallet" disabled={locked} onPress={onBack} /> : null}
  </View>
}

function Parameter({ field, value, change, disabled }: { field: LiquidityParameter; value: string; change: (value: string) => void; disabled: boolean }) {
  const options = field.type === 'boolean' ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] : field.options
  return <View style={st.stack}><Txt v="label">{field.label}{field.required ? '' : ' · optional'}</Txt>{options ? <View style={st.row}>{options.map(option => { const item = typeof option === 'string' ? { value: option, label: option } : option; return <Chip key={String(item.value)} label={item.label} active={value === String(item.value)} onPress={() => { if (!disabled) change(String(item.value)) }} /> })}</View> : <TextInput accessibilityLabel={field.label} value={value} onChangeText={change} editable={!disabled} autoCapitalize="none" style={st.input} />}</View>
}
const st = StyleSheet.create({
  stack: { gap: 10 }, row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  box: { gap: 8, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.bg },
  input: { minWidth: 0, height: 44, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: C.line, color: C.text, fontFamily: F.mono, fontSize: 12 },
  amount: { minWidth: 0, height: 48, color: C.text, fontFamily: F.monoBold, fontSize: 22 },
})
