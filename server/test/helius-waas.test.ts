import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'
import { handleHeliusWaas } from '../src/helius-waas.ts'

const originalFetch = globalThis.fetch
const originalKey = process.env.HELIUS_API_KEY
const originalOrigins = process.env.HELIUS_WAAS_ORIGINS
const originalSecureUrl = process.env.HELIUS_WAAS_SECURE_RPC_URL
let server: http.Server
let port: number
let upstreamCalls: Array<{ url: string; init?: RequestInit }> = []

before(async () => {
  process.env.HELIUS_API_KEY = 'test-secret-api-key'
  process.env.HELIUS_WAAS_ORIGINS = 'https://liquidityxyz.fun'
  globalThis.fetch = async (input, init) => {
    upstreamCalls.push({ url: String(input), init })
    if (String(input).endsWith('/waas/config')) return Response.json({
      organizationId: 'org-id', authProxyConfigId: 'proxy-id', projectId: 'project-id',
      secureRpcUrl: {
        'mainnet-beta': 'https://example-fast-mainnet.helius-rpc.com',
        devnet: 'https://devnet.helius-rpc.com/?api-key=should-never-ship',
      },
      extraSecret: 'test-secret-api-key',
    })
    if (String(input).endsWith('/waas/wallets')) return new Response(null, { status: 204 })
    return Response.json({ jsonrpc: '2.0', id: 1, result: 123 })
  }
  server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    await handleHeliusWaas(req, res, new URL(req.url ?? '/', 'http://localhost'), body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})

after(async () => {
  globalThis.fetch = originalFetch
  if (originalKey === undefined) delete process.env.HELIUS_API_KEY
  else process.env.HELIUS_API_KEY = originalKey
  if (originalOrigins === undefined) delete process.env.HELIUS_WAAS_ORIGINS
  else process.env.HELIUS_WAAS_ORIGINS = originalOrigins
  if (originalSecureUrl === undefined) delete process.env.HELIUS_WAAS_SECURE_RPC_URL
  else process.env.HELIUS_WAAS_SECURE_RPC_URL = originalSecureUrl
  await new Promise<void>(resolve => server.close(() => resolve()))
})

function request(path: string, method = 'GET', body?: unknown, origin = 'https://liquidityxyz.fun') {
  return new Promise<{ status: number; data: any }>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: {
      origin, ...(body ? { 'content-type': 'application/json' } : {}),
    } }, res => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve({ status: res.statusCode ?? 0, data: JSON.parse(data) }))
    })
    req.on('error', reject)
    req.end(body ? JSON.stringify(body) : undefined)
  })
}

test('bootstrap exposes only wallet setup and safe secure RPC URLs', async () => {
  const response = await request('/api/helius/waas/config')
  assert.equal(response.status, 200)
  assert.deepEqual(response.data, {
    organizationId: 'org-id', authProxyConfigId: 'proxy-id', projectId: 'project-id',
    secureRpcUrl: { 'mainnet-beta': 'https://example-fast-mainnet.helius-rpc.com' },
  })
  assert.equal(JSON.stringify(response.data).includes('test-secret-api-key'), false)
  const calls = upstreamCalls.length
  assert.equal((await request('/api/helius/waas/config')).status, 200)
  assert.equal(upstreamCalls.length, calls)
})

test('server can select its keyless secure RPC URL', async () => {
  process.env.HELIUS_WAAS_SECURE_RPC_URL = 'https://another-fast-mainnet.helius-rpc.com'
  try {
    const response = await request('/api/helius/waas/config')
    assert.equal(response.status, 200)
    assert.equal(response.data.secureRpcUrl['mainnet-beta'], 'https://another-fast-mainnet.helius-rpc.com')
  } finally {
    delete process.env.HELIUS_WAAS_SECURE_RPC_URL
  }
})

test('origin guard runs before upstream', async () => {
  const beforeCalls = upstreamCalls.length
  const response = await request('/api/helius/waas/config', 'GET', undefined, 'https://attacker.example')
  assert.equal(response.status, 403)
  assert.equal(upstreamCalls.length, beforeCalls)
})

test('wallet registration accepts Helius 204 without exposing key', async () => {
  const response = await request('/api/helius/waas/wallets', 'POST', {
    endUserId: 'user', turnkeySubOrgId: 'suborg', turnkeyWalletId: 'wallet',
    solanaAddress: 'So11111111111111111111111111111111111111112', authMethod: 'passkey',
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.data, { ok: true })
  const last = upstreamCalls.at(-1)
  assert.equal(last?.init?.headers && (last.init.headers as Record<string, string>)['x-api-key'], 'test-secret-api-key')
})

test('generic RPC write methods are denied before upstream', async () => {
  const beforeCalls = upstreamCalls.length
  const response = await request('/api/helius/rpc?cluster=mainnet-beta', 'POST', {
    jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: ['a'],
  })
  assert.equal(response.status, 400)
  assert.equal(upstreamCalls.length, beforeCalls)
})
