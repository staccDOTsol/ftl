// /swap?in=<mint|SOL>&out=<mint>&amount=<decimal>: the router's full-page
// swap terminal, one centered card. /swap?mode=liquidity&out=<mint>[&pool=<address>]
// opens the same card in Liquidity mode on that token (Simple deposit;
// &action=exit for Simple withdraw, &advanced=1 for the full form).
import { useMemo } from 'react'
import { ScrollView, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { parseSwapLink } from '@/lib/swap-link'
import SwapTerminal from '@/components/SwapTerminal'
import { Screen } from '@/components/ui'

export default function SwapScreen() {
  const { in: inParam, out: outParam, amount: amountParam, mode: modeParam, pool: poolParam, action: actionParam, advanced: advancedParam } = useLocalSearchParams<{ in?: string; out?: string; amount?: string; mode?: string; pool?: string; action?: string; advanced?: string }>()
  // Read once per distinct link so typing in the terminal never re-seeds it.
  const initial = useMemo(() => parseSwapLink({ in: inParam, out: outParam, amount: amountParam, mode: modeParam, pool: poolParam, action: actionParam, advanced: advancedParam }), [inParam, outParam, amountParam, modeParam, poolParam, actionParam, advancedParam])
  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 24, paddingBottom: 64, alignItems: 'center' }} keyboardShouldPersistTaps="handled">
        <View style={{ width: '100%', maxWidth: 460 }}>
          <SwapTerminal key={`${initial.inputMint}|${initial.outputMint ?? ''}|${initial.amount}|${initial.mode}|${initial.pool ?? ''}|${initial.action ?? ''}|${initial.advanced ? 1 : 0}`} initial={initial} />
        </View>
      </ScrollView>
    </Screen>
  )
}
