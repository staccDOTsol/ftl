// Compatibility boundary for the recovered pre-V1 Composer binary. Only the
// RPC request's supported-version ceiling changes; responses remain byte-for-
// byte upstream JSON. In particular, V1 is never relabelled as V0.
import http from 'node:http'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export function supportV1(request) {
  if (Array.isArray(request)) return request.map(supportV1)
  if (!request || !['getTransaction', 'getBlock'].includes(request.method)) return request
  const params = [...(request.params ?? [])]
  params[1] = { ...(params[1] ?? {}), maxSupportedTransactionVersion: Math.max(1, Number(params[1]?.maxSupportedTransactionVersion ?? 0)) }
  return { ...request, params }
}

export function createCompatServer({ rpc, heavy = rpc, fetcher = fetch, concurrency = 4 }) {
  let active = 0
  const waiters = []
  const metrics = { requests: 0, v1Requests: 0, rpcErrors: 0, retries: 0 }
  const acquire = async () => { if (active >= concurrency) await new Promise(resolve => waiters.push(resolve)); else active++ }
  const release = () => { const next = waiters.shift(); if (next) next(); else active-- }
  const forward = async (request, endpoint) => {
    await acquire()
    try {
      const patched = supportV1(request)
      metrics.requests++
      if (patched !== request) metrics.v1Requests++
      const read = /^(get|isBlockhashValid|minimumLedgerSlot)/.test(request?.method ?? '')
      for (let attempt = 0; ; attempt++) {
        const response = await fetcher(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patched), signal: AbortSignal.timeout(60_000) })
        const text = await response.text()
        let code
        try { code = JSON.parse(text)?.error?.code } catch {}
        if (read && attempt < 3 && ([429, 502, 503, 504].includes(response.status) || [-32005, -32429, 429].includes(code))) {
          metrics.retries++
          await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt))
          continue
        }
        if (code !== undefined || !response.ok) {
          metrics.rpcErrors++
          console.warn('[composer:rpc]', request?.method, 'http', response.status, 'code', code ?? 'none')
        }
        return { status: response.status, text }
      }
    } finally { release() }
  }
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, ...metrics, active, queued: waiters.length }))
      return
    }
    if (req.method !== 'POST' || !['/rpc', '/heavy'].includes(req.url)) { res.writeHead(404).end(); return }
    try {
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (Buffer.byteLength(body) > 10_000_000) { res.writeHead(413).end(); return }
      }
      const request = JSON.parse(body)
      const endpoint = req.url === '/heavy' ? heavy : rpc
      // The old learner uses JSON-RPC batches. Fan them out with a bounded
      // concurrency so each getTransaction's V1 ceiling and retries apply.
      if (Array.isArray(request)) {
        const rows = await Promise.all(request.map(async item => {
          const result = await forward(item, endpoint)
          try { return JSON.parse(result.text) } catch { return { jsonrpc: '2.0', id: item.id, error: { code: -32000, message: `Upstream HTTP ${result.status}` } } }
        }))
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(rows))
      } else {
        const result = await forward(request, endpoint)
        res.writeHead(result.status, { 'content-type': 'application/json' }).end(result.text)
      }
    } catch {
      res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: -32000, message: 'Composer upstream RPC unavailable' } }))
    }
  })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.RPC_URL) throw new Error('RPC_URL is required')
  const server = createCompatServer({ rpc: process.env.RPC_URL, heavy: process.env.HEAVY_RPC_URL || process.env.RPC_URL })
  server.listen(8090, '127.0.0.1', () => {
    const child = spawn('/usr/local/bin/composer', [], { stdio: 'inherit', env: { ...process.env,
      RPC_URL: 'http://127.0.0.1:8090/rpc', HEAVY_RPC_URL: 'http://127.0.0.1:8090/heavy' } })
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal))
    child.on('exit', code => { server.close(); process.exit(code ?? 0) })
    child.on('error', () => { server.close(); process.exit(1) })
    console.log('[composer:rpc] V1-compatible RPC boundary listening on loopback')
  })
}
