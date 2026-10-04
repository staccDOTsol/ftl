// One clock for every "3s ago" on screen: only the time labels re-render each
// second, never the rows around them.
import { useSyncExternalStore } from 'react'

let now = Date.now()
const listeners = new Set<() => void>()
setInterval(() => { now = Date.now(); for (const l of listeners) l() }, 1000)
const sub = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const get = () => now

export function useClock() { return useSyncExternalStore(sub, get, get) }
