import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import { config, redact } from '../config.ts'
import type { ProgramDetail, ProgramList, ProgramUpdate } from '../../../shared/programs.ts'
import { type ProgramObservation } from './program-observation.ts'

export const programBus = new EventEmitter()
let worker: Worker | null = null
let started = false
let id = 0
const pending = new Map<number, { resolve: (data: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
let batch: ProgramObservation[] = []
let flushTimer: NodeJS.Timeout | null = null

export function startProgramDiscovery() {
  if (started) return
  started = true
  const spawn = () => {
    const next = new Worker(new URL('./program-index-worker.ts', import.meta.url))
    worker = next
    next.on('message', message => {
      if (message.t === 'programs') programBus.emit('update', message as ProgramUpdate)
      else if (message.t === 'response') {
        const request = pending.get(message.id)
        if (!request) return
        pending.delete(message.id); clearTimeout(request.timer)
        if (message.error) request.reject(new Error(message.error)); else request.resolve(message.data)
      }
    })
    next.on('error', error => console.error('[programs] worker', redact(String(error))))
    next.on('exit', code => {
      if (worker !== next) return
      worker = null
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Program index is restarting')) }
      pending.clear()
      console.warn(`[programs] worker exited ${code}; resuming durable queue`)
      setTimeout(spawn, 2000).unref()
    })
    if (batch.length) { next.postMessage({ t: 'observations', observations: batch }); batch = [] }
  }
  spawn()
}
export function ingestProgramObservations(observations: ProgramObservation[]) {
  if (!config.programDiscovery || !observations.length) return
  batch.push(...observations)
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    if (!worker) return
    worker.postMessage({ t: 'observations', observations: batch }); batch = []
  }, 100)
}
export function programSource(lane: string, connected: boolean) { worker?.postMessage({ t: 'source', lane, connected }) }
async function request<T>(operation: string, options: unknown): Promise<T> {
  if (!started) startProgramDiscovery()
  if (!worker) throw new Error('Program index is restarting')
  const key = ++id
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('Program index request timed out')) }, 10_000)
    pending.set(key, { resolve, reject, timer })
    worker!.postMessage({ t: 'request', id: key, operation, options })
  })
}
export const listPrograms = (options: Record<string, unknown> = {}) => request<ProgramList>('list', options)
export const getProgram = (address: string) => request<ProgramDetail | null>('detail', address)
export const getProgramIdl = (address: string) => request<string | null>('idl', address)
