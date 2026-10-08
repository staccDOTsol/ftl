import { Linking, View } from 'react-native'
import type { FlowEvent, PoolSummary, TokenSummary } from '@/lib/types'
import { Button, Txt } from './ui'

// Helius Wallet Kit 1.1 is web-only. Do not present a native signing stub.
export default function SolanaTrade({ t }: { t: TokenSummary; pools: PoolSummary[]; origin?: FlowEvent | null; initialAction?: 'exit' | 'liquidity' }) {
  return <View style={{ gap: 10 }}>
    <Txt v="h2">Trade this market</Txt>
    <Txt v="small">In-app Solana signing is available on the web. This native build does not yet have a compatible trading wallet.</Txt>
    <Button label="Open web trading" onPress={() => void Linking.openURL(`https://${process.env.EXPO_PUBLIC_WEB_HOST ?? 'liquidityxyz.fun'}/token/solana/${t.address}`)} />
  </View>
}
