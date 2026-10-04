import { useEffect, useMemo, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { C, F, KIND } from '@/theme'
import { get } from '@/lib/api'
import { live, useLive } from '@/lib/live'
import { useNow } from '@/lib/useNow'
import type { Chain, FlowEvent, Kind } from '@/lib/types'
import { EventRow } from '@/components/rows'
import { Chip, Empty, Screen, Seg, Txt } from '@/components/ui'
import { LaneBar } from '@/components/LaneBar'

const KINDS: Kind[] = ['pool_init', 'liq_add', 'liq_remove', 'graduate', 'launch']

export default function LiveScreen() {
  const l = useLive()
  const now = useNow(3000)
  const [chain, setChain] = useState<'all' | Chain>('all')
  const [kinds, setKinds] = useState<Kind[]>(['pool_init', 'liq_add', 'liq_remove', 'graduate'])
  const [flagged, setFlagged] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const chains = chain === 'all' ? undefined : [chain]
    live.setFilter({ t: 'filter', chains, kinds, flaggedOnly: flagged })
    setLoading(true)
    get<FlowEvent[]>('/api/feed', { chain: chain === 'all' ? undefined : chain, kinds: kinds.join(','), flagged: flagged ? 1 : undefined, limit: 120 })
      .then(evs => live.seed(evs))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [chain, kinds.join(','), flagged])

  const toggleKind = (k: Kind) => setKinds(ks => ks.includes(k) ? (ks.length > 1 ? ks.filter(x => x !== k) : ks) : [...ks, k])
  const data = l.events

  const header = useMemo(() => (
    <View style={st.header}>
      <View style={st.brandRow}>
        <View>
          <Text style={st.brand}>FTL</Text>
          <Txt v="small">Follow the liquidity · pool births, adds and pulls as they land</Txt>
        </View>
        <Pressable onPress={() => live.setPaused(!live.isPaused)} style={[st.pause, live.isPaused && { borderColor: C.warn }]}>
          <Text style={[st.pauseText, live.isPaused && { color: C.warn }]}>{live.isPaused ? `▶ ${live.heldCount}` : '❚❚'}</Text>
        </Pressable>
      </View>
      <LaneBar />
      <View style={{ paddingHorizontal: 16, gap: 10, paddingTop: 6 }}>
        <Seg value={chain} onChange={setChain} options={[{ value: 'all', label: 'All chains' }, { value: 'solana', label: 'Solana' }, { value: 'robinhood', label: 'Robinhood' }]} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {KINDS.map(k => <Chip key={k} small label={KIND[k].label + (k === 'launch' ? 'es' : 's')} active={kinds.includes(k)} color={KIND[k].color} onPress={() => toggleKind(k)} />)}
          <Chip small label="⚑ book flags only" active={flagged} color="#FF6B3D" onPress={() => setFlagged(f => !f)} />
        </View>
      </View>
    </View>
  ), [chain, kinds, flagged, l.isPaused, l.heldCount])

  return (
    <Screen>
      <FlatList
        data={data}
        keyExtractor={e => e.id}
        renderItem={({ item }) => <EventRow e={item} now={now} />}
        ListHeaderComponent={header}
        stickyHeaderIndices={[]}
        initialNumToRender={20}
        windowSize={11}
        ListEmptyComponent={loading ? null : <Empty title="Waiting for liquidity" body="Nothing matches these filters yet. New pools, adds and pulls stream in as the lanes see them." />}
      />
    </Screen>
  )
}

const st = StyleSheet.create({
  header: { paddingTop: 8, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line, gap: 4 },
  brandRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  brand: { fontFamily: F.displayBold, fontSize: 30, color: C.accent, letterSpacing: -1 },
  pause: { borderWidth: 1, borderColor: C.lineStrong, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: C.surface },
  pauseText: { fontFamily: F.monoBold, fontSize: 13, color: C.text },
})
