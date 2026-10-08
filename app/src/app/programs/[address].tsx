import { ScrollView, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import { useProgramDetail } from '@/lib/use-program-index'
import { programStateLabel } from '@/lib/program-model'
import { short } from '@/lib/format'
import { C } from '@/theme'
import { Loading, Screen, Txt } from '@/components/ui'

export default function Program() {
  const { address } = useLocalSearchParams<{ address: string }>()
  const { detail, error } = useProgramDetail(typeof address === 'string' ? address : null)
  return <Screen edges={[]}><Stack.Screen options={{ title: 'Program evidence' }} /><ScrollView contentContainerStyle={{ padding: 18, gap: 18 }}>
    {!detail ? error ? <Txt>{error}</Txt> : <Loading /> : <><Txt v="title">{detail.program.name ?? short(detail.program.address, 8)}</Txt><Txt v="monoSmall" selectable>{detail.program.address}</Txt><Txt v="h2" color={C.gold}>{programStateLabel[detail.program.state]}</Txt><Txt>{detail.program.phase}</Txt><Txt v="small">{detail.program.transactions} transactions · {detail.program.atomicTransactions} atomic routes · {detail.program.bundleHintTransactions} Jito tip hints</Txt>
      <Txt v="h2">Indexed instructions</Txt>{detail.instructions.map((ix, i) => <View key={`${ix.name}:${i}`} style={{ gap: 5 }}><Txt v="mono">{ix.name}</Txt><Txt v="small">{ix.accounts} accounts · {ix.pdaAccounts} PDA recipes · {ix.argsDecoded ? 'declared arguments' : 'opaque arguments'}</Txt></View>)}
      <Txt v="h2">Learning timeline</Txt>{detail.activity.map(event => <View key={event.id} style={{ gap: 5 }}><Txt v="monoSmall">{new Date(event.ts).toLocaleString()}</Txt><Txt v="small">{event.message}</Txt></View>)}</>}
  </ScrollView></Screen>
}
