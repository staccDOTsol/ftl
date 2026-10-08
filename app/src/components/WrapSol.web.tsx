// Wrap / unwrap SOL with the same discipline as swaps and liquidity:
// build → verify → simulate (fee) → wallet sign → send → confirm.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Linking, StyleSheet, TextInput, View } from 'react-native'
import bs58 from 'bs58'
import { C, F } from '@/theme'
import { assertSignedMessage, decodeTransaction, sendSignedSwap, tokenBalance, transactionStatus, type Confirmation } from '@/lib/solana'
import { inspectTransaction } from '@/lib/solana-wire'
import { balancePercent, fromAtomic, SOL_MINT, toAtomic } from '@/lib/solana-trade'
import { buildWrap, simulateWrap, type WrapDirection, type WrapIntent } from '@/lib/solana-wrap'
import type { SolanaSigner } from './SolanaTrade.web'
import { Button, Chip, Seg, Txt } from './ui'

export interface WrapSolProps { signer: SolanaSigner; defaultDirection?: WrapDirection; onDone?: (result: { signature: string; direction: WrapDirection; lamports: string }) => void }
interface Outcome { signature: string; state: Confirmation; direction: WrapDirection; lamports: string }
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Wrap request failed. Try again.'
const sol = (lamports: string) => `${fromAtomic(lamports, 9)} SOL`

export function WrapSol({ signer, defaultDirection = 'wrap', onDone }: WrapSolProps) {
  const owner = signer.address, version = signer.transactionVersion
  const [direction, setDirection] = useState<WrapDirection>(defaultDirection)
  const [amount, setAmount] = useState('')
  const [balances, setBalances] = useState<{ owner: string; native: string; wrapped: string } | null>(null)
  const [phase, setPhase] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const refresh = useCallback(async () => {
    if (!owner) { setBalances(null); return }
    const [native, wrapped] = await Promise.all([tokenBalance(owner, SOL_MINT, true), tokenBalance(owner, SOL_MINT, false)])
    if (mounted.current) setBalances({ owner, native, wrapped })
  }, [owner])
  useEffect(() => { const timer = setTimeout(() => { void refresh().catch(e => { if (mounted.current) setError(errorMessage(e)) }) }, 0); return () => clearTimeout(timer) }, [refresh])
  const current = balances?.owner === owner ? balances : null
  const lamports = direction === 'wrap' ? (() => { try { return toAtomic(amount, 9) } catch { return null } })() : current?.wrapped ?? null
  const canRun = !!owner && !!version && !busy && lamports !== null && BigInt(lamports) > 0n

  async function execute() {
    if (!owner || !version || lamports === null) throw new Error('Connect a Solana wallet first.')
    const intent: WrapIntent = { owner, direction, transactionVersion: version, ...(direction === 'wrap' ? { lamports } : {}) }
    setPhase(direction === 'wrap' ? 'Building wrap…' : 'Building unwrap…')
    const build = await buildWrap(intent)
    setPhase('Simulating…')
    const fee = await simulateWrap(build, intent)
    if (!mounted.current || signer.address !== owner) throw new Error('Wallet changed. Nothing was sent.')
    setPhase(`Approve in your wallet · ${direction === 'wrap' ? 'wrap' : 'unwrap'} ${sol(build.summary.lamports)} · network fee ${sol(String(fee))}${build.summary.createsTokenAccount ? ' · creates your wrapped SOL account' : ''}`)
    const signed = await signer.sign(decodeTransaction(build.transaction))
    assertSignedMessage(build.transaction, signed)
    if (!mounted.current || signer.address !== owner) throw new Error('Wallet changed. Nothing was sent.')
    const signatureBytes = inspectTransaction(signed).signatures[0]
    if (!signatureBytes?.some(byte => byte !== 0)) throw new Error('Wallet did not sign this transaction.')
    const signature = bs58.encode(signatureBytes)
    setPhase('Sending…')
    const sent = await sendSignedSwap(signed, build.lastValidBlockHeight)
    if (sent !== signature) throw new Error('Unexpected transaction signature.')
    let result: Outcome = { signature, state: 'pending', direction, lamports: build.summary.lamports }
    setOutcome(result)
    for (let i = 0; i < 30 && mounted.current; i++) {
      setPhase(`Confirming ${signature.slice(0, 8)}… (${i + 1})`)
      const state = await transactionStatus(signature, build.lastValidBlockHeight)
      if (state !== 'pending') { result = { ...result, state }; break }
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    if (!mounted.current) return
    setOutcome(result)
    if (result.state === 'confirmed') { setAmount(''); onDone?.(result); await refresh() }
    else if (result.state === 'pending') throw new Error('Still awaiting confirmation. Check Solscan before trying again.')
    else throw new Error(`Transaction ${result.state}. Nothing changed; refresh and try again.`)
  }
  function act() { setBusy(true); setError(''); setOutcome(null); void execute().catch(e => { if (mounted.current) setError(errorMessage(e)) }).finally(() => { if (mounted.current) { setBusy(false); setPhase('') } }) }

  return <View style={st.stack}>
    <Seg value={direction} options={[{ value: 'wrap', label: 'Wrap' }, { value: 'unwrap', label: 'Unwrap' }]} onChange={value => { if (!busy) { setDirection(value); setError(''); setOutcome(null) } }} />
    <View style={st.between}>
      <View><Txt v="label">Native SOL</Txt><Txt v="mono">{current ? sol(current.native) : '—'}</Txt></View>
      <View><Txt v="label">Wrapped SOL</Txt><Txt v="mono">{current ? sol(current.wrapped) : '—'}</Txt></View>
      <Button kind="quiet" label="Refresh" disabled={busy || !owner} onPress={() => void refresh().catch(e => setError(errorMessage(e)))} />
    </View>
    {direction === 'wrap' ? <View style={st.section}>
      <Txt v="label">SOL to wrap</Txt>
      <TextInput accessibilityLabel="SOL to wrap" value={amount} onChangeText={setAmount} editable={!busy} keyboardType="decimal-pad" placeholder="0.0" placeholderTextColor={C.faint} style={st.amount} />
      <View style={st.row}>{[10, 25, 50, 100].map(percent => <Chip key={percent} label={`${percent}%`} onPress={() => { if (!busy && current) setAmount(fromAtomic(balancePercent(current.native, percent, true), 9)) }} />)}</View>
      <Txt v="small">Keeps 0.01 SOL for fees and rent. Wrapped SOL is an SPL token account you can trade or add to pools.</Txt>
    </View> : <View style={st.section}>
      <Txt v="label">Unwrap all</Txt>
      <Txt v="h1">{current ? sol(current.wrapped) : '—'}</Txt>
      <Txt v="small">Closes your wrapped SOL account and returns every lamport, including rent, to your wallet.</Txt>
    </View>}
    {!owner ? <Button label="Connect wallet" disabled={busy} onPress={() => void signer.connect().catch(e => setError(errorMessage(e)))} /> : null}
    <Button label={busy ? 'Working…' : direction === 'wrap' ? 'Wrap SOL' : 'Unwrap SOL'} disabled={!canRun} busy={busy} onPress={act} />
    {phase ? <Txt v="small" color={C.muted}>{phase}</Txt> : null}
    {error ? <Txt v="small" color={C.bad}>{error}</Txt> : null}
    {outcome ? <View style={[st.section, { borderColor: outcome.state === 'confirmed' ? C.accent + '66' : outcome.state === 'pending' ? C.gold + '66' : C.bad + '66' }]}>
      <Txt v="h2" color={outcome.state === 'confirmed' ? C.accent : outcome.state === 'pending' ? C.gold : C.bad}>{outcome.state === 'confirmed' ? (outcome.direction === 'wrap' ? 'Wrapped' : 'Unwrapped') : outcome.state === 'pending' ? 'Pending' : outcome.state === 'expired' ? 'Expired' : 'Failed'} · {sol(outcome.lamports)}</Txt>
      <Txt v="monoSmall" selectable>{outcome.signature}</Txt>
      <Button kind="quiet" label="View on Solscan ↗" onPress={() => void Linking.openURL(`https://solscan.io/tx/${outcome.signature}`)} />
    </View> : null}
  </View>
}

const st = StyleSheet.create({
  stack: { gap: 10 }, row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  section: { gap: 10, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.surface },
  amount: { minWidth: 0, height: 52, color: C.text, fontFamily: F.monoBold, fontSize: 26 },
})
