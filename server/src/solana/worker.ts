// One Solana lane per worker thread: gRPC, protobuf and instruction decoding stay
// off the main thread, which only sees the handful of events that matched.
import { parentPort, workerData } from 'node:worker_threads'
import { config } from '../config.ts'
import { deshredLane, geyserLane, preconfsLanes, setGeyserPrimaryPrograms, setSink, type LaneStats } from './lanes.ts'
import type { SwapObservation } from './swaps.ts'
import type { RawEvent } from '../hub.ts'
import type { Lane } from '../../../shared/types.ts'

const kind = workerData.kind as Lane
const stats: LaneStats = { connected: false, msgs: 0, lastMsgTs: null, configuredStreams: 0, activeStreams: 0 }
let buf: RawEvent[] = []
let swaps: SwapObservation[] = []
setSink({ emit: (evs) => { buf.push(...evs) }, swaps: (items) => { swaps.push(...items) },
  stream: (event) => parentPort!.postMessage({ t: 'swap-stream', event }), stats: () => stats })
setInterval(() => { if (buf.length) { parentPort!.postMessage({ t: 'ev', evs: buf }); buf = [] } }, 20)
setInterval(() => { if (swaps.length) { parentPort!.postMessage({ t: 'swap', swaps }); swaps = [] } }, 20)
setInterval(() => parentPort!.postMessage({ t: 'stats', stats }), 1000)
parentPort!.on('message', (m: any) => {
  if (kind === 'geyser-primary' && m?.t === 'program-filter') {
    try { setGeyserPrimaryPrograms(m.programs) }
    catch (e) { console.error('[sol:geyser-primary] invalid program filter', String(e)) }
  }
})

if (kind === 'geyser-primary') {
  setGeyserPrimaryPrograms(workerData.programs)
  parentPort!.postMessage({ t: 'filter-ack', programs: workerData.programs.length })
  geyserLane('geyser-primary', config.yellowstoneGrpcUrl!, config.yellowstoneXToken!)
}
else if (kind === 'geyser') geyserLane('geyser', config.tritonGrpcUrl!, config.tritonXToken!)
else if (kind === 'geyser-drpc') geyserLane('geyser-drpc', config.drpcGeyserUrl!, config.drpcKey!)
else if (kind === 'deshred') deshredLane(config.tritonGrpcUrl!, config.tritonXToken!)
else if (kind === 'preconf') preconfsLanes()
