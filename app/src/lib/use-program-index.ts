import { useCallback, useEffect, useState } from 'react'
import { get } from './api'
import { live } from './live'
import { mergeProgramUpdate, programQuery, type ProgramMode } from './program-model'
import type { ProgramDetail, ProgramList, ProgramUpdate } from '../../../shared/programs'

export function useProgramIndex(mode: ProgramMode, search: string, hours: number) {
  const [state, setState] = useState<{ key: string; data: ProgramList | null; error: string | null }>({ key: '', data: null, error: null })
  const [refreshKey, setRefreshKey] = useState(0)
  const [lastPushTs, setLastPushTs] = useState<number | null>(null)
  const key = `${mode}:${search}:${hours}:${refreshKey}`
  const refresh = useCallback(() => setRefreshKey(key => key + 1), [])

  useEffect(() => {
    let active = true, reading = false
    let awaiting: ProgramUpdate[] = []
    let timer: ReturnType<typeof setTimeout> | null = null
    let lastSequence: number | null = null
    const read = async () => {
      if (reading || !active) return
      reading = true
      try {
        const result = await get<ProgramList>('/api/programs', { ...programQuery(mode), search, hours, limit: 150 })
        if (!active) return
        const receivedUpdates = awaiting
        awaiting = []
        setState(previous => {
          // Socket pushes arriving while HTTP is in flight have precedence.
          let next = result
          for (const update of receivedUpdates) next = mergeProgramUpdate(next, update, mode, search, hours)
          if (previous.key === key && previous.data && previous.data.sequence > next.sequence) return previous
          return { key, data: next, error: null }
        })
        lastSequence = Math.max(lastSequence ?? 0, result.sequence)
      } catch (e) { if (active) setState(previous => ({ key, data: previous.key === key ? previous.data : null, error: e instanceof Error ? e.message : 'Program discovery is temporarily unavailable' })) }
      finally { reading = false }
    }
    const schedule = () => {
      if (timer) return
      timer = setTimeout(() => { timer = null; void read() }, 500)
    }
    const unsubscribe = live.onPrograms(update => {
      if (!active) return
      setLastPushTs(update.ts)
      if (reading || lastSequence === null) awaiting.push(update)
      setState(previous => previous.key === key && previous.data ? { ...previous, data: mergeProgramUpdate(previous.data, update, mode, search, hours) } : previous)
      if (update.reset || (lastSequence !== null && update.sequence > lastSequence + 1)) schedule()
      lastSequence = Math.max(lastSequence ?? 0, update.sequence)
    })
    void read()
    const fallback = setInterval(() => { if (!live.connected) void read() }, 5000)
    const reconcile = setInterval(() => { void read() }, 60_000)
    const foreground = () => { if (typeof document === 'undefined' || document.visibilityState === 'visible') schedule() }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', foreground)
    return () => { active = false; unsubscribe(); clearInterval(fallback); clearInterval(reconcile); if (timer) clearTimeout(timer); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', foreground) }
  }, [mode, search, hours, key])
  const current = state.key === key ? state : { data: null, error: null }
  return { ...current, loading: !current.data && !current.error, lastPushTs, refresh }
}

export function useProgramDetail(address: string | null) {
  const [state, setState] = useState<{ address: string | null; detail: ProgramDetail | null; error: string | null }>({ address: null, detail: null, error: null })
  useEffect(() => {
    if (!address) return
    let active = true, reading = false, lastRead = 0, timer: ReturnType<typeof setTimeout> | null = null
    let lastPhase: string | null = null, lastHash: string | null = null
    const read = async () => {
      if (reading || !active) return
      reading = true; lastRead = Date.now()
      try { const result = await get<ProgramDetail>(`/api/programs/solana/${address}`); if (active) { setState({ address, detail: result, error: null }); lastPhase = result.program.state; lastHash = result.program.idlHash } }
      catch (e) { if (active) setState(previous => ({ address, detail: previous.address === address ? previous.detail : null, error: e instanceof Error ? e.message : 'Could not load this program' })) }
      finally { reading = false }
    }
    const unsubscribe = live.onPrograms(update => {
      const record = update.records.find(program => program.address === address)
      if (!record) return
      const phaseChanged = record.state !== lastPhase || record.idlHash !== lastHash
      lastPhase = record.state; lastHash = record.idlHash
      setState(previous => previous.address === address && previous.detail ? { ...previous, detail: { ...previous.detail, program: record,
        activity: [...update.activity.filter(event => event.address === address), ...previous.detail.activity].filter((event, i, all) => all.findIndex(other => other.id === event.id) === i).slice(0, 60) } } : previous)
      if (!timer) timer = setTimeout(() => { timer = null; void read() }, phaseChanged ? 0 : Math.max(0, 2000 - (Date.now() - lastRead)))
    })
    void read()
    const fallback = setInterval(() => { if (!live.connected) void read() }, 5000)
    return () => { active = false; unsubscribe(); clearInterval(fallback); if (timer) clearTimeout(timer) }
  }, [address])
  return state.address === address ? state : { detail: null, error: null }
}
