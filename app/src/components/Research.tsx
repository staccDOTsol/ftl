import { StyleSheet, Text, View } from 'react-native'
import { C, CHAIN, F } from '@/theme'
import { short } from '@/lib/format'
import type { ResearchCoin, ResearchCoinDetail, TokenSummary } from '@/lib/types'
import { Press, TokenAvatar, Txt } from './ui'
import { webData } from '@/lib/web-props'

const OFFICIAL_RH_TOKEN = '0xb051d6c1feb3e43b67a0a2b2aa7e0caa536614c4'

const STATUS: Record<ResearchCoin['status'], { label: string; color: string }> = {
  queued: { label: 'Warming up', color: C.warn },
  collecting: { label: 'Collecting', color: C.warn },
  ready: { label: 'Measured', color: C.good },
  insufficient_data: { label: 'Needs history', color: C.faint },
  source_unavailable: { label: 'Metrics pending', color: C.warn },
  error: { label: 'Data issue', color: C.bad },
}

const PRICE_STREAM: Record<ResearchCoin['coverage']['priceStreamState'], string> = {
  unconfigured: 'No price stream',
  observing: 'Broad feed only',
  subscribed_unverified: 'Mint stream active; market coverage still partial',
  stale: 'Stream stale',
  gap: 'Stream gap',
}

const HOLDER_STREAM: Record<ResearchCoin['coverage']['holderState'], string> = {
  unconfigured: 'Holder feed not configured',
  pending: 'Initial holder read pending',
  fetching: 'Initial holder read in progress',
  live: 'Finalized holder stream live',
  stale: 'Holder stream stale',
  unavailable: 'Holder feed unavailable',
}

type Provisional = NonNullable<ResearchCoin['provisional']>

const PROVISIONAL_STATE: Record<Provisional['state'], { label: string; color: string }> = {
  unconfigured: { label: 'Not connected', color: C.faint },
  catching_up: { label: 'Catching up', color: C.warn },
  live: { label: 'Latest head', color: C.accent },
  stale: { label: 'Stale', color: C.warn },
}

export function researchName(coin: ResearchCoin) {
  return coin.symbol ? `$${coin.symbol}` : coin.name || short(coin.address, 6)
}

export function ResearchStatus({ coin }: { coin: ResearchCoin }) {
  const s = STATUS[coin.status]
  return (
    <View style={[st.status, { borderColor: `${s.color}66`, backgroundColor: `${s.color}14` }]}>
      <View style={[st.dot, { backgroundColor: s.color }]} />
      <Txt v="monoSmall" color={s.color}>{s.label}</Txt>
    </View>
  )
}

function value(v: number | null, unit = '') {
  return v === null || !Number.isFinite(v) ? '—' : `${v.toFixed(1)}${unit}`
}

function date(ts: number | null) {
  return ts ? new Date(ts).toISOString().slice(0, 10) : '—'
}

function stamp(ts: number | null) {
  return ts ? `${new Date(ts).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '—'
}

function quoteAmount(v: number) {
  if (!Number.isFinite(v)) return '—'
  if (v === 0) return '0'
  if (Math.abs(v) >= 1) return v.toFixed(2)
  if (Math.abs(v) >= 0.01) return v.toFixed(4)
  if (Math.abs(v) >= 0.000001) return v.toFixed(8)
  return v.toExponential(2)
}

function bytes(v: number | null) {
  if (v === null || !Number.isFinite(v)) return '—'
  return v >= 1024 * 1024 ? `${(v / 1024 / 1024).toFixed(1)} MiB` : `${(v / 1024).toFixed(1)} KiB`
}

function holderPending(coin: ResearchCoin) {
  return coin.holderStrength.reason || HOLDER_STREAM[coin.coverage.holderState] || 'Holder coverage is pending.'
}

function Metric({ label, value: metric, hint }: { label: string; value: string; hint?: string }) {
  return (
    <View style={st.metric}>
      <Txt v="label">{label}</Txt>
      <Txt v="num">{metric}</Txt>
      {hint ? <Txt v="monoSmall">{hint}</Txt> : null}
    </View>
  )
}

function ProvisionalLine({ provisional }: { provisional: Provisional }) {
  const state = PROVISIONAL_STATE[provisional.state]
  const activity = provisional.state === 'live'
    ? `${provisional.holderTransferEvents ?? '—'} ERC-20 transfers · ${provisional.touchedWallets ?? '—'} addresses touched · ${provisional.knownV4SwapEvents ?? '—'} indexed v4 swaps`
    : state.label
  return <Txt v="monoSmall" color={state.color} numberOfLines={1}>Unfinalized RH activity · {activity}</Txt>
}

function ProvisionalReport({ provisional }: { provisional: Provisional }) {
  const state = PROVISIONAL_STATE[provisional.state]
  const live = provisional.state === 'live'
  return (
    <View style={st.card}>
      <View style={st.cardTitle}>
        <View style={{ flex: 1, gap: 4 }}>
          <Txt v="h2">Robinhood activity · provisional</Txt>
          <Txt v="monoSmall">Latest-head observations; unfinalized and subject to reorg rollback</Txt>
        </View>
        <Txt v="monoSmall" color={state.color}>{state.label}</Txt>
      </View>
      <View style={st.metrics}>
        <Metric label="ERC-20 transfers" value={!live || provisional.holderTransferEvents === null ? '—' : String(provisional.holderTransferEvents)} hint="events, not holder balances" />
        <Metric label="Addresses touched" value={!live || provisional.touchedWallets === null ? '—' : String(provisional.touchedWallets)} hint="distinct addresses, not people" />
        <Metric label="Indexed v4 swaps" value={!live || provisional.knownV4SwapEvents === null ? '—' : String(provisional.knownV4SwapEvents)} hint="known Uniswap v4 pools only" />
      </View>
      <Txt v="monoSmall">{provisional.observedFromBlock === null || provisional.observedThroughBlock === null
        ? 'Observed block range pending'
        : `Observed blocks ${provisional.observedFromBlock}–${provisional.observedThroughBlock}`} · finalized through {provisional.finalizedThroughBlock ?? '—'}</Txt>
      <Txt v="monoSmall">Latest complete read {stamp(provisional.observedAt)} · reorg rollbacks {provisional.rollbackCount}</Txt>
      {provisional.state !== 'live' ? <Txt v="small" color={C.warn}>Activity counts are withheld while this source is {state.label.toLowerCase()}.</Txt> : null}
      {provisional.reason ? <Txt v="small">{provisional.reason}</Txt> : null}
      <Txt v="small">This activity preview does not contribute to finalized holder strength or bottoming scores.</Txt>
    </View>
  )
}

export function ResearchRow({ coin, mode, onPress }: { coin: ResearchCoin; mode: 'holders' | 'bottoming'; onPress: () => void }) {
  const primary = mode === 'holders' ? coin.holderStrength.score : coin.bottoming.signs
  const secondary = mode === 'holders' ? coin.bottoming.signs : coin.holderStrength.score
  const official = coin.chain === 'robinhood' && coin.address.toLowerCase() === OFFICIAL_RH_TOKEN
  return (
    <Press onPress={onPress} accessibilityRole="button" accessibilityLabel={`Open research for ${researchName(coin)}`} {...webData({ 'research-row': true })}
      style={({ pressed, hovered }) => [st.row, hovered && { backgroundColor: C.hover }, pressed && { opacity: 0.72 }]}>
      <TokenAvatar image={coin.image} label={researchName(coin)} size={42} chain={coin.chain} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Txt v="h2" numberOfLines={1}>{researchName(coin)}</Txt>
        {official ? <Txt v="label" color={C.accent}>Official liquidityxyz token</Txt> : null}
        <Txt v="monoSmall" numberOfLines={1}>{CHAIN[coin.chain].label} · {coin.name || 'Unnamed'} · {short(coin.address, 6)}</Txt>
        <Txt v="monoSmall" numberOfLines={1}>{coin.liveLiquidity ? `${coin.liveLiquidity.poolInits} pools · ${coin.liveLiquidity.adds} adds · ${coin.liveLiquidity.removes} pulls${coin.coverage.priceTrades ? ` · ${coin.coverage.priceTrades} swap ${coin.coverage.priceTrades === 1 ? 'sample' : 'samples'}` : ''}` : 'Stream coverage pending'}</Txt>
        {coin.provisional ? <ProvisionalLine provisional={coin.provisional} /> : null}
        <ResearchStatus coin={coin} />
      </View>
      <View style={{ alignItems: 'flex-end', gap: 3 }}>
        <Txt v="label">{mode === 'holders' ? 'Accounts' : 'Bottom'}</Txt>
        <Txt v="num" color={primary === null ? C.faint : C.accent}>{primary === null ? '—' : mode === 'holders' ? Math.round(primary) : `${primary}/3`}</Txt>
        <Txt v="monoSmall">{mode === 'holders' ? 'Bottom' : 'Accounts'} {secondary === null ? '—' : mode === 'holders' ? `${secondary}/3` : Math.round(secondary)}</Txt>
      </View>
      <Txt v="h2" color={C.faint}>›</Txt>
    </Press>
  )
}

function bottomingPending(coin: ResearchCoin) {
  return (coin.coverage.priceWindowDays ?? 0) < 30
    ? '30 days of price history needed'
    : 'Price coverage incomplete'
}

export function ResearchSummary({ coin, token, onPress }: { coin: ResearchCoin; token?: TokenSummary; onPress: () => void }) {
  return (
    <Press onPress={onPress} accessibilityRole="button" accessibilityLabel="Open coin research"
      style={({ pressed, hovered }) => [st.summary, hovered && { backgroundColor: C.hover }, pressed && { opacity: 0.72 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Txt v="h2">Coin research</Txt>
        <ResearchStatus coin={coin} />
      </View>
      {token ? <Txt v="small">FTL live: {token.fundedPools} funded {token.fundedPools === 1 ? 'pool' : 'pools'} · {token.lpWallets} LP {token.lpWallets === 1 ? 'wallet' : 'wallets'}</Txt> : null}
      <Txt v="monoSmall">Observed LP events: {coin.liveLiquidity.poolInits} pool births · {coin.liveLiquidity.adds} adds · {coin.liveLiquidity.removes} pulls</Txt>
      {coin.provisional ? <ProvisionalLine provisional={coin.provisional} /> : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Metric label="Top-account proxy" value={coin.holderStrength.score === null ? '—' : `${Math.round(coin.holderStrength.score)}/100`} hint={coin.holderStrength.score === null ? holderPending(coin) : undefined} />
        <Metric label="Bottom signs" value={coin.bottoming.signs === null ? '—' : `${coin.bottoming.signs}/3`} hint={coin.bottoming.signs === null ? bottomingPending(coin) : undefined} />
      </View>
      <Txt v="small">View coverage, history and methods →</Txt>
    </Press>
  )
}

function Sign({ label, state }: { label: string; state: boolean | null }) {
  const color = state === true ? C.good : state === false ? C.faint : C.warn
  return (
    <View style={st.sign}>
      <Text style={{ color, fontFamily: F.monoBold, fontSize: 16 }}>{state === true ? '■' : state === false ? '□' : '·'}</Text>
      <Txt v="small" color={state === true ? C.text : C.muted}>{label}</Txt>
    </View>
  )
}

function HistoryBars({ values, color, label, format = value }: { values: number[]; color: string; label: string; format?: (v: number) => string }) {
  if (values.length < 2) return null
  const recent = values.slice(-30)
  const lo = Math.min(...recent)
  const hi = Math.max(...recent)
  const range = Math.max(hi - lo, Math.abs(hi) * 0.01, 0.000001)
  return (
    <View style={{ gap: 7 }}>
      <Txt v="label">{label}</Txt>
      <View style={st.bars} accessibilityLabel={`${label}, ${recent.length} observations`}>
        {recent.map((v, i) => <View key={i} style={{ flex: 1, height: 5 + ((v - lo) / range) * 28, backgroundColor: color, opacity: 0.45 + (i / recent.length) * 0.55, borderRadius: 2 }} />)}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Txt v="monoSmall">first {format(recent[0])}</Txt>
        <Txt v="monoSmall">latest {format(recent[recent.length - 1])}</Txt>
      </View>
    </View>
  )
}

export function ResearchReport({ coin }: { coin: ResearchCoinDetail }) {
  const h = coin.holderStrength
  const b = coin.bottoming
  const c = coin.coverage
  return (
    <View style={{ gap: 16 }}>
      {coin.provisional ? <ProvisionalReport provisional={coin.provisional} /> : null}
      <View style={st.card}>
        <View style={st.cardTitle}>
          <View style={{ flex: 1 }}>
            <Txt v="h2">Holder strength</Txt>
            <Txt v="monoSmall">Top-account persistence proxy</Txt>
          </View>
          <Txt v="title" color={h.score === null ? C.faint : C.accent}>{h.score === null ? '—' : Math.round(h.score)}</Txt>
        </View>
        {h.score === null ? <><Txt v="small">{HOLDER_STREAM[c.holderState] ?? 'Holder coverage pending'}.</Txt><Txt v="small">{holderPending(coin)}</Txt></> : <Txt v="small">Observed top accounts retained through the measurement window. Pool vaults and custodial accounts may be included; this is not a count of individual people holding.</Txt>}
        <View style={st.metrics}>
          <Metric label="Retention" value={value(h.retentionPct, '%')} />
          <Metric label="Top 20 share" value={value(h.top20SharePct, '%')} />
          <Metric label="Share change" value={value(h.top20ShareChangePct, ' pp')} />
        </View>
        <Txt v="monoSmall">Baseline {date(h.baselineTs)} · observed {date(h.observedTs)}</Txt>
        <HistoryBars values={coin.holderHistory.map(x => x.top20SharePct).filter((x): x is number => x !== null)} color={C.accent} label="Observed top-20 account share (%)" />
      </View>

      <View style={st.card}>
        <View style={st.cardTitle}>
          <View style={{ flex: 1 }}>
            <Txt v="h2">Bottoming test</Txt>
            <Txt v="monoSmall">Price and volume proxy</Txt>
          </View>
          <Txt v="title" color={b.signs === null ? C.faint : C.good}>{b.signs === null ? '—' : `${b.signs}/3`}</Txt>
        </View>
        {b.signs === null ? <><Txt v="small">{bottomingPending(coin)}.</Txt><Txt v="small">{b.reason || 'Waiting for enough 30-day price history to evaluate the signs.'}</Txt></> : <Txt v="small">Three price and volume patterns after a fall. They do not prove seller intent or forecast a rebound.</Txt>}
        <View style={{ gap: 8 }}>
          <Sign label="Selloff volume cooled" state={b.sellersCapitulated} />
          <Sign label="The low is holding" state={b.lowHolding} />
          <Sign label="Price and volume rebounded" state={b.demandReturning} />
        </View>
        <View style={st.metrics}>
          <Metric label="From 30-day high" value={value(b.drawdownPct, '%')} />
          <Metric label="Observed" value={date(b.observedTs)} />
        </View>
        {coin.priceHistory.length ? <Txt v="small">These daily values use finalized eligible swaps FTL observed. Stream coverage may have gaps, so they are not complete market candles.</Txt> : null}
        <HistoryBars values={coin.priceHistory.map(x => x.close).filter(x => Number.isFinite(x))} color={C.good} label={`Observed daily close (${coin.priceQuote ?? 'quote'} per token)`} format={quoteAmount} />
        <HistoryBars values={coin.priceHistory.map(x => x.volumeQuote).filter(x => Number.isFinite(x))} color={C.accent} label={`Observed daily quote volume (${coin.priceQuote ?? 'quote'})`} format={quoteAmount} />
      </View>

      <View style={st.card}>
        <Txt v="h2">Coverage & method</Txt>
        {coin.liveLiquidity ? <>
          <View style={st.metrics}>
            <Metric label="Pool births" value={String(coin.liveLiquidity.poolInits)} />
            <Metric label="Adds" value={String(coin.liveLiquidity.adds)} />
            <Metric label="Pulls" value={String(coin.liveLiquidity.removes)} />
          </View>
          <Txt v="monoSmall">FTL observation started {stamp(coin.liveLiquidity.observationStartTs)} · latest event {stamp(coin.liveLiquidity.lastEventTs)}</Txt>
        </> : <Txt v="small">FTL stream coverage is pending for this coin.</Txt>}
        <View style={st.metrics}>
          <Metric label="Initial holder read" value={c.holderBootstrapAttempts ? 'Attempted' : 'Not started'} hint={c.holderWindowDays === null ? undefined : `${value(c.holderWindowDays)} live days`} />
          <Metric label="Tracked accounts" value={c.holderAccounts === null || c.holderAccounts === undefined ? '—' : String(c.holderAccounts)} />
          <Metric label="Tracked owners" value={c.holderOwners === null || c.holderOwners === undefined ? '—' : String(c.holderOwners)} hint="addresses, not people" />
          <Metric label="Swap samples" value={String(c.priceTrades)} hint={coin.priceQuote === null ? undefined : `${coin.priceQuote} quote`} />
          <Metric label="Sampled days" value={coin.priceQuote === null && c.priceCandles === 0 ? 'Unavailable' : String(c.priceCandles)} hint={c.priceWindowDays === null ? undefined : `${value(c.priceWindowDays)} days`} />
        </View>
        <Txt v="small">Holder feed: {HOLDER_STREAM[c.holderState] ?? 'Coverage pending'}</Txt>
        {c.holderLastSlot != null ? <Txt v="monoSmall">Latest holder slot {c.holderLastSlot}{c.holderCoveredThroughSlot == null ? '' : ` · covered through ${c.holderCoveredThroughSlot}`}</Txt> : null}
        {c.holderBootstrapResponseBytes != null ? <Txt v="monoSmall">Initial read response {bytes(c.holderBootstrapResponseBytes)}{c.holderBootstrapPageAccounts == null ? '' : ` · ${c.holderBootstrapPageAccounts} accounts/page`}{c.holderBootstrapDbGrowthBytes == null ? '' : ` · database grew ${bytes(c.holderBootstrapDbGrowthBytes)}`}</Txt> : null}
        <Txt v="small">Price feed: {PRICE_STREAM[c.priceStreamState] ?? 'Coverage pending'}</Txt>
        {c.priceStreamReason ? <Txt v="small">{c.priceStreamReason}</Txt> : null}
        {c.priceStreamLastTs ? <Txt v="monoSmall">Latest price-stream evidence {stamp(c.priceStreamLastTs)}{c.priceStreamLagMs === null ? '' : ` · lag ${Math.round(c.priceStreamLagMs)} ms`}</Txt> : null}
        <Txt v="small">Holder source: {coin.methodology.holderSource}</Txt>
        <Txt v="small">Price source: {coin.methodology.priceSource}</Txt>
        <Txt v="small">Holder strength: {coin.methodology.holderStrength}</Txt>
        <Txt v="small">Bottoming: {coin.methodology.bottoming}</Txt>
        {coin.updatedTs ? <Txt v="monoSmall">Last calculated {stamp(coin.updatedTs)}</Txt> : null}
      </View>
    </View>
  )
}

const st = StyleSheet.create({
  status: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  dot: { width: 5, height: 5, borderRadius: 3 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line, padding: 14, minHeight: 86 },
  summary: { borderWidth: 1, borderColor: C.line, backgroundColor: C.surface, borderRadius: 12, padding: 14, gap: 12, marginHorizontal: 16 },
  card: { borderWidth: 1, borderColor: C.line, backgroundColor: C.surface, borderRadius: 14, padding: 16, gap: 14 },
  cardTitle: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  metric: { minWidth: 96, flexGrow: 1, padding: 10, gap: 5, borderWidth: 1, borderColor: C.line, borderRadius: 10, backgroundColor: C.bg },
  sign: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  bars: { height: 36, flexDirection: 'row', alignItems: 'flex-end', gap: 2, overflow: 'hidden' },
})
