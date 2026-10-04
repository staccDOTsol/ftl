import { useState } from 'react'
import { ScrollView, TextInput, View } from 'react-native'
import { C, CHAIN, F } from '@/theme'
import { API_URL } from '@/lib/api'
import { useLive } from '@/lib/live'
import { useSocial } from '@/lib/social'
import { enableAlerts } from '@/lib/notify'
import { ago } from '@/lib/format'
import { Button, Screen, Section, Txt } from '@/components/ui'
import { laneLabel } from '@/components/NavBar'

export default function Me() {
  const social = useSocial()
  const l = useLive()
  const [handle, setHandle] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [alerts, setAlerts] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
        <View style={{ padding: 16, gap: 8 }}>
          <Txt v="title">{social.profile?.handle ? '@' + social.profile.handle : 'You'}</Txt>
          <Txt v="small">Your account is a key on this device. Its public half is a Solana address; every follow, call and like is signed with it. Nothing else to sign up for.</Txt>
          <Txt v="monoSmall" selectable>{social.pubkey ?? '…'}</Txt>
        </View>

        <Section title="Handle">
          <View style={{ paddingHorizontal: 16, gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: C.lineStrong, borderRadius: 10, paddingHorizontal: 12, backgroundColor: C.surface }}>
              <Txt v="mono" color={C.muted}>@</Txt>
              <TextInput value={handle} onChangeText={setHandle} placeholder={social.profile?.handle ?? 'pick a handle'} placeholderTextColor={C.faint} autoCapitalize="none" autoCorrect={false} style={{ flex: 1, height: 44, color: C.text, fontFamily: F.mono, fontSize: 15 }} />
            </View>
            {msg ? <Txt v="small" color={msg.startsWith('Saved') ? C.good : C.bad}>{msg}</Txt> : null}
            <Button label="Save handle" kind="ghost" busy={busy} disabled={!handle.trim()} onPress={async () => {
              setBusy(true)
              try { await social.setHandle(handle.trim()); setMsg('Saved'); setHandle('') } catch (e: any) { setMsg(e.message) }
              setBusy(false)
            }} />
          </View>
        </Section>

        <Section title="Alerts">
          <View style={{ paddingHorizontal: 16, gap: 8 }}>
            <Txt v="small">Get pinged when a wallet you follow opens, adds or pulls liquidity, or when a token you follow gets a new pool or a book flag.</Txt>
            <Button label="Turn on alerts" onPress={async () => { const r = await enableAlerts(); setAlerts(r.ok ? (r.push ? 'On: push alerts registered.' : `On while the app is open. ${r.reason ?? ''}`) : `Off: ${r.reason}`) }} />
            {alerts ? <Txt v="small" color={C.accent}>{alerts}</Txt> : null}
          </View>
        </Section>

        <Section title="Feeds">
          <View style={{ paddingHorizontal: 16, gap: 10 }}>
            {(l.status?.lanes ?? []).map(s => (
              <View key={`${s.chain}:${s.lane}`} style={{ gap: 2 }}>
                <Txt v="mono"><Txt v="mono" color={CHAIN[s.chain].color}>{CHAIN[s.chain].short}</Txt>  {laneLabel(s)}  <Txt v="mono" color={!s.enabled ? C.faint : s.connected ? C.good : C.bad}>{!s.enabled ? 'off' : s.connected ? 'connected' : 'reconnecting'}</Txt></Txt>
                <Txt v="monoSmall">{s.enabled ? `${s.events} events · first on ${s.firstSeenWins}${s.p50LeadMs !== undefined ? ` · median lead ${s.p50LeadMs} ms` : ''}${s.lastMsgTs ? ` · last ${ago(s.lastMsgTs)} ago` : ''}` : s.reason}</Txt>
              </View>
            ))}
            <Txt v="monoSmall">{l.status ? `${l.status.eventsStored} events stored · ${l.status.clients} watching` : ''} · {API_URL}</Txt>
          </View>
        </Section>

        <Section title="About">
          <View style={{ paddingHorizontal: 16, gap: 8 }}>
            <Txt v="small">FTL follows liquidity, not price. Bot crews arm a launch with pools before it moves: pools on a token still on its curve, bursts of funded pools within minutes, honeypot fee tiers, price ladders with no depth, liquidity pulled within blocks. The signals come from the forensic record in staccDOTsol/the-book.</Txt>
            <Txt v="small">Robinhood Chain streams over dRPC. Solana races Triton Preconfs, Deshred and Dragon’s Mouth, and dRPC Geyser when configured. The first lane to see a transaction posts it; the executed copy confirms it and sizes it.</Txt>
            <Txt v="small" color={C.faint}>Not financial advice. Pools with 70%+ fees exist to take a buyer’s input.</Txt>
          </View>
        </Section>
      </ScrollView>
    </Screen>
  )
}
