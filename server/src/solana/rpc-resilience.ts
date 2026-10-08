// Bounded resilience for server-side Solana JSON-RPC reads. One shared
// fetch-compatible wrapper retries rate limits, 5xx and network failures with
// capped exponential backoff and jitter, joins identical in-flight requests,
// and (inside an explicit memo scope only) serves pool/config account reads
// from a short TTL memo. Errors it raises never carry the endpoint URL.
import { AsyncLocalStorage } from 'node:async_hooks'

/** Retry policy: 3 attempts in total, backoff 250 ms · 2^(n-1) scaled by a
 * jitter factor in [0.5, 1), each wait at most 1 s, and no retry that would
 * end later than 1.5 s after the first attempt started. A `retry-after`
 * header replaces the computed wait; when it does not fit the budget the
 * wrapper gives up immediately. */
export const RPC_RETRY = { attempts: 3, baseDelayMs: 250, maxDelayMs: 1_000, budgetMs: 1_500 } as const
/** Memo policy: about 2 s per entry, at most 256 entries, no single response
 * over 1 MB. Only getAccountInfo / getMultipleAccounts inside a memo scope. */
export const RPC_MEMO = { ttlMs: 2_000, maxEntries: 256, maxEntryBytes: 1_000_000 } as const
export const RATE_LIMITED_MESSAGE = 'Route service is rate-limited; retry in a moment'
export const RATE_LIMITED_RETRY_AFTER_S = 2

const TRANSIENT_MARKER = 'Solana RPC transient failure'
const MEMO_METHODS = new Set(['getAccountInfo', 'getMultipleAccounts'])
const NO_DEDUPE = new Set(['sendTransaction', 'simulateTransaction', 'requestAirdrop'])

export class RpcTransientError extends Error {
  readonly transient = true
  readonly status: number | null
  constructor(status: number | null) {
    super(`${TRANSIENT_MARKER}: ${status === null ? 'network error' : `HTTP ${status}`}`)
    this.name = 'RpcTransientError'
    this.status = status
  }
}

/** True for the wrapper's give-up error, also after SDKs re-wrap it into a
 * plain Error string (web3.js getAccountInfo does) or attach it as a cause. */
export function isTransientRpcError(error: unknown): boolean {
  for (let e: any = error, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (e instanceof RpcTransientError || e.transient === true) return true
    if (typeof e.message === 'string' && e.message.includes(TRANSIENT_MARKER)) return true
    if (typeof e === 'string' && e.includes(TRANSIENT_MARKER)) return true
  }
  return false
}

/** Per-operation RPC context. `memo` allows memoized account reads for code
 * pricing pool state; anything building for a wallet runs without it.
 * `transient` counts give-ups observed by this scope or nested scopes. */
export type RpcScope = { memo: boolean; transient: number; parent: RpcScope | null }
const scopes = new AsyncLocalStorage<RpcScope>()
export function rpcScope(options: { memo?: boolean } = {}): RpcScope {
  return { memo: options.memo === true, transient: 0, parent: null }
}
export function runInRpcScope<T>(scope: RpcScope, fn: () => Promise<T>): Promise<T> {
  scope.parent = scopes.getStore() ?? null
  return scopes.run(scope, fn)
}
function markTransient(scope: RpcScope | undefined) {
  for (let s: RpcScope | null | undefined = scope; s; s = s.parent) s.transient++
}

type Stored = { status: number; statusText: string; headers: [string, string][]; text: string; id: unknown }
export type ResilientFetchOptions = {
  /** Underlying fetch; defaults to globalThis.fetch at call time. */
  fetch?: typeof fetch
  attempts?: number; baseDelayMs?: number; maxDelayMs?: number; budgetMs?: number
  memoTtlMs?: number; memoMaxEntries?: number; memoMaxEntryBytes?: number
  dedupe?: boolean
  /** Called with every HTTP status seen, before any retry decision. */
  onStatus?: (status: number) => void
  /** Veto further retries (e.g. while a caller-level cooldown is active). */
  canRetry?: () => boolean
  now?: () => number; sleep?: (ms: number) => Promise<void>; random?: () => number
}
export type ResilientFetch = ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) &
  { clearMemo(): void; readonly memoSize: number; readonly inflightSize: number }

const retryable = (status: number) => status === 429 || status >= 500
export function retryAfterMs(value: string | null, now: number): number | null {
  if (!value) return null
  const trimmed = value.trim()
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000)
  const at = Date.parse(trimmed)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
}
function parseRpc(body: unknown): { method: string; params: string; id: unknown } | null {
  if (typeof body !== 'string' || body.length > 100_000) return null
  try {
    const json = JSON.parse(body)
    if (!json || typeof json !== 'object' || Array.isArray(json) || typeof json.method !== 'string') return null
    return { method: json.method, params: JSON.stringify(json.params ?? null), id: json.id }
  } catch { return null }
}
function respond(stored: Stored, id: unknown, rewrite: boolean): Response {
  let text = stored.text
  if (rewrite && id !== stored.id) {
    try {
      const json = JSON.parse(text)
      if (json && typeof json === 'object' && !Array.isArray(json)) { json.id = id; text = JSON.stringify(json) }
    } catch { /* not JSON: hand back as is */ }
  }
  return new Response(text, { status: stored.status, statusText: stored.statusText, headers: stored.headers })
}
const okResult = (text: string) => {
  try { const json = JSON.parse(text); return !!json && typeof json === 'object' && !('error' in json) && 'result' in json } catch { return false }
}

export function createResilientFetch(options: ResilientFetchOptions = {}): ResilientFetch {
  const attempts = options.attempts ?? RPC_RETRY.attempts
  const base = options.baseDelayMs ?? RPC_RETRY.baseDelayMs
  const maxDelay = options.maxDelayMs ?? RPC_RETRY.maxDelayMs
  const budget = options.budgetMs ?? RPC_RETRY.budgetMs
  const ttl = options.memoTtlMs ?? RPC_MEMO.ttlMs
  const maxEntries = options.memoMaxEntries ?? RPC_MEMO.maxEntries
  const maxEntryBytes = options.memoMaxEntryBytes ?? RPC_MEMO.maxEntryBytes
  const dedupe = options.dedupe !== false
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const random = options.random ?? Math.random
  const memo = new Map<string, { expires: number; stored: Stored }>()
  const inflight = new Map<string, Promise<Stored>>()

  async function attempt(input: string | URL | Request, init: RequestInit, id: unknown): Promise<Stored> {
    const started = now()
    for (let n = 1; ; n++) {
      let res: Response | null = null
      try {
        res = await (options.fetch ?? globalThis.fetch)(input, init)
      } catch (error) {
        // A caller's own abort/timeout is not ours to retry or reclassify.
        if (init.signal?.aborted) throw error
      }
      if (res) options.onStatus?.(res.status)
      if (res && !retryable(res.status)) {
        return { status: res.status, statusText: res.statusText, text: await res.text(), id,
          headers: [...res.headers.entries()] }
      }
      const hinted = res ? retryAfterMs(res.headers.get('retry-after'), now()) : null
      if (res) await res.body?.cancel().catch(() => {})
      const delay = hinted ?? Math.round(Math.min(maxDelay, base * 2 ** (n - 1)) * (0.5 + 0.5 * random()))
      if (n >= attempts || now() - started + delay > budget || options.canRetry?.() === false)
        throw new RpcTransientError(res ? res.status : null)
      await sleep(delay)
    }
  }

  const resilient = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const rpc = parseRpc(init.body)
    const scope = scopes.getStore()
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const key = rpc ? `${url}\n${rpc.method}\n${rpc.params}` : null
    const memoable = !!key && !!scope?.memo && ttl > 0 && MEMO_METHODS.has(rpc!.method)
    if (memoable) {
      const hit = memo.get(key!)
      if (hit && hit.expires > now()) return respond(hit.stored, rpc!.id, true)
      if (hit) memo.delete(key!)
    }
    const share = !!key && dedupe && !NO_DEDUPE.has(rpc!.method) && !init.signal
    let pending = share ? inflight.get(key!) : undefined
    const joined = !!pending
    if (!pending) {
      pending = attempt(input, init, rpc?.id)
      if (share) {
        inflight.set(key!, pending)
        pending.then(() => inflight.delete(key!), () => inflight.delete(key!))
      }
    }
    let stored: Stored
    try {
      stored = await pending
    } catch (error) {
      if (isTransientRpcError(error)) markTransient(scope)
      throw error
    }
    if (memoable && stored.status === 200 && stored.text.length <= maxEntryBytes && okResult(stored.text)) {
      memo.delete(key!)
      memo.set(key!, { expires: now() + ttl, stored })
      if (memo.size > maxEntries) {
        const time = now()
        for (const [k, v] of memo) if (v.expires <= time) memo.delete(k)
        while (memo.size > maxEntries) memo.delete(memo.keys().next().value!)
      }
    }
    return respond(stored, rpc?.id, joined)
  }) as ResilientFetch
  Object.defineProperties(resilient, {
    clearMemo: { value: () => memo.clear() },
    memoSize: { get: () => memo.size },
    inflightSize: { get: () => inflight.size },
  })
  return resilient
}

/** At most `max` tasks run at once; waiters are handed a slot in FIFO order. */
export function concurrencyLimit(max: number) {
  let active = 0
  const queue: (() => void)[] = []
  const run = async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < max) active++
    else await new Promise<void>(resolve => queue.push(resolve))
    try { return await task() } finally {
      const next = queue.shift()
      if (next) next(); else active--
    }
  }
  return Object.assign(run, { get active() { return active }, get waiting() { return queue.length } })
}

/** A pause that starts on a rate-limit signal and blocks new work until it ends. */
export function cooldown(durationMs: number, now: () => number = Date.now) {
  let until = 0
  return {
    trip() { until = Math.max(until, now() + durationMs) },
    active() { return now() < until },
    remainingMs() { return Math.max(0, until - now()) },
  }
}

export class RpcCooldownError extends Error {
  constructor(remainingMs: number) {
    super(`Solana RPC is cooling down after a rate limit (${Math.ceil(remainingMs / 1000)} s left)`)
    this.name = 'RpcCooldownError'
  }
}
/** Background (non-quote) RPC traffic: the same retry wrapper, at most
 * `concurrency` requests in flight, and a `cooldownMs` pause after any HTTP
 * 429 during which no new request starts and no retry is attempted. */
export function createBackgroundRpc(options: { concurrency: number; cooldownMs: number;
  fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>; random?: () => number }) {
  const now = options.now ?? Date.now
  const pause = cooldown(options.cooldownMs, now)
  const slots = concurrencyLimit(options.concurrency)
  const resilient = createResilientFetch({ fetch: options.fetch, dedupe: false, now, sleep: options.sleep,
    random: options.random, onStatus: status => { if (status === 429) pause.trip() },
    canRetry: () => !pause.active() })
  return {
    coolingDown: () => pause.active(),
    cooldownRemainingMs: () => pause.remainingMs(),
    get inFlight() { return slots.active },
    call(url: string, init: RequestInit): Promise<Response> {
      return slots(async () => {
        if (pause.active()) throw new RpcCooldownError(pause.remainingMs())
        return resilient(url, init)
      })
    },
  }
}
