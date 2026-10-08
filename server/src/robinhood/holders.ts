// Robinhood Chain holder ledger: replay every ERC-20 Transfer from contract
// deployment to a finalized anchor, prove all resulting balances with one
// balanceOf/totalSupply pass at that anchor, then advance only from contiguous
// finalized Transfer logs. No explorer, periodic snapshot, or proxy score.
import { db, getCursor, setCursor } from '../db.ts'
import { bus } from '../hub.ts'
import { config } from '../config.ts'
import { StrictRhRpc, TRANSFER_TOPIC, ZERO, blockNumber, decodeTransfer, hexBlock, type ChainLog, type Transfer } from './research-source.ts'

type State = 'pending' | 'fetching' | 'live' | 'stale' | 'unavailable'
interface StateRow {
  token: string; first_seen_ts: number; state: State; reason: string | null;
  attempted_at: number | null; deployment_block: number | null; baseline_block: number | null;
  baseline_ts: number | null; covered_through_block: number | null; covered_through_ts: number | null;
  baseline_top20_share: number | null; transfers: number; validated_owners: number;
  cohort_examined: number; global_synced: number;
}
export interface RobinhoodHolderStatus {
  state: State
  reason: string | null
  source: 'deployment-transfer-replay+finalized-log-stream'
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

db.exec(`
CREATE TABLE IF NOT EXISTS research_rh_holder_state (
  token TEXT PRIMARY KEY, first_seen_ts INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', reason TEXT, attempted_at INTEGER,
  deployment_block INTEGER, baseline_block INTEGER, baseline_ts INTEGER,
  covered_through_block INTEGER, covered_through_ts INTEGER,
  baseline_top20_share REAL, transfers INTEGER NOT NULL DEFAULT 0,
  validated_owners INTEGER NOT NULL DEFAULT 0,
  cohort_examined INTEGER NOT NULL DEFAULT 0,
  global_synced INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS research_rh_holder_queue ON research_rh_holder_state(state,first_seen_ts);
CREATE TABLE IF NOT EXISTS research_rh_holder_balances (
  token TEXT NOT NULL, owner TEXT NOT NULL, amount TEXT NOT NULL,
  PRIMARY KEY(token,owner)
);
CREATE TABLE IF NOT EXISTS research_rh_holder_baseline_top (
  token TEXT NOT NULL, owner TEXT NOT NULL, amount TEXT NOT NULL,
  PRIMARY KEY(token,owner)
);
CREATE TABLE IF NOT EXISTS research_rh_holder_cohort_balances (
  token TEXT NOT NULL, owner TEXT NOT NULL, amount TEXT NOT NULL,
  PRIMARY KEY(token,owner)
);
CREATE TABLE IF NOT EXISTS research_rh_holder_cohort_deltas (
  token TEXT NOT NULL, block INTEGER NOT NULL, log_index INTEGER NOT NULL,
  sender TEXT NOT NULL, recipient TEXT NOT NULL, amount TEXT NOT NULL,
  PRIMARY KEY(token,block,log_index)
);
CREATE INDEX IF NOT EXISTS research_rh_holder_cohort_pending
  ON research_rh_holder_cohort_deltas(token,block);
CREATE INDEX IF NOT EXISTS research_rh_holder_cohort_due
  ON research_rh_holder_cohort_deltas(block,token);
`)
try { db.exec('ALTER TABLE research_rh_holder_state ADD COLUMN cohort_examined INTEGER NOT NULL DEFAULT 0') } catch {}
try { db.exec('ALTER TABLE research_rh_holder_state ADD COLUMN global_synced INTEGER NOT NULL DEFAULT 0') } catch {}

const validToken = (s: unknown): s is string => typeof s === 'string' && /^0x[a-f0-9]{40}$/.test(s)
const DAY = 86_400_000
const COHORT_BLOCK = 'rh:holder:cohort-block'
const COHORT_TS = 'rh:holder:cohort-ts'
const COHORT_HASH = 'rh:holder:cohort-hash'
const COHORT_REFRESH_MS = 15_000
const GLOBAL_BLOCK = 'rh:holder:global-finalized-block'
const GLOBAL_TS = 'rh:holder:global-finalized-ts'
const GLOBAL_HASH = 'rh:holder:global-finalized-hash'
interface CohortBoundary { block: number; ts: number; hash: string }
let cohortBoundary: CohortBoundary | null = null
let cohortPending: Promise<CohortBoundary> | null = null
const stateOf = db.prepare('SELECT * FROM research_rh_holder_state WHERE token=?')
const insertState = db.prepare(`INSERT OR IGNORE INTO research_rh_holder_state(token,first_seen_ts)
  SELECT address,first_seen_ts FROM research_tokens WHERE chain='robinhood' AND address=?`)
const balanceOf = db.prepare('SELECT amount FROM research_rh_holder_balances WHERE token=? AND owner=?')
const upsertBalance = db.prepare(`INSERT INTO research_rh_holder_balances(token,owner,amount) VALUES(?,?,?)
  ON CONFLICT(token,owner) DO UPDATE SET amount=excluded.amount`)
const deleteBalance = db.prepare('DELETE FROM research_rh_holder_balances WHERE token=? AND owner=?')
const balancesOf = db.prepare('SELECT owner,amount FROM research_rh_holder_balances WHERE token=?')
const baselineOf = db.prepare('SELECT owner,amount FROM research_rh_holder_baseline_top WHERE token=?')
const cohortBalanceOf = db.prepare('SELECT amount FROM research_rh_holder_cohort_balances WHERE token=? AND owner=?')
const upsertCohortBalance = db.prepare(`INSERT INTO research_rh_holder_cohort_balances(token,owner,amount) VALUES(?,?,?)
  ON CONFLICT(token,owner) DO UPDATE SET amount=excluded.amount`)
const deleteCohortBalance = db.prepare('DELETE FROM research_rh_holder_cohort_balances WHERE token=? AND owner=?')
const allCohortBalances = db.prepare('SELECT owner,amount FROM research_rh_holder_cohort_balances WHERE token=?')
const addCohortDelta = db.prepare(`INSERT INTO research_rh_holder_cohort_deltas
  (token,block,log_index,sender,recipient,amount) VALUES(?,?,?,?,?,?)`)
const launchTxOf = db.prepare("SELECT launch_tx FROM tokens WHERE chain='robinhood' AND address=?")
const announce = (token: string) => bus.emit('research', 'robinhood', token, false)
let started = false
let rpc: StrictRhRpc | null = null
let bootstrapRunning = false
let liveRunning = false
let sourceStartedAt = 0
const seenTokens = new Set<string>()

function ensure(token: string): StateRow | null {
  if (!validToken(token)) return null
  insertState.run(token)
  return (stateOf.get(token) as unknown as StateRow | undefined) ?? null
}
function mark(token: string, state: State, reason: string | null): void {
  db.prepare('UPDATE research_rh_holder_state SET state=?,reason=? WHERE token=?').run(state, reason, token)
  announce(token)
}
function positiveBalances(token: string): { owner: string; amount: bigint }[] {
  const rows = (balancesOf.all(token) as { owner: string; amount: string }[])
    .map(r => ({ owner: r.owner, amount: BigInt(r.amount) })).filter(r => r.amount > 0n)
  rows.sort((a, b) => a.amount === b.amount ? a.owner.localeCompare(b.owner) : a.amount > b.amount ? -1 : 1)
  return rows
}
function captureEventCohort(token: string, boundary: Pick<CohortBoundary, 'block' | 'ts'>): void {
  const row = ensure(token)
  if (!row || row.baseline_block !== null || row.deployment_block === null ||
    row.deployment_block > boundary.block) return
  const owners = positiveBalances(token)
  const total = owners.reduce((sum, owner) => sum + owner.amount, 0n)
  db.prepare('DELETE FROM research_rh_holder_cohort_balances WHERE token=?').run(token)
  for (const owner of owners) upsertCohortBalance.run(token, owner.owner, owner.amount.toString())
  if (!total) {
    // A token existed but had no positive supply at the boundary. This is a
    // verified absence, distinct from a replay that skipped the boundary.
    db.prepare('UPDATE research_rh_holder_state SET cohort_examined=1 WHERE token=?').run(token)
    return
  }
  const top20 = owners.slice(0, 20)
  const part = top20.reduce((sum, owner) => sum + owner.amount, 0n)
  db.prepare('DELETE FROM research_rh_holder_baseline_top WHERE token=?').run(token)
  const add = db.prepare('INSERT INTO research_rh_holder_baseline_top(token,owner,amount) VALUES(?,?,?)')
  for (const owner of top20) add.run(token, owner.owner, owner.amount.toString())
  db.prepare(`UPDATE research_rh_holder_state SET baseline_block=?,baseline_ts=?,baseline_top20_share=?,
    cohort_examined=1 WHERE token=?`).run(boundary.block, boundary.ts, pct(part, total), token)
}

function recordCohortDelta(move: Transfer): void {
  if (move.from === move.to || move.amount === 0n) return
  addCohortDelta.run(move.token, move.block, move.index, move.from, move.to, move.amount.toString())
}

function applyCohortDelta(token: string, move: { sender: string; recipient: string; amount: string }): void {
  const amount = BigInt(move.amount)
  if (move.sender !== ZERO) {
    const old = BigInt((cohortBalanceOf.get(token, move.sender) as { amount: string } | undefined)?.amount ?? '0')
    if (old < amount) throw new Error('Rolling holder cohort has a negative sender balance')
    const next = old - amount
    if (next) upsertCohortBalance.run(token, move.sender, next.toString())
    else deleteCohortBalance.run(token, move.sender)
  }
  if (move.recipient !== ZERO) {
    const old = BigInt((cohortBalanceOf.get(token, move.recipient) as { amount: string } | undefined)?.amount ?? '0')
    upsertCohortBalance.run(token, move.recipient, (old + amount).toString())
  }
}

// Advance the baseline by replaying only the Transfer delta between the old
// and new seven-day block boundaries. This never reads current balances again.
// Caller owns the SQLite transaction so the cohort and its delta cursor move
// atomically with the live holder ledger.
function rollCohort(token: string, boundary: CohortBoundary): void {
  const row = ensure(token)
  const globalBlock = Number(getCursor(GLOBAL_BLOCK))
  const covered = row?.global_synced && Number.isSafeInteger(globalBlock)
    ? Math.max(row.covered_through_block ?? -1, globalBlock) : row?.covered_through_block
  if (!row || row.baseline_block === null || row.baseline_block >= boundary.block ||
    covered === null || covered === undefined || covered < boundary.block) return
  const deltas = db.prepare(`SELECT sender,recipient,amount FROM research_rh_holder_cohort_deltas
    WHERE token=? AND block>? AND block<=? ORDER BY block,log_index`)
    .all(token, row.baseline_block, boundary.block) as
    { sender: string; recipient: string; amount: string }[]
  // If no holder moved, the persisted owner balances already equal the
  // cohort at the new boundary. The public status may use the newer canonical
  // block without rewriting every inactive token every fifteen seconds.
  if (!deltas.length) return
  for (const move of deltas) applyCohortDelta(token, move)
  db.prepare('DELETE FROM research_rh_holder_cohort_deltas WHERE token=? AND block<=?').run(token, boundary.block)
  const owners = (allCohortBalances.all(token) as { owner: string; amount: string }[])
    .map(r => ({ owner: r.owner, amount: BigInt(r.amount) })).filter(r => r.amount > 0n)
    .sort((a, b) => a.amount === b.amount ? a.owner.localeCompare(b.owner) : a.amount > b.amount ? -1 : 1)
  const total = owners.reduce((sum, owner) => sum + owner.amount, 0n)
  const top = owners.slice(0, 20)
  const topAmount = top.reduce((sum, owner) => sum + owner.amount, 0n)
  db.prepare('DELETE FROM research_rh_holder_baseline_top WHERE token=?').run(token)
  const add = db.prepare('INSERT INTO research_rh_holder_baseline_top(token,owner,amount) VALUES(?,?,?)')
  for (const owner of top) add.run(token, owner.owner, owner.amount.toString())
  db.prepare(`UPDATE research_rh_holder_state SET baseline_block=?,baseline_ts=?,baseline_top20_share=?,
    cohort_examined=1 WHERE token=?`).run(boundary.block, boundary.ts, pct(topAmount, total), token)
}
function pct(part: bigint, total: bigint): number | null {
  return total > 0n ? Math.round(Number(part) / Number(total) * 10_000) / 100 : null
}
export function robinhoodHolderStatus(token: string): RobinhoodHolderStatus | null {
  const row = ensure(token)
  if (!row) return null
  const globalBlockRaw = getCursor(GLOBAL_BLOCK)
  const globalTsRaw = getCursor(GLOBAL_TS)
  const globalBlock = globalBlockRaw === null ? null : Number(globalBlockRaw)
  const globalTs = globalTsRaw === null ? null : Number(globalTsRaw)
  const coveredBlock = row.global_synced && globalBlock !== null && row.covered_through_block !== null
    ? Math.max(row.covered_through_block, globalBlock) : row.covered_through_block
  const coveredTs = row.global_synced && globalBlock !== null && globalTs !== null &&
    row.covered_through_block !== null && globalBlock >= row.covered_through_block
    ? globalTs : row.covered_through_ts
  const boundary = cohortBoundary && row.baseline_block !== null &&
    row.baseline_block < cohortBoundary.block ? cohortBoundary : null
  const cohortCovered = !boundary || coveredBlock !== null && coveredBlock >= boundary.block
  const pendingCohort = boundary && cohortCovered && db.prepare(`SELECT 1 FROM research_rh_holder_cohort_deltas
    WHERE token=? AND block>? AND block<=? LIMIT 1`).get(token, row.baseline_block, boundary.block)
  const cohortFresh = row.state !== 'live' || cohortCovered && !pendingCohort
  const state = row.state === 'live' && (!cohortFresh || !row.global_synced) ? 'stale' : row.state
  const effectiveBaseline = boundary && cohortFresh ? boundary : null
  const live = state === 'live' && row.baseline_block !== null && coveredBlock !== null
  const owners = live ? positiveBalances(token) : []
  const total = owners.reduce((sum, o) => sum + o.amount, 0n)
  const top20 = owners.slice(0, 20).reduce((sum, o) => sum + o.amount, 0n)
  const current = new Map(owners.map(o => [o.owner, o.amount]))
  const baseline = live ? (baselineOf.all(token) as { owner: string; amount: string }[])
    .map(o => ({ owner: o.owner, amount: BigInt(o.amount) })) : []
  const cohort = baseline.reduce((sum, o) => sum + o.amount, 0n)
  const retained = baseline.reduce((sum, o) => {
    const now = current.get(o.owner) ?? 0n
    return sum + (now < o.amount ? now : o.amount)
  }, 0n)
  const reason = !cohortFresh ? 'Finalized seven-day owner cohort is catching up.' :
    !row.global_synced && row.state === 'live' ? 'Finalized global Transfer stream is catching up.' :
    row.reason ?? (row.state === 'pending'
    ? !config.rhHttp ? 'Robinhood JSON-RPC is not configured.'
      : 'Queued for full deployment-to-finalized Transfer replay and anchor balance validation.'
    : row.state === 'fetching' ? 'Replaying finalized Transfer logs from token deployment.'
      : row.state === 'stale' ? 'Finalized Transfer replay is catching up after an interruption.' : null)
  return { state, reason, source: 'deployment-transfer-replay+finalized-log-stream',
    bootstrapAttemptedAt: row.attempted_at, baselineSlot: effectiveBaseline?.block ?? row.baseline_block,
    baselineTs: effectiveBaseline?.ts ?? row.baseline_ts, lastSlot: coveredBlock,
    coveredThroughSlot: coveredBlock, observedTs: live ? coveredTs : null,
    accountCount: live ? owners.length : 0, ownerCount: live ? owners.length : 0,
    baselineTop20SharePct: live ? row.baseline_top20_share : null,
    top20SharePct: live ? pct(top20, total) : null,
    baselineRetentionPct: live ? pct(retained, cohort) : null,
    observedDays: live && (effectiveBaseline?.ts ?? row.baseline_ts) && coveredTs
      ? Math.max(0, (coveredTs - (effectiveBaseline?.ts ?? row.baseline_ts!)) / DAY) : null,
    bootstrapResponseBytes: null, bootstrapPageAccounts: row.validated_owners || null,
    bootstrapDbGrowthBytes: null }
}

function applyOne(transfer: Transfer): void {
  const { token, from, to, amount } = transfer
  if (amount < 0n) throw new Error('Negative Transfer amount')
  if (from === to || amount === 0n) return
  if (from !== ZERO) {
    const old = BigInt((balanceOf.get(token, from) as { amount: string } | undefined)?.amount ?? '0')
    if (old < amount) throw new Error(`Transfer exceeds replayed sender balance at ${transfer.block}`)
    const next = old - amount
    if (next) upsertBalance.run(token, from, next.toString())
    else deleteBalance.run(token, from)
  }
  if (to !== ZERO) {
    const old = BigInt((balanceOf.get(token, to) as { amount: string } | undefined)?.amount ?? '0')
    upsertBalance.run(token, to, (old + amount).toString())
  }
}

async function applyRange(token: string, logs: ChainLog[], from: number, to: number,
  head: { number: number; ts: number }, verified?: Map<number, number>, knownToTs?: number,
  cohort?: CohortBoundary): Promise<void> {
  if (!rpc) throw new Error('Robinhood RPC unavailable')
  const times = verified ?? await rpc.verifiedBlocks(logs, to)
  const transfers = logs.map(log => decodeTransfer(log))
  if (transfers.some(x => !x || x.token !== token)) throw new Error('Unexpected token in Transfer replay')
  transfers.sort((a, b) => a!.block - b!.block || a!.index - b!.index)
  const toTs = knownToTs ?? times.get(to) ?? (to === head.number ? head.ts :
    blockNumber((await rpc.call('eth_getBlockByNumber', [hexBlock(to), false]) as { timestamp: string }).timestamp) * 1000)
  const initial = ensure(token)
  const captureTarget = cohort && initial?.deployment_block !== null && initial?.deployment_block !== undefined
    ? Math.max(cohort.block, initial.deployment_block) : null
  const captureTargetTs = captureTarget !== null && from <= captureTarget && captureTarget <= to
    ? captureTarget === cohort!.block ? cohort!.ts : times.get(captureTarget) ??
      blockNumber((await rpc.call('eth_getBlockByNumber', [hexBlock(captureTarget), false]) as { timestamp: string }).timestamp) * 1000
    : null
  db.exec('BEGIN IMMEDIATE')
  try {
    const state = ensure(token)
    if (!state || state.covered_through_block !== from - 1) throw new Error('Noncontiguous holder replay')
    let journalAfter = state.baseline_block
    const captureAt = (block: number, ts: number): void => {
      if (journalAfter !== null) return
      captureEventCohort(token, { block, ts })
      journalAfter = (stateOf.get(token) as unknown as StateRow).baseline_block
    }
    let previousBlock = from
    for (let i = 0; i < transfers.length;) {
      const block = transfers[i]!.block
      if (captureTarget !== null && journalAfter === null &&
        previousBlock <= captureTarget && captureTarget < block)
        captureAt(captureTarget, captureTargetTs!)
      while (i < transfers.length && transfers[i]!.block === block) {
        const transfer = transfers[i++]!
        applyOne(transfer)
        if (journalAfter !== null && transfer.block > journalAfter) recordCohortDelta(transfer)
      }
      if (captureTarget !== null && journalAfter === null && block >= captureTarget) {
        const blockTs = times.get(block)
        if (blockTs === undefined) throw new Error('Missing verified first-positive-supply block time')
        captureAt(block, blockTs)
      }
      previousBlock = block + 1
    }
    if (captureTarget !== null && journalAfter === null &&
      previousBlock <= captureTarget && captureTarget <= to)
      captureAt(captureTarget, captureTargetTs!)
    db.prepare(`UPDATE research_rh_holder_state SET covered_through_block=?,covered_through_ts=?,
      transfers=transfers+? WHERE token=?`).run(to, toTs, transfers.length, token)
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  if (transfers.length) announce(token)
}

async function findDeployment(token: string, head: number): Promise<number> {
  if (!rpc) throw new Error('Robinhood RPC unavailable')
  const current = await rpc.call('eth_getCode', [token, hexBlock(head)]) as string
  if (!/^0x[a-f\d]+$/i.test(current) || current === '0x') throw new Error('No ERC-20 contract bytecode at finalized head')
  // A launch event often shares the token creation transaction. A finalized
  // receipt plus absent code in the preceding block proves the deployment
  // boundary in a receipt and two historical code reads, avoiding a
  // full-height binary search after the current-code check.
  const launchTx = (launchTxOf.get(token) as { launch_tx: string | null } | undefined)?.launch_tx
  if (launchTx && /^0x[a-f\d]{64}$/i.test(launchTx)) {
    let receipt: { blockNumber: string } | null = null
    try { receipt = await rpc.call('eth_getTransactionReceipt', [launchTx]) as { blockNumber: string } }
    catch (error) {
      // A missing old receipt does not weaken the binary-search proof. Real
      // RPC failures still stop this attempt and retry without moving a cursor.
      if (!/returned no complete result/.test(String(error))) throw error
    }
    if (receipt) {
      const at = blockNumber(receipt.blockNumber)
      if (at <= head && at > 0) {
        const [atCode, beforeCode] = await rpc.batch([
          { method: 'eth_getCode', params: [token, hexBlock(at)] },
          { method: 'eth_getCode', params: [token, hexBlock(at - 1)] },
        ]) as string[]
        if (typeof atCode === 'string' && atCode !== '0x' && beforeCode === '0x') return at
      }
    }
  }
  let low = 0, high = head
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    const code = await rpc.call('eth_getCode', [token, hexBlock(mid)]) as string
    if (typeof code !== 'string' || !/^0x[a-f\d]*$/i.test(code)) throw new Error('Invalid historical eth_getCode result')
    if (code === '0x') low = mid + 1
    else high = mid
  }
  return low
}

async function deriveCohortBoundary(head: { number: number; ts: number }): Promise<CohortBoundary> {
  if (!rpc) throw new Error('Robinhood RPC unavailable')
  const target = head.ts - 7 * DAY
  if (cohortBoundary && target >= cohortBoundary.ts && target - cohortBoundary.ts < COHORT_REFRESH_MS)
    return cohortBoundary
  if (cohortBoundary?.block === 0 && target < cohortBoundary.ts)
    return cohortBoundary
  if (cohortBoundary && target < cohortBoundary.ts)
    throw new Error('Finalized time regressed behind the holder cohort')
  const persistedBlock = getCursor(COHORT_BLOCK)
  const persistedTs = getCursor(COHORT_TS)
  const persistedHash = getCursor(COHORT_HASH)
  if ((persistedBlock !== null || persistedTs !== null || persistedHash !== null) &&
    (persistedBlock === null || persistedTs === null || persistedHash === null))
    throw new Error('Incomplete persisted Robinhood holder cohort boundary')
  let lowerBound = 0
  if (persistedBlock !== null) {
    lowerBound = Number(persistedBlock)
    if (!Number.isSafeInteger(lowerBound) || lowerBound < 0 || lowerBound > head.number)
      throw new Error('Invalid persisted cohort block')
  }
  if (persistedBlock !== null) {
    const prior = await rpc.call('eth_getBlockByNumber', [hexBlock(lowerBound), false]) as
      { number: string; hash: string; timestamp: string }
    if (blockNumber(prior.number) !== lowerBound || !/^0x[a-f\d]{64}$/i.test(prior.hash) ||
      blockNumber(prior.timestamp) * 1000 !== Number(persistedTs) ||
      prior.hash.toLowerCase() !== persistedHash!.toLowerCase())
      throw new Error('Persisted cohort boundary no longer matches canonical finalized history')
    if (Number(persistedTs) > target && lowerBound === 0) {
      cohortBoundary = { block: 0, ts: Number(persistedTs), hash: persistedHash!.toLowerCase() }
      return cohortBoundary
    }
    if (Number(persistedTs) > target)
      throw new Error('Finalized time regressed behind the persisted holder cohort')
    if (target - Number(persistedTs) < COHORT_REFRESH_MS) {
      cohortBoundary = { block: lowerBound, ts: Number(persistedTs), hash: persistedHash!.toLowerCase() }
      return cohortBoundary
    }
  }
  let low = lowerBound, high = head.number
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    const candidate = await rpc.call('eth_getBlockByNumber', [hexBlock(mid), false]) as
      { number: string; hash: string; timestamp: string }
    if (blockNumber(candidate.number) !== mid || !/^0x[a-f\d]{64}$/i.test(candidate.hash))
      throw new Error('Invalid historical cohort block')
    if (blockNumber(candidate.timestamp) * 1000 <= target) low = mid
    else high = mid - 1
  }
  const block = low
  const anchor = await rpc.call('eth_getBlockByNumber', [hexBlock(block), false]) as
    { number: string; hash: string; timestamp: string }
  if (blockNumber(anchor.number) !== block || !/^0x[a-f\d]{64}$/i.test(anchor.hash))
    throw new Error('Invalid canonical cohort boundary')
  const ts = blockNumber(anchor.timestamp) * 1000
  const hash = anchor.hash.toLowerCase()
  if (persistedBlock === null || Number(persistedBlock) !== block) {
    db.exec('BEGIN IMMEDIATE')
    try {
      setCursor(COHORT_BLOCK, String(block))
      setCursor(COHORT_TS, String(ts))
      setCursor(COHORT_HASH, hash)
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  cohortBoundary = { block, ts, hash }
  return cohortBoundary
}

async function ensureCohortBoundary(head: { number: number; ts: number }): Promise<CohortBoundary> {
  if (cohortPending) return cohortPending
  cohortPending = deriveCohortBoundary(head)
  try { return await cohortPending }
  finally { cohortPending = null }
}

function abiAddress(owner: string): string { return owner.slice(2).padStart(64, '0') }
async function validateAnchor(token: string, head: number, ts: number): Promise<void> {
  if (!rpc) throw new Error('Robinhood RPC unavailable')
  const owners = positiveBalances(token)
  const expected = owners.reduce((sum, o) => sum + o.amount, 0n)
  const supplyHex = await rpc.call('eth_call', [{ to: token, data: '0x18160ddd' }, hexBlock(head)]) as string
  if (!/^0x[a-f\d]{64}$/i.test(supplyHex) || BigInt(supplyHex) !== expected)
    throw new Error('Transfer ledger does not equal finalized totalSupply; token may rebalance or omit events')
  for (let i = 0; i < owners.length; i += 100) {
    const chunk = owners.slice(i, i + 100)
    const balances = await rpc.batch(chunk.map(o => ({ method: 'eth_call',
      params: [{ to: token, data: `0x70a08231${abiAddress(o.owner)}` }, hexBlock(head)] }))) as string[]
    balances.forEach((value, n) => {
      if (!/^0x[a-f\d]{64}$/i.test(value) || BigInt(value) !== chunk[n].amount)
        throw new Error('Transfer ledger does not match finalized balanceOf; token needs a different balance source')
    })
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  const top20 = owners.slice(0, 20)
  const baselineTop = top20.reduce((sum, o) => sum + o.amount, 0n)
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = ensure(token)
    if (!row || row.covered_through_block !== head || row.state !== 'fetching') throw new Error('Holder anchor moved during validation')
    if (cohortBoundary && row.deployment_block !== null && row.deployment_block <= cohortBoundary.block &&
      !row.cohort_examined) throw new Error('Historical holder cohort boundary was not replayed')
    if (row.baseline_block !== null &&
      (!(baselineOf.all(token) as { owner: string }[]).length || row.baseline_top20_share === null))
      throw new Error('Historical holder cohort is incomplete')
    if (row.baseline_block === null) {
      db.prepare('DELETE FROM research_rh_holder_baseline_top WHERE token=?').run(token)
      db.prepare('DELETE FROM research_rh_holder_cohort_balances WHERE token=?').run(token)
      const add = db.prepare('INSERT INTO research_rh_holder_baseline_top(token,owner,amount) VALUES(?,?,?)')
      for (const o of top20) add.run(token, o.owner, o.amount.toString())
      for (const o of owners) upsertCohortBalance.run(token, o.owner, o.amount.toString())
    }
    const globalCursor = getCursor(GLOBAL_BLOCK)
    const synced = globalCursor !== null && head >= Number(globalCursor)
    db.prepare(`UPDATE research_rh_holder_state SET state=?,reason=?,global_synced=?,
      baseline_block=?,baseline_ts=?,covered_through_ts=?,baseline_top20_share=?,validated_owners=? WHERE token=?`)
      .run(synced ? 'live' : 'stale', synced ? null : 'Joining the finalized global Transfer stream.',
        Number(synced), row.baseline_block ?? head, row.baseline_ts ?? ts, ts,
        row.baseline_top20_share ?? pct(baselineTop, expected), owners.length, token)
    if (cohortBoundary) rollCohort(token, cohortBoundary)
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  announce(token)
}

async function initializeOne(token: string, head: { number: number; ts: number }): Promise<void> {
  if (!rpc) return
  const row = ensure(token)
  if (!row || row.state !== 'pending' || row.deployment_block !== null) return
  const first = await findDeployment(token, head.number)
  db.prepare(`UPDATE research_rh_holder_state SET state='fetching',reason=NULL,
    attempted_at=COALESCE(attempted_at,?),deployment_block=?,covered_through_block=? WHERE token=?`)
    .run(Date.now(), first, first - 1, token)
}

async function bootstrapGroup(head: { number: number; ts: number }, cohort: CohortBoundary): Promise<void> {
  if (!rpc) return
  const rows = db.prepare(`SELECT token,covered_through_block,deployment_block,cohort_examined FROM research_rh_holder_state
    WHERE state='fetching' AND covered_through_block IS NOT NULL
    ORDER BY (first_seen_ts >= ?) DESC,covered_through_block,first_seen_ts DESC,token LIMIT 32`)
    .all(sourceStartedAt) as { token: string; covered_through_block: number; deployment_block: number; cohort_examined: number }[]
  if (!rows.length) return
  for (const row of rows) {
    if (row.deployment_block > cohort.block || row.covered_through_block < cohort.block || row.cohort_examined) continue
    // An older process advanced past this boundary before cohort capture
    // existed. Rebuild from deployment; never substitute a current cohort.
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM research_rh_holder_balances WHERE token=?').run(row.token)
      db.prepare('DELETE FROM research_rh_holder_baseline_top WHERE token=?').run(row.token)
      db.prepare('DELETE FROM research_rh_holder_cohort_balances WHERE token=?').run(row.token)
      db.prepare('DELETE FROM research_rh_holder_cohort_deltas WHERE token=?').run(row.token)
      db.prepare(`UPDATE research_rh_holder_state SET covered_through_block=deployment_block-1,
        covered_through_ts=NULL,baseline_block=NULL,baseline_ts=NULL,baseline_top20_share=NULL,
        transfers=0,validated_owners=0,global_synced=0,
        reason='Replaying event-derived historical cohort from deployment.'
        WHERE token=?`).run(row.token)
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    return
  }
  const from = Math.min(...rows.map(row => row.covered_through_block + 1))
  if (from > head.number) {
    // A persisted cursor above the provider's finalized head is inconsistent;
    // do not silently treat the token as covered on this fork.
    if (rows.some(row => row.covered_through_block > head.number))
      throw new Error('Holder replay cursor exceeds finalized head')
    // Every member of this group reached the same finalized anchor.
    for (const row of rows) if (row.covered_through_block === head.number)
      await validateAnchor(row.token, head.number, head.ts)
    return
  }
  const to = Math.min(head.number, from + 9_999)
  const addresses = rows.filter(row => row.covered_through_block < to).map(row => row.token)
  const logs = await completeAddressLogs(rpc, addresses, from, to)
  const times = await rpc.finalizedStampedTimes(logs, from, to, head.number)
  const toTs = times.get(to) ?? (to === head.number ? head.ts :
    blockNumber((await rpc.call('eth_getBlockByNumber', [hexBlock(to), false]) as { timestamp: string }).timestamp) * 1000)
  const byToken = new Map<string, ChainLog[]>()
  for (const log of logs) {
    const transfer = decodeTransfer(log)
    if (!transfer || !addresses.includes(transfer.token)) throw new Error('Unexpected token in grouped Transfer replay')
    const list = byToken.get(transfer.token) ?? []
    list.push(log)
    byToken.set(transfer.token, list)
  }
  for (const row of rows) {
    if (row.covered_through_block >= to) continue
    const ownFrom = row.covered_through_block + 1
    const ownLogs = (byToken.get(row.token) ?? []).filter(log => blockNumber(log.blockNumber) >= ownFrom)
    try {
      await applyRange(row.token, ownLogs, ownFrom, to, head, times, toTs, cohort)
      if (to === head.number) await validateAnchor(row.token, head.number, head.ts)
    } catch (error) {
      if (/Transfer exceeds|does not equal|does not match|No ERC-20|Malformed|Noncontiguous|Unexpected token/.test(String(error)))
        mark(row.token, 'unavailable', String(error).slice(0, 260))
      else db.prepare('UPDATE research_rh_holder_state SET reason=? WHERE token=?')
        .run(`Finalized holder replay is waiting for RPC: ${String(error).slice(0, 180)}`, row.token)
    }
  }
}

async function bootstrapTick(): Promise<void> {
  if (!rpc || bootstrapRunning) return
  bootstrapRunning = true
  try {
    const row = db.prepare(`SELECT token,first_seen_ts FROM research_rh_holder_state WHERE state='pending'
      ORDER BY first_seen_ts DESC,token LIMIT 1`)
      .get() as { token: string; first_seen_ts: number } | undefined
    const fetching = (db.prepare("SELECT COUNT(*) AS n FROM research_rh_holder_state WHERE state='fetching'")
      .get() as { n: number }).n
    if (!row && !fetching) return
    const head = await rpc.finalizedHead()
    const cohort = await ensureCohortBoundary(head)
    // Keep a bounded group of historical replays so log ranges are shared.
    // A genuinely new token can join immediately even while the older
    // backlog is running, without dropping any earlier token from the queue.
    if (row && (fetching < 32 || row.first_seen_ts >= sourceStartedAt)) {
      try { await initializeOne(row.token, head) }
      catch (error) {
        if (/No ERC-20|Invalid historical|Malformed/.test(String(error)))
          mark(row.token, 'unavailable', String(error).slice(0, 260))
        else db.prepare('UPDATE research_rh_holder_state SET reason=? WHERE token=?')
          .run(`Deployment lookup is waiting for RPC: ${String(error).slice(0, 180)}`, row.token)
      }
    }
    await bootstrapGroup(head, cohort)
  } catch (error) {
    // A source-level failure leaves every per-token cursor unchanged.
    console.error('[rh:holders] replay pending:', String(error).slice(0, 260))
  } finally { bootstrapRunning = false }
}

async function liveTick(): Promise<void> {
  if (!rpc || liveRunning) return
  liveRunning = true
  try {
    const head = await rpc.finalizedHead()
    const cohort = await ensureCohortBoundary(head)
    let cursor = Number(getCursor(GLOBAL_BLOCK))
    if (getCursor(GLOBAL_BLOCK) === null) {
      // No prior subscriber exists on first enablement. Every token still
      // performs its complete deployment replay before joining this cursor.
      db.exec('BEGIN IMMEDIATE')
      try {
        setCursor(GLOBAL_BLOCK, String(head.number))
        setCursor(GLOBAL_TS, String(head.ts))
        setCursor(GLOBAL_HASH, head.hash)
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
      cursor = head.number
    }
    const priorHash = getCursor(GLOBAL_HASH)
    const priorTs = Number(getCursor(GLOBAL_TS))
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > head.number ||
      !priorHash || !/^0x[a-f\d]{64}$/i.test(priorHash) || !Number.isSafeInteger(priorTs))
      throw new Error('Invalid persisted finalized Transfer cursor')
    const prior = await rpc.call('eth_getBlockByNumber', [hexBlock(cursor), false]) as
      { number: string; hash: string; timestamp: string }
    if (blockNumber(prior.number) !== cursor || prior.hash?.toLowerCase() !== priorHash.toLowerCase() ||
      blockNumber(prior.timestamp) * 1000 !== priorTs)
      throw new Error('Finalized Transfer cursor no longer matches canonical history')
    while (cursor < head.number) {
      const from = cursor + 1, to = Math.min(head.number, from + 999)
      // One chain-wide finalized log read replaces one read per 32 tokens.
      // The stream is complete before any FTL token is filtered from it.
      const logs = await rpc.completeLogs({ topics: [TRANSFER_TOPIC] }, from, to)
      const times = await rpc.finalizedStampedTimes(logs, from, to, head.number)
      const anchor = await rpc.call('eth_getBlockByNumber', [hexBlock(to), false]) as
        { number: string; hash: string; timestamp: string }
      if (blockNumber(anchor.number) !== to || !/^0x[a-f\d]{64}$/i.test(anchor.hash) ||
        blockNumber(anchor.timestamp) * 1000 !== times.get(to))
        throw new Error('Finalized Transfer range anchor changed')
      const byToken = new Map<string, Transfer[]>()
      for (const log of logs) {
        const token = log.address?.toLowerCase()
        if (!seenTokens.has(token) || log.topics?.length === 4) continue
        const move = decodeTransfer(log)
        if (!move || move.block < from || move.block > to)
          throw new Error('Invalid FTL token Transfer in finalized global stream')
        const moves = byToken.get(token) ?? []
        moves.push(move)
        byToken.set(token, moves)
      }
      const changed = new Set<string>()
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const [token, moves] of byToken) {
          const row = ensure(token)
          if (!row || !row.global_synced || !['live', 'stale'].includes(row.state) ||
            row.covered_through_block === null) continue
          moves.sort((a, b) => a.block - b.block || a.index - b.index)
          const fresh = moves.filter(move => move.block > row.covered_through_block!)
          if (!fresh.length) continue
          db.exec('SAVEPOINT rh_token')
          try {
            for (const move of fresh) {
              applyOne(move)
              if (row.baseline_block !== null && move.block > row.baseline_block)
                recordCohortDelta(move)
            }
            const last = fresh.at(-1)!
            db.prepare(`UPDATE research_rh_holder_state SET covered_through_block=?,covered_through_ts=?,
              transfers=transfers+?,state='live',reason=NULL WHERE token=?`)
              .run(last.block, times.get(last.block), fresh.length, token)
            db.exec('RELEASE rh_token')
            changed.add(token)
          } catch (error) {
            db.exec('ROLLBACK TO rh_token')
            db.exec('RELEASE rh_token')
            db.prepare(`UPDATE research_rh_holder_state SET state='unavailable',global_synced=0,reason=? WHERE token=?`)
              .run(`Finalized Transfer ledger cannot be maintained: ${String(error).slice(0, 180)}`, token)
            changed.add(token)
          }
        }
        setCursor(GLOBAL_BLOCK, String(to))
        setCursor(GLOBAL_TS, String(times.get(to)))
        setCursor(GLOBAL_HASH, anchor.hash.toLowerCase())
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
      cursor = to
      for (const token of changed) announce(token)
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    // Restarted members remain stale until the global cursor has replayed
    // its gap from the last durable canonical block.
    db.prepare("UPDATE research_rh_holder_state SET state='live',reason=NULL WHERE state='stale' AND global_synced=1").run()

    // A bootstrap may finish while the global stream is a few blocks ahead.
    // Join it with one bounded address-filtered catchup, then inherit the
    // global coverage cursor. This cost occurs once per token, not every tick.
    const lagging = db.prepare(`SELECT token,covered_through_block FROM research_rh_holder_state
      WHERE state='stale' AND global_synced=0 AND baseline_block IS NOT NULL
      ORDER BY first_seen_ts DESC,token LIMIT 32`).all() as
      { token: string; covered_through_block: number }[]
    for (const row of lagging) {
      const from = row.covered_through_block + 1
      if (from <= cursor) {
        const to = Math.min(cursor, from + 9_999)
        const logs = await completeAddressLogs(rpc, [row.token], from, to)
        const times = await rpc.finalizedStampedTimes(logs, from, to, head.number)
        await applyRange(row.token, logs, from, to, { number: cursor, ts: Number(getCursor(GLOBAL_TS)) },
          times, times.get(to), cohort)
      }
      const current = ensure(row.token)
      if (current?.covered_through_block === cursor) {
        db.prepare("UPDATE research_rh_holder_state SET state='live',reason=NULL,global_synced=1 WHERE token=?")
          .run(row.token)
        announce(row.token)
      }
    }
    // The seven-day boundary can move even when a token has no new Transfer
    // at the head. Recompute only cohorts with journaled moves newly crossing
    // that boundary; inactive tokens use the canonical boundary lazily.
    const due = db.prepare(`SELECT DISTINCT token FROM research_rh_holder_cohort_deltas
      WHERE block<=? ORDER BY token`).all(cohort.block) as { token: string }[]
    for (const { token } of due) {
      const row = ensure(token)
      if (!row || row.state !== 'live' || !row.global_synced || cursor < cohort.block) continue
      db.exec('BEGIN IMMEDIATE')
      try { rollCohort(token, cohort); db.exec('COMMIT') }
      catch (error) {
        db.exec('ROLLBACK')
        mark(token, 'unavailable', `Rolling holder cohort failed: ${String(error).slice(0, 180)}`)
        continue
      }
      announce(token)
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  } catch (error) {
    db.prepare(`UPDATE research_rh_holder_state SET state='stale',reason=?
      WHERE state='live' AND global_synced=1`)
      .run(`Finalized Transfer replay interrupted: ${String(error).slice(0, 180)}`)
    console.error('[rh:holders] live replay pending:', String(error).slice(0, 260))
  } finally { liveRunning = false }
}

async function completeAddressLogs(source: StrictRhRpc, addresses: string[], from: number, to: number): Promise<ChainLog[]> {
  if (!addresses.length) return []
  try { return await source.completeLogs({ address: addresses, topics: [TRANSFER_TOPIC] }, from, to) }
  catch (error) {
    // Some RPC gateways limit address-array size independently of block range.
    // Split the filter, never silently drop a token from coverage.
    if (addresses.length === 1 || !/too many addresses|address (?:array|list|limit)|filter addresses/i.test(String(error)))
      throw error
    const mid = Math.floor(addresses.length / 2)
    return [...await completeAddressLogs(source, addresses.slice(0, mid), from, to),
      ...await completeAddressLogs(source, addresses.slice(mid), from, to)]
  }
}

export function startRobinhoodHolders(source?: StrictRhRpc): void {
  if (started) return
  started = true
  sourceStartedAt = Date.now()
  rpc = source ?? (config.rhHttp ? new StrictRhRpc(config.rhHttp) : null)
  db.exec(`INSERT OR IGNORE INTO research_rh_holder_state(token,first_seen_ts)
    SELECT address,first_seen_ts FROM research_tokens WHERE chain='robinhood'`)
  for (const row of db.prepare("SELECT token FROM research_rh_holder_state").all() as { token: string }[])
    seenTokens.add(row.token)
  // An ungraceful process stop leaves coverage ending at its persisted block.
  db.prepare(`UPDATE research_rh_holder_state SET state='stale',reason='Restart requires finalized Transfer replay.' WHERE state='live'`).run()
  bus.on('research', (chain: string, token: string) => {
    if (chain === 'robinhood' && ensure(token)) seenTokens.add(token)
  })
  if (!rpc) return
  setInterval(() => void bootstrapTick(), 250).unref()
  setInterval(() => void liveTick(), 3_000).unref()
  void bootstrapTick()
  void liveTick()
}

// Explicit advancement also supports deterministic provider-fixture checks.
export async function advanceRobinhoodHolderBootstrap(): Promise<void> { await bootstrapTick() }
export async function advanceRobinhoodHolderLive(): Promise<void> { await liveTick() }
