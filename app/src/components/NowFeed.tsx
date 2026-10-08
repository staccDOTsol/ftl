import { eventLink } from '@/lib/event-context'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import { C, CHAIN, F, KIND, T } from '@/theme'
import { get } from '@/lib/api'
import { ago, num, quoteSymbol, short } from '@/lib/format'
import { useLive } from '@/lib/live'
import { useNow } from '@/lib/useNow'
import type { FlowEvent, Post, TokenSummary } from '@/lib/types'
import { PostItem } from '@/components/Posts'
import { Button, Empty, Section, TokenAvatar, Txt } from '@/components/ui'

// The first screen is a short social room. The full transaction tape stays one
// tap away for people who want every venue and filter.
const OFFICIAL_TOKEN_CA = '0xb051d6c1feb3e43b67a0a2b2aa7e0caa536614c4'

export function NowFeed({ onFullFeed }: { onFullFeed: () => void }) {
  const live = useLive()
  const now = useNow(3000)
  const [calls, setCalls] = useState<Post[]>([])
  const [loaded, setLoaded] = useState(false)
  const [feedError, setFeedError] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    const [events, posts] = await Promise.allSettled([
      get<FlowEvent[]>('/api/feed', { after: Date.now() - 3600_000, limit: 300 }),
      get<Post[]>('/api/posts', { kind: 'call', limit: 8 }),
    ])
    if (events.status === 'fulfilled') { live.seed(events.value); setFeedError(false) }
    else setFeedError(true)
    if (posts.status === 'fulfilled') setCalls(posts.value)
    setLoaded(true)
    setRefreshing(false)
  }, [live])

  useEffect(() => {
    const first = setTimeout(() => void load(), 0)
    return () => clearTimeout(first)
  }, [load])

  const confirmed = useMemo(() => live.events
    .filter(e => e.stage === 'confirmed' && e.token && (e.confirmedTs ?? e.ts) > now - 3600_000)
    .sort((a, b) => (b.confirmedTs ?? b.ts) - (a.confirmedTs ?? a.ts)), [live.events, now])
  const latest = confirmed.slice(0, 7)
  const currentMoves = (() => {
    const seen = new Set<string>()
    return confirmed.filter(e => {
      const key = `${e.chain}:${e.token}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, 5).map(e => ({ event: e, token: live.tokens.get(`${e.chain}:${e.token}`) }))
  })()
  const currentCalls = (() => {
    const byId = new Map(calls.map(p => [p.id, p]))
    for (const p of live.posts) if (p.kind === 'call') byId.set(p.id, p)
    return [...byId.values()].sort((a, b) => b.ts - a.ts).slice(0, 8)
  })()
  return (
    <ScrollView refreshControl={<RefreshControl refreshing={refreshing} tintColor={C.accent} onRefresh={() => { setRefreshing(true); void load() }} />} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={st.hero}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={st.heading}>Now<Text style={{ color: C.accent }}>.</Text></Text>
          <Txt v="small">The move, the token, and the people who called it.</Txt>
        </View>
        <Button label="Full feed →" kind="ghost" onPress={onFullFeed} />
      </View>

      <View style={st.official}>
        <Pressable
          onPress={() => router.push(`/token/robinhood/${OFFICIAL_TOKEN_CA}`)}
          accessibilityRole="button"
          accessibilityLabel={`Open official liquidityxyz token on Robinhood Chain: ${OFFICIAL_TOKEN_CA}`}
          style={({ pressed }) => [st.officialMain, pressed && { opacity: 0.7 }]}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={st.officialTitle}>OFFICIAL TOKEN <Text style={{ color: C.text }}>LXYZ</Text></Text>
            <Text style={st.officialDetail}>Robinhood Chain · {short(OFFICIAL_TOKEN_CA, 6)}</Text>
          </View>
          <Text style={st.officialLink}>OPEN →</Text>
        </Pressable>
      </View>

      <Section title="Fresh moves · 1h" right={<Txt v="monoSmall">CONFIRMED</Txt>}>
        {currentMoves.length ? currentMoves.map(({ event, token }) => <ActivityRow key={`${event.chain}:${event.token}`} event={event} token={token} now={now} prices={live.status?.prices} />)
          : loaded ? <Empty title={feedError ? 'Checking live moves' : 'Quiet hour'} body={feedError ? 'The recent feed is reconnecting.' : 'Confirmed pool and liquidity moves appear here.'} /> : <Txt v="small" style={st.placeholder}>Loading the room…</Txt>}
      </Section>

      <Section title="Just hit chain" right={<Pressable onPress={onFullFeed}><Txt v="monoSmall" color={C.accent}>ALL MOVES →</Txt></Pressable>}>
        {latest.length ? latest.map(e => <MoveRow key={e.id} event={e} now={now} />)
          : <Empty title="Waiting for the next move" body="Confirmed pool births, adds and pulls show up here." />}
      </Section>

      <Section title="Calls from the room" right={<Txt v="monoSmall">NEWEST</Txt>}>
        {currentCalls.length ? currentCalls.map(p => <PostItem key={p.id} p={p} now={now} showToken />)
          : loaded ? <Empty title="First call is still open" body="Open a token on its curve and post what you see. Calls are scored when it graduates." /> : <Txt v="small" style={st.placeholder}>Loading calls…</Txt>}
      </Section>
    </ScrollView>
  )
}

const STABLE_QUOTES = new Set(['USDC', 'USDT', 'USDG', 'USD1', 'PYUSD'])

// Keep the real event visible, but omit a size below roughly one USD of quote.
// Live marks are preferred; the fallback units are only for display precision.
function displayableQuoteSize(amount: number | null, quote: string | undefined, prices?: Record<string, number>) {
  if (amount === null || !Number.isFinite(amount) || amount <= 0 || !quote) return false
  const mark = STABLE_QUOTES.has(quote) ? 1 : quote === 'SOL' ? prices?.SOL : quote === 'ETH' || quote === 'WETH' ? prices?.ETH : undefined
  const fallback: Record<string, number> = { SOL: 0.01, ETH: 0.0005, WETH: 0.0005 }
  const min = mark && Number.isFinite(mark) && mark > 0 ? 1 / mark : fallback[quote] ?? 1
  return amount >= min
}

function ActivityRow({ event: e, token: t, now, prices }: { event: FlowEvent; token?: TokenSummary; now: number; prices?: Record<string, number> }) {
  const label = t?.symbol || e.tokenMeta?.symbol ? `$${t?.symbol || e.tokenMeta?.symbol}` : short(e.token)
  const open = () => { if (e.token) router.push(eventLink(e)) }
  const action = e.kind === 'liq_add' ? 'Liquidity in' : e.kind === 'liq_remove' ? 'Liquidity out' : KIND[e.kind].label
  const quote = quoteSymbol(e.quote)
  const size = (e.kind === 'liq_add' || e.kind === 'liq_remove') && displayableQuoteSize(e.quoteUi, quote, prices) ? `${num(e.quoteUi)} ${quote}` : null
  const subtitle = [action, size, `${ago(e.confirmedTs ?? e.ts, now)} ago`, CHAIN[e.chain].short].filter(Boolean).join(' · ')
  return (
    <Pressable onPress={open} style={st.hotRow} accessibilityRole="button">
      <View style={[st.moveDot, { backgroundColor: KIND[e.kind].color }]} />
      <TokenAvatar image={t?.image || e.tokenMeta?.image} label={label} chain={e.chain} size={42} />
      <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
        <Text style={st.token} numberOfLines={1}>{label}</Text>
        <Text style={st.sub} numberOfLines={1}>{subtitle}</Text>
      </View>
      <Text style={st.action}>{t?.graduatedTs || e.kind === 'graduate' ? 'OPEN →' : 'CALL IT →'}</Text>
    </Pressable>
  )
}

function MoveRow({ event: e, now }: { event: FlowEvent; now: number }) {
  const label = e.tokenMeta?.symbol ? `$${e.tokenMeta.symbol}` : e.token ? short(e.token) : e.venue
  const action = e.kind === 'liq_add' ? 'liquidity in' : e.kind === 'liq_remove' ? 'liquidity out' : KIND[e.kind].label.toLowerCase()
  const color = KIND[e.kind].color
  const open = () => { if (e.token) router.push(eventLink(e)) }
  return (
    <Pressable onPress={open} disabled={!e.token} style={st.moveRow} accessibilityRole="button">
      <View style={[st.moveDot, { backgroundColor: color }]} />
      <Text style={st.moveText} numberOfLines={1}><Text style={{ color: C.text, fontFamily: F.monoBold }}>{label}</Text>  {action}</Text>
      <Text style={st.time}>{ago(e.confirmedTs ?? e.ts, now)}</Text>
    </Pressable>
  )
}

const st = StyleSheet.create({
  hero: { padding: 16, paddingTop: 22, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  heading: { fontFamily: F.displayBold, fontSize: 36, color: C.text, letterSpacing: -1.5 },
  official: { minHeight: 52, flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 8, backgroundColor: C.raised, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  officialMain: { flex: 1, minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  officialTitle: { fontFamily: F.monoBold, fontSize: 10, letterSpacing: 1, color: C.accent },
  officialDetail: { fontFamily: F.mono, fontSize: T.xs, color: C.muted },
  officialLink: { fontFamily: F.monoBold, fontSize: 10, color: C.accent },
  placeholder: { paddingHorizontal: 16, paddingVertical: 24 },
  hotRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 66, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  token: { fontFamily: F.displayBold, fontSize: T.md, color: C.text },
  sub: { fontFamily: F.body, fontSize: T.xs, color: C.muted },
  action: { fontFamily: F.monoBold, fontSize: 10, color: C.accent },
  moveRow: { flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 48, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  moveDot: { width: 7, height: 7, borderRadius: 4 },
  moveText: { flex: 1, fontFamily: F.body, fontSize: T.sm, color: C.muted },
  time: { fontFamily: F.mono, fontSize: T.xs, color: C.faint },
})
