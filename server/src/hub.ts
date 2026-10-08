// The hub: every lane hands it RawEvents; it dedupes across lanes, keeps the
// young-liquidity rule, computes the book's flags, persists and fans out.

import { EventEmitter } from 'node:events'
import { db, tx } from './db.ts'
import { config } from './config.ts'
import type { Amount, Chain, Flag, FlowEvent, Kind, Lane, LaneStatus, PoolSummary, Stage, TokenMeta, TokenSummary, WalletSummary } from '../../shared/types.ts'

export interface RawEvent {
  chain: Chain
  kind: Kind
  venue: string
  ix: string
  pool: string | null
  mints: string[]            // pool order; DBC launches preserve [base, quote]
  baseMint?: string          // explicit protocol roles, never inferred from symbol
  quoteMint?: string
  wallet: string
  amounts?: Amount[]         // only from executed lanes
  feeBps?: number | null
  tx: string
  n: string                  // position inside the tx, identical across lanes for the same instruction
  slot: number
  lane: Lane
  stage: Stage
  noLiquidity?: boolean      // pool_init whose tx adds no liquidity to that pool
  gradPool?: boolean         // pool_init that is the launchpad's own graduation pool
  at?: number                // backfilled events carry their chain time; live ones use arrival
  meta?: { name?: string; symbol?: string; uri?: string; decimals?: number }  // from launch args
}

export const QUOTES: Record<Chain, Record<string, { symbol: string; decimals: number }>> = {
  solana: {
    So11111111111111111111111111111111111111112: { symbol: 'SOL', decimals: 9 },
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6 },
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', decimals: 6 },
    USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB: { symbol: 'USD1', decimals: 6 },
    '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': { symbol: 'PYUSD', decimals: 6 },
  },
  robinhood: {
    '0x0000000000000000000000000000000000000000': { symbol: 'ETH', decimals: 18 },
    '0x0bd7d308f8e1639fab988df18a8011f41eacad73': { symbol: 'WETH', decimals: 18 },
    '0x5fc5360d0400a0fd4f2af552add042d716f1d168': { symbol: 'USDG', decimals: 6 },
  },
}
export const isQuote = (chain: Chain, mint: string) => mint in QUOTES[chain]

// ---- lane bookkeeping -------------------------------------------------------

const lanes = new Map<string, LaneStatus & { leads: number[] }>()
export function lane(chain: Chain, l: Lane, enabled: boolean, reason?: string) {
  const key = `${chain}:${l}`
  let s = lanes.get(key)
  if (!s) { s = { lane: l, chain, enabled, connected: false, lastMsgTs: null, msgs: 0, events: 0, firstSeenWins: 0, leads: [] }; lanes.set(key, s) }
  s.enabled = enabled
  s.reason = reason
  return s
}
export function laneStatus(): LaneStatus[] {
  return [...lanes.values()].map(({ leads, ...s }) => {
    const sorted = [...leads].sort((a, b) => a - b)
    return { ...s, p50LeadMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : undefined }
  })
}

// ---- in-memory state --------------------------------------------------------

export const bus = new EventEmitter()
bus.setMaxListeners(0)

const recent = new Map<string, FlowEvent>()          // id -> event, last few minutes, for lane upgrades
const recentByTx = new Map<string, string[]>()       // tx -> ids
const RECENT_MAX = 60_000
function remember(e: FlowEvent) {
  recent.set(e.id, e)
  const ids = recentByTx.get(e.tx) ?? []
  ids.push(e.id)
  recentByTx.set(e.tx, ids)
  if (recent.size > RECENT_MAX) {
    const drop = recent.size - RECENT_MAX
    let i = 0
    for (const [id, ev] of recent) { if (i++ >= drop) break; recent.delete(id); recentByTx.delete(ev.tx) }
  }
}

interface PoolState { created: number | null; funded: number | null; venue: string; feeBps: number | null; grad: boolean }
interface TokenState {
  chain: Chain; address: string
  launched: number | null; launchVenue: string | null; graduated: number | null; firstPool: number | null
  pools: Map<string, PoolState>
  wallets: Set<string>
  flags: Set<Flag>
  events: number; last: number
  meta: { symbol?: string; name?: string; image?: string; decimals?: number }
}
const tokens = new Map<string, TokenState>()
const lastLiq = new Map<string, { slot: number; ts: number }>()   // `${wallet}|${pool}` -> last add
export const followedWallets = new Set<string>()                  // `${chain}:${address}`

const tk = (chain: Chain, a: string) => `${chain}:${a}`

function loadToken(chain: Chain, address: string): TokenState {
  const key = tk(chain, address)
  let t = tokens.get(key)
  if (t) return t
  const row = db.prepare('SELECT * FROM tokens WHERE chain = ? AND address = ?').get(chain, address) as any
  t = {
    chain, address,
    launched: row?.launched_ts ?? null, launchVenue: row?.launch_venue ?? null,
    graduated: row?.graduated_ts ?? null, firstPool: row?.first_pool_ts ?? null,
    pools: new Map(), wallets: new Set(), flags: new Set(JSON.parse(row?.flags ?? '[]')),
    events: row?.events ?? 0, last: row?.last_ts ?? 0,
    meta: row ? { symbol: row.symbol ?? undefined, name: row.name ?? undefined, image: row.image ?? undefined, decimals: row.decimals ?? undefined, description: row.description ?? undefined, twitter: row.twitter ?? undefined, website: row.website ?? undefined } : {},
  }
  if (row) {
    for (const p of db.prepare('SELECT address, venue, fee_bps, created_ts, funded FROM pools WHERE chain = ? AND token = ?').all(chain, address) as any[])
      t.pools.set(p.address, { created: p.created_ts, funded: p.funded ? (p.created_ts ?? 0) : null, venue: p.venue, feeBps: p.fee_bps, grad: false })
    for (const w of db.prepare("SELECT DISTINCT wallet FROM events WHERE chain = ? AND token = ? AND kind IN ('pool_init','liq_add')").all(chain, address) as any[])
      t.wallets.add(w.wallet)
  }
  tokens.set(key, t)
  if (tokens.size > 200_000) for (const k of tokens.keys()) { tokens.delete(k); if (tokens.size < 150_000) break }
  return t
}

// pool -> {token, quote, venue} for pools whose add instructions do not carry mints
const poolIndex = new Map<string, { token: string | null; quote: string | null; mints: string[]; created: number | null }>()
export function lookupPool(chain: Chain, pool: string) {
  const key = tk(chain, pool)
  const hit = poolIndex.get(key)
  if (hit) return hit
  const row = db.prepare('SELECT token, quote, mint_a, mint_b, created_ts FROM pools WHERE chain = ? AND address = ?').get(chain, pool) as any
  if (!row) return null
  const v = { token: row.token, quote: row.quote, mints: [row.mint_a, row.mint_b].filter(Boolean), created: row.created_ts }
  poolIndex.set(key, v)
  return v
}
function indexPool(chain: Chain, pool: string, v: { token: string | null; quote: string | null; mints: string[]; created: number | null }) {
  poolIndex.set(tk(chain, pool), v)
  if (poolIndex.size > 400_000) for (const k of poolIndex.keys()) { poolIndex.delete(k); if (poolIndex.size < 300_000) break }
}

function pickToken(chain: Chain, mints: string[]): { token: string | null; quote: string | null } {
  const m = mints.filter(Boolean)
  const quotes = m.filter(x => isQuote(chain, x))
  const others = m.filter(x => !isQuote(chain, x))
  if (others.length === 1) return { token: others[0], quote: quotes[0] ?? null }
  if (others.length === 0) return { token: m[0] ?? null, quote: m[1] ?? null }
  // two non-quote mints: prefer the one that launched on a launchpad we saw
  const launched = others.find(x => loadToken(chain, x).launched)
  const token = launched ?? others[0]
  return { token, quote: others.find(x => x !== token) ?? null }
}

// ---- ingest -----------------------------------------------------------------

const insertEvent = db.prepare(`INSERT OR IGNORE INTO events
  (id, chain, kind, stage, lane, venue, ix, pool, token, quote, wallet, amounts, quote_ui, fee_bps, tx, slot, ts, confirmed_ts, flags)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
const updateEvent = db.prepare('UPDATE events SET stage = ?, confirmed_ts = ?, amounts = ?, quote_ui = ?, flags = ?, pool = COALESCE(pool, ?), token = COALESCE(token, ?), quote = COALESCE(quote, ?) WHERE id = ?')

let dropped = 0
export const counters = { dropped: () => dropped }

export function ingest(r: RawEvent): void {
  const ls = lane(r.chain, r.lane, true)
  ls.events++
  const id = `${r.chain}:${r.tx}:${r.n}`
  const now = r.at ?? Date.now()

  const prev = recent.get(id)
  if (prev) return upgrade(prev, r, now)
  if (r.stage === 'failed') return   // a failure we never saw pending is not news

  // resolve subject token / quote
  let mints = r.mints.filter(Boolean)
  if (r.pool && mints.length < 2) {
    const p = lookupPool(r.chain, r.pool)
    if (p && p.mints.length) mints = p.mints
  }
  const { token, quote } = r.baseMint && r.quoteMint
    ? { token: r.baseMint, quote: r.quoteMint }
    : r.kind === 'launch' || r.kind === 'graduate'
      ? { token: mints[0] ?? null, quote: null }
      : pickToken(r.chain, mints)

  // young-liquidity rule
  if (r.kind === 'liq_add' || r.kind === 'liq_remove') {
    const p = r.pool ? lookupPool(r.chain, r.pool) : null
    const t = token ? loadToken(r.chain, token) : null
    const young = (p?.created && now - p.created < config.youngMs)
      || (t?.launched && now - t.launched < config.youngMs)
      || (t?.firstPool && now - t.firstPool < config.youngMs)
      || followedWallets.has(tk(r.chain, r.wallet))
    if (!young) { dropped++; return }
  }

  const e: FlowEvent = {
    id, chain: r.chain, kind: r.kind, stage: r.stage, lane: r.lane, venue: r.venue, ix: r.ix,
    pool: r.pool, token, quote, wallet: r.wallet,
    amounts: r.amounts ?? [], quoteUi: quoteLeg(r.chain, r.amounts, quote),
    feeBps: r.feeBps ?? null, tx: r.tx, slot: r.slot, ts: now,
    confirmedTs: r.stage === 'confirmed' ? now : undefined,
    flags: [],
  }
  ls.firstSeenWins++
  if (r.meta && token && (r.meta.name || r.meta.symbol)) {
    const t = loadToken(r.chain, token)
    if (!t.meta.symbol) {
      setTokenMeta(r.chain, token, { name: r.meta.name, symbol: r.meta.symbol, decimals: r.meta.decimals }, false)
      if (r.meta.uri) bus.emit('launchUri', r.chain, token, r.meta.uri)
    }
  }
  applyState(e, r, mints)
  if (token) {
    const t = loadToken(r.chain, token)
    if (t.meta.symbol || t.meta.name) e.tokenMeta = t.meta
  }
  insertEvent.run(e.id, e.chain, e.kind, e.stage, e.lane, e.venue, e.ix, e.pool, e.token, e.quote, e.wallet,
    JSON.stringify(e.amounts), e.quoteUi, e.feeBps, e.tx, e.slot, e.ts, e.confirmedTs ?? null, JSON.stringify(e.flags))
  remember(e)
  bus.emit('event', e)
}

function quoteLeg(chain: Chain, amounts: Amount[] | undefined, quote: string | null): number | null {
  if (!amounts?.length) return null
  const q = amounts.find(a => (quote && a.mint === quote) || isQuote(chain, a.mint))
  return q ? Math.abs(q.ui) : null
}

function upgrade(prev: FlowEvent, r: RawEvent, now: number) {
  const ls = lane(r.chain, r.lane, true)
  if (r.stage === 'failed' && prev.stage === 'pending') {
    prev.stage = 'failed'
  } else if (r.stage === 'confirmed' && prev.stage !== 'confirmed') {
    prev.stage = 'confirmed'
    prev.confirmedTs = now
    if (r.amounts?.length) { prev.amounts = r.amounts; prev.quoteUi = quoteLeg(prev.chain, r.amounts, prev.quote) }
    if (!prev.pool && r.pool) prev.pool = r.pool
    if (r.baseMint && r.quoteMint) { prev.token = r.baseMint; prev.quote = r.quoteMint; prev.quoteUi = quoteLeg(prev.chain, prev.amounts, prev.quote) }
    ls.leads.push(now - prev.ts)
    if (ls.leads.length > 2000) ls.leads.splice(0, 1000)
    const firstLane = lane(prev.chain, prev.lane, true)
    if (firstLane !== ls) { firstLane.leads.push(now - prev.ts); if (firstLane.leads.length > 2000) firstLane.leads.splice(0, 1000) }
  } else return
  updateEvent.run(prev.stage, prev.confirmedTs ?? null, JSON.stringify(prev.amounts), prev.quoteUi, JSON.stringify(prev.flags), prev.pool, prev.token, prev.quote, prev.id)
  bus.emit('upgrade', { t: 'upgrade', id: prev.id, stage: prev.stage, confirmedTs: prev.confirmedTs, amounts: prev.amounts, quoteUi: prev.quoteUi, flags: prev.flags })
}

// a liquidity event whose pool turned out to have no liquidity added (ladder) or
// a later flag (burst) is attached after the fact
export function addFlag(id: string, flag: Flag) {
  const e = recent.get(id)
  if (!e || e.flags.includes(flag)) return
  e.flags.push(flag)
  db.prepare('UPDATE events SET flags = ? WHERE id = ?').run(JSON.stringify(e.flags), id)
  bus.emit('upgrade', { t: 'upgrade', id, stage: e.stage, flags: e.flags })
  if (e.token) { const t = loadToken(e.chain, e.token); t.flags.add(flag); saveToken(t) }
}

// ---- state, flags, aggregates ----------------------------------------------

const upPool = db.prepare(`INSERT INTO pools (chain, address, venue, token, quote, mint_a, mint_b, fee_bps, created_ts, creator, init_tx, liq_events, funded)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0)
  ON CONFLICT(chain, address) DO UPDATE SET token = COALESCE(pools.token, excluded.token), quote = COALESCE(pools.quote, excluded.quote),
    mint_a = COALESCE(pools.mint_a, excluded.mint_a), mint_b = COALESCE(pools.mint_b, excluded.mint_b),
    fee_bps = COALESCE(pools.fee_bps, excluded.fee_bps), created_ts = COALESCE(pools.created_ts, excluded.created_ts),
    creator = COALESCE(pools.creator, excluded.creator), init_tx = COALESCE(pools.init_tx, excluded.init_tx)`)
const bumpPool = db.prepare('UPDATE pools SET liq_events = liq_events + 1, funded = MAX(funded, ?) WHERE chain = ? AND address = ?')
const upWallet = db.prepare(`INSERT INTO wallets (chain, address, inits, adds, removes, first_ts, last_ts) VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(chain, address) DO UPDATE SET inits = inits + excluded.inits, adds = adds + excluded.adds, removes = removes + excluded.removes, last_ts = excluded.last_ts`)
const insWalletToken = db.prepare('INSERT OR IGNORE INTO wallet_tokens (chain, wallet, token, first_ts) VALUES (?,?,?,?)')
const bumpWalletTokens = db.prepare('UPDATE wallets SET tokens = tokens + 1 WHERE chain = ? AND address = ?')
const upToken = db.prepare(`INSERT INTO tokens (chain, address, launched_ts, launch_venue, launch_tx, creator, graduated_ts, first_pool_ts, pools, funded_pools, lp_wallets, events, last_ts, score, flags)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(chain, address) DO UPDATE SET launched_ts = COALESCE(tokens.launched_ts, excluded.launched_ts), launch_venue = COALESCE(tokens.launch_venue, excluded.launch_venue),
    launch_tx = COALESCE(tokens.launch_tx, excluded.launch_tx), creator = COALESCE(tokens.creator, excluded.creator),
    graduated_ts = COALESCE(tokens.graduated_ts, excluded.graduated_ts), first_pool_ts = COALESCE(tokens.first_pool_ts, excluded.first_pool_ts),
    pools = excluded.pools, funded_pools = excluded.funded_pools, lp_wallets = excluded.lp_wallets, events = excluded.events,
    last_ts = excluded.last_ts, score = excluded.score, flags = excluded.flags`)

const FLAG_WEIGHT: Record<Flag, number> = { pounce: 5, burst_4_300: 8, burst_5_600: 10, honeypot_fee: 2, ladder: 2, jit: 2, multi_venue: 6, first_pool: 0 }

function score(t: TokenState): number {
  let funded = 0
  for (const p of t.pools.values()) if (p.funded) funded++
  let s = t.pools.size + 2 * funded + t.wallets.size
  for (const f of t.flags) s += FLAG_WEIGHT[f] ?? 0
  if (t.graduated) s += 3
  return s
}

const launchMeta = new Map<string, { tx: string; creator: string }>()
function saveToken(t: TokenState) {
  let funded = 0
  for (const p of t.pools.values()) if (p.funded) funded++
  const lm = launchMeta.get(tk(t.chain, t.address))
  upToken.run(t.chain, t.address, t.launched, t.launchVenue, lm?.tx ?? null, lm?.creator ?? null, t.graduated, t.firstPool,
    t.pools.size, funded, t.wallets.size, t.events, t.last, score(t), JSON.stringify([...t.flags]))
  bus.emit('token', t.chain, t.address)
}

const tokenEventIds = new Map<string, string[]>()   // token -> recent event ids, for retroactive token-level flags

function applyState(e: FlowEvent, r: RawEvent, mints: string[]) {
  const now = e.ts
  const poolBorn = r.kind === 'pool_init' || (r.kind === 'launch' && r.venue === 'meteora-dbc' && !!r.pool)
  if (r.pool && (r.kind === 'pool_init' || mints.length >= 2)) {
    const prevIdx = lookupPool(r.chain, r.pool)
    indexPool(r.chain, r.pool, { token: e.token, quote: e.quote, mints, created: poolBorn ? now : (prevIdx?.created ?? null) })
  }
  tx(() => {
    if (r.pool) {
      upPool.run(e.chain, r.pool, e.venue, e.token, e.quote, mints[0] ?? null, mints[1] ?? null, e.feeBps,
        poolBorn ? now : null, poolBorn ? e.wallet : null, poolBorn ? e.tx : null)
      if (r.kind === 'liq_add' || r.kind === 'liq_remove') bumpPool.run(r.kind === 'liq_add' ? 1 : 0, e.chain, r.pool)
    }
    upWallet.run(e.chain, e.wallet, r.kind === 'pool_init' ? 1 : 0, r.kind === 'liq_add' ? 1 : 0, r.kind === 'liq_remove' ? 1 : 0, now, now)
  })
  if (!e.token) return

  const t = loadToken(e.chain, e.token)
  t.events++
  t.last = now
  const flags = new Set<Flag>()

  if (r.kind === 'launch') {
    t.launched ??= now
    t.launchVenue ??= e.venue
    launchMeta.set(tk(e.chain, e.token), { tx: e.tx, creator: e.wallet })
    if (poolBorn && r.pool) {
      t.firstPool ??= now
      if (!t.pools.has(r.pool)) t.pools.set(r.pool, { created: now, funded: null, venue: e.venue, feeBps: e.feeBps, grad: false })
    }
  }
  if (r.kind === 'graduate') graduate(t, now)

  if (r.kind === 'pool_init' && r.pool) {
    if (r.gradPool) { if (!t.graduated) graduate(t, now) }
    if (t.pools.size === 0 && !r.gradPool) flags.add('first_pool')
    if (!t.pools.has(r.pool)) t.pools.set(r.pool, { created: now, funded: null, venue: e.venue, feeBps: e.feeBps, grad: !!r.gradPool })
    t.firstPool ??= now
    if (e.feeBps != null && e.feeBps >= 7000) flags.add('honeypot_fee')
    if (r.noLiquidity) flags.add('ladder')
    // the book's crew shape: an independent pool on a launchpad token still on its curve
    if (t.launched && !t.graduated && !r.gradPool) flags.add('pounce')
    const firstHour = [...t.pools.values()].filter(p => p.created && p.created - (t.launched ?? t.firstPool ?? now) < 3600_000).length
    if (firstHour >= 5) flags.add('multi_venue')
  }

  if ((r.kind === 'liq_add' || (r.kind === 'pool_init' && !r.noLiquidity)) && r.pool) {
    let p = t.pools.get(r.pool)
    if (!p) { p = { created: null, funded: null, venue: e.venue, feeBps: e.feeBps, grad: false }; t.pools.set(r.pool, p) }
    if (!p.funded) {
      p.funded = now
      if (!p.grad) {
        const funded = [...t.pools.values()].filter(x => x.funded && !x.grad)
        if (funded.filter(x => now - x.funded! <= 300_000).length >= 4) flags.add('burst_4_300')
        if (funded.filter(x => now - x.funded! <= 600_000).length >= 5) flags.add('burst_5_600')
      }
    }
    if (r.kind === 'liq_add') lastLiq.set(`${e.wallet}|${r.pool}`, { slot: e.slot, ts: now })
    if (t.launched && !t.graduated && !p.grad) flags.add('pounce')
  }
  if (r.kind === 'liq_remove' && r.pool) {
    const add = lastLiq.get(`${e.wallet}|${r.pool}`)
    const window = e.chain === 'solana' ? 8 : 12
    if (add && e.slot - add.slot <= window) flags.add('jit')
  }
  if (lastLiq.size > 300_000) for (const k of lastLiq.keys()) { lastLiq.delete(k); if (lastLiq.size < 200_000) break }

  if (r.kind === 'pool_init' || r.kind === 'liq_add') {
    if (!t.wallets.has(e.wallet)) {
      t.wallets.add(e.wallet)
      if (t.launched && !t.graduated) {
        const res = insWalletToken.run(e.chain, e.wallet, e.token, now)
        if (res.changes) bumpWalletTokens.run(e.chain, e.wallet)
      }
    }
  }

  e.flags = [...flags]
  for (const f of flags) if (f !== 'first_pool') t.flags.add(f)
  const ids = tokenEventIds.get(tk(e.chain, e.token)) ?? []
  ids.push(e.id)
  if (ids.length > 50) ids.shift()
  tokenEventIds.set(tk(e.chain, e.token), ids)
  saveToken(t)
}

function graduate(t: TokenState, now: number) {
  if (t.graduated) return
  t.graduated = now
  tx(() => {
    db.prepare('UPDATE wallet_tokens SET hit = 1 WHERE chain = ? AND token = ?').run(t.chain, t.address)
    db.prepare(`UPDATE wallets SET hits = hits + 1 WHERE chain = ? AND address IN (SELECT wallet FROM wallet_tokens WHERE chain = ? AND token = ?)`).run(t.chain, t.chain, t.address)
    db.prepare('UPDATE posts SET hit = 1 WHERE chain = ? AND token = ? AND pre_grad = 1').run(t.chain, t.address)
  })
  bus.emit('graduated', t.chain, t.address)
}

const clip = (s: string | undefined, n: number) => (s ? s.slice(0, n) : undefined)
export function setTokenMeta(chain: Chain, address: string, meta: TokenMeta, complete = true) {
  const t = loadToken(chain, address)
  const m: TokenMeta = { ...t.meta }
  for (const [k, v] of Object.entries(meta)) if (v !== undefined && v !== null && v !== '') (m as any)[k] = v
  m.symbol = clip(m.symbol, 24); m.name = clip(m.name, 64); m.description = clip(m.description, 400)
  t.meta = m
  db.prepare(`INSERT INTO tokens (chain, address, symbol, name, image, decimals, description, twitter, website, meta_ts) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(chain, address) DO UPDATE SET symbol = excluded.symbol, name = excluded.name, image = excluded.image, decimals = excluded.decimals,
      description = excluded.description, twitter = excluded.twitter, website = excluded.website, meta_ts = COALESCE(excluded.meta_ts, tokens.meta_ts)`)
    .run(chain, address, m.symbol ?? null, m.name ?? null, m.image ?? null, m.decimals ?? null, m.description ?? null, m.twitter ?? null, m.website ?? null, complete ? Date.now() : null)
  bus.emit('token', chain, address)
  bus.emit('meta', chain, address, m)
}

export function tokenGraduated(chain: Chain, address: string): boolean { return !!loadToken(chain, address).graduated }

// ---- reads ------------------------------------------------------------------

export function rowToEvent(r: any): FlowEvent {
  return {
    id: r.id, chain: r.chain, kind: r.kind, stage: r.stage, lane: r.lane, venue: r.venue, ix: r.ix,
    pool: r.pool, token: r.token, quote: r.quote, wallet: r.wallet, amounts: JSON.parse(r.amounts),
    quoteUi: r.quote_ui, feeBps: r.fee_bps, tx: r.tx, slot: r.slot, ts: r.ts, confirmedTs: r.confirmed_ts ?? undefined,
    flags: JSON.parse(r.flags),
    tokenMeta: r.t_symbol || r.t_name || r.t_image ? { symbol: r.t_symbol ?? undefined, name: r.t_name ?? undefined, image: r.t_image ?? undefined, decimals: r.t_decimals ?? undefined } : undefined,
  }
}

export function rowToToken(r: any): TokenSummary {
  return {
    chain: r.chain, address: r.address, symbol: r.symbol ?? undefined, name: r.name ?? undefined, image: r.image ?? undefined, decimals: r.decimals ?? undefined,
    description: r.description ?? undefined, twitter: r.twitter ?? undefined, website: r.website ?? undefined,
    launchedTs: r.launched_ts, launchVenue: r.launch_venue, graduatedTs: r.graduated_ts, firstPoolTs: r.first_pool_ts,
    pools: r.pools, fundedPools: r.funded_pools, lpWallets: r.lp_wallets, events: r.events, lastTs: r.last_ts,
    score: r.score, flags: JSON.parse(r.flags), followers: r.followers ?? undefined,
  }
}

export function rowToWallet(r: any): WalletSummary {
  return {
    chain: r.chain, address: r.address, label: r.label, inits: r.inits, adds: r.adds, removes: r.removes,
    tokens: r.tokens, hits: r.hits, hitRate: r.tokens ? r.hits / r.tokens : 0, firstTs: r.first_ts, lastTs: r.last_ts,
    followers: r.followers ?? undefined,
  }
}

export function rowToPool(r: any): PoolSummary {
  return { chain: r.chain, address: r.address, venue: r.venue, token: r.token, quote: r.quote, feeBps: r.fee_bps, createdTs: r.created_ts, creator: r.creator, liqEvents: r.liq_events, funded: !!r.funded }
}

export function getToken(chain: Chain, address: string): TokenSummary | null {
  const r = db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM follows f WHERE f.kind = 'token' AND f.chain = t.chain AND f.address = t.address) AS followers
    FROM tokens t WHERE chain = ? AND address = ?`).get(chain, address)
  return r ? rowToToken(r) : null
}

// prune old rows once an hour so the volume stays bounded
setInterval(() => {
  const cutoff = Date.now() - config.retainDays * 86400_000
  db.prepare("DELETE FROM events WHERE ts < ? AND kind IN ('liq_add','liq_remove')").run(cutoff)
  db.prepare("DELETE FROM events WHERE ts < ? AND kind = 'launch' AND token NOT IN (SELECT address FROM tokens WHERE pools > 0)").run(cutoff)
}, 3600_000).unref()

// pre-execution copies that never landed: once an executed lane is up and a
// pending copy is 45 s old with no executed copy, it was dropped or failed
export function sweepPending() {
  const executed = [...lanes.values()].some(l => l.chain === 'solana' && (l.lane === 'geyser' || l.lane === 'geyser-drpc') && l.connected)
  if (!executed) return
  const cutoff = Date.now() - 90_000
  for (const e of recent.values()) {
    if (e.stage !== 'pending' || e.ts > cutoff) continue
    e.stage = 'failed'
    updateEvent.run('failed', null, JSON.stringify(e.amounts), e.quoteUi, JSON.stringify(e.flags), e.pool, e.token, e.quote, e.id)
    bus.emit('upgrade', { t: 'upgrade', id: e.id, stage: 'failed' })
  }
}
