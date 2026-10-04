import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import { C, F, KIND } from '@/theme'
import { ago, num, pct, quoteLeg, short, tokenLabel, venue } from '@/lib/format'
import type { FlowEvent, TokenSummary, WalletSummary } from '@/lib/types'
import { ChainBadge, FlagChips, TokenAvatar, Txt } from './ui'

const STAGE_COLOR = { pending: C.warn, confirmed: C.good, failed: C.bad } as const

export const EventRow = memo(function EventRow({ e, now, showToken = true }: { e: FlowEvent; now: number; showToken?: boolean }) {
  const k = KIND[e.kind]
  const leg = quoteLeg(e)
  const lead = e.confirmedTs && e.stage === 'confirmed' && e.lane !== 'geyser' && e.lane !== 'geyser-drpc' && e.lane !== 'logs' ? e.confirmedTs - e.ts : null
  return (
    <Pressable
      onPress={() => e.token ? router.push(`/token/${e.chain}/${e.token}`) : router.push(`/wallet/${e.chain}/${e.wallet}`)}
      style={({ pressed }) => [r.row, pressed && { backgroundColor: C.surface }]}>
      <View style={[r.glyph, { borderColor: k.color + '66', backgroundColor: k.color + '14' }]}>
        <Text style={[r.glyphText, { color: k.color }]}>{k.glyph}</Text>
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <View style={r.line}>
          {showToken ? <Txt v="h2" numberOfLines={1} style={{ flexShrink: 1, fontSize: 15 }}>{tokenLabel(e)}</Txt> : null}
          <Text style={[r.kind, { color: k.color }]}>{k.label}</Text>
          <ChainBadge chain={e.chain} />
          <View style={{ flex: 1 }} />
          <View style={[r.dot, { backgroundColor: STAGE_COLOR[e.stage] }]} />
          <Txt v="monoSmall">{ago(e.ts, now)}</Txt>
        </View>
        <View style={r.line}>
          <Txt v="small" numberOfLines={1} style={{ flexShrink: 1 }}>
            {venue(e.venue)}
            {e.feeBps !== null ? ` · ${(e.feeBps / 100).toFixed(e.feeBps % 100 ? 2 : 0)}% fee` : ''}
          </Txt>
          {leg ? <Text style={[r.amount, { color: e.kind === 'liq_remove' ? '#FF8A5B' : C.text }]}>{leg}</Text> : e.stage === 'pending' ? <Txt v="monoSmall">sizing on confirm</Txt> : null}
        </View>
        <View style={r.line}>
          <Pressable onPress={() => router.push(`/wallet/${e.chain}/${e.wallet}`)} hitSlop={6}>
            <Txt v="monoSmall" color={C.muted}>by {short(e.wallet)}</Txt>
          </Pressable>
          {e.lane !== 'logs' && e.lane !== 'geyser' && e.lane !== 'geyser-drpc' ? <Txt v="monoSmall" color={C.warn}>{e.lane}{lead !== null ? ` +${lead}ms` : ''}</Txt> : null}
          <View style={{ flex: 1 }} />
          <FlagChips flags={e.flags} max={3} />
        </View>
      </View>
    </Pressable>
  )
})

export const TokenRow = memo(function TokenRow({ t, now, rank }: { t: TokenSummary; now: number; rank?: number }) {
  const label = t.symbol ? '$' + t.symbol : short(t.address)
  return (
    <Pressable onPress={() => router.push(`/token/${t.chain}/${t.address}`)} style={({ pressed }) => [r.row, pressed && { backgroundColor: C.surface }]}>
      {rank !== undefined ? <Text style={r.rank}>{rank}</Text> : null}
      <TokenAvatar image={t.image} label={label} chain={t.chain} />
      <View style={{ flex: 1, gap: 3 }}>
        <View style={r.line}>
          <Txt v="h2" numberOfLines={1} style={{ flexShrink: 1, fontSize: 15 }}>{label}</Txt>
          {t.name && t.name !== t.symbol ? <Txt v="small" numberOfLines={1} style={{ flexShrink: 1 }}>{t.name}</Txt> : null}
          <View style={{ flex: 1 }} />
          {t.graduatedTs ? <Text style={[r.kind, { color: C.good }]}>GRADUATED</Text> : null}
          <Txt v="monoSmall">{ago(t.lastTs, now)}</Txt>
        </View>
        <View style={r.line}>
          <Txt v="monoSmall" color={C.text}>{t.pools} pools · {t.fundedPools} funded · {t.lpWallets} LPs</Txt>
          {t.launchedTs ? <Txt v="monoSmall">launched {ago(t.launchedTs, now)} ago</Txt> : null}
        </View>
        <FlagChips flags={t.flags} max={5} />
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={r.score}>{num(t.score, 0)}</Text>
        <Txt v="label">score</Txt>
      </View>
    </Pressable>
  )
})

export const WalletRow = memo(function WalletRow({ w, now, rank }: { w: WalletSummary; now: number; rank?: number }) {
  return (
    <Pressable onPress={() => router.push(`/wallet/${w.chain}/${w.address}`)} style={({ pressed }) => [r.row, pressed && { backgroundColor: C.surface }]}>
      {rank !== undefined ? <Text style={r.rank}>{rank}</Text> : null}
      <View style={{ flex: 1, gap: 3 }}>
        <View style={r.line}>
          <Txt v="mono" style={{ fontSize: 14 }}>{w.label ?? short(w.address, 5)}</Txt>
          <ChainBadge chain={w.chain} />
          <View style={{ flex: 1 }} />
          <Txt v="monoSmall">{ago(w.lastTs, now)}</Txt>
        </View>
        <Txt v="monoSmall" color={C.text}>{w.inits} inits · {w.adds} adds · {w.removes} pulls · {w.tokens} launch tokens{w.followers ? ` · ${w.followers} following` : ''}</Txt>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[r.score, { color: w.hits ? C.good : C.muted }]}>{w.hits}/{w.tokens}</Text>
        <Txt v="label">{w.tokens ? pct(w.hitRate) : 'hits'}</Txt>
      </View>
    </Pressable>
  )
})

const r = StyleSheet.create({
  row: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line, alignItems: 'center' },
  glyph: { width: 34, height: 34, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start', marginTop: 2 },
  glyphText: { fontSize: 16, fontFamily: F.monoBold },
  line: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  kind: { fontFamily: F.monoBold, fontSize: 10, letterSpacing: 0.6, textTransform: 'uppercase' },
  dot: { width: 6, height: 6, borderRadius: 3 },
  amount: { fontFamily: F.monoBold, fontSize: 13, marginLeft: 'auto' },
  rank: { fontFamily: F.monoBold, fontSize: 12, color: C.faint, width: 22, textAlign: 'right' },
  score: { fontFamily: F.monoBold, fontSize: 17, color: C.accent },
})
