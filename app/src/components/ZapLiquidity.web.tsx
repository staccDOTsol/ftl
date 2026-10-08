// Simple liquidity: the Liquidity tab's default. One SOL amount in, one LP
// position out (or the reverse), in the shape of the swap terminal: a pay
// panel, a flip, a receive panel that shows the chosen pool as the asset, and
// a single primary action. The server plans the pool, the split and the
// quotes; each step is built against live balances, simulated, signed by the
// wallet and confirmed before the next starts. Progress persists so a reload
// resumes. The "Advanced" chip swaps in the full venue/pool/range form.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Linking, StyleSheet, TextInput, View } from 'react-native'
import bs58 from 'bs58'
import { C, F, T } from '@/theme'
import type { FlowEvent, Move, MoveVenue, PoolSummary, TokenSummary } from '@/lib/types'
import { assertSignedMessage, decodeTransaction, getRouterStatus, mintDecimals, sendSignedSwap, tokenBalance, transactionStatus } from '@/lib/solana'
import { acknowledgeComposer, balancePercent, COMPOSER_SOURCE_URL, composerAcknowledged, fromAtomic, shortMint, SOL_MINT, toAtomic } from '@/lib/solana-trade'
import { hasPending, PENDING_KEY } from '@/lib/solana-pending'
import { inspectTransaction, type TransactionVersion } from '@/lib/solana-wire'
import { assertLiquidityTransactionIntent, liquidityPositions, simulateLiquidity, type LiquidityOperation, type LiquidityPosition, type LiquidityQuote } from '@/lib/solana-liquidity'
import { compactAmount, estimateLine, KIND_LABEL, parseZapProgress, POOL_SCOPED_VENUES, PREFERENCE_OPTIONS, routingVenue, stepLabel, ZAP_KEY, zapBuild, zapPlan, type ZapBuild, type ZapDirection, type ZapDone, type ZapPlan, type ZapPreference, type ZapProgress } from '@/lib/solana-zap'
import { useTokenMeta } from '@/lib/token-meta'
import { usd, short } from '@/lib/format'
import type { SolanaSigner } from './SolanaWallet.web'
import SolanaLiquidity from './SolanaLiquidity.web'
import { PoolYield } from './PoolYield.web'
import { ShareMove } from './ShareMove.web'
import { Button, Chip, Press, Seg, Txt } from './ui'

type Props = { t: TokenSummary; pools: PoolSummary[]; signer: SolanaSigner | null; onLockChange: (locked: boolean) => void; origin?: FlowEvent | null; exitRequest?: boolean; initialPool?: string | null; initialAmount?: string; advanced?: boolean; onConnect?: () => void; onBack?: () => void }
const BATCH_KEY = 'liquidityxyz.solana.liquidity-batch.v1'
const PLAN_REFRESH_MS = 45_000
const NO_SOL_POOL = 'No SOL pool for this token yet'
const VENUE: Record<string, string> = { 'raydium-cpmm': 'Raydium CPMM', 'raydium-clmm': 'Raydium CLMM', 'raydium-amm-v4': 'Raydium AMM v4', 'raydium-amm': 'Raydium AMM v4', orca: 'Orca', 'meteora-dlmm': 'Meteora DLMM', 'meteora-damm': 'Meteora DAMM', 'meteora-damm-v2': 'Meteora DAMM v2', pumpswap: 'PumpSwap' }
const venueName = (id: string) => VENUE[id] ?? id.replaceAll('-', ' ')
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'The operation could not finish. Please try again.'
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const account = (address: string) => `https://solscan.io/account/${address}`
const money = (x: number | null | undefined) => x === null || x === undefined ? '—' : usd(x).replace('K', 'k')
const active = (p: LiquidityPosition) => p.removalMode === 'percentage' || (!!p.liquidity && /^[0-9]+$/.test(p.liquidity) && BigInt(p.liquidity) > 0n) || (p.amounts ?? []).some(a => (a.raw && BigInt(a.raw) > 0n) || (a.amount && BigInt(a.amount) > 0n))
function readProgress(): ZapProgress | null { try { return parseZapProgress(localStorage.getItem(ZAP_KEY)) } catch { return null } }

export default function ZapLiquidity(props: Props) {
  const [advanced, setAdvanced] = useState(!!props.advanced)
  const [preset, setPreset] = useState<{ venue: string; operation: LiquidityOperation } | null>(null)
  const [locked, setLocked] = useState(false)
  const { onLockChange } = props
  const lock = useCallback((value: boolean) => { setLocked(value); onLockChange(value) }, [onLockChange])
  // An interrupted Advanced batch resumes in Advanced; an interrupted Simple run resumes here.
  useEffect(() => {
    const timer = setTimeout(() => { try { if (localStorage.getItem(BATCH_KEY) && !localStorage.getItem(ZAP_KEY)) setAdvanced(true) } catch {} }, 0)
    return () => clearTimeout(timer)
  }, [])
  const owner = props.signer?.address ?? null
  return <View style={st.stack}>
    <View style={st.between}>
      <Txt v="label">{advanced ? 'Advanced · venue, pool, range' : 'Simple · SOL in, LP out'}</Txt>
      <Chip label={advanced ? 'Simple' : 'Advanced'} active={advanced} onPress={() => { if (!locked) { setAdvanced(value => !value); setPreset(null) } }} />
    </View>
    {advanced ? <>
      <SolanaLiquidity {...props} onLockChange={lock} initialVenue={preset?.venue} initialOperation={preset?.operation} />
      {!owner && props.onConnect ? <Button label="Connect wallet" onPress={props.onConnect} style={st.primary} /> : null}
    </> : <SimpleZap {...props} onLockChange={lock} onOpenPool={() => { setPreset({ venue: 'meteora-damm-v2', operation: 'initialize' }); setAdvanced(true) }} />}
  </View>
}

function SimpleZap({ t, pools, signer, onLockChange, exitRequest, initialPool, initialAmount, onConnect, onOpenPool }: Props & { onOpenPool: () => void }) {
  const mint = t.address
  const [direction, setDirection] = useState<ZapDirection>(exitRequest ? 'out' : 'in')
  const [amount, setAmount] = useState(initialAmount ?? '')
  const [preference, setPreference] = useState<ZapPreference>('auto')
  const [forcedPool, setForcedPool] = useState<string | null>(initialPool ?? null)
  const [showPools, setShowPools] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [balance, setBalance] = useState<{ owner: string; raw: string } | null>(null)
  const [decimals, setDecimals] = useState<number | null>(t.decimals ?? null)
  const [planState, setPlanState] = useState<{ plan: ZapPlan; key: string; at: number } | null>(null)
  const [planning, setPlanning] = useState(false)
  const [planError, setPlanError] = useState<{ key: string; message: string; at: number } | null>(null)
  const [positions, setPositions] = useState<{ owner: string; rows: LiquidityPosition[]; errors: { venue: string; error: string }[] } | null>(null)
  const [positionError, setPositionError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string>('')
  const [progress, setProgress] = useState<ZapProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ direction: ZapDirection; venue: string; pool: string; position?: string; signatures: string[]; done: ZapDone[] } | null>(null)
  const [routerOk, setRouterOk] = useState<boolean | null>(null)
  const [ackedProgram, setAckedProgram] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const owner = signer?.address ?? null
  const version = signer?.transactionVersion ?? null
  const current = useRef({ signer, key: '' })
  const mounted = useRef(true)
  const acting = useRef(false)
  const seq = useRef(0)
  const meta = useTokenMeta([mint])
  const symbol = t.symbol || meta[mint]?.symbol ? `$${(t.symbol || meta[mint]?.symbol || '').slice(0, 14)}` : shortMint(mint)
  const amountRaw = useMemo(() => { try { return toAtomic(amount, 9) } catch { return null } }, [amount])
  const walletPositions = useMemo(() => positions?.owner === owner ? positions.rows : [], [positions, owner])
  const linkedPositions = initialPool ? walletPositions.filter(p => p.pool === initialPool) : []
  const position = walletPositions.find(p => p.position === selected) ?? (!selected ? linkedPositions.length === 1 ? linkedPositions[0] : walletPositions.length === 1 ? walletPositions[0] : null : null)
  const key = owner && version ? (direction === 'in' ? (amountRaw ? `${owner}|${version}|in|${amountRaw}|${preference}|${forcedPool ?? ''}` : '') : (position ? `${owner}|${version}|out|${position.venue}|${position.pool}|${position.position}` : '')) : ''
  const plan = planState?.key === key ? planState.plan : null
  // A composed plan runs through the lp-zap program; the browser acknowledges each program once.
  const composed = plan?.mode === 'composed'
  const composerAck = !composed || ackedProgram === (plan?.composerProgramId ?? 'unreported') || composerAcknowledged(plan?.composerProgramId)
  const locked = busy || !!progress
  const solBalance = balance?.owner === owner ? balance.raw : null
  useEffect(() => { current.current = { signer, key } }, [signer, key])
  useEffect(() => { onLockChange(locked); return () => onLockChange(false) }, [locked, onLockChange])
  useEffect(() => {
    mounted.current = true
    const timer = setInterval(() => setNow(Date.now()), 1000)
    const restore = setTimeout(() => { const saved = readProgress(); if (saved && saved.mint === mint) { setProgress(saved); setDirection(saved.direction) } }, 0)
    return () => { mounted.current = false; clearInterval(timer); clearTimeout(restore) }
  }, [mint])
  useEffect(() => {
    let alive = true
    void getRouterStatus().then(status => { if (alive) setRouterOk(!(status.configured === false || status.available === false || status.status !== 'ok')) }).catch(() => { if (alive) setRouterOk(false) })
    return () => { alive = false }
  }, [])
  useEffect(() => {
    if (decimals !== null) return
    let alive = true
    void mintDecimals(mint).then(value => { if (alive) setDecimals(value) }).catch(() => {})
    return () => { alive = false }
  }, [mint, decimals])
  const refreshBalance = useCallback(async () => {
    if (!owner) return
    const raw = await tokenBalance(owner, SOL_MINT, true)
    if (mounted.current && current.current.signer?.address === owner) setBalance({ owner, raw })
  }, [owner])
  useEffect(() => {
    let alive = true
    const refresh = () => { void refreshBalance().catch(error => { if (alive) setError(`Balance unavailable: ${messageOf(error)}`) }) }
    refresh()
    const timer = setInterval(refresh, 20_000)
    return () => { alive = false; clearInterval(timer) }
  }, [refreshBalance, result])
  // Withdraw: every venue's positions on this token, plus the per-pool reads
  // for venues that only list LP holdings per pool (holdings does the same).
  const refreshPositions = useCallback(async () => {
    if (!owner) return
    setPositionError(null)
    try {
      const all = await liquidityPositions(owner)
      const scoped = pools.filter(p => p.funded && POOL_SCOPED_VENUES.has(routingVenue(p.venue))).slice(0, 6)
      const extra = await Promise.allSettled(scoped.map(p => liquidityPositions(owner, routingVenue(p.venue), p.address)))
      const rows = new Map<string, LiquidityPosition>()
      for (const list of [all, ...extra.flatMap(r => r.status === 'fulfilled' ? [r.value] : [])]) for (const p of list.positions) {
        const row = { ...p, venue: routingVenue(p.venue) }
        if ((row.mintA === mint || row.mintB === mint) && active(row)) rows.set(`${row.venue}:${row.position}`, row)
      }
      if (mounted.current && current.current.signer?.address === owner) setPositions({ owner, rows: [...rows.values()], errors: (all.errors ?? []).filter(e => !POOL_SCOPED_VENUES.has(e.venue)) })
    } catch (error) { if (mounted.current) setPositionError(messageOf(error)) }
  }, [owner, mint, pools])
  useEffect(() => { const timer = setTimeout(() => { if (direction === 'out') void refreshPositions() }, 0); return () => clearTimeout(timer) }, [direction, refreshPositions, result])

  // Plan on every valid change (debounced) and every 45 s after that while idle.
  const fetchPlan = useCallback(async (planKey: string) => {
    const request = ++seq.current
    const [planOwner, planVersion, planDirection, ...rest] = planKey.split('|')
    setPlanning(true)
    try {
      const body = planDirection === 'in'
        ? { owner: planOwner, mint, direction: 'in' as const, amount: rest[0], preference: rest[1] as ZapPreference, ...(rest[2] ? { pool: rest[2] } : {}), transactionVersion: planVersion as TransactionVersion }
        : { owner: planOwner, mint, direction: 'out' as const, position: { venue: rest[0], pool: rest[1], position: rest[2] }, transactionVersion: planVersion as TransactionVersion }
      const response = await zapPlan(body)
      if (request === seq.current && mounted.current) { setPlanState({ plan: response, key: planKey, at: Date.now() }); setPlanError(null) }
    } catch (error) {
      if (request === seq.current && mounted.current) { setPlanState(null); setPlanError({ key: planKey, message: messageOf(error), at: Date.now() }) }
    } finally { if (request === seq.current && mounted.current) setPlanning(false) }
  }, [mint])
  useEffect(() => {
    seq.current++
    const reset = setTimeout(() => { setPlanState(null); setPlanError(null); setPlanning(false) }, 0)
    const timer = key && !locked ? setTimeout(() => void fetchPlan(key), 400) : undefined
    return () => { clearTimeout(reset); if (timer) clearTimeout(timer) }
  }, [key, locked, fetchPlan])
  useEffect(() => {
    if (!key || locked || planning) return
    const due = planState?.key === key ? planState.at + PLAN_REFRESH_MS : planError?.key === key ? planError.at + PLAN_REFRESH_MS : null
    if (due === null) return
    const timer = setTimeout(() => void fetchPlan(key), Math.max(0, due - Date.now()))
    return () => clearTimeout(timer)
  }, [key, locked, planning, planState, planError, fetchPlan])

  async function act(fn: () => Promise<void>) {
    if (acting.current) return
    acting.current = true; setBusy(true); setError('')
    try { await fn() } catch (error) { if (mounted.current) setError(messageOf(error)) }
    finally { acting.current = false; if (mounted.current) { setBusy(false); setPhase('') } }
  }
  function persist(value: ZapProgress | null) {
    // Refuse to continue if recovery state cannot be saved before a network send.
    if (value) localStorage.setItem(ZAP_KEY, JSON.stringify(value)); else localStorage.removeItem(ZAP_KEY)
    if (value?.pending) localStorage.setItem(PENDING_KEY, JSON.stringify({ ...value.pending, state: 'pending' }))
    else localStorage.removeItem(PENDING_KEY)
    if (mounted.current) setProgress(value)
  }
  async function settle(value: ZapProgress): Promise<ZapProgress | null> {
    if (!value.pending) return value
    const state = await transactionStatus(value.pending.signature, value.pending.lastValidBlockHeight)
    if (state === 'pending') { setPhase('Awaiting on-chain confirmation. Check again before continuing.'); return null }
    if (state !== 'confirmed') { persist(null); throw new Error(`Transaction ${state}. ${value.confirmed.length} earlier transaction(s) confirmed; check your wallet balances before trying again.`) }
    const next: ZapProgress = { ...value, confirmed: [...value.confirmed, value.pending.signature], built: value.built ? { ...value.built, next: value.built.next + 1 } : undefined, pending: undefined }
    persist(next); return next
  }
  async function execute(initial: ZapProgress) {
    let value: ZapProgress | null = await settle(initial)
    if (!value) return
    const total = value.titles.length
    while (value.step < total) {
      const wallet = current.current.signer
      if (!mounted.current || !wallet?.address || wallet.address !== value.owner || wallet.transactionVersion !== value.version) throw new Error('Reconnect the same wallet to continue this deposit.')
      const label = stepLabel(value.step, total, value.titles[value.step])
      if (!value.built) {
        setPhase(`${label} · preparing…`)
        const built: ZapBuild = await zapBuild({ planId: value.planId, owner: value.owner, step: value.step, transactionVersion: value.version, confirmed: value.confirmed.slice(-8) })
        if (built.step !== value.step || !Array.isArray(built.transactions) || !built.transactions.length || built.transactions.length > 12) throw new Error('The server returned an unexpected step. Nothing was sent.')
        const { owner: signerOwner, version: signerVersion } = value
        built.transactions.forEach(tx => assertLiquidityTransactionIntent(tx, signerOwner, signerVersion))
        if (!mounted.current || current.current.signer?.address !== value.owner) throw new Error('Wallet changed. Nothing was sent.')
        value = { ...value, built: { step: value.step, mode: built.mode, kind: built.kind, transactions: built.transactions, next: 0, quote: built.quote, pool: built.pool, position: built.position, note: built.note } }
        persist(value)
      }
      while (value.built!.next < value.built!.transactions.length) {
        const transaction = value.built!.transactions[value.built!.next]
        const part = value.built!.transactions.length > 1 ? ` (${value.built!.next + 1}/${value.built!.transactions.length})` : ''
        setPhase(`${label}${part} · simulating…`)
        const fee = await simulateLiquidity(transaction, value.owner, value.version)
        if (!mounted.current || current.current.signer?.address !== value.owner) throw new Error('Wallet changed. Nothing was sent.')
        setPhase(`${label}${part} · approve in your wallet · network fee ${fromAtomic(String(fee), 9)} SOL`)
        const signed = await wallet.sign(decodeTransaction(transaction.transaction))
        assertSignedMessage(transaction.transaction, signed)
        if (!mounted.current || current.current.signer?.address !== value.owner) throw new Error('Wallet changed. Nothing was sent.')
        const bytes = inspectTransaction(signed).signatures[0]
        if (!bytes?.some(byte => byte !== 0)) throw new Error('Wallet did not sign this transaction.')
        const signature = bs58.encode(bytes)
        value = { ...value, pending: { signature, lastValidBlockHeight: transaction.lastValidBlockHeight } }
        persist(value)
        setPhase(`${label}${part} · submitting…`)
        try { const sent = await sendSignedSwap(signed, transaction.lastValidBlockHeight); if (sent !== signature) throw new Error('Unexpected transaction signature.') }
        catch (error) { setError(`Submission needs a status check: ${messageOf(error)} Do not repeat this step.`); return }
        setPhase(`${label}${part} · confirming…`)
        let settled: ZapProgress | null = null
        for (let i = 0; i < 20 && mounted.current; i++) { settled = await settle(value); if (settled) break; await sleep(2000) }
        if (!settled) return
        value = settled
      }
      const finished: NonNullable<ZapProgress['built']> = value.built!
      const entry: ZapDone = { step: finished.step, kind: finished.kind ?? 'swap', quote: finished.quote, pool: finished.pool, position: finished.position, signatures: value.confirmed.slice(value.confirmed.length - finished.transactions.length) }
      // A composed build is the whole plan in one transaction: no later steps remain.
      value = { ...value, step: finished.mode === 'composed' ? value.titles.length : value.step + 1, built: undefined, done: [...value.done, entry] }
      persist(value)
    }
    persist(null)
    const liquidity = value.done.find(d => d.kind === 'add' || d.kind === 'remove')
    setResult({ direction: value.direction, venue: value.venue, pool: value.pool, position: liquidity?.position, signatures: value.confirmed, done: value.done })
    setPlanState(null); setAmount(''); setSelected('')
  }
  async function start() {
    if (hasPending()) throw new Error('Resolve the pending wallet transaction before starting another operation.')
    if (readProgress()) throw new Error('Finish or stop the operation in progress first.')
    if (!plan || !owner || !version || current.current.key !== key || plan.owner !== owner) throw new Error('Wait for a fresh plan.')
    if (plan.expiresAt <= Date.now()) throw new Error('This plan expired. Wait for the refreshed one.')
    if (plan.mode === 'composed' && !composerAck) throw new Error('This run goes through the composer program. Review the composed route above and acknowledge it, then try again. Nothing was signed.')
    const value: ZapProgress = { planId: plan.planId, owner, version, direction: plan.direction, mint, venue: plan.pool.venue, pool: plan.pool.pool, titles: plan.steps.map(step => step.title), step: 0, confirmed: [], done: [], expiresAt: plan.expiresAt }
    persist(value)
    await execute(value)
  }
  function flip() { if (locked) return; setDirection(value => value === 'in' ? 'out' : 'in'); setError(''); setShowPools(false) }

  const noPool = planError?.key === key && planError.message === NO_SOL_POOL
  const countdown = plan && planState ? Math.max(0, Math.ceil((planState.at + PLAN_REFRESH_MS - now) / 1000)) : null
  const estimate = plan ? estimateLine(plan, symbol) : null
  const addQuote = plan?.steps.find(step => step.kind === 'add')?.quote as LiquidityQuote | undefined
  const details = (addQuote?.details ?? {}) as Record<string, string | number | boolean | null | undefined>
  const primary = ((): { label: string; onPress?: () => void; busy?: boolean } => {
    if (progress) return { label: progress.pending ? 'Check confirmation & continue' : `Continue ${progress.step + 1}/${progress.titles.length}`, busy, onPress: owner === progress.owner ? () => void act(() => execute(progress)) : undefined }
    if (!owner) return { label: 'Connect wallet', busy, onPress: onConnect ?? (signer ? () => void act(signer.connect) : undefined) }
    if (busy) return { label: phase ? 'Working…' : 'Please wait…', busy: true }
    if (routerOk === false) return { label: 'Routing unavailable' }
    if (direction === 'out') {
      if (!position) return { label: walletPositions.length ? 'Choose a position' : 'No position to withdraw' }
      if (planError?.key === key) return { label: 'Cannot price this exit' }
      if (!plan) return { label: 'Pricing exit…', busy: true }
      return { label: 'Withdraw to SOL', onPress: () => void act(start) }
    }
    if (!amountRaw) return { label: 'Enter an amount' }
    if (solBalance !== null && BigInt(amountRaw) + 10_000_000n > BigInt(solBalance)) return { label: 'Insufficient SOL' }
    if (noPool) return { label: 'No SOL pool yet' }
    if (planError?.key === key) return { label: 'Quote unavailable' }
    if (!plan) return { label: 'Finding the best pool…', busy: true }
    if (version === null) return { label: 'Wallet cannot sign V0/V1' }
    return { label: 'Deposit', onPress: () => void act(start) }
  })()
  const primaryDisabled = progress ? owner !== progress.owner : !owner ? !onConnect && !signer : busy || routerOk === false || (direction === 'out'
    ? !position || planError?.key === key || !plan || (composed && !composerAck)
    : !amountRaw || solBalance !== null && BigInt(amountRaw) + 10_000_000n > BigInt(solBalance) || noPool || planError?.key === key || !plan || version === null || (composed && !composerAck))
  const poolBadge = (venue: string, kind: ZapPlan['pool']['kind']) => <View style={st.poolRow}><Txt v="num" style={{ fontSize: T.sm }}>{venueName(venue)}</Txt><Chip label={KIND_LABEL[kind]} color={kind === 'constant' ? C.accent : kind === 'splash' ? C.violet : C.gold} active /></View>
  const moveFor = (): Move | null => {
    if (!result) return null
    const done = result.done.find(d => d.kind === (result.direction === 'in' ? 'add' : 'remove'))
    const quote = done?.quote as LiquidityQuote | undefined
    const amounts = (quote?.amounts ?? []).filter(a => a.direction === (result.direction === 'in' ? 'debit' : 'credit')).slice(0, 4).map(a => ({ mint: a.mint, amount: fromAtomic(a.expectedRaw, a.decimals), symbol: a.mint === SOL_MINT ? 'SOL' : a.mint === mint ? symbol.replace('$', '') : shortMint(a.mint) }))
    return { venue: routingVenue(result.venue) as MoveVenue, operation: result.direction === 'in' ? 'add' : 'remove', pool: result.pool, amounts }
  }
  const move = moveFor()

  return <View style={st.stack}>
    {direction === 'in' ? <>
      <View style={st.panel}>
        <View style={st.between}>
          <Txt v="label">You pay</Txt>
          <View style={st.balanceRow}>
            <Txt v="monoSmall">{solBalance !== null ? `Balance ${fromAtomic(solBalance, 9)}` : owner ? 'Balance …' : ''}</Txt>
            {solBalance !== null ? [['HALF', 50], ['MAX', 100]].map(([label, percent]) => (
              <Press key={label} disabled={locked} onPress={() => { setAmount(fromAtomic(balancePercent(solBalance, Number(percent), true), 9)); setError('') }} accessibilityRole="button" style={({ hovered, pressed }) => [st.miniChip, hovered && { backgroundColor: C.hover }, pressed && { opacity: 0.7 }]}>
                <Txt v="label" color={C.accent}>{label}</Txt>
              </Press>
            )) : null}
          </View>
        </View>
        <View style={st.row}>
          <View style={st.tokenButton}><View style={[st.dot, { backgroundColor: C.violet }]} /><Txt v="num" style={{ fontSize: T.sm }}>SOL</Txt></View>
          <TextInput accessibilityLabel="SOL amount to deposit" value={amount} onChangeText={value => { setAmount(value); setError('') }} editable={!locked} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={C.faint} style={st.amount} />
        </View>
        {owner ? <Txt v="monoSmall">FTL handles the token split. Shortcuts reserve 0.01 SOL for fees.</Txt> : null}
      </View>
    </> : <View style={st.panel}>
      <View style={st.between}><Txt v="label">You withdraw</Txt><Button kind="quiet" size="sm" label="Refresh" disabled={busy || !owner} onPress={() => void refreshPositions()} /></View>
      {!owner ? <Txt v="small">Connect your wallet to see your {symbol} positions.</Txt>
        : positionError ? <Txt v="small" color={C.warn}>Positions unavailable: {positionError}</Txt>
        : positions?.owner !== owner ? <Txt v="small">Loading your positions…</Txt>
        : !walletPositions.length ? <Txt v="small">No {symbol} position for {shortMint(owner)}. Flip to deposit SOL into one.</Txt>
        : walletPositions.map(p => <Press key={`${p.venue}:${p.position}`} disabled={locked} onPress={() => { setSelected(p.position); setError('') }} accessibilityRole="button" accessibilityState={{ selected: position?.position === p.position }} style={({ hovered, pressed }) => [st.positionRow, position?.position === p.position && { borderColor: C.accent + '88', backgroundColor: C.accentDim }, hovered && { backgroundColor: C.hover }, pressed && { opacity: 0.7 }]}>
          <View style={{ flex: 1, gap: 4, minWidth: 0 }}>
            <View style={st.poolRow}><Txt v="num" style={{ fontSize: T.sm }}>{venueName(p.venue)}</Txt><Txt v="monoSmall" selectable>pool {shortMint(p.pool)} · {shortMint(p.position)}</Txt></View>
            <Txt v="monoSmall" color={C.text}>{p.amounts?.length ? p.amounts.map(a => `${compactAmount(a.raw ?? a.amount ?? '0', a.decimals)} ${a.mint === SOL_MINT ? 'SOL' : a.mint === mint ? symbol : shortMint(a.mint)}`).join(' + ') : p.removalMode === 'percentage' ? 'bin position · withdrawn in full' : `${p.liquidity ?? '—'} liquidity units · withdrawn in full`}</Txt>
            <PoolYield venue={p.venue} pool={p.pool} />
          </View>
          <Txt v="mono" color={position?.position === p.position ? C.accent : C.faint}>{position?.position === p.position ? '●' : '○'}</Txt>
        </Press>)}
      {positions?.owner === owner && positions.errors.length ? <Txt v="monoSmall">{positions.errors.map(e => venueName(e.venue)).join(', ')} did not answer; refresh before treating an empty list as no position.</Txt> : null}
    </View>}

    <View style={st.flipRow}>
      <View style={st.flipLine} />
      <Press onPress={flip} disabled={locked} accessibilityRole="button" accessibilityLabel={direction === 'in' ? 'Switch to withdraw' : 'Switch to deposit'} style={({ hovered, pressed }) => [st.flip, hovered && { borderColor: C.accent + '88', backgroundColor: C.accentDim }, pressed && { transform: [{ rotate: '180deg' }] }]}>
        <Txt v="mono" color={C.accent}>⇅</Txt>
      </Press>
      <View style={st.flipLine} />
    </View>

    <View style={st.panel}>
      <View style={st.between}>
        <Txt v="label">You get</Txt>
        {plan && countdown !== null ? <Txt v="monoSmall" color={planning ? C.warn : C.accent}>{planning ? 'Refreshing…' : `Refreshes in ${countdown}s`}</Txt> : planning ? <Txt v="monoSmall">Planning…</Txt> : null}
      </View>
      {direction === 'in' ? <>
        {plan ? <>
          <View style={st.between}>
            <View style={st.poolRow}><Txt v="num" style={{ fontSize: T.sm }}>{symbol} / SOL LP</Txt><Txt v="monoSmall" color={C.accent}>{forcedPool ? 'Selected pool' : 'Auto-selected'}</Txt></View>
            <Chip label={showPools ? 'Done' : 'Change pool'} active={showPools} onPress={() => { if (!locked) setShowPools(value => !value) }} />
          </View>
          <Txt v="num" style={st.estimate} numberOfLines={2}>{estimate}</Txt>
          <Txt v="small">Trading fees from {venueName(plan.pool.venue)}</Txt>
          <PoolYield venue={plan.pool.venue} pool={plan.pool.pool} />
          {showDetails ? <><Txt v="monoSmall" selectable>{plan.pool.pool}</Txt><Txt v="small">{plan.pool.reason}</Txt>{details.priceLower !== undefined && details.priceUpper !== undefined ? <Txt v="monoSmall">Range {String(details.priceLower)} → {String(details.priceUpper)} SOL per {symbol}{details.priceCurrent !== undefined ? ` · now ${String(details.priceCurrent)}` : ''}</Txt> : null}</> : null}
          {addQuote?.warnings?.map(warning => <Txt key={warning} v="small" color={C.warn}>{warning}</Txt>)}
        </> : noPool ? <>
          <Txt v="body">No SOL pool for {symbol} yet.</Txt>
          <Txt v="small">Simple mode deposits into an existing SOL pool. Open the first one in Advanced: Meteora DAMM v2 is preselected; you set the starting price.</Txt>
          <Button kind="ghost" label="Open a pool (Advanced)" disabled={locked} onPress={onOpenPool} />
        </> : <>
          <View style={st.poolRow}><Txt v="num" style={{ fontSize: T.sm }}>{symbol} / SOL LP</Txt><Txt v="monoSmall">{pools.filter(p => p.funded).length} funded pool{pools.filter(p => p.funded).length === 1 ? '' : 's'} on FTL</Txt></View>
          <Txt v="num" style={[st.estimate, { color: C.faint }]}>{planning ? '…' : '0.00'}</Txt>
          <Txt v="small">{!owner ? 'Connect a wallet to price this deposit.' : !amountRaw ? 'Enter your SOL amount. Pool selection, token splits, and the deposit route are automatic.' : planError?.key === key ? planError.message : 'Finding the best pool…'}</Txt>
        </>}
        {showPools && plan ? <View style={st.alternatives}>
          <Seg value={preference} options={PREFERENCE_OPTIONS} onChange={value => { if (!locked) { setPreference(value); setForcedPool(null) } }} />
          {[{ venue: plan.pool.venue, pool: plan.pool.pool, kind: plan.pool.kind, stats: plan.pool.stats }, ...plan.alternatives].map(item => <Press key={item.pool} disabled={locked} onPress={() => { setForcedPool(item.pool === plan.pool.pool ? null : item.pool); setShowPools(false) }} accessibilityRole="button" style={({ hovered, pressed }) => [st.positionRow, item.pool === plan.pool.pool && { borderColor: C.accent + '88' }, hovered && { backgroundColor: C.hover }, pressed && { opacity: 0.7 }]}>
            <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
              {poolBadge(item.venue, item.kind)}
              <Txt v="monoSmall">{shortMint(item.pool)} · TVL {money(item.stats?.tvlUsd)} · fee {item.stats?.feeRateBps !== null && item.stats?.feeRateBps !== undefined ? `${(item.stats.feeRateBps / 100).toFixed(2)}%` : '—'}</Txt>
            </View>
            <Txt v="mono" color={item.pool === plan.pool.pool ? C.accent : C.faint}>{item.pool === plan.pool.pool ? '●' : '○'}</Txt>
          </Press>)}
        </View> : null}
      </> : <>
        <View style={st.poolRow}><View style={[st.dot, { backgroundColor: C.violet }]} /><Txt v="num" style={{ fontSize: T.sm }}>SOL</Txt></View>
        <Txt v="num" style={[st.estimate, !plan && { color: C.faint }]}>{plan ? estimate : planning ? '…' : '0.00'}</Txt>
        {plan ? <Txt v="small">{plan.pool.reason} {plan.steps.length === 1 ? 'The position holds only SOL, so no swap is needed.' : `The ${symbol} side swaps back to SOL in a second transaction.`}</Txt>
          : position && planError?.key === key ? <Txt v="small" color={C.warn}>{planError.message}</Txt>
          : <Txt v="small">Pick a position above. It is withdrawn in full and the {symbol} side is swapped back to SOL.</Txt>}
      </>}
    </View>

    {plan && !progress && composed ? <ComposedZapNotice plan={plan} acknowledged={composerAck}
      onAcknowledge={() => { acknowledgeComposer(plan.composerProgramId); setAckedProgram(plan.composerProgramId ?? 'unreported') }} /> : null}

    {plan && !progress ? <View style={st.details}>
      <Press onPress={() => setShowDetails(value => !value)} accessibilityRole="button" accessibilityState={{ expanded: showDetails }} style={({ hovered }) => [st.between, { paddingVertical: 4 }, hovered && { opacity: 0.8 }]}><Txt v="monoSmall" color={C.text}>{composed ? `${plan.steps.length} steps · one signature · ` : `${plan.steps.length} guided steps · `}{showDetails ? 'Hide route' : 'View route'}</Txt><Txt v="monoSmall" color={C.accent}>{showDetails ? '−' : '+'}</Txt></Press>
      {showDetails ? plan.steps.map((step, i) => <View key={`${step.kind}:${i}`} style={st.between}><Txt v="monoSmall" color={C.text}>{stepLabel(i, plan.steps.length, step.title)}</Txt><Txt v="monoSmall">{step.kind === 'swap' ? `min ${compactAmount(step.minOut, step.outputMint === SOL_MINT ? 9 : plan.estimate.tokenDecimals ?? decimals ?? 0)} ${step.outputMint === SOL_MINT ? 'SOL' : symbol}` : 'quoted live before signing'}</Txt></View>) : null}
      <View style={st.between}><Txt v="monoSmall">Network fees</Txt><Txt v="monoSmall" color={C.text}>≈ {plan.estimate.networkFeeSolApprox} SOL + account rent</Txt></View>
      <View style={st.between}><Txt v="monoSmall">Slippage per step</Txt><Txt v="monoSmall" color={C.text}>{plan.slippageBps / 100}%</Txt></View>
      {plan.steps.filter(step => step.kind === 'swap').map((step, i) => step.kind === 'swap' ? <View key={`minimum-${i}`} style={st.between}><Txt v="monoSmall">Swap minimum</Txt><Txt v="monoSmall" color={C.text}>{compactAmount(step.minOut, step.outputMint === SOL_MINT ? 9 : plan.estimate.tokenDecimals ?? decimals ?? 0)} {step.outputMint === SOL_MINT ? 'SOL' : symbol}</Txt></View> : null)}
      <Txt v="monoSmall">{composed ? 'Both steps run in one transaction: all of it lands or none of it does.' : 'Steps confirm in order. Earlier confirmed steps remain if a later step fails.'}</Txt>
    </View> : null}

    {routerOk === false ? <Txt v="small" color={C.warn}>Liquidity routing is temporarily unavailable. Try again shortly, or use Advanced.</Txt> : null}
    {phase ? <Txt v="small" color={C.accent}>{phase}</Txt> : null}
    {error ? <Txt v="small" color={C.warn}>{error}</Txt> : null}

    {progress ? <View style={st.details}>
      <Txt v="label">{progress.direction === 'in' ? 'Deposit in progress' : 'Withdrawal in progress'} · {venueName(progress.venue)}</Txt>
      {progress.titles.map((title, i) => <View key={title} style={st.between}>
        <Txt v="monoSmall" color={i < progress.step ? C.accent : i === progress.step ? C.text : C.faint}>{stepLabel(i, progress.titles.length, title)}</Txt>
        <Txt v="monoSmall" color={i < progress.step ? C.accent : C.faint}>{i < progress.step ? 'confirmed' : i === progress.step ? (progress.pending ? 'awaiting confirmation' : progress.built ? `${progress.built.next}/${progress.built.transactions.length} signed` : 'next') : ''}</Txt>
      </View>)}
      {progress.built?.note ? <Txt v="small">{progress.built.note}</Txt> : null}
      {progress.expiresAt <= now ? <Txt v="small" color={C.warn}>The plan behind this run has expired. Stop here and start again; confirmed steps already changed your balances.</Txt> : null}
      {progress.pending ? <Button kind="quiet" size="sm" label="View pending transaction ↗" onPress={() => void Linking.openURL(`https://solscan.io/tx/${progress.pending!.signature}`)} /> : null}
      {owner !== progress.owner ? <Txt v="small" color={C.warn}>Reconnect {shortMint(progress.owner)} to continue.</Txt> : null}
      {!progress.pending ? <Button kind="quiet" size="sm" label="Stop remaining steps" disabled={busy} onPress={() => { persist(null); setPlanState(null) }} /> : null}
    </View> : null}

    {planError?.key === key && key && !locked ? <Button label="Retry quote" kind="ghost" onPress={() => void fetchPlan(key)} /> : null}
    <Button label={primary.label} busy={primary.busy} disabled={primaryDisabled} onPress={() => primary.onPress?.()} style={st.primary} />

    {result ? <View style={[st.details, { borderColor: C.accent + '66' }]}>
      <Txt v="h2" color={C.accent}>{result.direction === 'in' ? `Deposited into ${venueName(result.venue)}` : `Withdrawn to SOL from ${venueName(result.venue)}`}</Txt>
      <Txt v="monoSmall" selectable>Pool {result.pool}</Txt>
      {result.position ? <Txt v="monoSmall" selectable>Position {result.position}</Txt> : null}
      <View style={st.wrap}>{result.signatures.map((signature, i) => <Chip key={signature} label={`Transaction ${i + 1} ↗`} color={C.accent} active onPress={() => void Linking.openURL(`https://solscan.io/tx/${signature}`)} />)}</View>
      <PoolYield venue={result.venue} pool={result.pool} />
      {move && result.signatures.length ? <ShareMove chain="solana" token={mint} symbol={symbol.startsWith('$') ? symbol.slice(1) : undefined} graduated={!!t.graduatedTs} tx={result.signatures[result.signatures.length - 1]} move={move} /> : null}
      <Button kind="quiet" size="sm" label="Done" onPress={() => setResult(null)} />
    </View> : null}
  </View>
}

// Disclosure for a composed zap: both steps run through the lp-zap composer in
// one transaction and its fee is taken in kind on the swapped side. Signing
// needs one acknowledgement per browser and composer program, like swaps.
function ComposedZapNotice({ plan, acknowledged, onAcknowledge }: { plan: ZapPlan; acknowledged: boolean; onAcknowledge: () => void }) {
  const program = plan.composerProgramId, recipient = plan.composerFeeRecipient, feeBps = plan.composerFeeBps ?? 10
  const inLabel = plan.direction === 'in'
  return <View style={st.composerBox} accessibilityRole="summary" accessibilityLabel="Composed zap disclosure">
    <Txt v="label" color={C.text}>One signature · composed through lp-zap</Txt>
    <Txt v="small">
      The {inLabel ? 'swap and the deposit' : 'withdrawal and the swap back'} run in one transaction through the lp-zap composer program. The {inLabel ? 'deposit is sized from what the swap actually delivers' : 'swap spends exactly what the withdrawal delivers'}, so nothing is left half-done.
    </Txt>
    <View style={st.links}>
      {program
        ? <Press onPress={() => void Linking.openURL(account(program))} accessibilityRole="link"><Txt v="monoSmall" color={C.accent}>Program {short(program, 4)} ↗</Txt></Press>
        : <Txt v="monoSmall" color={C.warn}>Program id not reported by the router</Txt>}
      <Press onPress={() => void Linking.openURL(COMPOSER_SOURCE_URL)} accessibilityRole="link"><Txt v="monoSmall" color={C.accent}>Source ↗</Txt></Press>
    </View>
    <Txt v="small" color={C.text}>Composer fee: {feeBps / 100}% of the swapped side, taken in that token{recipient ? <Txt v="monoSmall"> · paid to {short(recipient, 4)}</Txt> : null}</Txt>
    <Txt v="small" color={C.text}>What it enforces</Txt>
    <Txt v="small">Each step keeps its quoted minimum — the swap&apos;s minimum out and the venue&apos;s own deposit bounds. If any step fails, nothing happens and only the network fee is spent.</Txt>
    <Txt v="small" color={C.text}>What it does not cover</Txt>
    <Txt v="small">Prices can move before the transaction lands. When a build cannot prove every amount on chain, the server falls back to two separate transactions and says so in the run.</Txt>
    <Press onPress={acknowledged ? undefined : onAcknowledge} disabled={acknowledged} accessibilityRole="checkbox" accessibilityState={{ checked: acknowledged }}
      style={({ hovered }) => [st.ack, acknowledged && st.ackDone, hovered && !acknowledged && { opacity: 0.85 }]}>
      <View style={[st.tick, acknowledged && st.tickDone]}>{acknowledged ? <Txt v="monoSmall" color={C.bg}>✓</Txt> : null}</View>
      <Txt v="small" color={C.text} style={{ flex: 1 }}>I understand this {inLabel ? 'deposit' : 'withdrawal'} runs through the composer program and pays its fee on the swapped side.</Txt>
    </Press>
  </View>
}

const st = StyleSheet.create({
  stack: { gap: 10 },
  panel: { padding: 12, borderRadius: 14, borderWidth: 1, borderColor: C.lineStrong, backgroundColor: C.bg, gap: 8 },
  details: { gap: 6, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: C.line, backgroundColor: C.bg },
  composerBox: { gap: 6, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: C.accent + '44', backgroundColor: C.accentDim },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  ack: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: C.line },
  ackDone: { borderColor: C.accent + '66' },
  tick: { width: 18, height: 18, borderRadius: 5, borderWidth: 1, borderColor: C.muted, alignItems: 'center', justifyContent: 'center' },
  tickDone: { backgroundColor: C.accent, borderColor: C.accent },
  alternatives: { gap: 8, padding: 10, borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.raised },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  balanceRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  miniChip: { paddingHorizontal: 6, height: 20, borderRadius: 6, borderWidth: 1, borderColor: C.accent + '55', alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  poolRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  tokenButton: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, height: 40, borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.surface },
  dot: { width: 8, height: 8, borderRadius: 4 },
  amount: { flex: 1, minWidth: 0, height: 48, color: C.text, fontFamily: F.monoBold, fontSize: 26, textAlign: 'right' },
  estimate: { fontSize: 22, textAlign: 'right' },
  flipRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: -4 },
  flipLine: { flex: 1, height: 1, backgroundColor: C.line },
  flip: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: C.lineStrong, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center' },
  positionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.bg },
  primary: { height: 52, borderRadius: 14 },
})
