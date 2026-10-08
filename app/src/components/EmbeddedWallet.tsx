import { View } from 'react-native'
import { Screen, Txt } from '@/components/ui'

// Helius Wallet Kit 1.1.0 has no React Native/Expo implementation. Keep the
// route honest on native while the web variant uses the real Helius SDK.
export default function EmbeddedWalletNative() {
  return (
    <Screen>
      <View style={{ padding: 20, gap: 12 }}>
        <Txt v="title">Embedded wallet</Txt>
        <Txt v="small">Helius Wallet Kit currently supports web React only. An embedded Helius wallet is unavailable in this iOS or Android build.</Txt>
        <Txt v="small">Your FTL profile key still signs follows, calls, and likes on this device. It is separate from the Helius trading wallet.</Txt>
      </View>
    </Screen>
  )
}
