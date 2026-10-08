import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The stream runs in a worker, so the SDK stub has to load inside it: workers
// inherit execArgv, and the harness process is started with --import <stub>.
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ftl-blocktime-thread-'))
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const MINT = 'So11111111111111111111111111111111111111112'
const SECOND_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

const stub = `
import { createRequire } from 'node:module'
const sdk = createRequire(${JSON.stringify(path.join(server, 'package.json'))})('helius-laserstream')
sdk.subscribe = async (_config, request, callback) => {
  const name = Object.keys(request.blocksMeta)[0]
  const now = Date.now()
  const key = n => new Uint8Array(32).fill(n)
  setTimeout(() => {
    callback({ filters: [name], slot: { slot: 100, status: 2 }, createdAt: new Date(now) })
    callback({ filters: [name], createdAt: new Date(now), blockMeta: {
      slot: 100, parentSlot: 99, blockhash: 'block-100', blockTime: { timestamp: Math.floor(now / 1000) } } })
    const balance = amount => ({ accountIndex: 3, mint: ${JSON.stringify(MINT)}, owner: 'owner',
      programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWpvsJr2LNY3eHnCwF', uiTokenAmount: { amount, uiAmountString: 'x' } })
    callback({ filters: [name], transaction: { slot: 100, transaction: { index: 7, signature: new Uint8Array(64),
      transaction: { message: { accountKeys: [key(1), key(2)] } },
      meta: { logMessages: ['big'], loadedWritableAddresses: [key(3)], loadedReadonlyAddresses: [key(4)],
        preTokenBalances: [balance('5')], postTokenBalances: [balance('9')] } } } })
  }, 50)
  return { write: async () => {}, cancel: () => {} }
}
`
const harness = `
const { db } = await import(${JSON.stringify(path.join(server, 'src/db.ts'))})
const { bus } = await import(${JSON.stringify(path.join(server, 'src/hub.ts'))})
const thread = await import(${JSON.stringify(path.join(server, 'src/solana/blocktime-thread.ts'))})
db.prepare('INSERT INTO research_tokens(chain,address,first_seen_ts) VALUES(?,?,?)').run('solana', ${JSON.stringify(MINT)}, Date.now())
const calls = []
const stop = await thread.startBlockTimeStream({
  onConnection: (connected) => calls.push(['connection', connected]),
  onStream: e => { if (e.t !== 'pulse') calls.push(['stream', e.t, e.token ?? null]) },
  onHolderTransaction: update => calls.push(['holder', update]),
})
const until = async (check) => { for (let i = 0; i < 100 && !check(); i++) await new Promise(r => setTimeout(r, 50)) }
await until(() => calls.some(c => c[0] === 'holder'))
const fallback = await thread.setFallbackPrograms([])
bus.emit('research', 'solana', ${JSON.stringify(SECOND_MINT)}, true)
await until(() => thread.blockTimeUsage().trackedMints === 2)
const usage = thread.blockTimeUsage()
stop()
const replacer = (_k, v) => v instanceof Uint8Array ? { bytes: Array.from(v) } : v
console.log('RESULT ' + JSON.stringify({ calls, fallback, usage }, replacer))
process.exit(0)
`
fs.writeFileSync(path.join(tmp, 'stub.mjs'), stub)
fs.writeFileSync(path.join(tmp, 'harness.mjs'), harness)

test('the research stream runs in a worker and replays callbacks on the main thread in order', () => {
  const run = spawnSync(process.execPath, ['--no-warnings', '--import', path.join(tmp, 'stub.mjs'), path.join(tmp, 'harness.mjs')], {
    env: { ...process.env, DATA_DIR: path.join(tmp, 'data'), HELIUS_API_KEY: 'test-key-never-sent' },
    encoding: 'utf8', timeout: 30_000,
  })
  const line = run.stdout.split('\n').find(l => l.startsWith('RESULT '))
  assert.ok(line, `no result; status=${run.status}\n${run.stdout}\n${run.stderr}`)
  const { calls, fallback, usage } = JSON.parse(line.slice('RESULT '.length))

  const order = calls.map((c: any[]) => c[0] === 'holder' ? 'holder' : c.join(':'))
  const connected = order.indexOf('connection:true'), opened = order.indexOf(`stream:open:${MINT}`), holder = order.indexOf('holder')
  assert.ok(connected >= 0 && opened > connected && holder > opened, order.join(' | '))

  // The holder update keeps what onHolderTransaction reads, nothing else.
  const update = calls[holder][1]
  assert.equal(update.slot, 100)
  assert.equal(update.transaction.index, 7)
  assert.equal(update.transaction.meta.err, undefined)
  assert.equal(update.transaction.meta.logMessages, undefined)
  assert.deepEqual(update.transaction.meta.preTokenBalances[0], { accountIndex: 3, mint: MINT, owner: 'owner',
    programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWpvsJr2LNY3eHnCwF', uiTokenAmount: { amount: '5' } })
  assert.equal(update.transaction.meta.postTokenBalances[0].uiTokenAmount.amount, '9')
  // Static keys are 0-1, loaded writable 2, loaded readonly 3; only the indexed key is sent.
  const keys = update.transaction.transaction.message.accountKeys
  assert.deepEqual(keys[3], { bytes: new Array(32).fill(4) })
  assert.equal(keys.filter((k: unknown) => k).length, 1)

  assert.equal(fallback, true)
  assert.equal(usage.connected, true)
  assert.equal(usage.trackedMints, 2)
})
