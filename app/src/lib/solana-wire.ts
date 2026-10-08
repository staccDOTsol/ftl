import { VersionedTransaction, type VersionedMessage } from '@solana/web3.js'
import bs58 from 'bs58'
import nacl from 'tweetnacl'

export type TransactionVersion = '0' | '1'
export interface WireTransaction {
  version: TransactionVersion | 'legacy'
  message: Uint8Array
  signatures: Uint8Array[]
  feePayer: string
  requiredSignatures: number
  signerKeys: string[]
  /** Program id of every top-level instruction, in order. Program ids are
   * always static keys, so this is exact even when lookup tables load accounts. */
  programs: string[]
}

// V1 puts its version byte first and signatures last. web3.js 1.x must not
// deserialize/re-serialize this path. Layout: Solana SIMD-0385.
export function inspectTransaction(bytes: Uint8Array): WireTransaction {
  const fail = () => { throw new Error('Invalid or unsupported Solana transaction encoding.') }
  if (bytes[0] !== 0x81) {
    if (bytes.length > 1232 || bytes.length < 100) return fail()
    const tx = VersionedTransaction.deserialize(bytes)
    if (tx.signatures.length !== tx.message.header.numRequiredSignatures) return fail()
    return { version: tx.version === 'legacy' ? 'legacy' : '0', message: tx.message.serialize(), signatures: tx.signatures,
      programs: tx.message.compiledInstructions.map(ix => tx.message.staticAccountKeys[ix.programIdIndex].toBase58()),
      feePayer: tx.message.staticAccountKeys[0].toBase58(), requiredSignatures: tx.message.header.numRequiredSignatures,
      signerKeys: tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map(key => key.toBase58()) }
  }
  if (bytes.length < 42 + 32 + 8 + 4 + 64 || bytes.length > 4096) return fail()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const requiredSignatures = bytes[1], readonlySigners = bytes[2], readonlyAccounts = bytes[3]
  const mask = view.getUint32(4, true), instructionCount = bytes[40], addressCount = bytes[41]
  if (requiredSignatures < 1 || requiredSignatures > addressCount || readonlySigners >= requiredSignatures || readonlyAccounts > addressCount - requiredSignatures ||
      instructionCount < 1 || instructionCount > 64 || addressCount < 1 || addressCount > 64 || (mask & ~31) !== 0 ||
      ![0, 3].includes(mask & 3) || (mask & 12) !== 12) return fail()
  const end = bytes.length - requiredSignatures * 64
  let offset = 42 + addressCount * 32
  const keys = Array.from({ length: addressCount }, (_, i) => bs58.encode(bytes.slice(42 + i * 32, 74 + i * 32)))
  const addresses = new Set(keys)
  if (addresses.size !== addressCount || offset + 8 > end) return fail()
  if ((mask & 3) === 3) offset += 8
  if (offset + 8 > end) return fail()
  const compute = view.getUint32(offset, true), dataSize = view.getUint32(offset + 4, true)
  if (compute < 1 || compute > 1_400_000 || dataSize < 1 || dataSize > 64 * 1024 * 1024) return fail()
  offset += 8
  if (mask & 16) {
    if (offset + 4 > end) return fail()
    const heap = view.getUint32(offset, true)
    if (heap < 32 * 1024 || heap > 256 * 1024 || heap % 1024) return fail()
    offset += 4
  }
  const headers = offset
  offset += instructionCount * 4
  if (offset > end) return fail()
  for (let i = 0; i < instructionCount; i++) {
    const header = headers + i * 4
    const accounts = bytes[header + 1], dataLength = view.getUint16(header + 2, true)
    if (bytes[header] >= addressCount || accounts > 64 || offset + accounts + dataLength > end) return fail()
    for (let j = 0; j < accounts; j++) if (bytes[offset + j] >= addressCount) return fail()
    offset += accounts + dataLength
  }
  if (offset !== end) return fail()
  return { version: '1', message: bytes.slice(0, end), feePayer: bs58.encode(bytes.slice(42, 74)), requiredSignatures,
    programs: Array.from({ length: instructionCount }, (_, i) => keys[bytes[headers + i * 4]]),
    signerKeys: Array.from({ length: requiredSignatures }, (_, i) => bs58.encode(bytes.slice(42 + i * 32, 74 + i * 32))),
    signatures: Array.from({ length: requiredSignatures }, (_, i) => bytes.slice(end + i * 64, end + (i + 1) * 64)) }
}

const LIGHTHOUSE = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'
interface Account { key: string; isSigner: boolean; isWritable: boolean }
interface Instruction { program: string; accounts: Account[]; data: Uint8Array }
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i])
const sameAccount = (a: Account, b?: Account) => !!b && a.key === b.key && a.isSigner === b.isSigner && a.isWritable === b.isWritable
const sameInstruction = (a: Instruction, b: Instruction) => a.program === b.program && sameBytes(a.data, b.data) &&
  a.accounts.length === b.accounts.length && a.accounts.every((account, i) => sameAccount(account, b.accounts[i]))

// Lookup-table accounts resolve symbolically (table:w|r:index); tables are never fetched.
function resolve(message: VersionedMessage) {
  const tables = message.addressTableLookups.map(table => ({ ...table, key: table.accountKey.toBase58() }))
  const keys = [...message.staticAccountKeys.map(key => key.toBase58()),
    ...tables.flatMap(table => table.writableIndexes.map(i => `${table.key}:w:${i}`)), ...tables.flatMap(table => table.readonlyIndexes.map(i => `${table.key}:r:${i}`))]
  const accounts: Account[] = keys.map((key, i) => ({ key, isSigner: message.isAccountSigner(i), isWritable: message.isAccountWritable(i) }))
  if (new Set(keys).size !== keys.length || message.compiledInstructions.some(ix => [ix.programIdIndex, ...ix.accountKeyIndexes].some(i => i >= keys.length))) return null
  return { accounts, instructions: message.compiledInstructions.map(ix => ({ program: keys[ix.programIdIndex], accounts: ix.accountKeyIndexes.map(i => accounts[i]), data: ix.data })) }
}

// Phantom inserts Lighthouse assertions, and priority fees when a transaction
// sets no compute budget, before signing. Anything else is a different transaction.
function sameIntent(unsigned: Uint8Array, signed: Uint8Array) {
  const a = VersionedTransaction.deserialize(unsigned), b = VersionedTransaction.deserialize(signed)
  const expected = resolve(a.message), actual = resolve(b.message)
  if (!expected || !actual || a.version !== b.version || a.message.recentBlockhash !== b.message.recentBlockhash) return false
  const flags = new Map(actual.accounts.map(account => [account.key, account])), known = new Set(expected.accounts.map(account => account.key))
  if (!expected.accounts.every(account => sameAccount(account, flags.get(account.key))) ||
      actual.accounts.some(account => !known.has(account.key) && (account.isSigner || account.isWritable))) return false
  // Only SetComputeUnitLimit (2) / SetComputeUnitPrice (3), once each, and only when we set no budget.
  const budgeted = expected.instructions.some(ix => ix.program === COMPUTE_BUDGET), fees = new Set<number>()
  const fee = (ix: Instruction) => !budgeted && ix.program === COMPUTE_BUDGET && !ix.accounts.length && !fees.has(ix.data[0]) &&
    (ix.data[0] === 2 && ix.data.length === 5 || ix.data[0] === 3 && ix.data.length === 9) && !!fees.add(ix.data[0])
  const rest = actual.instructions.filter(ix => ix.program !== LIGHTHOUSE && !fee(ix))
  return rest.length === expected.instructions.length && rest.every((ix, i) => sameInstruction(expected.instructions[i], ix))
}

export function assertTransactionSignature(unsigned: Uint8Array, signed: Uint8Array) {
  const expected = inspectTransaction(unsigned), actual = inspectTransaction(signed)
  // V1 stays byte-exact: no known wallet rewrites it.
  if (!sameBytes(expected.message, actual.message) && (expected.version === '1' || actual.version === '1' || expected.version !== actual.version ||
      expected.signerKeys.join() !== actual.signerKeys.join() || !sameIntent(unsigned, signed))) {
    throw new Error('Wallet returned a different transaction. Nothing was sent.')
  }
  if (actual.signerKeys.some((key, i) => !nacl.sign.detached.verify(actual.message, actual.signatures[i], bs58.decode(key)))) {
    throw new Error('Wallet returned an invalid transaction signature. Nothing was sent.')
  }
}

export function preferredTransactionVersion(versions: readonly (number | string)[]): TransactionVersion | null {
  return versions.includes(1) ? '1' : versions.includes(0) ? '0' : null
}
