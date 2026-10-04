import { useEffect, useState } from 'react'
import { FlatList, Pressable, View } from 'react-native'
import { router } from 'expo-router'
import { C } from '@/theme'
import { get } from '@/lib/api'
import { useNow } from '@/lib/useNow'
import { pct, short } from '@/lib/format'
import type { CallerSummary, Chain, WalletSummary } from '@/lib/types'
import { WalletRow } from '@/components/rows'
import { Empty, Loading, Screen, Seg, Txt } from '@/components/ui'

export default function Leaders() {
  const now = useNow(10_000)
  const [tab, setTab] = useState<'lps' | 'callers'>('lps')
  const [chain, setChain] = useState<'all' | Chain>('all')
  const [wallets, setWallets] = useState<WalletSummary[] | null>(null)
  const [callers, setCallers] = useState<CallerSummary[] | null>(null)

  useEffect(() => {
    if (tab === 'lps') { setWallets(null); get<WalletSummary[]>('/api/leaderboard/wallets', { chain: chain === 'all' ? undefined : chain, min: 2 }).then(setWallets).catch(() => setWallets([])) }
    else { setCallers(null); get<CallerSummary[]>('/api/leaderboard/callers').then(setCallers).catch(() => setCallers([])) }
  }, [tab, chain])

  const header = (
    <View style={{ padding: 16, gap: 10, borderBottomWidth: 1, borderBottomColor: C.line }}>
      <Txt v="title">Leaders</Txt>
      <Txt v="small">{tab === 'lps'
        ? 'Wallets that put liquidity on launchpad tokens before they graduated. Hits are the tokens that went on to graduate.'
        : 'People who called a token on its curve. A call scores when the token graduates.'}</Txt>
      <Seg value={tab} onChange={setTab} options={[{ value: 'lps', label: 'LP wallets' }, { value: 'callers', label: 'Callers' }]} />
      {tab === 'lps' ? <Seg value={chain} onChange={setChain} options={[{ value: 'all', label: 'All' }, { value: 'solana', label: 'Solana' }, { value: 'robinhood', label: 'Robinhood' }]} /> : null}
    </View>
  )

  if (tab === 'callers') return (
    <Screen>
      <FlatList data={callers ?? []} keyExtractor={c => c.profile.pubkey} ListHeaderComponent={header}
        renderItem={({ item, index }) => (
          <Pressable onPress={() => router.push(`/profile/${item.profile.pubkey}`)} style={{ flexDirection: 'row', gap: 12, alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: C.line }}>
            <Txt v="monoSmall" style={{ width: 22, textAlign: 'right' }}>{index + 1}</Txt>
            <Txt v="h2" style={{ flex: 1 }}>{item.profile.handle ? '@' + item.profile.handle : short(item.profile.pubkey)}</Txt>
            <Txt v="num" color={item.hits ? C.good : C.muted}>{item.hits}/{item.calls}</Txt>
            <Txt v="monoSmall">{pct(item.hitRate)}</Txt>
          </Pressable>
        )}
        ListEmptyComponent={callers === null ? <Loading /> : <Empty title="No callers yet" body="Open a token still on its curve and post a call." />} />
    </Screen>
  )
  return (
    <Screen>
      <FlatList data={wallets ?? []} keyExtractor={w => `${w.chain}:${w.address}`} ListHeaderComponent={header}
        renderItem={({ item, index }) => <WalletRow w={item} now={now} rank={index + 1} />}
        ListEmptyComponent={wallets === null ? <Loading /> : <Empty title="Building the board" body="A wallet shows up after it touches two launchpad tokens before graduation." />} />
    </Screen>
  )
}
