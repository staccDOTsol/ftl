import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { C, CHAIN, F } from '@/theme'
import { useLive } from '@/lib/live'
import type { LaneStatus } from '@/lib/types'

const LANE_LABEL: Record<string, string> = { preconf: 'Preconfs', deshred: 'Deshred', geyser: "Dragon's Mouth", 'geyser-drpc': 'dRPC Geyser', logs: 'dRPC logs' }

export function laneLabel(l: LaneStatus) { return LANE_LABEL[l.lane] ?? l.lane }

// the feeds behind the firehose: which lanes are on, live and how far ahead they run
export function LaneBar() {
  const live = useLive()
  const lanes = (live.status?.lanes ?? []).filter(l => l.enabled)
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.wrap}>
      <View style={[st.pill, { borderColor: live.connected ? C.accent + '55' : C.bad + '55' }]}>
        <View style={[st.dot, { backgroundColor: live.connected ? C.accent : C.bad }]} />
        <Text style={st.text}>{live.connected ? 'live' : 'reconnecting'}</Text>
      </View>
      {lanes.map(l => {
        const fresh = l.lastMsgTs && Date.now() - l.lastMsgTs < 15_000
        return (
          <View key={`${l.chain}:${l.lane}`} style={st.pill}>
            <View style={[st.dot, { backgroundColor: l.connected && fresh ? C.good : l.connected ? C.warn : C.bad }]} />
            <Text style={[st.text, { color: CHAIN[l.chain].color }]}>{CHAIN[l.chain].short}</Text>
            <Text style={st.text}>{laneLabel(l)}</Text>
            {l.p50LeadMs !== undefined && l.lane !== 'geyser' && l.lane !== 'geyser-drpc' ? <Text style={[st.text, { color: C.warn }]}>-{l.p50LeadMs}ms</Text> : null}
          </View>
        )
      })}
    </ScrollView>
  )
}

const st = StyleSheet.create({
  wrap: { gap: 6, paddingHorizontal: 16, paddingVertical: 6 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderColor: C.line, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4, backgroundColor: C.surface },
  dot: { width: 6, height: 6, borderRadius: 3 },
  text: { fontFamily: F.mono, fontSize: 11, color: C.muted },
})
