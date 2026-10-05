// One websocket for the whole app. Incoming events are batched and flushed to
// the UI every 200 ms so a burst of 50 events is one render, not 50.

import { useSyncExternalStore } from 'react'
import { WS_URL, get } from './api'
import type { Chain, ClientMsg, FlowEvent, ServerMsg, Status, TokenMeta, TokenSummary } from './types'

type Listener = () => void
const MAX = 300
const FLUSH_MS = 200
const BINS = 30          // pulse history: 30 bins of 2 s = one minute
const BIN_MS = 2000

export type LiveEvent = FlowEvent & { fresh?: number }

class Live {
  events: LiveEvent[] = []
  status: Status | null = null
  connected = false
  tokens = new Map<string, TokenSummary>()
  tokenTick = 0
  held: LiveEvent[] = []
  hold = false
  // per-chain arrivals, for the pulse in the header
  rate: Record<Chain, number[]> = { solana: new Array(BINS).fill(0), robinhood: new Array(BINS).fill(0) }
  // whole-chain throughput from the server's lane counters: 12 bins of one status tick (5 s)
  flow: Record<Chain, number[]> = { solana: new Array(12).fill(0), robinhood: new Array(12).fill(0) }
  private lastWins: Record<Chain, number | null> = { solana: null, robinhood: null }
  // per-token arrivals over the last minute, for the heat rail sparklines
  tokenRate = new Map<string, number[]>()
  private binAt = Math.floor(Date.now() / BIN_MS)
  private meta = new Map<string, TokenMeta>()
  private ws: WebSocket | null = null
  private listeners = new Set<Listener>()
  private filter: ClientMsg | null = null
  private retry = 0
  private inbox: LiveEvent[] = []
  private dirty = false
  private eventHooks = new Set<(e: FlowEvent) => void>()

  private lastMsg = 0
  private downSince = Date.now()
  private polling = false
  private pollAfter = 0

  constructor() {
    setInterval(() => this.tick(), FLUSH_MS)
    // watchdog: the server sends status every 5 s, so 15 s of silence is a dead socket
    setInterval(() => {
      if (this.ws && this.connected && Date.now() - this.lastMsg > 15_000) { try { this.ws.close() } catch {} }
      if (!this.connected && Date.now() - this.downSince > 5000) void this.poll()
    }, 2000)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && !this.connected) { this.retry = 0; this.kick() }
      })
    }
  }

  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private kick() {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null }
    if (this.ws) { try { this.ws.close() } catch {} return }
    this.start()
  }

  // socket down: keep the page alive over HTTP until it comes back
  private async poll() {
    if (this.polling) return
    this.polling = true
    try {
      const f = this.filter && this.filter.t === 'filter' ? this.filter : null
      const after = this.pollAfter || (this.events[0]?.ts ?? Date.now() - 60_000)
      const evs = await get<FlowEvent[]>('/api/feed', { after, limit: 100, chain: f?.chains?.length === 1 ? f.chains[0] : undefined, kinds: f?.kinds?.join(','), flagged: f?.flaggedOnly ? 1 : undefined })
      if (evs.length) {
        this.pollAfter = evs[0].ts
        const have = new Set(this.events.map(e => e.id))
        for (const e of evs.reverse()) if (!have.has(e.id)) { this.bump(e.chain, e.kind === 'launch' ? null : e.token); this.inbox.push({ ...e, fresh: Date.now() }) }
      }
      if (!this.status || Date.now() - this.lastStatusPoll > 5000) { this.lastStatusPoll = Date.now(); this.onStatus(await get<Status>('/api/status')) }
    } catch {} finally { this.polling = false }
  }
  private lastStatusPoll = 0
  // live either over the socket or, while it reconnects, over HTTP polling
  get healthy() { return this.connected || (!!this.status && Date.now() - this.lastStatusPoll < 12_000) }

  start() {
    if (this.ws) return
    const ws = new WebSocket(WS_URL)
    this.ws = ws
    ws.onopen = () => { this.connected = true; this.retry = 0; this.lastMsg = Date.now(); this.pollAfter = 0; if (this.filter) ws.send(JSON.stringify(this.filter)); this.dirty = true }
    ws.onclose = () => {
      if (this.connected) this.downSince = Date.now()
      this.connected = false
      this.ws = null
      this.dirty = true
      this.retryTimer = setTimeout(() => { this.retryTimer = null; this.start() }, Math.min(4000, 300 * 2 ** this.retry++))
    }
    ws.onerror = () => { try { ws.close() } catch {} }
    ws.onmessage = (m) => {
      this.lastMsg = Date.now()
      let msg: ServerMsg
      try { msg = JSON.parse(String(m.data)) } catch { return }
      if (msg.t === 'event') {
        const e: LiveEvent = { ...msg.e, fresh: Date.now() }
        this.applyMeta(e)
        this.bump(e.chain, e.kind === 'launch' ? null : e.token)
        for (const h of this.eventHooks) h(e)
        this.inbox.push(e)
      } else if (msg.t === 'upgrade') {
        const patch = (arr: LiveEvent[]) => {
          const i = arr.findIndex(e => e.id === msg.id)
          if (i < 0) return false
          const e = arr[i]
          arr[i] = { ...e, stage: msg.stage, confirmedTs: msg.confirmedTs ?? e.confirmedTs, amounts: msg.amounts ?? e.amounts, quoteUi: msg.quoteUi !== undefined ? msg.quoteUi : e.quoteUi, flags: msg.flags ?? e.flags }
          return true
        }
        if (patch(this.inbox) || patch(this.held)) return
        const copy = [...this.events]
        if (patch(copy)) { this.events = copy; this.dirty = true }
      } else if (msg.t === 'meta') {
        const key = `${msg.chain}:${msg.address}`
        this.meta.set(key, { ...this.meta.get(key), ...msg.m })
        if (this.meta.size > 5000) this.meta.delete(this.meta.keys().next().value!)
        let hit = false
        const next = this.events.map(e => (e.chain === msg.chain && e.token === msg.address ? (hit = true, { ...e, tokenMeta: { ...e.tokenMeta, ...msg.m } }) : e))
        if (hit) { this.events = next; this.dirty = true }
      } else if (msg.t === 'status') this.onStatus(msg.s)
      else if (msg.t === 'token') { this.tokens.set(`${msg.s.chain}:${msg.s.address}`, msg.s); this.tokenTick++; this.dirty = true }
    }
  }

  private onStatus(st: Status) {
    this.status = st
    for (const c of ['solana', 'robinhood'] as Chain[]) {
      const wins = st.lanes.filter(x => x.chain === c).reduce((a, x) => a + x.firstSeenWins, 0)
      const prev = this.lastWins[c]
      this.lastWins[c] = wins
      if (prev !== null) this.flow[c] = [...this.flow[c].slice(1), Math.max(0, wins - prev)]
    }
    this.dirty = true
  }

  private applyMeta(e: LiveEvent) {
    if (!e.token) return
    const m = this.meta.get(`${e.chain}:${e.token}`)
    if (m) e.tokenMeta = { ...e.tokenMeta, ...m }
  }

  private bump(chain: Chain, token?: string | null) {
    this.roll()
    this.rate[chain][BINS - 1]++
    if (token) {
      const key = `${chain}:${token}`
      let bins = this.tokenRate.get(key)
      if (!bins) { bins = new Array(BINS).fill(0); this.tokenRate.set(key, bins); if (this.tokenRate.size > 3000) this.tokenRate.delete(this.tokenRate.keys().next().value!) }
      bins[BINS - 1]++
    }
  }
  private roll() {
    const b = Math.floor(Date.now() / BIN_MS)
    const shift = Math.min(BINS, b - this.binAt)
    if (shift > 0) {
      for (const c of ['solana', 'robinhood'] as Chain[]) this.rate[c] = [...this.rate[c].slice(shift), ...new Array(shift).fill(0)]
      for (const [k, bins] of this.tokenRate) {
        const next = [...bins.slice(shift), ...new Array(shift).fill(0)]
        if (next.every(x => x === 0)) this.tokenRate.delete(k); else this.tokenRate.set(k, next)
      }
      this.binAt = b
      this.dirty = true
    }
  }

  private tick() {
    this.roll()
    if (this.inbox.length) {
      const batch = this.inbox.reverse()
      this.inbox = []
      if (this.hold) this.held = [...batch, ...this.held].slice(0, MAX)
      else this.events = [...batch, ...this.events].slice(0, MAX)
      this.dirty = true
    }
    if (this.dirty) { this.dirty = false; this.version++; for (const l of this.listeners) l() }
  }

  perMinute(chain: Chain) { return this.flow[chain].reduce((a, b) => a + b, 0) }

  setFilter(f: ClientMsg) {
    this.filter = f
    this.events = []
    this.held = []
    this.inbox = []
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(f))
    this.dirty = true
  }
  seed(events: FlowEvent[]) {
    const have = new Set(this.events.map(e => e.id))
    this.events = [...this.events, ...events.filter(e => !have.has(e.id))].sort((a, b) => b.ts - a.ts).slice(0, MAX)
    this.dirty = true
  }
  setHold(h: boolean) {
    if (h === this.hold) return
    this.hold = h
    if (!h && this.held.length) { this.events = [...this.held, ...this.events].slice(0, MAX); this.held = [] }
    this.dirty = true
  }
  onEvent(h: (e: FlowEvent) => void) { this.eventHooks.add(h); return () => { this.eventHooks.delete(h) } }

  subscribe = (l: Listener) => { this.listeners.add(l); return () => { this.listeners.delete(l) } }
  private version = 0
  getVersion = () => this.version
}

export const live = new Live()
;(globalThis as any).__ftlLive = live

export function useLive() {
  useSyncExternalStore(live.subscribe, live.getVersion, live.getVersion)
  return live
}
