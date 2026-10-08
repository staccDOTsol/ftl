// One-time program identity for historical FTL-seen Solana mints. Confirmed
// launch instructions with a fixed token-program account are local evidence;
// residual unknown and Token-2022 mints consume one batched raw mint-account
// lookup. The same bytes establish owner program and all mint TLV types.

import { db, getCursor, setCursor } from '../db.ts'
import { bus } from '../hub.ts'
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM, recordKnownTokenProgram, recordToken2022RawEvidence } from './holders.ts'

const EVENT_CURSOR = 'holder:program:event:last'
const EVENT_DONE = 'holder:program:event:done'
const EVENT_BATCH = 100
const RPC_BATCH = 20
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const ESTIMATED_CREDITS_PER_RPC_CALL = 1

// These exact instruction names have fixed token-program account addresses in
// the shipped venue IDLs. Ambiguous names, including Raydium initialize_v2,
// are deliberately left for the raw mint read. Never infer a program from venue alone.
export const FIXED_LAUNCH_PROGRAMS: Readonly<Record<string, string>> = Object.freeze({
  'pumpfun:create': TOKEN_PROGRAM,
  'pumpfun:create_v2': TOKEN_2022_PROGRAM,
  'meteora-dbc:initialize_virtual_pool_with_spl_token': TOKEN_PROGRAM,
  'meteora-dbc:initialize_virtual_pool_with_token2022': TOKEN_2022_PROGRAM,
  'meteora-dbc:initialize_virtual_pool_with_token2022_transfer_hook': TOKEN_2022_PROGRAM,
  'raydium-launchlab:initialize_with_token_2022': TOKEN_2022_PROGRAM,
})

db.exec(`
CREATE TABLE IF NOT EXISTS research_holder_program_backfill_attempts (
  mint TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  attempted_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 1,
  next_retry_at INTEGER,
  response_bytes INTEGER NOT NULL DEFAULT 0,
  reason TEXT
);
CREATE TABLE IF NOT EXISTS research_holder_program_backfill_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempted_at INTEGER NOT NULL,
  mint_count INTEGER NOT NULL,
  response_bytes INTEGER NOT NULL DEFAULT 0,
  estimated_credits INTEGER NOT NULL,
  status TEXT NOT NULL
);
`)
// A process crash can leave the result of a sent request unknowable. Never
// silently send a second current-state metadata read for that mint.
db.prepare("UPDATE research_holder_program_backfill_attempts SET status='blocked',next_retry_at=NULL,reason='Metadata read was interrupted; outcome is unknown.' WHERE status='reserved'").run()

type Phase = 'events' | 'rpc' | 'done' | 'paused'
export interface ProgramBackfillStep {
  phase: Phase
  scanned: number
  mapped: number
  attempts: number
  responseBytes: number
  reason?: string
}
export interface ProgramBackfillStatus {
  eventScanDone: boolean
  eventScanned: number
  knownPrograms: number
  unknownPrograms: number
  queuedMints: number
  retryMints: number
  blockedMints: number
  missingMints: number
  extensionPendingMints: number
  extensionTransparentMints: number
  extensionConfidentialMints: number
  extensionInconclusiveMints: number
  rpcAttempts: number
  rpcCalls: number
  estimatedRpcCredits: number
  responseBytes: number
  todayRpcCalls: number
  dailyRpcLimit: number
}

const unknownEventMints = db.prepare(`SELECT mint FROM research_holder_state
  WHERE program_id IS NULL AND mint>? ORDER BY mint LIMIT ?`)
const rpcCandidates = db.prepare(`SELECT h.mint FROM research_holder_state h
  LEFT JOIN research_holder_extension_evidence x ON x.mint=h.mint
  LEFT JOIN research_holder_program_backfill_attempts a ON a.mint=h.mint
  WHERE (h.program_id IS NULL OR (h.program_id=? AND x.mint IS NULL)) AND
    (a.mint IS NULL OR
    (a.status='retry' AND a.next_retry_at<=?))
  ORDER BY h.first_seen_ts,h.mint LIMIT ?`)
const insertAttempt = db.prepare(`INSERT OR IGNORE INTO research_holder_program_backfill_attempts(mint,status,attempted_at,reason)
  VALUES(?,?,?,?)`)
const updateAttempt = db.prepare(`UPDATE research_holder_program_backfill_attempts
  SET status=?,response_bytes=?,reason=?,next_retry_at=? WHERE mint=?`)
const reserveAttempt = db.prepare(`INSERT INTO research_holder_program_backfill_attempts
  (mint,status,attempted_at,request_count,next_retry_at,reason) VALUES(?,'reserved',?,1,?,NULL)
  ON CONFLICT(mint) DO UPDATE SET status='reserved',attempted_at=excluded.attempted_at,
  request_count=request_count+1,next_retry_at=excluded.next_retry_at,reason=NULL`)
const insertCall = db.prepare(`INSERT INTO research_holder_program_backfill_calls
  (attempted_at,mint_count,estimated_credits,status) VALUES(?,?,?,?)`)
const updateCall = db.prepare(`UPDATE research_holder_program_backfill_calls
  SET response_bytes=?,status=? WHERE id=?`)
const attemptCount = db.prepare('SELECT request_count FROM research_holder_program_backfill_attempts WHERE mint=?')

function retryMint(mint: string, responseBytes: number, reason: string, retryAfterMs = 0): void {
  const attempts = (attemptCount.get(mint) as { request_count: number }).request_count
  const backoff = Math.max(retryAfterMs, Math.min(3_600_000, 10_000 * 2 ** Math.min(8, attempts - 1)))
  updateAttempt.run('retry', responseBytes, reason, Date.now() + backoff, mint)
}

function explicitRpcUrl(raw: string | undefined): string | null {
  if (!raw || raw === 'off') return null
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' ? url.toString() : null
  } catch { return null }
}
function dailyLimit(): number {
  const n = Number(process.env.HOLDER_PROGRAM_RPC_DAILY_LIMIT ?? process.env.HOLDER_PROGRAM_DAS_DAILY_LIMIT ?? 0)
  return Number.isSafeInteger(n) && n >= 0 && n <= 10_000 ? n : 0
}
function dailyKeys(): { own: string; meta: string } {
  const day = new Date().toISOString().slice(0, 10)
  return { own: `holder:program:rpc:${day}`, meta: `meta:rpc:${day}` }
}
function budgetReason(): string | null {
  const { own, meta } = dailyKeys()
  const ownLimit = dailyLimit()
  if (ownLimit > 0 && Number(getCursor(own) ?? 0) >= ownLimit) return 'One-time program RPC daily call limit reached.'
  const metaLimit = Number(process.env.META_RPC_DAILY_LIMIT ?? 0)
  if (Number.isFinite(metaLimit) && metaLimit > 0 && Number(getCursor(meta) ?? 0) >= metaLimit)
    return 'Shared metadata RPC daily call limit reached.'
  return null
}
function reserveCall(mints: string[]): number {
  const { own, meta } = dailyKeys()
  db.exec('BEGIN IMMEDIATE')
  try {
    const reason = budgetReason()
    if (reason) throw new Error(reason)
    const now = Date.now()
    for (const mint of mints) reserveAttempt.run(mint, now, null)
    setCursor(own, String(Number(getCursor(own) ?? 0) + 1))
    setCursor(meta, String(Number(getCursor(meta) ?? 0) + 1))
    const id = Number(insertCall.run(now, mints.length, ESTIMATED_CREDITS_PER_RPC_CALL, 'reserved').lastInsertRowid)
    db.exec('COMMIT')
    return id
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
async function boundedJson(response: Response): Promise<{ body: unknown; bytes: number }> {
  if (Number(response.headers.get('content-length') ?? 0) > MAX_RESPONSE_BYTES || !response.body)
    throw new Error('Raw mint response exceeded the bounded size or had no body.')
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > MAX_RESPONSE_BYTES) throw new Error('Raw mint response exceeded the bounded size.')
    chunks.push(chunk)
  }
  return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')), bytes }
}

export async function stepProgramBackfill(options: { rpcUrl?: string; fetcher?: typeof fetch } = {}): Promise<ProgramBackfillStep> {
  if (getCursor(EVENT_DONE) !== '1') {
    const rows = unknownEventMints.all(getCursor(EVENT_CURSOR) ?? '', EVENT_BATCH) as { mint: string }[]
    if (rows.length) {
      const mints = rows.map(row => row.mint)
      const placeholders = mints.map(() => '?').join(',')
      const events = db.prepare(`SELECT token,venue,ix FROM events
        WHERE chain='solana' AND stage='confirmed' AND kind='launch' AND token IN (${placeholders})`)
        .all(...mints) as { token: string; venue: string; ix: string }[]
      const programs = new Map<string, Map<string, string>>()
      for (const event of events) {
        const program = FIXED_LAUNCH_PROGRAMS[`${event.venue}:${event.ix}`]
        if (!program) continue
        let found = programs.get(event.token)
        if (!found) { found = new Map(); programs.set(event.token, found) }
        found.set(program, `confirmed-launch:${event.venue}:${event.ix}`)
      }
      let mapped = 0
      for (const mint of mints) {
        const found = programs.get(mint)
        if (found?.size === 1) {
          const [program, source] = [...found][0]
          if (recordKnownTokenProgram(mint, program, source)) mapped++
        } else if (found && found.size > 1) {
          insertAttempt.run(mint, 'conflict', Date.now(), 'Confirmed launch instructions disagree on token program.')
        }
      }
      setCursor(EVENT_CURSOR, mints[mints.length - 1])
      setCursor('holder:program:event:scanned', String(Number(getCursor('holder:program:event:scanned') ?? 0) + mints.length))
      return { phase: 'events', scanned: mints.length, mapped, attempts: 0, responseBytes: 0 }
    }
    setCursor(EVENT_DONE, '1')
  }

  const mints = (rpcCandidates.all(TOKEN_2022_PROGRAM, Date.now(), RPC_BATCH) as { mint: string }[]).map(row => row.mint)
  if (!mints.length) {
    const waiting = (db.prepare(`SELECT COUNT(*) AS n FROM research_holder_program_backfill_attempts a
      JOIN research_holder_state h ON h.mint=a.mint
      LEFT JOIN research_holder_extension_evidence x ON x.mint=h.mint
      WHERE (h.program_id IS NULL OR (h.program_id=? AND x.mint IS NULL)) AND
        a.status='retry'`).get(TOKEN_2022_PROGRAM) as { n: number }).n
    return { phase: waiting ? 'paused' : 'done', scanned: 0, mapped: 0, attempts: 0, responseBytes: 0,
      ...(waiting ? { reason: 'Transient raw mint RPC attempts are waiting for bounded retry backoff.' } : {}) }
  }
  const reason = budgetReason()
  if (reason) return { phase: 'paused', scanned: 0, mapped: 0, attempts: 0, responseBytes: 0, reason }
  const rpcUrl = explicitRpcUrl(options.rpcUrl ?? process.env.SOLANA_DAS_URL)
  if (!rpcUrl) return { phase: 'paused', scanned: 0, mapped: 0, attempts: 0, responseBytes: 0,
    reason: 'Explicit HTTPS Helius SOLANA_DAS_URL is required for one-time raw mint backfill.' }
  const callId = reserveCall(mints)
  let bytes = 0
  let mapped = 0
  let status = 'error'
  let failure = 'Raw mint RPC request failed; the batch is queued for bounded retry.'
  let permanent = false
  let successfulHttp = false
  let retryAfterMs = 0
  try {
    const response = await (options.fetcher ?? fetch)(rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [
        mints, { encoding: 'base64', commitment: 'finalized' },
      ] }), signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      permanent = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
      const retryAfter = Number(response.headers.get('retry-after'))
      if (Number.isFinite(retryAfter) && retryAfter > 0)
        retryAfterMs = Math.min(3_600_000, retryAfter * 1000)
      throw new Error(`Raw mint RPC HTTP ${response.status}.`)
    }
    successfulHttp = true
    const result = await boundedJson(response)
    bytes = result.bytes
    const body = result.body as { result?: { context?: { slot?: unknown }; value?: unknown }; error?: unknown }
    const slot = Number(body?.result?.context?.slot)
    const values = body?.result?.value
    if (body?.error || !Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(values) || values.length !== mints.length)
      throw new Error('Raw mint RPC omitted finalized context or the complete account batch.')
    for (let i = 0; i < mints.length; i++) {
      const mint = mints[i]
      const account = values[i] as { owner?: unknown; data?: unknown; error?: unknown } | null
      if (account?.error) {
        retryMint(mint, bytes, 'Raw mint RPC reported an account-specific error; retrying after backoff.')
        status = 'partial'
        continue
      }
      const data = account?.data
      if (!account || !Array.isArray(data) || data[1] !== 'base64' || typeof data[0] !== 'string') {
        updateAttempt.run('missing', bytes, 'Raw mint RPC returned no complete account data.', null, mint)
        continue
      }
      if (data[0].length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data[0])) {
        updateAttempt.run('missing', bytes, 'Raw mint RPC returned invalid base64 account data.', null, mint)
        continue
      }
      const raw = Buffer.from(data[0], 'base64')
      if (raw.toString('base64') !== data[0] || raw.length < 82 || raw[45] !== 1 ||
        (account.owner === TOKEN_PROGRAM && raw.length !== 82) ||
        !recordKnownTokenProgram(mint, String(account.owner ?? ''), `raw-mint-account:${slot}`)) {
        updateAttempt.run('missing', bytes, 'Raw mint account was uninitialized or its owner was unsupported.', null, mint)
        continue
      }
      if (account.owner === TOKEN_2022_PROGRAM)
        recordToken2022RawEvidence(mint, raw, `raw-mint-account:${slot}`)
      updateAttempt.run('mapped', bytes, null, null, mint)
      mapped++
    }
    if (status !== 'partial') status = 'ok'
  } catch (error) {
    if (error instanceof Error && /^Raw mint RPC HTTP \d+\.$/.test(error.message)) failure = error.message
    if (successfulHttp) failure = 'Successful raw mint response could not be fully verified; one-time read will not repeat.'
    for (const mint of mints) {
      const current = db.prepare('SELECT status FROM research_holder_program_backfill_attempts WHERE mint=?')
        .get(mint) as { status: string } | undefined
      if (current?.status !== 'reserved') continue
      if (permanent || successfulHttp) updateAttempt.run('blocked', bytes, failure, null, mint)
      else retryMint(mint, bytes, failure, retryAfterMs)
    }
  } finally { updateCall.run(bytes, status, callId) }
  return { phase: 'rpc', scanned: 0, mapped, attempts: mints.length, responseBytes: bytes,
    ...(status === 'error' ? { reason: failure } : {}) }
}

export function programBackfillStatus(): ProgramBackfillStatus {
  const counts = db.prepare(`WITH candidate AS (
      SELECT h.mint FROM research_holder_state h
      LEFT JOIN research_holder_extension_evidence x ON x.mint=h.mint
      WHERE h.program_id IS NULL OR (h.program_id=? AND x.mint IS NULL)
    ) SELECT
    (SELECT COUNT(*) FROM research_holder_state WHERE program_id IS NOT NULL) AS known,
    (SELECT COUNT(*) FROM research_holder_state WHERE program_id IS NULL) AS unknown,
    (SELECT COUNT(*) FROM candidate c LEFT JOIN research_holder_program_backfill_attempts a ON a.mint=c.mint
      WHERE a.mint IS NULL) AS queued,
    (SELECT COUNT(*) FROM candidate c JOIN research_holder_program_backfill_attempts a ON a.mint=c.mint
      WHERE a.status='retry') AS retry,
    (SELECT COUNT(*) FROM candidate c JOIN research_holder_program_backfill_attempts a ON a.mint=c.mint
      WHERE a.status IN ('blocked','conflict')) AS blocked,
    (SELECT COUNT(*) FROM candidate c JOIN research_holder_program_backfill_attempts a ON a.mint=c.mint
      WHERE a.status='missing') AS missing,
    (SELECT COUNT(*) FROM research_holder_state h LEFT JOIN research_holder_extension_evidence x ON x.mint=h.mint
      WHERE h.program_id=? AND x.mint IS NULL) AS extension_pending,
    (SELECT COUNT(*) FROM research_holder_extension_evidence WHERE verdict='transparent') AS extension_transparent,
    (SELECT COUNT(*) FROM research_holder_extension_evidence WHERE verdict='confidential') AS extension_confidential,
    (SELECT COUNT(*) FROM research_holder_extension_evidence WHERE verdict='inconclusive') AS extension_inconclusive,
    (SELECT COUNT(*) FROM research_holder_program_backfill_attempts) AS attempts,
    (SELECT COUNT(*) FROM research_holder_program_backfill_calls) AS calls,
    (SELECT COALESCE(SUM(estimated_credits),0) FROM research_holder_program_backfill_calls) AS credits,
    (SELECT COALESCE(SUM(response_bytes),0) FROM research_holder_program_backfill_calls) AS bytes`).get(TOKEN_2022_PROGRAM, TOKEN_2022_PROGRAM) as
    { known: number; unknown: number; queued: number; retry: number; blocked: number; missing: number;
      extension_pending: number; extension_transparent: number; extension_confidential: number;
      extension_inconclusive: number; attempts: number; calls: number; credits: number; bytes: number }
  return { eventScanDone: getCursor(EVENT_DONE) === '1', knownPrograms: counts.known,
    eventScanned: Number(getCursor('holder:program:event:scanned') ?? 0),
    unknownPrograms: counts.unknown, queuedMints: counts.queued, retryMints: counts.retry,
    blockedMints: counts.blocked, missingMints: counts.missing,
    extensionPendingMints: counts.extension_pending,
    extensionTransparentMints: counts.extension_transparent,
    extensionConfidentialMints: counts.extension_confidential,
    extensionInconclusiveMints: counts.extension_inconclusive,
    rpcAttempts: counts.attempts, rpcCalls: counts.calls,
    estimatedRpcCredits: counts.credits, responseBytes: counts.bytes,
    todayRpcCalls: Number(getCursor(dailyKeys().own) ?? 0), dailyRpcLimit: dailyLimit() }
}

export function startProgramBackfill(): () => void {
  if (process.env.HOLDER_PROGRAM_BACKFILL !== '1') return () => {}
  const rawInterval = Number(process.env.HOLDER_PROGRAM_BACKFILL_INTERVAL_MS ?? 2_000)
  const interval = Number.isSafeInteger(rawInterval) ? Math.min(60_000, Math.max(1_000, rawInterval)) : 2_000
  let stopped = false
  let timer: NodeJS.Timeout | null = null
  let working = false
  let pendingWake = false
  let lastRpcAt = 0
  const schedule = (delay: number) => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    const paced = lastRpcAt ? Math.max(0, interval - (Date.now() - lastRpcAt)) : 0
    timer = setTimeout(() => { timer = null; void next() }, Math.max(delay, paced))
  }
  const next = async () => {
    if (stopped || working) return
    working = true
    let delay = interval
    try {
      const result = await stepProgramBackfill()
      if (result.phase === 'rpc') lastRpcAt = Date.now()
      // New FTL tokens can arrive after the historical queue drains. The bus
      // wakes this worker immediately; a slow idle check covers missed events.
      if (result.phase === 'done') delay = 60_000
    } catch { console.error('[holder-program-backfill] step failed; retrying after delay') }
    working = false
    if (pendingWake) { pendingWake = false; delay = 0 }
    schedule(delay)
  }
  const onResearch = (chain: string, _mint: string, enrolled: boolean) => {
    if (chain !== 'solana' || !enrolled) return
    if (working) pendingWake = true
    else schedule(0)
  }
  bus.on('research', onResearch)
  schedule(interval)
  return () => { stopped = true; if (timer) clearTimeout(timer); bus.off('research', onResearch) }
}
