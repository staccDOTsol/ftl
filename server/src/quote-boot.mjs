// Quote HTTP on its own thread. The firehose import pegs the main thread, and
// a quote sent there never gets a response.
import { parentPort, workerData } from 'node:worker_threads'

process.env.PORT = String(workerData.port)
process.env.QUOTE_ONLY = '1'
const { startApi } = await import('./api.ts')
const server = startApi(workerData.port)
await new Promise((resolve) => {
  if (server.listening) resolve()
  else server.once('listening', resolve)
})
console.log(`[quote] listening on :${workerData.port}`)
parentPort.postMessage({ quoteReady: true })
