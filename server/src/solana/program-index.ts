// Durable discovery, ranking and IDL provenance. Runtime writes run in their
// own worker/SQLite WAL so a seed search or busy program stream cannot stall FTL.
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import type { ProgramActivity, ProgramBucket, ProgramCoverage, ProgramDetail, ProgramList, ProgramRecord, ProgramState, ProgramTotals, ProgramUpdate } from '../../../shared/programs.ts'
import { INFRASTRUCTURE, type InstructionSample, type ProgramObservation, validProgram } from './program-observation.ts'
import { indexableSamples, interfaceMatch, mergeLearnedInstructions, selectorFor } from './program-interface.ts'

const MINUTE = 60_000
type Row = Record<string, any>
export interface ProgramIndexOptions {
  db: DatabaseSync
  composerUrl?: string
  enabled?: boolean
  fetcher?: typeof fetch
  now?: () => number
  onUpdate?: (update: ProgramUpdate) => void
}
class ComposerError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}
const flatten = (accounts: any[]): any[] => (accounts ?? []).flatMap(account => account.accounts ? flatten(account.accounts) : [account])
const discriminator = selectorFor

export function validateInterface(idl: any, address: string, samples: InstructionSample[]) {
  if (!idl || (idl.address ?? idl.metadata?.address) !== address || !Array.isArray(idl.instructions) || !idl.instructions.length)
    throw new Error('Composer returned an interface without the requested program identity or instructions')
  for (const ix of idl.instructions) if (typeof ix.name !== 'string' || !Array.isArray(ix.accounts) ||
    !discriminator(ix).length || !discriminator(ix).every(n => Number.isInteger(n) && n >= 0 && n <= 255))
    throw new Error('Composer returned an invalid instruction schema')
  let matched = 0, mismatched = 0
  const observed = indexableSamples(samples, address)
  for (const sample of observed.samples) {
    const candidates = idl.instructions.filter((ix: any) => interfaceMatch(ix, sample, idl.metadata?.source?.includes('reconstructed') === true))
    if (candidates.length) matched++; else mismatched++
  }
  const learned = idl.metadata?.source?.includes('reconstructed') || !!idl.evidence
  const opaque = idl.instructions.filter((ix: any) =>
    (ix.argsHex?.some((hex: string) => hex.length) || ix.argBytes?.some((n: number) => n > 0)) && !ix.args?.length).length
  // Learned positional names and constant/PDA recipes are observations, even
  // when structural validation passes. They never become a published ABI.
  return { matched, tested: observed.samples.length, mismatched, unresolved: learned ? opaque : 0,
    runtimeEvents: observed.runtimeEvents, missingData: observed.missingData }
}

export class ProgramIndex {
  private readonly db: DatabaseSync
  private readonly now: () => number
  private readonly fetcher: typeof fetch
  private readonly composerUrl: string | undefined
  private readonly enabled: boolean
  private readonly onUpdate: ProgramIndexOptions['onUpdate']
  private dirty = new Set<string>()
  private activityDirty: ProgramActivity[] = []
  private sampleKeys = new Map<string, Set<string>>()
  private working = false
  private completedJobs = 0
  private composerHealth: ProgramCoverage['composer']
  private statements = new Map<string, ReturnType<DatabaseSync['prepare']>>()

  constructor(options: ProgramIndexOptions) {
    this.db = options.db
    this.now = options.now ?? Date.now
    this.fetcher = options.fetcher ?? fetch
    this.composerUrl = options.composerUrl?.replace(/\/$/, '')
    this.enabled = options.enabled !== false
    this.onUpdate = options.onUpdate
    this.composerHealth = { url: this.composerUrl ?? null, connected: null, checkedTs: null, reason: null }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS programs (
        address TEXT PRIMARY KEY, name TEXT, infrastructure INTEGER NOT NULL DEFAULT 0, known INTEGER NOT NULL DEFAULT 0,
        first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL, first_sig TEXT, last_sig TEXT, last_slot INTEGER,
        transactions INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
        outer_count INTEGER NOT NULL DEFAULT 0, inner_count INTEGER NOT NULL DEFAULT 0,
        atomic_count INTEGER NOT NULL DEFAULT 0, bundle_count INTEGER NOT NULL DEFAULT 0, positive_count INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL, phase TEXT NOT NULL, state_ts INTEGER NOT NULL, next_attempt INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
        idl_source TEXT, idl_hash TEXT, instruction_count INTEGER NOT NULL DEFAULT 0, sample_count INTEGER NOT NULL DEFAULT 0,
        validation TEXT, reason TEXT, priority REAL NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS programs_queue ON programs(state,next_attempt,priority DESC,first_ts);
      CREATE INDEX IF NOT EXISTS programs_usage ON programs(transactions DESC,last_ts DESC,address);
      CREATE INDEX IF NOT EXISTS programs_arrivals ON programs(first_ts DESC,address);
      CREATE TABLE IF NOT EXISTS program_receipts (
        address TEXT NOT NULL, signature TEXT NOT NULL, slot INTEGER NOT NULL, ts INTEGER NOT NULL, version TEXT NOT NULL,
        executed INTEGER NOT NULL, failed INTEGER NOT NULL, finalized INTEGER NOT NULL,
        outer_count INTEGER NOT NULL, inner_count INTEGER NOT NULL, atomic_route INTEGER NOT NULL, bundle_hint INTEGER NOT NULL,
        closed_positive INTEGER NOT NULL, PRIMARY KEY(address,signature));
      CREATE INDEX IF NOT EXISTS program_receipts_latest ON program_receipts(address,ts DESC);
      CREATE TABLE IF NOT EXISTS program_transactions (
        signature TEXT PRIMARY KEY, executed INTEGER NOT NULL, ts INTEGER NOT NULL, invocations INTEGER NOT NULL DEFAULT 0,
        atomic_route INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS program_edges (
        caller TEXT NOT NULL, callee TEXT NOT NULL, attribution TEXT NOT NULL, transactions INTEGER NOT NULL,
        last_ts INTEGER NOT NULL, PRIMARY KEY(caller,callee,attribution));
      CREATE TABLE IF NOT EXISTS program_edge_receipts (
        signature TEXT NOT NULL, caller TEXT NOT NULL, callee TEXT NOT NULL, attribution TEXT NOT NULL,
        PRIMARY KEY(signature,caller,callee,attribution));
      CREATE TABLE IF NOT EXISTS program_samples (
        address TEXT NOT NULL, shape TEXT NOT NULL, sample TEXT NOT NULL, PRIMARY KEY(address,shape));
      CREATE TABLE IF NOT EXISTS program_idls (
        address TEXT PRIMARY KEY, body TEXT NOT NULL, source TEXT NOT NULL, hash TEXT NOT NULL, learned_ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS program_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
        message TEXT NOT NULL, ts INTEGER NOT NULL, signature TEXT);
      CREATE INDEX IF NOT EXISTS program_activity_latest ON program_activity(ts DESC,id DESC);
      CREATE TABLE IF NOT EXISTS program_buckets (
        ts INTEGER PRIMARY KEY, discoveries INTEGER NOT NULL DEFAULT 0, transactions INTEGER NOT NULL DEFAULT 0,
        invocations INTEGER NOT NULL DEFAULT 0, learned INTEGER NOT NULL DEFAULT 0, atomic_route INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS program_sources (
        lane TEXT PRIMARY KEY, connected INTEGER NOT NULL DEFAULT 0, last_ts INTEGER, transactions INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS program_index_meta (key TEXT PRIMARY KEY,value INTEGER NOT NULL);
      INSERT OR IGNORE INTO program_index_meta(key,value) VALUES('sequence',0);`)
    // A crash/redeploy preserves every job and names the interruption.
    this.db.prepare(`UPDATE programs SET state='retrying', phase='Resuming interrupted Composer job', next_attempt=?, reason='Worker restarted during learning' WHERE state IN ('checking','learning','validating')`).run(this.now())
    for (const row of this.sql('SELECT address,shape FROM program_samples').all() as Row[]) {
      const keys = this.sampleKeys.get(row.address) ?? new Set<string>(); keys.add(row.shape); this.sampleKeys.set(row.address, keys)
    }
  }

  private sql(query: string) { let statement = this.statements.get(query); if (!statement) { statement = this.db.prepare(query); this.statements.set(query, statement) } return statement }
  private raw(address: string) { return this.sql('SELECT * FROM programs WHERE address=?').get(address) as Row | undefined }
  private bucket(ts: number, discoveries = 0, transactions = 0, invocations = 0, learned = 0, atomic = 0) {
    this.sql(`INSERT INTO program_buckets(ts,discoveries,transactions,invocations,learned,atomic_route) VALUES(?,?,?,?,?,?)
      ON CONFLICT(ts) DO UPDATE SET discoveries=discoveries+excluded.discoveries,transactions=transactions+excluded.transactions,
      invocations=invocations+excluded.invocations,learned=learned+excluded.learned,atomic_route=atomic_route+excluded.atomic_route`)
      .run(Math.floor(ts / MINUTE) * MINUTE, discoveries, transactions, invocations, learned, atomic)
  }
  private activity(address: string, kind: ProgramActivity['kind'], state: ProgramState, message: string, signature: string | null = null) {
    const ts = this.now()
    const insert = this.sql('INSERT INTO program_activity(address,kind,state,message,ts,signature) VALUES(?,?,?,?,?,?)').run(address, kind, state, message, ts, signature)
    this.activityDirty.push({ id: Number(insert.lastInsertRowid), address, kind, state, message, ts, signature })
    this.dirty.add(address)
  }
  private transition(address: string, state: ProgramState, phase: string, reason: string | null = null, nextAttempt: number | null = null) {
    this.sql('UPDATE programs SET state=?,phase=?,state_ts=?,reason=?,next_attempt=? WHERE address=?').run(state, phase, this.now(), reason, nextAttempt, address)
    this.activity(address, state === 'retrying' || state === 'blocked' ? 'retry' : 'progress', state, phase)
    this.flush()
  }

  seed(address: string, idl: any, name: string | null = null) {
    if (!validProgram(address)) return
    const now = this.now(), body = JSON.stringify(idl), hash = createHash('sha256').update(body).digest('hex')
    this.sql(`INSERT OR IGNORE INTO programs(address,name,known,first_ts,last_ts,state,phase,state_ts,idl_source,idl_hash,instruction_count)
      VALUES(?,?,1,?,?,'known','Shipped interface',?,'shipped',?,?)`).run(address, name, now, now, now, hash, idl.instructions?.length ?? 0)
    this.sql(`INSERT OR IGNORE INTO program_idls(address,body,source,hash,learned_ts) VALUES(?,?,'shipped',?,?)`).run(address, body, hash, now)
  }

  observeMany(observations: ProgramObservation[]) {
    if (!this.enabled || !observations.length) return
    const now = this.now()
    this.db.exec('BEGIN')
    try {
      for (const observation of observations) {
        if (!observation.programs.length) continue
        const oldTx = this.sql('SELECT * FROM program_transactions WHERE signature=?').get(observation.signature) as Row | undefined
        const invocationCount = observation.programs.reduce((sum, p) => sum + p.outer + p.inner, 0)
        const atomic = observation.executed && !observation.failed && observation.programs.some(p => p.atomic)
        this.sql(`INSERT INTO program_transactions(signature,executed,ts,invocations,atomic_route) VALUES(?,?,?,?,?)
          ON CONFLICT(signature) DO UPDATE SET executed=MAX(executed,excluded.executed),invocations=MAX(invocations,excluded.invocations),atomic_route=MAX(atomic_route,excluded.atomic_route)`)
          .run(observation.signature, Number(observation.executed), now, invocationCount, Number(atomic))
        this.bucket(now, 0, Number(observation.executed && !oldTx?.executed), Math.max(0, invocationCount - (oldTx?.invocations ?? 0)), 0, Number(atomic && !oldTx?.atomic_route))
        this.sql(`INSERT INTO program_sources(lane,connected,last_ts,transactions) VALUES(?,1,?,?)
          ON CONFLICT(lane) DO UPDATE SET connected=1,last_ts=excluded.last_ts,transactions=transactions+excluded.transactions`)
          .run(observation.lane, now, Number(!oldTx))
        for (const program of observation.programs) {
          if (!validProgram(program.address)) continue
          const builtin = INFRASTRUCTURE.get(program.address)
          const inserted = this.sql(`INSERT OR IGNORE INTO programs(address,name,infrastructure,known,first_ts,last_ts,first_sig,last_sig,last_slot,state,phase,state_ts)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(program.address, builtin ?? null, Number(!!builtin), Number(!!builtin), now, now,
              observation.signature, observation.signature, observation.slot, builtin ? 'known' : 'queued', builtin ? 'Native infrastructure' : 'Waiting for IDL lookup', now).changes > 0
          if (inserted && !builtin) { this.bucket(now, 1); this.activity(program.address, 'discovered', 'queued', `First seen in ${program.outer ? 'an outer instruction' : 'a CPI'}`, observation.signature) }
          const old = this.sql('SELECT * FROM program_receipts WHERE address=? AND signature=?').get(program.address, observation.signature) as Row | undefined
          const executed = observation.executed || !!old?.executed
          const outer = Math.max(program.outer, old?.outer_count ?? 0), inner = Math.max(program.inner, old?.inner_count ?? 0)
          const pAtomic = !observation.failed && observation.executed && program.atomic
          const bundle = observation.executed && !observation.failed && observation.bundleHint
          const positive = observation.executed && !observation.failed && observation.closedPositive
          this.sql(`INSERT INTO program_receipts(address,signature,slot,ts,version,executed,failed,finalized,outer_count,inner_count,atomic_route,bundle_hint,closed_positive)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(address,signature) DO UPDATE SET executed=MAX(executed,excluded.executed),
            failed=excluded.failed,finalized=MAX(finalized,excluded.finalized),outer_count=MAX(outer_count,excluded.outer_count),inner_count=MAX(inner_count,excluded.inner_count),
            atomic_route=MAX(atomic_route,excluded.atomic_route),bundle_hint=MAX(bundle_hint,excluded.bundle_hint),closed_positive=MAX(closed_positive,excluded.closed_positive)`)
            .run(program.address, observation.signature, observation.slot, now, String(observation.version), Number(executed), Number(observation.failed), Number(observation.finalized), outer, inner, Number(pAtomic), Number(bundle), Number(positive))
          this.sql(`UPDATE programs SET last_ts=?,first_sig=COALESCE(first_sig,?),last_sig=?,last_slot=?,transactions=transactions+?,pending=pending+?,failed=failed+?,
            outer_count=outer_count+?,inner_count=inner_count+?,atomic_count=atomic_count+?,bundle_count=bundle_count+?,positive_count=positive_count+? WHERE address=?`)
            .run(now, observation.signature, observation.signature, observation.slot, Number(executed && !old?.executed),
              old ? Number(!executed) - Number(!old.executed) : Number(!executed), Number(observation.failed && observation.executed && !old?.failed),
              outer - (old?.outer_count ?? 0), inner - (old?.inner_count ?? 0), Number(pAtomic && !old?.atomic_route), Number(bundle && !old?.bundle_hint), Number(positive && !old?.closed_positive), program.address)
          if (observation.executed && !observation.failed && !builtin) {
            const shapes = this.sampleKeys.get(program.address) ?? new Set<string>()
            for (const sample of program.samples) {
              const bytes = Buffer.from(sample.data, 'base64'), shape = `${bytes.subarray(0, 8).toString('hex')}:${bytes.length}:${sample.accounts.length}:${sample.inner}`
              if (shapes.has(shape) || shapes.size >= 64) continue
              this.sql('INSERT OR IGNORE INTO program_samples(address,shape,sample) VALUES(?,?,?)').run(program.address, shape, JSON.stringify(sample))
              shapes.add(shape)
            }
            this.sampleKeys.set(program.address, shapes)
            this.sql('UPDATE programs SET sample_count=? WHERE address=?').run(shapes.size, program.address)
          }
          const current = this.raw(program.address)!
          const priority = Math.log2(1 + current.transactions) + current.atomic_count * 4 + current.bundle_count * 2 + current.positive_count * 3
          this.sql('UPDATE programs SET priority=? WHERE address=?').run(priority, program.address)
          // New observations with new selectors retry an incomplete interface.
          if (current.state === 'blocked' && current.reason?.includes('recent successful') && !observation.failed && observation.executed)
            this.sql("UPDATE programs SET state='retrying',phase='New successful receipt; learning queued',next_attempt=? WHERE address=?").run(now, program.address)
          this.dirty.add(program.address)
        }
        if (observation.executed && !observation.failed) for (const edge of observation.edges) {
          if (this.sql('INSERT OR IGNORE INTO program_edge_receipts(signature,caller,callee,attribution) VALUES(?,?,?,?)')
            .run(observation.signature, edge.caller, edge.callee, edge.attribution).changes) {
            this.sql(`INSERT INTO program_edges(caller,callee,attribution,transactions,last_ts) VALUES(?,?,?,1,?)
              ON CONFLICT(caller,callee,attribution) DO UPDATE SET transactions=transactions+1,last_ts=excluded.last_ts`).run(edge.caller, edge.callee, edge.attribution, now)
          }
        }
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  source(lane: string, connected: boolean, ts?: number) {
    this.sql(`INSERT INTO program_sources(lane,connected,last_ts) VALUES(?,?,?) ON CONFLICT(lane) DO UPDATE SET connected=excluded.connected`)
      .run(lane, Number(connected), ts ?? null)
  }
  private record(row: Row): ProgramRecord {
    return { address: row.address, name: row.name, infrastructure: !!row.infrastructure, known: !!row.known,
      firstSeenTs: row.first_ts, lastSeenTs: row.last_ts, firstSignature: row.first_sig, lastSignature: row.last_sig, lastSlot: row.last_slot,
      transactions: row.transactions, pendingTransactions: row.pending, failedTransactions: row.failed, outerInvocations: row.outer_count,
      innerInvocations: row.inner_count, atomicTransactions: row.atomic_count, bundleHintTransactions: row.bundle_count, closedPositiveTransactions: row.positive_count,
      state: row.state, phase: row.phase, stateSinceTs: row.state_ts, nextAttemptTs: row.next_attempt, attempts: row.attempts,
      idlSource: row.idl_source, idlHash: row.idl_hash, instructionCount: row.instruction_count, sampleCount: row.sample_count,
      validation: row.validation ? JSON.parse(row.validation) : null, reason: row.reason, priority: row.priority }
  }
  private activities(address?: string, limit = 60): ProgramActivity[] {
    return (this.sql(`SELECT * FROM program_activity ${address ? 'WHERE address=?' : ''} ORDER BY id DESC LIMIT ?`).all(...(address ? [address, limit] : [limit])) as Row[])
      .map(row => ({ id: row.id, address: row.address, kind: row.kind, state: row.state, message: row.message, ts: row.ts, signature: row.signature }))
  }
  totals(): ProgramTotals {
    const rows = this.sql(`SELECT COUNT(*) programs,SUM(known=0) unseen,SUM(state IN ('queued','retrying')) queued,
      SUM(state IN ('checking','learning','validating')) active,SUM(state='ready') ready,SUM(state='partial') partial,SUM(state='blocked') blocked FROM programs`).get() as Row
    const throughput = this.sql('SELECT COALESCE(SUM(transactions),0) transactions,COALESCE(SUM(invocations),0) invocations,COALESCE(SUM(atomic_route),0) atomicTransactions FROM program_buckets').get() as Row
    const last = this.sql('SELECT MAX(last_ts) ts FROM program_sources').get() as Row
    return { programs: rows.programs, unseen: rows.unseen ?? 0, queued: rows.queued ?? 0, active: rows.active ?? 0, ready: rows.ready ?? 0, partial: rows.partial ?? 0,
      blocked: rows.blocked ?? 0, transactions: throughput.transactions, invocations: throughput.invocations, atomicTransactions: throughput.atomicTransactions, lastObservationTs: last.ts }
  }
  coverage(): ProgramCoverage {
    return { enabled: this.enabled, scope: 'Every transaction delivered to FTL’s configured Solana lanes, mint stream and replay',
      sources: (this.sql('SELECT * FROM program_sources').all() as Row[]).map(row => ({ lane: row.lane, connected: !!row.connected && this.now() - (row.last_ts ?? 0) < 30_000, lastTs: row.last_ts, transactions: row.transactions })),
      composer: this.composerHealth,
      note: 'Net-new means first seen by this index. Usage is within FTL’s observed traffic, not chain-wide. Atomic routes are same-transaction swap paths. Jito tips are bundle hints; bundle membership and profit guarantees remain unproven.' }
  }
  private buckets(hours = 1): ProgramBucket[] {
    const width = hours <= 1 ? MINUTE : hours <= 6 ? 5 * MINUTE : 15 * MINUTE
    const end = Math.floor(this.now() / width) * width, start = end - (Math.max(1, Math.min(168, hours)) * 60 * MINUTE) + width
    const rows = this.sql(`SELECT CAST(ts/? AS INTEGER)*? ts,SUM(discoveries) discoveries,SUM(transactions) transactions,SUM(invocations) invocations,SUM(learned) learned,SUM(atomic_route) atomic FROM program_buckets WHERE ts>=? GROUP BY 1 ORDER BY 1`)
      .all(width, width, start) as ProgramBucket[]
    const byTs = new Map(rows.map(row => [row.ts, row]))
    return Array.from({ length: Math.floor((end - start) / width) + 1 }, (_, i) => byTs.get(start + i * width) ?? { ts: start + i * width, discoveries: 0, transactions: 0, invocations: 0, learned: 0, atomic: 0 })
  }
  private sequence(): number { return (this.sql("SELECT value FROM program_index_meta WHERE key='sequence'").get() as Row).value }
  list(options: { search?: string; filter?: string; sort?: string; offset?: number; limit?: number; hours?: number } = {}): ProgramList {
    const where: string[] = [], args: (string | number)[] = []
    if (options.filter !== 'all') where.push('infrastructure=0')
    if (options.filter === 'unseen') where.push('known=0')
    if (options.filter === 'atomic') where.push('(atomic_count>0 OR bundle_count>0)')
    if (options.filter === 'interfaces') where.push('idl_hash IS NOT NULL')
    if (options.filter === 'working') where.push("state IN ('queued','checking','learning','validating','retrying','blocked')")
    if (options.search) { where.push('(address LIKE ? OR name LIKE ?)'); const search = `%${options.search.slice(0, 80).replace(/[%_]/g, '')}%`; args.push(search, search) }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const sort = options.sort === 'usage' ? 'transactions DESC,address' : options.sort === 'priority' ? 'known ASC,priority DESC,address' : 'first_ts DESC,address'
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 75))), offset = Math.max(0, Math.floor(options.offset ?? 0))
    const total = (this.sql(`SELECT COUNT(*) n FROM programs ${clause}`).get(...args) as Row).n
    return { items: (this.sql(`SELECT * FROM programs ${clause} ORDER BY ${sort} LIMIT ? OFFSET ?`).all(...args, limit, offset) as Row[]).map(row => this.record(row)),
      total, offset, hasMore: offset + limit < total, sequence: this.sequence(), totals: this.totals(), buckets: this.buckets(options.hours), activity: this.activities(), coverage: this.coverage() }
  }
  detail(address: string): ProgramDetail | null {
    const row = this.raw(address)
    if (!row) return null
    const stored = this.sql('SELECT body FROM program_idls WHERE address=?').get(address) as Row | undefined
    const idl = stored ? JSON.parse(stored.body) : null
    return { program: this.record(row), idlAvailable: !!idl, evidence: idl?.evidence ?? null, caveats: idl?.caveats ?? [], activity: this.activities(address),
      instructions: (idl?.instructions ?? []).map((ix: any) => { const accounts = flatten(ix.accounts); return { name: ix.name, discriminator: discriminator(ix), accounts: accounts.length,
        observedIn: ix.observedIn ?? null, argumentBytes: ix.argBytes ?? null, argsDecoded: !(ix.argsHex?.some((hex: string) => hex.length) || ix.argBytes?.some((n: number) => n > 0)) || !!ix.args?.length,
        nameSource: ix.nameSource ?? null, pdaAccounts: accounts.filter(account => account.pda).length, fixedAccounts: accounts.filter(account => account.address).length } }),
      relationships: (this.sql(`SELECT e.*,p.name FROM program_edges e LEFT JOIN programs p ON p.address=CASE WHEN e.caller=? THEN e.callee ELSE e.caller END
        WHERE e.caller=? OR e.callee=? ORDER BY e.transactions DESC LIMIT 100`).all(address, address, address) as Row[])
        .map(edge => ({ address: edge.caller === address ? edge.callee : edge.caller, name: edge.name, direction: edge.caller === address ? 'calls' : 'calledBy', attribution: edge.attribution, transactions: edge.transactions, lastTs: edge.last_ts })),
      receipts: (this.sql('SELECT * FROM program_receipts WHERE address=? ORDER BY ts DESC LIMIT 30').all(address) as Row[]).map(receipt => ({ signature: receipt.signature, slot: receipt.slot, ts: receipt.ts,
        version: receipt.version === 'legacy' ? 'legacy' : Number(receipt.version) as 0 | 1, outer: receipt.outer_count, inner: receipt.inner_count, atomic: !!receipt.atomic_route,
        bundleHint: !!receipt.bundle_hint, closedPositive: !!receipt.closed_positive, failed: !!receipt.failed, finalized: !!receipt.finalized })) }
  }
  idl(address: string): string | null { return (this.sql('SELECT body FROM program_idls WHERE address=?').get(address) as Row | undefined)?.body ?? null }

  refreshInterfaces() {
    for (const row of this.sql("SELECT * FROM programs WHERE idl_source IN ('published','composer','published+composer') AND state IN ('partial','ready')").all() as Row[]) {
      const body = this.idl(row.address)
      if (!body) continue
      const idl = JSON.parse(body)
      const samples = (this.sql('SELECT sample FROM program_samples WHERE address=?').all(row.address) as Row[]).map(item => JSON.parse(item.sample))
      const validation = validateInterface(idl, row.address, samples)
      const state = validation.mismatched ? 'partial' : validation.tested ? 'ready' : 'partial'
      const phase = `${validation.matched}/${validation.tested} observed instruction shapes match${validation.runtimeEvents ? ` · ${validation.runtimeEvents} runtime events` : ''}${validation.mismatched ? ' · refining' : ''}`
      this.sql('UPDATE programs SET state=?,phase=?,validation=?,reason=?,next_attempt=CASE WHEN ? THEN COALESCE(next_attempt,?) ELSE NULL END WHERE address=?')
        .run(state, phase, JSON.stringify(validation), validation.mismatched ? `${validation.mismatched} observed shapes need additional reconstruction` : null,
          Number(!!validation.mismatched), this.now() + 5 * MINUTE, row.address)
      this.dirty.add(row.address)
    }
    this.flush()
  }

  flush(force = false) {
    if (!this.dirty.size && !this.activityDirty.length && !force) return
    this.sql("UPDATE program_index_meta SET value=value+1 WHERE key='sequence'").run()
    // If updates exceed one message, clients refresh the durable ordered list.
    const reset = this.dirty.size > 200
    const records = [...this.dirty].slice(0, 200).flatMap(address => { const row = this.raw(address); return row ? [this.record(row)] : [] })
    const activity = this.activityDirty.splice(0).slice(-100)
    this.dirty.clear()
    this.onUpdate?.({ t: 'programs', sequence: this.sequence(), reset, records, activity, totals: this.totals(), buckets: this.buckets(), coverage: this.coverage(), ts: this.now() })
  }

  private async composer(route: string, timeout = 30_000): Promise<any> {
    if (!this.composerUrl) throw new ComposerError(503, 'Composer URL is not configured')
    let response: Response
    try { response = await this.fetcher(this.composerUrl + route, { signal: AbortSignal.timeout(timeout) }) }
    catch { throw new ComposerError(503, 'Composer request timed out or could not connect') }
    let data: any
    try { data = await response.json() } catch { throw new ComposerError(502, 'Composer returned an invalid JSON response') }
    if (!response.ok) {
      // Store only known actionable error classes, never an upstream body or key.
      const message = typeof data?.error === 'string' ? data.error : ''
      if (/no published IDL account/.test(message)) throw new ComposerError(404, 'No published on-chain IDL; reconstructing from receipts')
      if (/none contained a successful instruction|0 transactions fetched/.test(message)) throw new ComposerError(422, 'Composer could not read recent successful instructions (transaction-version/CPI coverage may be incomplete)')
      throw new ComposerError(response.status, `Composer HTTP ${response.status}`)
    }
    return data
  }
  async checkHealth() {
    try { const response = await this.composer('/health', 8_000); this.composerHealth = { url: this.composerUrl ?? null, connected: response.ok === true, checkedTs: this.now(), reason: response.ok ? null : 'Composer health did not report ready' } }
    catch (error) { this.composerHealth = { url: this.composerUrl ?? null, connected: false, checkedTs: this.now(), reason: (error as Error).message } }
    this.flush(true)
  }
  async next(): Promise<string | null> {
    if (this.working || !this.enabled || !this.composerUrl) return null
    const refinementTurn = this.completedJobs % 4 === 3
    const row = this.sql(`SELECT * FROM programs WHERE known=0 AND transactions>failed AND
      (state IN ('queued','retrying') OR (state='partial' AND next_attempt IS NOT NULL)) AND (next_attempt IS NULL OR next_attempt<=?)
      ORDER BY CASE WHEN state='partial' THEN ? ELSE ? END DESC,priority DESC,first_ts ASC LIMIT 1`)
      .get(this.now(), refinementTurn ? 1 : 0, refinementTurn ? 0 : 1) as Row | undefined
    if (!row) return null
    this.working = true
    const address = row.address
    this.sql('UPDATE programs SET attempts=attempts+1 WHERE address=?').run(address)
    try {
      this.transition(address, 'checking', 'Checking for a published on-chain IDL')
      let idl: any, source: 'published' | 'composer' | 'published+composer' = 'published'
      try { idl = await this.composer(`/idl/${address}`) }
      catch (error) {
        if (!(error instanceof ComposerError) || error.status !== 404) throw error
        source = 'composer'
        this.transition(address, 'learning', 'Composer is reconstructing instruction shapes and PDA seeds')
        const parameters = row.idl_hash ? '?refresh=true&signatures=1000&seedBudget=2000000' : '?signatures=250&seedBudget=2000000'
        idl = await this.composer(`/learn/${address}${parameters}`, 15 * 60_000)
      }
      this.composerHealth = { url: this.composerUrl, connected: true, checkedTs: this.now(), reason: null }
      this.transition(address, 'validating', 'Checking selectors, account positions and payload lengths against observed receipts')
      const samples = (this.sql('SELECT sample FROM program_samples WHERE address=?').all(address) as Row[]).map(sample => JSON.parse(sample.sample))
      let validation = validateInterface(idl, address, samples)
      if (source === 'published' && validation.mismatched) {
        this.transition(address, 'learning', 'Composer is learning instructions absent from the published IDL')
        try {
          const supplement = await this.composer(`/learn/${address}?signatures=250&seedBudget=2000000`, 15 * 60_000)
          idl = mergeLearnedInstructions(idl, supplement, samples)
          if (idl.evidence?.composerExtensions) source = 'published+composer'
          validation = validateInterface(idl, address, samples)
        } catch {}
      }
      const body = JSON.stringify(idl), hash = createHash('sha256').update(body).digest('hex')
      const state: ProgramState = validation.mismatched || !validation.tested ? 'partial' : 'ready'
      const priorIdl = !!row.idl_hash
      this.db.exec('BEGIN')
      try {
        this.sql(`INSERT INTO program_idls(address,body,source,hash,learned_ts) VALUES(?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET body=excluded.body,source=excluded.source,hash=excluded.hash,learned_ts=excluded.learned_ts`)
          .run(address, body, source, hash, this.now())
        this.sql(`UPDATE programs SET idl_source=?,idl_hash=?,instruction_count=?,validation=?,name=COALESCE(name,?),next_attempt=NULL WHERE address=?`)
          .run(source, hash, idl.instructions.length, JSON.stringify(validation), source === 'published' ? idl.metadata?.name ?? idl.name ?? null : null, address)
        if (!priorIdl) this.bucket(this.now(), 0, 0, 0, 1)
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
      const phase = `${validation.matched}/${validation.tested} observed instruction shapes match${validation.runtimeEvents ? ` · ${validation.runtimeEvents} runtime events` : ''}${validation.mismatched ? ' · refining' : ''}`
      this.transition(address, state, phase, validation.mismatched ? `${validation.mismatched} observed shapes need additional reconstruction` : null,
        validation.mismatched ? this.now() + 5 * MINUTE : null)
      this.activity(address, 'interface', state, `${source === 'composer' ? 'Composer learned' : 'Published'} IDL indexed with ${idl.instructions.length} instruction shapes`)
    } catch (error) {
      const reason = error instanceof ComposerError ? error.message : 'Interface validation failed'
      const attempts = row.attempts + 1
      const permanent = error instanceof ComposerError && [400, 401, 402, 403].includes(error.status)
      const nextAttempt = permanent ? null : this.now() + Math.min(30 * MINUTE, 10_000 * 2 ** Math.min(attempts, 8))
      this.transition(address, permanent ? 'blocked' : 'retrying', permanent ? 'Composer job blocked' : 'Composer job will retry', reason, nextAttempt)
      this.composerHealth = { url: this.composerUrl, connected: error instanceof ComposerError && error.status < 500, checkedTs: this.now(), reason }
    } finally { this.working = false; this.completedJobs++; this.flush() }
    return address
  }
}
