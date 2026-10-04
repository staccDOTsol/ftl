// One websocket for the whole app. Screens subscribe to slices of it through
// useSyncExternalStore; events land newest first in a bounded ring.

import { useSyncExternalStore } from 'react'
import { WS_URL } from './api'
import type { ClientMsg, FlowEvent, ServerMsg, Status, TokenSummary } from './types'

type Listener = () => void
const MAX = 400

class Live {
  events: FlowEvent[] = []
  status: Status | null = null
  connected = false
  tokens = new Map<string, TokenSummary>()
  tokenTick = 0
  clockSkew = 0
  private ws: WebSocket | null = null
  private listeners = new Set<Listener>()
  private filter: ClientMsg | null = null
  private retry = 0
  private paused = false
  private held: FlowEvent[] = []
  private eventHooks = new Set<(e: FlowEvent) => void>()

  start() {
    if (this.ws) return
    const ws = new WebSocket(WS_URL)
    this.ws = ws
    ws.onopen = () => { this.connected = true; this.retry = 0; if (this.filter) ws.send(JSON.stringify(this.filter)); this.emit() }
    ws.onclose = () => {
      this.connected = false
      this.ws = null
      this.emit()
      setTimeout(() => this.start(), Math.min(15_000, 500 * 2 ** this.retry++))
    }
    ws.onerror = () => { try { ws.close() } catch {} }
    ws.onmessage = (m) => {
      let msg: ServerMsg
      try { msg = JSON.parse(String(m.data)) } catch { return }
      if (msg.t === 'hello') this.clockSkew = Date.now() - msg.serverTs
      else if (msg.t === 'event') {
        for (const h of this.eventHooks) h(msg.e)
        if (this.paused) { this.held.unshift(msg.e); this.held.length = Math.min(this.held.length, MAX) }
        else { this.events = [msg.e, ...this.events].slice(0, MAX) }
        this.emit()
      } else if (msg.t === 'upgrade') {
        const i = this.events.findIndex(e => e.id === msg.id)
        if (i >= 0) {
          const e = this.events[i]
          const next = { ...e, stage: msg.stage, confirmedTs: msg.confirmedTs ?? e.confirmedTs, amounts: msg.amounts ?? e.amounts, quoteUi: msg.quoteUi !== undefined ? msg.quoteUi : e.quoteUi, flags: msg.flags ?? e.flags }
          this.events = [...this.events.slice(0, i), next, ...this.events.slice(i + 1)]
          this.emit()
        }
      } else if (msg.t === 'status') { this.status = msg.s; this.emit() }
      else if (msg.t === 'token') { this.tokens.set(`${msg.s.chain}:${msg.s.address}`, msg.s); this.tokenTick++; this.emit() }
    }
  }

  setFilter(f: ClientMsg) {
    this.filter = f
    this.events = []
    this.held = []
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(f))
    this.emit()
  }
  seed(events: FlowEvent[]) {
    const have = new Set(this.events.map(e => e.id))
    this.events = [...this.events, ...events.filter(e => !have.has(e.id))].sort((a, b) => b.ts - a.ts).slice(0, MAX)
    this.emit()
  }
  setPaused(p: boolean) {
    this.paused = p
    if (!p && this.held.length) { this.events = [...this.held, ...this.events].slice(0, MAX); this.held = [] }
    this.emit()
  }
  get isPaused() { return this.paused }
  get heldCount() { return this.held.length }
  onEvent(h: (e: FlowEvent) => void) { this.eventHooks.add(h); return () => { this.eventHooks.delete(h) } }

  subscribe = (l: Listener) => { this.listeners.add(l); return () => { this.listeners.delete(l) } }
  private version = 0
  private emit() { this.version++; for (const l of this.listeners) l() }
  getVersion = () => this.version
}

export const live = new Live()

export function useLive() {
  useSyncExternalStore(live.subscribe, live.getVersion, live.getVersion)
  return live
}
