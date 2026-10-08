import { memo, useState } from 'react'
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { router } from 'expo-router'
import { C, F } from '@/theme'
import { post as apiPost } from '@/lib/api'
import { useSocial } from '@/lib/social'
import { ago, short } from '@/lib/format'
import { moveAmounts, moveTag, txUrl } from '@/lib/move-text'
import type { Chain, Move, Post } from '@/lib/types'
import { Button, Chip, Seg, Txt } from './ui'

export const PostItem = memo(function PostItem({ p, now, showToken }: { p: Post; now: number; showToken?: boolean }) {
  const social = useSocial()
  const [liked, setLiked] = useState(!!p.liked)
  const [likes, setLikes] = useState(p.likes)
  const name = p.author.handle ? '@' + p.author.handle : short(p.author.pubkey)
  const following = social.isFollowing('user', 'solana', p.author.pubkey)
  return (
    <View style={ps.item}>
      <View style={ps.head}>
        <Pressable onPress={() => router.push(`/profile/${p.author.pubkey}`)}><Text style={ps.author}>{name}</Text></Pressable>
        {p.kind === 'call' ? <Text style={[ps.tag, { color: C.accent, borderColor: C.accent + '66' }]}>CALL</Text> : null}
        {p.hit === true ? <Text style={[ps.tag, { color: C.good, borderColor: C.good + '66' }]}>HIT · GRADUATED</Text> : null}
        {showToken ? <Pressable onPress={() => router.push(`/token/${p.chain}/${p.token}`)}><Text style={ps.token}>{p.tokenMeta?.symbol ? '$' + p.tokenMeta.symbol : short(p.token)}</Text></Pressable> : null}
        <View style={{ flex: 1 }} />
        <Txt v="monoSmall">{ago(p.ts, now)}</Txt>
      </View>
      <Txt v="body" selectable>{p.body}</Txt>
      {p.move ? <MoveCard move={p.move} tx={p.tx} /> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Pressable hitSlop={8} onPress={async () => {
          const on = !liked
          setLiked(on); setLikes(n => n + (on ? 1 : -1))
          try { const r = await apiPost<Post>(`/api/posts/${p.id}/${on ? 'like' : 'unlike'}`, {}); setLikes(r.likes) } catch { setLiked(!on); setLikes(n => n + (on ? -1 : 1)) }
        }}>
          <Txt v="monoSmall" color={liked ? '#FF5D8F' : C.muted}>{liked ? '♥' : '♡'} {likes}</Txt>
        </Pressable>
        {social.pubkey && social.pubkey !== p.author.pubkey ? (
          <Pressable hitSlop={8} onPress={() => social.toggle('user', 'solana', p.author.pubkey).catch(() => {})}>
            <Txt v="monoSmall" color={following ? C.faint : C.accent}>{following ? 'Following' : '+ Follow person'}</Txt>
          </Pressable>
        ) : null}
      </View>
    </View>
  )
})

// the on-chain move a post carries: what was done, where, how much, and the receipt
function MoveCard({ move, tx }: { move: Move; tx?: string }) {
  const out = move.operation === 'remove'
  const amounts = moveAmounts(move)
  return (
    <View style={ps.move}>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text style={[ps.tag, { alignSelf: 'flex-start', color: out ? C.out : C.accent, borderColor: (out ? C.out : C.accent) + '66' }]}>{moveTag(move)}</Text>
        {amounts ? <Txt v="mono" numberOfLines={1}>{amounts}</Txt> : null}
        {move.pool ? <Txt v="monoSmall" numberOfLines={1}>pool {short(move.pool)}</Txt> : null}
      </View>
      {tx ? <Chip label="View tx ↗" onPress={() => Linking.openURL(txUrl(tx))} /> : null}
    </View>
  )
}

export function Composer({ chain, token, graduated, onPosted }: { chain: Chain; token: string; graduated: boolean; onPosted: (p: Post) => void }) {
  const [body, setBody] = useState('')
  const [kind, setKind] = useState<'call' | 'comment'>(graduated ? 'comment' : 'call')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  return (
    <View style={ps.composer}>
      {!graduated ? <Seg value={kind} onChange={setKind} options={[{ value: 'call', label: 'Call it (scored at graduation)' }, { value: 'comment', label: 'Comment' }]} /> : null}
      <TextInput
        value={body}
        onChangeText={setBody}
        placeholder={kind === 'call' ? 'Why this one graduates…' : 'Say something about this liquidity…'}
        placeholderTextColor={C.faint}
        multiline
        maxLength={500}
        style={ps.input}
      />
      {err ? <Txt v="small" color={C.bad}>{err}</Txt> : null}
      <Button label={kind === 'call' ? 'Post call' : 'Post'} busy={busy} disabled={!body.trim()} onPress={async () => {
        setBusy(true); setErr(null)
        try { const p = await apiPost<Post>('/api/posts', { chain, token, kind, body }); setBody(''); onPosted(p) } catch (e: any) { setErr(e.message) }
        setBusy(false)
      }} />
    </View>
  )
}

const ps = StyleSheet.create({
  item: { paddingHorizontal: 16, paddingVertical: 12, gap: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  author: { fontFamily: F.display, fontSize: 14, color: C.text },
  token: { fontFamily: F.monoBold, fontSize: 12, color: C.accent },
  tag: { fontFamily: F.monoBold, fontSize: 9, letterSpacing: 0.6, borderWidth: 1, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  move: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: C.line, backgroundColor: C.surface },
  composer: { marginHorizontal: 16, padding: 12, gap: 10, backgroundColor: C.surface, borderRadius: 14, borderWidth: 1, borderColor: C.line },
  input: { minHeight: 64, color: C.text, fontFamily: F.body, fontSize: 15, textAlignVertical: 'top', padding: 0 },
})
