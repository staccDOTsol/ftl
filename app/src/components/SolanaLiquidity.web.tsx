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
import type { TradeAction } from './Trade'
import { Button, Chip, Seg, Txt } from './ui'
import { ShareMove } from './ShareMove.web'
import { PoolCrowd } from './PoolCrowd.web'
import { FollowTradingWallet } from './FollowTradingWallet.web'
import { WrapSol } from './WrapSol.web'
import { PoolYield } from './PoolYield.web'
import type { Move, MoveVenue } from '@/lib/types'
import { useTokenMeta } from '@/lib/token-meta'

const ADVANCED = new Set(['tickLowerIndex', 'tickUpperIndex', 'minBinId', 'maxBinId', 'strategyType', 'configIndex'])
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

// `initialPool` pre-selects one pool (deep link /swap?mode=liquidity&pool=…): a
// known FTL pool also selects its venue and pair; an unknown address is pasted as is.
type Props = { t: TokenSummary; pools: PoolSummary[]; signer: SolanaSigner | null; onBack?: () => void; onLockChange: (locked: boolean) => void; origin?: FlowEvent | null; initialAction?: TradeAction; exitRequest?: boolean; initialPool?: string | null }
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

export default function SolanaLiquidity({ t, pools, signer, onBack, onLockChange, origin, exitRequest, initialPool }: Props) {
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
  const [result, setResult] = useState<{ pool: string; position?: string; signatures: string[]; operation: LiquidityOperation; venue: string; amounts: LiquidityQuote['amounts'] } | null>(null)
  const [showWrap, setShowWrap] = useState(false)
  const [showCrowd, setShowCrowd] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [editMints, setEditMints] = useState(false)
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
  const poolsByVenue = useMemo(() => {
    const counts: Record<string, { total: number; funded: number }> = {}
    for (const item of pools) { const id = routingVenue(item.venue); counts[id] ??= { total: 0, funded: 0 }; counts[id].total++; if (item.funded) counts[id].funded++ }
    return counts
  }, [pools])
  const orderedVenues = useMemo(() => [...venues].sort((a, b) => (poolsByVenue[b.id]?.funded ?? 0) - (poolsByVenue[a.id]?.funded ?? 0) || (poolsByVenue[b.id]?.total ?? 0) - (poolsByVenue[a.id]?.total ?? 0)), [venues, poolsByVenue])
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
    void liquidityCapabilities().then(response => { if (alive) { setVenues(response.venues); setLoaded(true)
      const counts: Record<string, number> = {}
      for (const item of pools) counts[routingVenue(item.venue)] = (counts[routingVenue(item.venue)] ?? 0) + (item.funded ? 2 : 1)
      const linked = initialPool ? pools.find(item => item.address === initialPool) : undefined
      const best = linked && response.venues.some(item => item.id === routingVenue(linked.venue) && item.capabilities.length) ? response.venues.find(item => item.id === routingVenue(linked.venue))
        : response.venues.filter(item => item.capabilities.length).sort((a, b) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0))[0]
      setVenue(best?.id ?? '')
      if (linked) { setPool(linked.address); if (linked.token) setMintA(linked.token); if (linked.quote) setMintB(linked.quote) }
      else if (initialPool) setPool(initialPool)
      else if (best && counts[best.id]) { const first = pools.find(item => routingVenue(item.venue) === best.id && item.funded) ?? pools.find(item => routingVenue(item.venue) === best.id); if (first) { setPool(first.address); if (first.token) setMintA(first.token); if (first.quote) setMintB(first.quote) } } } }).catch(error => { if (alive) { setError(errorMessage(error)); setLoaded(true) } })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    persist(null); setQuote(null); setPool(value.build.pool); setResult({ pool: value.build.pool, position: value.build.position, signatures: value.confirmed, operation: value.build.quote.operation, venue: value.build.quote.venue, amounts: value.build.quote.amounts }); await refreshPositions()
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

  const details = (quote?.details ?? {}) as Record<string, string | number | boolean | null | undefined>
  const basicSchema = schema.filter(field => !ADVANCED.has(field.name) && !(percentageRemoval && field.name === 'removeBps'))
  const advancedSchema = schema.filter(field => ADVANCED.has(field.name))
  const rangeVenue = ['raydium-clmm', 'orca', 'meteora-dlmm'].includes(venue) && operation === 'add'
  const rangeManual = advancedSchema.some(field => (parameters[field.name] ?? '').trim() !== '')
  const venuePositions = walletPositions.filter(item => item.venue === venue && (!pool || item.pool === pool))
  const tokenPositions = walletPositions.filter(position => position.mintA === t.address || position.mintB === t.address || position.pool === result?.pool)
  // Symbols for every mint this card names: the pair, quoted amounts, positions.
  const meta = useTokenMeta([t.address, mintA, mintB, ...(quote?.amounts.map(amount => amount.mint) ?? []), ...(batch?.build.quote.amounts.map(amount => amount.mint) ?? []), ...tokenPositions.flatMap(position => [position.mintA, position.mintB])])
  const label = (mint: string) => mint === SOL_MINT ? (nativeSol ? 'SOL' : 'WSOL') : mint === USDC_MINT ? 'USDC' : mint === t.address ? (t.symbol || meta[mint]?.symbol || shortMint(mint)) : meta[mint]?.symbol || shortMint(mint)
  const tokenName = t.symbol || meta[t.address]?.symbol || 'this token'
  function amountField(mint: string, amount: string, change: (value: string) => void) {
    const token = tokens[mint], balance = token?.owner === owner && (mint !== SOL_MINT || token.nativeSol === nativeSol) ? token.raw : null
    return <View style={st.amountBox}>
      <View style={st.between}>
        <View style={st.inline}><View style={[st.dot, { backgroundColor: mint === t.address ? C.accent : C.violet }]} /><Txt v="h2">{label(mint)}</Txt></View>
        <Txt v="monoSmall">{balance !== null && token ? `Balance ${fromAtomic(balance, token.decimals)}` : owner ? 'Loading balance…' : 'Connect to see balance'}</Txt>
      </View>
      <TextInput accessibilityLabel={`Liquidity amount ${mint === mintA ? 'A' : 'B'}`} value={amount} onChangeText={change} keyboardType="decimal-pad" editable={!locked} placeholder="0.00" placeholderTextColor={C.faint} style={st.amount} />
      <View style={st.row}>{[10, 25, 50, 100].map(percent => <Chip key={percent} label={`${percent}%`} onPress={() => { if (!locked && balance !== null && token) change(fromAtomic(balancePercent(balance, percent, mint === SOL_MINT && nativeSol), token.decimals)) }} />)}
        {mint === SOL_MINT ? <Txt v="monoSmall" style={{ marginLeft: 'auto' }}>{nativeSol ? 'keeps 0.01 SOL for fees' : 'wrapped SOL balance'}</Txt> : null}</View>
    </View>
  }
  const fieldControl = (field: LiquidityParameter) => <Parameter key={`${operation}:${field.name}`} field={field} value={parameters[field.name] ?? String(field.default ?? '')} disabled={locked} change={value => setParameters(previous => ({ ...previous, [field.name]: value }))} />
  return <View style={st.stack}>
    <View style={st.between}>
      <View><Txt v="h2">Liquidity</Txt><Txt v="small">Open a pool, add to it, or pull your position. Every step signs with your wallet.</Txt></View>
      {owner ? <View style={st.pill}><View style={[st.dot, { backgroundColor: C.accent }]} /><Txt v="monoSmall" color={C.text}>{shortMint(owner)} · V{version}</Txt></View> : null}
    </View>
    {owner ? <FollowTradingWallet address={owner} /> : null}
    {!loaded ? <Txt v="small">Loading venues…</Txt> : null}
    {['meteora-dbc', 'raydium-launchlab', 'pumpfun'].includes(venue) ? <Txt v="small">This is a launch curve. Use Swap to trade it; its protocol manages launch and migration. Choose an AMM below to initialize an independent liquidity pool.</Txt> : null}
    <View style={st.section}>
      <View style={st.between}><Txt v="label">Venue</Txt><Txt v="monoSmall">{pools.length ? `${pools.filter(item => item.funded).length} funded of ${pools.length} pools on ${tokenName}` : 'no pools seen yet'}</Txt></View>
      <View style={st.row}>{orderedVenues.map(item => {
        const stats = poolsByVenue[item.id]
        return <Chip key={item.id} label={venueName(item.id)} active={item.id === venue} color={stats?.funded ? C.accent : stats ? C.gold : C.ghost} count={stats?.total} onPress={() => { if (!locked) chooseVenue(item.id) }} />
      })}</View>
      {loaded ? <Txt v="monoSmall">counted venues already hold {tokenName} · mint {tokenName === 'this token' ? 'the token' : tokenName} liquidity anywhere else with New pool</Txt> : null}
      {selectedVenue?.note || selectedVenue?.reason ? <Txt v="small">{selectedVenue.note || selectedVenue.reason}</Txt> : null}
    </View>
    {!selectedVenue ? <Txt v="small">Choose a venue once capabilities load.</Txt> : !selectedVenue.capabilities.length ? <Txt v="small">This venue has no direct LP operations. Pre-bond launch curves use their protocol’s launch and migration flow.</Txt> : <>
      <Seg value={operation} options={(['initialize', 'add', 'remove'] as const).map(value => ({ value, label: value === 'initialize' ? 'New pool' : value === 'add' ? 'Add' : 'Remove' }))} onChange={value => { if (!locked) { setOperation(value); setParameters({}); setError('') } }} />
      {!canOperate && selectedVenue ? <Txt v="small">{title(operation)} is unavailable for this venue.</Txt> : null}
      {operation !== 'initialize' ? <View style={st.section}>
        <View style={st.between}><Txt v="label">Pool</Txt>{knownPools.length ? <Txt v="monoSmall">{knownPools.length} on {venueName(venue)}</Txt> : null}</View>
        {knownPools.length ? <View style={st.row}>{knownPools.map(item => <Chip key={item.address} label={`${shortMint(item.address)}${item.funded ? '' : ' · empty'}`} color={item.funded ? C.accent : C.gold} active={pool === item.address} onPress={() => { if (!locked) choosePool(item.address) }} />)}</View> : <Txt v="small">FTL has not seen a {venueName(venue)} pool for this token. Paste one, or open a new pool.</Txt>}
        <TextInput accessibilityLabel="Liquidity pool address" value={pool} onChangeText={choosePool} editable={!locked} placeholder="Pool account address" placeholderTextColor={C.faint} autoCapitalize="none" style={st.input} />
        {pool ? <PoolYield venue={venue} pool={pool} /> : null}
        {pool ? <><Chip label={showCrowd ? 'Hide who’s in this pool' : 'Who’s in this pool'} active={showCrowd} onPress={() => setShowCrowd(value => !value)} />{showCrowd ? <PoolCrowd pool={pool} chain="solana" /> : null}</> : null}
        {operation === 'remove' ? <>
          <View style={st.between}><Txt v="label">Your positions</Txt><Button label="Refresh" kind="quiet" disabled={busy || !owner} onPress={() => void act(refreshPositions)} /></View>
          {positions?.owner === owner && positions?.errors.some(item => item.venue === venue) ? <Txt v="small" color={C.warn}>This venue could not return all positions. Refresh before treating an empty result as no position.</Txt> : null}
          {!owner ? <Txt v="small">Connect your wallet to load positions.</Txt> : positions?.owner !== owner ? <Txt v="small">{positionError?.owner === owner ? 'Positions unavailable. Refresh to try again.' : 'Loading your positions…'}</Txt> : venuePositions.length === 0 ? <Txt v="small">No positions returned for this wallet and pool.</Txt> : venuePositions.map(item => <Button key={item.position} kind={positionId === item.position ? 'primary' : 'ghost'} label={`${shortMint(item.position)}${item.removalMode === 'percentage' ? ' · bin position' : ` · ${item.liquidity ?? '—'} liquidity units`}`} disabled={locked} onPress={() => choosePosition(item)} />)}
        </> : null}
      </View> : null}
      {operation !== 'remove' ? <View style={st.section}>
        <View style={st.between}>
          <Txt v="label">Pair</Txt>
          <View style={st.row}>
            {[SOL_MINT, USDC_MINT].map(mint => <Chip key={mint} label={`vs ${label(mint)}`} active={mintB === mint} onPress={() => { if (!locked) { setMintB(mint); setQuote(null) } }} />)}
            <Chip label={editMints ? 'Done' : 'Edit mints'} onPress={() => setEditMints(value => !value)} />
          </View>
        </View>
        {editMints ? <>
          <TextInput accessibilityLabel="Liquidity mint A" value={mintA} onChangeText={setMintA} editable={!locked} autoCapitalize="none" style={st.input} />
          <TextInput accessibilityLabel="Liquidity mint B" value={mintB} onChangeText={setMintB} editable={!locked} autoCapitalize="none" style={st.input} />
        </> : <Txt v="monoSmall" selectable>{label(mintA)} {mintA} · {label(mintB)} {mintB}</Txt>}
        {amountField(mintA, amountA, setAmountA)}{amountField(mintB, amountB, setAmountB)}
        {signer && [mintA, mintB].includes(SOL_MINT) ? <><Chip label={showWrap ? 'Hide wrap / unwrap' : 'Wrap or unwrap SOL'} active={showWrap} onPress={() => setShowWrap(value => !value)} />{showWrap ? <WrapSol signer={signer} defaultDirection={nativeSol ? 'unwrap' : 'wrap'} onDone={() => setResult(previous => previous)} /> : null}</> : null}
        {operation === 'initialize' ? <Txt v="small">{Number(amountA) > 0 && Number(amountB) > 0 ? `Seed ratio ${Number(amountB) / Number(amountA)} ${label(mintB)} per ${label(mintA)}` : 'This venue may open without a deposit. Set its initial price below when required.'}</Txt> : null}
        {rangeVenue ? <View style={st.rangeBox}>
          <View style={st.between}><Txt v="label">Range</Txt><Chip label={advanced ? 'Hide ticks' : 'Set ticks'} active={advanced} onPress={() => setAdvanced(value => !value)} /></View>
          <Txt v="small">{rangeManual ? 'Using the ticks you entered.' : `Auto. The range is inferred from your amounts around the live price: more ${label(mintA)} leans above it, more ${label(mintB)} leans below.`}</Txt>
          {advanced ? advancedSchema.map(fieldControl) : null}
        </View> : advancedSchema.length ? <><Chip label={advanced ? 'Hide advanced' : 'Advanced'} active={advanced} onPress={() => setAdvanced(value => !value)} />{advanced ? advancedSchema.map(fieldControl) : null}</> : null}
      </View> : percentageRemoval ? <View style={st.section}><Txt v="label">Share to withdraw</Txt><Txt v="h1">{removeBps ? `${Number(removeBps) / 100}%` : 'Choose a share'}</Txt><Txt v="small">Applies across this position’s bin range.</Txt><View style={st.row}>{[10, 25, 50, 100].map(percent => <Chip key={percent} label={`${percent}%`} active={removeBps === String(percent * 100)} onPress={() => { if (!locked && selectedPosition) setParameters(previous => ({ ...previous, removeBps: String(percent * 100) })) }} />)}</View></View> : <View style={st.section}><Txt v="label">Liquidity to withdraw</Txt><Txt v="monoSmall">Position holds {selectedPosition?.liquidity ?? '—'} liquidity units</Txt><TextInput accessibilityLabel="Liquidity units to remove" value={liquidity} onChangeText={setLiquidity} editable={!locked} keyboardType="number-pad" placeholder="0" placeholderTextColor={C.faint} style={st.amount} /><View style={st.row}>{[10, 25, 50, 100].map(percent => <Chip key={percent} label={`${percent}%`} onPress={() => { if (!locked && selectedPosition?.liquidity) setLiquidity(balancePercent(selectedPosition.liquidity, percent, false).toString()) }} />)}</View></View>}
      {basicSchema.length ? <View style={st.row}>{basicSchema.map(fieldControl)}</View> : null}
      <View style={st.between}><Txt v="label">Slippage</Txt><View style={st.row}>{[50, 100, 300].map(value => <Chip key={value} label={`${value / 100}%`} active={slippageBps === value} onPress={() => { if (!locked) setSlippageBps(value) }} />)}</View></View>
    </>}
    {quote ? <View style={st.quote}>
      <View style={st.between}><Txt v="h2">{title(quote.operation)} · {venueName(quote.venue)}</Txt><Txt v="monoSmall" color={quote.expiresAt > now ? C.accent : C.warn}>{quote.expiresAt > now ? `${Math.ceil((quote.expiresAt - now) / 1000)}s` : 'expired'}</Txt></View>
      {quote.operation === 'initialize' ? <Txt v="small">Seed amounts belong to their displayed mint. Initial price is {label(mintB)} per {label(mintA)} as entered; check both sides before approving.</Txt> : null}
      {!quote.amounts.length ? <Txt v="small">This step opens the pool without a token deposit.</Txt> : null}
      {quote.amounts.map((amount, index) => <View key={`${amount.mint}:${index}`} style={st.between}>
        <View><Txt v="label">{amount.direction === 'debit' ? 'You pay' : 'You receive'}</Txt><Txt v="h1">{fromAtomic(amount.expectedRaw, amount.decimals)} {label(amount.mint)}</Txt></View>
        <View style={{ alignItems: 'flex-end' }}><Txt v="monoSmall">{amount.direction === 'debit' ? 'max' : 'min'} {fromAtomic(amount.limitRaw, amount.decimals)}</Txt><Txt v="monoSmall" selectable>{shortMint(amount.mint)}</Txt></View>
      </View>)}
      {details.priceLower !== undefined && details.priceUpper !== undefined ? <View style={st.rangeBox}>
        <View style={st.between}><Txt v="label">Range{details.inferredRange ? ' · auto' : ''}</Txt><Txt v="monoSmall">{label(quote.mintB ?? mintB)} per {label(quote.mintA ?? mintA)}</Txt></View>
        <View style={st.between}><Txt v="num">{String(details.priceLower)}</Txt><Txt v="monoSmall" color={C.accent}>now {String(details.priceCurrent ?? '—')}</Txt><Txt v="num">{String(details.priceUpper)}</Txt></View>
        <Txt v="monoSmall">{details.tickLowerIndex !== undefined ? `ticks ${String(details.tickLowerIndex)} → ${String(details.tickUpperIndex)}` : details.minBinId !== undefined ? `bins ${String(details.minBinId)} → ${String(details.maxBinId)}` : ''}</Txt>
      </View> : null}
      {quote.mintA && quote.mintB ? <Txt v="monoSmall" selectable>Pool order A {shortMint(quote.mintA)} · B {shortMint(quote.mintB)}</Txt> : null}
      {quote.warnings?.map(warning => <Txt key={warning} v="small" color={C.warn}>{warning}</Txt>)}
      <Txt v="monoSmall">Network fees and rent are extra. Each transaction is simulated before your wallet is asked.</Txt>
    </View> : null}
    {phase ? <Txt v="small" color={C.accent}>{phase}</Txt> : null}{error ? <Txt v="small" color={C.warn}>{error}</Txt> : null}
    {batch ? <View style={st.quote}>
      <Txt v="label">{title(batch.build.quote.operation)} · {venueName(batch.build.quote.venue)}</Txt>
      <Txt v="monoSmall" selectable>Pool {batch.build.pool}</Txt>
      {batch.build.quote.amounts.map((amount, index) => <Txt key={`${amount.mint}:${index}`} v="small">{amount.direction === 'debit' ? 'Max debit' : 'Min received'} {fromAtomic(amount.limitRaw, amount.decimals)} {label(amount.mint)}</Txt>)}
      <Txt v="h2">{batch.confirmed.length}/{batch.build.transactions.length} transactions confirmed</Txt>
      {batch.build.transactions.length > 1 ? <Txt v="small" color={C.warn}>Not atomic. Each transaction commits separately; a later failure does not reverse earlier confirmed steps.</Txt> : null}
      <Txt v="small">{batch.pending ? 'Waiting for this transaction before any next step.' : 'Continue the approved operation with the same wallet.'}</Txt>
      {batch.pending ? <Button kind="quiet" label="View pending transaction ↗" onPress={() => void Linking.openURL(`https://solscan.io/tx/${batch.pending!.signature}`)} /> : null}
      <Button label={batch.pending ? 'Check confirmation & continue' : `Review & sign ${batch.next + 1}/${batch.build.transactions.length}`} disabled={busy || owner !== batch.owner} onPress={() => void act(() => execute(batch))} />
      {!batch.pending ? <Button kind="quiet" label="Stop remaining steps" disabled={busy} onPress={() => { persist(null); setQuote(null); void refreshPositions() }} /> : null}
    </View> : <View style={st.row}>
      {signer && !owner ? <Button label="Connect wallet" disabled={busy} onPress={() => void act(signer.connect)} style={{ flex: 1 }} /> : null}
      <Button kind={quote ? 'ghost' : 'primary'} label={quote ? 'Requote' : 'Quote liquidity'} disabled={busy || !owner || !version || !canOperate} onPress={() => void act(requestQuote)} style={{ flex: 1 }} />
      {quote ? <Button label="Review & sign" disabled={busy || quote.expiresAt <= now} onPress={() => void act(start)} style={{ flex: 1 }} /> : null}
    </View>}
    {result ? <View style={[st.quote, { borderColor: C.accent + '66' }]}><Txt v="h2" color={C.accent}>{result.operation === 'initialize' ? 'Pool opened' : result.operation === 'remove' ? 'Liquidity withdrawn' : 'Liquidity added'}</Txt><Txt v="monoSmall" selectable>Pool {result.pool}</Txt>{result.position ? <Txt v="monoSmall" selectable>Position {result.position}</Txt> : null}<View style={st.row}>{result.signatures.map((signature, i) => <Chip key={signature} label={`Transaction ${i + 1} ↗`} color={C.accent} active onPress={() => void Linking.openURL(`https://solscan.io/tx/${signature}`)} />)}</View>{result.operation === 'initialize' ? <Button label="Add liquidity to this pool" disabled={locked} onPress={() => { setPool(result.pool); setOperation('add'); setParameters({}); setQuote(null) }} /> : null}
      {result.signatures.length ? <ShareMove chain="solana" token={t.address} symbol={t.symbol || meta[t.address]?.symbol || undefined} graduated={!!t.graduatedTs} tx={result.signatures[result.signatures.length - 1]} move={{ venue: result.venue as MoveVenue, operation: result.operation, pool: result.pool, amounts: result.amounts.slice(0, 4).map(amount => ({ mint: amount.mint, amount: fromAtomic(amount.expectedRaw, amount.decimals), symbol: label(amount.mint) })) } satisfies Move} /> : null}</View> : null}
    <View style={st.section}>
      <View style={st.between}><Txt v="label">My positions on {tokenName}</Txt><Button kind="quiet" label="Refresh" disabled={busy || !owner} onPress={() => void act(refreshPositions)} /></View>
      {!owner ? <Txt v="small">Connect your wallet to check your positions.</Txt> : null}
      {positionError?.owner === owner ? <Txt v="small" color={C.warn}>Positions could not refresh: {positionError.message}</Txt> : null}
      {positions?.owner === owner ? positions.errors.map(item => <Txt key={item.venue} v="monoSmall">{venueName(item.venue)}: {item.error}</Txt>) : null}
      {owner && positions?.owner !== owner && positionError?.owner !== owner ? <Txt v="small">Loading positions…</Txt> : null}
      {tokenPositions.map(position => <View key={`${position.venue}:${position.position}`} style={st.between}>
        <View style={{ gap: 4 }}><Txt v="h2">{venueName(position.venue)}</Txt><Txt v="monoSmall" selectable>{shortMint(position.position)} · {label(position.mintA)} / {label(position.mintB)} · {position.removalMode === 'percentage' ? 'bin position' : `${position.liquidity ?? '—'} units`}</Txt><PoolYield venue={position.venue} pool={position.pool} /></View>
        <Button kind="ghost" label="Exit" disabled={locked} onPress={() => { choosePosition(position); setOperation('remove'); setParameters({}) }} />
      </View>)}
      {owner && positions?.owner === owner && !tokenPositions.length ? <Txt v="small">No positions on this token for {shortMint(owner)}.</Txt> : null}
    </View>
    {onBack ? <Button kind="quiet" label="Choose another wallet" disabled={locked} onPress={onBack} /> : null}
  </View>
}

function Parameter({ field, value, change, disabled }: { field: LiquidityParameter; value: string; change: (value: string) => void; disabled: boolean }) {
  const options = field.type === 'boolean' ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] : field.options
  return <View style={[st.stack, { minWidth: 160, flexGrow: 1 }]}><Txt v="label">{field.label}{field.required ? '' : ' · optional'}</Txt>{options ? <View style={st.row}>{options.map(option => { const item = typeof option === 'string' ? { value: option, label: option } : option; return <Chip key={String(item.value)} label={item.label} active={value === String(item.value)} onPress={() => { if (!disabled) change(String(item.value)) }} /> })}</View> : <TextInput accessibilityLabel={field.label} value={value} onChangeText={change} editable={!disabled} autoCapitalize="none" placeholder={field.default !== undefined ? String(field.default) : 'auto'} placeholderTextColor={C.faint} style={st.input} />}</View>
}
const st = StyleSheet.create({
  stack: { gap: 10 }, row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  section: { gap: 10, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.surface },
  amountBox: { gap: 8, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: C.lineStrong, backgroundColor: C.bg },
  rangeBox: { gap: 8, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.raised },
  quote: { gap: 10, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: C.lineStrong, backgroundColor: C.bg },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, height: 28, borderRadius: 14, borderWidth: 1, borderColor: C.line, backgroundColor: C.surface },
  dot: { width: 8, height: 8, borderRadius: 4 },
  input: { minWidth: 0, height: 44, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: C.line, color: C.text, fontFamily: F.mono, fontSize: 12, backgroundColor: C.bg },
  amount: { minWidth: 0, height: 52, color: C.text, fontFamily: F.monoBold, fontSize: 26 },
})
