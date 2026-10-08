import type { ProgramBucket, ProgramList, ProgramRecord, ProgramUpdate } from '../../../shared/programs'

export type ProgramMode = 'new' | 'usage' | 'atomic' | 'interfaces' | 'working'
export const programQuery = (mode: ProgramMode) => ({ filter: mode === 'new' || mode === 'usage' ? 'unseen' : mode,
  sort: mode === 'usage' ? 'usage' : mode === 'atomic' || mode === 'working' ? 'priority' : 'new' })
export function matchesProgram(program: ProgramRecord, mode: ProgramMode, search = '') {
  if (program.infrastructure) return false
  if ((mode === 'new' || mode === 'usage') && program.known) return false
  if (mode === 'atomic' && !program.atomicTransactions && !program.bundleHintTransactions) return false
  if (mode === 'interfaces' && !program.idlHash) return false
  if (mode === 'working' && !['queued', 'checking', 'learning', 'validating', 'retrying', 'blocked'].includes(program.state)) return false
  const text = search.toLowerCase()
  return !text || program.address.toLowerCase().includes(text) || !!program.name?.toLowerCase().includes(text)
}
export function sortPrograms(records: ProgramRecord[], mode: ProgramMode) {
  return [...records].sort((a, b) => mode === 'usage' ? b.transactions - a.transactions || a.address.localeCompare(b.address)
    : mode === 'atomic' || mode === 'working' ? Number(a.known) - Number(b.known) || b.priority - a.priority || a.address.localeCompare(b.address)
      : b.firstSeenTs - a.firstSeenTs || a.address.localeCompare(b.address))
}
export function mergeProgramBuckets(previous: ProgramBucket[], incoming: ProgramBucket[], hours: number, now: number): ProgramBucket[] {
  const minute = 60_000, width = hours <= 1 ? minute : hours <= 6 ? 5 * minute : 15 * minute
  const end = Math.floor(now / width) * width, start = end - hours * 60 * minute + width
  const byTs = new Map(previous.map(bucket => [bucket.ts, bucket]))
  const grouped = new Map<number, ProgramBucket>()
  for (const bucket of incoming) {
    const ts = Math.floor(bucket.ts / width) * width
    const aggregate = grouped.get(ts) ?? { ts, discoveries: 0, transactions: 0, invocations: 0, learned: 0, atomic: 0 }
    for (const key of ['discoveries', 'transactions', 'invocations', 'learned', 'atomic'] as const) aggregate[key] += bucket[key]
    grouped.set(ts, aggregate)
  }
  // The oldest live minute can bisect a coarse historical bucket. Do not erase
  // its earlier minutes with a partial replacement.
  const firstComplete = incoming.length ? Math.ceil(incoming[0].ts / width) * width : Infinity
  for (const [ts, bucket] of grouped) if (ts >= firstComplete) byTs.set(ts, bucket)
  return Array.from({ length: Math.round((end - start) / width) + 1 }, (_, i) => byTs.get(start + i * width) ??
    { ts: start + i * width, discoveries: 0, transactions: 0, invocations: 0, learned: 0, atomic: 0 })
}
export function mergeProgramUpdate(previous: ProgramList, update: ProgramUpdate, mode: ProgramMode, search: string, hours: number): ProgramList {
  if (update.sequence <= previous.sequence) return previous
  const records = new Map(previous.items.map(program => [program.address, program]))
  let added = 0, removed = 0
  for (const program of update.records) {
    const present = records.has(program.address), matches = matchesProgram(program, mode, search)
    if (matches) { records.set(program.address, program); if (!present) added++ }
    else if (records.delete(program.address)) removed++
  }
  const activity = new Map([...previous.activity, ...update.activity].map(event => [event.id, event]))
  const total = mode === 'new' || mode === 'usage' ? search ? Math.max(0, previous.total + added - removed) : update.totals.unseen
    : Math.max(0, previous.total + added - removed)
  return { ...previous, items: sortPrograms([...records.values()], mode).slice(0, 300), total, sequence: update.sequence,
    totals: update.totals, coverage: update.coverage, activity: [...activity.values()].sort((a, b) => b.id - a.id).slice(0, 80),
    buckets: mergeProgramBuckets(previous.buckets, update.buckets, hours, update.ts) }
}
export const programStateLabel: Record<ProgramRecord['state'], string> = {
  queued: 'Queued', checking: 'IDL lookup', learning: 'Learning', validating: 'Validating', ready: 'IDL indexed',
  partial: 'Refining coverage', retrying: 'Retry scheduled', blocked: 'Blocked', known: 'Known IDL',
}
