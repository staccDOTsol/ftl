import { useCallback, useEffect, useState } from 'react'
import { Linking, Pressable, ScrollView, View } from 'react-native'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import { C } from '@/theme'
import { get } from '@/lib/api'
import { useSocial } from '@/lib/social'
import { useLive } from '@/lib/live'
import { useWindowDimensions } from 'react-native'
import { MID } from '@/theme'
import { useNow } from '@/lib/useNow'
import { ago, explorerAddr, pct, short } from '@/lib/format'
import type { Chain, FlowEvent, TokenSummary, WalletSummary } from '@/lib/types'
import { EventRow } from '@/components/rows'
import { Button, ChainBadge, Chip, Empty, FlagChips, Loading, Screen, Section, Stat, Txt } from '@/components/ui'

interface Page { wallet: WalletSummary; events: FlowEvent[]; tokens: (TokenSummary & { touchedTs: number; hit: boolean })[] }

export default function WalletScreen() {
  const { chain, address } = useLocalSearchParams<{ chain: Chain; address: string }>()
  const social = useSocial()
  const now = useNow(5000)
  const live = useLive()
  const { width } = useWindowDimensions()
  const [page, setPage] = useState<Page | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(() => get<Page>(`/api/wallet/${chain}/${address}`).then(setPage).catch(e => setErr(e.message)), [chain, address])
  useEffect(() => { void load(); const t = setInterval(load, 10_000); return () => clearInterval(t) }, [load])

  if (err && !page) return <Screen edges={[]}><Empty title="Not seen yet" body={err} /></Screen>
  if (!page) return <Screen edges={[]}><Loading /></Screen>
  const w = page.wallet
  const following = social.isFollowing('wallet', w.chain, w.address)

  return (
    <Screen edges={[]}>
      <Stack.Screen options={{ title: short(w.address) }} />
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
        <View style={{ padding: 16, gap: 12 }}>
          <Pressable onPress={async () => { await Clipboard.setStringAsync(w.address); setCopied(true); setTimeout(() => setCopied(false), 1200) }} style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <ChainBadge chain={w.chain} />
              <Txt v="label">{copied ? 'copied' : 'LP wallet · tap to copy'}</Txt>
            </View>
            <Txt v="mono" selectable style={{ fontSize: 14 }}>{w.address}</Txt>
          </Pressable>
          <Txt v="small">First seen {ago(w.firstTs, now)} ago · last move {ago(w.lastTs, now)} ago{w.followers ? ` · ${w.followers} following` : ''}</Txt>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Stat label="pool inits" value={w.inits} />
            <Stat label="adds" value={w.adds} />
            <Stat label="pulls" value={w.removes} />
          </View>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Stat label="launch tokens" value={w.tokens} />
            <Stat label="graduated" value={w.hits} color={w.hits ? C.good : undefined} />
            <Stat label="hit rate" value={w.tokens ? pct(w.hitRate) : '—'} color={C.accent} />
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button label={following ? 'Following' : 'Follow wallet'} kind={following ? 'ghost' : 'primary'} style={{ flex: 1 }} onPress={() => social.toggle('wallet', w.chain, w.address).catch(() => {})} />
            <Chip label="Explorer ↗" onPress={() => Linking.openURL(explorerAddr(w.chain, w.address))} />
          </View>
        </View>

        <Section title={`Launch tokens it touched before graduation · ${page.tokens.length}`}>
          {page.tokens.length ? page.tokens.map(t => (
            <Pressable key={t.address} onPress={() => router.push(`/token/${t.chain}/${t.address}`)} style={{ paddingHorizontal: 16, paddingVertical: 10, gap: 4, borderBottomWidth: 1, borderBottomColor: C.line }}>
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                <Txt v="h2" style={{ fontSize: 15 }}>{t.symbol ? '$' + t.symbol : short(t.address)}</Txt>
                {t.hit ? <Txt v="monoSmall" color={C.good}>GRADUATED</Txt> : null}
                <View style={{ flex: 1 }} />
                <Txt v="monoSmall">{ago(t.touchedTs, now)}</Txt>
              </View>
              <FlagChips flags={t.flags} max={5} />
            </Pressable>
          )) : <Txt v="small" style={{ paddingHorizontal: 16 }}>None yet. Tokens count once FTL has seen their launch.</Txt>}
        </Section>

        <Section title="Moves">
          {page.events.map(e => <EventRow key={e.id} e={e} prices={live.status?.prices} wide={width >= MID} />)}
        </Section>
      </ScrollView>
    </Screen>
  )
}
