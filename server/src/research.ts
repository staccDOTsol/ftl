// Research coverage follows every token FTL observes. This module does
// not call providers, poll balances, or invent holder/price history. Confirmed
// liquidity observations come from the same durable event log as Live.

import bs58 from 'bs58'
import { db } from './db.ts'
import { bus } from './hub.ts'
import { HttpError } from './social.ts'
import { holderStatus, type HolderStatus } from './solana/holders.ts'
import { robinhoodHolderStatus, type RobinhoodHolderStatus } from './robinhood/holders.ts'
import { robinhoodProvisionalStatus } from './robinhood/provisional.ts'
import { quoteSymbolFor, type SwapObservation, type SwapStreamEvent } from './solana/swaps.ts'
import type { Chain, FlowEvent, ResearchBottoming, ResearchCandle, ResearchCoin, ResearchCoinDetail, ResearchList } from '../../shared/types.ts'

const DAY = 86_400_000
const RH_RESEARCH_ENABLED = process.env.RH_RESEARCH_SOURCE === '1'
const RH_PROVISIONAL_ENABLED = process.env.RH_PROVISIONAL_SOURCE === '1'

const SOURCE_REASON: Record<Chain, string> = {
  solana: 'Holder strength awaits one complete token-account bootstrap and continuous finalized mint-stream coverage. FTL shows confirmed liquidity events and eligible executed swap observations where present.',
  robinhood: 'Robinhood Chain holder strength requires complete deployment-to-finalized Transfer replay, a verified rolling owner cohort seven finalized days behind the head and current balance validation. Younger tokens need seven finalized days. Finalized eligible v4 swap observations appear only where a verified live source has recorded them.',
}
const HOLDER_REASON: Record<Chain, string> = {
  solana: 'A complete current token-account bootstrap followed by continuous finalized mint-filtered balance updates is required. FTL liquidity events cannot measure holder retention.',
  robinhood: 'Complete deployment-to-finalized Transfer replay, an event-derived rolling owner cohort seven finalized days behind the head, current balance validation and continuous finalized Transfer coverage are required. FTL liquidity events cannot measure holder retention.',
}
const BOTTOMING_REASON: Record<Chain, string> = {
  solana: 'Thirty consecutive completed UTC days of finalized eligible swap prices and quote volume, with continuous stream coverage, are required. FTL liquidity events cannot establish a price bottom.',
  robinhood: 'Thirty consecutive completed UTC days of finalized eligible v4 swap prices and quote volume, with continuous stream coverage, are required. FTL liquidity events cannot establish a price bottom.',
}
const COVERAGE_NOTE = 'Every Solana and Robinhood Chain token seen in FTL events is indexed automatically. Price patterns require finalized eligible swaps, 30 complete daily candles, and continuous chain-specific stream coverage. Solana holder scores require one complete current-state read and seven observed days; Robinhood holder scores require full deployment Transfer replay, a verified rolling seven-finalized-day cohort and current balance validation. Younger Robinhood tokens must age seven finalized days. Both require continuous finalized updates. Liquidity counts retain confirmed FTL events from history still stored when Research started and all new events afterward; older pruned events and activity omitted by FTL’s young-liquidity filter cannot be recovered.'

const BASE_METHOD = {
  holderStrength: 'Solana top-account persistence proxy: after seven days of continuous finalized coverage, 70% of the original top-20 owners’ retained balance percentage plus 30% of the inverse current top-20 balance share. One account or owner address is not necessarily one person; pool vaults and custodians may be included. No periodic snapshots or investment recommendation.',
  bottoming: 'Three observed price/quote-volume patterns after a 30% drawdown from a 30-day high: high-volume down day followed by quieter volume, a low holding for at least three days, and a higher close on stronger volume. Requires 30 consecutive completed UTC days of finalized eligible swaps in one quote and continuous feed coverage. These are patterns, not proof of investor intent or future returns.',
} as const

function methodFor(chain: Chain): ResearchCoin['methodology'] {
  return {
    ...BASE_METHOD,
    holderStrength: chain === 'solana' ? BASE_METHOD.holderStrength
      : 'Robinhood top-account persistence proxy: 70% of the retained balance of the verified top-20 owner cohort seven finalized days behind the head plus 30% of the inverse current top-20 balance share. The cohort rolls from complete deployment Transfer history and is checked against current balances and supply. Younger tokens need seven finalized days. An address is not necessarily one person; pool vaults and custodians may be included. No periodic snapshots or investment recommendation.',
    holderSource: chain === 'solana'
      ? 'One mint-filtered Helius getProgramAccounts current-state read, followed by finalized LaserStream token-balance updates. A failed or oversized read, unverified replay or stream gap leaves the score unavailable. No periodic snapshots.'
      : RH_RESEARCH_ENABLED
        ? 'ERC-20 Transfer logs replayed from contract deployment through a finalized anchor reconstruct a rolling seven-finalized-day top-owner cohort. Current balances and supply are validated once, followed by contiguous finalized Transfer logs. A failed validation, unverified replay or stream gap leaves the score unavailable. Finalized Robinhood Chain data can lag the latest head. No periodic snapshots.'
        : 'Robinhood holder replay and live Transfer coverage are not enabled. No holder score is generated.',
    priceSource: chain === 'solana'
      ? 'Finalized Yellowstone or mint-filtered LaserStream transactions received by FTL. Only an IDL-recognized single swap with exactly two opposite signer token-balance deltas is retained. Prices and volume are in one quote (USDC, SOL, or USDT) per report. No price backfill; unsupported venues, native-SOL wrapping, multihop and stream gaps can leave coverage incomplete.'
      : 'Finalized Uniswap v4 PoolManager Swap logs from Robinhood Chain pools FTL has indexed. Prices and volume are in one paired quote (USDG, WETH or native ETH) per report. Logs need canonical block timestamps and verified replay; other venues and stream gaps can leave coverage incomplete.',
  }
}

interface ResearchRow {
  chain: Chain
  address: string
  first_seen_ts: number
  symbol: string | null
  name: string | null
  image: string | null
}

interface Cursor { ts: number; chain: Chain; address: string }

export function validSolanaMint(address: unknown): address is string {
  if (typeof address !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false
  try { return bs58.decode(address).length === 32 } catch { return false }
}

const insertResearchToken = db.prepare('INSERT OR IGNORE INTO research_tokens(chain,address,first_seen_ts) VALUES(?,?,?)')
const correctFirstSeen = db.prepare('UPDATE research_tokens SET first_seen_ts = ? WHERE chain = ? AND address = ? AND first_seen_ts > ?')
const confirmedLpEvent = db.prepare("SELECT id, chain, token, kind, ts, COALESCE(confirmed_ts, ts) AS confirmed_ts FROM events WHERE id = ? AND stage = 'confirmed'")
const insertLpEvent = db.prepare('INSERT OR IGNORE INTO research_lp_events(id,chain,address,kind,first_seen_ts,confirmed_ts) VALUES(?,?,?,?,?,?)')

function enroll(chain: Chain, address: string, firstSeenTs: number): boolean {
  if (!address || !Number.isSafeInteger(firstSeenTs) || firstSeenTs < 0) return false
  const created = insertResearchToken.run(chain, address, firstSeenTs).changes > 0
  if (!created) correctFirstSeen.run(firstSeenTs, chain, address, firstSeenTs)
  return created
}

function announce(chain: Chain, address: string, enrolled: boolean): void {
  bus.emit('research', chain, address, enrolled)
}

function enrollToken(chain: Chain, address: string): void {
  const token = db.prepare('SELECT events, launched_ts, first_pool_ts, last_ts FROM tokens WHERE chain = ? AND address = ?').get(chain, address) as
    { events: number; launched_ts: number | null; first_pool_ts: number | null; last_ts: number } | undefined
  if (!token || token.events < 1) return // metadata-only quote assets are not FTL event subjects
  if (enroll(chain, address, token.launched_ts ?? token.first_pool_ts ?? token.last_ts)) announce(chain, address, true)
}

function backfillSeenTokens(): void {
  // Local event history supplies the actual first FTL observation for older
  // tokens. No provider requests and no cap on the enrolled universe.
  db.exec(`INSERT INTO research_tokens(chain,address,first_seen_ts)
    SELECT t.chain,t.address,
      COALESCE((SELECT MIN(e.ts) FROM events e WHERE e.chain = t.chain AND e.token = t.address),
        t.launched_ts, t.first_pool_ts, t.last_ts)
    FROM tokens t WHERE t.chain IN ('solana','robinhood') AND t.events > 0
    ON CONFLICT(chain,address) DO UPDATE SET first_seen_ts = min(research_tokens.first_seen_ts, excluded.first_seen_ts)`)
}

function backfillConfirmedLpEvents(): void {
  // This local migration captures retained FTL history before hub prunes it.
  // Thereafter each confirmed stream event is appended once. No snapshots.
  db.exec(`INSERT OR IGNORE INTO research_lp_events(id,chain,address,kind,first_seen_ts,confirmed_ts)
    SELECT id,chain,token,kind,ts,COALESCE(confirmed_ts,ts) FROM events
    WHERE chain IN ('solana','robinhood') AND stage = 'confirmed' AND token IS NOT NULL
      AND kind IN ('pool_init','liq_add','liq_remove')`)
}

function captureConfirmedLpEvent(id: string): { chain: Chain; address: string } | null {
  const event = confirmedLpEvent.get(id) as
    { id: string; chain: Chain; token: string | null; kind: FlowEvent['kind']; ts: number; confirmed_ts: number } | undefined
  if (!event?.token || !isLpKind(event.kind)) return null
  const inserted = insertLpEvent.run(event.id, event.chain, event.token, event.kind, event.ts, event.confirmed_ts).changes > 0
  return inserted ? { chain: event.chain, address: event.token } : null
}

let started = false
export function startResearch(): void {
  if (started) return
  started = true
  // An interrupted process cannot claim coverage beyond its last received
  // stream pulse. Closing these rows preserves a visible gap across restarts.
  db.exec(`UPDATE research_stream_sessions SET ended_ts =
    COALESCE((SELECT last_pulse_ts FROM research_stream_health h WHERE h.lane = research_stream_sessions.lane), last_pulse_ts)
    WHERE ended_ts IS NULL`)
  db.exec('DELETE FROM research_swaps WHERE finalized = 0')
  backfillSeenTokens()
  backfillConfirmedLpEvents()
  bus.on('token', enrollToken)
  // The event row is already durable when this fires. It also covers any
  // subject that did not arrive through a token-summary update.
  bus.on('event', (event: FlowEvent) => {
    if (!event.token) return
    const created = enroll(event.chain, event.token, event.ts)
    const captured = event.stage === 'confirmed' ? captureConfirmedLpEvent(event.id) : null
    if (created || captured) announce(event.chain, event.token, created)
  })
  // Pending preconfirmation becomes a durable confirmed event in hub before
  // this notification. The client invalidates only the affected research row.
  bus.on('upgrade', (update: { t?: string; id?: string; stage?: string }) => {
    if (update.t !== 'upgrade' || update.stage !== 'confirmed' || !update.id) return
    const captured = captureConfirmedLpEvent(update.id)
    if (captured) announce(captured.chain, captured.address, false)
  })
}

function isLpKind(kind: FlowEvent['kind']): boolean {
  return kind === 'pool_init' || kind === 'liq_add' || kind === 'liq_remove'
}

const hasResearchToken = db.prepare("SELECT 1 FROM research_tokens WHERE chain = 'solana' AND address = ?")
const hasRobinhoodResearchToken = db.prepare("SELECT 1 FROM research_tokens WHERE chain = 'robinhood' AND address = ?")
const insertSwap = db.prepare(`INSERT OR IGNORE INTO research_swaps
  (id,chain,token,quote,quote_symbol,venue,instruction,slot,bank_id,finalized,ts,token_ui,quote_ui,price_quote)
  VALUES (?, 'solana', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
const promoteSwap = db.prepare(`UPDATE research_swaps SET token = ?, quote = ?, quote_symbol = ?,
  venue = ?, instruction = ?, slot = ?, bank_id = ?, finalized = 1, ts = ?,
  token_ui = ?, quote_ui = ?, price_quote = ? WHERE id = ? AND finalized = 0`)
const insertRobinhoodSwap = db.prepare(`INSERT OR IGNORE INTO research_swaps
  (id,chain,token,quote,quote_symbol,venue,instruction,slot,bank_id,finalized,ts,token_ui,quote_ui,price_quote)
  VALUES (?, 'robinhood', ?, ?, ?, 'uniswap-v4', 'Swap', ?, NULL, 1, ?, ?, ?, ?)`)
const pendingAtSlot = db.prepare('SELECT * FROM research_swaps WHERE slot = ? AND finalized = 0')
const finalizeSwap = db.prepare('UPDATE research_swaps SET finalized = 1 WHERE id = ? AND finalized = 0')
const deleteSwap = db.prepare('DELETE FROM research_swaps WHERE id = ? AND finalized = 0')
const prunePending = db.prepare('DELETE FROM research_swaps WHERE finalized = 0 AND slot < ?')
const upsertCandle = db.prepare(`INSERT INTO research_trade_candles
  (chain,token,quote,quote_symbol,day_ts,open,high,low,close,volume_quote,trades,first_trade_ts,last_trade_ts)
  VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)
  ON CONFLICT(chain,token,quote,day_ts) DO UPDATE SET
    open = CASE WHEN excluded.first_trade_ts < research_trade_candles.first_trade_ts THEN excluded.open ELSE research_trade_candles.open END,
    high = max(research_trade_candles.high, excluded.high),
    low = min(research_trade_candles.low, excluded.low),
    close = CASE WHEN excluded.last_trade_ts >= research_trade_candles.last_trade_ts THEN excluded.close ELSE research_trade_candles.close END,
    volume_quote = research_trade_candles.volume_quote + excluded.volume_quote,
    trades = research_trade_candles.trades + 1,
    first_trade_ts = min(research_trade_candles.first_trade_ts, excluded.first_trade_ts),
    last_trade_ts = max(research_trade_candles.last_trade_ts, excluded.last_trade_ts)`)

function addCandle(swap: { chain: Chain; token: string; quote: string; quote_symbol: string; ts: number; price_quote: number; quote_ui: number }): void {
  const day = Math.floor(swap.ts / DAY) * DAY
  upsertCandle.run(swap.chain, swap.token, swap.quote, swap.quote_symbol, day, swap.price_quote,
    swap.price_quote, swap.price_quote, swap.price_quote, swap.quote_ui, swap.ts, swap.ts)
}

const finalizedSlots = new Map<number, { bankId: string | null; status: 'finalized' | 'dead' }>()
function bankMatches(transactionBank: string | null, finalBank: string | null): boolean {
  // When either identity is unavailable, a slot alone cannot disambiguate forks.
  return !!transactionBank && !!finalBank && transactionBank === finalBank
}

const sessionOpen = db.prepare('INSERT INTO research_stream_sessions(lane,token,started_ts,last_pulse_ts) VALUES(?,?,?,?)')
const sessionClose = db.prepare('UPDATE research_stream_sessions SET ended_ts = ?, gap_reason = ? WHERE lane = ? AND token IS ? AND ended_ts IS NULL')
const sessionCloseLane = db.prepare('UPDATE research_stream_sessions SET ended_ts = ?, gap_reason = ? WHERE lane = ? AND ended_ts IS NULL')
const sessionResume = db.prepare(`UPDATE research_stream_sessions SET ended_ts = NULL, gap_reason = NULL
  WHERE id = (SELECT id FROM research_stream_sessions WHERE lane = ? AND token IS ? ORDER BY id DESC LIMIT 1)
    AND ended_ts IS NOT NULL AND (gap_reason IS NULL OR gap_reason IN ('stream disconnected', 'stream restarted'))`)
const pulseHealth = db.prepare('INSERT INTO research_stream_health(lane,last_pulse_ts) VALUES(?,?) ON CONFLICT(lane) DO UPDATE SET last_pulse_ts = excluded.last_pulse_ts')

export function onResearchSwapStream(event: SwapStreamEvent): void {
  if (!Number.isSafeInteger(event.ts) || event.ts <= 0) return
  if (event.t === 'slot') {
    if (!Number.isSafeInteger(event.slot) || event.slot < 0) return
    finalizedSlots.set(event.slot, { bankId: event.bankId, status: event.status })
    if (finalizedSlots.size > 4096) finalizedSlots.delete(finalizedSlots.keys().next().value!)
    const changed = new Set<string>()
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of pendingAtSlot.all(event.slot) as any[]) {
        if (event.status === 'dead' || !bankMatches(row.bank_id, event.bankId)) {
          deleteSwap.run(row.id)
          continue
        }
        if (finalizeSwap.run(row.id).changes > 0) { addCandle(row); changed.add(row.token) }
      }
      if (event.slot % 128 === 0) prunePending.run(event.slot - 128)
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
    for (const token of changed) announce('solana', token, false)
    return
  }
  if (event.token && !(event.lane === 'robinhood-swaps'
    ? validRhAddress(event.token) : validSolanaMint(event.token))) return
  const token = event.token ?? null
  if (event.t === 'pulse') { pulseHealth.run(event.lane, event.ts); return }
  if (event.t === 'open') {
    sessionClose.run(event.ts, 'stream restarted', event.lane, token)
    sessionOpen.run(event.lane, token, event.ts, event.ts)
    pulseHealth.run(event.lane, event.ts)
    return
  }
  if (event.t === 'resume') {
    // Only a provider-confirmed replay may bridge a disconnect. A recorded
    // unreplayed gap cannot be erased by this event.
    if (sessionResume.run(event.lane, token).changes === 0) sessionOpen.run(event.lane, token, event.ts, event.ts)
    pulseHealth.run(event.lane, event.ts)
    return
  }
  if (event.t === 'close' || event.t === 'gap') {
    const reason = event.t === 'gap' ? (event.reason ?? 'unreplayed stream gap') : 'stream disconnected'
    if (token) sessionClose.run(event.ts, reason, event.lane, token)
    else sessionCloseLane.run(event.ts, reason, event.lane)
    pulseHealth.run(event.lane, event.ts)
  }
}

// A named LaserStream filter can acknowledge the entire enrolled universe at
// once. Commit those per-mint session changes together so the initial ACK
// does not stall the API event loop with thousands of SQLite autocommits.
export function onResearchSwapStreamBatch(events: SwapStreamEvent[]): void {
  if (!events.length) return
  const valid = events.filter((event): event is SwapStreamEvent &
    { t: 'open' | 'resume'; token: string } =>
    (event.t === 'open' || event.t === 'resume') && !!event.token &&
    Number.isSafeInteger(event.ts) && event.ts > 0 &&
    (event.lane === 'robinhood-swaps' ? validRhAddress(event.token) : validSolanaMint(event.token)))
  if (!valid.length) return
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const event of valid) {
      if (event.t === 'open') {
        sessionClose.run(event.ts, 'stream restarted', event.lane, event.token)
        sessionOpen.run(event.lane, event.token, event.ts, event.ts)
      } else if (sessionResume.run(event.lane, event.token).changes === 0) {
        sessionOpen.run(event.lane, event.token, event.ts, event.ts)
      }
    }
    const latest = valid[valid.length - 1]
    pulseHealth.run(latest.lane, latest.ts)
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

export function ingestSwap(swap: SwapObservation): void {
  if (!validSolanaMint(swap.token) || !validSolanaMint(swap.quote) ||
    quoteSymbolFor(swap.quote) !== swap.quoteSymbol ||
    !Number.isFinite(swap.priceQuote) || swap.priceQuote <= 0 ||
    !Number.isFinite(swap.quoteUi) || swap.quoteUi <= 0 ||
    !Number.isFinite(swap.tokenUi) || swap.tokenUi <= 0 ||
    !Number.isSafeInteger(swap.ts) || swap.ts <= 0 || !Number.isSafeInteger(swap.slot) || swap.slot < 0 ||
    typeof swap.id !== 'string' || swap.id.length > 128) return
  // Upstream subscriptions contain more trades than FTL's event subjects.
  // Research follows every FTL-seen token, not the entire DEX universe.
  if (!hasResearchToken.get(swap.token)) return
  const slotState = finalizedSlots.get(swap.slot)
  if (slotState?.status === 'dead') return
  const final = swap.finalized === true || (slotState?.status === 'finalized' &&
    bankMatches(swap.bankId ?? null, slotState.bankId))
  let finalizedNow = false
  db.exec('BEGIN IMMEDIATE')
  try {
    const id = `solana:${swap.id}`
    const inserted = insertSwap.run(id, swap.token, swap.quote, swap.quoteSymbol,
      swap.venue, swap.instruction, swap.slot, swap.bankId ?? null, Number(final), swap.ts,
      swap.tokenUi, swap.quoteUi, swap.priceQuote).changes > 0
    finalizedNow = !!(inserted && final)
    if (!inserted && final) finalizedNow = promoteSwap.run(swap.token, swap.quote, swap.quoteSymbol,
      swap.venue, swap.instruction, swap.slot, swap.bankId ?? null, swap.ts,
      swap.tokenUi, swap.quoteUi, swap.priceQuote, id).changes > 0
    if (finalizedNow) addCandle({ chain: 'solana', token: swap.token, quote: swap.quote, quote_symbol: swap.quoteSymbol,
      ts: swap.ts, price_quote: swap.priceQuote, quote_ui: swap.quoteUi })
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
  if (finalizedNow) announce('solana', swap.token, false)
}

const RH_QUOTES = new Map<string, 'ETH' | 'WETH' | 'USDG'>([
  ['0x0000000000000000000000000000000000000000', 'ETH'],
  ['0x0bd7d308f8e1639fab988df18a8011f41eacad73', 'WETH'],
  ['0x5fc5360d0400a0fd4f2af552add042d716f1d168', 'USDG'],
])
const validRhAddress = (address: string): boolean => /^0x[0-9a-f]{40}$/.test(address)

export interface RobinhoodSwapObservation {
  chain: 'robinhood'
  id: string                 // transaction hash + log index
  token: string              // lower-case ERC-20 address
  quote: string              // lower-case quote currency address
  quoteSymbol: string
  tokenUi: number
  quoteUi: number
  priceQuote: number
  blockNumber: number
  ts: number                 // canonical block timestamp, milliseconds
  finalized: boolean        // true only after canonical block finality
}

export function ingestRobinhoodSwap(swap: RobinhoodSwapObservation): void {
  if (swap.chain !== 'robinhood' || swap.finalized !== true || !validRhAddress(swap.token) ||
    !validRhAddress(swap.quote) ||
    swap.quoteSymbol !== (RH_QUOTES.get(swap.quote) ?? swap.quote) ||
    !/^0x[0-9a-f]{64}:(?:0x[0-9a-f]+|[0-9]+)$/.test(swap.id) ||
    !Number.isSafeInteger(swap.blockNumber) || swap.blockNumber < 0 ||
    !Number.isSafeInteger(swap.ts) || swap.ts <= 0 ||
    !Number.isFinite(swap.tokenUi) || swap.tokenUi <= 0 ||
    !Number.isFinite(swap.quoteUi) || swap.quoteUi <= 0 ||
    !Number.isFinite(swap.priceQuote) || swap.priceQuote <= 0 ||
    Math.abs(swap.quoteUi / swap.tokenUi - swap.priceQuote) / swap.priceQuote > 1e-6 ||
    !hasRobinhoodResearchToken.get(swap.token)) return
  const id = `robinhood:${swap.id}`
  let inserted = false
  db.exec('BEGIN IMMEDIATE')
  try {
    inserted = insertRobinhoodSwap.run(id, swap.token, swap.quote, swap.quoteSymbol,
      swap.blockNumber, swap.ts, swap.tokenUi, swap.quoteUi, swap.priceQuote).changes > 0
    if (inserted) addCandle({ chain: 'robinhood', token: swap.token, quote: swap.quote,
      quote_symbol: swap.quoteSymbol, ts: swap.ts, price_quote: swap.priceQuote, quote_ui: swap.quoteUi })
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
  if (inserted) announce('robinhood', swap.token, false)
}

interface PriceData {
  quote: ResearchCoin['priceQuote']
  candles: ResearchCandle[]
  trades: number
  lastTradeTs: number | null
}

function readPrice(chain: Chain, token: string, now = Date.now()): PriceData {
  const today = Math.floor(now / DAY) * DAY
  const selected = db.prepare(`SELECT quote, quote_symbol FROM research_trade_candles
    WHERE chain = ? AND token = ? AND day_ts >= ?
    GROUP BY quote ORDER BY COUNT(*) DESC, SUM(trades) DESC,
      CASE quote_symbol WHEN 'USDC' THEN 0 WHEN 'USDG' THEN 0 WHEN 'SOL' THEN 1 WHEN 'ETH' THEN 1 ELSE 2 END LIMIT 1`)
    .get(chain, token, today - 30 * DAY) as { quote: string; quote_symbol: ResearchCoin['priceQuote'] } | undefined
  if (!selected) return { quote: null, candles: [], trades: 0, lastTradeTs: null }
  const rows = db.prepare(`SELECT day_ts, open, high, low, close, volume_quote, trades, last_trade_ts
    FROM research_trade_candles WHERE chain = ? AND token = ? AND quote = ? AND day_ts >= ?
    ORDER BY day_ts ASC LIMIT 31`).all(chain, token, selected.quote, today - 30 * DAY) as any[]
  return {
    quote: selected.quote_symbol,
    candles: rows.map(r => ({ ts: r.day_ts, open: r.open, high: r.high, low: r.low, close: r.close,
      volumeQuote: r.volume_quote, trades: r.trades })),
    trades: rows.reduce((sum, r) => sum + r.trades, 0),
    lastTradeTs: rows.reduce((latest, r) => Math.max(latest, r.last_trade_ts), 0) || null,
  }
}

function continuousPriceCoverage(chain: Chain, token: string, start: number, end: number, now = Date.now()): boolean {
  const lanes = chain === 'solana'
    ? ['laserstream'] // only the all-mint finalized subscription can certify a continuous price window
    : ['robinhood-swaps']
  const laneFilter = lanes.map(() => '?').join(',')
  const rows = db.prepare(`SELECT s.started_ts, s.ended_ts, h.last_pulse_ts
    FROM research_stream_sessions s LEFT JOIN research_stream_health h ON h.lane = s.lane
    WHERE s.lane IN (${laneFilter}) AND (s.token IS NULL OR s.token = ?) AND s.started_ts <= ?
      AND (s.ended_ts IS NULL OR s.ended_ts >= ?)
    ORDER BY s.started_ts ASC`).all(...lanes, token, end, start) as
    { started_ts: number; ended_ts: number | null; last_pulse_ts: number | null }[]
  let coveredThrough = start
  for (const row of rows) {
    if (row.started_ts > coveredThrough) return false
    const lastPulse = row.last_pulse_ts ?? row.started_ts
    const intervalEnd = row.ended_ts ?? (now - lastPulse <= 20_000 ? now : lastPulse)
    coveredThrough = Math.max(coveredThrough, intervalEnd)
    if (coveredThrough >= end) return true
  }
  return false
}

function priceStreamCoverage(chain: Chain, token: string, now = Date.now()): Pick<ResearchCoin['coverage'],
  'priceStreamState' | 'priceStreamLastTs' | 'priceStreamLagMs' | 'priceStreamReason'> {
  const lanes = chain === 'solana'
    ? ['geyser-primary', 'geyser', 'geyser-drpc', 'laserstream']
    : ['robinhood-swaps']
  const laneFilter = lanes.map(() => '?').join(',')
  const row = db.prepare(`SELECT s.lane, s.token, s.ended_ts, s.gap_reason, h.last_pulse_ts
    FROM research_stream_sessions s LEFT JOIN research_stream_health h ON h.lane = s.lane
    WHERE s.lane IN (${laneFilter}) AND (s.token IS NULL OR s.token = ?)
    ORDER BY CASE WHEN s.token = ? THEN 0 ELSE 1 END, s.started_ts DESC LIMIT 1`)
    .get(...lanes, token, token) as
    { lane: string; token: string | null; ended_ts: number | null; gap_reason: string | null; last_pulse_ts: number | null } | undefined
  if (!row) return { priceStreamState: 'unconfigured', priceStreamLastTs: null,
    priceStreamLagMs: null, priceStreamReason: 'No verified price-swap stream has been enrolled for this token.' }
  const last = row.last_pulse_ts ?? null
  const lag = last === null ? null : Math.max(0, now - last)
  const state = row.ended_ts !== null ? 'gap' : lag === null || lag > 20_000 ? 'stale'
    : row.token ? 'subscribed_unverified' : 'observing'
  const reason = state === 'gap' ? (row.gap_reason ?? 'stream disconnected')
    : state === 'stale' ? 'No recent stream heartbeat; price observations may be delayed.'
      : state === 'observing' ? 'DEX-program stream sees eligible swaps only from supported venues.'
        : 'Mint filter is acknowledged on a finalized stream; recognized swap venues and quote pairs are still partial market coverage.'
  return { priceStreamState: state, priceStreamLastTs: last, priceStreamLagMs: lag,
    priceStreamReason: reason }
}

const round1 = (n: number) => Math.round(n * 10) / 10
const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n))
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return 0
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function computeBottoming(candles: ResearchCandle[], now = Date.now()): ResearchBottoming {
  const today = Math.floor(now / DAY) * DAY
  const days = candles.filter(c => c.ts >= today - 30 * DAY && c.ts < today &&
    c.open > 0 && c.high >= c.low && c.low > 0 && c.close > 0 && c.volumeQuote > 0 && c.trades > 0)
    .sort((a, b) => a.ts - b.ts)
  const complete = days.length === 30 && days[0].ts === today - 30 * DAY &&
    days.every((c, i) => c.ts === today - (30 - i) * DAY)
  const none: ResearchBottoming = {
    signs: null, reason: `${days.length}/30 completed UTC days have eligible swaps in one quote; 30 consecutive days are required.`,
    drawdownPct: null, sellersCapitulated: null, lowHolding: null, demandReturning: null,
    observedTs: days.at(-1)?.ts ?? null,
  }
  if (!complete) return none
  const last = days[29]
  const high = Math.max(...days.map(c => c.high))
  const low = Math.min(...days.map(c => c.low))
  const drawdownPct = clamp(100 * (last.close / high - 1), -100, 0)
  const fallen = drawdownPct <= -30
  const typicalVolume = median(days.map(c => c.volumeQuote))
  const recent = days.slice(-3)
  const priorSelloff = days.slice(-14, -3).filter(c => c.close <= 0.85 * c.open && c.volumeQuote >= 1.5 * typicalVolume)
    .sort((a, b) => b.volumeQuote - a.volumeQuote)[0]
  const recentVolume = recent.reduce((sum, c) => sum + c.volumeQuote, 0) / 3
  const sellersCapitulated = !!(fallen && priorSelloff && recentVolume <= 0.65 * priorSelloff.volumeQuote)
  const lowDay = days.find(c => c.low === low)!
  const lowHolding = !!(fallen && lowDay.ts <= last.ts - 3 * DAY &&
    recent.every(c => c.low >= 0.98 * low && c.close <= 1.25 * low))
  const priorVolume = median(days.slice(-8, -1).map(c => c.volumeQuote))
  const demandReturning = !!(fallen && last.close >= 1.03 * days[28].close &&
    last.volumeQuote >= 1.25 * priorVolume && priorVolume > 0)
  return {
    signs: [sellersCapitulated, lowHolding, demandReturning].filter(Boolean).length,
    reason: null, drawdownPct: round1(drawdownPct), sellersCapitulated, lowHolding, demandReturning,
    observedTs: last.ts,
  }
}

function liveLiquidity(chain: Chain, address: string): ResearchCoin['liveLiquidity'] {
  const row = db.prepare(`SELECT
      COALESCE(SUM(kind = 'pool_init'), 0) AS pool_inits,
      COALESCE(SUM(kind = 'liq_add'), 0) AS adds,
      COALESCE(SUM(kind = 'liq_remove'), 0) AS removes,
      MIN(first_seen_ts) AS observation_start_ts,
      MAX(confirmed_ts) AS last_event_ts
    FROM research_lp_events WHERE chain = ? AND address = ?`).get(chain, address) as any
  return {
    poolInits: Number(row.pool_inits), adds: Number(row.adds), removes: Number(row.removes),
    observationStartTs: row.observation_start_ts ?? null, lastEventTs: row.last_event_ts ?? null,
  }
}

function holderMeasure(chain: Chain, address: string): {
  strength: ResearchCoin['holderStrength']
  coverage: Pick<ResearchCoin['coverage'], 'holderBootstrapAttempts' | 'holderState' |
    'holderAccounts' | 'holderOwners' | 'holderLastSlot' | 'holderCoveredThroughSlot' |
    'holderBootstrapResponseBytes' | 'holderBootstrapPageAccounts' | 'holderBootstrapDbGrowthBytes' |
    'holderWindowDays'>
  observedTs: number | null
} {
  const holder: HolderStatus | RobinhoodHolderStatus | null = chain === 'solana'
    ? holderStatus(address) : RH_RESEARCH_ENABLED ? robinhoodHolderStatus(address) : null
  const live = holder?.state === 'live' && holder.baselineSlot !== null
  const retention = live ? holder.baselineRetentionPct : null
  const share = live ? holder.top20SharePct : null
  const baselineShare = live ? holder.baselineTop20SharePct : null
  const days = live ? holder.observedDays : null
  const measured = retention !== null && share !== null && baselineShare !== null &&
    days !== null && Number.isFinite(days)
  const score = measured && days >= 7 ? round1(clamp(0.7 * retention + 0.3 * (100 - share), 0, 100)) : null
  const reason = !holder ? HOLDER_REASON[chain]
    : !live ? (holder.reason ?? 'Complete finalized holder coverage is not available.')
      : !measured ? 'A complete baseline with positive owner balances is required to measure top-account retention.'
        : days < 7 ? chain === 'robinhood'
          ? `${round1(days)}/7 finalized days available for the event-derived owner cohort; a younger token needs seven days.`
          : `${round1(days)}/7 days observed since the complete holder baseline; the score needs seven days of continuous finalized coverage.`
          : null
  return {
    strength: {
      score, reason, retentionPct: measured ? round1(retention) : null,
      top20SharePct: measured ? round1(share) : null,
      top20ShareChangePct: measured ? round1(share - baselineShare) : null,
      baselineTs: holder?.baselineTs ?? null, observedTs: live ? holder.observedTs : null,
    },
    coverage: {
      holderBootstrapAttempts: holder?.bootstrapAttemptedAt === null || !holder ? 0 : 1,
      holderState: holder?.state ?? 'unconfigured',
      holderAccounts: live ? holder.accountCount : null,
      holderOwners: live ? holder.ownerCount : null,
      holderLastSlot: live ? holder.lastSlot : null,
      holderCoveredThroughSlot: live ? holder.coveredThroughSlot : null,
      holderBootstrapResponseBytes: holder?.bootstrapResponseBytes ?? null,
      holderBootstrapPageAccounts: holder?.bootstrapPageAccounts ?? null,
      holderBootstrapDbGrowthBytes: holder?.bootstrapDbGrowthBytes ?? null,
      holderWindowDays: days === null ? null : round1(days),
    },
    observedTs: live ? holder.observedTs : null,
  }
}

function fromRow(row: ResearchRow, detail = false): ResearchCoin | ResearchCoinDetail {
  const price = readPrice(row.chain, row.address)
  const liquidity = liveLiquidity(row.chain, row.address)
  const holder = holderMeasure(row.chain, row.address)
  const now = Date.now()
  const today = Math.floor(now / DAY) * DAY
  const streamCovered = row.chain === 'solana' &&
    continuousPriceCoverage(row.chain, row.address, today - 30 * DAY, today, now)
  const observedBottoming = price.candles.length ? computeBottoming(price.candles, now) : null
  const bottoming: ResearchBottoming = price.candles.length
    ? (streamCovered || observedBottoming?.signs === null ? observedBottoming! : {
      signs: null, reason: row.chain === 'robinhood'
        ? 'Finalized Uniswap v4 swap samples are observed, but Pons curve and other Robinhood Chain venues are not covered; a full-token bottoming score is unavailable.'
        : 'Thirty completed days of continuous finalized swap-stream coverage are not verified; observed trades may be incomplete.',
      drawdownPct: null, sellersCapitulated: null, lowHolding: null, demandReturning: null,
      observedTs: price.candles.at(-1)!.ts,
    })
    : { signs: null, reason: BOTTOMING_REASON[row.chain], drawdownPct: null,
      sellersCapitulated: null, lowHolding: null, demandReturning: null, observedTs: null }
  const status: ResearchCoin['status'] = holder.strength.score !== null && bottoming.signs !== null ? 'ready'
    : holder.coverage.holderState === 'live' || price.trades > 0 ? 'insufficient_data'
      : holder.coverage.holderState === 'fetching' ? 'collecting'
        : holder.coverage.holderState === 'pending' && !holder.strength.reason?.includes('not enabled') ? 'queued'
          : 'source_unavailable'
  const item: ResearchCoin = {
    chain: row.chain, address: row.address,
    symbol: row.symbol ?? undefined, name: row.name ?? undefined, image: row.image ?? undefined,
    status,
    statusReason: holder.strength.reason || bottoming.reason
      ? [holder.strength.reason, bottoming.reason].filter(Boolean).join(' Price coverage: ')
      : status === 'ready' ? null : SOURCE_REASON[row.chain],
    firstSeenTs: row.first_seen_ts,
    updatedTs: Math.max(liquidity.lastEventTs ?? 0, price.lastTradeTs ?? 0, holder.observedTs ?? 0) || null,
    nextRefreshTs: null, priceQuote: price.quote,
    liveLiquidity: liquidity,
    holderStrength: holder.strength,
    bottoming,
    coverage: {
      ...holder.coverage, priceCandles: price.candles.length, priceTrades: price.trades,
      priceWindowDays: price.candles.length > 1 ? round1((price.candles.at(-1)!.ts - price.candles[0].ts) / DAY) : null,
      ...priceStreamCoverage(row.chain, row.address, now),
    },
    methodology: methodFor(row.chain),
    ...(row.chain === 'robinhood' && RH_PROVISIONAL_ENABLED
      ? { provisional: robinhoodProvisionalStatus(row.address) } : {}),
  }
  return detail ? { ...item, priceHistory: price.candles, holderHistory: [] } : item
}

function decodeCursor(value: string | null): Cursor | null {
  if (!value) return null
  if (value.length > 256) throw new HttpError(400, 'invalid research cursor')
  try {
    const raw = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!Array.isArray(raw) || raw.length !== 3 || !Number.isSafeInteger(raw[0]) || raw[0] < 0 ||
      (raw[1] !== 'solana' && raw[1] !== 'robinhood') ||
      typeof raw[2] !== 'string' || raw[2].length < 1 || raw[2].length > 128) throw new Error('cursor')
    return { ts: raw[0], chain: raw[1], address: raw[2] }
  } catch { throw new HttpError(400, 'invalid research cursor') }
}

function encodeCursor(row: ResearchRow): string {
  return Buffer.from(JSON.stringify([row.first_seen_ts, row.chain, row.address])).toString('base64url')
}

export function listResearch(q = new URLSearchParams()): ResearchList {
  const cursor = decodeCursor(q.get('cursor'))
  const requestedLimit = Number(q.get('limit') ?? 50)
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(Math.trunc(requestedLimit), 100)) : 50
  const search = (q.get('search') ?? '').trim()
  if (search.length > 80) throw new HttpError(400, 'research search is too long')
  const chain = q.get('chain')
  if (chain !== null && chain !== 'solana' && chain !== 'robinhood') throw new HttpError(400, 'invalid research chain')
  const filters: string[] = []
  const filterArgs: (number | string)[] = []
  if (chain) { filters.push('r.chain = ?'); filterArgs.push(chain) }
  if (search) {
    filters.push('(instr(lower(r.address), lower(?)) > 0 OR instr(lower(t.symbol), lower(?)) > 0 OR instr(lower(t.name), lower(?)) > 0)')
    filterArgs.push(search, search, search)
  }
  const cursorFilter = 'r.first_seen_ts < ? OR (r.first_seen_ts = ? AND (r.chain < ? OR (r.chain = ? AND r.address < ?)))'
  const pageFilters = cursor ? [...filters, `(${cursorFilter})`] : filters
  const where = pageFilters.length ? `WHERE ${pageFilters.join(' AND ')}` : ''
  const args: (number | string)[] = [...filterArgs, ...(cursor ? [cursor.ts, cursor.ts, cursor.chain, cursor.chain, cursor.address] : [])]
  const rows = db.prepare(`SELECT r.chain, r.address, r.first_seen_ts, t.symbol, t.name, t.image
    FROM research_tokens r LEFT JOIN tokens t ON t.chain = r.chain AND t.address = r.address
    ${where} ORDER BY r.first_seen_ts DESC, r.chain DESC, r.address DESC LIMIT ?`).all(...args, limit + 1) as unknown as ResearchRow[]
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const total = filters.length
    ? (db.prepare(`SELECT COUNT(*) AS n FROM research_tokens r
        LEFT JOIN tokens t ON t.chain = r.chain AND t.address = r.address
        WHERE ${filters.join(' AND ')}`).get(...filterArgs) as { n: number }).n
    : (db.prepare('SELECT COUNT(*) AS n FROM research_tokens').get() as { n: number }).n
  return {
    items: page.map(row => fromRow(row) as ResearchCoin), total, backlog: null,
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
    coverageNote: COVERAGE_NOTE,
  }
}

export function getResearch(chain: Chain, address: string): ResearchCoinDetail {
  if (chain !== 'solana' && chain !== 'robinhood') throw new HttpError(400, 'invalid research chain')
  if (typeof address !== 'string' || !address || address.length > 128) throw new HttpError(400, 'invalid research address')
  if (chain === 'robinhood') address = address.toLowerCase()
  const row = db.prepare(`SELECT r.chain, r.address, r.first_seen_ts, t.symbol, t.name, t.image
    FROM research_tokens r LEFT JOIN tokens t ON t.chain = r.chain AND t.address = r.address
    WHERE r.chain = ? AND r.address = ?`).get(chain, address) as unknown as ResearchRow | undefined
  if (!row) throw new HttpError(404, 'token has not been seen by FTL')
  return fromRow(row, true) as ResearchCoinDetail
}
