import { useState } from 'react'
import { FlatList, StyleSheet, View } from 'react-native'
import { Stack, router } from 'expo-router'
import { useProgramIndex } from '@/lib/use-program-index'
import { programStateLabel, type ProgramMode } from '@/lib/program-model'
import { ago, short } from '@/lib/format'
import { C } from '@/theme'
import { Button, Empty, Loading, Press, Screen, Seg, Txt } from '@/components/ui'

export default function Programs() {
  const [mode, setMode] = useState<ProgramMode>('new')
  const { data, error, loading, refresh } = useProgramIndex(mode, '', 1)
  return <Screen edges={[]}><Stack.Screen options={{ title: 'Program frontier' }} /><FlatList data={data?.items ?? []} keyExtractor={item => item.address}
    ListHeaderComponent={<View style={styles.header}><Txt v="label" color={C.accent}>Solana / The Composer</Txt><Txt v="title">Program frontier</Txt><Txt v="small">New programs, outer instructions and CPI calls. Learning progress streams live.</Txt><Seg value={mode} onChange={setMode} options={[{ value: 'new', label: 'New' }, { value: 'usage', label: 'Usage' }, { value: 'atomic', label: 'Atomic' }, { value: 'working', label: 'Progress' }]} />{data ? <Txt v="monoSmall">{data.totals.unseen} unseen · {data.totals.queued} queued · {data.totals.ready + data.totals.partial} indexed</Txt> : null}</View>}
    renderItem={({ item }) => <Press onPress={() => router.push(`/programs/${item.address}`)} style={({ hovered }) => [styles.row, hovered && { backgroundColor: C.hover }]}><View style={{ flex: 1, gap: 5 }}><Txt v="h2">{item.name ?? short(item.address, 8)}</Txt><Txt v="monoSmall">{item.transactions} tx · {item.outerInvocations} outer / {item.innerInvocations} CPI</Txt><Txt v="small" color={item.state === 'ready' ? C.accent : C.gold}>{programStateLabel[item.state]} · {item.phase}</Txt></View><Txt v="monoSmall">{ago(item.firstSeenTs)}</Txt></Press>}
    ListEmptyComponent={loading ? <Loading /> : <Empty title={error ?? 'Listening for unseen programs'}>{error ? <Button label="Retry" onPress={refresh} /> : null}</Empty>}
    onRefresh={refresh} refreshing={loading} contentContainerStyle={{ paddingBottom: 30 }} /></Screen>
}
const styles = StyleSheet.create({ header: { padding: 18, gap: 12 }, row: { padding: 18, borderTopWidth: 1, borderTopColor: C.line, flexDirection: 'row', gap: 12 } })
