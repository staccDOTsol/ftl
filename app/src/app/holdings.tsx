// What can I do with what I'm holding: paste or connect a Solana wallet and get
// executable next actions ranked from its actual account state.
import { useCallback, useEffect, useState } from 'react'
import { Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { C, F } from '@/theme'
import { short, venue } from '@/lib/format'
import { fromAtomic } from '@/lib/solana-trade'
import { ACTION_LABEL, actionMint, getHoldings, holdingLabel, isActionHref, isSolanaAddress, liquidityActionHref, shortAddress, SOL_MINT, type HoldingAction, type Holdings } from '@/lib/solana-holdings'
import { liquidityLink, swapLink } from '@/lib/swap-link'
import { retitle, useTokenMeta, type TokenMetaMap } from '@/lib/token-meta'
import HoldingsWallet from '@/components/HoldingsWallet'
import { Button, Empty, Loading, Press, Screen, Section, Stat, TokenAvatar, Txt } from '@/components/ui'

const ACTION_COLOR: Record<HoldingAction['kind'], string> = { exit: C.out, unwrap: C.gold, sell: C.warn, add: C.accent, buy: C.violet }

export default function HoldingsScreen() {
  const params = useLocalSearchParams<{ owner?: string }>()
  const initial = typeof params.owner === 'string' && isSolanaAddress(params.owner) ? params.owner.trim() : null
  const [input, setInput] = useState(initial ?? '')
  const [owner, setOwner] = useState<string | null>(initial)
  const [result, setResult] = useState<{ owner: string; data: Holdings } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<{ owner: string | null; message: string } | null>(null)
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null)

  const load = useCallback(async (address: string) => {
    setLoading(true); setError(null)
    try {
      const data = await getHoldings(address)
      setResult({ owner: address, data }); setRefreshedAt(Date.now())
    } catch (e) {
      setError({ owner: address, message: e instanceof Error ? e.message : 'Holdings could not be loaded.' })
    } finally { setLoading(false) }
  }, [])
  // A deep link with ?owner= reads once on mount; every later read is user-driven.
  useEffect(() => {
    if (!initial) return
    const timer = setTimeout(() => void load(initial), 0)
    return () => clearTimeout(timer)
  }, [initial, load])

  const choose = useCallback((address: string) => {
    const text = address.trim()
    if (!isSolanaAddress(text)) { setError({ owner: null, message: 'Enter a valid Solana wallet address.' }); return }
    setInput(text); setError(null); setOwner(text)
    void load(text)
  }, [load])

  const data = result?.owner === owner ? result.data : null
  const known = data ? data.tokens.filter(t => t.pools.length).length : 0
  // Names for every mint on screen that FTL has not named itself: held tokens,
  // position pairs and the mints the ranked actions point at.
  const meta = useTokenMeta(data ? [
    ...data.tokens.filter(t => !t.token?.symbol && !t.wrappedSol).map(t => t.mint),
    ...data.positions.positions.flatMap(p => [p.mintA, p.mintB]),
    ...data.actions.map(a => actionMint(a.href)),
  ] : [])
  // The token page exists for mints FTL has a row for; anything else goes to
  // the swap terminal (Liquidity mode for add / exit, Swap otherwise).
  const seen = useCallback((mint: string) => mint === SOL_MINT || !!data?.tokens.find(t => t.mint === mint)?.token || meta[mint]?.source === 'ftl', [data, meta])

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
        <View style={{ padding: 16, gap: 10 }}>
          <Txt v="title">What can I do with what I’m holding?</Txt>
          <Txt v="small">FTL reads a wallet’s SOL, every token account and its liquidity positions, then lists the concrete moves it can make here: exit a position, sell or add liquidity on tokens FTL knows pools for, unwrap stray SOL, or put idle SOL into what is hot.</Txt>
          <View style={st.inputRow}>
            <TextInput accessibilityLabel="Solana wallet address" value={input} onChangeText={setInput} onSubmitEditing={() => choose(input)} placeholder="Paste a Solana wallet address" placeholderTextColor={C.faint} autoCapitalize="none" autoCorrect={false} editable={!loading} style={st.input} />
          </View>
          <View style={st.wrap}>
            <Button label={owner && input.trim() === owner ? 'Refresh' : 'Show me'} busy={loading} disabled={!input.trim()} onPress={() => choose(input)} style={{ flex: 1 }} />
            {owner ? <Button label="Clear" kind="quiet" disabled={loading} onPress={() => { setOwner(null); setInput(''); setResult(null); setError(null) }} /> : null}
          </View>
          {error && error.owner === null ? <Txt v="small" color={C.warn}>{error.message}</Txt> : null}
        </View>

        <Section title={Platform.OS === 'web' ? 'Use my trading wallet' : 'Trading wallet'}>
          <View style={{ paddingHorizontal: 16 }}><HoldingsWallet onAddress={choose} /></View>
        </Section>

        {!owner ? <Empty title="No wallet yet" body="Paste an address or connect a wallet. FTL never needs a signature to read holdings." /> : null}
        {owner && loading && !data ? <Loading /> : null}
        {owner && error && error.owner === owner && !data ? (
          <Empty title="Holdings unavailable" body={error.message}><Button label="Try again" kind="ghost" onPress={() => void load(owner)} /></Empty>
        ) : null}

        {owner && data ? <>
          <View style={{ paddingHorizontal: 16, paddingTop: 16, gap: 10 }}>
            <Txt v="monoSmall" selectable>{owner}</Txt>
            <View style={st.wrap}>
              <Stat label="SOL" value={fromAtomic(data.sol.lamports, 9)} color={C.accent} />
              <Stat label="tokens" value={data.tokens.length} />
              <Stat label="positions" value={data.positions.positions.length} />
              <Stat label="actions" value={data.actions.length} color={C.accent} />
            </View>
            {error && error.owner === owner ? <Txt v="small" color={C.warn}>Refresh failed: {error.message}</Txt> : null}
            {refreshedAt ? <Txt v="monoSmall">{loading ? 'Refreshing…' : `Read at ${new Date(refreshedAt).toLocaleTimeString()} · confirmed commitment`}</Txt> : null}
          </View>

          <Section title={`What you can do · ${data.actions.length}`}>
            {data.actions.length ? data.actions.map((a, i) => <ActionRow key={`${a.kind}:${a.href}:${i}`} action={a} meta={meta} seen={seen} positions={data.positions.positions} />) : (
              <View style={{ paddingHorizontal: 16, gap: 6 }}>
                <Txt v="small">Nothing executable yet. {data.tokens.length ? 'FTL has not seen pools for the tokens this wallet holds, and there are no open positions.' : 'This wallet holds no tokens and no positions.'} {BigInt(data.sol.lamports) <= 20_000_000n ? 'Fund it with more than 0.02 SOL to see buy suggestions.' : ''}</Txt>
              </View>
            )}
          </Section>

          <Section title={`Tokens · ${data.tokens.length}`} right={known ? <Txt v="monoSmall">{known} with FTL pools</Txt> : undefined}>
            {data.tokens.length ? data.tokens.map(t => {
              const record = meta[t.mint]
              const label = t.wrappedSol || t.token?.symbol || !record?.symbol ? holdingLabel(t) : `$${record.symbol.slice(0, 14)}`
              const name = t.wrappedSol ? null : t.token?.name ?? record?.name ?? null
              // Known tokens open their page; anything else opens the swap terminal on that mint.
              const open = t.wrappedSol || t.pools.length || seen(t.mint) ? () => router.push(`/token/solana/${t.mint}` as any) : () => router.push(swapLink(SOL_MINT, t.mint) as any)
              return (
                <Press key={t.account} onPress={open} accessibilityRole="button" style={({ hovered, pressed }) => [st.row, hovered && { backgroundColor: C.hover }, pressed && { opacity: 0.7 }]}>
                  <TokenAvatar image={t.token?.image ?? record?.image ?? undefined} label={label} size={36} chain="solana" />
                  <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
                    <Txt v="body" numberOfLines={1}>{label}{name ? <Txt v="small">  {name}</Txt> : null}</Txt>
                    <Txt v="monoSmall" numberOfLines={1}>{shortAddress(t.mint)}{t.program === 'token-2022' ? ' · Token-2022' : ''} · {t.pools.length ? `${t.pools.length} FTL pool${t.pools.length === 1 ? '' : 's'}${t.pools.some(p => p.funded) ? ` · ${t.pools.filter(p => p.funded).length} funded` : ''}` : t.wrappedSol ? 'wrapped SOL account' : 'no FTL-known pools'}</Txt>
                  </View>
                  <Txt v="num" style={{ fontSize: 14 }}>{fromAtomic(t.amount, t.decimals)}</Txt>
                </Press>
              )
            }) : <Txt v="small" style={{ paddingHorizontal: 16 }}>No token accounts with a balance.</Txt>}
          </Section>

          <Section title={`Liquidity positions · ${data.positions.positions.length}`}>
            {data.positions.error ? <Txt v="small" color={C.warn} style={{ paddingHorizontal: 16, paddingBottom: 6 }}>{data.positions.error}</Txt> : null}
            {data.positions.errors.map(e => <Txt key={e.venue} v="small" color={C.warn} style={{ paddingHorizontal: 16, paddingBottom: 4 }}>{venue(e.venue)}: {e.error}</Txt>)}
            {data.positions.positions.length ? data.positions.positions.map(p => {
              const mint = p.mintA !== SOL_MINT ? p.mintA : p.mintB
              const href = seen(mint) ? `/token/solana/${mint}?action=exit` : liquidityLink(mint, p.pool, 'exit')
              const pairName = (m: string) => meta[m]?.symbol ? `$${meta[m].symbol!.slice(0, 14)}` : shortAddress(m)
              return (
                <Press key={`${p.venue}:${p.position}`} onPress={() => router.push(href as any)} accessibilityRole="button" style={({ hovered, pressed }) => [st.row, hovered && { backgroundColor: C.hover }, pressed && { opacity: 0.7 }]}>
                  <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
                    <Txt v="body" numberOfLines={1}>{venue(p.venue)} · {pairName(p.mintA)} / {pairName(p.mintB)}</Txt>
                    <Txt v="monoSmall" numberOfLines={1}>pool {short(p.pool, 5)} · position {short(p.position, 5)}</Txt>
                  </View>
                  <Txt v="monoSmall" color={C.text}>{p.removalMode === 'percentage' ? 'Bin position' : `${p.liquidity ?? '—'} liquidity units`}</Txt>
                </Press>
              )
            }) : !data.positions.error ? <Txt v="small" style={{ paddingHorizontal: 16 }}>No open positions returned{data.positions.errors.length ? ' for the venues that answered' : ''}.</Txt> : null}
          </Section>
          <Txt v="small" color={C.faint} style={{ padding: 16 }}>Suggestions come from balances and FTL’s pool records, not from price. Nothing here is financial advice.</Txt>
        </> : null}
      </ScrollView>
    </Screen>
  )
}

function ActionRow({ action, meta, seen, positions }: { action: HoldingAction; meta: TokenMetaMap; seen: (mint: string) => boolean; positions: Holdings['positions']['positions'] }) {
  const href = liquidityActionHref(action, seen, positions)
  const ok = isActionHref(href)
  const mint = actionMint(action.href)
  // "Sell A9EC…KnH4" reads "Sell $SYMBOL" once the metadata endpoint names it.
  const title = mint ? retitle(action.title, mint, meta) : action.title
  const color = ACTION_COLOR[action.kind] ?? C.accent
  return (
    <Press onPress={ok ? () => router.push(href as any) : undefined} disabled={!ok} accessibilityRole="button" style={({ hovered, pressed }) => [st.row, hovered && { backgroundColor: C.hover }, pressed && { opacity: 0.7 }]}>
      <View style={[st.kind, { borderColor: color + '66', backgroundColor: color + '1A' }]}><Txt v="label" color={color}>{ACTION_LABEL[action.kind] ?? action.kind}</Txt></View>
      <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
        <Txt v="body" numberOfLines={2}>{title}{href !== action.href ? <Txt v="small" color={C.accent}>  Liquidity ⇄</Txt> : null}</Txt>
        <Txt v="small" numberOfLines={3}>{action.detail}</Txt>
      </View>
      <Txt v="mono" color={C.faint}>→</Txt>
    </Press>
  )
}

const st = StyleSheet.create({
  inputRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: C.lineStrong, borderRadius: 10, paddingHorizontal: 12, backgroundColor: C.surface },
  input: { flex: 1, minWidth: 0, height: 44, color: C.text, fontFamily: F.mono, fontSize: 13 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line },
  kind: { minWidth: 64, paddingHorizontal: 8, height: 26, borderRadius: 7, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
})
