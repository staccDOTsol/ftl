// Same-origin proxy for the browser-only Helius Wallet Kit. The Helius key is
// read only on the server. This is deliberately narrower than a general RPC
// proxy: only the methods the embedded wallet needs are forwarded.

import type { IncomingMessage, ServerResponse } from 'node:http'
import bs58 from 'bs58'
import { redact } from './config.ts'

const DEV_API = 'https://dev-api.helius.xyz/v0'
const MAINNET_RPC = 'https://mainnet.helius-rpc.com/'
const DEVNET_RPC = 'https://devnet.helius-rpc.com/'
const MAINNET_SENDER = 'https://sender.helius-rpc.com/fast'
const READ_METHODS = new Set([
  'getAccountInfo', 'getBalance', 'getBlockHeight', 'getFeeForMessage',
  'getLatestBlockhash', 'getMinimumBalanceForRentExemption',
  'getMultipleAccounts', 'getRecentPrioritizationFees', 'getSignatureStatuses',
  'getSlot', 'getTokenAccountBalance', 'getTokenAccountsByOwner',
  'getTokenSupply', 'getVersion', 'getPriorityFeeEstimate',
])
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const B64 = /^[A-Za-z0-9+/]+={0,2}$/
const LIMITS: Record<string, number> = {
  'GET:waas/config': 30,
  'POST:waas/wallets': 10,
  'POST:rpc': 120,
  'POST:send': 10,
  'GET:transactions': 30,
}
const MINUTE = 60_000
const MAX_UPSTREAM_BYTES = 2_000_000
const buckets = new Map<string, { start: number; count: number }>()
let bootstrapCache: { until: number; key: string; secureMainnet?: string; data: unknown } | null = null

function limited(id: string, max: number): boolean {
  const now = Date.now()
  if (buckets.size > 10_000) for (const [key, value] of buckets) if (now - value.start >= MINUTE) buckets.delete(key)
  const b = buckets.get(id)
  if (!b || now - b.start >= MINUTE) { buckets.set(id, { start: now, count: 1 }); return false }
  if (b.count >= max) return true
  b.count++
  return false
}

function reply(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(data))
}

function configuredOrigins(): Set<string> {
  return new Set((process.env.HELIUS_WAAS_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean))
}

function requestOrigin(req: IncomingMessage): string | null {
  const source = req.headers.origin ?? req.headers.referer
  if (typeof source !== 'string') return null
  try { return new URL(source).origin } catch { return 'invalid' }
}

function clusterOf(value: string | null): 'mainnet-beta' | 'devnet' | null {
  return value === 'mainnet-beta' || value === 'devnet' ? value : null
}

function rpcUrl(cluster: 'mainnet-beta' | 'devnet', key: string): string {
  const u = new URL(cluster === 'mainnet-beta' ? MAINNET_RPC : DEVNET_RPC)
  u.searchParams.set('api-key', key)
  return u.toString()
}

async function upstreamJson(url: string, options: RequestInit, key: string): Promise<{ ok: boolean; status: number; data: any }> {
  const r = await fetch(url, { ...options, signal: AbortSignal.timeout(12_000) })
  if (r.status === 204) return { ok: r.ok, status: r.status, data: null }
  const reader = r.body?.getReader()
  if (!reader) throw new Error('empty upstream response')
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > MAX_UPSTREAM_BYTES) { await reader.cancel(); throw new Error('upstream response too large') }
    chunks.push(value)
  }
  const text = Buffer.concat(chunks, length).toString('utf8')
  let data: any
  try { data = JSON.parse(text) } catch { throw new Error('invalid upstream response') }
  // Never let an upstream error echo the server-side credential to a client.
  return { ok: r.ok, status: r.status, data: JSON.parse(redact(JSON.stringify(data)).split(key).join('***')) }
}

function safeSecureUrls(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const cluster of ['mainnet-beta', 'devnet']) {
    const value = (raw as Record<string, unknown>)[cluster]
    if (typeof value !== 'string') continue
    try {
      const u = new URL(value)
      if (u.protocol !== 'https:' || !u.hostname.endsWith('.helius-rpc.com') || u.username || u.password || u.search) continue
      out[cluster] = value
    } catch {}
  }
  return Object.keys(out).length ? out : undefined
}

function configuredSecureUrl(): string | undefined {
  return safeSecureUrls({ 'mainnet-beta': process.env.HELIUS_WAAS_SECURE_RPC_URL?.trim() })?.['mainnet-beta']
}

function parseBody(body: string): any | null {
  try { return JSON.parse(body) } catch { return null }
}

function validAddress(value: unknown): value is string {
  if (typeof value !== 'string' || !B58.test(value)) return false
  try { return bs58.decode(value).length === 32 } catch { return false }
}

export async function handleHeliusWaas(req: IncomingMessage, res: ServerResponse, url: URL, body: string): Promise<boolean> {
  if (!url.pathname.startsWith('/api/helius/')) return false
  const route = url.pathname.slice('/api/helius/'.length)
  const action = `${req.method}:${route}`
  const limit = LIMITS[action]
  if (!limit) { reply(res, 404, { error: 'Unknown wallet route' }); return true }
  const key = process.env.HELIUS_API_KEY?.trim()
  const origins = configuredOrigins()
  if (!key || origins.size === 0) { reply(res, 503, { error: 'Embedded wallet is not configured' }); return true }

  const origin = requestOrigin(req)
  if (origin && !origins.has(origin)) { reply(res, 403, { error: 'Origin not allowed' }); return true }
  if (!origin && req.method !== 'GET') { reply(res, 403, { error: 'Origin required' }); return true }
  if (body.length > 16_000) { reply(res, 413, { error: 'Wallet request too large' }); return true }
  const ip = String(req.headers['fly-client-ip'] ?? req.socket.remoteAddress ?? 'unknown')
  if (limited(`wallet:${ip}:${action}`, limit) || limited(`wallet:global:${action}`, limit * 30)) {
    res.setHeader('retry-after', '60')
    reply(res, 429, { error: 'Wallet request limit reached' })
    return true
  }
  try {
    if (action === 'GET:waas/config') {
      const secureMainnet = configuredSecureUrl()
      if (bootstrapCache && bootstrapCache.until > Date.now() && bootstrapCache.key === key && bootstrapCache.secureMainnet === secureMainnet) {
        reply(res, 200, bootstrapCache.data)
        return true
      }
      const upstream = await upstreamJson(`${DEV_API}/waas/config`, { headers: { 'x-api-key': key } }, key)
      if (!upstream.ok) { reply(res, upstream.status === 403 ? 403 : 502, { message: 'Helius WaaS configuration unavailable' }); return true }
      const data = upstream.data
      if (typeof data?.organizationId !== 'string' || typeof data?.authProxyConfigId !== 'string') {
        reply(res, 502, { message: 'Invalid Helius WaaS configuration' }); return true
      }
      const safeData = {
        organizationId: data.organizationId,
        authProxyConfigId: data.authProxyConfigId,
        projectId: typeof data.projectId === 'string' ? data.projectId : undefined,
        secureRpcUrl: {
          ...safeSecureUrls(data.secureRpcUrl),
          ...(secureMainnet ? { 'mainnet-beta': secureMainnet } : {}),
        },
        authMethods: data.authMethods && typeof data.authMethods === 'object' ? data.authMethods : undefined,
      }
      bootstrapCache = { until: Date.now() + MINUTE, key, secureMainnet, data: safeData }
      reply(res, 200, safeData)
      return true
    }

    if (action === 'POST:waas/wallets') {
      const data = parseBody(body)
      if (!data || !validAddress(data.solanaAddress) ||
        !['endUserId', 'turnkeySubOrgId', 'turnkeyWalletId'].every(k => typeof data[k] === 'string' && data[k].length > 0 && data[k].length <= 128)) {
        reply(res, 400, { error: 'Invalid wallet registration' }); return true
      }
      const upstream = await upstreamJson(`${DEV_API}/waas/wallets`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({
          endUserId: data.endUserId, turnkeySubOrgId: data.turnkeySubOrgId,
          turnkeyWalletId: data.turnkeyWalletId, solanaAddress: data.solanaAddress,
          authMethod: typeof data.authMethod === 'string' ? data.authMethod.slice(0, 32) : 'unknown',
        }),
      }, key)
      if (!upstream.ok) { reply(res, 502, { error: 'Wallet registration unavailable' }); return true }
      reply(res, 200, { ok: true })
      return true
    }

    if (action === 'POST:rpc') {
      const cluster = clusterOf(url.searchParams.get('cluster') ?? 'mainnet-beta')
      const rpc = parseBody(body)
      if (!cluster || !rpc || Array.isArray(rpc) || !READ_METHODS.has(rpc.method) || !Array.isArray(rpc.params)) {
        reply(res, 400, { error: 'Unsupported wallet RPC request' }); return true
      }
      const upstream = await upstreamJson(rpcUrl(cluster, key), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rpc),
      }, key)
      reply(res, upstream.ok ? 200 : 502, upstream.ok ? upstream.data : { error: 'Wallet RPC unavailable' })
      return true
    }

    if (action === 'POST:send') {
      const data = parseBody(body)
      const cluster = clusterOf(data?.cluster ?? null)
      if (!cluster || typeof data?.transaction !== 'string' || data.transaction.length > 2500 || !B64.test(data.transaction)) {
        reply(res, 400, { error: 'Invalid signed transaction' }); return true
      }
      const mainnet = cluster === 'mainnet-beta'
      const u = new URL(mainnet ? MAINNET_SENDER : DEVNET_RPC)
      u.searchParams.set('api-key', key)
      const upstream = await upstreamJson(u.toString(), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'sendTransaction', params: [data.transaction,
          mainnet ? { encoding: 'base64', skipPreflight: true, maxRetries: 0 } : { encoding: 'base64', skipPreflight: false, maxRetries: 3 }] }),
      }, key)
      if (!upstream.ok || upstream.data?.error || typeof upstream.data?.result !== 'string') {
        reply(res, 502, { error: 'Wallet transaction submission failed' }); return true
      }
      reply(res, 200, { signature: upstream.data.result })
      return true
    }

    const cluster = clusterOf(url.searchParams.get('cluster') ?? 'mainnet-beta')
    const address = url.searchParams.get('address') ?? ''
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 10) || 10, 1), 20)
    if (!cluster || !validAddress(address)) { reply(res, 400, { error: 'Invalid wallet history request' }); return true }
    const host = cluster === 'mainnet-beta' ? 'https://api.helius.xyz' : 'https://api-devnet.helius.xyz'
    const upstream = await upstreamJson(`${host}/v0/addresses/${encodeURIComponent(address)}/transactions?api-key=${encodeURIComponent(key)}&limit=${limit}`, {}, key)
    reply(res, upstream.ok ? 200 : 502, upstream.ok ? upstream.data : { error: 'Wallet history unavailable' })
    return true
  } catch (e) {
    console.error('[helius-waas]', redact(String(e)).split(key).join('***'))
    reply(res, 502, { error: 'Wallet provider unavailable' })
    return true
  }
}
