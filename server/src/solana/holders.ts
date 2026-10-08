// One finalized current-state read per FTL-seen mint, then finalized
// mint-filtered transaction balances. Legacy getProgramAccounts returns the
// complete filtered set in one response or an error. A failed read or
// unreplayed stream gap makes the measure unavailable; no polling or retry.

import bs58 from 'bs58'
import { config } from '../config.ts'
import { db } from '../db.ts'
import { bus } from '../hub.ts'
import type { SwapStreamEvent } from './swaps.ts'

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const PROGRAMS = new Set([TOKEN_PROGRAM, TOKEN_2022_PROGRAM])
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024
const MAX_BUFFERED_TX = 5_000
const BOOTSTRAP_INTERVAL_MS = Math.max(1_000, Number(process.env.HOLDER_BOOTSTRAP_INTERVAL_MS ?? 10_000))
if (!Number.isSafeInteger(BOOTSTRAP_INTERVAL_MS)) throw new Error('HOLDER_BOOTSTRAP_INTERVAL_MS must be an integer')

db.exec(`
CREATE TABLE IF NOT EXISTS research_holder_state (
  mint TEXT PRIMARY KEY,
  first_seen_ts INTEGER NOT NULL,
  program_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  reason TEXT,
  stream_ok INTEGER NOT NULL DEFAULT 0,
  attempted_at INTEGER,
  bootstrap_method TEXT,
  baseline_slot INTEGER,
  baseline_ts INTEGER,
  last_slot INTEGER,
  covered_through_slot INTEGER,
  last_ts INTEGER,
  baseline_top20_share REAL
);
CREATE INDEX IF NOT EXISTS research_holder_queue ON research_holder_state(state,stream_ok,first_seen_ts);
CREATE TABLE IF NOT EXISTS research_holder_accounts (
  mint TEXT NOT NULL,
  account TEXT NOT NULL,
  owner TEXT NOT NULL,
  amount TEXT NOT NULL,
  last_slot INTEGER NOT NULL,
  last_index INTEGER NOT NULL,
  PRIMARY KEY(mint,account)
);
CREATE INDEX IF NOT EXISTS research_holder_accounts_owner ON research_holder_accounts(mint,owner);
CREATE TABLE IF NOT EXISTS research_holder_owners (
  mint TEXT NOT NULL,
  owner TEXT NOT NULL,
  amount TEXT NOT NULL,
  PRIMARY KEY(mint,owner)
);
CREATE TABLE IF NOT EXISTS research_holder_baseline_top (
  mint TEXT NOT NULL,
  owner TEXT NOT NULL,
  amount TEXT NOT NULL,
  PRIMARY KEY(mint,owner)
);
CREATE TABLE IF NOT EXISTS research_holder_bootstrap_usage (
  mint TEXT PRIMARY KEY,
  response_bytes INTEGER NOT NULL,
  page_accounts INTEGER NOT NULL,
  db_growth_bytes INTEGER NOT NULL,
  measured_at INTEGER NOT NULL,
  pagination_key_present INTEGER,
  has_next_page INTEGER,
  total_results INTEGER
);
CREATE TABLE IF NOT EXISTS research_holder_program_sources (
  mint TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  source TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS research_holder_extension_evidence (
  mint TEXT PRIMARY KEY,
  verdict TEXT NOT NULL,
  source TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  extension_keys TEXT,
  reason TEXT
);
`)

// Existing volumes predate the safe pagination-shape telemetry. Never persist
// the cursor itself or the returned token-account payload.
const usageColumns = new Set((db.prepare('PRAGMA table_info(research_holder_bootstrap_usage)').all() as { name: string }[])
  .map(column => column.name))
for (const [name, type] of [
  ['pagination_key_present', 'INTEGER'], ['has_next_page', 'INTEGER'], ['total_results', 'INTEGER'],
] as const) if (!usageColumns.has(name)) db.exec(`ALTER TABLE research_holder_bootstrap_usage ADD COLUMN ${name} ${type}`)
const stateColumns = new Set((db.prepare('PRAGMA table_info(research_holder_state)').all() as { name: string }[])
  .map(column => column.name))
if (!stateColumns.has('bootstrap_method'))
  db.exec('ALTER TABLE research_holder_state ADD COLUMN bootstrap_method TEXT')

type State = 'pending' | 'fetching' | 'live' | 'stale' | 'unavailable'
interface StateRow {
  mint: string; first_seen_ts: number; program_id: string | null; state: State;
  reason: string | null; stream_ok: number; attempted_at: number | null;
  bootstrap_method: string | null;
  baseline_slot: number | null; baseline_ts: number | null;
  last_slot: number | null; covered_through_slot: number | null;
  last_ts: number | null; baseline_top20_share: number | null;
}
interface Balance { account: string; owner: string; amount: bigint; program: string | null }
interface Delta { account: string; pre?: Balance; post?: Balance }
interface BufferedTx { slot: number; index: number; deltas: Delta[] }
export interface HolderStatus {
  state: State
  reason: string | null
  source: 'helius-getProgramAccounts+laserstream' | 'helius-getProgramAccountsV2+laserstream'
  programId: string | null
  programSource: string | null
  extensionVerdict: 'transparent' | 'confidential' | 'inconclusive' | null
  extensionSource: string | null
  extensionObservedAt: number | null
  bootstrapAttemptedAt: number | null
  baselineSlot: number | null
  baselineTs: number | null
  lastSlot: number | null
  coveredThroughSlot: number | null
  observedTs: number | null
  accountCount: number
  ownerCount: number
  baselineTop20SharePct: number | null
  top20SharePct: number | null
  baselineRetentionPct: number | null
  observedDays: number | null
  bootstrapResponseBytes: number | null
  bootstrapPageAccounts: number | null
  bootstrapDbGrowthBytes: number | null
}

const stateOf = db.prepare('SELECT * FROM research_holder_state WHERE mint = ?')
const researchToken = db.prepare("SELECT first_seen_ts FROM research_tokens WHERE chain = 'solana' AND address = ?")
const insertState = db.prepare('INSERT OR IGNORE INTO research_holder_state(mint,first_seen_ts) VALUES(?,?)')
const markState = db.prepare('UPDATE research_holder_state SET state = ?, reason = ? WHERE mint = ?')
const openPending = db.prepare("UPDATE research_holder_state SET stream_ok=1 WHERE mint=? AND state='pending'")
const accountOf = db.prepare('SELECT owner,amount,last_slot,last_index FROM research_holder_accounts WHERE mint = ? AND account = ?')
const upsertAccount = db.prepare(`INSERT INTO research_holder_accounts(mint,account,owner,amount,last_slot,last_index)
  VALUES(?,?,?,?,?,?) ON CONFLICT(mint,account) DO UPDATE SET owner=excluded.owner,amount=excluded.amount,
  last_slot=excluded.last_slot,last_index=excluded.last_index`)
const ownerOf = db.prepare('SELECT amount FROM research_holder_owners WHERE mint = ? AND owner = ?')
const upsertOwner = db.prepare(`INSERT INTO research_holder_owners(mint,owner,amount) VALUES(?,?,?)
  ON CONFLICT(mint,owner) DO UPDATE SET amount=excluded.amount`)
const upsertBaselineTop = db.prepare('INSERT INTO research_holder_baseline_top(mint,owner,amount) VALUES(?,?,?)')
const allOwners = db.prepare('SELECT owner,amount FROM research_holder_owners WHERE mint = ?')
const baselineTop = db.prepare('SELECT owner,amount FROM research_holder_baseline_top WHERE mint = ?')
const countAccounts = db.prepare('SELECT COUNT(*) AS n FROM research_holder_accounts WHERE mint = ? AND amount != ?')
const usageOf = db.prepare('SELECT response_bytes,page_accounts,db_growth_bytes FROM research_holder_bootstrap_usage WHERE mint = ?')
const programSourceOf = db.prepare('SELECT source FROM research_holder_program_sources WHERE mint = ?')
const insertProgramSource = db.prepare('INSERT OR IGNORE INTO research_holder_program_sources(mint,program_id,source,recorded_at) VALUES(?,?,?,?)')
const extensionEvidenceOf = db.prepare('SELECT verdict,source,observed_at,reason FROM research_holder_extension_evidence WHERE mint=?')
const insertExtensionEvidence = db.prepare(`INSERT OR IGNORE INTO research_holder_extension_evidence
  (mint,verdict,source,observed_at,extension_keys,reason) VALUES(?,?,?,?,?,?)`)
const upsertUsage = db.prepare(`INSERT INTO research_holder_bootstrap_usage
  (mint,response_bytes,page_accounts,db_growth_bytes,measured_at,pagination_key_present,has_next_page,total_results)
  VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(mint) DO UPDATE SET response_bytes=excluded.response_bytes,
  page_accounts=excluded.page_accounts,db_growth_bytes=excluded.db_growth_bytes,measured_at=excluded.measured_at,
  pagination_key_present=excluded.pagination_key_present,has_next_page=excluded.has_next_page,
  total_results=excluded.total_results`)
const pageCount = db.prepare('PRAGMA page_count')
const pageSize = db.prepare('PRAGMA page_size')
const logicalDbBytes = () => Number((pageCount.get() as { page_count: number }).page_count) *
  Number((pageSize.get() as { page_size: number }).page_size)

function validAddress(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false
  try { return bs58.decode(value).length === 32 } catch { return false }
}
function bootstrapUrl(raw: string | undefined): string | null {
  if (!raw || raw === 'off') return null
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
      ? url.toString() : null
  } catch { return null }
}
function probeScope(): { enabled: boolean; mint: string | null } {
  const raw = process.env.HOLDER_BOOTSTRAP_PROBE_MINT?.trim()
  return raw ? { enabled: true, mint: validAddress(raw) ? raw : null } : { enabled: false, mint: null }
}
function state(mint: string): StateRow | undefined { return stateOf.get(mint) as unknown as StateRow | undefined }
function ensure(mint: string): StateRow | undefined {
  if (!validAddress(mint)) return undefined
  if (enrolled.has(mint)) return state(mint)
  const research = researchToken.get(mint) as { first_seen_ts: number } | undefined
  if (!research) return undefined
  insertState.run(mint, research.first_seen_ts)
  const row = state(mint)
  if (row) {
    enrolled.add(mint)
    if (row.program_id) knownPrograms.set(mint, row.program_id)
  }
  return row
}
function percent(part: bigint, total: bigint): number | null {
  return total > 0n ? Math.round(Number(part) / Number(total) * 10_000) / 100 : null
}
function fail(mint: string, reason: string): void {
  markState.run('unavailable', reason, mint)
  tracking.delete(mint)
  changed?.(mint)
}
let changed: ((mint: string) => void) | undefined
let timer: NodeJS.Timeout | null = null
let started = false
let working = false
const pending = new Map<string, BufferedTx[]>()
const overflow = new Set<string>()
const enrolled = new Set<string>()
const knownPrograms = new Map<string, string>()
const programSources = new Map<string, string>()
const tracking = new Set<string>()

type ExtensionVerdict = 'transparent' | 'confidential' | 'inconclusive'
type ExtensionEvidence = { verdict: ExtensionVerdict; source: string; observed_at: number; reason: string | null }
const extensionEvidence = new Map<string, ExtensionEvidence>()
function extensionOf(mint: string): ExtensionEvidence | undefined {
  const cached = extensionEvidence.get(mint)
  if (cached || started) return cached
  return extensionEvidenceOf.get(mint) as ExtensionEvidence | undefined
}

// Token-2022's mint layout is 82 base bytes; extended mints pad to 165,
// followed by a one-byte Mint type and type/length/value entries. These IDs
// are from the current Solana Token-2022 ExtensionType enum. Unknown types
// fail closed because a future extension could hide balances.
const KNOWN_MINT_EXTENSIONS = new Set([1, 3, 4, 6, 9, 10, 12, 14, 16, 18, 19, 20, 21, 22, 23, 24, 25, 26, 28])
const CONFIDENTIAL_MINT_EXTENSIONS = new Set([4, 16, 24])
function classifyRawMint(data: Uint8Array): { verdict: ExtensionVerdict; keys: number[]; reason: string | null } {
  const bytes = Buffer.from(data)
  const inconclusive = (reason: string, keys: number[] = []) => ({ verdict: 'inconclusive' as const, keys, reason })
  if (bytes.length < 82 || bytes[45] !== 1) return inconclusive('Raw Token-2022 mint account is missing or uninitialized.')
  if (bytes.length === 82) return { verdict: 'transparent', keys: [], reason: null }
  if (bytes.length < 166 || bytes.subarray(82, 165).some(byte => byte !== 0) || bytes[165] !== 1)
    return inconclusive('Raw Token-2022 mint extension layout is invalid.')
  const keys: number[] = []
  const seen = new Set<number>()
  for (let offset = 166; offset < bytes.length;) {
    if (bytes.length - offset < 2) {
      if (bytes[offset] === 0) break
      return inconclusive('Raw Token-2022 mint TLV ends mid-type.', keys)
    }
    const type = bytes.readUInt16LE(offset)
    if (type === 0) {
      if (bytes.subarray(offset).some(byte => byte !== 0))
        return inconclusive('Raw Token-2022 mint TLV has data after its terminator.', keys)
      break
    }
    if (bytes.length - offset < 4) return inconclusive('Raw Token-2022 mint TLV ends mid-length.', keys)
    const length = bytes.readUInt16LE(offset + 2)
    if (offset + 4 + length > bytes.length || seen.has(type) || !KNOWN_MINT_EXTENSIONS.has(type))
      return inconclusive('Raw Token-2022 mint TLV contains an invalid or unknown extension.', keys)
    keys.push(type)
    seen.add(type)
    offset += 4 + length
  }
  if (keys.some(type => CONFIDENTIAL_MINT_EXTENSIONS.has(type)))
    return { verdict: 'confidential', keys, reason: 'Mint enables confidential balances; complete holder amounts are not public.' }
  return { verdict: 'transparent', keys, reason: null }
}

export function recordToken2022RawEvidence(mint: string, data: Uint8Array, source = 'holder-raw-mint-account'): ExtensionVerdict | null {
  const row = ensure(mint)
  if (!row || row.program_id !== TOKEN_2022_PROGRAM) return null
  const previous = extensionOf(mint)
  if (previous) { extensionEvidence.set(mint, previous); return previous.verdict }
  const evaluated = classifyRawMint(data)
  const observedAt = Date.now()
  insertExtensionEvidence.run(mint, evaluated.verdict, source, observedAt,
    JSON.stringify(evaluated.keys), evaluated.reason)
  extensionEvidence.set(mint, { verdict: evaluated.verdict, source, observed_at: observedAt, reason: evaluated.reason })
  if (evaluated.verdict === 'transparent') schedule(0)
  changed?.(mint)
  return evaluated.verdict
}

export function recordKnownTokenProgram(mint: string, programId: string, source = 'verified-source-unspecified'): boolean {
  if (!PROGRAMS.has(programId)) return false
  if (knownPrograms.get(mint) === programId && programSources.has(mint)) return true
  const row = ensure(mint)
  if (!row) return false
  if (row.program_id && row.program_id !== programId) {
    fail(mint, 'Conflicting token-program identities; one-read holder bootstrap is unsafe.')
    return false
  }
  if (row.program_id) knownPrograms.set(mint, row.program_id)
  if (!row.program_id) {
    db.prepare('UPDATE research_holder_state SET program_id = ? WHERE mint = ?').run(programId, mint)
    knownPrograms.set(mint, programId)
    changed?.(mint)
    schedule(0)
  }
  if (!programSources.has(mint)) {
    insertProgramSource.run(mint, programId, source, Date.now())
    programSources.set(mint, (programSourceOf.get(mint) as { source: string } | undefined)?.source ?? source)
  }
  // Token-2022 extensions are opt-in. Keep the identity, but defer its one
  // allowed read until account extensions and subsequent confidential changes
  // can be checked on the live stream. It is not safe to exclude every mint.
  return true
}

export function holderStatus(mint: string): HolderStatus | null {
  const row = ensure(mint)
  if (!row) return null
  const usage = row.attempted_at !== null ? usageOf.get(mint) as
    { response_bytes: number; page_accounts: number; db_growth_bytes: number } | undefined : undefined
  const complete = row.baseline_slot !== null && row.state === 'live' && !!row.stream_ok
  const owners = (complete ? allOwners.all(mint) as { owner: string; amount: string }[] : [])
    .map(o => ({ owner: o.owner, amount: BigInt(o.amount) })).filter(o => o.amount > 0n)
  owners.sort((a, b) => a.amount === b.amount ? a.owner.localeCompare(b.owner) : a.amount > b.amount ? -1 : 1)
  const total = owners.reduce((sum, o) => sum + o.amount, 0n)
  const top20 = owners.slice(0, 20).reduce((sum, o) => sum + o.amount, 0n)
  const currentByOwner = new Map(owners.map(o => [o.owner, o.amount]))
  const cohort = (complete ? baselineTop.all(mint) as { owner: string; amount: string }[] : [])
    .map(o => ({ owner: o.owner, amount: BigInt(o.amount) }))
  const baselineCohort = cohort.reduce((sum, o) => sum + o.amount, 0n)
  const retained = cohort.reduce((sum, o) => {
    const current = currentByOwner.get(o.owner) ?? 0n
    return sum + (current < o.amount ? current : o.amount)
  }, 0n)
  const probe = probeScope()
  const extension = row.program_id === TOKEN_2022_PROGRAM ? extensionOf(mint) : undefined
  const reason = row.reason ?? (row.state === 'pending'
    ? !row.program_id ? 'Waiting for token program from existing metadata or finalized transactions.'
      : row.program_id === TOKEN_2022_PROGRAM && !extension ? 'Waiting for one-time raw Token-2022 mint-extension verification.'
      : row.program_id === TOKEN_2022_PROGRAM && extension?.verdict !== 'transparent'
        ? extension?.reason ?? 'Token-2022 mint-extension verification is inconclusive.'
      : !row.stream_ok ? 'Waiting for verified finalized mint-stream coverage.'
      : process.env.HOLDER_BOOTSTRAP !== '1' ? 'One-read holder bootstrap is not enabled.'
      : !bootstrapUrl(process.env.SOLANA_DAS_URL) ? 'Valid HTTPS Helius holder-bootstrap RPC endpoint is not configured.'
      : probe.enabled && !probe.mint ? 'Holder bootstrap probe mint is invalid; no reads will be sent.'
      : probe.enabled && probe.mint !== mint ? 'One-mint holder bootstrap probe is active; this mint awaits full rollout.'
      : 'Queued for one current-state bootstrap read.'
    : null)
  return {
    state: row.state, reason, source: row.attempted_at !== null && row.bootstrap_method !== 'getProgramAccounts'
      ? 'helius-getProgramAccountsV2+laserstream' : 'helius-getProgramAccounts+laserstream',
    programId: row.program_id, programSource: programSources.get(mint) ?? null,
    extensionVerdict: extension?.verdict ?? null, extensionSource: extension?.source ?? null,
    extensionObservedAt: extension?.observed_at ?? null,
    bootstrapAttemptedAt: row.attempted_at,
    baselineSlot: row.baseline_slot, baselineTs: row.baseline_ts, lastSlot: row.last_slot,
    coveredThroughSlot: row.covered_through_slot,
    observedTs: row.last_ts, accountCount: complete ? (countAccounts.get(mint, '0') as { n: number }).n : 0,
    ownerCount: owners.length,
    baselineTop20SharePct: complete ? row.baseline_top20_share : null,
    top20SharePct: complete ? percent(top20, total) : null,
    baselineRetentionPct: complete ? percent(retained, baselineCohort) : null,
    observedDays: complete && row.baseline_ts ? Math.max(0, (Date.now() - row.baseline_ts) / 86_400_000) : null,
    bootstrapResponseBytes: usage?.response_bytes ?? null,
    bootstrapPageAccounts: usage?.page_accounts ?? null,
    bootstrapDbGrowthBytes: usage?.db_growth_bytes ?? null,
  }
}

// `onStream` is the already-verified per-mint LaserStream coverage event. A
// normal disconnect is bridgeable only after that source explicitly resumes;
// an unreplayed gap permanently invalidates this one-bootstrap baseline.
export function onHolderStreamEvent(event: SwapStreamEvent): void {
  if (event.lane !== 'laserstream') return
  if (event.t === 'pulse') {
    const covered = 'coveredThroughSlot' in event ? Number(event.coveredThroughSlot) : NaN
    if (Number.isSafeInteger(covered) && covered >= 0)
      db.prepare('UPDATE research_holder_state SET covered_through_slot=max(COALESCE(covered_through_slot,0),?) WHERE stream_ok=1 AND baseline_slot IS NOT NULL AND state=?')
        .run(covered, 'live')
    return
  }
  if (event.t === 'gap' && !event.token) {
    // A failed replay often follows a normal close. Include already-stale
    // baselines and clear coverage for pending mints as well.
    onHolderMetadataGap(event.reason ?? 'Finalized holder stream has an unreplayed gap.')
    db.prepare('UPDATE research_holder_state SET stream_ok=0').run()
    return
  }
  if (event.t === 'open' && event.token && openPending.run(event.token).changes) {
    // Initial filter ACK can open 15k+ enrolled mints at once. Their public
    // status has no computed value yet, so avoid per-mint WS invalidations.
    schedule(0)
    return
  }
  const mints = event.token ? [event.token] : (db.prepare('SELECT mint FROM research_holder_state WHERE stream_ok = 1').all() as { mint: string }[]).map(r => r.mint)
  for (const mint of mints) {
    const row = ensure(mint)
    if (!row) continue
    if (event.t === 'close' || event.t === 'gap') {
      db.prepare('UPDATE research_holder_state SET stream_ok = 0 WHERE mint = ?').run(mint)
      if (event.t === 'gap' && (row.baseline_slot !== null || row.state === 'fetching'))
        fail(mint, event.reason ?? 'Finalized holder stream has an unreplayed gap.')
      else if (row.state === 'live') markState.run('stale', 'Finalized holder stream is disconnected; replay has not been verified.', mint)
    } else {
      db.prepare('UPDATE research_holder_state SET stream_ok = 1 WHERE mint = ?').run(mint)
      if (event.t === 'resume' && row.state === 'stale' && row.baseline_slot !== null) {
        const fromSlot = Number(event.fromSlot)
        const checkpoint = row.covered_through_slot
        if (Number.isSafeInteger(fromSlot) && fromSlot >= 0 && checkpoint !== null &&
          fromSlot <= checkpoint) markState.run('live', null, mint)
        else fail(mint, 'Finalized replay began after the last verified holder coverage slot.')
      }
      else if (event.t === 'open' && row.baseline_slot !== null && row.state !== 'unavailable')
        fail(mint, 'A new mint-stream session opened without replaying the persisted holder baseline.')
      schedule(0)
    }
    changed?.(mint)
  }
}

// A filter ACK can open the entire enrolled universe in one callback. Keep
// the existing per-mint coverage decisions, but commit them together so
// pending rows do not block the API thread with thousands of autocommits.
export function onHolderStreamBatch(events: SwapStreamEvent[]): void {
  if (!events.length) return
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const event of events) onHolderStreamEvent(event)
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

export function onHolderMetadataGap(reason = 'Finalized mint stream cannot prove complete token-balance coverage.'): void {
  const affected = (db.prepare("SELECT mint FROM research_holder_state WHERE state!='unavailable' AND (baseline_slot IS NOT NULL OR state='fetching')")
    .all() as { mint: string }[]).map(row => row.mint)
  db.prepare("UPDATE research_holder_state SET stream_ok=0,state='unavailable',reason=? WHERE state!='unavailable' AND (baseline_slot IS NOT NULL OR state='fetching')")
    .run(reason)
  tracking.clear()
  for (const mint of affected) changed?.(mint)
}

function adjustOwner(mint: string, owner: string, delta: bigint): void {
  const old = BigInt((ownerOf.get(mint, owner) as { amount: string } | undefined)?.amount ?? '0')
  const next = old + delta
  if (next < 0n) throw new Error('owner balance became negative')
  upsertOwner.run(mint, owner, next.toString())
}
function applyTx(mint: string, tx: BufferedTx): void {
  const row = state(mint)
  if (!row || row.baseline_slot === null || row.state === 'unavailable' || tx.slot <= row.baseline_slot) return
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const delta of tx.deltas) {
      const old = accountOf.get(mint, delta.account) as { owner: string; amount: string; last_slot: number; last_index: number } | undefined
      if (old && (tx.slot < old.last_slot || (tx.slot === old.last_slot && tx.index <= old.last_index))) continue
      const pre = delta.pre?.amount ?? 0n
      if (old && BigInt(old.amount) > 0n && !delta.pre)
        throw new Error('existing funded token account omitted its pre-balance')
      if (old && delta.pre && BigInt(old.amount) !== pre) throw new Error('token-account pre-balance differs from tracked state')
      if (old && delta.pre && old.owner !== delta.pre.owner) throw new Error('token-account pre-owner differs from tracked state')
      if (!old && pre > 0n) throw new Error('untracked token account had a nonzero pre-balance')
      const owner = delta.post?.owner ?? old?.owner ?? delta.pre?.owner
      if (!owner || !validAddress(owner)) throw new Error('token-account owner is missing')
      const amount = delta.post?.amount ?? 0n
      if (old) adjustOwner(mint, old.owner, -BigInt(old.amount))
      adjustOwner(mint, owner, amount)
      upsertAccount.run(mint, delta.account, owner, amount.toString(), tx.slot, tx.index)
    }
    db.prepare('UPDATE research_holder_state SET last_slot = max(last_slot, ?), last_ts = ? WHERE mint = ?')
      .run(tx.slot, Date.now(), mint)
    db.exec('COMMIT')
    changed?.(mint)
  } catch (error) {
    db.exec('ROLLBACK')
    fail(mint, error instanceof Error ? error.message : 'Finalized holder update could not be reconciled.')
  }
}

type TokenBalanceWire = { accountIndex?: number; mint?: string; owner?: string; programId?: string; uiTokenAmount?: { amount?: string } }
export type HolderTransactionUpdate = {
  slot?: number | { toNumber(): number }
  transaction?: {
    index?: number | { toNumber(): number }
    transaction?: { message?: { accountKeys?: Uint8Array[] } }
    meta?: { err?: unknown; loadedWritableAddresses?: Uint8Array[]; loadedReadonlyAddresses?: Uint8Array[];
      preTokenBalances?: TokenBalanceWire[]; postTokenBalances?: TokenBalanceWire[] }
  }
}

export function onHolderTransaction(update: HolderTransactionUpdate): void {
  const info = update.transaction, meta = info?.meta
  if (!info || !meta || meta.err) return
  const slot = Number(update.slot), index = Number(info.index)
  if (!Number.isSafeInteger(slot) || slot < 0 || !Number.isSafeInteger(index) || index < 0) return
  if (!Array.isArray(meta.preTokenBalances) || !Array.isArray(meta.postTokenBalances)) {
    if (tracking.size) onHolderMetadataGap('Finalized transaction omitted token-balance arrays.')
    return
  }
  const observeProgram = (balance: TokenBalanceWire): boolean => {
    const mint = balance.mint
    if (!mint || !enrolled.has(mint)) return false
    if (balance.programId && !PROGRAMS.has(balance.programId)) {
      fail(mint, 'Finalized token-balance metadata identified an unsupported token program.')
      return false
    }
    if (balance.programId && knownPrograms.get(mint) !== balance.programId)
      recordKnownTokenProgram(mint, balance.programId, 'finalized-token-balance')
    return tracking.has(mint)
  }
  if (!tracking.size) {
    // Before the one allowed current-state read, transaction balances cannot
    // establish a complete holder set. They can still establish program ID.
    for (const balance of meta.preTokenBalances) observeProgram(balance)
    for (const balance of meta.postTokenBalances) observeProgram(balance)
    return
  }
  const keys = [...(info.transaction?.message?.accountKeys ?? []),
    ...(meta.loadedWritableAddresses ?? []), ...(meta.loadedReadonlyAddresses ?? [])]
  const groups = new Map<string, Map<string, Delta>>()
  const add = (balances: TokenBalanceWire[] | undefined, side: 'pre' | 'post') => {
    for (const b of balances ?? []) {
      if (!observeProgram(b)) continue
      const accountKey = keys[b.accountIndex ?? -1]
      if (!accountKey || accountKey.length !== 32 || !validAddress(b.owner)) {
        fail(b.mint!, 'Finalized token-balance metadata omitted an account or owner.')
        continue
      }
      let amount: bigint
      try { amount = BigInt(b.uiTokenAmount?.amount ?? '') } catch {
        fail(b.mint!, 'Finalized token-balance metadata omitted raw amount.')
        continue
      }
      if (amount < 0n) { fail(b.mint!, 'Finalized token-balance amount was negative.'); continue }
      const account = bs58.encode(accountKey)
      let byAccount = groups.get(b.mint!)
      if (!byAccount) { byAccount = new Map(); groups.set(b.mint!, byAccount) }
      let delta = byAccount.get(account)
      if (!delta) { delta = { account }; byAccount.set(account, delta) }
      delta[side] = { account, owner: b.owner!, amount, program: b.programId ?? null }
    }
  }
  add(meta.preTokenBalances, 'pre')
  add(meta.postTokenBalances, 'post')
  for (const [mint, byAccount] of groups) {
    const tx = { slot, index, deltas: [...byAccount.values()] }
    const buffer = pending.get(mint)
    if (buffer) {
      if (buffer.length >= MAX_BUFFERED_TX) overflow.add(mint)
      else buffer.push(tx)
    } else applyTx(mint, tx)
  }
}

function parseBootstrap(result: unknown, mint: string, program: string): { slot: number; accounts: Balance[] } {
  const envelope = result as any
  const slot = Number(envelope?.context?.slot)
  const entries = envelope?.value
  if (!Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(entries))
    throw new Error('One-read bootstrap omitted finalized context or accounts.')
  const accounts: Balance[] = []
  const seen = new Set<string>()
  for (const item of entries) {
    if (!validAddress(item?.pubkey) || seen.has(item.pubkey) || item?.account?.owner !== program)
      throw new Error('One-read bootstrap returned duplicate or invalid token account.')
    seen.add(item.pubkey)
    const payload = item.account.data
    if (!Array.isArray(payload) || payload[1] !== 'base64' || typeof payload[0] !== 'string')
      throw new Error('One-read bootstrap token-account encoding is unsupported.')
    const data = Buffer.from(payload[0], 'base64')
    if (data.length < 109 || bs58.encode(data.subarray(0, 32)) !== mint || ![1, 2].includes(data[108]))
      throw new Error('One-read bootstrap token-account data is invalid.')
    accounts.push({ account: item.pubkey, owner: bs58.encode(data.subarray(32, 64)),
      amount: data.readBigUInt64LE(64), program })
  }
  return { slot, accounts }
}

async function boundedJson(response: Response): Promise<{ body: any; bytes: number }> {
  if (Number(response.headers.get('content-length') ?? 0) > MAX_RESPONSE_BYTES)
    throw new Error('One-read bootstrap response exceeded 20 MiB.')
  if (!response.body) throw new Error('One-read bootstrap response has no body.')
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > MAX_RESPONSE_BYTES) throw new Error('One-read bootstrap response exceeded 20 MiB.')
    chunks.push(chunk)
  }
  return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')), bytes: size }
}

export async function attemptHolderBootstrap(mint: string, options: { rpcUrl?: string; fetcher?: typeof fetch } = {}): Promise<HolderStatus | null> {
  const row = ensure(mint)
  if (!row || !row.program_id || row.state !== 'pending' || !row.stream_ok || row.attempted_at !== null) return holderStatus(mint)
  if (row.program_id === TOKEN_2022_PROGRAM && extensionOf(mint)?.verdict !== 'transparent')
    return holderStatus(mint)
  const probe = probeScope()
  if (probe.enabled && probe.mint !== mint) return holderStatus(mint)
  const rpcUrl = bootstrapUrl(options.rpcUrl ?? process.env.SOLANA_DAS_URL)
  if (!rpcUrl) return holderStatus(mint) // no read until an explicit Helius endpoint is configured
  const reserved = db.prepare("UPDATE research_holder_state SET state='fetching',reason=NULL,attempted_at=?,bootstrap_method='getProgramAccounts' WHERE mint=? AND state='pending' AND attempted_at IS NULL")
    .run(Date.now(), mint).changes
  if (!reserved) return holderStatus(mint)
  tracking.add(mint)
  pending.set(mint, [])
  changed?.(mint)
  let responseBytes: number | null = null
  let pageAccounts = 0
  let dbGrowthBytes = 0
  try {
    const response = await (options.fetcher ?? fetch)(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [row.program_id,
        { encoding: 'base64', commitment: 'finalized', withContext: true,
          dataSlice: { offset: 0, length: 109 }, filters: [{ memcmp: { offset: 0, bytes: mint } }] }] }),
      signal: AbortSignal.timeout(12_000) })
    if (!response.ok) throw new Error(`One-read bootstrap HTTP ${response.status}.`)
    const bounded = await boundedJson(response)
    const body = bounded.body
    responseBytes = bounded.bytes
    pageAccounts = Array.isArray(body?.result?.value) ? body.result.value.length : 0
    if (body?.error) throw new Error('One-read bootstrap provider rejected the request.')
    const parsed = parseBootstrap(body?.result, mint, row.program_id)
    if (overflow.has(mint)) throw new Error('Live transaction buffer overflowed during one-read bootstrap.')
    if (state(mint)?.state === 'unavailable') throw new Error('Finalized stream lost coverage during one-read bootstrap.')
    const owners = new Map<string, bigint>()
    for (const account of parsed.accounts) owners.set(account.owner, (owners.get(account.owner) ?? 0n) + account.amount)
    const ranked = [...owners].filter(([, amount]) => amount > 0n).sort((a, b) => a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] > b[1] ? -1 : 1)
    const total = ranked.reduce((sum, [, amount]) => sum + amount, 0n)
    const top = ranked.slice(0, 20).reduce((sum, [, amount]) => sum + amount, 0n)
    const baselineTs = Date.now()
    const dbBefore = logicalDbBytes()
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const account of parsed.accounts)
        upsertAccount.run(mint, account.account, account.owner, account.amount.toString(), parsed.slot, 2_147_483_647)
      for (const [owner, amount] of owners) upsertOwner.run(mint, owner, amount.toString())
      for (const [owner, amount] of ranked.slice(0, 20)) upsertBaselineTop.run(mint, owner, amount.toString())
      const current = state(mint)!
      db.prepare('UPDATE research_holder_state SET baseline_slot=?,baseline_ts=?,last_slot=?,last_ts=?,baseline_top20_share=?,state=?,reason=? WHERE mint=?')
        .run(parsed.slot, baselineTs, parsed.slot, baselineTs, percent(top, total),
          current.stream_ok ? 'live' : 'stale', current.stream_ok ? null : 'Finalized stream disconnected during bootstrap.', mint)
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    for (const transaction of (pending.get(mint) ?? []).sort((a, b) => a.slot - b.slot || a.index - b.index))
      applyTx(mint, transaction)
    dbGrowthBytes = Math.max(0, logicalDbBytes() - dbBefore)
    changed?.(mint)
  } catch (error) {
    // Attempt was reserved before the request: a timeout or crash must never
    // silently cause a second current-state read for this mint.
    fail(mint, error instanceof Error ? error.message : 'One-read bootstrap failed.')
  } finally {
    if (responseBytes !== null) upsertUsage.run(mint, responseBytes, pageAccounts, dbGrowthBytes, Date.now(),
      0, 0, pageAccounts)
    pending.delete(mint)
    overflow.delete(mint)
  }
  return holderStatus(mint)
}

function schedule(delay = BOOTSTRAP_INTERVAL_MS): void {
  if (!started || timer) return
  timer = setTimeout(() => { timer = null; void work() }, delay)
}
async function work(): Promise<void> {
  if (!started || working) return
  working = true
  try {
    if (process.env.HOLDER_BOOTSTRAP === '1' && bootstrapUrl(process.env.SOLANA_DAS_URL)) {
      const probe = probeScope()
      const next = probe.enabled && !probe.mint ? undefined : db.prepare(`SELECT h.mint FROM research_holder_state h
        LEFT JOIN research_holder_extension_evidence x ON x.mint=h.mint
        WHERE h.state='pending' AND h.stream_ok=1 AND
          (h.program_id=? OR (h.program_id=? AND x.verdict='transparent')) AND
          (? IS NULL OR h.mint=?) ORDER BY h.first_seen_ts,h.mint LIMIT 1`)
        .get(TOKEN_PROGRAM, TOKEN_2022_PROGRAM, probe.mint, probe.mint) as { mint: string } | undefined
      if (next) await attemptHolderBootstrap(next.mint)
    }
  } finally { working = false; schedule() }
}

export function startHolders(onChange?: (mint: string) => void): () => void {
  if (started) throw new Error('holder tracker already started')
  started = true
  changed = onChange
  db.prepare("INSERT OR IGNORE INTO research_holder_state(mint,first_seen_ts) SELECT address,first_seen_ts FROM research_tokens WHERE chain='solana'").run()
  db.prepare("UPDATE research_holder_state SET state='unavailable',reason='One-read bootstrap was interrupted; no retry is permitted.' WHERE state='fetching'").run()
  db.prepare("UPDATE research_holder_state SET state='pending',reason=NULL WHERE program_id=? AND state='unavailable' AND attempted_at IS NULL AND reason='Token-2022 confidential balances cannot be verified from one current-state read and transaction balance metadata.'")
    .run(TOKEN_2022_PROGRAM)
  db.prepare("UPDATE research_holder_state SET stream_ok=0,state='stale',reason='Restart requires verified finalized replay.' WHERE state='live'").run()
  db.prepare('UPDATE research_holder_state SET stream_ok=0').run()
  enrolled.clear()
  knownPrograms.clear()
  programSources.clear()
  extensionEvidence.clear()
  tracking.clear()
  for (const row of db.prepare('SELECT mint,program_id,state,baseline_slot FROM research_holder_state').all() as
    { mint: string; program_id: string | null; state: State; baseline_slot: number | null }[]) {
    enrolled.add(row.mint)
    if (row.program_id) knownPrograms.set(row.mint, row.program_id)
    if (row.baseline_slot !== null && row.state === 'stale') tracking.add(row.mint)
  }
  for (const row of db.prepare('SELECT mint,source FROM research_holder_program_sources').all() as { mint: string; source: string }[])
    programSources.set(row.mint, row.source)
  for (const row of db.prepare('SELECT mint,verdict,source,observed_at,reason FROM research_holder_extension_evidence').all() as
    (ExtensionEvidence & { mint: string })[]) extensionEvidence.set(row.mint, row)
  const onResearch = (chain: string, mint: string, enrolled: boolean) => {
    if (chain !== 'solana' || !enrolled) return
    if (ensure(mint)) { changed?.(mint); schedule(0) }
  }
  bus.on('research', onResearch)
  schedule(0)
  return () => {
    started = false
    changed = undefined
    if (timer) clearTimeout(timer)
    timer = null
    bus.off('research', onResearch)
  }
}
