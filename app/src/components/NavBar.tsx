import { StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { ComponentProps } from 'react'
import type { Tabs } from 'expo-router'
import { C, CHAIN, F, T, WIDE } from '@/theme'
import { useLive } from '@/lib/live'
import type { Chain, LaneStatus } from '@/lib/types'
import { Press, Spark } from './ui'

const GLYPH: Record<string, string> = { index: '◉', signals: '▲', following: '♥', leaders: '★', me: '●' }
const LANE: Record<string, string> = { preconf: 'Preconfs', deshred: 'Deshred', geyser: "Dragon's Mouth", 'geyser-drpc': 'dRPC Geyser', logs: 'dRPC logs' }
export const laneLabel = (l: LaneStatus) => LANE[l.lane] ?? l.lane

type BottomTabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0]

export function useWide() { return useWindowDimensions().width >= WIDE }

// one component, two shapes: a left rail with the pulse on wide screens, a bottom bar on phones
export function NavBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const wide = useWide()
  const insets = useSafeAreaInsets()
  const items = state.routes.map((route: any, i: number) => {
    const focused = state.index === i
    const label = String(descriptors[route.key].options.title ?? route.name)
    const go = () => {
      const ev = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true })
      if (!focused && !ev.defaultPrevented) navigation.navigate(route.name as never)
    }
    return { key: route.key, name: route.name, label, focused, go }
  })

  if (!wide) {
    return (
      <View style={[st.bottom, { paddingBottom: Math.max(insets.bottom, 6) }]}>
        {items.map((it: any) => (
          <Press key={it.key} onPress={it.go} accessibilityRole="tab" accessibilityState={{ selected: it.focused }} style={({ pressed }) => [st.bottomItem, pressed && { opacity: 0.6 }]}>
            <Text style={[st.glyph, { color: it.focused ? C.accent : C.ghost }]}>{GLYPH[it.name] ?? '•'}</Text>
            <Text style={[st.bottomLabel, it.focused && { color: C.text }]}>{it.label}</Text>
          </Press>
        ))}
      </View>
    )
  }

  return (
    <View style={[st.rail, { paddingTop: insets.top + 20 }]}>
      <View style={{ paddingHorizontal: 20, gap: 2 }}>
        <Text style={st.brand}>FTL</Text>
        <Text style={st.tag}>follow the liquidity</Text>
      </View>
      <View style={{ marginTop: 24, gap: 2, paddingHorizontal: 10 }}>
        {items.map((it: any) => (
          <Press key={it.key} onPress={it.go} accessibilityRole="tab" accessibilityState={{ selected: it.focused }}
            style={({ hovered, pressed }) => [st.navItem, hovered && !it.focused && { backgroundColor: C.hover }, it.focused && { backgroundColor: C.raised }, pressed && { opacity: 0.7 }]}>
            <Text style={[st.glyph, { color: it.focused ? C.accent : C.ghost, width: 20 }]}>{GLYPH[it.name] ?? '•'}</Text>
            <Text style={[st.navLabel, it.focused && { color: C.text }]}>{it.label}</Text>
          </Press>
        ))}
      </View>
      <Pulse />
    </View>
  )
}

export function Pulse({ inline }: { inline?: boolean }) {
  const l = useLive()
  const lanes = (l.status?.lanes ?? []).filter(x => x.enabled)
  const chains: Chain[] = ['solana', 'robinhood']
  if (inline) {
    return (
      <View style={{ flexDirection: 'row', gap: 14, alignItems: 'center' }}>
        <View style={[st.liveDot, { backgroundColor: l.connected ? C.accent : C.bad }]} />
        {chains.map(c => (
          <View key={c} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={[st.chain, { color: CHAIN[c].color }]}>{CHAIN[c].short}</Text>
            <Spark values={l.flow[c]} color={CHAIN[c].color} width={44} height={14} />
            <Text style={st.rate}>{l.perMinute(c)}<Text style={st.unit}>/m</Text></Text>
          </View>
        ))}
      </View>
    )
  }
  return (
    <View style={{ marginTop: 'auto', padding: 20, gap: 16 }}>
      <View style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={[st.liveDot, { backgroundColor: l.connected ? C.accent : C.bad }]} />
          <Text style={st.section}>{l.connected ? 'LIVE' : 'RECONNECTING'}</Text>
        </View>
        {chains.map(c => (
          <View key={c} style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <Text style={[st.chain, { color: CHAIN[c].color }]}>{CHAIN[c].label}</Text>
              <Text style={st.rate}>{l.perMinute(c)}<Text style={st.unit}> /min</Text></Text>
            </View>
            <Spark values={l.flow[c]} color={CHAIN[c].color} width={180} height={22} />
          </View>
        ))}
      </View>
      <View style={{ gap: 6 }}>
        {lanes.map(x => {
          const fresh = x.lastMsgTs && Date.now() - x.lastMsgTs < 15_000
          return (
            <View key={`${x.chain}:${x.lane}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={[st.laneDot, { backgroundColor: x.connected && fresh ? C.good : x.connected ? C.warn : C.bad }]} />
              <Text style={[st.laneText, { color: CHAIN[x.chain].color }]}>{CHAIN[x.chain].short}</Text>
              <Text style={st.laneText} numberOfLines={1}>{laneLabel(x)}</Text>
              {x.p50LeadMs !== undefined && (x.lane === 'preconf' || x.lane === 'deshred') ? <Text style={[st.laneText, { color: C.warn, marginLeft: 'auto' }]}>−{x.p50LeadMs}ms</Text> : null}
            </View>
          )
        })}
      </View>
      {l.status?.prices ? <Text style={st.laneText}>SOL ${l.status.prices.SOL?.toFixed(2) ?? '—'} · ETH ${l.status.prices.ETH?.toFixed(0) ?? '—'}</Text> : null}
    </View>
  )
}

const st = StyleSheet.create({
  rail: { width: 236, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: C.line, backgroundColor: C.bg, height: '100%' },
  brand: { fontFamily: F.displayBold, fontSize: 30, color: C.accent, letterSpacing: -1.4, lineHeight: 32 },
  tag: { fontFamily: F.monoBold, fontSize: 10, color: C.faint, letterSpacing: 1.6, textTransform: 'uppercase' },
  navItem: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 38, borderRadius: 9, paddingHorizontal: 10 },
  navLabel: { fontFamily: F.bodyMedium, fontSize: T.md, color: C.muted },
  glyph: { fontFamily: F.monoBold, fontSize: 16, textAlign: 'center' },
  bottom: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line, backgroundColor: C.bg, paddingTop: 6 },
  bottomItem: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: 4 },
  bottomLabel: { fontFamily: F.bodyMedium, fontSize: 10.5, color: C.faint },
  section: { fontFamily: F.monoBold, fontSize: 10, letterSpacing: 1.6, color: C.muted },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  chain: { fontFamily: F.monoBold, fontSize: T.xs, letterSpacing: 0.4 },
  rate: { fontFamily: F.monoBold, fontSize: T.md, color: C.text, fontVariant: ['tabular-nums'] },
  unit: { fontFamily: F.mono, fontSize: T.xs, color: C.faint },
  laneDot: { width: 5, height: 5, borderRadius: 3 },
  laneText: { fontFamily: F.mono, fontSize: T.xs, color: C.faint },
})
