// One Solana lane per worker thread: gRPC, protobuf and instruction decoding stay
// off the main thread, which only sees the handful of events that matched.
import { parentPort, workerData } from 'node:worker_threads'
import { config } from '../config.ts'
import { deshredLane, geyserLane, preconfsLanes, setSink, type LaneStats } from './lanes.ts'
import type { RawEvent } from '../hub.ts'
import type { Lane } from '../../../shared/types.ts'

const kind = workerData.kind as Lane
const stats: LaneStats = { connected: false, msgs: 0, lastMsgTs: null }
let buf: RawEvent[] = []
setSink({ emit: (evs) => { buf.push(...evs) }, stats: () => stats })
setInterval(() => { if (buf.length) { parentPort!.postMessage({ t: 'ev', evs: buf }); buf = [] } }, 20)
setInterval(() => parentPort!.postMessage({ t: 'stats', stats }), 1000)

if (kind === 'geyser') geyserLane('geyser', config.tritonGrpcUrl!, config.tritonXToken!)
else if (kind === 'geyser-drpc') geyserLane('geyser-drpc', config.drpcGeyserUrl!, config.drpcKey!)
else if (kind === 'deshred') deshredLane(config.tritonGrpcUrl!, config.tritonXToken!)
else if (kind === 'preconf') preconfsLanes()
