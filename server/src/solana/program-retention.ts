// Time limit on the program index's per-transaction history (receipts, transactions, edge receipts, activity). Those
// rows are what grew programs.db by ~11 GB/day until it filled the volume on 2026-10-13 15:22 UTC. Nothing reads them
// past the latest few per program, so rows older than the window are cleared. The learned registry (programs, IDLs,
// edges, samples, swap templates) and the per-minute counters are small and stay forever.
//
// SQLite reuses the freed pages, so the file stops growing at about one window of history; it does not shrink.
import type { DatabaseSync } from 'node:sqlite'

type Row = { rowid: number; ts: number }
const BATCH = 5_000
const pause = () => new Promise(resolve => setTimeout(resolve, 5))

// Rows are appended in time order and upserts keep both rowid and ts, so ts rises with rowid. That makes the cutoff a
// rowid found by binary search, and each delete a cheap rowid range instead of a scan of a multi-GB table.
function cutoffRowid(db: DatabaseSync, probeSql: string, maxSql: string, cutoff: number): { start: number; end: number } | null {
  const probe = db.prepare(probeSql)
  const first = probe.get(0) as Row | undefined
  if (!first || first.ts >= cutoff) return null
  const max = Number((db.prepare(maxSql).get() as { m: number | null }).m ?? first.rowid)
  let lo = first.rowid, hi = max + 1
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    const row = probe.get(mid) as Row | undefined
    if (!row || row.ts >= cutoff) hi = mid
    else lo = row.rowid
  }
  return { start: first.rowid, end: hi }
}

async function clearRange(db: DatabaseSync, table: string, range: { start: number; end: number } | null) {
  if (!range) return 0
  const del = db.prepare(`DELETE FROM ${table} WHERE rowid >= ? AND rowid < ?`)
  let cleared = 0
  for (let at = range.start; at < range.end; at += BATCH) {
    cleared += Number(del.run(at, Math.min(at + BATCH, range.end)).changes)
    await pause()
  }
  return cleared
}

/** Clears per-transaction history older than `cutoff` (ms). Yields between batches so the worker keeps serving. */
export async function pruneProgramHistory(db: DatabaseSync, cutoff: number) {
  const counts: Record<string, number> = {}
  // Edge receipts carry no timestamp; they take their transaction's. Cleared before transactions so that lookup still
  // works; a receipt whose transaction is already gone counts as old.
  counts.program_edge_receipts = await clearRange(db, 'program_edge_receipts', cutoffRowid(db,
    `SELECT e.rowid AS rowid, COALESCE((SELECT t.ts FROM program_transactions t WHERE t.signature = e.signature), 0) AS ts
       FROM program_edge_receipts e WHERE e.rowid >= ? ORDER BY e.rowid LIMIT 1`,
    'SELECT MAX(rowid) AS m FROM program_edge_receipts', cutoff))
  for (const table of ['program_receipts', 'program_transactions']) {
    counts[table] = await clearRange(db, table, cutoffRowid(db,
      `SELECT rowid, ts FROM ${table} WHERE rowid >= ? ORDER BY rowid LIMIT 1`, `SELECT MAX(rowid) AS m FROM ${table}`, cutoff))
  }
  const activity = db.prepare('DELETE FROM program_activity WHERE id IN (SELECT id FROM program_activity WHERE ts < ? ORDER BY ts LIMIT ?)')
  counts.program_activity = 0
  for (;;) {
    const n = Number(activity.run(cutoff, BATCH).changes)
    counts.program_activity += n
    if (n < BATCH) break
    await pause()
  }
  return counts
}
