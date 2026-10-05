import { useCallback, useEffect, useState } from 'react'
import { FlatList, RefreshControl, View } from 'react-native'
import { C, FLAG } from '@/theme'
import { get } from '@/lib/api'
import { useLive } from '@/lib/live'
import { useNow } from '@/lib/useNow'
import type { Chain, Flag, TokenSummary } from '@/lib/types'
import { TokenRow } from '@/components/rows'
import { Empty, Loading, Screen, Seg, Txt } from '@/components/ui'

export default function Signals() {
  const now = useNow(5000)
  const l = useLive()
  const [chain, setChain] = useState<'all' | Chain>('all')
  const [sort, setSort] = useState<'hot' | 'new'>('hot')
  const [rows, setRows] = useState<TokenSummary[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    const r = await get<TokenSummary[]>('/api/tokens/hot', { chain: chain === 'all' ? undefined : chain, sort, hours: 12, limit: 100 }).catch(() => [])
    setRows(r)
  }, [chain, sort])
  useEffect(() => { setRows(null); void load() }, [load])

  // merge live token updates into the list without refetching
  useEffect(() => {
    if (!rows) return
    let changed = false
    const next = rows.map(t => { const u = l.tokens.get(`${t.chain}:${t.address}`); if (u && u.lastTs !== t.lastTs) { changed = true; return { ...t, ...u } } return t })
    if (changed) setRows(sort === 'hot' ? [...next].sort((a, b) => b.score - a.score) : next)
  }, [l.tokenTick])

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
