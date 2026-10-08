// Disclosure for decoded routes: the wallet replays a landed swap through a
// program liquidityxyz learned by observation, not one of its recognized
// venues. The route is quoted from the landing's ratio and its outcome is
// simulated against the quoted minimum before anything is signed. Signing
// needs one acknowledgement per browser and program, like composed routes.
import { Linking, StyleSheet, View } from 'react-native'
import { C } from '@/theme'
import { short } from '@/lib/format'
import { DECODED_PROGRAM_SOURCE, type SolanaQuote } from '@/lib/solana-trade'
import { Press, Txt } from './ui'

type Props = {
  quote: SolanaQuote
  acknowledged: boolean
  onAcknowledge: () => void
}

const account = (address: string) => `https://solscan.io/account/${address}`

export default function DecodedRouteNotice({ quote, acknowledged, onAcknowledge }: Props) {
  const program = quote.decodedProgramId
  return <View style={st.box} accessibilityRole="summary" accessibilityLabel="Decoded route disclosure">
    <Txt v="label" color={C.text}>Decoded route · replayed from a landed swap</Txt>
    <Txt v="small">
      This pair has no pool liquidityxyz routes directly. Your wallet calls a program the program frontier learned by observing landed transactions, replaying a swap another signer made: the same instruction, sized to your amount, with your own accounts in the signer’s places.
    </Txt>
    <View style={st.links}>
      {program
        ? <Press onPress={() => void Linking.openURL(account(program))} accessibilityRole="link"><Txt v="monoSmall" color={C.accent}>Program {quote.decodedProgramName ?? short(program, 4)} ↗</Txt></Press>
        : <Txt v="monoSmall" color={C.warn}>Program id not reported by the router</Txt>}
      <Press onPress={() => void Linking.openURL(DECODED_PROGRAM_SOURCE)} accessibilityRole="link"><Txt v="monoSmall" color={C.accent}>How programs are learned ↗</Txt></Press>
    </View>
    <Txt v="small" color={C.text}>What the server enforces</Txt>
    <Txt v="small">The replay is simulated before you sign, and it must deliver at least the minimum shown; otherwise nothing is offered to sign. If it fails on chain after signing, the program’s own rules decide the outcome.</Txt>
    <Txt v="small" color={C.text}>What it does not cover</Txt>
    <Txt v="small">The estimate is the landed swap’s ratio at your size. The program is third-party code that can call others, and prices can move between the simulation and the landing, so the fill can come in anywhere between the estimate and the minimum.</Txt>
    <Press onPress={acknowledged ? undefined : onAcknowledge} disabled={acknowledged} accessibilityRole="checkbox" accessibilityState={{ checked: acknowledged }}
      style={({ hovered }) => [st.ack, acknowledged && st.ackDone, hovered && !acknowledged && { opacity: 0.85 }]}>
      <View style={[st.tick, acknowledged && st.tickDone]}>{acknowledged ? <Txt v="monoSmall" color={C.bg}>✓</Txt> : null}</View>
      <Txt v="small" color={C.text} style={{ flex: 1 }}>I understand this swap runs through a program liquidityxyz learned by observation, not one of its recognized venues.</Txt>
    </Press>
  </View>
}

const st = StyleSheet.create({
  box: { gap: 6, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: C.violet + '44', backgroundColor: C.bg },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  ack: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: C.line },
  ackDone: { borderColor: C.violet + '66' },
  tick: { width: 18, height: 18, borderRadius: 5, borderWidth: 1, borderColor: C.muted, alignItems: 'center', justifyContent: 'center' },
  tickDone: { backgroundColor: C.violet, borderColor: C.violet },
})
