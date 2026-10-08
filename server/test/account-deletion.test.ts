import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { once } from 'node:events'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import nacl from 'tweetnacl'
import bs58 from 'bs58'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ftl-delete-account-'))
process.env.DATA_DIR = tmp
const { db } = await import('../src/db.ts')
const { followedWallets } = await import('../src/hub.ts')
const { startApi } = await import('../src/api.ts')
const owner = nacl.sign.keyPair()
const other = nacl.sign.keyPair()
const user = bs58.encode(owner.publicKey)
const otherUser = bs58.encode(other.publicKey)
const wallet = bs58.encode(nacl.sign.keyPair().publicKey)

db.prepare('INSERT INTO users(pubkey,handle,created_ts) VALUES(?,?,?)').run(user, 'deleteme', 1)
db.prepare('INSERT INTO users(pubkey,handle,created_ts) VALUES(?,?,?)').run(otherUser, 'stays', 1)
db.prepare("INSERT INTO posts(user,chain,token,kind,body,ts,likes) VALUES(?,'solana','token','comment','my post',1,1)").run(user)
db.prepare("INSERT INTO posts(user,chain,token,kind,body,ts,likes) VALUES(?,'solana','token','comment','other post',2,1)").run(otherUser)
const ownPost = (db.prepare('SELECT id FROM posts WHERE user = ?').get(user) as { id: number }).id
const otherPost = (db.prepare('SELECT id FROM posts WHERE user = ?').get(otherUser) as { id: number }).id
db.prepare('INSERT INTO likes(user,post) VALUES(?,?)').run(otherUser, ownPost)
db.prepare('INSERT INTO likes(user,post) VALUES(?,?)').run(user, otherPost)
db.prepare("INSERT INTO follows(user,kind,chain,address,ts) VALUES(?,'wallet','solana',?,1)").run(user, wallet)
db.prepare("INSERT INTO follows(user,kind,chain,address,ts) VALUES(?,'user','solana',?,1)").run(otherUser, user)
db.prepare("INSERT INTO push_tokens(token,user,platform,ts) VALUES('ExpoPushToken[x]',?,'ios',1)").run(user)
followedWallets.add(`solana:${wallet}`)

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

function headers(method: string, route: string, body: string, ts = Date.now()) {
  const hash = crypto.createHash('sha256').update(body).digest('hex')
  const msg = new TextEncoder().encode(`FTL\n${method}\n${route}\n${ts}\n${hash}`)
  return { 'content-type': 'application/json', 'x-ftl-pubkey': user,
    'x-ftl-ts': String(ts), 'x-ftl-sig': bs58.encode(nacl.sign.detached(msg, owner.secretKey)) }
}

test('account deletion requires the route-bound signature and removes only that account data', async () => {
  const route = '/api/account/delete'
  const body = '{}'
  const unsigned = await fetch(base + route, { method: 'POST', body })
  assert.equal(unsigned.status, 401)
  const wrongRoute = await fetch(base + route, { method: 'POST', body,
    headers: headers('POST', '/api/me', body) })
  assert.equal(wrongRoute.status, 401)
  assert.ok(db.prepare('SELECT 1 FROM users WHERE pubkey = ?').get(user))

  const oldTs = Date.now()
  const deleted = await fetch(base + route, { method: 'POST', body,
    headers: headers('POST', route, body, oldTs) })
  assert.equal(deleted.status, 200)
  assert.deepEqual(await deleted.json(), { deleted: true })
  for (const [table, column] of [['users','pubkey'], ['posts','user'], ['likes','user'], ['follows','user'], ['push_tokens','user']])
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(user) as { n: number }).n, 0)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM likes WHERE post = ?').get(ownPost) as { n: number }).n, 0)
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM follows WHERE kind = 'user' AND address = ?").get(user) as { n: number }).n, 0)
  assert.equal((db.prepare('SELECT likes FROM posts WHERE id = ?').get(otherPost) as { likes: number }).likes, 0)
  assert.ok(db.prepare('SELECT 1 FROM users WHERE pubkey = ?').get(otherUser))
  assert.equal(followedWallets.has(`solana:${wallet}`), false)

  // An in-flight signed write from before deletion must not recreate the user.
  const replay = await fetch(base + '/api/me', { method: 'POST', body,
    headers: headers('POST', '/api/me', body, oldTs) })
  assert.equal(replay.status, 401)
  assert.equal(db.prepare('SELECT 1 FROM users WHERE pubkey = ?').get(user), undefined)
})
