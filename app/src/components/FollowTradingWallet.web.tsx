// Your moves in your own feed: following the wallet that signs your trades
// puts its adds and pulls in Following, like any other followed wallet.
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { C } from '@/theme'
import { short } from '@/lib/format'
import { useSocial } from '@/lib/social'
import { Button, Txt } from './ui'

export function FollowTradingWallet({ address }: { address: string }) {
  const social = useSocial()
  const [busy, setBusy] = useState(false)
  const following = social.isFollowing('wallet', 'solana', address)
  return (
    <View style={s.card}>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Txt v="body">{following ? 'Following your trading wallet ' : 'Follow your trading wallet '}<Txt v="mono">{short(address)}</Txt></Txt>
        <Txt v="small">{following ? 'Your adds and pulls show in Following.' : 'so your adds and pulls show in Following.'}</Txt>
      </View>
      <Button label={following ? 'Unfollow' : 'Follow'} kind={following ? 'ghost' : 'primary'} busy={busy} onPress={async () => {
        setBusy(true)
        try { await social.toggle('wallet', 'solana', address) } catch {}
        setBusy(false)
      }} />
    </View>
  )
}

const s = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: C.line, backgroundColor: C.surface },
})
