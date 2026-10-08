// Normalize all invoked programs before FTL's venue-specific instruction gate.
// No RPC and no model invocation happen on this hot path.
import bs58 from 'bs58'
import { type NIx, type NTx, parseWire, WSOL } from './decode.ts'
import { looksLikeSwap, USDC, USDT } from './swaps.ts'
import { programIds } from './programs.ts'

export const INFRASTRUCTURE = new Map([
  ['11111111111111111111111111111111', 'System'],
  ['ComputeBudget111111111111111111111111111111', 'Compute budget'],
  ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'SPL Token'],
  ['TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'Token-2022'],
  ['ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'Associated token'],
  ['MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo'],
  ['Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo', 'Memo v1'],
  ['Vote111111111111111111111111111111111111111', 'Vote'],
  ['AddressLookupTab1e1111111111111111111111111', 'Address lookup table'],
])
const TIP_ACCOUNTS = new Set([
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY', 'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh', 'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL', '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
])
const validKeys = new Map<string, boolean>()
export const validProgram = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false
  const cached = validKeys.get(value)
  if (cached !== undefined) return cached
  let valid = false
  try { valid = bs58.decode(value).length === 32 } catch {}
  validKeys.set(value, valid)
  if (validKeys.size > 10_000) validKeys.delete(validKeys.keys().next().value!)
  return valid
}
const shipped = new Set(programIds)
const capturedShapes = new Map<string, Set<string>>()
export interface InstructionSample {
  signature: string; n: string; data: string
  accounts: { address: string; signer: boolean | null; writable: boolean | null }[]
  inner: boolean
  rawDataKnown?: boolean
}
export interface ProgramObservation {
  signature: string; slot: number; ts: number; lane: string
  version: 'legacy' | 0 | 1; executed: boolean; failed: boolean; finalized: boolean
  bundleHint: boolean; closedPositive: boolean
  programs: { address: string; outer: number; inner: number; atomic: boolean; samples: InstructionSample[] }[]
  edges: { caller: string; callee: string; attribution: 'direct' | 'outer' }[]
}

// A positive closed-inventory receipt is an observed balance pattern, not a
// verified profit assertion. Rent refunds and third-party transfers can affect it.
function closedPositive(tx: NTx): boolean {
  if (tx.failed || !tx.pre || !tx.post || !tx.lamports || !tx.keys[0]) return false
  const wallet = tx.keys[0], delta = new Map<string, bigint>()
  for (const balance of tx.pre) if (balance.owner === wallet) delta.set(balance.mint, (delta.get(balance.mint) ?? 0n) - balance.amount)
  for (const balance of tx.post) if (balance.owner === wallet) delta.set(balance.mint, (delta.get(balance.mint) ?? 0n) + balance.amount)
  const native = (tx.lamports.post[0] ?? 0n) - (tx.lamports.pre[0] ?? 0n)
  delta.set(WSOL, (delta.get(WSOL) ?? 0n) + native)
  const moved = [...delta].filter(([, raw]) => raw !== 0n)
  return moved.length === 1 && [WSOL, USDC, USDT].includes(moved[0][0]) && moved[0][1] > 0n
}

export function observePrograms(tx: NTx, lane: string, ts = Date.now(), executed = true, finalized = false,
  options: { resolveKey?: (index: number) => string | null; flagAt?: (index: number) => { signer: boolean; writable: boolean }; rawMeta?: any } = {}): ProgramObservation | null {
  if (!tx.sig || !Number.isSafeInteger(tx.slot) || tx.slot < 0) return null
  const programs = new Map<string, ProgramObservation['programs'][number]>()
  const top = new Map(tx.ixs.filter(ix => !ix.n.includes('.')).map(ix => [ix.n, ix]))
  const swapRoots = new Map<string, number>()
  const edges = new Map<string, ProgramObservation['edges'][number]>()
  const parents = new Map<string, Map<number, string>>()
  let bundleHint = false
  const keyAt = (index: number) => tx.keys[index] ?? options.resolveKey?.(index) ?? null
  for (const ix of tx.ixs) {
    if (!validProgram(ix.prog)) continue
    const root = ix.n.split('.')[0], inner = ix.n.includes('.')
    if (looksLikeSwap(ix.prog, ix.data)) swapRoots.set(root, (swapRoots.get(root) ?? 0) + 1)
    if (ix.prog === '11111111111111111111111111111111' && ix.data.length === 12 && ix.accts.length >= 2) {
      const data = Buffer.from(ix.data), to = keyAt(ix.accts[1])
      if (data.readUInt32LE(0) === 2 && data.readBigUInt64LE(4) >= 1000n && to && TIP_ACCOUNTS.has(to)) bundleHint = true
    }
    let found = programs.get(ix.prog)
    if (!found) { found = { address: ix.prog, outer: 0, inner: 0, atomic: false, samples: [] }; programs.set(ix.prog, found) }
    found[inner ? 'inner' : 'outer']++
    // Keep representative payload/account shapes, not every token transfer.
    if (!INFRASTRUCTURE.has(ix.prog) && !shipped.has(ix.prog) && ix.rawDataKnown !== false && found.samples.length < 3 && ix.data.length <= 4096) {
      // Send each representative shape once per lane process. Counts still
      // include *every* invocation; full account arrays on every transaction
      // would otherwise dominate structured-clone traffic at mainnet rates.
      const bytes = Buffer.from(ix.data), shape = `${bytes.subarray(0, 8).toString('hex')}:${bytes.length}:${ix.accts.length}:${inner}`
      const shapes = capturedShapes.get(ix.prog) ?? new Set<string>()
      if (!shapes.has(shape) && shapes.size < 64 && ix.accts.every(i => !!keyAt(i))) {
        shapes.add(shape); capturedShapes.set(ix.prog, shapes)
        found.samples.push({ signature: tx.sig, n: ix.n, data: bytes.toString('base64'), inner,
          accounts: ix.accts.map(i => ({ address: keyAt(i)!, signer: tx.keyFlags?.[i]?.signer ?? options.flagAt?.(i)?.signer ?? null, writable: tx.keyFlags?.[i]?.writable ?? options.flagAt?.(i)?.writable ?? null })) })
      }
    }
    if (inner) {
      const outer = top.get(root)?.prog
      let stack = parents.get(root)
      if (!stack) { stack = new Map([[1, outer ?? '']]); parents.set(root, stack) }
      const height = ix.stackHeight
      const direct = Number.isSafeInteger(height) && height! >= 2 ? stack.get(height! - 1) : undefined
      const caller = direct || outer
      if (caller && validProgram(caller) && caller !== ix.prog) {
        const attribution = direct ? 'direct' : 'outer'
        edges.set(`${caller}:${ix.prog}:${attribution}`, { caller, callee: ix.prog, attribution })
      }
      if (Number.isSafeInteger(height) && height! >= 2) {
        for (const depth of stack.keys()) if (depth >= height!) stack.delete(depth)
        stack.set(height!, ix.prog)
      }
    }
  }
  if (!programs.size) return null
  const totalSwaps = [...swapRoots.values()].reduce((a, b) => a + b, 0)
  for (const [root, count] of swapRoots) if (count >= 2) {
    for (const ix of tx.ixs) if (ix.n.split('.')[0] === root && programs.has(ix.prog)) programs.get(ix.prog)!.atomic = true
  }
  // Multiple outer swap instructions are also atomic within the same tx.
  if (totalSwaps >= 2) for (const ix of tx.ixs) if (!ix.n.includes('.') && looksLikeSwap(ix.prog, ix.data)) programs.get(ix.prog)!.atomic = true
  if (totalSwaps >= 2 && options.rawMeta && !tx.failed) {
    tx.keys[0] = keyAt(0)
    const meta = options.rawMeta
    const balances = (items: any[]) => items.map(b => ({ idx: b.accountIndex, mint: b.mint, owner: b.owner ?? '', amount: BigInt(b.uiTokenAmount?.amount ?? '0'), decimals: b.uiTokenAmount?.decimals ?? 0 }))
    if (Array.isArray(meta.preTokenBalances) && Array.isArray(meta.postTokenBalances)) { tx.pre = balances(meta.preTokenBalances); tx.post = balances(meta.postTokenBalances) }
    if (Array.isArray(meta.preBalances) && Array.isArray(meta.postBalances)) tx.lamports = { pre: meta.preBalances.map(BigInt), post: meta.postBalances.map(BigInt), fee: BigInt(meta.fee ?? 0) }
  }
  return { signature: tx.sig, slot: tx.slot, ts, lane, version: tx.version ?? 'legacy', executed,
    failed: tx.failed === true, finalized, bundleHint, closedPositive: totalSwaps >= 2 && closedPositive(tx),
    programs: [...programs.values()], edges: [...edges.values()] }
}

const programAddresses = new Map<string, string>()
// Finalized mint traffic is often transfer-only. Resolve the small set of
// *program* keys first, and resolve other accounts only for a new sample/tip.
// This avoids base58-encoding every account of every transaction on the API
// thread, while still observing every outer and inner program in that traffic.
export function observeRawPrograms(info: any, slot: number, lane: string, ts = Date.now(), finalized = false): ProgramObservation | null {
  const message = info?.transaction?.message
  if (!message || !info.signature) return null
  const meta = info.meta
  const raw: Uint8Array[] = [...(message.accountKeys ?? []), ...(meta?.loadedWritableAddresses ?? []), ...(meta?.loadedReadonlyAddresses ?? [])]
  const keys: (string | null)[] = new Array(raw.length).fill(null)
  const resolveKey = (index: number): string | null => {
    if (keys[index]) return keys[index]
    const bytes = raw[index]
    if (!bytes || bytes.length !== 32) return null
    return keys[index] = bs58.encode(bytes)
  }
  const programAt = (index: number) => {
    const bytes = raw[index]
    if (!bytes || bytes.length !== 32) return ''
    const hex = Buffer.from(bytes).toString('hex')
    let program = programAddresses.get(hex)
    if (!program) { program = bs58.encode(bytes); programAddresses.set(hex, program); if (programAddresses.size > 10_000) programAddresses.delete(programAddresses.keys().next().value!) }
    keys[index] = program
    return program
  }
  const ixs: NIx[] = (message.instructions ?? []).map((ix: any, n: number) => ({ prog: programAt(ix.programIdIndex), accts: Array.from(ix.accounts ?? []), data: ix.data ?? new Uint8Array(), n: String(n) }))
  for (const group of meta?.innerInstructions ?? []) for (const [n, ix] of group.instructions.entries())
    ixs.push({ prog: programAt(ix.programIdIndex), accts: Array.from(ix.accounts ?? []), data: ix.data ?? new Uint8Array(), n: `${group.index}.${n}`, stackHeight: ix.stackHeight ?? undefined })
  const header = message.header
  const flagAt = header ? (i: number) => ({ signer: i < header.numRequiredSignatures,
    writable: i < header.numRequiredSignatures ? i < header.numRequiredSignatures - header.numReadonlySignedAccounts
      : i < message.accountKeys.length ? i < message.accountKeys.length - header.numReadonlyUnsignedAccounts
        : i < message.accountKeys.length + (meta?.loadedWritableAddresses?.length ?? 0) }) : undefined
  return observePrograms({ sig: bs58.encode(info.signature), slot, keys, ixs, failed: !!meta?.err,
    version: message.config != null ? 1 : message.versioned ? 0 : 'legacy' }, lane, ts, true, finalized, { resolveKey, flagAt, rawMeta: meta })
}

export function rpcDiscoveryTransaction(row: any, signature?: string): NTx {
  if (!row?.transaction || !row.meta || !Number.isSafeInteger(row.slot)) throw new Error('Transaction metadata unavailable')
  let message = row.transaction.message, sig = signature ?? row.transaction.signatures?.[0], wire
  if (Array.isArray(row.transaction)) {
    wire = parseWire(Buffer.from(row.transaction[0], 'base64'))
    sig ??= bs58.encode(wire.sig)
    message = { accountKeys: wire.keys.map(k => bs58.encode(k)), instructions: wire.ixs.map(ix => ({ programIdIndex: ix.prog, accounts: ix.accts, data: bs58.encode(ix.data) })) }
  }
  if (!message || !Array.isArray(message.accountKeys) || !Array.isArray(message.instructions)) throw new Error('Raw instruction data unavailable')
  const keys = [...message.accountKeys, ...(row.meta.loadedAddresses?.writable ?? []), ...(row.meta.loadedAddresses?.readonly ?? [])]
  if (!keys.every(validProgram)) throw new Error('Transaction has unresolved addresses')
  const instruction = (ix: any, n: string): NIx => {
    if (!keys[ix.programIdIndex] || !Array.isArray(ix.accounts) || !ix.accounts.every((i: number) => Number.isSafeInteger(i) && i >= 0 && i < keys.length) || typeof ix.data !== 'string')
      throw new Error('Transaction has unresolved instruction accounts')
    return { prog: keys[ix.programIdIndex], accts: ix.accounts, data: bs58.decode(ix.data), n, stackHeight: ix.stackHeight ?? undefined }
  }
  const ixs = message.instructions.map((ix: any, n: number) => instruction(ix, String(n)))
  for (const group of row.meta.innerInstructions ?? []) group.instructions.forEach((ix: any, n: number) => ixs.push(instruction(ix, `${group.index}.${n}`)))
  const h = message.header
  const keyFlags = h ? keys.map((_, i) => ({ signer: i < h.numRequiredSignatures, writable: i < h.numRequiredSignatures
    ? i < h.numRequiredSignatures - h.numReadonlySignedAccounts : i < message.accountKeys.length
      ? i < message.accountKeys.length - h.numReadonlyUnsignedAccounts : i < message.accountKeys.length + (row.meta.loadedAddresses?.writable?.length ?? 0) })) : undefined
  const balances = (items: any[]) => items.map(b => ({ idx: b.accountIndex, mint: b.mint, owner: b.owner ?? '', amount: BigInt(b.uiTokenAmount.amount), decimals: b.uiTokenAmount.decimals }))
  return { sig, slot: row.slot, keys, ixs, keyFlags, version: wire?.version ?? row.version ?? 'legacy', failed: row.meta.err !== null,
    ...(Array.isArray(row.meta.preTokenBalances) ? { pre: balances(row.meta.preTokenBalances) } : {}),
    ...(Array.isArray(row.meta.postTokenBalances) ? { post: balances(row.meta.postTokenBalances) } : {}),
    ...(Array.isArray(row.meta.preBalances) && Array.isArray(row.meta.postBalances) ? { lamports: { pre: row.meta.preBalances.map(BigInt), post: row.meta.postBalances.map(BigInt), fee: BigInt(row.meta.fee ?? 0) } } : {}) }
}
