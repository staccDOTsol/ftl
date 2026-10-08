// Who's in this pool: the wallets that added or pulled liquidity, with how many
// app users follow each one. Reads the events table the same way tokenPage
// builds its LP wallets, grouped by pool instead of token.

import { db } from './db.ts'
import { HttpError, followersOf } from './social.ts'
import type { Chain } from '../../shared/types.ts'

export interface PoolWallet { address: string; adds: number; pulls: number; lastTs: number; followers: number; followed: boolean }

const B58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/

export function poolWallets(chain: Chain, pool: string, viewer: string | null, limit = 30): PoolWallet[] {
  if (chain === 'robinhood' ? !EVM_ADDRESS.test(pool) : !B58_ADDRESS.test(pool)) throw new HttpError(400, 'bad pool address')
  // A funded pool_init is the creator's first add; ladder inits (no liquidity) are flagged but still count as presence.
  const rows = db.prepare(`SELECT wallet AS address,
      SUM(CASE WHEN kind IN ('liq_add', 'pool_init') THEN 1 ELSE 0 END) AS adds,
      SUM(CASE WHEN kind = 'liq_remove' THEN 1 ELSE 0 END) AS pulls,
      MAX(ts) AS lastTs
    FROM events WHERE chain = ? AND pool = ? AND kind IN ('pool_init', 'liq_add', 'liq_remove')
    GROUP BY wallet ORDER BY adds DESC, lastTs DESC LIMIT ?`).all(chain, pool, Math.max(1, Math.min(limit, 100))) as { address: string; adds: number; pulls: number; lastTs: number }[]
  return rows.map(r => {
    const followers = followersOf('wallet', chain, r.address)
    return { address: r.address, adds: r.adds, pulls: r.pulls, lastTs: r.lastTs, followers: followers.length, followed: !!viewer && followers.includes(viewer) }
  })
}
