import { useCallback, useEffect, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import { C, CHAIN, FLAG } from '@/theme'
import { get } from '@/lib/api'
import { useSocial } from '@/lib/social'
import { useNow } from '@/lib/useNow'
import { ago, short, venue } from '@/lib/format'
import type { Chain, FlowEvent, PoolSummary, Post, TokenSummary, WalletSummary } from '@/lib/types'
import { EventRow, WalletRow } from '@/components/rows'
import { Button, ChainBadge, Empty, FlagChips, Loading, Screen, Section, Stat, TokenAvatar, Txt } from '@/components/ui'
import { Composer, PostItem } from '@/components/Posts'
import { Trade } from '@/components/Trade'

interface Page { token: TokenSummary; pools: PoolSummary[]; events: FlowEvent[]; wallets: WalletSummary[]; posts: Post[] }

export default function TokenScreen() {
  const { chain, address } = useLocalSearchParams<{ chain: Chain; address: string }>()
  const social = useSocial()
  const now = useNow(5000)
  const [page, setPage] = useState<Page | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(() => get<Page>(`/api/token/${chain}/${address}`, { viewer: social.pubkey }).then(setPage).catch(e => setErr(e.message)), [chain, address, social.pubkey])
  useEffect(() => { void load(); const t = setInterval(load, 8000); return () => clearInterval(t) }, [load])

  if (err && !page) return <Screen edges={[]}><Empty title="Not seen yet" body={err} /></Screen>
  if (!page) return <Screen edges={[]}><Loading /></Screen>
  const t = page.token
  const label = t.symbol ? '$' + t.symbol : short(t.address)
  const following = social.isFollowing('token', t.chain, t.address)

  return (
    <Screen edges={[]}>
      <Stack.Screen options={{ title: label }} />
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
        <View style={{ padding: 16, gap: 12 }}>
          <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
            <TokenAvatar image={t.image} label={label} size={56} chain={t.chain} />
            <View style={{ flex: 1, gap: 2 }}>
              <Txt v="title" numberOfLines={1}>{label}</Txt>
              {t.name ? <Txt v="small" numberOfLines={1}>{t.name}</Txt> : null}
              <Pressable onPress={async () => { await Clipboard.setStringAsync(t.address); setCopied(true); setTimeout(() => setCopied(false), 1200) }} style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                <ChainBadge chain={t.chain} />
                <Txt v="monoSmall">{copied ? 'copied' : short(t.address, 6)}</Txt>
              </Pressable>
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button label={following ? 'Following' : 'Follow token'} kind={following ? 'ghost' : 'primary'} style={{ flex: 1 }} onPress={() => social.toggle('token', t.chain, t.address).catch(() => {})} />
          </View>
          <Txt v="small">
            {t.launchedTs ? `Launched on ${venue(t.launchVenue ?? '')} ${ago(t.launchedTs, now)} ago. ` : 'Launch not seen by FTL. '}
            {t.graduatedTs ? `Graduated ${ago(t.graduatedTs, now)} ago.` : t.launchedTs ? 'Still on its curve.' : ''}
            {t.firstPoolTs ? ` First pool ${ago(t.firstPoolTs, now)} ago.` : ''}
          </Txt>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            <Stat label="pools" value={t.pools} />
            <Stat label="funded" value={t.fundedPools} />
            <Stat label="LP wallets" value={t.lpWallets} />
            <Stat label="score" value={Math.round(t.score)} color={C.accent} />
          </View>
          {t.flags.length ? (
            <View style={{ gap: 6 }}>
              <FlagChips flags={t.flags} max={8} />
              {t.flags.filter(f => f !== 'first_pool').map(f => <Txt key={f} v="small"><Txt v="monoSmall" color={FLAG[f].color}>{FLAG[f].label}</Txt>  {FLAG[f].about}</Txt>)}
            </View>
          ) : null}
        </View>

        <Trade t={t} pools={page.pools} />

        <Section title={`Calls & comments · ${page.posts.length}`}>
          <Composer chain={t.chain} token={t.address} graduated={!!t.graduatedTs} onPosted={p => setPage(pg => pg ? { ...pg, posts: [p, ...pg.posts] } : pg)} />
          {page.posts.map(p => <PostItem key={p.id} p={p} now={now} />)}
        </Section>

        <Section title={`LP wallets · ${page.wallets.length}`}>
          {page.wallets.length ? page.wallets.map(w => <WalletRow key={w.address} w={w} now={now} />) : <Txt v="small" style={{ paddingHorizontal: 16 }}>None yet.</Txt>}
        </Section>

        <Section title={`Pools · ${page.pools.length}`}>
          {page.pools.map(p => (
            <View key={p.address} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line }}>
              <Txt v="mono" style={{ width: 110 }}>{short(p.address, 5)}</Txt>
              <Txt v="small" style={{ flex: 1 }} numberOfLines={1}>{venue(p.venue)}{p.feeBps !== null ? ` · ${(p.feeBps / 100).toFixed(2)}%` : ''}</Txt>
              <Txt v="monoSmall" color={p.funded ? C.good : C.faint}>{p.funded ? 'funded' : 'empty'}</Txt>
              {p.creator ? <Pressable onPress={() => router.push(`/wallet/${p.chain}/${p.creator}`)}><Txt v="monoSmall">{short(p.creator)}</Txt></Pressable> : null}
              <Txt v="monoSmall">{p.createdTs ? ago(p.createdTs, now) : '—'}</Txt>
            </View>
          ))}
        </Section>

        <Section title="Liquidity timeline">
          {page.events.map(e => <EventRow key={e.id} e={e} now={now} showToken={false} />)}
        </Section>
        <Txt v="monoSmall" style={{ padding: 16, color: CHAIN[t.chain].color }}>{CHAIN[t.chain].label}</Txt>
      </ScrollView>
    </Screen>
  )
}
