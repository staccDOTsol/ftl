import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCompatServer, supportV1 } from '../src/solana/composer-rpc-compat.mjs'

test('Composer RPC compatibility upgrades the ceiling without changing encoding, signature or future versions', () => {
  const request = { jsonrpc: '2.0', id: 4, method: 'getTransaction', params: ['signature', { encoding: 'json', maxSupportedTransactionVersion: 0 }] }
  assert.deepEqual(supportV1(request), { ...request, params: ['signature', { encoding: 'json', maxSupportedTransactionVersion: 1 }] })
  assert.equal(request.params[1].maxSupportedTransactionVersion, 0)
  const future = { ...request, params: ['signature', { maxSupportedTransactionVersion: 2 }] }
  assert.equal(supportV1(future).params[1].maxSupportedTransactionVersion, 2)
  const send = { method: 'sendTransaction', params: ['unchanged'] }
  assert.equal(supportV1(send), send)
})

test('the RPC shim preserves actual V1 responses and bounds batch fanout', async () => {
  let running = 0, max = 0
  const server = createCompatServer({ rpc: 'https://rpc.invalid', concurrency: 2, fetcher: async (_url, init) => {
    max = Math.max(max, ++running)
    const request = JSON.parse(init.body)
    assert.equal(request.params[1].maxSupportedTransactionVersion, 1)
    await new Promise(resolve => setTimeout(resolve, 5))
    running--
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { version: 1, transaction: ['real-wire', 'base64'] } }))
  } })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address() as { port: number }
    const response = await fetch(`http://127.0.0.1:${address.port}/heavy`, { method: 'POST', body: JSON.stringify(
      Array.from({ length: 8 }, (_, id) => ({ jsonrpc: '2.0', id, method: 'getTransaction', params: [`sig-${id}`, { maxSupportedTransactionVersion: 0 }] }))) })
    const rows = await response.json()
    assert.equal(rows.length, 8)
    assert.equal(max, 2)
    assert.ok(rows.every(row => row.result.version === 1 && row.result.transaction[0] === 'real-wire'))
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
