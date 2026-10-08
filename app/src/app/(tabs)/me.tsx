import { useState } from 'react'
import { Linking, Platform, ScrollView, TextInput, View } from 'react-native'
import { router } from 'expo-router'
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
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteMsg, setDeleteMsg] = useState<string | null>(null)

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
        <View style={{ padding: 16, gap: 8 }}>
          <Txt v="title">{social.profile?.handle ? '@' + social.profile.handle : 'You'}</Txt>
          <Txt v="small">Your account is a key on this device. Its public half is a Solana address; every follow, call and like is signed with it. Nothing else to sign up for.</Txt>
          <Txt v="monoSmall" selectable>{social.pubkey ?? (social.ready ? 'No active FTL profile key' : '…')}</Txt>
        </View>

        <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 8 }}>
          <Button label="What can I do with what I’m holding?" onPress={() => router.push('/holdings')} />
          <Txt v="small">Paste or connect a Solana wallet. FTL reads its SOL, tokens and liquidity positions and lists the exits, sells, adds and buys it can execute here.</Txt>
          <Button label="Swap ⇄" kind="ghost" onPress={() => router.push('/swap')} />
          <Txt v="small">Swap any two Solana tokens through FTL’s router in one full-page terminal.</Txt>
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

        {Platform.OS === 'web' ? <Section title="Embedded wallet">
          <View style={{ paddingHorizontal: 16, gap: 8 }}>
            <Txt v="small">Create or sign in to a non-custodial Solana wallet with Helius Wallet Kit. This trading wallet is separate from your FTL profile key.</Txt>
            <Button label="Open embedded wallet" kind="ghost" onPress={() => router.push('/embedded-wallet')} />
          </View>
        </Section> : null}

        <Section title="Privacy and account">
          <View style={{ paddingHorizontal: 16, gap: 8 }}>
            <Txt v="small">Your calls, comments, likes, follows, handle, and optional push token are tied to this device profile key. Public blockchain activity is separate.</Txt>
            <Button label="Read privacy policy" kind="ghost" onPress={() => void Linking.openURL('https://www.liquidityxyz.fun/privacy.html')} />
            <Button label="Account deletion details" kind="quiet" onPress={() => void Linking.openURL('https://www.liquidityxyz.fun/account-deletion.html')} />
            <Button label="Source on GitHub ↗" kind="quiet" onPress={() => void Linking.openURL('https://github.com/staccDOTsol/ftl')} />
            {deleteMsg ? <Txt v="small" color={deleteMsg.startsWith('Deleted') ? C.good : C.bad}>{deleteMsg}</Txt> : null}
            {!confirmDelete ? <Button label="Delete my profile and data" kind="ghost" disabled={!social.pubkey} onPress={() => { setDeleteMsg(null); setConfirmDelete(true) }} /> : (
              <View style={{ gap: 8, padding: 12, borderWidth: 1, borderColor: C.bad, borderRadius: 10 }}>
                <Txt v="small">This permanently deletes your FTL profile, calls, comments, likes, follows, and push registration, then removes this device’s profile key. Public blockchain records and any separate trading wallet remain. This cannot be undone.</Txt>
                <Button label="Permanently delete" busy={deleteBusy} onPress={() => void (async () => {
                  setDeleteBusy(true)
                  try {
                    await social.deleteAccount()
                    setDeleteMsg('Deleted. Your FTL profile and local profile key have been removed.')
                    setConfirmDelete(false)
                  } catch (e) {
                    setDeleteMsg(e instanceof Error ? e.message : 'Deletion failed. Please try again.')
                  } finally { setDeleteBusy(false) }
                })()} />
                <Button label="Keep my profile" kind="quiet" disabled={deleteBusy} onPress={() => setConfirmDelete(false)} />
              </View>
            )}
          </View>
        </Section>

        <Section title="Feeds">
          <View style={{ paddingHorizontal: 16, gap: 10 }}>
            {(l.status?.lanes ?? []).map(s => (
              <View key={`${s.chain}:${s.lane}`} style={{ gap: 2 }}>
                <Txt v="mono"><Txt v="mono" color={CHAIN[s.chain].color}>{CHAIN[s.chain].short}</Txt>  {laneLabel(s)}  <Txt v="mono" color={!s.enabled ? C.faint : s.connected ? C.good : C.bad}>{!s.enabled ? 'off' : s.connected ? 'connected' : s.circuitOpenUntil ? 'budget pause' : 'reconnecting'}</Txt></Txt>
                <Txt v="monoSmall">{s.enabled ? `${s.configuredStreams !== undefined ? `${s.activeStreams ?? 0}/${s.configuredStreams} streams · ${s.msgs} messages · ` : ''}${s.events} events · first on ${s.firstSeenWins}${s.p50LeadMs !== undefined ? ` · median lead ${s.p50LeadMs} ms` : ''}${s.lastMsgTs ? ` · last ${ago(s.lastMsgTs)} ago` : ''}${s.reason ? ` · ${s.reason}` : ''}` : s.reason}</Txt>
                {s.estimatedPayloadBytes !== undefined && s.payloadSamples ? <Txt v="monoSmall">~{(s.estimatedPayloadBytes / 1024 / 1024).toFixed(1)} MB protobuf payload estimated from {s.payloadSamples} samples; provider billing may differ</Txt> : null}
                {s.budgetLimitBytes !== undefined ? <Txt v="monoSmall">{s.budgetLimitBytes > 0
                  ? `Rolling 1h cap: ${((s.estimatedWindowPayloadBytes ?? 0) / 1024 / 1024).toFixed(0)} / ${(s.budgetLimitBytes / 1024 / 1024).toFixed(0)} MiB estimated${s.circuitOpenUntil ? ` · resumes ${new Date(s.circuitOpenUntil).toLocaleTimeString()}` : ''}`
                  : s.budgetPayloadSamples
                    ? `Past 1h payload: ~${((s.estimatedWindowPayloadBytes ?? 0) / 1024 / 1024).toFixed(1)} MiB estimated · ~${((s.estimatedWindowPayloadBytes ?? 0) * 24 / 1024 / 1024).toFixed(1)} MiB/day if repeated · no app cutoff`
                    : 'Payload sampling starting · no app cutoff'}</Txt> : null}
              </View>
            ))}
            <Txt v="monoSmall">{l.status ? `${l.status.eventsStored} events stored · ${l.status.clients} watching` : ''} · {API_URL}</Txt>
          </View>
        </Section>

        <Section title="About">
          <View style={{ paddingHorizontal: 16, gap: 8 }}>
            <Txt v="small">liquidityxyz follows liquidity, not price. Bot crews arm a launch with pools before it moves: pools on a token still on its curve, bursts of funded pools within minutes, honeypot fee tiers, price ladders with no depth, liquidity pulled within blocks. The signals come from the forensic record in staccDOTsol/the-book.</Txt>
            <Txt v="small">Robinhood Chain streams over dRPC. Solana uses filtered Helius parsed events and Flux Yellowstone for uncovered instructions and failover. The first lane to see a transaction posts it; an executed copy confirms it and sizes it.</Txt>
            <Txt v="small" color={C.faint}>Not financial advice. Pools with 70%+ fees exist to take a buyer’s input.</Txt>
          </View>
        </Section>
      </ScrollView>
    </Screen>
  )
}
