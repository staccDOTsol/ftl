import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decode } from '../src/solana/decode.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ftl-dbc-identity-'))
process.env.DATA_DIR = tmp
const { db } = await import('../src/db.ts')
const { ingest, getToken, lookupPool } = await import('../src/hub.ts')
after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }) })
const idl = JSON.parse(fs.readFileSync(new URL('../idl/meteora_dbc.json', import.meta.url), 'utf8'))
const base = '53cTDPa69sUXtn4FiuXiKEipJGkUUaNxoisBiuSFkd5i'
const quote = 'BQDMYwgnWr9UBcUCvLX67yXriTVe1bkPEiTQ1TzKpump'
const pool = '8PeDEXsgwjkcweEJfYwYgfPJ9kohjJr446UJQQg5wJjo'

test('DBC launch preserves virtual pool and explicit base/quote roles for two memes', () => {
  const ix = idl.instructions.find((v: any) => v.name === 'initialize_virtual_pool_with_spl_token')
  const keys = ix.accounts.map((a: any) => a.name === 'base_mint' ? base : a.name === 'quote_mint' ? quote : a.name === 'pool' ? pool : `${a.name}-fixture`)
  const events = decode({ sig: 'dbc-launch-fixture', slot: 42, keys, ixs: [{ prog: idl.address, accts: keys.map((_: any, i: number) => i), data: Uint8Array.from(ix.discriminator), n: '0' }] }, 'geyser', 'confirmed')
  assert.equal(events.length, 1)
  assert.equal(events[0].pool, pool)
  assert.deepEqual(events[0].mints, [base, quote])
  assert.equal(events[0].baseMint, base); assert.equal(events[0].quoteMint, quote)
  ingest(events[0])
  const row = db.prepare('SELECT token, quote, pool FROM events WHERE tx = ?').get('dbc-launch-fixture') as any
  assert.deepEqual({ ...row }, { token: base, quote, pool })
  assert.equal(lookupPool('solana', pool)?.quote, quote)
  assert.equal(getToken('solana', base)?.pools, 1)
  assert.equal(getToken('solana', base)?.fundedPools, 0)
})
