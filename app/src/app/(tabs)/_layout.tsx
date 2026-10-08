import { Tabs } from 'expo-router'
import { C } from '@/theme'
import { NavBar, useWide } from '@/components/NavBar'

export default function TabsLayout() {
  const wide = useWide()
  return (
    <Tabs tabBar={(p) => <NavBar {...p} />} screenOptions={{
      headerShown: false,
      tabBarPosition: wide ? 'left' : 'bottom',
      sceneStyle: { backgroundColor: C.bg },
      animation: 'fade',
    }}>
      <Tabs.Screen name="index" options={{ title: 'Now' }} />
      <Tabs.Screen name="signals" options={{ title: 'Signals' }} />
      <Tabs.Screen name="following" options={{ title: 'Following' }} />
      <Tabs.Screen name="leaders" options={{ title: 'Leaders' }} />
      <Tabs.Screen name="me" options={{ title: 'You' }} />
    </Tabs>
  )
}
