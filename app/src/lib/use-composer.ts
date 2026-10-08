// React state for Composer service calls: cancellable requests with elapsed
// time, and cached program interfaces (published IDL, learned IDL, recipes).
import { useCallback, useEffect, useRef, useState } from 'react'
import { composerRequest, failureOf, isAddress, NO_PUBLISHED_IDL, type AnchorIdl, type ComposerFailure, type LearnedIdl, type Requirements } from './composer'

export interface CallState<T> { status: 'idle' | 'running' | 'done' | 'error'; data: T | null; error: ComposerFailure | null; startedAt: number | null; finishedAt: number | null; cancelled: boolean; request: unknown }
const idle = <T,>(): CallState<T> => ({ status: 'idle', data: null, error: null, startedAt: null, finishedAt: null, cancelled: false, request: null })

// One in-flight request per caller. Starting another aborts the previous one.
export function useComposerCall<T>() {
  const [state, setState] = useState<CallState<T>>(idle)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const run = useCallback(async (fn: (signal: AbortSignal) => Promise<T>, request?: unknown) => {
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    const startedAt = Date.now()
    setState({ ...idle<T>(), status: 'running', startedAt, request: request ?? null })
    try {
      const data = await fn(current.signal)
      if (controller.current === current) setState({ ...idle<T>(), status: 'done', data, startedAt, finishedAt: Date.now(), request: request ?? null })
      return data
    } catch (error) {
      if (controller.current !== current) return null
      if (current.signal.aborted) setState({ ...idle<T>(), cancelled: true, request: request ?? null })
      else setState({ ...idle<T>(), status: 'error', error: failureOf(error), startedAt, finishedAt: Date.now(), request: request ?? null })
      return null
    } finally { if (controller.current === current) controller.current = null }
  }, [])
  const cancel = useCallback(() => controller.current?.abort(), [])
  const reset = useCallback(() => { controller.current?.abort(); setState(idle) }, [])
  const fail = useCallback((error: unknown) => setState({ ...idle<T>(), status: 'error', error: failureOf(error), startedAt: Date.now(), finishedAt: Date.now() }), [])
  return { ...state, run, cancel, reset, fail }
}

// Whole seconds since `since`, ticking while `running`. A finished call passes
// its own `until` so the figure stops where the request ended.
export function useElapsed(since: number | null, running: boolean, until?: number | null) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const tick = () => setNow(Date.now())
    const first = setTimeout(tick, 0)
    const timer = setInterval(tick, 500)
    return () => { clearTimeout(first); clearInterval(timer) }
  }, [running])
  const end = running ? now : until ?? now
  return since ? Math.max(0, Math.floor((end - since) / 1000)) : 0
}

// Interfaces are immutable for a session; cache settled results by program.
const published = new Map<string, AnchorIdl>()
const missing = new Map<string, string>()
const learned = new Map<string, LearnedIdl>()
const requirements = new Map<string, Requirements>()
const recipes = new Map<string, RecipesResponse>()

export type ProgramInterface =
  | { kind: 'published'; programId: string; idl: AnchorIdl }
  | { kind: 'learned'; programId: string; learned: LearnedIdl; publishedError: string | null }
  | { kind: 'native'; programId: 'native' }

export interface InterfaceState { status: 'idle' | 'loading-published' | 'loading-learned' | 'ready' | 'no-idl' | 'error'; iface: ProgramInterface | null; error: ComposerFailure | null; publishedError: string | null; startedAt: number | null }

// `preference`: auto tries the published IDL, then the learned one; `learned`
// skips straight to /learn; `published` never learns. `learnOnMissing` false
// stops after a missing published IDL until `learn()` is called. Settled
// answers come from the session cache during render; only fetches use effects.
type Preference = 'auto' | 'published' | 'learned'
function settledInterface(program: string, preference: Preference, allowLearn: boolean): InterfaceState | null {
  if (program === 'native') return { status: 'ready', iface: { kind: 'native', programId: 'native' }, error: null, publishedError: null, startedAt: null }
  if (!isAddress(program)) return { status: 'idle', iface: null, error: null, publishedError: null, startedAt: null }
  const idl = preference !== 'learned' ? published.get(program) : undefined
  if (idl) return { status: 'ready', iface: { kind: 'published', programId: program, idl }, error: null, publishedError: null, startedAt: null }
  const publishedError = missing.get(program) ?? null
  if (preference === 'learned' || publishedError) {
    const cached = learned.get(program)
    if (cached) return { status: 'ready', iface: { kind: 'learned', programId: program, learned: cached, publishedError }, error: null, publishedError, startedAt: null }
    if (preference === 'published' || (publishedError && !allowLearn)) return { status: 'no-idl', iface: null, error: null, publishedError, startedAt: null }
  }
  return null
}

export function useProgramInterface(programId: string, preference: Preference, learnOnMissing = true) {
  const program = programId.trim()
  const [state, setState] = useState<InterfaceState & { key: string }>({ key: '', status: 'idle', iface: null, error: null, publishedError: null, startedAt: null })
  const [attempt, setAttempt] = useState(0)
  const [forceLearn, setForceLearn] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const allowLearn = learnOnMissing || forceLearn
  const key = `${program}|${preference}|${allowLearn}|${attempt}`
  const settled = settledInterface(program, preference, allowLearn)
  const needsFetch = !settled
  useEffect(() => {
    if (!needsFetch) return
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    let alive = true
    const set = (next: Partial<InterfaceState>) => { if (alive) setState(previous => ({ ...(previous.key === key ? previous : { status: 'idle', iface: null, error: null, publishedError: null, startedAt: null }), ...next, key })) }
    const learn = async (publishedError: string | null) => {
      set({ status: 'loading-learned', publishedError, startedAt: Date.now(), error: null })
      try {
        const result = await composerRequest<LearnedIdl>(`/learn/${program}`, undefined, current.signal)
        learned.set(program, result)
        set({ status: 'ready', iface: { kind: 'learned', programId: program, learned: result, publishedError }, startedAt: null })
      } catch (error) {
        if (current.signal.aborted) set({ status: 'no-idl', publishedError, startedAt: null })
        else set({ status: 'error', error: failureOf(error), publishedError, startedAt: null })
      }
    }
    const read = preference === 'learned' || missing.has(program)
      ? Promise.resolve().then(() => learn(missing.get(program) ?? null))
      : composerRequest<AnchorIdl>(`/idl/${program}`, undefined, current.signal).then(idl => {
        published.set(program, idl)
        set({ status: 'ready', iface: { kind: 'published', programId: program, idl }, startedAt: null })
      }, error => {
        if (current.signal.aborted) return
        const failure = failureOf(error)
        if (!NO_PUBLISHED_IDL.test(failure.message)) return set({ status: 'error', error: failure, startedAt: null })
        missing.set(program, failure.message)
        if (preference === 'published' || !allowLearn) return set({ status: 'no-idl', publishedError: failure.message, startedAt: null })
        return learn(failure.message)
      })
    void read
    return () => { alive = false; current.abort() }
  }, [key, needsFetch, program, preference, allowLearn])
  const cancel = useCallback(() => controller.current?.abort(), [])
  const retry = () => setAttempt(value => value + 1)
  const learn = () => setForceLearn(true)
  const current: InterfaceState = settled ?? (state.key === key ? state : { status: 'loading-published', iface: null, error: null, publishedError: null, startedAt: null })
  return { ...current, cancel, retry, learn }
}

export function useRequirements(programId: string, instruction: string, enabled: boolean) {
  const key = `${programId.trim()}/${instruction.trim()}`
  const [state, setState] = useState<{ key: string; data: Requirements | null; error: ComposerFailure | null }>({ key: '', data: null, error: null })
  const cached = requirements.get(key) ?? null
  const fetchNeeded = enabled && isAddress(programId) && !!instruction.trim() && !cached
  useEffect(() => {
    if (!fetchNeeded) return
    const controller = new AbortController()
    composerRequest<Requirements>(`/idl/${programId.trim()}/requirements/${encodeURIComponent(instruction.trim())}`, undefined, controller.signal)
      .then(data => { requirements.set(key, data); setState({ key, data, error: null }) })
      .catch(error => { if (!controller.signal.aborted) setState({ key, data: null, error: failureOf(error) }) })
    return () => controller.abort()
  }, [key, programId, instruction, fetchNeeded])
  if (cached) return { key, data: cached, error: null }
  return state.key === key ? state : { key, data: null, error: null }
}

export interface Recipe { account?: string; needs_accounts: string[]; needs_args: string[]; program?: string; seeds: string[]; seen_on?: string[] }
export interface RecipesResponse { programId?: string; name?: string; derivable: Record<string, Recipe>; queryable?: { account: string; filterableFields: { offset: number; path: string; type: string }[] }[]; gpaWarning?: string | null; hint?: string }
export function useRecipes(programId: string, enabled = true) {
  const program = programId.trim()
  const [state, setState] = useState<{ key: string; data: RecipesResponse | null; error: ComposerFailure | null }>({ key: '', data: null, error: null })
  const cached = recipes.get(program) ?? null
  const fetchNeeded = enabled && isAddress(program) && !cached
  useEffect(() => {
    if (!fetchNeeded) return
    const controller = new AbortController()
    composerRequest<RecipesResponse>(`/recipes/${program}`, undefined, controller.signal)
      .then(data => { recipes.set(program, data); setState({ key: program, data, error: null }) })
      .catch(error => { if (!controller.signal.aborted) setState({ key: program, data: null, error: failureOf(error) }) })
    return () => controller.abort()
  }, [program, fetchNeeded])
  if (cached) return { key: program, data: cached, error: null, loading: false }
  if (state.key === program) return { ...state, loading: false }
  return { key: program, data: null, error: null, loading: fetchNeeded }
}

export function useComposerHealth() {
  const [health, setHealth] = useState<{ ok: boolean; version?: string; note?: string } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    composerRequest<{ ok?: boolean; version?: string; note?: string }>('/health', undefined, controller.signal)
      .then(data => setHealth({ ok: data.ok === true, version: data.version, note: data.note }))
      .catch(() => { if (!controller.signal.aborted) setHealth({ ok: false }) })
    return () => controller.abort()
  }, [])
  return health
}
