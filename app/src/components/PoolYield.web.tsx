// Compact yield row for one liquidity pool, read from the venue's own pool-stats
// API through /api/pool-stats/solana. Fetches on mount, refreshes every 60s.
import { useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { C } from '@/theme'
import { usd } from '@/lib/format'
import { aprLabel, estimateShare, poolStats, type PoolStats } from '@/lib/solana-liquidity'
import { Chip, Txt } from './ui'

export { aprLabel, estimateShare }
const REFRESH_MS = 60_000
const sourceName = (stats: PoolStats) => stats.venue.split('-')[0]
const money = (x: number | null) => (x === null ? '—' : usd(x).replace('K', 'k'))

export function PoolYield({ venue, pool, depositUsd }: { venue: string; pool: string; depositUsd?: number }) {
  const [stats, setStats] = useState<PoolStats | null | undefined>(undefined)
  useEffect(() => {
    let alive = true
    const load = () => poolStats([{ venue, pool }])
      .then(r => { if (alive) setStats(r.results[0]?.stats ?? null) })
      .catch(() => { if (alive) setStats(s => s ?? null) })
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [venue, pool])

  if (stats === undefined) return <Txt v="monoSmall">loading yield…</Txt>
  const label = aprLabel(stats)
  if (!stats || !label) return <Txt v="monoSmall" color={C.ghost}>no data</Txt>
  const apr = stats.totalApr ?? stats.feeApr ?? 0
  const yearly = depositUsd !== undefined ? estimateShare(stats, depositUsd) : null
  return (
    <View style={s.wrap}>
      <View style={s.row}>
        <Txt v="num" color={apr > 0 ? C.accent : C.muted}>{label}</Txt>
        <Txt v="monoSmall">fees {money(stats.fees24hUsd)}/24h · TVL {money(stats.tvlUsd)} · vol {money(stats.volume24hUsd)}</Txt>
        <Chip label={`via ${sourceName(stats)}`} color={C.faint} />
      </View>
      {yearly !== null ? <Txt v="monoSmall" color={C.muted}>≈ {money(yearly)}/yr at today's volume</Txt> : null}
    </View>
  )
}

const s = StyleSheet.create({
  wrap: { gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
})
