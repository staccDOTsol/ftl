import { config } from './config.ts'
import { startApi } from './api.ts'
import { startRobinhood } from './robinhood/ingest.ts'
import { startSolana } from './solana/lanes.ts'
import { loadFollowedWallets } from './social.ts'
import { startPush } from './push.ts'
import { ingest, lane, sweepPending } from './hub.ts'
import { enrich } from './meta.ts'
import { db, getCursor, setCursor } from './db.ts'

loadFollowedWallets()
startApi(config.port)
startPush()
startRobinhood()
startSolana(ingest, (l, enabled, reason, stats) => { const s = lane('solana', l, enabled, reason); if (stats) Object.assign(s, stats) })
setInterval(sweepPending, 5000).unref()

// metadata v3: anything active in the last day still missing a symbol or image is asked again,
// now with retries until it resolves
if (getCursor('meta:v3') !== 'done') {
  const rows = db.prepare('SELECT chain, address FROM tokens WHERE last_ts > ? AND (symbol IS NULL OR image IS NULL) ORDER BY last_ts DESC LIMIT 20000').all(Date.now() - 86400_000) as any[]
  for (const r of rows) enrich(r.chain, r.address, true)
  setCursor('meta:v3', 'done')
  console.log(`[meta] re-resolving ${rows.length} tokens`)
}

process.on('unhandledRejection', (e) => console.error('[unhandled]', e))
