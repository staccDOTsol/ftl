import { useCallback, useEffect, useRef, useState } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, TextInput, View } from 'react-native'
import { Stack, router, useFocusEffect } from 'expo-router'
import { C } from '@/theme'
import { get } from '@/lib/api'
import type { ResearchCoin, ResearchCoinDetail, ResearchList } from '@/lib/types'
import { live } from '@/lib/live'
import { webData } from '@/lib/web-props'
import { ResearchRow } from '@/components/Research'
import { Empty, Loading, Screen, Seg, Txt } from '@/components/ui'

type Mode = 'holders' | 'bottoming'
type ChainFilter = 'all' | 'solana' | 'robinhood'
const keyOf = (coin: ResearchCoin) => `${coin.chain}:${coin.address}`

export default function ResearchIndex() {
  const [mode, setMode] = useState<Mode>('holders')
  const [chain, setChain] = useState<ChainFilter>('all')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [items, setItems] = useState<ResearchCoin[] | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [backlog, setBacklog] = useState<number | null>(null)
  const [coverageNote, setCoverageNote] = useState('Research coverage is warming up.')
  const [showCoverage, setShowCoverage] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const moreInFlight = useRef(false)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    const next = searchInput.trim()
    const timer = setTimeout(() => {
      if (next === search) return
      generation.current++
      setItems(null)
      setNextCursor(null)
      setTotal(0)
      setSearch(next)
    }, 250)
    return () => clearTimeout(timer)
  }, [searchInput, search])

  useEffect(() => {
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = null
    }
  }, [search, chain])

  const load = useCallback(async () => {
    const current = ++generation.current
    try {
      const result = await get<ResearchList>('/api/research', { search, chain: chain === 'all' ? undefined : chain })
      if (current !== generation.current) return
      setItems(result.items)
      setNextCursor(result.nextCursor)
      setTotal(result.total)
      setBacklog(result.backlog)
      setCoverageNote(result.coverageNote)
      setError(null)
    } catch (e) {
      if (current !== generation.current) return
      setError(e instanceof Error ? e.message : 'Research is unavailable right now.')
    }
  }, [search, chain])

  const refreshLatest = useCallback(async () => {
    const current = ++generation.current
    try {
      const result = await get<ResearchList>('/api/research', { search, chain: chain === 'all' ? undefined : chain })
      if (current !== generation.current) return
      setItems(previous => {
        if (!previous) return result.items
        const newest = new Set(result.items.map(keyOf))
        return [...result.items, ...previous.filter(x => !newest.has(keyOf(x)))]
      })
      setNextCursor(previous => previous ?? result.nextCursor)
      setTotal(result.total)
      setBacklog(result.backlog)
      setCoverageNote(result.coverageNote)
      setError(null)
    } catch (e) {
      if (current !== generation.current) return
      setError(e instanceof Error ? e.message : 'Research is unavailable right now.')
    }
  }, [search, chain])

  useFocusEffect(useCallback(() => {
    void load()
  }, [load]))

  useEffect(() => live.onResearch(change => {
    if (change.all) { void load(); return }
    const present = new Map(items?.map(x => [keyOf(x), x]) ?? [])
    const changed = change.keys.map(key => present.get(key)).filter((x): x is ResearchCoin => x !== undefined)
    if (change.enrolled && !refreshTimer.current) refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null
      void (search || chain !== 'all' ? load() : refreshLatest())
    }, 750)
    if (!changed.length) return
    if (!change.enrolled && changed.length > 25) { void load(); return }
    void Promise.all(changed.map(coin => get<ResearchCoinDetail>(`/api/research/${coin.chain}/${encodeURIComponent(coin.address)}`).catch(() => null)))
      .then(fresh => {
        const byKey = new Map(fresh.filter((x): x is ResearchCoinDetail => x !== null).map(x => [keyOf(x), x]))
        if (byKey.size) setItems(previous => previous?.map(x => byKey.get(keyOf(x)) ?? x) ?? previous)
      })
  }), [items, load, refreshLatest, search, chain])

  const loadMore = useCallback(async () => {
    if (!nextCursor || moreInFlight.current) return
    const current = generation.current
    moreInFlight.current = true
    setLoadingMore(true)
    try {
      const result = await get<ResearchList>('/api/research', {
        cursor: nextCursor, search, chain: chain === 'all' ? undefined : chain,
      })
      if (current !== generation.current) return
      setItems(previous => {
        const seen = new Set(previous?.map(keyOf) ?? [])
        return [...(previous ?? []), ...result.items.filter(x => !seen.has(keyOf(x)))]
      })
      setNextCursor(result.nextCursor)
      setTotal(result.total)
      setBacklog(result.backlog)
      setCoverageNote(result.coverageNote)
      setError(null)
    } catch (e) {
      if (current !== generation.current) return
      setError(e instanceof Error ? e.message : 'Could not load more coins.')
    } finally {
      moreInFlight.current = false
      setLoadingMore(false)
    }
  }, [nextCursor, search, chain])

  return (
    <Screen edges={[]}>
      <Stack.Screen options={{ title: 'Research' }} />
      <FlatList
        data={items ?? []}
        keyExtractor={keyOf}
        renderItem={({ item }) => <ResearchRow coin={item} mode={mode} onPress={() => router.push(`/research/${item.chain}/${item.address}`)} />}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={C.accent} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false) }} />}
        onEndReached={() => { void loadMore() }}
        onEndReachedThreshold={0.4}
        contentContainerStyle={{ paddingBottom: 36 }}
        ListHeaderComponent={
          <View style={st.header} {...webData({ 'page-header': true })}>
            <View style={{ gap: 4 }}>
              <Txt v="label" color={C.accent}>The story behind the signal</Txt>
              <Txt v="title">Look a little deeper.</Txt>
              <Txt v="small">Holder strength, liquidity activity, and bottoming research. Coins and source coverage update automatically.</Txt>
              <Pressable onPress={() => setShowCoverage(value => !value)} accessibilityRole="button" accessibilityLabel={showCoverage ? 'Hide research coverage' : 'Show research coverage'}>
                <Txt v="monoSmall" color={C.accent}>{showCoverage ? 'Hide coverage ↑' : 'Coverage & limits ↓'}</Txt>
              </Pressable>
              {showCoverage ? <Txt v="small">{coverageNote}</Txt> : null}
            </View>
            <View style={{ gap: 12 }} {...webData({ 'research-controls': true })}>
              <View style={{ gap: 8 }}>
              <Txt v="label">Find a coin</Txt>
              <TextInput
                value={searchInput}
                onChangeText={setSearchInput}
                placeholder="Name, symbol or contract address"
                placeholderTextColor={C.faint}
                accessibilityLabel="Search research coins"
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={80}
                style={st.search}
              />
              </View>
              <View style={{ gap: 8 }}><Txt v="label">Chain</Txt>
              <Seg value={chain} onChange={value => {
                if (value === chain) return
                generation.current++
                setItems(null)
                setNextCursor(null)
                setTotal(0)
                setChain(value)
              }} options={[
                { value: 'all', label: 'All' },
                { value: 'solana', label: 'Solana' },
                { value: 'robinhood', label: 'Robinhood' },
              ]} />
              </View>
              <View style={{ gap: 8 }}>
              <Txt v="label">Focus</Txt>
              <Seg value={mode} onChange={setMode} options={[{ value: 'holders', label: 'Holder strength' }, { value: 'bottoming', label: 'Bottoming test' }]} />
              </View>
            </View>
            <Txt v="monoSmall">Newest first · {total} {search || chain !== 'all' ? 'matching coins' : 'coins'}{backlog !== null && backlog > 0 ? ` · ${backlog} awaiting sources` : ''}. Scores need a working source and enough history.</Txt>
            {error ? <Txt v="small" color={C.warn}>{error}</Txt> : null}
          </View>
        }
        ListEmptyComponent={items === null && !error ? <Loading /> : <Empty
          title={error ? 'Research unavailable' : search || chain !== 'all' ? 'No matching coins' : 'Watching for coins'}
          body={error || (search || chain !== 'all'
            ? 'Try another name, symbol or contract address.'
            : 'As FTL sees tokens on Solana and Robinhood Chain, their research status will appear here.')}
        />}
        ListFooterComponent={loadingMore ? <Loading /> : null}
      />
    </Screen>
  )
}

const st = StyleSheet.create({
  header: { padding: 16, gap: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  search: { borderWidth: 1, borderColor: C.line, borderRadius: 10, backgroundColor: C.surface,
    color: C.text, fontSize: 15, paddingHorizontal: 14, paddingVertical: 12 },
})
