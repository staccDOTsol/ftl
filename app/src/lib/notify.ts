// Alerts for followed wallets and tokens.
//  - native: Expo push tokens registered with the server (needs an EAS project id
//    and, for store builds, APNs/FCM credentials), plus local notifications from
//    the live socket while the app is open
//  - web: the browser Notification API while the tab is open

import { Platform } from 'react-native'
import { router } from 'expo-router'
import { eventLink } from './event-context'
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { post } from './api'
import { live } from './live'
import { followedMatch } from './social'
import { KIND } from '@/theme'
import { short, tokenLabel } from './format'

let enabled = false
let lastAt = 0

export async function enableAlerts(): Promise<{ ok: boolean; push: boolean; reason?: string }> {
  if (Platform.OS === 'web') {
    if (typeof Notification === 'undefined') return { ok: false, push: false, reason: 'This browser has no notifications' }
    const p = await Notification.requestPermission()
    enabled = p === 'granted'
    return { ok: enabled, push: false, reason: enabled ? undefined : 'Permission denied' }
  }
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  })
  if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('liquidity', { name: 'Liquidity', importance: Notifications.AndroidImportance.HIGH })
  const perm = await Notifications.requestPermissionsAsync()
  if (!perm.granted) return { ok: false, push: false, reason: 'Permission denied' }
  enabled = true
  const projectId = (Constants.expoConfig?.extra as any)?.eas?.projectId ?? Constants.easConfig?.projectId
  if (!Device.isDevice || !projectId) return { ok: true, push: false, reason: Device.isDevice ? 'No EAS project id: alerts only while the app is open' : 'Simulator: alerts only while the app is open' }
  try {
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data
    await post('/api/push', { token, platform: Platform.OS })
    return { ok: true, push: true }
  } catch (e: any) {
    return { ok: true, push: false, reason: String(e?.message ?? e) }
  }
}

// foreground alerts from the live socket
live.onEvent((e) => {
  if (!enabled || e.kind === 'launch' || !followedMatch(e)) return
  if (Date.now() - lastAt < 4000) return
  lastAt = Date.now()
  const title = `${tokenLabel(e)} · ${KIND[e.kind].label}`
  const body = `${short(e.wallet)} ${KIND[e.kind].verb}${e.flags.length ? ' · ' + e.flags.join(', ') : ''}`
  if (Platform.OS === 'web') {
    try { const notification = new Notification(title, { body }); notification.onclick = () => { router.push(eventLink(e)); notification.close() } } catch {}
  } else {
    void Notifications.scheduleNotificationAsync({ content: { title, body, data: { url: eventLink(e) } }, trigger: null })
  }
})
