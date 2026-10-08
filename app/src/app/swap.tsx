// /swap?in=<mint|SOL>&out=<mint>&amount=<decimal>: the router's full-page
// swap terminal, one centered card.
import { useMemo } from 'react'
import { ScrollView, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { parseSwapLink } from '@/lib/swap-link'
import SwapTerminal from '@/components/SwapTerminal'
import { Screen } from '@/components/ui'

export default function SwapScreen() {
  const { in: inParam, out: outParam, amount: amountParam } = useLocalSearchParams<{ in?: string; out?: string; amount?: string }>()
  // Read once per distinct link so typing in the terminal never re-seeds it.
  const initial = useMemo(() => parseSwapLink({ in: inParam, out: outParam, amount: amountParam }), [inParam, outParam, amountParam])
  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 24, paddingBottom: 64, alignItems: 'center' }} keyboardShouldPersistTaps="handled">
        <View style={{ width: '100%', maxWidth: 460 }}>
          <SwapTerminal key={`${initial.inputMint}|${initial.outputMint ?? ''}|${initial.amount}`} initial={initial} />
        </View>
      </ScrollView>
    </Screen>
  )
}
