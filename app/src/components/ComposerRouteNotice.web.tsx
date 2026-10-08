// Disclosure for composed routes: the wallet calls the lp-zap composer program,
// which runs every hop in one transaction and takes an in-kind fee per hop.
// Shown before signing; swapping on a composed route needs one acknowledgement
// per browser and composer program.
import { Linking, StyleSheet, View } from 'react-native'
import { C } from '@/theme'
import { short } from '@/lib/format'
import { COMPOSER_SOURCE_URL, composerHopFees, type SolanaQuote } from '@/lib/solana-trade'
import { Press, Txt } from './ui'

type Props = {
  quote: SolanaQuote
  label: (mint: string) => string
  /** Atomic amount → display amount, or null while decimals load. */
  amountOf: (mint: string, atomic: string) => string | null
  acknowledged: boolean
  onAcknowledge: () => void
}

const account = (address: string) => `https://solscan.io/account/${address}`

export default function ComposerRouteNotice({ quote, label, amountOf, acknowledged, onAcknowledge }: Props) {
  const fees = composerHopFees(quote)
  const program = quote.composerProgramId, recipient = quote.composerFeeRecipient
  return <View style={st.box} accessibilityRole="summary" accessibilityLabel="Composed route disclosure">
    <Txt v="label" color={C.text}>Composed route · {quote.hops} hops in one transaction</Txt>
    <Txt v="small">
      This swap does not go straight to one pool. Your wallet calls the lp-zap composer program, which runs each hop in order inside this one transaction. Each later hop spends what the hop before it actually delivered.
    </Txt>
    <View style={st.links}>
      {program
        ? <Press onPress={() => void Linking.openURL(account(program))} accessibilityRole="link"><Txt v="monoSmall" color={C.accent}>Program {short(program, 4)} ↗</Txt></Press>
        : <Txt v="monoSmall" color={C.warn}>Program id not reported by the router</Txt>}
      <Press onPress={() => void Linking.openURL(COMPOSER_SOURCE_URL)} accessibilityRole="link"><Txt v="monoSmall" color={C.accent}>Source ↗</Txt></Press>
    </View>
    <Txt v="small" color={C.text}>Composer fee: {quote.composerFeeBps !== undefined ? `${quote.composerFeeBps / 100}%` : 'not reported'} of each hop&apos;s output, taken in that token</Txt>
    {fees ? fees.map((fee, i) => <Txt key={i} v="monoSmall">Hop {i + 1}: ≈ {amountOf(fee.mint, fee.amount) ?? `${fee.amount} atomic units of`} {label(fee.mint)}</Txt>) : null}
    {recipient
      ? <Press onPress={() => void Linking.openURL(account(recipient))} accessibilityRole="link"><Txt v="monoSmall" color={C.accent}>Paid to {short(recipient, 4)} ↗</Txt></Press>
      : null}
    <Txt v="small">The estimate shown is already net of these fees.</Txt>
    <Txt v="small" color={C.text}>What the program enforces</Txt>
    <Txt v="small">You receive at least the minimum shown, or the whole transaction fails. If it fails, nothing is swapped and only the network fee is spent.</Txt>
    <Txt v="small" color={C.text}>What it does not cover</Txt>
    <Txt v="small">The pool on each hop is a third-party program. Prices can move before the transaction lands, so a fill can come in anywhere between the estimate and the minimum.</Txt>
    <Press onPress={acknowledged ? undefined : onAcknowledge} disabled={acknowledged} accessibilityRole="checkbox" accessibilityState={{ checked: acknowledged }}
      style={({ hovered }) => [st.ack, acknowledged && st.ackDone, hovered && !acknowledged && { opacity: 0.85 }]}>
      <View style={[st.tick, acknowledged && st.tickDone]}>{acknowledged ? <Txt v="monoSmall" color={C.bg}>✓</Txt> : null}</View>
      <Txt v="small" color={C.text} style={{ flex: 1 }}>I understand this swap runs through the composer program and pays its fee on each hop.</Txt>
    </Press>
  </View>
}

const st = StyleSheet.create({
  box: { gap: 6, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: C.accent + '44', backgroundColor: C.accentDim },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  ack: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: C.line },
  ackDone: { borderColor: C.accent + '66' },
  tick: { width: 18, height: 18, borderRadius: 5, borderWidth: 1, borderColor: C.muted, alignItems: 'center', justifyContent: 'center' },
  tickDone: { backgroundColor: C.accent, borderColor: C.accent },
})
