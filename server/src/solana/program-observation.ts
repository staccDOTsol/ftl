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
  templates?: SwapTemplate[]
}

/** A landed swap its signer made through exactly one non-infrastructure
 * program: the router may replay it for another wallet once that program's
 * interface is indexed. Everything here is observed; nothing is inferred
 * beyond the unique byte offset of the exact amount the signer spent. */
export interface SwapTemplate {
  program: string; signature: string; slot: number; ts: number
  data: string; accounts: { address: string; signer: boolean; writable: boolean }[]
  signer: string; inputMint: string; outputMint: string; amountIn: string; amountOut: string
  /** Unique little-endian u64 offset of amountIn in the instruction data.
   * 'exact': the slot equals what the signer spent. 'bounded': a native spend
   * also paid the program's own fee, so the slot is the unique value within
   * 10% below the spend; the router sizes it by simulation before use. */
  amountOffset: number; amountProof: 'exact' | 'bounded'
  /** How native SOL moved: from/to the wallet's lamports, or via a WSOL token account. */
  nativeIn: 'lamports' | 'wsol' | null; nativeOut: 'lamports' | 'wsol' | null
  /** The signer's own token accounts the instruction names, by mint. */
  tokenAccounts: { address: string; mint: string }[]
  lookupTables: string[]
}
const capturedTemplates = new Map<string, number>()
const TEMPLATE_REFRESH_MS = 5 * 60_000
const metaBalances = (items: any[]) => items.map(b => ({ idx: b.accountIndex, mint: b.mint, owner: b.owner ?? '', amount: BigInt(b.uiTokenAmount?.amount ?? '0'), decimals: b.uiTokenAmount?.decimals ?? 0 }))

/** The unique offset of `value` as a little-endian u64 in `data`, else null. */
export function uniqueU64(data: Uint8Array, value: bigint): number | null {
  if (value <= 0n || value >= 1n << 64n) return null
  const needle = Buffer.alloc(8); needle.writeBigUInt64LE(value)
  const haystack = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const at = haystack.indexOf(needle)
  return at >= 0 && haystack.indexOf(needle, at + 1) < 0 ? at : null
}

export function swapTemplate(tx: NTx, ts: number, keyAt: (index: number) => string | null,
  flagAt: (index: number) => { signer: boolean; writable: boolean } | undefined, rawMeta?: any): SwapTemplate | null {
  if (tx.failed) return null
  let venue: NIx | null = null
  for (const ix of tx.ixs) {
    if (ix.n.includes('.') || INFRASTRUCTURE.has(ix.prog)) continue
    // One venue instruction, from a program FTL's own decoders do not already route.
    if (venue || shipped.has(ix.prog) || !validProgram(ix.prog)) return null
    venue = ix
  }
  if (!venue || venue.rawDataKnown === false || venue.data.length > 1024 || venue.accts.length > 48) return null
  const signer = keyAt(0)
  if (!signer || flagAt(0)?.signer !== true || !venue.accts.includes(0)) return null
  const pre = tx.pre ?? (Array.isArray(rawMeta?.preTokenBalances) ? metaBalances(rawMeta.preTokenBalances) : null)
  const post = tx.post ?? (Array.isArray(rawMeta?.postTokenBalances) ? metaBalances(rawMeta.postTokenBalances) : null)
  const lamports = tx.lamports ?? (Array.isArray(rawMeta?.preBalances) && Array.isArray(rawMeta?.postBalances)
    ? { pre: rawMeta.preBalances.map(BigInt), post: rawMeta.postBalances.map(BigInt), fee: BigInt(rawMeta.fee ?? 0) } : null)
  if (!pre || !post || !lamports || lamports.pre[0] === undefined || lamports.post[0] === undefined) return null
  const delta = new Map<string, bigint>(), owned = new Map<string, string>()
  for (const [list, sign] of [[pre, -1n], [post, 1n]] as const) for (const balance of list) {
    if (balance.owner !== signer) continue
    const address = keyAt(balance.idx)
    if (!address) return null
    const known = owned.get(address)
    if (known && known !== balance.mint) return null
    owned.set(address, balance.mint)
    delta.set(balance.mint, (delta.get(balance.mint) ?? 0n) + sign * balance.amount)
  }
  // One account per mint: two of the signer's accounts for one mint is ambiguous to re-point.
  const mints = [...owned.values()]
  if (new Set(mints).size !== mints.length) return null
  const native = lamports.post[0] - lamports.pre[0] + lamports.fee + (delta.get(WSOL) ?? 0n)
  const wsolAccount = [...owned].find(([, mint]) => mint === WSOL)?.[0]
  const wsolNamed = !!wsolAccount && venue.accts.some(i => keyAt(i) === wsolAccount)
  delta.delete(WSOL)
  const ins = [...delta].filter(([, d]) => d < 0n), outs = [...delta].filter(([, d]) => d > 0n)
  let inputMint: string, outputMint: string, amountIn: bigint, amountOut: bigint
  let nativeIn: SwapTemplate['nativeIn'] = null, nativeOut: SwapTemplate['nativeOut'] = null
  if (ins.length === 1 && outs.length === 1) [inputMint, amountIn, outputMint, amountOut] = [ins[0][0], -ins[0][1], outs[0][0], outs[0][1]]
  else if (!ins.length && outs.length === 1 && native < 0n) {
    [inputMint, amountIn, outputMint, amountOut] = [WSOL, -native, outs[0][0], outs[0][1]]; nativeIn = wsolNamed ? 'wsol' : 'lamports'
  } else if (ins.length === 1 && !outs.length && native > 0n) {
    [inputMint, amountIn, outputMint, amountOut] = [ins[0][0], -ins[0][1], WSOL, native]; nativeOut = wsolNamed ? 'wsol' : 'lamports'
  } else return null
  // The amount the signer spent must sit at exactly one offset. A native spend
  // also carries tips and rent paid by the outer infrastructure instructions;
  // those are measured from this transaction and removed before matching.
  const data = Buffer.from(venue.data)
  let amountOffset = uniqueU64(data, amountIn), amountProof: SwapTemplate['amountProof'] = 'exact'
  if (amountOffset === null && nativeIn) {
    let outer = 0n
    for (const ix of tx.ixs) {
      if (ix.n.includes('.') || ix === venue || ix.accts[0] !== 0) continue
      const bytes = Buffer.from(ix.data)
      if (ix.prog === '11111111111111111111111111111111' && bytes.length === 12 && bytes.readUInt32LE(0) === 2 && ix.accts[1] !== 0
        && keyAt(ix.accts[1]) !== wsolAccount) outer += bytes.readBigUInt64LE(4)
      if (ix.prog === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' && ix.accts[1] !== undefined && keyAt(ix.accts[1]) !== wsolAccount)
        outer += (lamports.post[ix.accts[1]] ?? 0n) - (lamports.pre[ix.accts[1]] ?? 0n)
    }
    if (outer > 0n && outer < amountIn) { amountIn -= outer; amountOffset = uniqueU64(data, amountIn) }
    if (amountOffset === null) {
      // The program's own fee on top of its amount: one u64 in (90%, 100%] of the spend.
      const found: number[] = []
      for (let at = 0; at + 8 <= data.length; at++) {
        const value = data.readBigUInt64LE(at)
        if (value * 10n > amountIn * 9n && value <= amountIn) found.push(at)
      }
      if (found.length !== 1) return null
      amountOffset = found[0]; amountIn = data.readBigUInt64LE(amountOffset); amountProof = 'bounded'
    }
  }
  if (amountOffset === null) return null
  const accounts = venue.accts.map(i => ({ address: keyAt(i), flags: tx.keyFlags?.[i] ?? flagAt(i) }))
  if (accounts.some(a => !a.address || !a.flags)) return null
  const tokenAccounts = [...owned].filter(([address]) => venue!.accts.some(i => keyAt(i) === address)).map(([address, mint]) => ({ address, mint }))
  // Every account the swap moved value through must be one the instruction names.
  for (const mint of [inputMint, outputMint]) if (mint !== WSOL || wsolNamed)
    if (!tokenAccounts.some(account => account.mint === mint)) return null
  const key = `${venue.prog}:${data.subarray(0, 8).toString('hex')}:${data.length}:${venue.accts.length}:${inputMint}:${outputMint}`
  const last = capturedTemplates.get(key)
  if (last !== undefined && ts - last < TEMPLATE_REFRESH_MS) return null
  capturedTemplates.set(key, ts)
  if (capturedTemplates.size > 20_000) capturedTemplates.delete(capturedTemplates.keys().next().value!)
  return { program: venue.prog, signature: tx.sig, slot: tx.slot, ts, data: data.toString('base64'),
    accounts: accounts.map(a => ({ address: a.address!, signer: a.flags!.signer, writable: a.flags!.writable })),
    signer, inputMint, outputMint, amountIn: amountIn.toString(), amountOut: amountOut.toString(), amountOffset, amountProof,
    nativeIn, nativeOut, tokenAccounts, lookupTables: tx.lookups ?? [] }
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
  const template = executed ? swapTemplate(tx, ts, keyAt, i => tx.keyFlags?.[i] ?? options.flagAt?.(i), options.rawMeta) : null
  return { signature: tx.sig, slot: tx.slot, ts, lane, version: tx.version ?? 'legacy', executed,
    failed: tx.failed === true, finalized, bundleHint, closedPositive: totalSwaps >= 2 && closedPositive(tx),
    programs: [...programs.values()], edges: [...edges.values()], ...(template ? { templates: [template] } : {}) }
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
    version: message.config != null ? 1 : message.versioned ? 0 : 'legacy',
    ...(message.addressTableLookups?.length ? { lookups: message.addressTableLookups.map((l: any) => bs58.encode(l.accountKey)) } : {}) },
    lane, ts, true, finalized, { resolveKey, flagAt, rawMeta: meta })
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
  const lookups: string[] = wire ? wire.lookups.map(l => l.table) : (message.addressTableLookups ?? []).map((l: any) => l.accountKey)
  return { sig, slot: row.slot, keys, ixs, keyFlags, version: wire?.version ?? row.version ?? 'legacy', failed: row.meta.err !== null,
    ...(lookups.length ? { lookups } : {}),
    ...(Array.isArray(row.meta.preTokenBalances) ? { pre: balances(row.meta.preTokenBalances) } : {}),
    ...(Array.isArray(row.meta.postTokenBalances) ? { post: balances(row.meta.postTokenBalances) } : {}),
    ...(Array.isArray(row.meta.preBalances) && Array.isArray(row.meta.postBalances) ? { lamports: { pre: row.meta.preBalances.map(BigInt), post: row.meta.postBalances.map(BigInt), fee: BigInt(row.meta.fee ?? 0) } } : {}) }
}
