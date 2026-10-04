import { config } from './config.ts'
import { startApi } from './api.ts'
import { startRobinhood } from './robinhood/ingest.ts'
import { startSolana } from './solana/lanes.ts'
import { loadFollowedWallets } from './social.ts'
import { startPush } from './push.ts'
import { sweepPending } from './hub.ts'
import { enrich } from './meta.ts'
import { db, getCursor, setCursor } from './db.ts'

loadFollowedWallets()
startApi(config.port)
startPush()
startRobinhood()
startSolana()
setInterval(sweepPending, 5000).unref()

// metadata v2 (DAS, Pons getTokenInfo, launch args): re-resolve everything active in the last day once
if (getCursor('meta:v2') !== 'done') {
  const rows = db.prepare('SELECT chain, address FROM tokens WHERE last_ts > ? AND (pools > 0 OR launched_ts IS NOT NULL) ORDER BY last_ts DESC LIMIT 20000').all(Date.now() - 86400_000) as any[]
  for (const r of rows) enrich(r.chain, r.address, true)
  setCursor('meta:v2', 'done')
  console.log(`[meta] re-resolving ${rows.length} tokens`)
}

process.on('unhandledRejection', (e) => console.error('[unhandled]', e))
