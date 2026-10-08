import { config, redact } from './config.ts'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { startApi } from './api.ts'
import { startRobinhood } from './robinhood/ingest.ts'
import { startRobinhoodHolders } from './robinhood/holders.ts'
import { startRobinhoodSwaps } from './robinhood/swaps.ts'
import { startRobinhoodProvisional } from './robinhood/provisional.ts'
import { startSolana } from './solana/lanes.ts'
import { loadFollowedWallets } from './social.ts'
import { startPush } from './push.ts'
import { bus, ingest, lane, sweepPending } from './hub.ts'
import { enrich } from './meta.ts'
import { db, getCursor, setCursor } from './db.ts'
import { ingestSwap, onResearchSwapStream, onResearchSwapStreamBatch } from './research.ts'
import { startParsedStream } from './solana/parsed-stream.ts'
import { setFallbackPrograms, startBlockTimeStream } from './solana/blocktime.ts'
import { onHolderMetadataGap, onHolderStreamBatch, onHolderStreamEvent, onHolderTransaction, startHolders } from './solana/holders.ts'
import { startProgramBackfill } from './solana/program-backfill.ts'
import { ingestProgramObservations, programSource, startProgramDiscovery } from './solana/program-service.ts'

loadFollowedWallets()
startApi(config.port)
startProgramDiscovery()
startHolders(mint => bus.emit('research', 'solana', mint, false))
startProgramBackfill()
startPush()
startRobinhood()
// Latest-head observations are a separate, explicitly unfinalized overlay.
if (process.env.RH_PROVISIONAL_SOURCE === '1') startRobinhoodProvisional()
// Historical RH Research can replay tens of millions of blocks. Enable only
// after measuring the provider's log-range cost and finality behavior.
if (process.env.RH_RESEARCH_SOURCE === '1') {
  startRobinhoodHolders()
  startRobinhoodSwaps()
}

// Aggregate runtime telemetry helps separate provider latency from synchronous
// main-thread stalls. It contains no account, token, request, or secret data.
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 })
eventLoopDelay.enable()
let priorEventLoop = performance.eventLoopUtilization()
setInterval(() => {
  const utilization = performance.eventLoopUtilization(priorEventLoop)
  priorEventLoop = performance.eventLoopUtilization()
  console.log(`[runtime] event-loop p99=${Math.round(eventLoopDelay.percentile(99) / 1e6)}ms max=${Math.round(eventLoopDelay.max / 1e6)}ms utilization=${Math.round(utilization.utilization * 100)}%`)
  eventLoopDelay.reset()
}, 10_000).unref()

const heliusLane = lane('solana', 'helius-laserstream', config.heliusTargetedStream,
  config.heliusTargetedStream ? 'awaiting finalized mint stream' : 'HELIUS_TARGETED_STREAM=1 not set')
heliusLane.configuredStreams = config.heliusTargetedStream ? 1 : 0
heliusLane.activeStreams = 0
heliusLane.filterPrograms = 0
let fallbackGapReason: string | undefined
let fallbackActivation: NodeJS.Timeout | null = null
let latestPrimaryHealth: { healthy: boolean; programs: string[]; lastFinalizedSlot: number | null } | null = null
const setFluxPrograms = startSolana(ingest,
  (l, enabled, reason, stats) => { const s = lane('solana', l, enabled, reason); if (stats) Object.assign(s, stats); programSource(l, enabled && !!stats?.connected) },
  ingestSwap, onResearchSwapStream, health => {
    if (!config.heliusTargetedStream) return
    latestPrimaryHealth = health
    if (fallbackActivation) { clearTimeout(fallbackActivation); fallbackActivation = null }
    if (health.healthy) {
      void setFallbackPrograms([]).then(applied => {
        if (!applied || !latestPrimaryHealth?.healthy) return
        fallbackGapReason = undefined
        if (heliusLane.connected) heliusLane.reason = undefined
      }).catch(error => console.error('[sol:research] fallback filter', redact(String(error))))
      return
    }
    // Primary workers report an unhealthy transition while starting and
    // while Parsed Streams changes the two-program filter. Replaying all 11
    // programs on each short transition can overwhelm the main API process.
    // A sustained outage still activates the authorized Helius fallback,
    // replaying from before the last finalized Flux slot.
    fallbackActivation = setTimeout(() => {
      fallbackActivation = null
      const current = latestPrimaryHealth
      if (!current || current.healthy || !current.programs.length) return
      fallbackGapReason = 'FTL fallback replays from before the last finalized Flux slot; complete handoff coverage is unverified.'
      void setFallbackPrograms(current.programs, current.lastFinalizedSlot).then(applied => {
        if (!latestPrimaryHealth?.healthy) heliusLane.reason = applied ? fallbackGapReason
          : 'FTL fallback filter is awaiting Helius acknowledgement'
        else void setFallbackPrograms([])
      }).catch(error => console.error('[sol:research] fallback filter', redact(String(error))))
    }, 20_000)
  }, ingestProgramObservations)
startParsedStream(ingest, (status, fallbackPrograms) => {
  const s = lane('solana', 'helius-parsed', config.heliusParsedStream, status.reason)
  Object.assign(s, status)
  programSource('helius-parsed', status.connected)
  setFluxPrograms(fallbackPrograms)
})
if (config.heliusTargetedStream) void startBlockTimeStream({
  onSwap: ingestSwap,
  onPrograms: config.programDiscovery ? ingestProgramObservations : undefined,
  onHolderStream: onHolderStreamEvent,
  onHolderStreamBatch,
  onHolderTransaction,
  onHolderMetadataGap,
  onStreamBatch: onResearchSwapStreamBatch,
  onStream: event => {
    onResearchSwapStream(event)
    if (event.t === 'pulse') { heliusLane.lastMsgTs = event.ts; heliusLane.msgs++ }
  },
  onFallbackEvent: ingest,
  onFallbackStatus: programs => {
    heliusLane.filterPrograms = programs
    if (programs && fallbackGapReason) heliusLane.reason = fallbackGapReason
  },
  onConnection: (connected, reason) => {
    programSource('helius-laserstream', connected)
    heliusLane.connected = connected
    heliusLane.activeStreams = connected ? 1 : 0
    heliusLane.reason = reason ?? fallbackGapReason
    if (connected) heliusLane.lastMsgTs = Date.now()
  },
  onGap: reason => console.error('[sol:research]', reason),
}).catch(error => console.error('[sol:research] could not start', redact(String(error))))
setInterval(sweepPending, 5000).unref()

// metadata v3: anything active in the last day still missing a symbol or image is asked again,
// now with retries until it resolves
if (getCursor('meta:v3') !== 'done') {
  const rows = db.prepare('SELECT chain, address FROM tokens WHERE last_ts > ? AND (symbol IS NULL OR image IS NULL) ORDER BY last_ts DESC LIMIT 500').all(Date.now() - 86400_000) as any[]
  for (const r of rows) enrich(r.chain, r.address, true)
  setCursor('meta:v3', 'done')
  console.log(`[meta] re-resolving ${rows.length} tokens`)
}

process.on('unhandledRejection', (e) => console.error('[unhandled]', e))
