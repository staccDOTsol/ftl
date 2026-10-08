import { memo, useEffect, useRef, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { C, F, T } from '@/theme'
import { get } from '@/lib/api'
import { short } from '@/lib/format'
import type { Chain, FlowEvent } from '@/lib/types'
import { Ago, Press, TokenAvatar } from './ui'

// the newest token births across both chains, scrolling in from the left: the
// tape stays about liquidity while launches still give the page a heartbeat
export function LaunchTicker({ chain }: { chain?: Chain }) {
  const [result, setResult] = useState<{ chain?: Chain; items: { e: FlowEvent; fresh: boolean }[] } | null>(null)
  const seen = useRef(new Set<string>())
  const first = useRef(true)
  useEffect(() => {
    let alive = true
    seen.current = new Set()
    first.current = true
    const load = async () => {
      const evs = await get<FlowEvent[]>('/api/feed', { kinds: 'launch', chain, limit: 24 }).catch(() => null)
      if (!alive || !evs) return
      const items = evs.map(e => ({ e, fresh: !first.current && !seen.current.has(e.id) }))
      for (const e of evs) seen.current.add(e.id)
      first.current = false
      setResult({ chain, items })
    }
    void load()
    const t = setInterval(load, 3000)
    return () => { alive = false; clearInterval(t) }
  }, [chain])
  const items = result && result.chain === chain ? result.items : []
  if (!items.length) return null
  return (
    <View style={st.wrap}>
      <Text style={st.label}>LAUNCHES</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingRight: 16 }}>
        {items.map(({ e, fresh }) => <Tick key={e.id} e={e} fresh={fresh} />)}
      </ScrollView>
    </View>
  )
}

const Tick = memo(function Tick({ e, fresh }: { e: FlowEvent; fresh: boolean }) {
  const p = useSharedValue(fresh ? 0 : 1)
  useEffect(() => { if (fresh) p.value = withTiming(1, { duration: 320, easing: Easing.out(Easing.cubic) }) }, [fresh, p])
  const a = useAnimatedStyle(() => ({ opacity: p.value, transform: [{ translateX: (1 - p.value) * -14 }, { scale: 0.92 + 0.08 * p.value }] }))
  const sym = e.tokenMeta?.symbol ? e.tokenMeta.symbol.slice(0, 10) : short(e.token, 3)
  return (
    <Animated.View style={a}>
      <Press onPress={() => e.token && router.push(`/token/${e.chain}/${e.token}`)} accessibilityRole="link"
        style={({ hovered, pressed }) => [st.tick, fresh && { borderColor: C.violet + '99' }, hovered && { backgroundColor: C.hover, borderColor: C.lineStrong }, pressed && { transform: [{ scale: 0.96 }] }]}>
        <TokenAvatar image={e.tokenMeta?.image} label={sym} chain={e.chain} size={22} />
        <Text style={st.sym} numberOfLines={1}>{sym}</Text>
        <Ago ts={e.ts} style={{ fontSize: 10 }} />
      </Press>
    </Animated.View>
  )
})

const st = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 16 },
  label: { fontFamily: F.monoBold, fontSize: 9.5, letterSpacing: 1.4, color: C.violet },
  tick: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 30, paddingLeft: 4, paddingRight: 10, borderRadius: 15, borderWidth: 1, borderColor: C.line, backgroundColor: C.surface },
  sym: { fontFamily: F.display, fontSize: T.sm - 1, color: C.text, maxWidth: 90 },
})
