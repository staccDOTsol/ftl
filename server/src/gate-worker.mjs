// Public port. This thread only answers the health check and forwards
// everything else once the app has finished opening its own port. It stays
// responsive while the main thread is inside sqlite or a quote.
import http from 'node:http'
import { parentPort, workerData } from 'node:worker_threads'

const { publicPort, appPort, quotePort } = workerData
let ready = false
let quoteReady = false
const waiters = new Set()
const quoteWaiters = new Set()

function whenReady(ms = 180_000) {
  if (ready) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      waiters.delete(done)
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), ms)
    waiters.add(done)
  })
}

function whenQuoteReady(ms = 90_000) {
  if (quoteReady) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      quoteWaiters.delete(done)
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), ms)
    quoteWaiters.add(done)
  })
}

const quotePath = (path) => path.startsWith('/api/quote/') || path.startsWith('/api/swap/')

parentPort.on('message', (msg) => {
  if (msg?.quoteReady && !quoteReady) {
    quoteReady = true
    for (const done of [...quoteWaiters]) done(true)
  }
  if (!msg?.ready || ready) return
  ready = true
  for (const done of [...waiters]) done(true)
})

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer'])

function forward(req, res, port) {
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP.has(k.toLowerCase()) || v == null) continue
    headers[k] = v
  }
  const upstream = http.request({
    hostname: '127.0.0.1', port, method: req.method, path: req.url, headers,
  }, (up) => {
    const out = {}
    for (const [k, v] of Object.entries(up.headers)) {
      if (v == null || HOP.has(k.toLowerCase())) continue
      out[k] = v
    }
    res.writeHead(up.statusCode ?? 502, out)
    up.pipe(res)
  })
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end('upstream')
    else res.destroy()
  })
  res.on('close', () => upstream.destroy())
  req.pipe(upstream)
}

const server = http.createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  if ((req.method === 'GET' || req.method === 'HEAD') && (path === '/health' || path === '/')) {
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end(req.method === 'HEAD' ? undefined : 'ftl ok')
    return
  }
  if (quotePath(path)) {
    if (!await whenQuoteReady()) {
      res.writeHead(503, { 'content-type': 'text/plain' }).end('starting')
      return
    }
    forward(req, res, quotePort)
    return
  }
  if (!await whenReady()) {
    res.writeHead(503, { 'content-type': 'text/plain' }).end('starting')
    return
  }
  forward(req, res, appPort)
})

server.on('upgrade', (req, socket, head) => {
  const go = () => {
    const upstream = http.request({
      hostname: '127.0.0.1', port: appPort, method: req.method, path: req.url, headers: req.headers,
    })
    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || ''}`.trimEnd()]
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (v == null) continue
        for (const val of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${val}`)
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n')
      if (upHead?.length) socket.write(upHead)
      upSocket.pipe(socket)
      socket.pipe(upSocket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    upstream.on('response', (upRes) => {
      const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || ''}`.trimEnd()]
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (v == null) continue
        for (const val of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${val}`)
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n')
      upRes.pipe(socket)
    })
    if (head?.length) upstream.write(head)
    upstream.end()
  }
  if (ready) go()
  else whenReady().then((ok) => {
    if (!ok) socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 8\r\n\r\nstarting')
    else go()
  })
})

server.listen(publicPort, '0.0.0.0', () => console.log(`[gate] listening on :${publicPort}`))
