import { useCallback, useEffect, useState } from 'react'
import { FlatList, Pressable, View } from 'react-native'
import { router } from 'expo-router'
import { C } from '@/theme'
import { get } from '@/lib/api'
import { useSocial } from '@/lib/social'
import { useLive } from '@/lib/live'
import { useWindowDimensions } from 'react-native'
import { MID } from '@/theme'
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
    if (tab === 'calls') setPosts(await get<Post[]>('/api/posts', { viewer: social.pubkey }).catch(() => []))
  }, [social.pubkey, tab, social.follows.length])

  useEffect(() => { void load(); const t = setInterval(load, 5000); return () => clearInterval(t) }, [load])

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
            <Pressable onPress={() => router.push(`/${f.kind}/${f.chain}/${f.address}` as any)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.line }}>
              <Txt v="label" style={{ width: 54 }}>{f.kind}</Txt>
              <ChainBadge chain={f.chain} />
              <Txt v="mono" style={{ flex: 1 }}>{short(f.address, 6)}</Txt>
              <Pressable hitSlop={8} onPress={() => social.toggle(f.kind, f.chain, f.address)}><Txt v="small" color={C.bad}>unfollow</Txt></Pressable>
            </Pressable>
          )}
          ListEmptyComponent={<Empty title="Follow wallets and tokens" body="Open any wallet or token from the live feed and tap Follow. Their pool births, adds and pulls collect here, and You → Alerts pings you when they move." />}
        />
      </Screen>
    )
  }
  if (tab === 'calls') {
    return (
      <Screen>
        <FlatList data={posts} keyExtractor={p => String(p.id)} ListHeaderComponent={header} renderItem={({ item }) => <PostItem p={item} now={now} showToken />}
          ListEmptyComponent={<Empty title="No calls yet" body="Calls are posts on a token while it is still on its curve. Graduations score them." />} />
      </Screen>
    )
  }
  return (
    <Screen>
      <FlatList data={events} keyExtractor={e => e.id} ListHeaderComponent={header} renderItem={({ item }) => <EventRow e={item} prices={live.status?.prices} wide={width >= MID} />}
        ListEmptyComponent={<Empty title={social.follows.length ? 'Quiet so far' : 'Nobody followed yet'} body={social.follows.length ? 'Moves by the wallets and tokens you follow land here.' : 'Follow a wallet from the Leaders tab or any event in the feed.'} />} />
    </Screen>
  )
}
