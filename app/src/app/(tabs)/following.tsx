import { useCallback, useEffect, useMemo, useState } from 'react'
import { FlatList, Pressable, View, useWindowDimensions } from 'react-native'
import { router } from 'expo-router'
import { C, MID } from '@/theme'
import { get } from '@/lib/api'
import { useSocial } from '@/lib/social'
import { useLive } from '@/lib/live'
import { useNow } from '@/lib/useNow'
import { short } from '@/lib/format'
import type { FlowEvent, Post } from '@/lib/types'
import { EventRow } from '@/components/rows'
import { ChainBadge, Empty, Screen, Seg, Txt } from '@/components/ui'
import { PostItem } from '@/components/Posts'

export default function Following() {
  const social = useSocial()
  const now = useNow(3000)
  const live = useLive()
  const { width } = useWindowDimensions()
  const [tab, setTab] = useState<'moves' | 'calls' | 'list'>('moves')
  const [events, setEvents] = useState<FlowEvent[]>([])
  const [posts, setPosts] = useState<Post[]>([])

  const load = useCallback(async () => {
    if (!social.pubkey) return
    if (tab === 'moves') setEvents(await get<FlowEvent[]>('/api/feed', { as: social.pubkey, limit: 150 }).catch(() => []))
    if (tab === 'calls') setPosts(await get<Post[]>('/api/posts', { viewer: social.pubkey, following: social.pubkey, kind: 'call' }).catch(() => []))
  }, [social.pubkey, tab, social.follows.length])

  useEffect(() => {
    const first = setTimeout(() => void load(), 0)
    const t = setInterval(load, 30_000)
    return () => { clearTimeout(first); clearInterval(t) }
  }, [load])

  // Calls and moves reach this screen immediately over the shared live socket.
  // The periodic read above fills gaps after a disconnected session.
  const shownPosts = useMemo(() => {
    const people = new Set(social.follows.filter(f => f.kind === 'user').map(f => f.address))
    const fresh = live.posts.filter(p => p.kind === 'call' && (people.has(p.author.pubkey) || p.author.pubkey === social.pubkey))
    const byId = new Map(posts.map(p => [p.id, p]))
    for (const p of fresh) byId.set(p.id, p)
    return [...byId.values()].sort((a, b) => b.ts - a.ts).slice(0, 100)
  }, [posts, live.postTick, social.follows, social.pubkey])

  const shownEvents = useMemo(() => {
    const targets = new Set(social.follows.filter(f => f.kind !== 'user').map(f => `${f.kind}:${f.chain}:${f.address}`))
    const fresh = live.events.filter(e => targets.has(`wallet:${e.chain}:${e.wallet}`) || (e.token && targets.has(`token:${e.chain}:${e.token}`)))
    const byId = new Map(events.map(e => [e.id, e]))
    for (const e of fresh) byId.set(e.id, e)
    return [...byId.values()].sort((a, b) => b.ts - a.ts).slice(0, 150)
  }, [events, live.events, social.follows])

  const header = (
    <View style={{ padding: 16, gap: 10, borderBottomWidth: 1, borderBottomColor: C.line }}>
      <Txt v="title">Following</Txt>
      <Seg value={tab} onChange={setTab} options={[{ value: 'moves', label: 'Their moves' }, { value: 'calls', label: 'Calls' }, { value: 'list', label: `Following ${social.follows.length}` }]} />
    </View>
  )

  if (tab === 'list') {
    return (
      <Screen>
        <FlatList
          data={social.follows}
          keyExtractor={f => `${f.kind}:${f.chain}:${f.address}`}
          ListHeaderComponent={header}
          renderItem={({ item: f }) => (
            <Pressable onPress={() => router.push(f.kind === 'user' ? `/profile/${f.address}` : `/${f.kind}/${f.chain}/${f.address}` as any)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.line }}>
              <Txt v="label" style={{ width: 54 }}>{f.kind}</Txt>
              {f.kind !== 'user' ? <ChainBadge chain={f.chain} /> : null}
              <Txt v="mono" style={{ flex: 1 }}>{short(f.address, 6)}</Txt>
              <Pressable hitSlop={8} onPress={() => social.toggle(f.kind, f.chain, f.address)}><Txt v="small" color={C.bad}>unfollow</Txt></Pressable>
            </Pressable>
          )}
          ListEmptyComponent={<Empty title="Follow people, wallets and tokens" body="Tap Follow on a person's profile, a wallet, or a token. Their calls and liquidity moves collect here." />}
        />
      </Screen>
    )
  }
  if (tab === 'calls') {
    return (
      <Screen>
        <FlatList data={shownPosts} keyExtractor={p => String(p.id)} ListHeaderComponent={header} renderItem={({ item }) => <PostItem p={item} now={now} showToken />}
          ListEmptyComponent={<Empty title="No calls from your circle yet" body="Follow people from a call or the Leaders tab. Their token calls land here." />} />
      </Screen>
    )
  }
  return (
    <Screen>
      <FlatList data={shownEvents} keyExtractor={e => e.id} ListHeaderComponent={header} renderItem={({ item }) => <EventRow e={item} prices={live.status?.prices} wide={width >= MID} />}
        ListEmptyComponent={<Empty title={social.follows.length ? 'Quiet so far' : 'Nobody followed yet'} body={social.follows.length ? 'Moves by the wallets and tokens you follow land here.' : 'Follow a wallet from the Leaders tab or any event in the feed.'} />} />
    </Screen>
  )
}
