import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ftl-pool-funding-'))
process.env.DATA_DIR = tmp
const { db } = await import('../src/db.ts')

const insertPool = db.prepare(`INSERT INTO pools
  (chain,address,venue,token,quote,created_ts,funded) VALUES ('solana',?, 'test',?, 'So11111111111111111111111111111111111111112',1000,0)`)
const insertToken = db.prepare(`INSERT INTO tokens
  (chain,address,pools,funded_pools,score) VALUES ('solana',?,1,0,1)`)
const insertEvent = db.prepare(`INSERT INTO events
  (id,chain,kind,stage,lane,venue,ix,pool,token,wallet,amounts,tx,slot,ts,confirmed_ts,flags)
  VALUES (?, 'solana','pool_init','confirmed','helius-parsed','test','init',?,?,'wallet','[]',?,1,1000,1000,?)`)
insertPool.run('historic-funded-pool', 'historic-funded-token')
insertToken.run('historic-funded-token')
insertEvent.run('historic-funded-event', 'historic-funded-pool', 'historic-funded-token', 'historic-funded-tx', '[]')
insertPool.run('historic-ladder-pool', 'historic-ladder-token')
insertToken.run('historic-ladder-token')
insertEvent.run('historic-ladder-event', 'historic-ladder-pool', 'historic-ladder-token', 'historic-ladder-tx', '["ladder"]')

const { getToken, ingest, rowToPool } = await import('../src/hub.ts')
after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

function pool(address: string) {
  const row = db.prepare('SELECT * FROM pools WHERE chain = ? AND address = ?').get('solana', address)
  return row ? rowToPool(row) : null
}

test('repairs confirmed initially funded pools without funding ladder pools', () => {
  assert.equal(pool('historic-funded-pool')?.funded, true)
  assert.equal(getToken('solana', 'historic-funded-token')?.fundedPools, 1)
  assert.equal(getToken('solana', 'historic-funded-token')?.score, 3)
  assert.equal(pool('historic-ladder-pool')?.funded, false)
  assert.equal(getToken('solana', 'historic-ladder-token')?.fundedPools, 0)
})

test('persists initial funding in the pool row without counting a separate add', () => {
  const token = '7rLy8n6iETLdQrWgpv8XejNjLwrhKHNDrwb2kibnpump'
  ingest({ chain: 'solana', kind: 'pool_init', venue: 'test', ix: 'init',
    pool: 'new-funded-pool', mints: [token, 'So11111111111111111111111111111111111111112'],
    wallet: 'wallet', tx: 'funded-tx', n: '0', slot: 2, lane: 'helius-parsed', stage: 'confirmed',
    noLiquidity: false, at: 2000 })
  assert.equal(pool('new-funded-pool')?.funded, true)
  assert.equal(pool('new-funded-pool')?.liqEvents, 0)
  assert.equal(getToken('solana', token)?.fundedPools, 1)

  ingest({ chain: 'solana', kind: 'pool_init', venue: 'test', ix: 'init',
    pool: 'new-ladder-pool', mints: [token, 'So11111111111111111111111111111111111111112'],
    wallet: 'wallet', tx: 'ladder-tx', n: '0', slot: 3, lane: 'helius-parsed', stage: 'confirmed',
    noLiquidity: true, at: 3000 })
  assert.equal(pool('new-ladder-pool')?.funded, false)
  assert.equal(getToken('solana', token)?.fundedPools, 1)
})
