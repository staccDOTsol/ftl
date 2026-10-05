import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, StyleSheet, Text, View, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import Animated, { FadeInDown, FadeOutUp } from 'react-native-reanimated'
import { C, F, KIND, MID, T } from '@/theme'
import { get } from '@/lib/api'
import { live, useLive, type LiveEvent } from '@/lib/live'
import type { Chain, FlowEvent, Kind, TokenSummary } from '@/lib/types'
import { EVENT_ROW_H, EventRow, TokenRow } from '@/components/rows'
import { Chip, Empty, Press, Screen, Seg, Skeleton, Txt } from '@/components/ui'
import { Pulse, useWide } from '@/components/NavBar'
import { LaunchTicker } from '@/components/LaunchTicker'

const KINDS: Kind[] = ['pool_init', 'liq_add', 'liq_remove', 'graduate', 'launch']
const KIND_LABEL: Record<Kind, string> = { pool_init: 'New pools', liq_add: 'Adds', liq_remove: 'Pulls', graduate: 'Grads', launch: 'Launches' }

export default function LiveScreen() {
  const l = useLive()
  const wide = useWide()
  const { width } = useWindowDimensions()
  const [chain, setChain] = useState<'all' | Chain>('all')
  const [kinds, setKinds] = useState<Kind[]>(['pool_init', 'liq_add', 'liq_remove', 'graduate'])
  const [flagged, setFlagged] = useState(false)
  const [loading, setLoading] = useState(true)
  const list = useRef<FlatList<LiveEvent>>(null)
  const feedWide = (wide ? width - 236 - 360 : width) >= MID

  useEffect(() => {
    const chains = chain === 'all' ? undefined : [chain]
    live.setFilter({ t: 'filter', chains, kinds, flaggedOnly: flagged })
    setLoading(true)
    get<FlowEvent[]>('/api/feed', { chain: chain === 'all' ? undefined : chain, kinds: kinds.join(','), flagged: flagged ? 1 : undefined, limit: 150 })
      .then(evs => live.seed(evs))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [chain, kinds.join(','), flagged])

  const toggleKind = (k: Kind) => setKinds(ks => ks.includes(k) ? (ks.length > 1 ? ks.filter(x => x !== k) : ks) : [...ks, k])

  // reading further down holds new arrivals instead of shoving the list under your thumb
  const onScroll = useCallback((ev: NativeSyntheticEvent<NativeScrollEvent>) => live.setHold(ev.nativeEvent.contentOffset.y > 80), [])
  const jumpTop = () => { list.current?.scrollToOffset({ offset: 0, animated: true }); live.setHold(false) }

  const prices = l.status?.prices
  const rowH = feedWide ? EVENT_ROW_H.wide : EVENT_ROW_H.narrow
  const solOff = (l.status?.lanes ?? []).filter(x => x.chain === 'solana').every(x => !x.enabled)

  const header = useMemo(() => (
    <View style={st.header}>
      <View style={st.titleRow}>
        <View style={{ gap: 2, flexShrink: 1, minWidth: 220 }}>
          <Text style={st.title}>{wide ? 'Live liquidity' : <>liquidity<Text style={{ color: C.accent }}>xyz</Text></>}</Text>
          <Txt v="small">Pool births, adds and pulls the moment the chain sees them</Txt>
        </View>
        {!wide ? <Pulse inline /> : null}
      </View>
      <View style={st.filters}>
        <View style={{ width: wide ? 300 : '100%' }}>
          <Seg value={chain} onChange={setChain} options={[{ value: 'all', label: 'All' }, { value: 'solana', label: 'Solana' }, { value: 'robinhood', label: 'Robinhood' }]} />
        </View>
        <View style={[st.chips, !wide && { width: '100%' }]}>
          {KINDS.map(k => <Chip key={k} label={KIND_LABEL[k]} active={kinds.includes(k)} color={KIND[k].color} onPress={() => toggleKind(k)} />)}
          <Chip label="Book flags only" active={flagged} color={C.heat} onPress={() => setFlagged(f => !f)} />
        </View>
      </View>
      {!kinds.includes('launch') ? <LaunchTicker chain={chain === 'all' ? undefined : chain} /> : null}
      {chain === 'solana' && solOff ? <Txt v="small" color={C.warn} style={{ paddingHorizontal: 16 }}>Solana lanes are starting up.</Txt> : null}
    </View>
  ), [chain, kinds, flagged, wide, solOff])

  const feed = (
    <View style={{ flex: 1, minWidth: 0 }}>
      <FlatList
        ref={list}
        data={l.events}
        keyExtractor={e => e.id}
        renderItem={({ item }) => <EventRow e={item} prices={prices} wide={feedWide} />}
        ListHeaderComponent={header}
        onScroll={onScroll}
        scrollEventThrottle={64}
        initialNumToRender={18}
        maxToRenderPerBatch={12}
        windowSize={9}
        getItemLayout={feedWide ? (_, i) => ({ length: rowH, offset: rowH * i, index: i }) : undefined}
        ListEmptyComponent={loading ? <Skeleton rows={9} height={rowH} /> : <Empty title="Waiting for liquidity" body="Nothing matches these filters yet. Pools, adds and pulls land here as the lanes see them." />}
      />
      {l.held.length ? (
        <Animated.View entering={FadeInDown.duration(180)} exiting={FadeOutUp.duration(160)} style={st.newPill}>
          <Press onPress={jumpTop} accessibilityRole="button" style={({ hovered, pressed }) => [st.newPillInner, hovered && { transform: [{ scale: 1.04 }] }, pressed && { transform: [{ scale: 0.96 }] }]}>
            <Text style={st.newPillText}>↑ {l.held.length} new</Text>
          </Press>
        </Animated.View>
      ) : null}
    </View>
  )

  return (
    <Screen>
      <View style={{ flex: 1, flexDirection: 'row' }}>
        {feed}
        {wide ? <HeatRail /> : null}
      </View>
    </Screen>
  )
}

// right rail: tokens heating up in the last hour, re-ranked as the live socket updates them
function HeatRail() {
  const l = useLive()
  const [rows, setRows] = useState<TokenSummary[] | null>(null)
  const load = useCallback(() => get<TokenSummary[]>('/api/tokens/hot', { hours: 1, limit: 14 }).then(setRows).catch(() => {}), [])
  useEffect(() => { void load(); const t = setInterval(load, 20_000); return () => clearInterval(t) }, [load])
  const ranked = useMemo(() => {
    if (!rows) return null
    return rows.map(t => ({ ...t, ...(l.tokens.get(`${t.chain}:${t.address}`) ?? {}) })).sort((a, b) => b.score - a.score)
  }, [rows, l.tokenTick])
  return (
    <View style={st.rail}>
      <View style={{ paddingHorizontal: 16, paddingTop: 22, paddingBottom: 10, gap: 2 }}>
        <Text style={st.railTitle}>Heating up</Text>
        <Txt v="small">Last hour · pools, funding, LPs and the book’s fingerprints</Txt>
      </View>
      {ranked === null ? <Skeleton rows={8} height={72} /> : ranked.length ? (
        <FlatList data={ranked} keyExtractor={t => `${t.chain}:${t.address}`} renderItem={({ item, index }) => <TokenRow t={item} rank={index + 1} spark={l.tokenRate.get(`${item.chain}:${item.address}`)} />} />
      ) : <Empty title="Quiet hour" body="Tokens show up once pools open on them." />}
    </View>
  )
}

const st = StyleSheet.create({
  header: { paddingTop: 18, paddingBottom: 12, gap: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, gap: 12, flexWrap: 'wrap' },
  title: { fontFamily: F.displayBold, fontSize: T.xxl, color: C.text, letterSpacing: -1 },
  filters: { paddingHorizontal: 16, gap: 10, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  rail: { width: 360, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: C.line },
  railTitle: { fontFamily: F.displayBold, fontSize: T.lg, color: C.text, letterSpacing: -0.4 },
  newPill: { position: 'absolute', top: 12, alignSelf: 'center' },
  newPillInner: { backgroundColor: C.accent, paddingHorizontal: 14, height: 32, borderRadius: 16, justifyContent: 'center', shadowColor: C.accent, shadowOpacity: 0.45, shadowRadius: 14, shadowOffset: { width: 0, height: 4 } },
  newPillText: { fontFamily: F.monoBold, fontSize: T.sm, color: C.accentInk },
})
