// HTTP + websocket API. Reads are open; writes carry an ed25519 signature.

import http from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { db } from './db.ts'
import { bus, counters, getToken, laneStatus, rowToEvent, rowToPool, rowToToken, rowToWallet } from './hub.ts'
import { enrich } from './meta.ts'
import { prices } from './prices.ts'
import { HttpError, callers, createPost, follow, follows, getPost, like, listPosts, profile, registerPush, setProfile, verify } from './social.ts'
import type { Chain, ClientMsg, FlowEvent, Kind, ServerMsg, Status } from '../../shared/types.ts'

const started = Date.now()
const ROUTING_API = process.env.ROUTING_API_URL ?? 'https://xn644o3px9.execute-api.us-east-2.amazonaws.com/prod/quote'

const eventSelect = `SELECT e.*, t.symbol AS t_symbol, t.name AS t_name, t.image AS t_image, t.decimals AS t_decimals
  FROM events e LEFT JOIN tokens t ON t.chain = e.chain AND t.address = e.token`

const CHAINS = new Set(['solana', 'robinhood'])
const KINDS = new Set(['launch', 'pool_init', 'liq_add', 'liq_remove', 'graduate'])
const chainOf = (v: string | null) => (v && CHAINS.has(v) ? (v as Chain) : null)
const normAddr = (chain: Chain, a: string) => (chain === 'robinhood' ? a.toLowerCase() : a)

function status(): Status {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as any).n
  return { startedTs: started, lanes: laneStatus(), clients: clients.size, eventsStored: n, prices }
}

function feed(q: URLSearchParams) {
  const where: string[] = []
  const args: any[] = []
  const chain = chainOf(q.get('chain'))
  if (chain) { where.push('e.chain = ?'); args.push(chain) }
  const kinds = (q.get('kinds') ?? '').split(',').filter(k => KINDS.has(k))
  if (kinds.length) { where.push(`e.kind IN (${kinds.map(() => '?').join(',')})`); args.push(...kinds) }
  if (q.get('flagged') === '1') where.push("e.flags != '[]' AND e.flags != '[\"first_pool\"]'")
  const minQuote = Number(q.get('minQuote') ?? 0)
  if (minQuote > 0) { where.push('e.quote_ui >= ?'); args.push(minQuote) }
  const before = Number(q.get('before') ?? 0)
  if (before) { where.push('e.ts < ?'); args.push(before) }
  if (q.get('token')) { where.push('e.token = ?'); args.push(q.get('token')) }
  if (q.get('wallet')) { where.push('e.wallet = ?'); args.push(q.get('wallet')) }
  const as = q.get('as')
  if (as) {
    where.push(`((e.chain, e.wallet) IN (SELECT chain, address FROM follows WHERE user = ? AND kind = 'wallet')
      OR (e.chain, e.token) IN (SELECT chain, address FROM follows WHERE user = ? AND kind = 'token'))`)
    args.push(as, as)
  }
  const limit = Math.min(Number(q.get('limit') ?? 60), 300)
  const sql = `${eventSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.ts DESC LIMIT ?`
  return (db.prepare(sql).all(...args, limit) as any[]).map(rowToEvent)
}

function hot(q: URLSearchParams) {
  const chain = chainOf(q.get('chain'))
  const hours = Math.min(Number(q.get('hours') ?? 6), 72)
  const limit = Math.min(Number(q.get('limit') ?? 50), 200)
  const sort = q.get('sort') === 'new' ? 'first_pool_ts DESC' : 'score DESC, last_ts DESC'
  const rows = db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM follows f WHERE f.kind = 'token' AND f.chain = t.chain AND f.address = t.address) AS followers
    FROM tokens t WHERE t.last_ts > ? AND t.pools > 0 ${chain ? 'AND t.chain = ?' : ''} AND t.address NOT IN (${QUOTE_LIST})
    ORDER BY ${sort} LIMIT ?`).all(...[Date.now() - hours * 3600_000, ...(chain ? [chain] : []), limit]) as any[]
  return rows.map(rowToToken)
}
const QUOTE_LIST = `'So11111111111111111111111111111111111111112','EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v','Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB','USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB','2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo','0x0000000000000000000000000000000000000000','0x0bd7d308f8e1639fab988df18a8011f41eacad73','0x5fc5360d0400a0fd4f2af552add042d716f1d168'`

function tokenPage(chain: Chain, address: string, viewer: string | null) {
  const token = getToken(chain, address)
  if (!token) throw new HttpError(404, 'token not seen yet')
  if (!token.symbol && !token.name) enrich(chain, address)
  const pools = (db.prepare('SELECT * FROM pools WHERE chain = ? AND token = ? ORDER BY created_ts DESC LIMIT 100').all(chain, address) as any[]).map(rowToPool)
  const events = (db.prepare(`${eventSelect} WHERE e.chain = ? AND e.token = ? ORDER BY e.ts DESC LIMIT 200`).all(chain, address) as any[]).map(rowToEvent)
  const wallets = (db.prepare(`SELECT w.*, (SELECT COUNT(*) FROM follows f WHERE f.kind = 'wallet' AND f.chain = w.chain AND f.address = w.address) AS followers
    FROM wallets w WHERE w.chain = ? AND w.address IN (SELECT DISTINCT wallet FROM events WHERE chain = ? AND token = ? AND kind IN ('pool_init','liq_add'))
    ORDER BY w.hits DESC LIMIT 50`).all(chain, chain, address) as any[]).map(rowToWallet)
  return { token, pools, events, wallets, posts: listPosts({ chain, token: address, viewer }) }
}

function walletPage(chain: Chain, address: string) {
  const r = db.prepare(`SELECT w.*, (SELECT COUNT(*) FROM follows f WHERE f.kind = 'wallet' AND f.chain = w.chain AND f.address = w.address) AS followers
    FROM wallets w WHERE chain = ? AND address = ?`).get(chain, address)
  if (!r) throw new HttpError(404, 'wallet not seen yet')
  const events = (db.prepare(`${eventSelect} WHERE e.chain = ? AND e.wallet = ? ORDER BY e.ts DESC LIMIT 200`).all(chain, address) as any[]).map(rowToEvent)
  const tokens = (db.prepare(`SELECT t.*, wt.first_ts AS wt_first, wt.hit AS wt_hit FROM wallet_tokens wt JOIN tokens t ON t.chain = wt.chain AND t.address = wt.token
    WHERE wt.chain = ? AND wt.wallet = ? ORDER BY wt.first_ts DESC LIMIT 200`).all(chain, address) as any[]).map(x => ({ ...rowToToken(x), touchedTs: x.wt_first, hit: !!x.wt_hit }))
  return { wallet: rowToWallet(r), events, tokens }
}

function leaderboard(q: URLSearchParams) {
  const chain = chainOf(q.get('chain'))
  const min = Math.max(1, Number(q.get('min') ?? 3))
  const rows = db.prepare(`SELECT w.*, (SELECT COUNT(*) FROM follows f WHERE f.kind = 'wallet' AND f.chain = w.chain AND f.address = w.address) AS followers
    FROM wallets w WHERE w.tokens >= ? ${chain ? 'AND w.chain = ?' : ''}
    ORDER BY w.hits DESC, (CAST(w.hits AS REAL) / w.tokens) DESC, w.last_ts DESC LIMIT 100`).all(...[min, ...(chain ? [chain] : [])]) as any[]
  return rows.map(rowToWallet)
}

function search(qs: string) {
  const q = qs.trim()
  if (!q) return { tokens: [], wallets: [], profiles: [] }
  const like = `%${q.replace(/[%_]/g, '')}%`
  const tokens = (db.prepare(`SELECT * FROM tokens WHERE (address = ? OR address = ? OR symbol LIKE ? OR name LIKE ?) AND pools > 0 ORDER BY score DESC LIMIT 20`).all(q, q.toLowerCase(), like, like) as any[]).map(rowToToken)
  const wallets = (db.prepare('SELECT * FROM wallets WHERE address = ? OR address = ? LIMIT 5').all(q, q.toLowerCase()) as any[]).map(rowToWallet)
  const profiles = (db.prepare('SELECT * FROM users WHERE handle LIKE ? OR pubkey = ? LIMIT 10').all(like, q) as any[]).map(r => profile(r.pubkey))
  return { tokens, wallets, profiles }
}

async function quote(q: URLSearchParams) {
  const p = new URLSearchParams({
    tokenInAddress: q.get('tokenIn') ?? '', tokenInChainId: '4663', tokenOutAddress: q.get('tokenOut') ?? '', tokenOutChainId: '4663',
    amount: q.get('amount') ?? '', type: q.get('type') === 'exactOut' ? 'exactOut' : 'exactIn',
  })
  if (q.get('recipient')) { p.set('recipient', q.get('recipient')!); p.set('slippageTolerance', q.get('slippage') ?? '5'); p.set('deadline', '600') }
  const r = await fetch(`${ROUTING_API}?${p}`, { headers: { 'x-universal-router-version': '2.0' }, signal: AbortSignal.timeout(20_000) })
  const body = await r.text()
  if (!r.ok) throw new HttpError(r.status === 404 ? 404 : 502, body.slice(0, 300) || 'no route')
  return JSON.parse(body)
}

// ---- server -----------------------------------------------------------------

const clients = new Map<WebSocket, { chains?: Set<Chain>; kinds?: Set<Kind>; flaggedOnly?: boolean; minQuote?: number; wallets?: Set<string>; tokens?: Set<string> }>()

function matches(f: ReturnType<typeof clients.get> & {}, e: FlowEvent): boolean {
  if (f.wallets || f.tokens) {
    const hit = (f.wallets?.has(`${e.chain}:${e.wallet}`)) || (e.token && f.tokens?.has(`${e.chain}:${e.token}`))
    if (!hit) return false
  }
  if (f.chains && !f.chains.has(e.chain)) return false
  if (f.kinds && !f.kinds.has(e.kind)) return false
  if (f.flaggedOnly && !e.flags.some(x => x !== 'first_pool')) return false
  if (f.minQuote && (e.quoteUi ?? 0) < f.minQuote) return false
  return true
}

function send(ws: WebSocket, m: ServerMsg) { if (ws.readyState === 1 && ws.bufferedAmount < 4_000_000) ws.send(JSON.stringify(m)) }

export function startApi(port: number) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-headers', 'content-type, x-ftl-pubkey, x-ftl-ts, x-ftl-sig')
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return }
    const url = new URL(req.url ?? '/', 'http://x')
    const q = url.searchParams
    const parts = url.pathname.split('/').filter(Boolean)
    let body = ''
    if (req.method === 'POST') { for await (const c of req) { body += c; if (body.length > 20_000) break } }
    const json = () => { try { return JSON.parse(body || '{}') } catch { throw new HttpError(400, 'bad json') } }
    const viewer = q.get('viewer')
    try {
      let out: unknown
      const [a, b, c, d] = parts
      if (a !== 'api') {
        if (url.pathname === '/' || url.pathname === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }).end('ftl ok'); return }
        throw new HttpError(404, 'not found')
      }
      if (req.method === 'GET') {
        if (b === 'status') out = { ...status(), dropped: counters.dropped() }
        else if (b === 'feed') out = feed(q)
        else if (b === 'tokens' && c === 'hot') out = hot(q)
        else if (b === 'token' && chainOf(c ?? null) && d) out = tokenPage(c as Chain, normAddr(c as Chain, d), viewer)
        else if (b === 'wallet' && chainOf(c ?? null) && d) out = walletPage(c as Chain, normAddr(c as Chain, d))
        else if (b === 'leaderboard' && c === 'wallets') out = leaderboard(q)
        else if (b === 'leaderboard' && c === 'callers') out = callers()
        else if (b === 'posts' && !c) out = listPosts({ chain: q.get('chain') ?? undefined, token: q.get('token') ?? undefined, user: q.get('user') ?? undefined, before: Number(q.get('before') ?? 0) || undefined, viewer })
        else if (b === 'profile' && c) out = { profile: profile(c), follows: follows(c), posts: listPosts({ user: c, viewer }) }
        else if (b === 'search') out = search(q.get('q') ?? '')
        else if (b === 'quote' && c === 'robinhood') out = await quote(q)
        else throw new HttpError(404, 'not found')
      } else if (req.method === 'POST') {
        const user = verify('POST', url.pathname, body, req.headers)
        if (b === 'me') { const j = json(); out = setProfile(user, j.handle, j.bio) }
        else if (b === 'follow') out = follow(user, json(), true)
        else if (b === 'unfollow') out = follow(user, json(), false)
        else if (b === 'posts' && !c) {
          const p = createPost(user, json())
          for (const ws of clients.keys()) send(ws, { t: 'post', p })
          out = p
        }
        else if (b === 'posts' && c && (d === 'like' || d === 'unlike')) out = like(user, Number(c), d === 'like')
        else if (b === 'push') out = registerPush(user, json())
        else throw new HttpError(404, 'not found')
      } else throw new HttpError(405, 'method')
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': req.method === 'GET' && (b === 'leaderboard') ? 'public, max-age=15' : 'no-store' })
      res.end(JSON.stringify(out))
    } catch (e: any) {
      const status = e instanceof HttpError ? e.status : 500
      if (status === 500) console.error('[api]', req.method, url.pathname, e)
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e?.message ?? 'error' }))
    }
  })

  const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: false })
  wss.on('connection', (ws) => {
    clients.set(ws, {})
    send(ws, { t: 'hello', serverTs: Date.now() })
    send(ws, { t: 'status', s: status() })
    let alive = true
    ws.on('pong', () => { alive = true })
    const hb = setInterval(() => { if (!alive) { ws.terminate(); return } alive = false; ws.ping() }, 25_000)
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(String(raw)) as ClientMsg
        if (m.t === 'filter') {
          clients.set(ws, {
            chains: m.chains?.length ? new Set(m.chains) : undefined,
            kinds: m.kinds?.length ? new Set(m.kinds) : undefined,
            flaggedOnly: !!m.flaggedOnly,
            minQuote: m.minQuote,
            wallets: m.follow ? new Set(m.follow.wallets) : undefined,
            tokens: m.follow ? new Set(m.follow.tokens) : undefined,
          })
        }
      } catch {}
    })
    ws.on('close', () => { clearInterval(hb); clients.delete(ws) })
  })

  bus.on('event', (e: FlowEvent) => {
    for (const [ws, f] of clients) if (matches(f, e)) send(ws, { t: 'event', e })
    if (e.token && !e.tokenMeta?.image) enrich(e.chain, e.token)
  })
  // names and images resolve after the event went out: patch them into every open feed
  bus.on('meta', (chain: Chain, address: string, m: any) => {
    const msg: ServerMsg = { t: 'meta', chain, address, m: { symbol: m.symbol, name: m.name, image: m.image, decimals: m.decimals } }
    for (const ws of clients.keys()) send(ws, msg)
  })
  bus.on('upgrade', (u: ServerMsg) => { for (const ws of clients.keys()) send(ws, u) })

  // token summaries change on every event; coalesce to one push per token per second
  const dirty = new Set<string>()
  bus.on('token', (chain: Chain, address: string) => dirty.add(`${chain}|${address}`))
  setInterval(() => {
    if (!dirty.size || !clients.size) { dirty.clear(); return }
    const keys = [...dirty].slice(0, 200)
    dirty.clear()
    for (const k of keys) {
      const [chain, address] = k.split('|') as [Chain, string]
      const s = getToken(chain, address)
      if (!s || s.pools === 0) continue
      for (const ws of clients.keys()) send(ws, { t: 'token', s })
    }
  }, 1000).unref()
  setInterval(() => { const s = status(); for (const ws of clients.keys()) send(ws, { t: 'status', s }) }, 5000).unref()

  server.listen(port, '0.0.0.0', () => console.log(`[api] listening on :${port}`))
}
