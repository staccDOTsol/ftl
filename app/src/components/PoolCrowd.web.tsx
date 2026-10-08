// Who's in this pool: wallets that added or pulled liquidity here, with how
// many app users follow each one, and a follow toggle on every row.
import { useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { router } from 'expo-router'
import { C } from '@/theme'
import { get } from '@/lib/api'
import { useClock } from '@/lib/clock'
import { ago, short } from '@/lib/format'
import { useSocial } from '@/lib/social'
import type { Chain } from '@/lib/types'
import { Chip, Press, Txt } from './ui'

export interface PoolWallet { address: string; adds: number; pulls: number; lastTs: number; followers: number; followed: boolean }

export function PoolCrowd({ pool, chain }: { pool: string; chain: Chain }) {
  const social = useSocial()
  const now = useClock()
  const [rows, setRows] = useState<PoolWallet[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setRows(null); setErr(null)
    get<PoolWallet[]>(`/api/pool/${chain}/${pool}/wallets`, { viewer: social.pubkey })
      .then(r => { if (alive) setRows(r) })
      .catch(e => { if (alive) setErr(e.message) })
    return () => { alive = false }
  }, [chain, pool])   // eslint-disable-line react-hooks/exhaustive-deps -- one read per pool; follows update locally

  if (err) return <Txt v="small" color={C.bad} style={s.note}>{err}</Txt>
  if (!rows) return <Txt v="small" style={s.note}>Loading the crowd…</Txt>
  if (!rows.length) return <Txt v="small" style={s.note}>No liquidity moves seen in this pool yet.</Txt>
  return (
    <View>
      {rows.map(w => {
        const following = social.isFollowing('wallet', chain, w.address)
        // the server count is a snapshot; keep it honest as the viewer toggles
        const followers = w.followers + (following ? 1 : 0) - (w.followed ? 1 : 0)
        const line = [`${w.adds} add${w.adds === 1 ? '' : 's'}`, `${w.pulls} pull${w.pulls === 1 ? '' : 's'}`, `${ago(w.lastTs, now)} ago`, followers ? `${followers} following` : null]
        return (
          <Press key={w.address} onPress={() => router.push(`/wallet/${chain}/${w.address}`)} accessibilityRole="link"
            style={({ hovered, pressed }) => [s.row, hovered && { backgroundColor: C.hover }, pressed && { opacity: 0.8 }]}>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Txt v="mono" numberOfLines={1}>{short(w.address, 6)}</Txt>
              <Txt v="monoSmall" numberOfLines={1}>{line.filter(Boolean).join(' · ')}</Txt>
            </View>
            {social.pubkey && social.pubkey !== w.address ? (
              <Chip label={following ? 'Following' : 'Follow'} active={following} onPress={() => social.toggle('wallet', chain, w.address).catch(() => {})} />
            ) : null}
          </Press>
        )
      })}
    </View>
  )
}

const s = StyleSheet.create({
  note: { paddingHorizontal: 16, paddingVertical: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
})
