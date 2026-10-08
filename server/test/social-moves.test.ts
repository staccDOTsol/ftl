import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import nacl from 'tweetnacl'
import bs58 from 'bs58'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ftl-social-moves-'))
process.env.DATA_DIR = tmp
const { db } = await import('../src/db.ts')
const { createPost, getPost, listPosts, parseMove, parseTx, HttpError } = await import('../src/social.ts')
const { poolWallets } = await import('../src/pool-crowd.ts')
const { startApi } = await import('../src/api.ts')

const key = (byte: number) => bs58.encode(Buffer.alloc(32, byte))
const sig = (byte: number) => bs58.encode(Buffer.alloc(64, byte))   // 64 bytes -> 86-88 base58 chars
const token = key(7)
const pool = key(8)
const SOL = 'So11111111111111111111111111111111111111112'
// createPost rate-limits one post per user per 5 s, so each case writes as its own user
let n = 100
const user = () => key(n++)
const move = () => ({ venue: 'raydium-clmm', operation: 'add', pool, amounts: [{ mint: token, amount: '1234.5', symbol: 'FTL' }, { mint: SOL, amount: '0.25', symbol: 'SOL' }] })

const server = startApi(0)
await once(server, 'listening')
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
after(async () => {
  server.closeAllConnections()
  server.close()
  await once(server, 'close')
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('posts schema carries nullable tx and move columns', () => {
  const cols = (db.prepare('PRAGMA table_info(posts)').all() as { name: string; notnull: number }[])
  assert.deepEqual(cols.filter(c => c.name === 'tx' || c.name === 'move').map(c => [c.name, c.notnull]), [['tx', 0], ['move', 0]])
})

test('createPost stores a valid tx and move and returns them on the post', () => {
  const tx = sig(1)
  const p = createPost(user(), { chain: 'solana', token, kind: 'comment', body: 'Added liquidity to $FTL on Raydium CLMM', tx, move: move() })
  assert.equal(p.tx, tx)
  assert.deepEqual(p.move, move())
  assert.deepEqual(getPost(p.id)?.move, move())
  assert.equal(listPosts({ chain: 'solana', token }).find(x => x.id === p.id)?.tx, tx)
  const plain = createPost(user(), { chain: 'solana', token, kind: 'comment', body: 'no move here' })
  assert.equal(plain.tx, undefined)
  assert.equal(plain.move, undefined)
  assert.equal((db.prepare('SELECT tx, move FROM posts WHERE id = ?').get(plain.id) as any).move, null)
})

test('createPost rejects a bad signature', () => {
  for (const bad of ['abc', sig(1).slice(0, 60), sig(1) + '0', 'O'.repeat(85), 42]) {
    assert.throws(() => createPost(user(), { chain: 'solana', token, body: 'x', tx: bad }), (e: any) => e instanceof HttpError && e.status === 400 && /tx/.test(e.message))
  }
  assert.equal(parseTx(''), undefined)
  assert.equal(parseTx(undefined), undefined)
})

test('createPost rejects a bad venue, operation, pool, or more than four amounts', () => {
  const reject = (m: any, re: RegExp) => assert.throws(() => createPost(user(), { chain: 'solana', token, body: 'x', tx: sig(2), move: m }), (e: any) => e instanceof HttpError && e.status === 400 && re.test(e.message))
  reject({ ...move(), venue: 'uniswap-v4' }, /venue/)
  reject({ ...move(), venue: undefined }, /venue/)
  reject({ ...move(), operation: 'burn' }, /operation/)
  reject({ ...move(), pool: 'not-an-address' }, /pool/)
  reject({ ...move(), amounts: Array.from({ length: 5 }, () => ({ mint: SOL, amount: '1' })) }, /amounts/)
  reject({ ...move(), amounts: [{ mint: SOL, amount: 1 }] }, /decimal/)
  reject({ ...move(), amounts: [{ mint: SOL, amount: '1e9' }] }, /decimal/)
  reject({ ...move(), amounts: [{ mint: 'x', amount: '1' }] }, /mint/)
  reject({ ...move(), amounts: [{ mint: SOL, amount: '1', symbol: 'this symbol is far too long' }] }, /symbol/)
  reject('swap', /object/)
  assert.deepEqual(parseMove({ venue: 'swap', operation: 'swap' }), { venue: 'swap', operation: 'swap' })
  assert.deepEqual(parseMove({ venue: 'orca', operation: 'remove', pool, amounts: [] }), { venue: 'orca', operation: 'remove', pool, amounts: [] })
  // four amounts is the limit, not three
  assert.equal(parseMove({ venue: 'swap', operation: 'swap', amounts: Array.from({ length: 4 }, () => ({ mint: SOL, amount: '1' })) })?.amounts?.length, 4)
})

test('pool wallets come from the events table, sorted by adds then recency, with follower counts', async () => {
  const insertEvent = db.prepare(`INSERT INTO events
    (id,chain,kind,stage,lane,venue,ix,pool,token,wallet,amounts,tx,slot,ts,confirmed_ts,flags)
    VALUES (?, 'solana',?,'confirmed','helius-parsed','raydium-clmm','ix',?,?,?,'[]',?,1,?,?,'[]')`)
  const [creator, adder, puller, elsewhere, viewer, fan] = [key(21), key(22), key(23), key(24), key(31), key(32)]
  let i = 0
  const ev = (kind: string, wallet: string, ts: number, at = pool) => insertEvent.run(`e${i++}`, kind, at, token, wallet, `tx${i}`, ts, ts)
  ev('pool_init', creator, 1000)
  ev('liq_add', creator, 2000)
  ev('liq_add', adder, 3000)
  ev('liq_add', adder, 4000)
  ev('liq_remove', adder, 5000)
  ev('liq_remove', puller, 6000)
  ev('liq_add', elsewhere, 7000, key(9))        // another pool: must not appear
  ev('launch', key(25), 8000)                   // not a liquidity move: must not appear
  db.prepare("INSERT INTO follows(user,kind,chain,address,ts) VALUES(?,'wallet','solana',?,1)").run(viewer, adder)
  db.prepare("INSERT INTO follows(user,kind,chain,address,ts) VALUES(?,'wallet','solana',?,1)").run(fan, adder)
  db.prepare("INSERT INTO follows(user,kind,chain,address,ts) VALUES(?,'wallet','solana',?,1)").run(fan, creator)
  db.prepare("INSERT INTO follows(user,kind,chain,address,ts) VALUES(?,'token','solana',?,1)").run(fan, adder) // a token follow of the same address does not count

  const direct = poolWallets('solana', pool, viewer)
  assert.deepEqual(direct, [
    { address: adder, adds: 2, pulls: 1, lastTs: 5000, followers: 2, followed: true },
    { address: creator, adds: 2, pulls: 0, lastTs: 2000, followers: 1, followed: false },
    { address: puller, adds: 0, pulls: 1, lastTs: 6000, followers: 0, followed: false },
  ])
  assert.deepEqual(poolWallets('solana', pool, null).map(w => w.followed), [false, false, false])
  assert.throws(() => poolWallets('solana', 'nope', null), (e: any) => e instanceof HttpError && e.status === 400)

  const r = await fetch(`${base}/api/pool/solana/${pool}/wallets?viewer=${viewer}`)
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), direct)
  const anon = await (await fetch(`${base}/api/pool/solana/${pool}/wallets`)).json() as { followed: boolean }[]
  assert.deepEqual(anon.map(w => w.followed), [false, false, false])
  assert.deepEqual(await (await fetch(`${base}/api/pool/solana/${key(10)}/wallets`)).json(), [])
  assert.equal((await fetch(`${base}/api/pool/solana/${pool}/wallets/extra`)).status, 404)
  assert.equal((await fetch(`${base}/api/pool/solana/bad-address/wallets`)).status, 400)
})

test('pool wallets are capped at 30', () => {
  const insertEvent = db.prepare(`INSERT INTO events
    (id,chain,kind,stage,lane,venue,ix,pool,token,wallet,amounts,tx,slot,ts,confirmed_ts,flags)
    VALUES (?, 'solana','liq_add','confirmed','helius-parsed','orca','ix',?,?,?,'[]',?,1,?,?,'[]')`)
  const big = key(11)
  for (let w = 0; w < 35; w++) insertEvent.run(`big${w}`, big, token, bs58.encode(Buffer.alloc(32, 200 + w % 50)).slice(0, 44), `bigtx${w}`, w, w)
  assert.equal(poolWallets('solana', big, null).length, 30)
})
