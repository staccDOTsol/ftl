import { View } from 'react-native'
import { Txt } from './ui'

// Browser wallets and the Helius embedded wallet are web-only. On native, the
// pasted-address path on the holdings screen does the same read.
export default function HoldingsWallet(_props: { onAddress: (address: string) => void }) {
  return <View style={{ gap: 6 }}>
    <Txt v="small">Wallet connection is available on the web. Paste a wallet address above to see what it can do.</Txt>
  </View>
}
