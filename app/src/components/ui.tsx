import { memo, useState, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type PressableProps, type StyleProp, type TextStyle, type ViewStyle } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Image } from 'expo-image'
import { C, CHAIN, F, FLAG, MAX_W, T } from '@/theme'
import { ago, img } from '@/lib/format'
import { useClock } from '@/lib/clock'
import type { Chain, Flag } from '@/lib/types'

type TxtVariant = 'title' | 'h1' | 'h2' | 'body' | 'small' | 'label' | 'mono' | 'monoSmall' | 'num'
export function Txt({ v = 'body', color, style, children, numberOfLines, selectable }: { v?: TxtVariant; color?: string; style?: StyleProp<TextStyle>; children: ReactNode; numberOfLines?: number; selectable?: boolean }) {
  return <Text selectable={selectable} numberOfLines={numberOfLines} style={[t[v], color ? { color } : null, style]}>{children}</Text>
}

export const t = StyleSheet.create({
  title: { fontFamily: F.displayBold, fontSize: T.xxl, color: C.text, letterSpacing: -0.8, lineHeight: 32 },
  h1: { fontFamily: F.displayBold, fontSize: T.xl, color: C.text, letterSpacing: -0.5 },
  h2: { fontFamily: F.display, fontSize: T.md, color: C.text, letterSpacing: -0.2 },
  body: { fontFamily: F.body, fontSize: T.md, color: C.text, lineHeight: 22 },
  small: { fontFamily: F.body, fontSize: T.sm, color: C.muted, lineHeight: 19 },
  label: { fontFamily: F.monoBold, fontSize: 10, color: C.faint, letterSpacing: 1.1, textTransform: 'uppercase' },
  mono: { fontFamily: F.mono, fontSize: T.sm, color: C.text },
  monoSmall: { fontFamily: F.mono, fontSize: T.xs, color: C.faint },
  num: { fontFamily: F.monoBold, fontSize: T.md, color: C.text, fontVariant: ['tabular-nums'] },
})

// every press target in the app: hover, focus ring, pressed, disabled
type PressState = { pressed: boolean; hovered?: boolean; focused?: boolean }
export function Press({ style, children, disabled, ...rest }: Omit<PressableProps, 'style' | 'children'> & { style?: (s: PressState) => StyleProp<ViewStyle>; children: ReactNode | ((s: PressState) => ReactNode) }) {
  return (
    <Pressable disabled={disabled} {...rest} style={(s) => {
      const st = s as PressState
      return [style?.(st), st.focused ? { outlineColor: C.accent, outlineWidth: 2, outlineStyle: 'solid' } as any : null, disabled ? { opacity: 0.45 } : null]
    }}>
      {children as any}
    </Pressable>
  )
}

export function Screen({ children, edges = ['top'] }: { children: ReactNode; edges?: ('top' | 'bottom')[] }) {
  return (
    <SafeAreaView edges={edges} style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ flex: 1, width: '100%', maxWidth: MAX_W, alignSelf: 'center' }}>{children}</View>
    </SafeAreaView>
  )
}

export function Chip({ label, active, onPress, color, count }: { label: string; active?: boolean; onPress?: () => void; color?: string; count?: number }) {
  const c = color ?? C.accent
  return (
    <Press onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: !!active }} hitSlop={4}
      style={({ pressed, hovered }) => [s.chip, hovered && !active && { borderColor: C.lineStrong, backgroundColor: C.hover }, active && { borderColor: c + 'AA', backgroundColor: c + '1F' }, pressed && { transform: [{ scale: 0.96 }] }, !onPress && { opacity: 0.85 }]}>
      <View style={[s.chipDot, { backgroundColor: active ? c : count ? c + '99' : C.ghost }]} />
      <Text style={[s.chipText, active && { color: C.text, fontFamily: F.display }]}>{label}</Text>
      {count !== undefined ? <View style={[s.chipCountWrap, active && { backgroundColor: c + '33' }]}><Text style={[s.chipCount, active && { color: C.text }]}>{count}</Text></View> : null}
    </Press>
  )
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <View style={s.seg} accessibilityRole="tablist">
      {options.map(o => (
        <Press key={o.value} onPress={() => onChange(o.value)} accessibilityRole="tab" accessibilityState={{ selected: value === o.value }}
          style={({ hovered, pressed }) => [s.segItem, hovered && value !== o.value && { backgroundColor: C.hover }, value === o.value && s.segActive, pressed && { opacity: 0.8 }]}>
          <Text style={[s.segText, value === o.value && { color: C.text }]}>{o.label}</Text>
        </Press>
      ))}
    </View>
  )
}

export function ChainDot({ chain, size = 8 }: { chain: Chain; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size, backgroundColor: CHAIN[chain].color }} />
}

export function ChainBadge({ chain }: { chain: Chain }) {
  return <Text style={[s.badgeText, { color: CHAIN[chain].color }]}>{CHAIN[chain].short}</Text>
}

export function FlagChips({ flags, max = 4 }: { flags: Flag[]; max?: number }) {
  const shown = flags.filter(f => f !== 'first_pool' || flags.length === 1).sort((a, b) => Number(FLAG[b].hot) - Number(FLAG[a].hot)).slice(0, max)
  if (!shown.length) return null
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
      {shown.map(f => (
        <View key={f} style={[s.flag, { backgroundColor: FLAG[f].color + (FLAG[f].hot ? '26' : '14'), borderColor: FLAG[f].color + (FLAG[f].hot ? '80' : '40') }]}>
          <Text style={[s.flagText, { color: FLAG[f].color }]}>{FLAG[f].label}</Text>
        </View>
      ))}
    </View>
  )
}

export const TokenAvatar = memo(function TokenAvatar({ image, label, size = 36, chain }: { image?: string; label: string; size?: number; chain?: Chain }) {
  const [failed, setFailed] = useState(false)
  const letter = label.replace('$', '').slice(0, 2).toUpperCase()
  const src = !failed ? img(image, size) : undefined
  // initials get a stable hue from the label so the tape is never a wall of grey discs
  let h = 0
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) % 360
  return (
    <View style={{ width: size, height: size }}>
      <View style={{ width: size, height: size, borderRadius: size / 2, overflow: 'hidden', backgroundColor: `hsl(${h}, 30%, 22%)`, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontFamily: F.displayBold, fontSize: size * 0.36, color: `hsl(${h}, 60%, 78%)` }}>{letter || '?'}</Text>
        {src ? <Image source={{ uri: src }} onError={() => setFailed(true)} style={StyleSheet.absoluteFill} contentFit="cover" transition={180} cachePolicy="memory-disk" recyclingKey={src} /> : null}
      </View>
      {chain ? <View style={{ position: 'absolute', right: -2, bottom: -2, width: Math.max(9, size * 0.32), height: Math.max(9, size * 0.32), borderRadius: size, backgroundColor: CHAIN[chain].color, borderWidth: 2, borderColor: C.bg }} /> : null}
    </View>
  )
})

export function Ago({ ts, style }: { ts: number; style?: StyleProp<TextStyle> }) {
  const now = useClock()
  return <Text style={[t.monoSmall, style]}>{ago(ts, now)}</Text>
}

// tiny bar sparkline drawn with views: works the same on web, iOS and Android
export function Spark({ values, color, height = 18, width = 60 }: { values: number[]; color: string; height?: number; width?: number }) {
  const max = Math.max(1, ...values)
  const w = width / values.length
  return (
    <View style={{ width, height, flexDirection: 'row', alignItems: 'flex-end', gap: 1 }}>
      {values.map((v, i) => <View key={i} style={{ width: Math.max(1, w - 1), height: Math.max(1, (v / max) * height), borderRadius: 1, backgroundColor: v ? color : C.line, opacity: v ? 0.35 + 0.65 * (i / values.length) : 1 }} />)}
    </View>
  )
}

// Weight ladder: one primary per view, ghost for secondary, quiet for tertiary.
// Sizes keep tertiary actions from reading as big mint slabs.
export function Button({ label, onPress, kind = 'primary', size = 'md', disabled, busy, style }: { label: string; onPress?: () => void; kind?: 'primary' | 'ghost' | 'quiet'; size?: 'sm' | 'md' | 'lg'; disabled?: boolean; busy?: boolean; style?: StyleProp<ViewStyle> }) {
  const height = size === 'sm' ? 32 : size === 'lg' ? 52 : 44
  const fontSize = size === 'sm' ? T.sm : size === 'lg' ? T.lg : T.md
  return (
    <Press disabled={disabled || busy} onPress={onPress} accessibilityRole="button" accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      style={({ pressed, hovered }) => [s.btn, { height, borderRadius: size === 'sm' ? 9 : 12, paddingHorizontal: size === 'sm' ? 12 : 18 }, kind === 'primary' ? s.btnPrimary : kind === 'ghost' ? s.btnGhost : s.btnQuiet,
        hovered && (kind === 'primary' ? { backgroundColor: C.accent, shadowColor: C.accent, shadowOpacity: 0.45, shadowRadius: 18, shadowOffset: { width: 0, height: 4 } } : { backgroundColor: C.hover, borderColor: C.lineStrong }),
        pressed && { transform: [{ scale: 0.97 }] }, style]}>
      {busy ? <ActivityIndicator color={kind === 'primary' ? C.accentInk : C.text} /> : <Text style={[s.btnText, { fontSize }, kind === 'primary' && { color: C.accentInk }, kind === 'quiet' && { color: C.muted }]}>{label}</Text>}
    </Press>
  )
}

export function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <View style={s.stat}>
      <Text style={[t.label]}>{label}</Text>
      <Text style={[t.num, { fontSize: T.lg }, color ? { color } : null]}>{value}</Text>
    </View>
  )
}

export function Empty({ title, body, children }: { title: string; body?: string; children?: ReactNode }) {
  return (
    <View style={{ paddingVertical: 48, paddingHorizontal: 24, alignItems: 'center', gap: 8 }}>
      <View style={s.emptyRing}><View style={s.emptyDot} /></View>
      <Txt v="h2" style={{ textAlign: 'center' }}>{title}</Txt>
      {body ? <Txt v="small" style={{ textAlign: 'center', maxWidth: 380 }}>{body}</Txt> : null}
      {children}
    </View>
  )
}

export function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <View style={{ marginTop: 24 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, marginBottom: 8 }}>
        <Txt v="label">{title}</Txt>
        {right}
      </View>
      {children}
    </View>
  )
}

// skeleton rows while the first page loads: the shape of the data, not a spinner
export function Skeleton({ rows = 8, height = 56 }: { rows?: number; height?: number }) {
  return (
    <View>
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={{ height, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line, opacity: 1 - i * 0.09 }}>
          <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: C.raised }} />
          <View style={{ flex: 1, gap: 6 }}>
            <View style={{ width: `${40 + ((i * 37) % 30)}%`, height: 10, borderRadius: 4, backgroundColor: C.raised }} />
            <View style={{ width: `${20 + ((i * 53) % 25)}%`, height: 8, borderRadius: 4, backgroundColor: C.surface }} />
          </View>
          <View style={{ width: 54, height: 12, borderRadius: 4, backgroundColor: C.raised }} />
        </View>
      ))}
    </View>
  )
}

export function Loading() {
  return <View style={{ padding: 40, alignItems: 'center' }}><ActivityIndicator color={C.accent} /></View>
}

export const s = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, height: 30, borderRadius: 8, borderWidth: 1, borderColor: C.line, backgroundColor: C.surface },
  chipDot: { width: 6, height: 6, borderRadius: 3 },
  chipText: { fontFamily: F.bodyMedium, fontSize: T.sm, color: C.muted },
  chipCount: { fontFamily: F.monoBold, fontSize: 10, color: C.muted },
  chipCountWrap: { minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, backgroundColor: C.raised, alignItems: 'center', justifyContent: 'center' },
  seg: { flexDirection: 'row', backgroundColor: C.surface, borderRadius: 10, padding: 3, borderWidth: 1, borderColor: C.line, gap: 2 },
  segItem: { flex: 1, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 7, paddingHorizontal: 10 },
  segActive: { backgroundColor: C.raised, shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
  segText: { fontFamily: F.bodyMedium, fontSize: T.sm, color: C.faint },
  badgeText: { fontFamily: F.monoBold, fontSize: 10, letterSpacing: 0.6 },
  flag: { borderWidth: 1, borderRadius: 5, paddingHorizontal: 5, height: 18, justifyContent: 'center' },
  flagText: { fontFamily: F.monoBold, fontSize: 9.5, letterSpacing: 0.5 },
  btn: { height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  btnPrimary: { backgroundColor: C.accent },
  btnGhost: { borderWidth: 1, borderColor: C.line, backgroundColor: C.surface },
  btnQuiet: { backgroundColor: 'transparent' },
  btnText: { fontFamily: F.display, fontSize: T.md, color: C.text },
  stat: { flex: 1, minWidth: 96, padding: 12, borderRadius: 12, backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, gap: 4 },
  emptyRing: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: C.lineStrong, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  emptyDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.accent },
})
