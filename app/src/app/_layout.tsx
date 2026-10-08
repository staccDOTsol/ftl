import { useEffect } from 'react'
import { Platform } from 'react-native'
import { DarkTheme, Slot, Stack, ThemeProvider, router } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as SplashScreen from 'expo-splash-screen'
import * as Notifications from 'expo-notifications'
import { useFonts, SpaceGrotesk_400Regular, SpaceGrotesk_500Medium, SpaceGrotesk_600SemiBold, SpaceGrotesk_700Bold } from '@expo-google-fonts/space-grotesk'
import { JetBrainsMono_400Regular, JetBrainsMono_600SemiBold } from '@expo-google-fonts/jetbrains-mono'
import { C, F } from '@/theme'
import { live } from '@/lib/live'
import { social } from '@/lib/social'
import '@/lib/notify'
import AppShell from '@/components/AppShell'

SplashScreen.preventAutoHideAsync().catch(() => {})

const theme = { ...DarkTheme, colors: { ...DarkTheme.colors, background: C.bg, card: C.bg, border: C.line, primary: C.accent, text: C.text } }

export default function Root() {
  const [loaded, fontError] = useFonts({ SpaceGrotesk_400Regular, SpaceGrotesk_500Medium, SpaceGrotesk_600SemiBold, SpaceGrotesk_700Bold, JetBrainsMono_400Regular, JetBrainsMono_600SemiBold })

  useEffect(() => { live.start(); void social.init() }, [])
  useEffect(() => { if (loaded || fontError) SplashScreen.hideAsync().catch(() => {}) }, [loaded, fontError])

  // tapping a push alert opens the token or wallet it is about
  useEffect(() => {
    if (Platform.OS === 'web') return
    const sub = Notifications.addNotificationResponseReceivedListener(r => {
      const url = r.notification.request.content.data?.url
      if (typeof url === 'string') router.push(url as any)
    })
    return () => sub.remove()
  }, [])

  if (!loaded && !fontError) return null
  return (
    <ThemeProvider value={theme}>
      <StatusBar style="light" />
      <AppShell>
      {Platform.OS === 'web' ? <Slot /> : <Stack screenOptions={{
        headerStyle: { backgroundColor: C.bg },
        headerTintColor: C.text,
        headerTitleStyle: { fontFamily: F.display },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: C.bg },
        headerBackButtonDisplayMode: 'minimal',
      }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false, title: 'liquidityxyz' }} />
        <Stack.Screen name="token/[chain]/[address]" options={{ title: 'Token' }} />
        <Stack.Screen name="holdings" options={{ title: 'What can I do' }} />
        <Stack.Screen name="swap" options={{ title: 'Swap' }} />
        <Stack.Screen name="research/index" options={{ title: 'Research' }} />
        <Stack.Screen name="research/[chain]/[address]" options={{ title: 'Coin research' }} />
        <Stack.Screen name="programs/index" options={{ title: 'Program frontier' }} />
        <Stack.Screen name="programs/[address]" options={{ title: 'Program evidence' }} />
        <Stack.Screen name="composer/index" options={{ title: 'Composer' }} />
        <Stack.Screen name="embedded-wallet" options={{ title: 'Embedded wallet' }} />
        <Stack.Screen name="wallet/[chain]/[address]" options={{ title: 'Wallet' }} />
        <Stack.Screen name="profile/[pubkey]" options={{ title: 'Profile' }} />
      </Stack>}
      </AppShell>
    </ThemeProvider>
  )
}
