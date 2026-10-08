import { useCallback, useEffect, useRef, useState } from 'react'
import { get } from './api'
import { live } from './live'

type Entry<T> = { data: T; at: number }
const cache = new Map<string, Entry<unknown>>()
const pending = new Map<string, Promise<unknown>>()

// Bounded, deduplicated read-through cache. Route revisits render immediately.
// Stream invalidations are coalesced; reconnects and foregrounding fill gaps.
export function useLiveResource<T>(path: string | null, interval = 30_000, onMoves = false) {
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string | null; at: number; loading: boolean }>(() => {
    const saved = path ? cache.get(path) as Entry<T> | undefined : undefined
    return { key: path, data: saved?.data ?? null, at: saved?.at ?? 0, error: null, loading: !!path && !saved }
  })
  const generation = useRef(0)
  const mounted = useRef(false)
  const lastRead = useRef(0)
  const invalidate = useCallback(() => { generation.current++ }, [])
  const refresh = useCallback(async () => {
    if (!path) return
    const run = ++generation.current
    if (!mounted.current) return
    setState(previous => ({ key: path, data: previous.key === path ? previous.data : null, at: previous.key === path ? previous.at : 0, error: null, loading: true }))
    lastRead.current = Date.now()
    try {
      let request = pending.get(path) as Promise<T> | undefined
      if (!request) {
        request = get<T>(path)
        pending.set(path, request)
        void request.finally(() => pending.delete(path)).catch(() => {})
      }
      const data = await request
      const at = Date.now()
      cache.set(path, { data, at })
      if (cache.size > 40) cache.delete(cache.keys().next().value!)
      if (mounted.current && generation.current === run) setState({ key: path, data, at, error: null, loading: false })
    } catch (error) {
      if (mounted.current && generation.current === run) setState(previous => ({ ...previous, key: path, error: error instanceof Error ? error.message : 'Could not refresh. Try again.', loading: false }))
    }
  }, [path])

  useEffect(() => {
    if (!path) return
    mounted.current = true
    const saved = cache.get(path) as Entry<T> | undefined
    setState({ key: path, data: saved?.data ?? null, at: saved?.at ?? 0, error: null, loading: !saved })
    lastRead.current = saved?.at ?? 0
    if (!saved || Date.now() - saved.at > 10_000) void refresh()
    const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible'
    const poll = setInterval(() => { if (visible()) void refresh() }, interval)
    const foreground = () => { if (visible() && Date.now() - lastRead.current > 10_000) void refresh() }
    let wasConnected = live.connected
    const unsubscribe = live.subscribe(() => {
      const restored = !wasConnected && live.connected
      wasConnected = live.connected
      if (restored) foreground()
    })
    const offEvent = onMoves ? live.onEvent(() => {
      if (visible() && Date.now() - lastRead.current > 10_000) void refresh()
    }) : undefined
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', foreground)
    return () => {
      mounted.current = false
      invalidate()
      clearInterval(poll)
      unsubscribe()
      offEvent?.()
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', foreground)
    }
  }, [path, interval, onMoves, refresh, invalidate])

  const current = state.key === path ? state : { data: null, at: 0, error: null, loading: !!path }
  return { ...current, refresh }
}
