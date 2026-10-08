// One-time, event-derived Solana price history. Helius gTFA pages raw
// transactions for each FTL-observed mint; this module does not poll balances
// or create periodic price snapshots. A completed page is durable before the
// next cursor is requested, so a restart may replay a page without duplicating
// a swap or candle (ingestSwap is signature-idempotent).

import { DatabaseSync } from 'node:sqlite'
import bs58 from 'bs58'
import { extractSwap, type SwapObservation } from './swaps.ts'
import type { NIx, NTx, TokenBal } from './decode.ts'
import { ingestProgramObservations } from './program-service.ts'
import { observePrograms } from './program-observation.ts'

const PAGE_SIZE = 100 // Helius documented full-detail default; larger pages risk huge payloads
const CREDIT_PER_REQUEST = 100 // Helius published gTFA rate, not a bill amount
const DAY = 86_400_000

export interface ArchiveJob {
  token: string
  start_ms: number
  end_ms: number
  anchor_slot: number
  cursor: string | null
  state: 'pending' | 'running' | 'complete' | 'blocked'
  pages: number
  bytes: number
  records: number
  eligible_swaps: number
  overlap_total: number
  overlap_missing: number
  attempts: number
  next_attempt_ms: number
  updated_ms: number
  reason: string | null
}

export interface ArchiveProgress {
  token: string
  state: ArchiveJob['state']
  pages: number
  bytes: number
  records: number
  eligibleSwaps: number
  overlapTotal: number
  overlapMissing: number
  estimatedCredits: number
  reason: string | null
}

export interface ArchiveOptions {
  db: DatabaseSync
  endpoint: string // server-only keyed Helius mainnet RPC URL
  onSwap: (swap: SwapObservation) => void
  fetch?: typeof fetch
  now?: () => number
}

class ArchiveShapeError extends Error {}
class ArchiveProviderError extends Error {
  readonly permanent: boolean
  constructor(message: string, permanent: boolean) { super(message); this.permanent = permanent }
}
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const uint = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0

function pubkey(v: unknown): v is string {
  if (typeof v !== 'string') return false
  try { return bs58.decode(v).length === 32 } catch { return false }
}

function dataBytes(v: unknown): Uint8Array {
  if (typeof v !== 'string') throw new ArchiveShapeError('Transaction instruction has no raw data')
  try { return bs58.decode(v) } catch { throw new ArchiveShapeError('Transaction instruction has invalid raw data') }
}

function balances(v: unknown, keyCount: number): TokenBal[] {
  if (!Array.isArray(v)) throw new ArchiveShapeError('Transaction omitted token balance arrays')
  return v.map(b => {
    const amount = b?.uiTokenAmount?.amount, decimals = b?.uiTokenAmount?.decimals
    if (!uint(b?.accountIndex) || b.accountIndex >= keyCount || !pubkey(b?.mint) ||
      !pubkey(b?.owner) || typeof amount !== 'string' || !/^\d+$/.test(amount) ||
      !uint(decimals) || decimals > 18)
      throw new ArchiveShapeError('Transaction has an unusable token balance')
    return { idx: b.accountIndex, mint: b.mint, owner: b.owner,
      amount: BigInt(amount), decimals }
  })
}

/** Decode an archival full-detail RPC row into the same strict shape used by live extraction. */
export function archivalTransaction(row: unknown): { tx: NTx; ts: number } {
  if (!object(row) || !uint(row.slot) || !uint(row.blockTime) || !object(row.transaction) ||
    !object(row.transaction.message) || !object(row.meta) || row.meta.err !== null)
    throw new ArchiveShapeError('Archival transaction lacks canonical successful metadata')
  const sig = row.transaction.signatures?.[0]
  let signatureLength = 0
  try { if (typeof sig === 'string') signatureLength = bs58.decode(sig).length } catch {}
  if (!Array.isArray(row.transaction.signatures) || signatureLength !== 64)
    throw new ArchiveShapeError('Archival transaction lacks a valid signature')
  const message = row.transaction.message
  const staticKeys = message.accountKeys
  const loaded = row.meta.loadedAddresses ??
    (row.version === 'legacy' ? { writable: [], readonly: [] } : undefined)
  if (!Array.isArray(staticKeys) || !staticKeys.length || !staticKeys.every(pubkey) ||
    !object(loaded) || !Array.isArray(loaded.writable) || !loaded.writable.every(pubkey) ||
    !Array.isArray(loaded.readonly) || !loaded.readonly.every(pubkey))
    throw new ArchiveShapeError('Archival transaction lacks resolved account keys')
  const keys: string[] = [...staticKeys, ...loaded.writable, ...loaded.readonly]
  const instruction = (ix: any, n: string): NIx => {
    if (!uint(ix?.programIdIndex) || ix.programIdIndex >= keys.length ||
      !Array.isArray(ix.accounts) || !ix.accounts.every((i: unknown) => uint(i) && i < keys.length))
      throw new ArchiveShapeError('Archival instruction has unresolved accounts')
    return { prog: keys[ix.programIdIndex], accts: ix.accounts, data: dataBytes(ix.data), n }
  }
  const inner = row.meta.innerInstructions ?? []
  if (!Array.isArray(message.instructions) || !Array.isArray(inner))
    throw new ArchiveShapeError('Archival transaction omitted instruction arrays')
  const ixs: NIx[] = message.instructions.map((ix: any, i: number) => instruction(ix, String(i)))
  for (const group of inner) {
    if (!uint(group?.index) || !Array.isArray(group.instructions))
      throw new ArchiveShapeError('Archival transaction has invalid inner instructions')
    group.instructions.forEach((ix: any, j: number) => ixs.push(instruction(ix, `${group.index}.${j}`)))
  }
  const pre = balances(row.meta.preTokenBalances, keys.length)
  const post = balances(row.meta.postTokenBalances, keys.length)
  return { tx: { sig, slot: row.slot, keys, ixs, pre, post, failed: false,
    version: row.version === 0 || row.version === 1 ? row.version : 'legacy' }, ts: row.blockTime * 1000 }
}

function page(result: unknown, priorCursor: string | null): { rows: unknown[]; cursor: string | null } {
  if (!object(result) || !Array.isArray(result.data) || result.data.length > PAGE_SIZE)
    throw new ArchiveShapeError('Helius returned an invalid archival page')
  const cursor = result.paginationToken ?? null
  if (cursor !== null && (typeof cursor !== 'string' || !cursor || cursor === priorCursor || !result.data.length))
    throw new ArchiveShapeError('Helius returned an invalid archival cursor')
  return { rows: result.data, cursor }
}

function progress(job: ArchiveJob): ArchiveProgress {
  return { token: job.token, state: job.state, pages: job.pages, bytes: job.bytes,
    records: job.records, eligibleSwaps: job.eligible_swaps,
    overlapTotal: job.overlap_total, overlapMissing: job.overlap_missing,
    estimatedCredits: job.pages * CREDIT_PER_REQUEST, reason: job.reason }
}

export class SolanaPriceArchive {
  private readonly db: DatabaseSync
  private readonly endpoint: string
  private readonly onSwap: ArchiveOptions['onSwap']
  private readonly fetcher: typeof fetch
  private readonly now: () => number

  constructor(options: ArchiveOptions) {
    this.db = options.db
    this.endpoint = options.endpoint
    this.onSwap = options.onSwap
    this.fetcher = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.db.exec(`CREATE TABLE IF NOT EXISTS research_solana_price_archive (
      token TEXT PRIMARY KEY, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
      anchor_slot INTEGER NOT NULL, cursor TEXT, state TEXT NOT NULL DEFAULT 'pending',
      pages INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
      records INTEGER NOT NULL DEFAULT 0, eligible_swaps INTEGER NOT NULL DEFAULT 0,
      overlap_total INTEGER NOT NULL DEFAULT 0, overlap_missing INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_ms INTEGER NOT NULL DEFAULT 0,
      updated_ms INTEGER NOT NULL, reason TEXT);
      CREATE INDEX IF NOT EXISTS research_solana_price_archive_queue
        ON research_solana_price_archive(state, next_attempt_ms, updated_ms);
      CREATE TABLE IF NOT EXISTS research_solana_price_archive_overlap (
        token TEXT NOT NULL, swap_id TEXT NOT NULL, PRIMARY KEY(token, swap_id));`)
  }

  /** Enroll every FTL-seen mint; the caller supplies a finalized anchor and fixed event window. */
  enqueue(token: string, startMs: number, endMs: number, anchorSlot: number): boolean {
    if (!pubkey(token) || !uint(startMs) || !uint(endMs) || endMs <= startMs ||
      startMs % DAY !== 0 || endMs - startMs < 30 * DAY || endMs > this.now() || !uint(anchorSlot))
      throw new Error('Archival window needs a mint, 30 complete days and a finalized slot')
    if (!this.db.prepare("SELECT 1 FROM research_tokens WHERE chain = 'solana' AND address = ?").get(token))
      throw new Error('Archival mint must first be observed by FTL')
    const now = this.now()
    const insert = this.db.prepare(`INSERT OR IGNORE INTO research_solana_price_archive
      (token,start_ms,end_ms,anchor_slot,updated_ms) VALUES(?,?,?,?,?)`)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const created = insert.run(token, startMs, endMs, anchorSlot, now).changes > 0
      if (created) {
        this.db.prepare(`INSERT OR IGNORE INTO research_solana_price_archive_overlap(token,swap_id)
          SELECT ?,id FROM research_swaps WHERE chain = 'solana' AND token = ? AND finalized = 1
            AND ts >= ? AND ts < ? AND slot <= ?`).run(token, token, startMs, endMs, anchorSlot)
        const total = (this.db.prepare('SELECT COUNT(*) n FROM research_solana_price_archive_overlap WHERE token = ?')
          .get(token) as { n: number }).n
        this.db.prepare('UPDATE research_solana_price_archive SET overlap_total = ?, overlap_missing = ? WHERE token = ?')
          .run(total, total, token)
      }
      this.db.exec('COMMIT')
      return created
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }

  get(token: string): ArchiveProgress | null {
    const row = this.db.prepare('SELECT * FROM research_solana_price_archive WHERE token = ?').get(token) as ArchiveJob | undefined
    return row ? progress(row) : null
  }

  totals(): { queued: number; complete: number; blocked: number; pages: number; bytes: number; estimatedCredits: number } {
    const row = this.db.prepare(`SELECT
      SUM(CASE WHEN state IN ('pending','running') THEN 1 ELSE 0 END) queued,
      SUM(CASE WHEN state = 'complete' THEN 1 ELSE 0 END) complete,
      SUM(CASE WHEN state = 'blocked' THEN 1 ELSE 0 END) blocked,
      COALESCE(SUM(pages),0) pages, COALESCE(SUM(bytes),0) bytes
      FROM research_solana_price_archive`).get() as { queued: number | null; complete: number | null; blocked: number | null; pages: number; bytes: number }
    return { queued: row.queued ?? 0, complete: row.complete ?? 0, blocked: row.blocked ?? 0,
      pages: row.pages, bytes: row.bytes, estimatedCredits: row.pages * CREDIT_PER_REQUEST }
  }

  /** One fair unit of work. Repeated calls round-robin all enrolled tokens, with no universe cutoff. */
  async next(): Promise<ArchiveProgress | null> {
    const job = this.db.prepare(`SELECT * FROM research_solana_price_archive
      WHERE state IN ('pending','running') AND next_attempt_ms <= ?
      ORDER BY updated_ms ASC, token ASC LIMIT 1`).get(this.now()) as ArchiveJob | undefined
    if (!job) return null
    const options = { transactionDetails: 'full', sortOrder: 'asc', limit: PAGE_SIZE,
      ...(job.cursor ? { paginationToken: job.cursor } : {}),
      filters: { blockTime: { gte: Math.floor(job.start_ms / 1000),
        lte: Math.floor((job.end_ms - 1) / 1000) }, status: 'succeeded' } }
    let body: string
    try {
      const response = await this.fetcher(this.endpoint, { method: 'POST', signal: AbortSignal.timeout(30_000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransactionsForAddress',
          params: [job.token, options] }) })
      if (!response.ok) throw new ArchiveProviderError(`Helius archival HTTP ${response.status}`,
        response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status))
      body = await response.text()
      const json = JSON.parse(body)
      if (json.error) {
        const code = Number(json.error.code)
        throw new ArchiveProviderError(`Helius archival RPC ${Number.isSafeInteger(code) ? code : 'error'}`,
          [-32600, -32601, -32602].includes(code))
      }
      const parsed = page(json.result, job.cursor)
      const swaps: SwapObservation[] = []
      for (const row of parsed.rows) {
        const { tx, ts } = archivalTransaction(row)
        if (ts < job.start_ms || ts >= job.end_ms)
          throw new ArchiveShapeError('Archival record falls outside the fixed time window')
        if (tx.slot > job.anchor_slot) continue // same blockTime second can include newer slots
        const discovery = observePrograms(tx, 'price-archive', Date.now(), true, true)
        if (discovery) ingestProgramObservations([discovery])
        const swap = extractSwap(tx, ts)
        if (swap?.token === job.token) swaps.push({ ...swap, finalized: true })
      }
      // On a crash before cursor commit the same signatures are safely replayed.
      for (const swap of swaps) {
        this.onSwap(swap)
        this.db.prepare('DELETE FROM research_solana_price_archive_overlap WHERE token = ? AND swap_id = ?')
          .run(job.token, `solana:${swap.id}`)
      }
      const missing = (this.db.prepare('SELECT COUNT(*) n FROM research_solana_price_archive_overlap WHERE token = ?')
        .get(job.token) as { n: number }).n
      const done = parsed.cursor === null
      const state = done && missing ? 'blocked' : done ? 'complete' : 'running'
      const reason = done && missing ? `${missing} finalized live swap signatures were absent from the mint archive` : null
      const now = this.now()
      this.db.prepare(`UPDATE research_solana_price_archive SET cursor = ?, state = ?, pages = pages + 1,
        bytes = bytes + ?, records = records + ?, eligible_swaps = eligible_swaps + ?,
        overlap_missing = ?, attempts = 0, next_attempt_ms = 0, updated_ms = ?, reason = ?
        WHERE token = ?`).run(parsed.cursor, state, Buffer.byteLength(body), parsed.rows.length,
        swaps.length, missing, now, reason, job.token)
      return this.get(job.token)
    } catch (error) {
      const fatal = error instanceof ArchiveShapeError ||
        (error instanceof ArchiveProviderError && error.permanent)
      const attempts = job.attempts + 1
      const waitMs = Math.min(15 * 60_000, 1_000 * 2 ** Math.min(attempts, 10))
      // Never persist a provider error body or a fetch exception: either may
      // contain the keyed RPC URL supplied to this server-side module.
      const reason = error instanceof ArchiveShapeError || error instanceof ArchiveProviderError
        ? error.message : 'Helius archival request failed'
      this.db.prepare(`UPDATE research_solana_price_archive SET state = ?, attempts = ?,
        next_attempt_ms = ?, updated_ms = ?, reason = ? WHERE token = ?`)
        .run(fatal ? 'blocked' : 'running', attempts, fatal ? 0 : this.now() + waitMs,
          this.now(), reason, job.token)
      return this.get(job.token)
    }
  }
}
