// After a swap or liquidity move signs, offer to post it: a prefilled one-line
// body, the signature and a Move summary ride along so the post shows a move card.
import { useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import { C, F } from '@/theme'
import { post as apiPost } from '@/lib/api'
import { short } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import { moveTag, moveText } from '@/lib/move-text'
import type { Chain, Move, Post } from '@/lib/types'
import { PostItem } from './Posts'
import { Button, Seg, Txt } from './ui'

export interface ShareMoveProps {
  chain: Chain
  token: string
  move: Move
  tx: string
  graduated?: boolean          // false lets the author file it as a call (scored at graduation), as Composer does
  symbol?: string              // "$SYM" in the prefilled text; falls back to the move's amount symbol or a short address
  side?: 'buy' | 'sell'        // swaps only: "Bought" (default) or "Sold"
  onPosted?: (p: Post) => void
}

export function ShareMove({ chain, token, move, tx, graduated = true, symbol, side, onPosted }: ShareMoveProps) {
  const now = useNow(5000)
  const sym = symbol ?? move.amounts?.find(a => a.mint === token)?.symbol
  const [body, setBody] = useState(() => moveText(move, sym ? '$' + sym : short(token), side))
  const [kind, setKind] = useState<'call' | 'comment'>(graduated ? 'comment' : 'call')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [posted, setPosted] = useState<Post | null>(null)

  if (posted) {
    return (
      <View style={s.card}>
        <Txt v="label">Shared to the token’s feed</Txt>
        <PostItem p={posted} now={now} />
      </View>
    )
  }
  return (
    <View style={s.card}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Txt v="label">Share this move</Txt>
        <Txt v="monoSmall">{moveTag(move)}</Txt>
      </View>
      {!graduated ? <Seg value={kind} onChange={setKind} options={[{ value: 'call', label: 'Call it (scored at graduation)' }, { value: 'comment', label: 'Comment' }]} /> : null}
      <TextInput
        value={body}
        onChangeText={setBody}
        placeholder="Say something about this move…"
        placeholderTextColor={C.faint}
        maxLength={500}
        style={s.input}
        onSubmitEditing={() => void submit()}
      />
      {err ? <Txt v="small" color={C.bad}>{err}</Txt> : null}
      <Button label={kind === 'call' ? 'Post call' : 'Post'} busy={busy} disabled={!body.trim()} onPress={() => void submit()} />
    </View>
  )

  async function submit() {
    if (busy || !body.trim()) return
    setBusy(true); setErr(null)
    try {
      const p = await apiPost<Post>('/api/posts', { chain, token, kind, body, tx, move })
      setPosted(p)
      onPosted?.(p)
    } catch (e: any) { setErr(e.message) }
    setBusy(false)
  }
}

const s = StyleSheet.create({
  card: { padding: 12, gap: 10, backgroundColor: C.surface, borderRadius: 14, borderWidth: 1, borderColor: C.line },
  input: { minHeight: 40, color: C.text, fontFamily: F.body, fontSize: 15, padding: 0 },
})
