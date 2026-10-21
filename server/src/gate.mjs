// Bind the public port before the app imports sqlite. Fly drops the machine
// when /health is refused during that import, and it does not put it back.
import http from 'node:http'
import { Worker } from 'node:worker_threads'

const publicPort = Number(process.env.PORT ?? 8080)
const appPort = publicPort + 1
const quotePort = publicPort + 2
const worker = new Worker(new URL('./gate-worker.mjs', import.meta.url), {
  workerData: { publicPort, appPort, quotePort },
})
worker.on('error', (err) => {
  console.error('[gate] worker', err)
  process.exit(1)
})
worker.on('exit', (code) => {
  if (code !== 0) {
    console.error('[gate] worker exited', code)
    process.exit(code || 1)
  }
})

process.env.PORT = String(appPort)

function startQuoteWorker() {
  const quoteWorker = new Worker(new URL('./quote-boot.mjs', import.meta.url), {
    workerData: { port: quotePort },
    env: { ...process.env, PORT: String(quotePort), QUOTE_ONLY: '1' },
  })
  quoteWorker.on('error', (err) => console.error('[quote] worker', err))
  quoteWorker.on('message', (msg) => {
    worker.postMessage(msg)
    if (msg?.quoteReady) quoteUp()
  })
  quoteWorker.on('exit', (code) => {
    console.error('[quote] worker exited', code)
    setTimeout(startQuoteWorker, 1000)
  })
}
let quoteUp = () => {}
const quoteReady = new Promise((resolve) => {
  const timer = setTimeout(resolve, 180_000)
  quoteUp = () => { clearTimeout(timer); resolve() }
})
startQuoteWorker()

function poke() {
  return new Promise((resolve) => {
    const req = http.get({ hostname: '127.0.0.1', port: appPort, path: '/health', timeout: 1000 }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

await quoteReady
console.log('[gate] quote ready')
await import('./index.ts')
for (;;) {
  if (await poke()) break
  await new Promise((r) => setTimeout(r, 200))
}
worker.postMessage({ ready: true })
console.log('[gate] app ready')
