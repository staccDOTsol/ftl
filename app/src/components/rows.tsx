import { memo, useEffect, type ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated'
import { C, CHAIN, F, FLAG, KIND, T } from '@/theme'
import { loudness, num, pct, quoteLeg, short, usd, usdOf, venue } from '@/lib/format'
import type { LiveEvent } from '@/lib/live'
import type { TokenSummary, WalletSummary } from '@/lib/types'
import { Ago, ChainBadge, FlagChips, Press, Spark, TokenAvatar, Txt } from './ui'

const FRESH_MS = 1800

function Flash({ color, fresh }: { color: string; fresh?: number }) {
  const o = useSharedValue(fresh && Date.now() - fresh < FRESH_MS ? 1 : 0)
  useEffect(() => { o.value = withTiming(0, { duration: 1600, easing: Easing.out(Easing.quad) }) }, [])
  const st = useAnimatedStyle(() => ({ opacity: o.value }))
  return <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: color }, st]} />
}

// new rows slide down into place and settle; reanimated's layout presets stall on web
function Enter({ fresh, children }: { fresh: boolean; children: ReactNode }) {
  const p = useSharedValue(fresh ? 0 : 1)
  useEffect(() => { if (fresh) p.value = withTiming(1, { duration: 260, easing: Easing.out(Easing.cubic) }) }, [])
  const st = useAnimatedStyle(() => ({ opacity: p.value, transform: [{ translateY: (1 - p.value) * -8 }] }))
  return <Animated.View style={st}>{children}</Animated.View>
}

function Pending() {
  const o = useSharedValue(1)
  useEffect(() => { o.value = withRepeat(withTiming(0.25, { duration: 520 }), -1, true) }, [])
  const st = useAnimatedStyle(() => ({ opacity: o.value }))
  return <Animated.View style={[r.dot, { backgroundColor: C.warn }, st]} />
}

export const EventRow = memo(function EventRow({ e, prices, wide, showToken = true }: { e: LiveEvent; prices?: Record<string, number>; wide: boolean; showToken?: boolean }) {
  const k = KIND[e.kind]
  const label = e.tokenMeta?.symbol ? e.tokenMeta.symbol.slice(0, 16) : short(e.token)
  const name = e.tokenMeta?.name && e.tokenMeta.name !== e.tokenMeta.symbol ? e.tokenMeta.name : null
  const dollars = usdOf(e, prices)
  const loud = loudness(dollars)
  const hot = e.flags.some(f => FLAG[f].hot)
  const fresh = e.fresh && Date.now() - e.fresh < FRESH_MS
  const early = e.lane === 'preconf' || e.lane === 'deshred'
  const lead = early && e.confirmedTs ? e.confirmedTs - e.ts : null
  const meta = [venue(e.venue), e.feeBps !== null ? `${(e.feeBps / 100).toFixed(e.feeBps % 100 ? 2 : 0)}% fee` : null].filter(Boolean).join(' · ')
  const open = () => (e.token ? router.push(`/token/${e.chain}/${e.token}`) : router.push(`/wallet/${e.chain}/${e.wallet}`))

  const amount = (
    <View style={{ alignItems: 'flex-end', minWidth: wide ? 104 : 80, gap: 3 }}>
      {dollars !== null ? (
        <Text style={[r.usd, { color: e.kind === 'liq_remove' ? C.out : loud > 0.55 ? C.text : C.muted, fontSize: loud > 0.7 ? T.lg : T.md }]}>
          {Math.abs(dollars) >= 0.01 ? (e.kind === 'liq_remove' ? '−' : e.kind === 'liq_add' || e.kind === 'pool_init' ? '+' : '') : ''}{usd(dollars)}
        </Text>
      ) : e.stage === 'pending' ? <Text style={r.sizing}>sizing…</Text> : <Text style={r.sizing}>{e.kind === 'launch' ? 'launch' : '—'}</Text>}
      {dollars !== null ? (
        <View style={r.barTrack}><View style={[r.bar, { width: `${Math.max(4, loud * 100)}%`, backgroundColor: k.color }]} /></View>
      ) : null}
    </View>
  )

  return (
    <Enter fresh={!!fresh}>
      <Press onPress={open} accessibilityRole="link"
        style={({ hovered, pressed }) => [r.row, wide ? r.rowWide : r.rowNarrow, hot && { backgroundColor: C.heatDim }, hovered && { backgroundColor: hot ? C.heatDim : C.hover }, pressed && { opacity: 0.8 }]}>
        {fresh ? <Flash color={hot ? C.heatDim : k.dim} fresh={e.fresh} /> : null}
        <TokenAvatar image={e.tokenMeta?.image} label={label} chain={e.chain} size={wide ? 34 : 36} />
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <View style={r.line}>
            {showToken ? <Text numberOfLines={1} style={r.sym}>{label}</Text> : null}
            <View style={[r.kind, { backgroundColor: k.dim }]}>
              <Text style={[r.kindText, { color: k.color }]}>{k.glyph} {k.label.toUpperCase()}</Text>
            </View>
            {wide && name ? <Text numberOfLines={1} style={r.name}>{name}</Text> : null}
          </View>
          <View style={r.line}>
            <ChainBadge chain={e.chain} />
            <Text numberOfLines={1} style={r.meta}>{meta}</Text>
            <Press onPress={() => router.push(`/wallet/${e.chain}/${e.wallet}`)} hitSlop={6} style={({ hovered }) => [hovered && { opacity: 0.7 }]}>
              <Text style={r.wallet}>{short(e.wallet)}</Text>
            </Press>
            {early ? <Text style={r.lane}>{e.lane}{lead !== null ? ` +${lead}ms` : ''}</Text> : null}
          </View>
          {!wide && e.flags.length ? <View style={{ marginTop: 2 }}><FlagChips flags={e.flags} max={3} /></View> : null}
        </View>
        {wide ? <View style={{ width: 180, alignItems: 'flex-end' }}><FlagChips flags={e.flags} max={2} /></View> : null}
        {amount}
        <View style={{ width: 36, alignItems: 'flex-end', gap: 4 }}>
          {e.stage === 'pending' ? <Pending /> : <View style={[r.dot, { backgroundColor: e.stage === 'failed' ? C.bad : C.ghost }]} />}
          <Ago ts={e.ts} />
        </View>
      </Press>
    </Enter>
  )
})

export const EVENT_ROW_H = { wide: 60, narrow: 66 }

export const TokenRow = memo(function TokenRow({ t, rank, spark }: { t: TokenSummary; rank?: number; spark?: number[] }) {
  const label = t.symbol ? t.symbol.slice(0, 16) : short(t.address)
  const hot = t.flags.some(f => FLAG[f].hot)
  return (
    <Press onPress={() => router.push(`/token/${t.chain}/${t.address}`)} accessibilityRole="link"
      style={({ hovered, pressed }) => [r.row, r.rowToken, hovered && { backgroundColor: C.hover }, pressed && { opacity: 0.8 }]}>
      {rank !== undefined ? <Text style={[r.rank, rank <= 3 && { color: C.accent }]}>{rank}</Text> : null}
      <TokenAvatar image={t.image} label={label} chain={t.chain} size={40} />
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <View style={r.line}>
          <Text numberOfLines={1} style={[r.sym, { fontSize: T.md + 1 }]}>{label}</Text>
          {t.name && t.name !== t.symbol ? <Text numberOfLines={1} style={r.name}>{t.name}</Text> : null}
          {t.graduatedTs ? <Text style={[r.kindText, { color: C.gold }]}>▲ GRAD</Text> : null}
        </View>
        <Text numberOfLines={1} style={r.meta}>
          <Text style={{ color: C.text }}>{t.pools}</Text> pools · <Text style={{ color: C.text }}>{t.fundedPools}</Text> funded · <Text style={{ color: C.text }}>{t.lpWallets}</Text> LPs{t.launchedTs ? ' · launched ' : ''}{t.launchedTs ? <Ago ts={t.launchedTs} /> : null}
        </Text>
        <FlagChips flags={t.flags} max={4} />
      </View>
      {spark ? <Spark values={spark} color={hot ? C.heat : C.accent} /> : null}
      <View style={{ alignItems: 'flex-end', gap: 2, minWidth: 56 }}>
        <Text style={[r.score, hot && { color: C.heat }]}>{num(t.score, 0)}</Text>
        <Ago ts={t.lastTs} />
      </View>
    </Press>
  )
})

export const WalletRow = memo(function WalletRow({ w, rank }: { w: WalletSummary; rank?: number }) {
  return (
    <Press onPress={() => router.push(`/wallet/${w.chain}/${w.address}`)} accessibilityRole="link"
      style={({ hovered, pressed }) => [r.row, r.rowToken, hovered && { backgroundColor: C.hover }, pressed && { opacity: 0.8 }]}>
      {rank !== undefined ? <Text style={[r.rank, rank <= 3 && { color: C.accent }]}>{rank}</Text> : null}
      <View style={[r.walletMark, { borderColor: CHAIN[w.chain].color + '55' }]}><Text style={[r.kindText, { color: CHAIN[w.chain].color }]}>{CHAIN[w.chain].short}</Text></View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text style={[r.sym, { fontFamily: F.monoBold, fontSize: T.sm + 1 }]}>{w.label ?? short(w.address, 6)}</Text>
        <Text numberOfLines={1} style={r.meta}>{w.inits} inits · {w.adds} adds · {w.removes} pulls{w.followers ? ` · ${w.followers} following` : ''}</Text>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        <Text style={[r.score, { color: w.hits ? C.good : C.faint }]}>{w.hits}<Text style={{ color: C.faint, fontSize: T.sm }}>/{w.tokens}</Text></Text>
        <Txt v="label">{w.tokens ? pct(w.hitRate) + ' grad' : 'no launches'}</Txt>
      </View>
    </Press>
  )
})

const r = StyleSheet.create({
  row: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line, overflow: 'hidden' },
  rowWide: { height: EVENT_ROW_H.wide },
  rowNarrow: { minHeight: EVENT_ROW_H.narrow, paddingVertical: 10 },
  rowToken: { paddingVertical: 12 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 7, minWidth: 0 },
  sym: { fontFamily: F.displayBold, fontSize: T.md, color: C.text, letterSpacing: -0.2, flexShrink: 1 },
  name: { fontFamily: F.body, fontSize: T.sm, color: C.faint, flexShrink: 1 },
  kind: { borderRadius: 5, paddingHorizontal: 6, height: 18, justifyContent: 'center' },
  kindText: { fontFamily: F.monoBold, fontSize: 9.5, letterSpacing: 0.6 },
  meta: { fontFamily: F.body, fontSize: T.sm - 1, color: C.faint, flexShrink: 1 },
  wallet: { fontFamily: F.mono, fontSize: T.xs, color: C.muted },
  lane: { fontFamily: F.monoBold, fontSize: 9.5, color: C.warn, letterSpacing: 0.4 },
  usd: { fontFamily: F.monoBold, fontVariant: ['tabular-nums'], letterSpacing: -0.3 },
  sizing: { fontFamily: F.mono, fontSize: T.xs, color: C.ghost },
  barTrack: { width: 64, height: 3, borderRadius: 2, backgroundColor: C.line, overflow: 'hidden', alignSelf: 'flex-end' },
  bar: { height: 3, borderRadius: 2, alignSelf: 'flex-end' },
  dot: { width: 6, height: 6, borderRadius: 3 },
  rank: { fontFamily: F.monoBold, fontSize: T.sm, color: C.ghost, width: 22, textAlign: 'right' },
  score: { fontFamily: F.monoBold, fontSize: T.lg, color: C.accent, fontVariant: ['tabular-nums'] },
  walletMark: { width: 40, height: 40, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surface },
})

void quoteLeg
