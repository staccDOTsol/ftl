import fs from 'node:fs'
import path from 'node:path'

const MINUTE = 60_000
const WINDOW = 60 * MINUTE
const SAVE_INTERVAL = 2_000

interface Bucket { minute: number; messages: number; sampledBytes: number; samples: number }

export interface PayloadBudgetStatus {
  budgetLimitBytes: number
  budgetWindowMs: number
  estimatedWindowPayloadBytes: number
  budgetPayloadSamples: number
  circuitOpenUntil?: number
}

// The estimate is protobuf message payload, sampled 1:16 by the caller. It is
// deliberately separate from provider-billed transport bytes. A persisted
// sliding hour prevents a worker restart from clearing the circuit breaker.
export class StreamPayloadBudget {
  private buckets: Bucket[] = []
  private lastSave = 0
  private readonly file: string
  private readonly limitBytes: number

  constructor(dataDir: string, lane: string, limitBytes: number) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) throw new Error('invalid stream payload budget')
    this.limitBytes = limitBytes
    this.file = path.join(dataDir, `stream-budget-${lane}.json`)
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { buckets?: Bucket[] }
      if (!Array.isArray(raw.buckets) || !raw.buckets.every(b =>
        Number.isSafeInteger(b.minute) && Number.isSafeInteger(b.messages) && b.messages >= 0 &&
        Number.isSafeInteger(b.sampledBytes) && b.sampledBytes >= 0 &&
        Number.isSafeInteger(b.samples) && b.samples >= 0)) throw new Error('invalid stream budget state')
      this.buckets = raw.buckets
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e
    }
  }

  private prune(now: number): void {
    const minute = Math.floor(now / MINUTE) * MINUTE
    this.buckets = this.buckets.filter(b => b.minute > minute - WINDOW && b.minute <= minute)
  }

  private persist(now: number): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ buckets: this.buckets }), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
    this.lastSave = now
  }

  status(now = Date.now()): PayloadBudgetStatus {
    this.prune(now)
    const messages = this.buckets.reduce((n, b) => n + b.messages, 0)
    const samples = this.buckets.reduce((n, b) => n + b.samples, 0)
    const sampledBytes = this.buckets.reduce((n, b) => n + b.sampledBytes, 0)
    const estimated = samples ? Math.ceil(sampledBytes * messages / samples) : 0
    const tripped = this.limitBytes > 0 && estimated >= this.limitBytes
    return {
      budgetLimitBytes: this.limitBytes, budgetWindowMs: WINDOW,
      estimatedWindowPayloadBytes: estimated, budgetPayloadSamples: samples,
      circuitOpenUntil: tripped ? Math.min(...this.buckets.map(b => b.minute + WINDOW)) : undefined,
    }
  }

  observe(sampleBytes: number | null, now = Date.now()): PayloadBudgetStatus {
    if (sampleBytes !== null && (!Number.isSafeInteger(sampleBytes) || sampleBytes < 0)) throw new Error('invalid payload sample')
    this.prune(now)
    const minute = Math.floor(now / MINUTE) * MINUTE
    let bucket = this.buckets.find(b => b.minute === minute)
    if (!bucket) { bucket = { minute, messages: 0, sampledBytes: 0, samples: 0 }; this.buckets.push(bucket) }
    bucket.messages++
    if (sampleBytes !== null) { bucket.sampledBytes += sampleBytes; bucket.samples++ }
    const state = this.status(now)
    if (state.circuitOpenUntil || now - this.lastSave >= SAVE_INTERVAL) this.persist(now)
    return state
  }

  flush(now = Date.now()): void { this.prune(now); this.persist(now) }
}
