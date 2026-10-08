import { lazy, Suspense } from 'react'
import { View } from 'react-native'
import { Screen, Txt } from './ui'

const WalletContents = lazy(() => import('./EmbeddedWalletContents.web'))

export default function EmbeddedWalletWeb() {
  return <Suspense fallback={<Screen><View style={{ padding: 20 }}><Txt v="small">Loading embedded wallet…</Txt></View></Screen>}><WalletContents /></Suspense>
}
