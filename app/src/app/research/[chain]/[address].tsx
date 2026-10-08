import { useCallback, useEffect, useState } from 'react'
import { RefreshControl, ScrollView, View } from 'react-native'
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { C, CHAIN } from '@/theme'
import { get } from '@/lib/api'
import { live } from '@/lib/live'
import { short } from '@/lib/format'
import type { Chain, ResearchCoinDetail } from '@/lib/types'
import { ResearchReport, ResearchStatus, researchName } from '@/components/Research'
import { Empty, Loading, Press, Screen, TokenAvatar, Txt } from '@/components/ui'

export default function ResearchDetail() {
  const { chain, address } = useLocalSearchParams<{ chain: Chain; address: string }>()
  const [coin, setCoin] = useState<ResearchCoinDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    if (!chain || !address) return
    try {
      const result = await get<ResearchCoinDetail>(`/api/research/${chain}/${encodeURIComponent(address)}`)
      setCoin(result)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this research report.')
    }
  }, [chain, address])

  useFocusEffect(useCallback(() => {
    void load()
  }, [load]))

  useEffect(() => live.onResearch(change => {
    if (!chain || !address) return
    const key = `${chain}:${chain === 'robinhood' ? address.toLowerCase() : address}`
    if (change.all || change.keys.includes(key)) void load()
  }), [chain, address, load])

  const visibleCoin = coin?.chain === chain && coin.address === (chain === 'robinhood' ? address?.toLowerCase() : address) ? coin : null

  if (!visibleCoin) return (
    <Screen edges={[]}>
      <Stack.Screen options={{ title: 'Research' }} />
      {error ? <Empty title="Report unavailable" body={error} /> : <Loading />}
    </Screen>
  )

  return (
    <Screen edges={[]}>
      <Stack.Screen options={{ title: researchName(visibleCoin) }} />
      <ScrollView refreshControl={<RefreshControl refreshing={refreshing} tintColor={C.accent} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false) }} />}
        contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 16 }}>
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
          <TokenAvatar image={visibleCoin.image} label={researchName(visibleCoin)} size={56} chain={visibleCoin.chain} />
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <Txt v="title" numberOfLines={1}>{researchName(visibleCoin)}</Txt>
            <Txt v="monoSmall" numberOfLines={1}>{CHAIN[visibleCoin.chain].label} · {visibleCoin.name || short(visibleCoin.address, 8)}</Txt>
            <ResearchStatus coin={visibleCoin} />
          </View>
        </View>
        <Txt v="monoSmall" selectable>{visibleCoin.address}</Txt>
        <Press onPress={() => router.push(`/token/${visibleCoin.chain}/${visibleCoin.address}`)}
          accessibilityRole="button" accessibilityLabel={`Open ${researchName(visibleCoin)} token page`}
          style={({ pressed, hovered }) => [{ padding: 14, borderRadius: 10, borderWidth: 1,
            borderColor: C.line, backgroundColor: hovered ? C.hover : C.surface }, pressed && { opacity: 0.7 }]}>
          <Txt v="small" color={C.accent}>Open token · live liquidity, calls and trade →</Txt>
        </Press>
        {visibleCoin.statusReason ? <Txt v="small" color={visibleCoin.status === 'error' ? C.warn : C.muted}>{visibleCoin.statusReason}</Txt> : null}
        {error ? <Txt v="small" color={C.warn}>Could not get the latest report: {error}. Showing the last fetched report.</Txt> : null}
        <ResearchReport coin={visibleCoin} />
      </ScrollView>
    </Screen>
  )
}
