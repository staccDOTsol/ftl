// Identity is an ed25519 keypair the app keeps on the device: the public key is
// a Solana address. Every write is signed; nothing else is needed to sign up.

import crypto from 'node:crypto'
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import { db, tx } from './db.ts'
import { followedWallets, tokenGraduated } from './hub.ts'
import type { Chain, Post, Profile } from '../../shared/types.ts'

export class HttpError extends Error {
  status: number
  constructor(status: number, msg: string) { super(msg); this.status = status }
}

const pruneDeletionGuards = db.prepare('DELETE FROM account_deletion_guards WHERE deleted_ts < ?')
pruneDeletionGuards.run(Date.now() - 5 * 60_000)
setInterval(() => pruneDeletionGuards.run(Date.now() - 5 * 60_000), 60_000).unref()

export function verify(method: string, path: string, body: string, h: Record<string, string | string[] | undefined>): string {
  const pubkey = String(h['x-ftl-pubkey'] ?? '')
  const ts = Number(h['x-ftl-ts'] ?? 0)
  const sig = String(h['x-ftl-sig'] ?? '')
  if (!pubkey || !ts || !sig) throw new HttpError(401, 'unsigned request')
  if (Math.abs(Date.now() - ts) > 5 * 60_000) throw new HttpError(401, 'stale signature')
  const digest = crypto.createHash('sha256').update(body).digest('hex')
  const msg = new TextEncoder().encode(`FTL\n${method}\n${path}\n${ts}\n${digest}`)
  let ok = false
  try { ok = nacl.sign.detached.verify(msg, bs58.decode(sig), bs58.decode(pubkey)) } catch {}
  if (!ok) throw new HttpError(401, 'bad signature')
  // Signatures remain valid for five minutes. A short digest-only guard keeps
  // an old in-flight request from recreating an account just deleted.
  const keyHash = crypto.createHash('sha256').update(pubkey).digest('hex')
  const deleted = db.prepare('SELECT deleted_ts FROM account_deletion_guards WHERE key_hash = ?').get(keyHash) as { deleted_ts: number } | undefined
  if (path !== '/api/account/delete' && deleted && Date.now() - deleted.deleted_ts < 5 * 60_000)
    throw new HttpError(401, 'account was recently deleted')
  db.prepare('INSERT OR IGNORE INTO users (pubkey, created_ts) VALUES (?, ?)').run(pubkey, Date.now())
  return pubkey
}

export function profile(pubkey: string): Profile {
  const r = db.prepare('SELECT * FROM users WHERE pubkey = ?').get(pubkey) as any
  return { pubkey, handle: r?.handle ?? null, bio: r?.bio ?? null, createdTs: r?.created_ts ?? 0 }
}

export function setProfile(pubkey: string, handle: unknown, bio: unknown): Profile {
  if (handle !== undefined && handle !== null) {
    const h = String(handle).trim()
    if (!/^[a-zA-Z0-9_]{2,20}$/.test(h)) throw new HttpError(400, 'handle: 2-20 letters, digits or _')
    const taken = db.prepare('SELECT pubkey FROM users WHERE handle = ? COLLATE NOCASE').get(h) as any
    if (taken && taken.pubkey !== pubkey) throw new HttpError(409, 'handle taken')
    db.prepare('UPDATE users SET handle = ? WHERE pubkey = ?').run(h, pubkey)
  }
  if (bio !== undefined) db.prepare('UPDATE users SET bio = ? WHERE pubkey = ?').run(bio === null ? null : String(bio).slice(0, 160), pubkey)
  return profile(pubkey)
}

const CHAINS = new Set(['solana', 'robinhood'])
function target(b: any): { kind: 'wallet' | 'token' | 'user'; chain: Chain; address: string } {
  if (b?.kind !== 'wallet' && b?.kind !== 'token' && b?.kind !== 'user') throw new HttpError(400, 'kind must be wallet, token or user')
  if (b.kind === 'user') {
    const address = String(b.address ?? '')
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) throw new HttpError(400, 'bad user address')
    return { kind: 'user', chain: 'solana', address }
  }
  if (!CHAINS.has(b?.chain)) throw new HttpError(400, 'unknown chain')
  const address = b.chain === 'robinhood' ? String(b.address ?? '').toLowerCase() : String(b.address ?? '')
  if (b.chain === 'robinhood' ? !/^0x[0-9a-f]{40}$/.test(address) : !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) throw new HttpError(400, 'bad address')
  return { kind: b.kind, chain: b.chain, address }
}

export function follow(user: string, body: any, on: boolean) {
  const t = target(body)
  if (on) {
    db.prepare('INSERT OR IGNORE INTO follows (user, kind, chain, address, ts) VALUES (?,?,?,?,?)').run(user, t.kind, t.chain, t.address, Date.now())
    if (t.kind === 'wallet') followedWallets.add(`${t.chain}:${t.address}`)
  } else {
    db.prepare('DELETE FROM follows WHERE user = ? AND kind = ? AND chain = ? AND address = ?').run(user, t.kind, t.chain, t.address)
    const still = db.prepare("SELECT 1 FROM follows WHERE kind = 'wallet' AND chain = ? AND address = ? LIMIT 1").get(t.chain, t.address)
    if (t.kind === 'wallet' && !still) followedWallets.delete(`${t.chain}:${t.address}`)
  }
  return follows(user)
}

export function follows(user: string) {
  return db.prepare('SELECT kind, chain, address, ts FROM follows WHERE user = ? ORDER BY ts DESC').all(user) as { kind: 'wallet' | 'token' | 'user'; chain: Chain; address: string; ts: number }[]
}

export function loadFollowedWallets() {
  for (const r of db.prepare("SELECT DISTINCT chain, address FROM follows WHERE kind = 'wallet'").all() as any[]) followedWallets.add(`${r.chain}:${r.address}`)
}

export function followersOf(kind: 'wallet' | 'token', chain: Chain, address: string): string[] {
  return (db.prepare('SELECT user FROM follows WHERE kind = ? AND chain = ? AND address = ?').all(kind, chain, address) as any[]).map(r => r.user)
}

// ---- posts ------------------------------------------------------------------

const lastPost = new Map<string, number>()

export function deleteAccount(user: string): { deleted: true } {
  const walletFollows = db.prepare("SELECT chain, address FROM follows WHERE user = ? AND kind = 'wallet'").all(user) as { chain: Chain; address: string }[]
  const keyHash = crypto.createHash('sha256').update(user).digest('hex')
  tx(() => {
    // A user's likes on other authors' posts must no longer inflate counts.
    db.prepare('UPDATE posts SET likes = MAX(0, likes - 1) WHERE user != ? AND id IN (SELECT post FROM likes WHERE user = ?)').run(user, user)
    db.prepare('DELETE FROM likes WHERE user = ? OR post IN (SELECT id FROM posts WHERE user = ?)').run(user, user)
    db.prepare('DELETE FROM posts WHERE user = ?').run(user)
    db.prepare("DELETE FROM follows WHERE user = ? OR (kind = 'user' AND address = ?)").run(user, user)
    db.prepare('DELETE FROM push_tokens WHERE user = ?').run(user)
    db.prepare('DELETE FROM users WHERE pubkey = ?').run(user)
    pruneDeletionGuards.run(Date.now() - 5 * 60_000)
    db.prepare('INSERT INTO account_deletion_guards(key_hash, deleted_ts) VALUES(?, ?) ON CONFLICT(key_hash) DO UPDATE SET deleted_ts = excluded.deleted_ts').run(keyHash, Date.now())
  })
  lastPost.delete(user)
  for (const { chain, address } of walletFollows) {
    const still = db.prepare("SELECT 1 FROM follows WHERE kind = 'wallet' AND chain = ? AND address = ? LIMIT 1").get(chain, address)
    if (!still) followedWallets.delete(`${chain}:${address}`)
  }
  return { deleted: true }
}

export function createPost(user: string, b: any): Post {
  const t = target({ kind: 'token', chain: b?.chain, address: b?.token })
  const kind = b?.kind === 'call' ? 'call' : 'comment'
  const body = String(b?.body ?? '').trim()
  if (!body || body.length > 500) throw new HttpError(400, 'body: 1-500 characters')
  const now = Date.now()
  if (now - (lastPost.get(user) ?? 0) < 5000) throw new HttpError(429, 'slow down')
  lastPost.set(user, now)
  const preGrad = kind === 'call' && !tokenGraduated(t.chain, t.address) ? 1 : 0
  const r = db.prepare('INSERT INTO posts (user, chain, token, kind, body, ts, pre_grad) VALUES (?,?,?,?,?,?,?)').run(user, t.chain, t.address, kind, body, now, preGrad)
  return getPost(Number(r.lastInsertRowid), user)!
}

const postSelect = `SELECT p.*, u.handle, u.bio, u.created_ts AS u_created, t.symbol AS t_symbol, t.name AS t_name, t.image AS t_image
  FROM posts p LEFT JOIN users u ON u.pubkey = p.user LEFT JOIN tokens t ON t.chain = p.chain AND t.address = p.token`

function rowToPost(r: any, viewer?: string | null): Post {
  return {
    id: r.id, chain: r.chain, token: r.token, kind: r.kind, body: r.body, ts: r.ts, likes: r.likes,
    author: { pubkey: r.user, handle: r.handle ?? null, bio: r.bio ?? null, createdTs: r.u_created ?? 0 },
    liked: viewer ? !!db.prepare('SELECT 1 FROM likes WHERE user = ? AND post = ?').get(viewer, r.id) : undefined,
    tokenMeta: r.t_symbol || r.t_name ? { symbol: r.t_symbol ?? undefined, name: r.t_name ?? undefined, image: r.t_image ?? undefined } : undefined,
    hit: r.kind === 'call' && r.pre_grad ? r.hit === 1 : undefined,
  }
}

export function getPost(id: number, viewer?: string | null): Post | null {
  const r = db.prepare(`${postSelect} WHERE p.id = ?`).get(id)
  return r ? rowToPost(r, viewer) : null
}

export function listPosts(q: { chain?: string; token?: string; user?: string; following?: string; kind?: 'call' | 'comment'; before?: number; limit?: number; viewer?: string | null }): Post[] {
  const where: string[] = []
  const args: any[] = []
  if (q.chain && q.token) { where.push('p.chain = ? AND p.token = ?'); args.push(q.chain, q.token) }
  if (q.user) { where.push('p.user = ?'); args.push(q.user) }
  if (q.following) { where.push("(p.user = ? OR p.user IN (SELECT address FROM follows WHERE user = ? AND kind = 'user'))"); args.push(q.following, q.following) }
  if (q.kind) { where.push('p.kind = ?'); args.push(q.kind) }
  if (q.before) { where.push('p.ts < ?'); args.push(q.before) }
  const sql = `${postSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.ts DESC LIMIT ?`
  args.push(Math.min(q.limit ?? 50, 200))
  return (db.prepare(sql).all(...args) as any[]).map(r => rowToPost(r, q.viewer))
}

export function like(user: string, id: number, on: boolean): Post {
  if (!getPost(id)) throw new HttpError(404, 'no such post')
  if (on) {
    const r = db.prepare('INSERT OR IGNORE INTO likes (user, post) VALUES (?, ?)').run(user, id)
    if (r.changes) db.prepare('UPDATE posts SET likes = likes + 1 WHERE id = ?').run(id)
  } else {
    const r = db.prepare('DELETE FROM likes WHERE user = ? AND post = ?').run(user, id)
    if (r.changes) db.prepare('UPDATE posts SET likes = likes - 1 WHERE id = ?').run(id)
  }
  return getPost(id, user)!
}

export function callers(limit = 50) {
  const rows = db.prepare(`SELECT p.user, COUNT(*) AS calls, SUM(CASE WHEN p.hit = 1 THEN 1 ELSE 0 END) AS hits, u.handle, u.bio, u.created_ts
    FROM posts p LEFT JOIN users u ON u.pubkey = p.user WHERE p.kind = 'call' AND p.pre_grad = 1
    GROUP BY p.user ORDER BY hits DESC, calls DESC LIMIT ?`).all(limit) as any[]
  return rows.map(r => ({ profile: { pubkey: r.user, handle: r.handle ?? null, bio: r.bio ?? null, createdTs: r.created_ts ?? 0 }, calls: r.calls, hits: r.hits, hitRate: r.calls ? r.hits / r.calls : 0 }))
}

export function registerPush(user: string, b: any) {
  const token = String(b?.token ?? '')
  if (!/^ExponentPushToken\[.+\]$|^ExpoPushToken\[.+\]$/.test(token)) throw new HttpError(400, 'expected an Expo push token')
  db.prepare('INSERT INTO push_tokens (token, user, platform, ts) VALUES (?,?,?,?) ON CONFLICT(token) DO UPDATE SET user = excluded.user, ts = excluded.ts').run(token, user, String(b?.platform ?? ''), Date.now())
  return { ok: true }
}
