// Shared V1 wire decoder for unexecuted feeds and wallet transport.
// Format: https://solana.com/docs/core/transactions/versioned-transactions
export interface V1Config {
  priorityFeeLamports?: string
  computeUnitLimit?: number
  loadedAccountsDataSizeLimit?: number
  heapSize?: number
}
export function decodeV1(bytes: Uint8Array, options: { messageOnly?: boolean; requireResources?: boolean } = {}) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const bad = (message: string): never => { throw new Error(message) }
  if (b.length < 42 || b[0] !== 0x81) bad('Invalid V1 transaction header')
  const required = b[1], readonlySigned = b[2], readonlyUnsigned = b[3]
  const instructionCount = b[40], addressCount = b[41]
  if (required < 1 || required > 12 || readonlySigned >= required || addressCount > 64 || addressCount < required + readonlyUnsigned || instructionCount > 64) bad('Invalid V1 account or instruction counts')
  const end = b.length - (options.messageOnly ? 0 : required * 64)
  if (end < 42 || (options.messageOnly ? b.length + required * 64 : b.length) > 4096) bad('V1 transaction exceeds 4096 bytes')
  let cursor = 42
  const need = (n: number) => { if (n < 0 || cursor + n > end) bad('Truncated V1 transaction') }
  need(addressCount * 32)
  const keys: Uint8Array[] = []
  const unique = new Set<string>()
  for (let i = 0; i < addressCount; i++) { const key = b.subarray(cursor + i * 32, cursor + (i + 1) * 32); keys.push(key); unique.add(key.toString('hex')) }
  if (unique.size !== addressCount) bad('V1 account addresses must be unique')
  cursor += addressCount * 32
  const mask = b.readUInt32LE(4), priority = mask & 3
  if ((mask & ~31) !== 0 || (priority !== 0 && priority !== 3)) bad('Invalid V1 transaction config mask')
  const config: V1Config = {}
  if (priority) { need(8); config.priorityFeeLamports = b.readBigUInt64LE(cursor).toString(); cursor += 8 }
  if (mask & 4) { need(4); config.computeUnitLimit = b.readUInt32LE(cursor); cursor += 4 }
  if (mask & 8) { need(4); config.loadedAccountsDataSizeLimit = b.readUInt32LE(cursor); cursor += 4 }
  if (options.requireResources && (mask & 12) !== 12) bad('V1 requires explicit compute and loaded-account data limits')
  if (options.requireResources && (!config.computeUnitLimit || !config.loadedAccountsDataSizeLimit)) bad('V1 resource limits must be positive')
  if (mask & 16) {
    need(4); const heap = b.readUInt32LE(cursor)
    if (heap < 32768 || heap > 262144 || heap % 1024 !== 0) bad('Invalid V1 heap size')
    config.heapSize = heap; cursor += 4
  }
  need(instructionCount * 4)
  const headers = cursor; cursor += instructionCount * 4
  const ixs: { prog: number; accts: number[]; data: Uint8Array }[] = []
  for (let i = 0; i < instructionCount; i++) {
    const header = headers + i * 4, prog = b[header], count = b[header + 1], length = b.readUInt16LE(header + 2)
    if (prog === 0 || prog >= addressCount) bad('Invalid V1 program account index')
    need(count + length)
    const accts = Array.from(b.subarray(cursor, cursor + count))
    if (accts.some(index => index >= addressCount)) bad('Invalid V1 instruction account index')
    cursor += count
    const data = b.subarray(cursor, cursor + length); cursor += length
    ixs.push({ prog, accts, data })
  }
  if (cursor !== end) bad('Unexpected trailing V1 transaction data')
  const signatures: Uint8Array[] = []
  if (!options.messageOnly) for (let i = 0; i < required; i++) signatures.push(b.subarray(end + i * 64, end + (i + 1) * 64))
  return { version: 1 as const, keys, ixs, config, signatures, message: b.subarray(0, end), messageEnd: end, required }
}
