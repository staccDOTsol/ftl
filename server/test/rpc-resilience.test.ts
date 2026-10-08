import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Connection, PublicKey } from '@solana/web3.js'
import { RPC_MEMO, RPC_RETRY, RpcCooldownError, RpcTransientError, concurrencyLimit, createBackgroundRpc,
  createResilientFetch, isTransientRpcError, rpcScope, runInRpcScope } from '../src/solana/rpc-resilience.ts'

const URL_WITH_KEY = 'https://rpc.example/?api-key=private-key'
const body = (method: string, params: unknown[] = [], id: unknown = 1) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params })
const ok = (id: unknown, result: unknown = 1) => Response.json({ jsonrpc: '2.0', id, result })
const fakeClock = () => {
  let t = 1_000_000
  return { now: () => t, advance: (ms: number) => { t += ms }, sleeps: [] as number[] }
}
function harness(statuses: Array<number | 'network' | { status: number; retryAfter: string }>) {
  const clock = fakeClock()
  const calls: any[] = []
  const wrapped = createResilientFetch({
    now: clock.now, random: () => 0.5,
    sleep: async ms => { clock.sleeps.push(ms); clock.advance(ms) },
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      calls.push(request)
      const next = statuses.length > 1 ? statuses.shift()! : statuses[0]
      if (next === 'network') throw new TypeError('fetch failed: connect ECONNREFUSED rpc.example')
      if (typeof next === 'object') return new Response('slow down', { status: next.status, headers: { 'retry-after': next.retryAfter } })
      return next === 200 ? ok(request.id, 'fresh') : new Response('busy', { status: next })
    },
  })
  return { wrapped, calls, clock }
}

test('retry: a 429 then success returns the success after one jittered backoff', async () => {
  const { wrapped, calls, clock } = harness([429, 200])
  const r = await wrapped(URL_WITH_KEY, { method: 'POST', body: body('getSlot') })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).result, 'fresh')
  assert.equal(calls.length, 2)
  // 250 ms base scaled by the 0.5–1.0 jitter factor (random() = 0.5 → 0.75).
  assert.deepEqual(clock.sleeps, [Math.round(RPC_RETRY.baseDelayMs * 0.75)])
})

test('retry: retry-after is honored, and one past the budget gives up at once', async () => {
  const honored = harness([{ status: 429, retryAfter: '1' }, 200])
  assert.equal((await honored.wrapped(URL_WITH_KEY, { method: 'POST', body: body('getSlot') })).status, 200)
  assert.deepEqual(honored.clock.sleeps, [1000])

  const tooLong = harness([{ status: 429, retryAfter: '5' }])
  await assert.rejects(tooLong.wrapped(URL_WITH_KEY, { method: 'POST', body: body('getSlot') }), RpcTransientError)
  assert.equal(tooLong.calls.length, 1)
  assert.deepEqual(tooLong.clock.sleeps, [])
})

test('retry: gives up after 3 attempts within ~1.5 s and classifies the failure as transient, URL-free', async () => {
  for (const failure of [503, 429, 'network'] as const) {
    const { wrapped, calls, clock } = harness([failure])
    const error = await wrapped(URL_WITH_KEY, { method: 'POST', body: body('getSlot') }).then(() => null, e => e)
    assert.ok(error instanceof RpcTransientError)
    assert.equal(isTransientRpcError(error), true)
    assert.equal(calls.length, RPC_RETRY.attempts)
    assert.ok(clock.sleeps.reduce((a, b) => a + b, 0) <= RPC_RETRY.budgetMs)
    assert.equal(String(error.message).includes('private-key'), false)
    assert.equal(String(error.message).includes('rpc.example'), false)
  }
  // Non-retryable statuses pass straight through.
  const forbidden = harness([403])
  assert.equal((await forbidden.wrapped(URL_WITH_KEY, { method: 'POST', body: body('getSlot') })).status, 403)
  assert.equal(forbidden.calls.length, 1)
  // SDKs re-wrap errors into strings; the classification survives that.
  assert.equal(isTransientRpcError(new Error(`failed to get info about account X: ${new RpcTransientError(429)}`)), true)
  assert.equal(isTransientRpcError(new Error('Pool cannot fill this amount')), false)
})

test('dedupe: identical in-flight JSON-RPC reads share one upstream request, each caller keeps its id', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let upstream = 0
  const wrapped = createResilientFetch({ fetch: async (_u, init) => {
    upstream++
    await gate
    return ok(JSON.parse(String(init?.body)).id, { value: 7 })
  } })
  const a = wrapped(URL_WITH_KEY, { method: 'POST', body: body('getSlot', [], 'a') })
  const b = wrapped(URL_WITH_KEY, { method: 'POST', body: body('getSlot', [], 'b') })
  assert.equal(wrapped.inflightSize, 1)
  release()
  const [ra, rb] = await Promise.all([a, b])
  assert.equal(upstream, 1)
  assert.equal((await ra.json()).id, 'a')
  assert.equal((await rb.json()).id, 'b')
  assert.equal(wrapped.inflightSize, 0)
})

test('memo: two pool reads within the TTL hit RPC once; expiry refetches; only inside a memo scope', async () => {
  const clock = fakeClock()
  const methods: string[] = []
  const wrapped = createResilientFetch({ now: clock.now, fetch: async (_u, init) => {
    const request = JSON.parse(String(init?.body))
    methods.push(request.method)
    return ok(request.id, { context: { slot: 1 }, value: null })
  } })
  const read = (id: number) => wrapped(URL_WITH_KEY, { method: 'POST', body: body('getAccountInfo', ['Pool111', { encoding: 'base64' }], id) })
  const scope = rpcScope({ memo: true })
  await runInRpcScope(scope, async () => {
    await read(1)
    const second = await read(2)
    assert.equal((await second.json()).id, 2)
  })
  assert.equal(methods.length, 1)
  assert.equal(wrapped.memoSize, 1)
  clock.advance(RPC_MEMO.ttlMs + 1)
  await runInRpcScope(rpcScope({ memo: true }), () => read(3))
  assert.equal(methods.length, 2)
  // Outside a memo scope (swap building for a wallet) nothing is served from the memo.
  await read(4); await read(5)
  assert.equal(methods.length, 4)
})

test('memo: wallet balance and token-account reads are never memoized, even inside a memo scope', async () => {
  const methods: string[] = []
  const wrapped = createResilientFetch({ fetch: async (_u, init) => {
    const request = JSON.parse(String(init?.body))
    methods.push(request.method)
    return ok(request.id, { context: { slot: 1 }, value: 5 })
  } })
  await runInRpcScope(rpcScope({ memo: true }), async () => {
    for (const method of ['getBalance', 'getTokenAccountsByOwner', 'getTokenAccountBalance']) {
      await wrapped(URL_WITH_KEY, { method: 'POST', body: body(method, ['Wallet111'], 1) })
      await wrapped(URL_WITH_KEY, { method: 'POST', body: body(method, ['Wallet111'], 2) })
    }
  })
  assert.equal(methods.length, 6)
  assert.equal(wrapped.memoSize, 0)
})

test('memo: bounded entry count evicts the oldest entries', async () => {
  const wrapped = createResilientFetch({ memoMaxEntries: 3, fetch: async (_u, init) =>
    ok(JSON.parse(String(init?.body)).id, { context: { slot: 1 }, value: null }) })
  await runInRpcScope(rpcScope({ memo: true }), async () => {
    for (let i = 0; i < 10; i++) await wrapped(URL_WITH_KEY, { method: 'POST', body: body('getAccountInfo', [`P${i}`]) })
  })
  assert.equal(wrapped.memoSize, 3)
})

test('a web3.js Connection works through the wrapper: memoized getAccountInfo, transient give-up classified', async () => {
  const methods: string[] = []
  let fail = false
  const wrapped = createResilientFetch({ sleep: async () => {}, fetch: async (_u, init) => {
    const request = JSON.parse(String(init?.body))
    methods.push(request.method)
    if (fail) return new Response('Too many requests', { status: 429 })
    return ok(request.id, { context: { slot: 9 }, value: { data: ['', 'base64'], executable: false,
      lamports: 1, owner: '11111111111111111111111111111111', rentEpoch: 0, space: 0 } })
  } })
  const connection = new Connection(URL_WITH_KEY, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: wrapped as any })
  const pool = new PublicKey('53cTDPa69sUXtn4FiuXiKEipJGkUUaNxoisBiuSFkd5i')
  const scope = rpcScope({ memo: true })
  await runInRpcScope(scope, async () => {
    assert.equal((await connection.getAccountInfo(pool))?.lamports, 1)
    assert.equal((await connection.getAccountInfo(pool))?.lamports, 1)
  })
  assert.deepEqual(methods, ['getAccountInfo'])
  fail = true
  const failing = rpcScope({ memo: true })
  const error = await runInRpcScope(failing, () => connection.getAccountInfo(new PublicKey('So11111111111111111111111111111111111111112')))
    .then(() => null, e => e)
  assert.ok(error)
  assert.equal(isTransientRpcError(error), true)
  assert.equal(failing.transient, 1)
  assert.equal(String(error.message).includes('private-key'), false)
})

test('concurrency limit never runs more than the cap at once', async () => {
  const limit = concurrencyLimit(2)
  let active = 0, peak = 0
  await Promise.all(Array.from({ length: 7 }, () => limit(async () => {
    active++; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 2))
    active--
  })))
  assert.equal(peak, 2)
  assert.equal(limit.active, 0)
})

test('background RPC: a 429 starts a 30 s cooldown with no retry; no request starts until it ends', async () => {
  const clock = fakeClock()
  let upstream = 0, status = 429
  const rpc = createBackgroundRpc({ concurrency: 2, cooldownMs: 30_000, now: clock.now, sleep: async () => {},
    fetch: async (_u, init) => { upstream++; return status === 200 ? ok(JSON.parse(String(init?.body)).id) : new Response('', { status }) } })
  const init = () => ({ method: 'POST', body: body('getMultipleAccounts', [['M1']]) })
  await assert.rejects(rpc.call(URL_WITH_KEY, init()), RpcTransientError)
  assert.equal(upstream, 1) // the 429 is not retried while cooling down
  assert.equal(rpc.coolingDown(), true)
  status = 200
  await assert.rejects(rpc.call(URL_WITH_KEY, init()), RpcCooldownError)
  clock.advance(29_999)
  await assert.rejects(rpc.call(URL_WITH_KEY, init()), RpcCooldownError)
  assert.equal(upstream, 1)
  clock.advance(2)
  assert.equal(rpc.coolingDown(), false)
  assert.equal((await rpc.call(URL_WITH_KEY, init())).status, 200)
  assert.equal(upstream, 2)
  // 5xx still gets the bounded backoff and does not trip the cooldown.
  let flaky = 0
  const retrying = createBackgroundRpc({ concurrency: 2, cooldownMs: 30_000, now: clock.now, sleep: async () => {},
    fetch: async (_u, init) => ++flaky === 1 ? new Response('', { status: 502 }) : ok(JSON.parse(String(init?.body)).id) })
  assert.equal((await retrying.call(URL_WITH_KEY, init())).status, 200)
  assert.equal(flaky, 2)
  assert.equal(retrying.coolingDown(), false)
})

test('background RPC caps metadata requests at 2 in flight', async () => {
  let active = 0, peak = 0
  const rpc = createBackgroundRpc({ concurrency: 2, cooldownMs: 30_000, fetch: async (_u, init) => {
    active++; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 2))
    active--
    return ok(JSON.parse(String(init?.body)).id)
  } })
  await Promise.all(Array.from({ length: 6 }, (_, i) =>
    rpc.call(URL_WITH_KEY, { method: 'POST', body: body('getAssetBatch', [{ ids: [`M${i}`] }]) })))
  assert.equal(peak, 2)
})
