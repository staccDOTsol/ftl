import { parentPort } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { config, redact } from '../config.ts'
import { ProgramIndex } from './program-index.ts'
import { observePrograms, rpcDiscoveryTransaction } from './program-observation.ts'
import { venueOf } from './programs.ts'

fs.mkdirSync(config.dataDir, { recursive: true })
const db = new DatabaseSync(path.join(config.dataDir, 'programs.db'))
const index = new ProgramIndex({ db, composerUrl: config.composerUrl, enabled: config.programDiscovery,
  onUpdate: update => parentPort!.postMessage(update) })
const directory = new URL('../../idl/', import.meta.url)
for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.json'))) {
  try {
    const idl = JSON.parse(fs.readFileSync(new URL(file, directory), 'utf8'))
    const address = idl.address ?? idl.metadata?.address
    if (address) index.seed(address, idl, venueOf.get(address) ?? idl.metadata?.name ?? idl.name ?? null)
  } catch {}
}
index.refreshInterfaces()
let observations: import('./program-observation.ts').ProgramObservation[] = []
let observationOffset = 0
let draining = false
const drain = () => {
  if (draining) return
  draining = true
  const step = () => {
    const chunk = observations.slice(observationOffset, observationOffset + 32)
    observationOffset += chunk.length
    if (chunk.length) {
      try { index.observeMany(chunk) } catch (error) { console.error('[programs:ingest]', redact(String(error))) }
    }
    if (observationOffset >= observations.length) { observations = []; observationOffset = 0; draining = false }
    else {
      if (observationOffset > 4096) { observations = observations.slice(observationOffset); observationOffset = 0 }
      // Yield between bounded WAL commits so HTTP requests and WS progress
      // are serviced even while a finalized replay is catching up.
      setImmediate(step)
    }
  }
  setImmediate(step)
}
parentPort!.on('message', message => {
  try {
    if (message.t === 'observations') { observations.push(...message.observations); drain() }
    else if (message.t === 'source') index.source(message.lane, message.connected)
    else if (message.t === 'request') {
      const data = message.operation === 'list' ? index.list(message.options) : message.operation === 'detail'
        ? index.detail(message.options) : message.operation === 'idl' ? index.idl(message.options) : null
      parentPort!.postMessage({ t: 'response', id: message.id, data })
    }
  } catch (error) {
    if (message.t === 'request') parentPort!.postMessage({ t: 'response', id: message.id, error: 'Program index temporarily unavailable' })
    console.error('[programs]', redact(String(error)))
  }
})
setInterval(() => index.flush(), 1000)
setInterval(() => index.refreshInterfaces(), 30_000)
setInterval(() => { void index.next().catch(error => console.error('[programs:learn]', redact(String(error)))) }, 2000)
if (config.programDiscovery) {
  void index.checkHealth()
  setInterval(() => { void index.checkHealth() }, 30_000)
}

// Recover a bounded set of *already observed* signatures once on first startup,
// with a durable checkpoint per signature. This is receipt replay, not polling
// the chain-wide program universe. Subsequent discoveries come from live lanes.
async function bootstrap() {
  if (!config.programDiscovery || !config.solanaRpc || !config.programDiscoveryBackfill) return
  if (db.prepare("SELECT value FROM program_index_meta WHERE key='bootstrap-completed'").get()) return
  db.exec('CREATE TABLE IF NOT EXISTS program_bootstrap(signature TEXT PRIMARY KEY,state TEXT NOT NULL)')
  const seen = new DatabaseSync(path.join(config.dataDir, 'ftl.db'), { readOnly: true })
  let signatures: { tx: string }[]
  try {
    signatures = seen.prepare(`WITH recent_events AS (SELECT tx,ts FROM events WHERE chain='solana' AND stage='confirmed' ORDER BY ts DESC LIMIT 200),
      recent_swaps AS (SELECT REPLACE(id,'solana:','') tx,ts FROM research_swaps WHERE chain='solana' ORDER BY ts DESC LIMIT 200)
      SELECT tx,MAX(ts) ts FROM (SELECT tx,ts FROM recent_events UNION ALL SELECT tx,ts FROM recent_swaps) GROUP BY tx ORDER BY ts DESC LIMIT 200`).all() as { tx: string }[]
  } finally { seen.close() }
  for (const { tx } of signatures) {
    if (db.prepare("SELECT 1 FROM program_bootstrap WHERE signature=? AND state='done'").get(tx)) continue
    try {
      const response = await fetch(config.solanaRpc, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [tx, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }] }), signal: AbortSignal.timeout(15_000) })
      const json = await response.json() as any
      if (!response.ok || json.error) throw new Error('receipt replay unavailable')
      if (json.result) {
        const observation = observePrograms(rpcDiscoveryTransaction(json.result, tx), 'receipt-replay')
        if (observation) index.observeMany([observation])
      }
      db.prepare("INSERT INTO program_bootstrap(signature,state) VALUES(?,'done') ON CONFLICT(signature) DO UPDATE SET state='done'").run(tx)
    } catch { console.warn('[programs:replay] receipt unavailable; live discovery continues'); return }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  db.prepare("INSERT OR IGNORE INTO program_index_meta(key,value) VALUES('bootstrap-completed',1)").run()
  index.flush()
}
// FTL opens its database before this worker is spawned.
void bootstrap().catch(error => console.error('[programs:replay]', redact(String(error))))
