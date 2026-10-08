// Canonical Solana block timestamps and mint-filtered transactions from one
// finalized LaserStream subscription.
// This never substitutes local receipt time for on-chain time or makes RPC reads.

import laserstream from 'helius-laserstream'
import { performance } from 'node:perf_hooks'
import proto from 'laserstream-core-proto-js/generated.js'
import type { StreamHandle, SubscribeRequest } from 'helius-laserstream'
import { config, redact } from '../config.ts'
import { db } from '../db.ts'
import { bus } from '../hub.ts'
import type { RawEvent } from '../hub.ts'
import { validSolanaMint } from '../research.ts'
import { toNTx } from './lanes.ts'
import { decode } from './decode.ts'
import { programIds } from './programs.ts'
import { extractSwap, type SwapObservation, type SwapStreamEvent } from './swaps.ts'
import type { HolderTransactionUpdate } from './holders.ts'
import { StreamPayloadBudget } from './stream-budget.ts'

const { CommitmentLevel, CompressedAccountFilterSet, subscribe } = laserstream
const { SlotStatus, SubscribeUpdate } = proto.geyser

const RETAIN_MS = 72 * 60 * 60_000
const MAX_WAITERS = 5_000
const MAX_HOLDER_ACK_BUFFER = 10_000
// Zero means telemetry only. The operator may opt into a circuit breaker.
const configuredCapMib = Number(process.env.HELIUS_BLOCKTIME_MAX_MIB_PER_HOUR ?? 0)
if (!Number.isSafeInteger(configuredCapMib) || configuredCapMib < 0)
  throw new Error('HELIUS_BLOCKTIME_MAX_MIB_PER_HOUR must be a non-negative integer')
const BLOCKTIME_HOURLY_CAP = configuredCapMib * 1024 * 1024
const streamBudget = new StreamPayloadBudget(config.dataDir, 'helius-blocktime', BLOCKTIME_HOURLY_CAP)
let streamConnected = false
let trackedMints = 0
let activeFallbackPrograms = 0

let desiredFallbackPrograms: string[] = []
let desiredFallbackReplaySlot: number | undefined
let applyFallback: ((programs: string[], replaySlot?: number) => Promise<boolean>) | null = null
export function setFallbackPrograms(programs: string[], lastPrimarySlot?: number | null): Promise<boolean> {
  if (programs.some(program => !programIds.includes(program)))
    throw new Error('invalid Helius fallback program')
  if (lastPrimarySlot !== undefined && lastPrimarySlot !== null &&
    (!Number.isSafeInteger(lastPrimarySlot) || lastPrimarySlot < 0))
    throw new Error('invalid primary stream replay slot')
  desiredFallbackPrograms = [...new Set(programs)].sort()
  // The latest slot seen on Flux is not a completed-slot marker. Replaying
  // earlier than it covers in-flight transactions and the stale detector's
  // transition interval. The status still reports a handoff gap until the
  // provider has acknowledged the fallback filter and replay reaches live.
  desiredFallbackReplaySlot = desiredFallbackPrograms.length && lastPrimarySlot !== undefined &&
    lastPrimarySlot !== null ? Math.max(0, lastPrimarySlot - 512) : undefined
  return applyFallback?.(desiredFallbackPrograms, desiredFallbackReplaySlot) ?? Promise.resolve(false)
}

export function blockTimeUsage() {
  const latest = (lastComplete.get() as { slot: number | null }).slot
  return { ...streamBudget.status(), connected: streamConnected, trackedMints,
    activeFallbackPrograms, latestFinalizedSlot: latest }
}

const getBlock = db.prepare('SELECT block_ts, blockhash, finalized FROM research_solana_blocktime WHERE slot = ?')
const upsertMeta = db.prepare('INSERT INTO research_solana_blocktime(slot,blockhash,block_ts,seen_ts) VALUES(?,?,?,?) ON CONFLICT(slot) DO UPDATE SET blockhash = excluded.blockhash, block_ts = excluded.block_ts, seen_ts = excluded.seen_ts')
const upsertFinal = db.prepare('INSERT INTO research_solana_blocktime(slot,finalized,seen_ts) VALUES(?,1,?) ON CONFLICT(slot) DO UPDATE SET finalized = 1, seen_ts = excluded.seen_ts')
const pruneOld = db.prepare('DELETE FROM research_solana_blocktime WHERE seen_ts < ?')
const lastComplete = db.prepare('SELECT MAX(slot) AS slot FROM research_solana_blocktime WHERE finalized = 1 AND block_ts IS NOT NULL AND blockhash IS NOT NULL')
const completeAtOrBefore = db.prepare('SELECT MAX(slot) AS slot FROM research_solana_blocktime WHERE finalized = 1 AND block_ts IS NOT NULL AND blockhash IS NOT NULL AND slot <= ?')
const waiters = new Map<number, Set<(ts: number | null) => void>>()
let waiterCount = 0
let observations = 0

export function finalizedBlockTime(slot: number): number | null {
  if (!Number.isSafeInteger(slot) || slot < 0) return null
  const row = getBlock.get(slot) as { block_ts: number | null; blockhash: string | null; finalized: number } | undefined
  return row?.finalized && row.blockhash && Number.isSafeInteger(row.block_ts) ? row.block_ts : null
}

function resolveWaiters(slot: number): void {
  const ts = finalizedBlockTime(slot)
  if (ts === null) return
  const listeners = waiters.get(slot)
  if (!listeners) return
  for (const resolve of [...listeners]) resolve(ts)
}

export function waitForFinalizedBlockTime(slot: number, timeoutMs = 60_000): Promise<number | null> {
  const ready = finalizedBlockTime(slot)
  if (ready !== null) return Promise.resolve(ready)
  if (!Number.isSafeInteger(slot) || slot < 0 || !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 || timeoutMs > 120_000 || waiterCount >= MAX_WAITERS) return Promise.resolve(null)
  return new Promise(resolve => {
    let listeners = waiters.get(slot)
    if (!listeners) { listeners = new Set(); waiters.set(slot, listeners) }
    const finish = (value: number | null) => {
      clearTimeout(timer)
      if (listeners!.delete(finish)) {
        waiterCount--
        if (!listeners!.size) waiters.delete(slot)
      }
      resolve(value)
    }
    listeners.add(finish)
    waiterCount++
    const timer = setTimeout(() => finish(null), timeoutMs)
  })
}

export function recordFinalizedSlot(slot: number, seenTs = Date.now()): void {
  if (!Number.isSafeInteger(slot) || slot < 0 || !Number.isSafeInteger(seenTs) || seenTs <= 0) return
  upsertFinal.run(slot, seenTs)
  resolveWaiters(slot)
}

export function recordBlockMeta(slot: number, blockhash: string, blockTs: number, seenTs = Date.now()): boolean {
  if (!Number.isSafeInteger(slot) || slot < 0 || !blockhash ||
    !Number.isSafeInteger(blockTs) || blockTs <= 0 || !Number.isSafeInteger(seenTs) || seenTs <= 0) return false
  const old = getBlock.get(slot) as { block_ts: number | null; blockhash: string | null; finalized: number } | undefined
  if (old?.finalized && old.blockhash && (old.blockhash !== blockhash || old.block_ts !== blockTs)) {
    // Conflicting finalized metadata is not safe to attach to trades.
    db.prepare('DELETE FROM research_solana_blocktime WHERE slot = ?').run(slot)
    return false
  }
  upsertMeta.run(slot, blockhash, blockTs, seenTs)
  resolveWaiters(slot)
  if (++observations % 1024 === 0) pruneOld.run(seenTs - RETAIN_MS)
  return true
}

export interface BlockTimeStreamOptions {
  fromSlot?: number
  onGap?: (reason: string) => void
  onSwap?: (swap: SwapObservation) => void
  onStream?: (event: SwapStreamEvent) => void
  onStreamBatch?: (events: SwapStreamEvent[]) => void
  onHolderStream?: (event: SwapStreamEvent) => void
  onHolderStreamBatch?: (events: SwapStreamEvent[]) => void
  onHolderTransaction?: (update: HolderTransactionUpdate) => void
  onHolderMetadataGap?: (reason: string) => void
  onFallbackEvent?: (event: RawEvent) => void
  onFallbackStatus?: (activePrograms: number) => void
  onConnection?: (connected: boolean, reason?: string) => void
}

export function researchLaserStreamRequest(mints: string[], fromSlot?: number, filterName = 'research',
  fallbackPrograms: string[] = []): SubscribeRequest {
  // The installed SDK's JS-facing extension converts matchMints (proto #32)
  // before encoding. Keep this a plain object; generated .create() discards it.
  // Explicit accountInclude lists share a provider plan limit. A transaction
  // cuckoo filter scales with the entire enrolled universe; exact-check every
  // decoded candidate locally before storing it.
  let transactionFilter: Record<string, unknown> | null = null
  if (mints.length > 10) {
    const filter = new CompressedAccountFilterSet(Math.max(16, Math.ceil(mints.length * 1.5)))
    for (const mint of mints) filter.insert(mint)
    if (filter.toBytes().length > 32 * 1024 * 1024)
      throw new Error('research mint filter exceeds LaserStream 32 MiB limit')
    transactionFilter = { ...filter.toTransactionFilter(), vote: false, failed: false, matchMints: true }
  } else if (mints.length) {
    transactionFilter = {
      vote: false, failed: false, accountInclude: mints,
      accountExclude: [], accountRequired: [], matchMints: true,
    }
  }
  return {
    accounts: {}, slots: { [filterName]: { filterByCommitment: true } },
    transactions: {
      ...(transactionFilter ? { [filterName]: transactionFilter } : {}),
      ...(fallbackPrograms.length ? { [`f${filterName}`]: {
        vote: false, failed: false, accountInclude: fallbackPrograms,
        accountExclude: [], accountRequired: [],
      } } : {}),
    },
    transactionsStatus: {}, blocks: {}, blocksMeta: { [filterName]: {} },
    entry: {}, accountsDataSlice: [], blockFooter: {}, commitment: CommitmentLevel.FINALIZED,
    ...(fromSlot === undefined ? {} : { fromSlot }),
  } as SubscribeRequest
}

// One subscription combines all-block metadata with finalized transactions
// matched by every Solana mint enrolled in Research. blocksMeta has no mint
// filter; bytes are persisted and a cap is operator opt-in.
export async function startBlockTimeStream(options: BlockTimeStreamOptions = {}): Promise<() => void> {
  if (options.fromSlot !== undefined && (!Number.isSafeInteger(options.fromSlot) || options.fromSlot < 0))
    throw new Error('invalid blocktime replay slot')
  const apiKey = process.env.HELIUS_API_KEY?.trim()
  if (!apiKey) { options.onGap?.('Helius LaserStream key is not configured'); return () => {} }
  const budget = streamBudget
  const mints = new Set((db.prepare("SELECT address FROM research_tokens WHERE chain = 'solana'").all() as { address: string }[])
    .map(row => row.address).filter(validSolanaMint))
  trackedMints = mints.size
  // startResearch() closed the previous process's sessions at its last pulse.
  // Preserve the identity of those sessions so a verified inclusive replay
  // can resume them after a deploy rather than manufacture a new time gap.
  const priorSessions = db.prepare(`SELECT token, gap_reason FROM research_stream_sessions
    WHERE lane = 'laserstream' AND token IS NOT NULL ORDER BY id DESC`)
    .all() as { token: string; gap_reason: string | null }[]
  const covered = new Set<string>()
  const examined = new Set<string>()
  for (const row of priorSessions) {
    if (!validSolanaMint(row.token) || examined.has(row.token)) continue
    examined.add(row.token)
    if (row.gap_reason === null || row.gap_reason === 'stream disconnected' || row.gap_reason === 'stream restarted')
      covered.add(row.token)
  }
  const active = new Set<string>()
  let acknowledged = new Set<string>()
  let acknowledgedResearchName: string | null = null
  let acknowledgedFallback: string[] = []
  let acknowledgedFallbackName: string | null = null
  let pendingAck: { name: string; mints: Set<string>; fallbackPrograms: string[] } | null = null
  const fallbackWaiters = new Set<{ key: string; resolve: (applied: boolean) => void; timer: NodeJS.Timeout }>()
  const fallbackKey = (programs: string[]) => programs.join(',')
  let ackTimer: NodeJS.Timeout | null = null
  let nextFilterId = Math.floor(Date.now() % 1_000_000_000)
  const filterName = () => `r${(++nextFilterId).toString(36)}`
  let lastMetaSlot: number | null = null
  let caughtUp = false
  let handle: StreamHandle | null = null
  let stopped = false
  let retry: NodeJS.Timeout | null = null
  let updateTimer: NodeJS.Timeout | null = null
  let lastPulse = 0
  let generation = 0
  let forceLive = false
  let replayGapRetries = 0
  let replayStartSlot: number | undefined
  let requestedFallbackKey = fallbackKey(desiredFallbackPrograms)
  let lastCoveragePulse = 0
  const holderAckBuffer: { update: HolderTransactionUpdate; slot: number; index: number }[] = []
  const holderAckOverflow = new Set<string>()
  let holderAckMetadataGap = false
  const callbackTiming = { since: Date.now(), updates: 0, transactions: 0, metadata: 0,
    totalMs: 0, maxMs: 0, encodeMs: 0, holderCalls: 0, holderMs: 0,
    sampledTxBytes: 0, sampledMetaBytes: 0, sampledSlotBytes: 0,
    sampledTx: 0, sampledExactMintTx: 0 }
  const deliverHolderTransaction = (update: HolderTransactionUpdate) => {
    if (!options.onHolderTransaction) return
    const start = performance.now()
    try { options.onHolderTransaction(update) } finally {
      callbackTiming.holderCalls++
      callbackTiming.holderMs += performance.now() - start
    }
  }
  const emitStream = (event: SwapStreamEvent) => {
    options.onStream?.(event)
    options.onHolderStream?.(event)
  }
  const holderMints = (update: HolderTransactionUpdate): string[] => {
    const meta = update.transaction?.meta
    const found = new Set<string>()
    for (const balance of [...(meta?.preTokenBalances ?? []), ...(meta?.postTokenBalances ?? [])])
      if (balance.mint && mints.has(balance.mint)) found.add(balance.mint)
    return [...found]
  }
  const flushHolderAck = () => {
    if (holderAckMetadataGap) options.onHolderMetadataGap?.('Finalized mint-filter transaction omitted token-balance arrays before filter acknowledgement.')
    holderAckMetadataGap = false
    holderAckBuffer.sort((a, b) => a.slot - b.slot || a.index - b.index)
    for (const item of holderAckBuffer) deliverHolderTransaction(item.update)
    holderAckBuffer.length = 0
    for (const mint of holderAckOverflow) options.onHolderStream?.({ t: 'gap', lane: 'laserstream',
      token: mint, ts: Date.now(), reason: 'Finalized holder transactions exceeded the filter-ACK replay buffer.' })
    holderAckOverflow.clear()
  }
  const gap = (reason: string) => options.onGap?.(reason)
  const settleFallbackWaiters = (key: string, applied: boolean) => {
    for (const waiter of [...fallbackWaiters]) {
      if (applied && waiter.key !== key) continue
      clearTimeout(waiter.timer)
      fallbackWaiters.delete(waiter)
      waiter.resolve(applied && waiter.key === key)
    }
  }
  const refreshCoverage = () => {
    if (!caughtUp || (!acknowledged.size && !acknowledgedFallback.length)) return
    if (!streamConnected) options.onConnection?.(true)
    streamConnected = true
    if (activeFallbackPrograms !== acknowledgedFallback.length) {
      activeFallbackPrograms = acknowledgedFallback.length
      options.onFallbackStatus?.(activeFallbackPrograms)
    }
    settleFallbackWaiters(fallbackKey(acknowledgedFallback), true)
    const ts = Date.now()
    const opened: SwapStreamEvent[] = []
    for (const mint of acknowledged) {
      if (active.has(mint)) continue
      opened.push({ t: covered.has(mint) ? 'resume' : 'open', lane: 'laserstream', token: mint,
        ts, fromSlot: replayStartSlot })
      covered.add(mint)
      active.add(mint)
    }
    if (options.onStreamBatch) options.onStreamBatch(opened)
    else for (const event of opened) options.onStream?.(event)
    if (options.onHolderStreamBatch) options.onHolderStreamBatch(opened)
    else for (const event of opened) options.onHolderStream?.(event)
  }
  const markDisconnected = (reason: string, unreplayed: boolean) => {
    if (unreplayed) covered.clear()
    options.onConnection?.(false, reason)
    streamConnected = false
    if (activeFallbackPrograms) { activeFallbackPrograms = 0; options.onFallbackStatus?.(0) }
    caughtUp = false
    acknowledged = new Set()
    acknowledgedResearchName = null
    acknowledgedFallback = []
    acknowledgedFallbackName = null
    active.clear()
    pendingAck = null
    holderAckBuffer.length = 0
    holderAckOverflow.clear()
    holderAckMetadataGap = false
    if (ackTimer) { clearTimeout(ackTimer); ackTimer = null }
    emitStream({ t: unreplayed ? 'gap' : 'close', lane: 'laserstream', ts: Date.now(), reason })
    gap(reason)
  }
  const scheduleRestart = (delayMs: number) => {
    if (stopped) return
    generation++
    const old = handle
    handle = null
    old?.cancel()
    if (retry) clearTimeout(retry)
    retry = setTimeout(() => { retry = null; void run() }, delayMs)
  }
  const updateMints = async () => {
    updateTimer = null
    if (!handle || stopped || pendingAck) return
    const name = filterName()
    const nextMints = new Set(mints)
    const nextFallback = [...desiredFallbackPrograms]
    try {
      const request = researchLaserStreamRequest([...nextMints], undefined, name, nextFallback)
      pendingAck = { name, mints: nextMints, fallbackPrograms: nextFallback }
      ackTimer = setTimeout(() => {
        if (pendingAck?.name !== name) return
        markDisconnected('mint filter update was not acknowledged by block metadata', true)
        scheduleRestart(5_000)
      }, 15_000)
      await handle.write(request)
    } catch (error) {
      markDisconnected('mint filter update failed or exceeded provider limits', true)
      console.error('[sol:blocktime] filter', redact(String(error)))
      scheduleRestart(30_000)
    }
  }
  applyFallback = (programs, replaySlot) => {
    if (stopped) return Promise.resolve(false)
    if (streamConnected && fallbackKey(acknowledgedFallback) === fallbackKey(programs))
      return Promise.resolve(true)
    const key = fallbackKey(programs)
    const changed = key !== requestedFallbackKey
    requestedFallbackKey = key
    const promise = new Promise<boolean>(resolve => {
      const waiter = { key, resolve, timer: setTimeout(() => {
        fallbackWaiters.delete(waiter)
        resolve(false)
      }, 20_000) }
      fallbackWaiters.add(waiter)
    })
    if (changed && programs.length) {
      // Dynamic filter writes cannot replay the interval between Flux going
      // stale and Helius acknowledging the new filter. Restart the same
      // combined subscription with an inclusive fallback checkpoint.
      if (updateTimer) { clearTimeout(updateTimer); updateTimer = null }
      markDisconnected('FTL fallback filter changing for inclusive replay', false)
      scheduleRestart(0)
    } else if (!updateTimer) updateTimer = setTimeout(() => void updateMints(), 100)
    return promise
  }
  const onResearch = (chain: string, address: string, enrolled: boolean) => {
    if (chain !== 'solana' || !enrolled || !validSolanaMint(address) || mints.has(address)) return
    mints.add(address)
    trackedMints = mints.size
    if (updateTimer) clearTimeout(updateTimer)
    updateTimer = setTimeout(() => void updateMints(), 100)
  }
  bus.on('research', onResearch)
  const run = async () => {
    if (stopped) return
    const currentGeneration = ++generation
    const status = budget.status()
    if (status.circuitOpenUntil) {
      gap('block metadata byte budget paused the stream')
      retry = setTimeout(() => void run(), Math.max(1_000, status.circuitOpenUntil - Date.now()))
      return
    }
    const latest = (lastComplete.get() as { slot: number | null }).slot
    // Replay the last persisted slot inclusively: its blockMeta may have been
    // committed just before a transaction callback that still needs replay.
    // Signature-level dedup in Research makes duplicates harmless.
    let fromSlot = forceLive ? undefined : (options.fromSlot ?? (latest === null ? undefined : latest))
    if (!forceLive && desiredFallbackPrograms.length && desiredFallbackReplaySlot !== undefined) {
      const anchor = (completeAtOrBefore.get(desiredFallbackReplaySlot) as { slot: number | null }).slot
      const fallbackFrom = anchor ?? desiredFallbackReplaySlot
      fromSlot = fromSlot === undefined ? fallbackFrom : Math.min(fromSlot, fallbackFrom)
    }
    replayStartSlot = fromSlot
    // Re-verify every block link from the inclusive replay anchor. Keeping
    // the previous live tip here would ignore gaps inside an older replay.
    const anchor = fromSlot === undefined ? null : getBlock.get(fromSlot) as
      { block_ts: number | null; blockhash: string | null; finalized: number } | undefined
    lastMetaSlot = anchor?.finalized && anchor.blockhash && anchor.block_ts !== null ? fromSlot : null
    if (covered.size && lastMetaSlot === null) covered.clear()
    const name = filterName()
    const initialMints = new Set(mints)
    const initialFallback = [...desiredFallbackPrograms]
    try {
      const request = researchLaserStreamRequest([...initialMints], fromSlot, name, initialFallback)
      pendingAck = { name, mints: initialMints, fallbackPrograms: initialFallback }
      const opened = await subscribe({
        apiKey, endpoint: config.heliusLaserstreamUrl, replay: true, maxReconnectAttempts: 5,
      }, request, update => {
        if (stopped || currentGeneration !== generation) return
        const callbackStart = performance.now()
        try {
          // Protobuf re-encoding exists only to estimate payload spend; the
          // SDK has already decoded this update. Sample every 16th message,
          // as the primary Yellowstone lane does, without dropping events.
          const sample = callbackTiming.updates % 16 === 0
          let sampledBytes: number | null = null
          if (sample) {
            const encodeStart = performance.now()
            sampledBytes = SubscribeUpdate.encode(update).finish().length
            callbackTiming.encodeMs += performance.now() - encodeStart
            if (update.transaction) {
              callbackTiming.sampledTxBytes += sampledBytes
              callbackTiming.sampledTx++
              const balances = update.transaction.transaction?.meta
              if ([...(balances?.preTokenBalances ?? []), ...(balances?.postTokenBalances ?? [])]
                .some(balance => balance.mint && mints.has(balance.mint)))
                callbackTiming.sampledExactMintTx++
            } else if (update.blockMeta) callbackTiming.sampledMetaBytes += sampledBytes
            else callbackTiming.sampledSlotBytes += sampledBytes
          }
          const next = budget.observe(sampledBytes)
          if (next.circuitOpenUntil) {
            markDisconnected('LaserStream byte budget reached', true)
            scheduleRestart(Math.max(1_000, next.circuitOpenUntil - Date.now()))
            return
          }
          const now = Date.now()
          if (now - lastPulse >= 5_000) {
            lastPulse = now
            emitStream({ t: 'pulse', lane: 'laserstream', ts: now })
          }
          const slot = update.slot
          if (slot?.status === SlotStatus.SLOT_FINALIZED) recordFinalizedSlot(Number(slot.slot))
          if (slot?.status === SlotStatus.SLOT_DEAD) {
            markDisconnected('block metadata stream reported a dead slot', true)
            scheduleRestart(5_000)
            return
          }
          const meta = update.blockMeta
          const timestampSec = meta?.blockTime?.timestamp
          if (meta && (timestampSec === undefined || timestampSec === null)) {
            markDisconnected('finalized block metadata had no on-chain timestamp', true)
            scheduleRestart(5_000)
            return
          }
          if (meta && timestampSec !== undefined && timestampSec !== null) {
            const timestampMs = Number(timestampSec) * 1000
            const metaSlot = Number(meta.slot)
            const parentSlot = Number(meta.parentSlot)
            const priorMetaSlot = lastMetaSlot
            if (lastMetaSlot !== null && metaSlot > lastMetaSlot && parentSlot !== lastMetaSlot) {
              markDisconnected('finalized block metadata parent chain has a gap', true)
              if (++replayGapRetries > 2) { forceLive = true; lastMetaSlot = null }
              scheduleRestart(5_000)
              return
            }
            if (!recordBlockMeta(metaSlot, meta.blockhash, timestampMs)) {
              markDisconnected('finalized block metadata conflicted or was invalid', true)
              scheduleRestart(5_000)
              return
            }
            if (lastMetaSlot === null || metaSlot > lastMetaSlot) lastMetaSlot = metaSlot
            // A replay can bridge the old session only after every subsequent
            // finalized block linked by parent slot AND the provider's event
            // creation time and on-chain block time have both reached the live
            // tip. In a bounded live probe they lagged by about nine seconds.
            const createdAt = update.createdAt instanceof Date ? update.createdAt.getTime() : NaN
            const atLiveTip = Number.isFinite(createdAt) && createdAt <= now + 5_000 &&
              now - createdAt <= 30_000 && timestampMs <= now + 5_000 && now - timestampMs <= 30_000
            if (atLiveTip) {
              caughtUp = true
              forceLive = false
              replayGapRetries = 0
            }
            refreshCoverage()
            if (priorMetaSlot !== null && metaSlot > priorMetaSlot && active.size &&
              now - lastCoveragePulse >= 5_000) {
              // The next parent-linked finalized block confirms the previous
              // block's coverage checkpoint; replay starts inclusively there.
              lastCoveragePulse = now
              emitStream({ t: 'pulse', lane: 'laserstream', ts: now,
                coveredThroughSlot: priorMetaSlot })
            }
          }
          // The server echoes the active named filter on every blockMeta.
          // Validate metadata continuity before acknowledging the filter so a
          // gap cannot briefly open a false continuous session.
          if (pendingAck && meta && update.filters?.includes(pendingAck.name)) {
            acknowledged = pendingAck.mints
            acknowledgedResearchName = pendingAck.name
            acknowledgedFallback = pendingAck.fallbackPrograms
            acknowledgedFallbackName = acknowledgedFallback.length ? `f${pendingAck.name}` : null
            pendingAck = null
            if (ackTimer) { clearTimeout(ackTimer); ackTimer = null }
            flushHolderAck()
            refreshCoverage()
            if ((acknowledged.size < mints.size ||
              fallbackKey(acknowledgedFallback) !== fallbackKey(desiredFallbackPrograms)) && !updateTimer)
              updateTimer = setTimeout(() => void updateMints(), 0)
          }
          if (!pendingAck && !acknowledged.size && handle && !updateTimer)
            updateTimer = setTimeout(() => void updateMints(), 0)
          const transaction = update.transaction
          const info = transaction?.transaction
          if (transaction && info && options.onHolderTransaction) {
            const tagged = update.filters ?? []
            const accepted = !!acknowledgedResearchName && tagged.includes(acknowledgedResearchName)
            const awaiting = !!pendingAck && tagged.includes(pendingAck.name)
            if (accepted || awaiting) {
              if (!Array.isArray(info.meta?.preTokenBalances) || !Array.isArray(info.meta?.postTokenBalances)) {
                if (accepted) options.onHolderMetadataGap?.('Finalized mint-filter transaction omitted token-balance arrays.')
                else holderAckMetadataGap = true
              } else {
                const updateMints = holderMints(transaction)
                if (updateMints.length && accepted)
                  deliverHolderTransaction(transaction)
                else if (updateMints.length && awaiting) {
                  if (holderAckBuffer.length < MAX_HOLDER_ACK_BUFFER)
                    holderAckBuffer.push({ update: transaction, slot: Number(transaction.slot),
                      index: Number(info.index) })
                  else for (const mint of updateMints) holderAckOverflow.add(mint)
                }
              }
            }
          }
          const fallbackMatched = !!options.onFallbackEvent && !!update.filters?.some(name =>
            name === acknowledgedFallbackName)
          if (info && (options.onSwap || fallbackMatched)) {
            const txSlot = Number(transaction.slot)
            const tx = toNTx(info.signature, txSlot, info.transaction?.message,
              info.meta?.loadedWritableAddresses ?? [], info.meta?.loadedReadonlyAddresses ?? [], info.meta)
            const candidate = tx && options.onSwap ? extractSwap(tx, 1) : null
            if (candidate && mints.has(candidate.token)) {
              const observedTs = finalizedBlockTime(txSlot)
              if (observedTs !== null) options.onSwap({ ...candidate, ts: observedTs, finalized: true })
              else void waitForFinalizedBlockTime(txSlot).then(blockTs => {
                if (stopped) return
                if (blockTs !== null) options.onSwap?.({ ...candidate, ts: blockTs, finalized: true })
                else emitStream({ t: 'gap', lane: 'laserstream', token: candidate.token,
                  ts: Date.now(), reason: 'finalized block timestamp unavailable for swap' })
              })
            }
            if (tx && fallbackMatched) {
              const emit = (blockTs: number | null) => {
                if (stopped) return
                if (blockTs === null) { gap('finalized block timestamp unavailable for fallback event'); return }
                for (const raw of decode(tx, 'helius-laserstream', 'confirmed'))
                  options.onFallbackEvent?.({ ...raw, at: blockTs })
              }
              const blockTs = finalizedBlockTime(txSlot)
              if (blockTs !== null) emit(blockTs)
              else void waitForFinalizedBlockTime(txSlot).then(emit)
            }
          }
        } catch (error) {
          markDisconnected('block metadata decode or budget accounting failed', true)
          console.error('[sol:blocktime]', redact(String(error)))
          scheduleRestart(5_000)
        } finally {
          const duration = performance.now() - callbackStart
          callbackTiming.updates++
          callbackTiming.transactions += Number(!!update.transaction)
          callbackTiming.metadata += Number(!!update.blockMeta)
          callbackTiming.totalMs += duration
          callbackTiming.maxMs = Math.max(callbackTiming.maxMs, duration)
          const at = Date.now()
          if (at - callbackTiming.since >= 10_000) {
            console.log(`[sol:research:cpu] updates=${callbackTiming.updates} tx=${callbackTiming.transactions} meta=${callbackTiming.metadata} callbackMs=${callbackTiming.totalMs.toFixed(1)} maxCallbackMs=${callbackTiming.maxMs.toFixed(1)} encodeMs=${callbackTiming.encodeMs.toFixed(1)} holderCalls=${callbackTiming.holderCalls} holderMs=${callbackTiming.holderMs.toFixed(1)} sampledTx=${callbackTiming.sampledTx} exactMintTx=${callbackTiming.sampledExactMintTx} sampledTxBytes=${callbackTiming.sampledTxBytes} sampledMetaBytes=${callbackTiming.sampledMetaBytes} sampledSlotBytes=${callbackTiming.sampledSlotBytes}`)
            callbackTiming.since = at
            callbackTiming.updates = 0; callbackTiming.transactions = 0; callbackTiming.metadata = 0
            callbackTiming.totalMs = 0; callbackTiming.maxMs = 0; callbackTiming.encodeMs = 0
            callbackTiming.holderCalls = 0; callbackTiming.holderMs = 0
            callbackTiming.sampledTxBytes = 0; callbackTiming.sampledMetaBytes = 0
            callbackTiming.sampledSlotBytes = 0; callbackTiming.sampledTx = 0
            callbackTiming.sampledExactMintTx = 0
          }
        }
      }, error => {
        if (stopped || currentGeneration !== generation) return
        const message = String(error)
        const unreplayed = /replay|out.of.range|from.slot/i.test(message)
        markDisconnected('LaserStream disconnected; replay is required', unreplayed)
        if (unreplayed) forceLive = true
        // Own the restart and its inclusive replay anchor. Relying on an
        // opaque SDK reconnect gives no proof of the starting slot.
        scheduleRestart(5_000)
        console.error('[sol:blocktime] stream', redact(String(error)))
      })
      if (currentGeneration !== generation) { opened.cancel(); return }
      handle = opened
      if (pendingAck) ackTimer = setTimeout(() => {
        if (pendingAck?.name !== name || currentGeneration !== generation) return
        markDisconnected('initial mint filter was not acknowledged by block metadata', true)
        scheduleRestart(5_000)
      }, 15_000)
    } catch (error) {
      if (currentGeneration !== generation) return
      markDisconnected('LaserStream could not connect', true)
      console.error('[sol:blocktime] connect', redact(String(error)))
      scheduleRestart(30_000)
    }
  }
  await run()
  return () => {
    stopped = true
    options.onConnection?.(false, 'stream stopped')
    streamConnected = false
    if (activeFallbackPrograms) { activeFallbackPrograms = 0; options.onFallbackStatus?.(0) }
    applyFallback = null
    settleFallbackWaiters('', false)
    if (retry) clearTimeout(retry)
    if (updateTimer) clearTimeout(updateTimer)
    if (ackTimer) clearTimeout(ackTimer)
    bus.off('research', onResearch)
    emitStream({ t: 'close', lane: 'laserstream', ts: Date.now() })
    handle?.cancel()
    budget.flush()
  }
}
