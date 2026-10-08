// Main-thread side of the research LaserStream, which runs in
// blocktime-worker.ts. Same exports as blocktime.ts; callbacks are replayed in
// the order the worker emitted them.
import { Worker } from 'node:worker_threads'
import { redact } from '../config.ts'
import { bus } from '../hub.ts'
import type { BlockTimeStreamOptions } from './blocktime.ts'

type Usage = { connected: boolean; trackedMints: number; activeFallbackPrograms: number; latestFinalizedSlot: number | null } & Record<string, unknown>
let usage: Usage = { connected: false, trackedMints: 0, activeFallbackPrograms: 0, latestFinalizedSlot: null }
let worker: Worker | null = null
// Survives worker restarts, as the module-level desired filter did in-process.
let desiredFallback: { programs: string[]; lastPrimarySlot?: number | null } | null = null
let nextRequest = 0
const requests = new Map<number, { resolve: (applied: boolean) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()

export function blockTimeUsage(): Usage { return usage }

export function setFallbackPrograms(programs: string[], lastPrimarySlot?: number | null): Promise<boolean> {
  desiredFallback = { programs: [...programs], lastPrimarySlot }
  if (!worker) return Promise.resolve(false)
  const id = ++nextRequest
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => { requests.delete(id); resolve(false) }, 30_000)
    requests.set(id, { resolve, reject, timer })
    worker!.postMessage({ t: 'fallback', id, programs, lastPrimarySlot })
  })
}

function settle(id: number, applied: boolean, error?: string) {
  const request = requests.get(id)
  if (!request) return
  requests.delete(id)
  clearTimeout(request.timer)
  if (error) request.reject(new Error(error))
  else request.resolve(applied)
}

export async function startBlockTimeStream(options: BlockTimeStreamOptions = {}): Promise<() => void> {
  const { subscribeResearch: _unused, fromSlot, ...rest } = options
  const callbacks = Object.keys(rest).filter(name => typeof (rest as any)[name] === 'function')
  let stopped = false
  const forwardResearch = (chain: string, address: string, enrolled: boolean) => {
    if (chain === 'solana' && enrolled) worker?.postMessage({ t: 'research', chain, address, enrolled })
  }
  bus.on('research', forwardResearch)

  const spawn = () => {
    const w = new Worker(new URL('./blocktime-worker.ts', import.meta.url), {
      workerData: { callbacks, fromSlot, fallback: desiredFallback },
    })
    worker = w
    w.on('message', (m: any) => {
      if (m.t === 'usage') usage = m.usage
      else if (m.t === 'calls') for (const [name, args] of m.items as [string, any[]][]) {
        if (name === '@fallback') { settle(args[0], args[1], args[2]); continue }
        try { (options as any)[name]?.(...args) }
        catch (error) { console.error(`[sol:research] ${name}`, redact(String(error))) }
      }
    })
    w.on('error', error => console.error('[sol:research] worker', redact(String(error))))
    w.on('exit', code => {
      if (worker !== w) return
      worker = null
      usage = { ...usage, connected: false, activeFallbackPrograms: 0 }
      for (const id of [...requests.keys()]) settle(id, false)
      if (stopped) return
      // What markDisconnected reported in-process: the next worker replays from
      // the last finalized block it persisted.
      const reason = `research stream worker exited ${code}`
      options.onConnection?.(false, reason)
      options.onFallbackStatus?.(0)
      const gap = { t: 'gap' as const, lane: 'laserstream' as const, ts: Date.now(), reason }
      options.onStream?.(gap)
      options.onHolderStream?.(gap)
      options.onGap?.(reason)
      console.warn(`[sol:research] ${reason}, restarting`)
      setTimeout(spawn, 2000)
    })
  }
  spawn()
  return () => {
    stopped = true
    bus.off('research', forwardResearch)
    void worker?.terminate()
    worker = null
  }
}
