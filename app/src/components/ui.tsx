import { type ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Image } from 'expo-image'
import { C, CHAIN, F, FLAG, MAX_W } from '@/theme'
import type { Chain, Flag } from '@/lib/types'

type TxtVariant = 'title' | 'h2' | 'body' | 'small' | 'label' | 'mono' | 'monoSmall' | 'num'
export function Txt({ v = 'body', color, style, children, numberOfLines, selectable }: { v?: TxtVariant; color?: string; style?: StyleProp<TextStyle>; children: ReactNode; numberOfLines?: number; selectable?: boolean }) {
  return <Text selectable={selectable} numberOfLines={numberOfLines} style={[t[v], color ? { color } : null, style]}>{children}</Text>
}

const t = StyleSheet.create({
  title: { fontFamily: F.displayBold, fontSize: 26, color: C.text, letterSpacing: -0.5 },
  h2: { fontFamily: F.display, fontSize: 17, color: C.text, letterSpacing: -0.2 },
  body: { fontFamily: F.body, fontSize: 15, color: C.text, lineHeight: 21 },
  small: { fontFamily: F.body, fontSize: 13, color: C.muted, lineHeight: 18 },
  label: { fontFamily: F.bodyMedium, fontSize: 11, color: C.muted, letterSpacing: 0.8, textTransform: 'uppercase' },
  mono: { fontFamily: F.mono, fontSize: 13, color: C.text },
  monoSmall: { fontFamily: F.mono, fontSize: 11, color: C.muted },
  num: { fontFamily: F.monoBold, fontSize: 15, color: C.text },
})

export function Screen({ children, edges = ['top'] }: { children: ReactNode; edges?: ('top' | 'bottom')[] }) {
  return (
    <SafeAreaView edges={edges} style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ flex: 1, width: '100%', maxWidth: MAX_W, alignSelf: 'center' }}>{children}</View>
    </SafeAreaView>
  )
}

export function Chip({ label, active, onPress, color, small }: { label: string; active?: boolean; onPress?: () => void; color?: string; small?: boolean }) {
  return (
    <Pressable onPress={onPress} hitSlop={6} style={({ pressed }) => [s.chip, small && s.chipSmall, active && { backgroundColor: color ?? C.accent, borderColor: color ?? C.accent }, pressed && { opacity: 0.7 }]}>
      <Text style={[s.chipText, small && { fontSize: 11 }, active && { color: C.accentInk }]}>{label}</Text>
    </Pressable>
  )
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <View style={s.seg}>
      {options.map(o => (
        <Pressable key={o.value} onPress={() => onChange(o.value)} style={[s.segItem, value === o.value && s.segActive]}>
          <Text style={[s.segText, value === o.value && { color: C.text }]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  )
}

export function ChainBadge({ chain }: { chain: Chain }) {
  return (
    <View style={[s.badge, { borderColor: CHAIN[chain].color + '55' }]}>
      <Text style={[s.badgeText, { color: CHAIN[chain].color }]}>{CHAIN[chain].short}</Text>
    </View>
  )
}

export function FlagChips({ flags, max = 4 }: { flags: Flag[]; max?: number }) {
  const shown = flags.filter(f => f !== 'first_pool' || flags.length === 1).slice(0, max)
  if (!shown.length) return null
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
      {shown.map(f => (
        <View key={f} style={[s.flag, { backgroundColor: FLAG[f].color + '1F', borderColor: FLAG[f].color + '55' }]}>
          <Text style={[s.flagText, { color: FLAG[f].color }]}>{FLAG[f].label}</Text>
        </View>
      ))}
    </View>
  )
}

export function TokenAvatar({ image, label, size = 36, chain }: { image?: string; label: string; size?: number; chain?: Chain }) {
  const letter = label.replace('$', '').slice(0, 2).toUpperCase()
  return (
    <View style={{ width: size, height: size }}>
      {image ? (
        <Image source={{ uri: image }} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: C.raised }} contentFit="cover" transition={150} />
      ) : (
        <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: C.raised, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.line }}>
          <Text style={{ fontFamily: F.display, fontSize: size * 0.36, color: C.muted }}>{letter || '?'}</Text>
        </View>
      )}
      {chain ? <View style={{ position: 'absolute', right: -1, bottom: -1, width: size * 0.34, height: size * 0.34, borderRadius: size, backgroundColor: CHAIN[chain].color, borderWidth: 2, borderColor: C.bg }} /> : null}
    </View>
  )
}

export function Button({ label, onPress, kind = 'primary', disabled, busy, style }: { label: string; onPress?: () => void; kind?: 'primary' | 'ghost' | 'quiet'; disabled?: boolean; busy?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable disabled={disabled || busy} onPress={onPress} style={({ pressed }) => [s.btn, kind === 'primary' ? s.btnPrimary : kind === 'ghost' ? s.btnGhost : s.btnQuiet, (pressed || disabled) && { opacity: 0.6 }, style]}>
      {busy ? <ActivityIndicator color={kind === 'primary' ? C.accentInk : C.text} /> : <Text style={[s.btnText, kind === 'primary' && { color: C.accentInk }]}>{label}</Text>}
    </Pressable>
  )
}

export function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <View style={s.stat}>
      <Text style={[t.num, { fontSize: 18 }, color ? { color } : null]}>{value}</Text>
      <Text style={t.label}>{label}</Text>
    </View>
  )
}

export function Empty({ title, body, children }: { title: string; body?: string; children?: ReactNode }) {
  return (
    <View style={{ padding: 32, alignItems: 'center', gap: 8 }}>
      <Txt v="h2" style={{ textAlign: 'center' }}>{title}</Txt>
      {body ? <Txt v="small" style={{ textAlign: 'center', maxWidth: 360 }}>{body}</Txt> : null}
      {children}
    </View>
  )
}

export function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <View style={{ marginTop: 20 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, marginBottom: 8 }}>
        <Txt v="label">{title}</Txt>
        {right}
      </View>
      {children}
    </View>
  )
}

export function Loading() {
  return <View style={{ padding: 40, alignItems: 'center' }}><ActivityIndicator color={C.accent} /></View>
}

export const s = StyleSheet.create({
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: C.lineStrong, backgroundColor: C.surface },
  chipSmall: { paddingHorizontal: 9, paddingVertical: 4 },
  chipText: { fontFamily: F.bodyMedium, fontSize: 13, color: C.text },
  seg: { flexDirection: 'row', backgroundColor: C.surface, borderRadius: 10, padding: 3, borderWidth: 1, borderColor: C.line },
  segItem: { flex: 1, paddingVertical: 7, alignItems: 'center', borderRadius: 8 },
  segActive: { backgroundColor: C.raised },
  segText: { fontFamily: F.bodyMedium, fontSize: 13, color: C.muted },
  badge: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  badgeText: { fontFamily: F.monoBold, fontSize: 9, letterSpacing: 0.5 },
  flag: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  flagText: { fontFamily: F.monoBold, fontSize: 10 },
  btn: { height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  btnPrimary: { backgroundColor: C.accent },
  btnGhost: { borderWidth: 1, borderColor: C.lineStrong, backgroundColor: C.surface },
  btnQuiet: { backgroundColor: 'transparent' },
  btnText: { fontFamily: F.display, fontSize: 15, color: C.text },
  stat: { flex: 1, minWidth: 80, padding: 12, borderRadius: 12, backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, gap: 2 },
})
