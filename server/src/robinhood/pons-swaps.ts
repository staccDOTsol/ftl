// Finalized Pons V2 curve prices for FTL-seen Robinhood tokens. Factory
// TokenLaunched logs provide the only accepted curve -> token/quote mapping;
// CurveBuy and CurveSell supply exact executed legs, including fee/tax fields.
// Every range is replayable. No inferred reserves or periodic snapshots.
import { config, redact } from '../config.ts'
import { db, getCursor, setCursor } from '../db.ts'
import { ingestRobinhoodSwap, onResearchSwapStream } from '../research.ts'
import { PONS_BUY_TOPIC, PONS_LAUNCH_TOPIC, PONS_SELL_TOPIC, PONS_V2_DEPLOYMENT_BLOCK,
  PONS_V2_FACTORY, RH_QUOTES, StrictRhRpc, blockNumber, decodePonsCurveSwap,
  decodePonsLaunch, hexBlock, type ChainLog, type PonsCurve } from './research-source.ts'

const LANE = 'robinhood-pons-swaps'
const DAY = 86_400_000
const MAP_CURSOR = 'rh:pons-map:block'
const SWAP_CURSOR = 'rh:pons-swap:block'
const START_TS = 'rh:pons-swap:start-ts'
const FACTORY_STEP = 100_000 // dRPC's address-filtered Robinhood maximum
const TRADE_STEP = 40_000 // dRPC counts an unfiltered address as five

db.exec(`CREATE TABLE IF NOT EXISTS research_pons_curves (
  curve TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  quote TEXT NOT NULL,
  launched_block INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS research_pons_curves_token ON research_pons_curves(token);
CREATE TABLE IF NOT EXISTS research_pons_quotes (
  address TEXT PRIMARY KEY,
  decimals INTEGER NOT NULL,
  checked_block INTEGER NOT NULL
);`)

const getCurve = db.prepare('SELECT curve,token,quote,launched_block FROM research_pons_curves WHERE curve=?')
const getQuote = db.prepare('SELECT decimals FROM research_pons_quotes WHERE address=?')
const insertCurve = db.prepare('INSERT OR IGNORE INTO research_pons_curves(curve,token,quote,launched_block) VALUES(?,?,?,?)')
const insertQuote = db.prepare('INSERT OR IGNORE INTO research_pons_quotes(address,decimals,checked_block) VALUES(?,?,?)')
const seenToken = db.prepare("SELECT 1 FROM research_tokens WHERE chain='robinhood' AND address=?")
const hasSwap = db.prepare("SELECT 1 FROM research_swaps WHERE chain='robinhood' AND id=?")

let source: StrictRhRpc | null = null
let started = false
let scanning = false
let continuous = false
let lastPulseTs: number | null = null

function persistedCursor(name: string, fallback: number): number {
  const raw = getCursor(name)
  if (raw === null) return fallback
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < fallback) throw new Error(`Invalid persisted ${name} cursor`)
  return n
}

async function blockAt(n: number): Promise<{ n: number; ts: number }> {
  if (!source) throw new Error('Robinhood RPC unavailable')
  const block = await source.call('eth_getBlockByNumber', [hexBlock(n), false]) as any
  if (blockNumber(block.number) !== n || !/^0x[a-f\d]{64}$/i.test(block.hash))
    throw new Error('Invalid historical Robinhood block')
  return { n, ts: blockNumber(block.timestamp) * 1000 }
}

async function firstBlockAt(ts: number, head: number): Promise<number> {
  let lo = PONS_V2_DEPLOYMENT_BLOCK, hi = head
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if ((await blockAt(mid)).ts < ts) lo = mid + 1
    else hi = mid
  }
  return lo
}

async function ensureStart(head: number): Promise<number> {
  const prior = getCursor(SWAP_CURSOR)
  if (prior !== null) {
    const n = Number(prior)
    if (!Number.isSafeInteger(n) || n < PONS_V2_DEPLOYMENT_BLOCK - 1 || !getCursor(START_TS))
      throw new Error('Invalid persisted Pons V2 replay start')
    return n
  }
  const today = Math.floor(Date.now() / DAY) * DAY
  const target = today - 31 * DAY
  const deployed = await blockAt(PONS_V2_DEPLOYMENT_BLOCK)
  const first = deployed.ts >= target ? PONS_V2_DEPLOYMENT_BLOCK : await firstBlockAt(target, head)
  const exact = first === deployed.n ? deployed : await blockAt(first)
  setCursor(START_TS, String(exact.ts))
  setCursor(SWAP_CURSOR, String(first - 1))
  return first - 1
}

function saveCurves(logs: ChainLog[]): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const log of logs) {
      const curve = decodePonsLaunch(log)
      if (!curve) throw new Error('Unexpected event in Pons V2 factory range')
      insertCurve.run(curve.curve, curve.token, curve.quote, curve.launchedBlock)
      const stored = getCurve.get(curve.curve) as
        { curve: string; token: string; quote: string; launched_block: number } | undefined
      if (!stored || stored.token !== curve.token || stored.quote !== curve.quote ||
        stored.launched_block !== curve.launchedBlock)
        throw new Error('Conflicting Pons V2 factory launch mapping')
    }
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

function mappedCurve(address: string): PonsCurve | null {
  const row = getCurve.get(address.toLowerCase()) as
    { curve: string; token: string; quote: string; launched_block: number } | undefined
  return row ? { curve: row.curve, token: row.token, quote: row.quote,
    launchedBlock: row.launched_block } : null
}

async function ensureQuoteDecimals(logs: ChainLog[]): Promise<Map<string, number>> {
  if (!source) throw new Error('Robinhood RPC unavailable')
  const out = new Map<string, number>()
  const missing = new Map<string, number>()
  for (const log of logs) {
    const curve = mappedCurve(log.address)
    if (!curve || !seenToken.get(curve.token)) continue
    const known = RH_QUOTES.get(curve.quote)
    if (known) { out.set(curve.quote, known.decimals); continue }
    const stored = getQuote.get(curve.quote) as { decimals: number } | undefined
    if (stored) { out.set(curve.quote, stored.decimals); continue }
    const block = blockNumber(log.blockNumber)
    missing.set(curve.quote, Math.min(missing.get(curve.quote) ?? block, block))
  }
  const entries = [...missing]
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100)
    const values = await source.batch(chunk.map(([quote, block]) => ({ method: 'eth_call',
      params: [{ to: quote, data: '0x313ce567' }, hexBlock(block)] }))) as string[]
    values.forEach((value, j) => {
      if (!/^0x[a-f\d]{64}$/i.test(value)) throw new Error('Pons V2 quote decimals() unavailable at finalized trade')
      const decimals = Number(BigInt(value))
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36)
        throw new Error('Invalid Pons V2 quote decimals')
      const [quote, block] = chunk[j]
      insertQuote.run(quote, decimals, block)
      out.set(quote, decimals)
    })
  }
  return out
}

async function applyTrades(logs: ChainLog[], times: Map<number, number>): Promise<void> {
  const decimals = await ensureQuoteDecimals(logs)
  logs.sort((a, b) => blockNumber(a.blockNumber) - blockNumber(b.blockNumber) ||
    blockNumber(a.logIndex) - blockNumber(b.logIndex))
  for (const log of logs) {
    const topic = log.topics[0]?.toLowerCase()
    if (topic !== PONS_BUY_TOPIC && topic !== PONS_SELL_TOPIC)
      throw new Error('Unexpected event in Pons V2 curve trade range')
    const curve = mappedCurve(log.address)
    if (!curve) continue // The signature can also be emitted by an unrelated contract.
    if (blockNumber(log.blockNumber) < curve.launchedBlock)
      throw new Error('Pons V2 trade predates authenticated factory launch')
    if (!seenToken.get(curve.token)) continue // Research indexes FTL-seen tokens.
    const quoteDecimals = decimals.get(curve.quote)
    if (quoteDecimals === undefined) throw new Error('Pons V2 quote decimals missing')
    // The authenticated Pons V2 factory deploys OpenZeppelin ERC20 tokens
    // whose decimals() is fixed at 18 in the verified launcher-token source.
    const observation = decodePonsCurveSwap(log, curve, 18, quoteDecimals,
      times.get(blockNumber(log.blockNumber))!)
    if (!observation) throw new Error('Pons V2 trade decoder rejected expected topic')
    ingestRobinhoodSwap(observation)
    if (!hasSwap.get(`robinhood:${observation.id}`))
      throw new Error('Pons V2 trade did not enter finalized Research ledger')
  }
}

async function scanOnce(): Promise<boolean> {
  if (!source) return false
  const head = await source.finalizedHead()
  const swapCursor = await ensureStart(head.number)
  const start = Number(getCursor(SWAP_CURSOR)) + 1
  const mapCursor = persistedCursor(MAP_CURSOR, PONS_V2_DEPLOYMENT_BLOCK - 1)
  if (mapCursor < start - 1) {
    const from = mapCursor + 1, to = Math.min(start - 1, from + FACTORY_STEP - 1)
    const launches = await source.completeLogs({ address: PONS_V2_FACTORY,
      topics: [PONS_LAUNCH_TOPIC] }, from, to)
    await source.finalizedStampedTimes(launches, from, to, head.number)
    saveCurves(launches)
    setCursor(MAP_CURSOR, String(to))
    return true
  }
  if (swapCursor >= head.number) {
    if (!continuous) {
      const prior = db.prepare("SELECT 1 FROM research_stream_sessions WHERE lane=? ORDER BY id DESC LIMIT 1").get(LANE)
      onResearchSwapStream({ t: prior ? 'resume' : 'open', lane: LANE,
        ts: prior ? Date.now() : Number(getCursor(START_TS) ?? head.ts) })
      continuous = true
    }
    lastPulseTs = Date.now()
    onResearchSwapStream({ t: 'pulse', lane: LANE, ts: lastPulseTs })
    return false
  }
  const from = swapCursor + 1, to = Math.min(head.number, from + TRADE_STEP - 1)
  const [launches, trades] = await Promise.all([
    source.completeLogs({ address: PONS_V2_FACTORY, topics: [PONS_LAUNCH_TOPIC] }, from, to),
    source.completeLogs({ topics: [[PONS_BUY_TOPIC, PONS_SELL_TOPIC]] }, from, to),
  ])
  const times = await source.finalizedStampedTimes([...launches, ...trades], from, to, head.number)
  saveCurves(launches)
  await applyTrades(trades, times)
  setCursor(SWAP_CURSOR, String(to))
  if (to >= head.number) {
    if (!continuous) {
      const prior = db.prepare("SELECT 1 FROM research_stream_sessions WHERE lane=? ORDER BY id DESC LIMIT 1").get(LANE)
      onResearchSwapStream({ t: prior ? 'resume' : 'open', lane: LANE,
        ts: prior ? Date.now() : Number(getCursor(START_TS) ?? head.ts) })
      continuous = true
    }
    lastPulseTs = Date.now()
    onResearchSwapStream({ t: 'pulse', lane: LANE, ts: lastPulseTs })
  }
  return to < head.number
}

async function run(): Promise<void> {
  if (!source || scanning) return
  scanning = true
  try {
    let more = true
    while (more) {
      more = await scanOnce()
      if (more) await new Promise<void>(resolve => setImmediate(resolve))
    }
  } catch (error) {
    if (continuous) onResearchSwapStream({ t: 'close', lane: LANE,
      ts: lastPulseTs ?? Date.now() })
    continuous = false
    console.error('[rh:pons] finalized replay pending:', redact(String(error)).slice(0, 260))
  } finally { scanning = false }
}

export function startPonsCurveSwaps(rpc?: StrictRhRpc): void {
  if (started) return
  started = true
  source = rpc ?? (config.rhHttp ? new StrictRhRpc(config.rhHttp) : null)
  if (!source) return
  setInterval(() => void run(), 3_000).unref()
  void run()
}

export async function advancePonsCurveSwaps(): Promise<void> { await run() }
