import { useEffect, useState } from 'react'
import { FlatList, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import { C } from '@/theme'
import { get } from '@/lib/api'
import { useNow } from '@/lib/useNow'
import { short } from '@/lib/format'
import type { Post, Profile } from '@/lib/types'
import { Empty, Loading, Screen, Stat, Txt } from '@/components/ui'
import { PostItem } from '@/components/Posts'

export default function ProfileScreen() {
  const { pubkey } = useLocalSearchParams<{ pubkey: string }>()
  const now = useNow(10_000)
  const [data, setData] = useState<{ profile: Profile; follows: any[]; posts: Post[] } | null>(null)
  useEffect(() => { get<any>(`/api/profile/${pubkey}`).then(setData).catch(() => {}) }, [pubkey])
  if (!data) return <Screen edges={[]}><Loading /></Screen>
  const name = data.profile.handle ? '@' + data.profile.handle : short(data.profile.pubkey)
  const calls = data.posts.filter(p => p.kind === 'call' && p.hit !== undefined)
  const hits = calls.filter(p => p.hit).length
  return (
    <Screen edges={[]}>
      <Stack.Screen options={{ title: name }} />
      <FlatList
        data={data.posts}
        keyExtractor={p => String(p.id)}
        renderItem={({ item }) => <PostItem p={item} now={now} showToken />}
        ListHeaderComponent={
          <View style={{ padding: 16, gap: 10, borderBottomWidth: 1, borderBottomColor: C.line }}>
            <Txt v="title">{name}</Txt>
            {data.profile.bio ? <Txt v="body">{data.profile.bio}</Txt> : null}
            <Txt v="monoSmall" selectable>{data.profile.pubkey}</Txt>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Stat label="calls" value={calls.length} />
              <Stat label="hits" value={hits} color={hits ? C.good : undefined} />
              <Stat label="following" value={data.follows.length} />
            </View>
          </View>
        }
        ListEmptyComponent={<Empty title="No posts yet" />}
      />
    </Screen>
  )
}
