import { Text, type ColorValue } from 'react-native'
import { Tabs } from 'expo-router'
import { C, F } from '@/theme'

const icon = (glyph: string) => ({ color }: { color: ColorValue }) => <Text style={{ color, fontSize: 18, fontFamily: F.monoBold, lineHeight: 22 }}>{glyph}</Text>

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{
      headerShown: false,
      tabBarActiveTintColor: C.accent,
      tabBarInactiveTintColor: C.faint,
      tabBarStyle: { backgroundColor: C.bg, borderTopColor: C.line },
      tabBarLabelStyle: { fontFamily: F.bodyMedium, fontSize: 11 },
      sceneStyle: { backgroundColor: C.bg },
    }}>
      <Tabs.Screen name="index" options={{ title: 'Live', tabBarIcon: icon('◉') }} />
      <Tabs.Screen name="signals" options={{ title: 'Signals', tabBarIcon: icon('▲') }} />
      <Tabs.Screen name="following" options={{ title: 'Following', tabBarIcon: icon('♥') }} />
      <Tabs.Screen name="leaders" options={{ title: 'Leaders', tabBarIcon: icon('★') }} />
      <Tabs.Screen name="me" options={{ title: 'You', tabBarIcon: icon('●') }} />
    </Tabs>
  )
}
