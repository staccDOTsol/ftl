import { config } from './config.ts'
import { startApi } from './api.ts'
import { startRobinhood } from './robinhood/ingest.ts'
import { startSolana } from './solana/lanes.ts'
import { loadFollowedWallets } from './social.ts'
import { startPush } from './push.ts'
import { sweepPending } from './hub.ts'

loadFollowedWallets()
startApi(config.port)
startPush()
startRobinhood()
startSolana()
setInterval(sweepPending, 5000).unref()

process.on('unhandledRejection', (e) => console.error('[unhandled]', e))
