// Push alerts through Expo's push service when a followed wallet moves
// liquidity or a followed token gets a new pool or a book flag.

import { db } from './db.ts'
import { bus } from './hub.ts'
import { followersOf } from './social.ts'
import type { FlowEvent } from '../../shared/types.ts'

const KIND: Record<string, string> = { pool_init: 'opened a pool', liq_add: 'added liquidity', liq_remove: 'pulled liquidity', launch: 'launched', graduate: 'graduated' }
const lastSent = new Map<string, number>()    // `${user}|${target}` -> ts, at most one alert per target per minute

function short(a: string) { return a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a }

async function send(messages: any[]) {
  for (let i = 0; i < messages.length; i += 100) {
    try {
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(messages.slice(i, i + 100)), signal: AbortSignal.timeout(10_000),
      })
    } catch (e) { console.error('[push]', String(e)) }
  }
}

export function startPush() {
  bus.on('event', (e: FlowEvent) => {
    if (e.kind === 'launch') return
    const sym = e.tokenMeta?.symbol ? `$${e.tokenMeta.symbol}` : e.token ? short(e.token) : 'a token'
    const targets: { user: string; key: string; title: string }[] = []
    for (const user of followersOf('wallet', e.chain, e.wallet))
      targets.push({ user, key: `w:${e.wallet}`, title: `${short(e.wallet)} ${KIND[e.kind] ?? e.kind} on ${sym}` })
    const loud = e.kind === 'pool_init' || e.kind === 'graduate' || e.flags.some(f => f !== 'first_pool')
    if (e.token && loud)
      for (const user of followersOf('token', e.chain, e.token))
        targets.push({ user, key: `t:${e.token}`, title: `${sym}: ${e.kind === 'pool_init' ? 'new pool' : KIND[e.kind] ?? e.kind}${e.flags.length ? ' · ' + e.flags.join(', ') : ''}` })
    if (!targets.length) return
    const now = Date.now()
    const messages: any[] = []
    for (const t of targets) {
      const k = `${t.user}|${t.key}`
      if (now - (lastSent.get(k) ?? 0) < 60_000) continue
      lastSent.set(k, now)
      for (const r of db.prepare('SELECT token FROM push_tokens WHERE user = ?').all(t.user) as any[])
        messages.push({ to: r.token, title: t.title, body: `${e.venue} · ${e.chain}${e.quoteUi ? ` · ${e.quoteUi.toFixed(e.quoteUi < 10 ? 3 : 0)} quote` : ''}`, data: { url: e.token ? `/token/${e.chain}/${e.token}` : `/wallet/${e.chain}/${e.wallet}` }, sound: 'default' })
    }
    if (messages.length) void send(messages)
  })
}
