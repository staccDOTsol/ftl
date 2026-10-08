import { useCallback, useEffect, useRef, useState } from 'react'
import { FlatList, RefreshControl, View } from 'react-native'
import { router } from 'expo-router'
import { C, FLAG } from '@/theme'
import { get } from '@/lib/api'
import { useLive } from '@/lib/live'
import type { Chain, Flag, TokenSummary } from '@/lib/types'
import { TokenRow } from '@/components/rows'
import { Button, Empty, Loading, Screen, Seg, Txt } from '@/components/ui'

export default function Signals() {
  const l = useLive()
  const [chain, setChain] = useState<'all' | Chain>('all')
  const [sort, setSort] = useState<'hot' | 'new'>('hot')
  const [result, setResult] = useState<{ key: string; rows: TokenSummary[] } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const requestId = useRef(0)
  const key = `${chain}:${sort}`

  const load = useCallback(async () => {
    const id = ++requestId.current
    const r = await get<TokenSummary[]>('/api/tokens/hot', { chain: chain === 'all' ? undefined : chain, sort, hours: 12, limit: 100 }).catch(() => [])
    if (id === requestId.current) setResult({ key, rows: r })
  }, [chain, sort, key])
  useEffect(() => { void load() }, [load])

  // Merge live token updates in render so the feed never refetches on every tick.
  const rows = result && result.key === key
    ? result.rows.map(t => {
      const u = l.tokens.get(`${t.chain}:${t.address}`)
      return u && u.lastTs !== t.lastTs ? { ...t, ...u } : t
    })
    : null
  if (rows && sort === 'hot') rows.sort((a, b) => b.score - a.score)

  const flags: Flag[] = ['pounce', 'burst_5_600', 'honeypot_fee', 'ladder', 'jit', 'multi_venue']
  return (
    <Screen>
      <FlatList
        data={rows ?? []}
        keyExtractor={t => `${t.chain}:${t.address}`}
        renderItem={({ item, index }) => <TokenRow t={item} rank={index + 1} spark={l.tokenRate.get(`${item.chain}:${item.address}`)} />}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={C.accent} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false) }} />}
        ListHeaderComponent={
          <View style={{ padding: 16, gap: 10, borderBottomWidth: 1, borderBottomColor: C.line }}>
            <Txt v="title">Signals</Txt>
            <Txt v="small">Tokens ranked by the liquidity structure around them in the last 12 hours: pools, funded pools, LP wallets and the book’s fingerprints.</Txt>
            <View style={{ borderWidth: 1, borderColor: C.line, backgroundColor: C.surface, padding: 12, borderRadius: 12, gap: 8 }}>
              <Txt v="h2">After the launch</Txt>
              <Txt v="small">See coins FTL has observed on Solana and Robinhood Chain, their live liquidity events, and which research sources are still missing.</Txt>
              <Button label="Open Research →" kind="ghost" onPress={() => router.push('/research')} />
            </View>
            <Seg value={chain} onChange={setChain} options={[{ value: 'all', label: 'All' }, { value: 'solana', label: 'Solana' }, { value: 'robinhood', label: 'Robinhood' }]} />
            <Seg value={sort} onChange={setSort} options={[{ value: 'hot', label: 'Highest score' }, { value: 'new', label: 'Newest first pool' }]} />
            <View style={{ gap: 4 }}>
              {flags.map(f => <Txt key={f} v="small"><Txt v="monoSmall" color={FLAG[f].color}>{FLAG[f].label}</Txt>  {FLAG[f].about}</Txt>)}
            </View>
          </View>
        }
        ListEmptyComponent={rows === null ? <Loading /> : <Empty title="No signals yet" body="Tokens show up here once pools open on them." />}
      />
    </Screen>
  )
}
