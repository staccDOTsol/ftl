// One websocket for the whole app. Incoming events are batched and flushed to
// the UI every 200 ms so a burst of 50 events is one render, not 50.

import { useSyncExternalStore } from 'react'
import { WS_URL } from './api'
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

  constructor() {
    setInterval(() => this.tick(), FLUSH_MS)
  }

  start() {
    if (this.ws) return
    const ws = new WebSocket(WS_URL)
    this.ws = ws
    ws.onopen = () => { this.connected = true; this.retry = 0; if (this.filter) ws.send(JSON.stringify(this.filter)); this.dirty = true }
    ws.onclose = () => {
      this.connected = false
      this.ws = null
      this.dirty = true
      setTimeout(() => this.start(), Math.min(15_000, 500 * 2 ** this.retry++))
    }
    ws.onerror = () => { try { ws.close() } catch {} }
    ws.onmessage = (m) => {
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
      } else if (msg.t === 'status') {
        this.status = msg.s
        for (const c of ['solana', 'robinhood'] as Chain[]) {
          const wins = msg.s.lanes.filter(x => x.chain === c).reduce((a, x) => a + x.firstSeenWins, 0)
          const prev = this.lastWins[c]
          this.lastWins[c] = wins
          if (prev !== null) this.flow[c] = [...this.flow[c].slice(1), Math.max(0, wins - prev)]
        }
        this.dirty = true
      }
      else if (msg.t === 'token') { this.tokens.set(`${msg.s.chain}:${msg.s.address}`, msg.s); this.tokenTick++; this.dirty = true }
    }
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
