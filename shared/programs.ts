// Discovery is first-seen by this index, not a claim of deployment time or
// chain-wide usage. Learned interfaces retain the Composer's provenance.
export type ProgramState = 'queued' | 'checking' | 'learning' | 'validating' | 'ready' | 'partial' | 'retrying' | 'blocked' | 'known'
export interface ProgramRecord {
  address: string
  name: string | null
  infrastructure: boolean
  known: boolean
  firstSeenTs: number
  lastSeenTs: number
  firstSignature: string | null
  lastSignature: string | null
  lastSlot: number | null
  transactions: number
  pendingTransactions: number
  failedTransactions: number
  outerInvocations: number
  innerInvocations: number
  atomicTransactions: number
  bundleHintTransactions: number
  closedPositiveTransactions: number
  state: ProgramState
  phase: string
  stateSinceTs: number
  nextAttemptTs: number | null
  attempts: number
  idlSource: 'shipped' | 'published' | 'composer' | 'published+composer' | null
  idlHash: string | null
  instructionCount: number
  sampleCount: number
  validation: { matched: number; tested: number; mismatched: number; unresolved: number; runtimeEvents?: number; missingData?: number } | null
  reason: string | null
  priority: number
}
export interface ProgramActivity {
  id: number
  address: string
  kind: 'discovered' | 'progress' | 'interface' | 'retry'
  state: ProgramState
  message: string
  ts: number
  signature: string | null
}
export interface ProgramBucket {
  ts: number
  discoveries: number
  transactions: number
  invocations: number
  learned: number
  atomic: number
}
export interface ProgramTotals {
  programs: number
  unseen: number
  queued: number
  active: number
  ready: number
  partial: number
  blocked: number
  transactions: number
  invocations: number
  atomicTransactions: number
  lastObservationTs: number | null
}
export interface ProgramCoverage {
  enabled: boolean
  scope: string
  sources: { lane: string; connected: boolean; lastTs: number | null; transactions: number }[]
  composer: { url: string | null; connected: boolean | null; checkedTs: number | null; reason: string | null }
  note: string
}
export interface ProgramList {
  items: ProgramRecord[]
  total: number
  offset: number
  hasMore: boolean
  sequence: number
  totals: ProgramTotals
  buckets: ProgramBucket[]
  activity: ProgramActivity[]
  coverage: ProgramCoverage
}
export interface ProgramInstruction {
  name: string
  discriminator: number[]
  accounts: number
  observedIn: number | null
  argumentBytes: number[] | null
  argsDecoded: boolean
  nameSource: string | null
  pdaAccounts: number
  fixedAccounts: number
}
export interface ProgramDetail {
  program: ProgramRecord
  instructions: ProgramInstruction[]
  activity: ProgramActivity[]
  relationships: { address: string; name: string | null; direction: 'calls' | 'calledBy'; attribution: 'direct' | 'outer'; transactions: number; lastTs: number }[]
  receipts: { signature: string; slot: number; ts: number; version: 'legacy' | 0 | 1; outer: number; inner: number; atomic: boolean; bundleHint: boolean; closedPositive: boolean; failed: boolean; finalized: boolean }[]
  evidence: Record<string, unknown> | null
  caveats: string[]
  idlAvailable: boolean
}
export interface ProgramUpdate {
  t: 'programs'
  sequence: number
  reset: boolean
  records: ProgramRecord[]
  activity: ProgramActivity[]
  totals: ProgramTotals
  buckets: ProgramBucket[]
  coverage: ProgramCoverage
  ts: number
}
