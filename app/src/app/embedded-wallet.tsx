import { useEffect } from 'react'
import { Platform } from 'react-native'
import EmbeddedWallet from '@/components/EmbeddedWallet'

const LIVE_WALLET = 'https://www.liquidityxyz.fun/embedded-wallet'

export default function EmbeddedWalletRoute() {
  const preview = Platform.OS === 'web' && typeof window !== 'undefined' &&
    window.location.hostname.endsWith('.vercel.app')

  useEffect(() => {
    if (preview) window.location.replace(LIVE_WALLET)
  }, [preview])

  return preview ? null : <EmbeddedWallet />
}
