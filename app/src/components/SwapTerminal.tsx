import { Linking, View } from 'react-native'
import type { SwapLink } from '@/lib/swap-link'
import { swapLink } from '@/lib/swap-link'
import { Button, Txt } from './ui'

// Solana signing is web-only (wallet-standard, injected wallets, Helius Wallet
// Kit). Native builds hand off to the web terminal with the same deep link.
export default function SwapTerminal({ initial }: { initial: SwapLink }) {
  return <View style={{ gap: 10, padding: 14 }}>
    <Txt v="h1">{initial.mode === 'liquidity' ? 'Liquidity' : 'Swap'}</Txt>
    <Txt v="small">The swap terminal signs with browser and embedded wallets on the web. This native build does not yet have a compatible trading wallet.</Txt>
    <Button label="Open the web swap terminal" onPress={() => void Linking.openURL(`https://${process.env.EXPO_PUBLIC_WEB_HOST ?? 'liquidityxyz.fun'}${swapLink(initial.inputMint, initial.outputMint, initial.amount, { mode: initial.mode, pool: initial.pool, action: initial.action })}`)} />
  </View>
}
