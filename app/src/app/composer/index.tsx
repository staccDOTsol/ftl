import { ScrollView, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import * as WebBrowser from 'expo-web-browser'
import { queryString } from '@/lib/composer'
import { C } from '@/theme'
import { Button, Screen, Txt } from '@/components/ui'

// The Composer signs with browser wallets (wallet-standard, injected, Helius
// embedded), which the native app does not carry. A deep link opened here is
// handed to the web workspace with every prefilled parameter intact.
const WEB = 'https://www.liquidityxyz.fun/composer'

export default function ComposerNative() {
  const params = useLocalSearchParams<Record<string, string | string[]>>()
  const query = queryString(Object.fromEntries(Object.entries(params).flatMap(([key, value]) => typeof value === 'string' ? [[key, value]] : Array.isArray(value) && value[0] ? [[key, value[0]]] : [])))
  const url = query ? `${WEB}?${query}` : WEB
  const prefilled = Object.keys(params).length
  return <Screen edges={[]}><Stack.Screen options={{ title: 'Composer' }} /><ScrollView contentContainerStyle={{ padding: 18, gap: 16 }}>
    <Txt v="label" color={C.accent}>Solana / The Composer</Txt>
    <Txt v="title">Compose any Solana transaction</Txt>
    <Txt v="small">The Composer turns a plain-language goal or a program’s IDL into an unsigned transaction for your wallet. Plans are ranked by whether they actually simulate against mainnet. The engine is a hosted service.</Txt>
    <Txt v="small">Signing happens with a browser wallet, so the workspace runs on the web. {prefilled ? 'This link’s prefilled fields open there unchanged.' : ''}</Txt>
    <View style={{ gap: 8 }}><Button label="Open the Composer" onPress={() => void WebBrowser.openBrowserAsync(url)} /></View>
    <Txt v="monoSmall" selectable>{url}</Txt>
  </ScrollView></Screen>
}
