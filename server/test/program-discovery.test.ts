import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import bs58 from 'bs58'
import { ProgramIndex, validateInterface } from '../src/solana/program-index.ts'
import { observePrograms, observeRawPrograms, rpcDiscoveryTransaction, type ProgramObservation } from '../src/solana/program-observation.ts'
import { toNTx } from '../src/solana/lanes.ts'
import { parsedDiscoveryTransaction } from '../src/solana/parsed-stream.ts'
import type { NTx } from '../src/solana/decode.ts'

const address = (byte: number) => bs58.encode(new Uint8Array(32).fill(byte))
const unknown = address(12), nested = address(13), wallet = address(14)
const tx = (signature = 'receipt-one'): NTx => ({ sig: signature, slot: 454560100, version: 1,
  keys: [wallet, unknown, nested], keyFlags: [{ signer: true, writable: true }, { signer: false, writable: false }, { signer: false, writable: false }],
  ixs: [{ prog: unknown, n: '0', data: new Uint8Array([7, 9]), accts: [0] }, { prog: nested, n: '0.0', stackHeight: 2, data: new Uint8Array([8]), accts: [0] }], failed: false })
const observation = (signature = 'receipt-one'): ProgramObservation => {
  const result = observePrograms(tx(signature), 'geyser-primary', 1000)!
  // A source delivers a representative shape once, not on every duplicate.
  // Supply the persisted representative for isolated index/validation tests.
  result.programs[0].samples = [{ signature, n: '0', data: Buffer.from([7, 9]).toString('base64'), inner: false,
    accounts: [{ address: wallet, signer: true, writable: true }] }]
  return result
}

test('unknown-only outer and CPI programs are observed before the venue instruction gate, including V1', () => {
  const raw = { accountKeys: [wallet, unknown, nested].map(key => bs58.decode(key)),
    config: { computeUnitLimit: 200000 }, header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 2 },
    instructions: [{ programIdIndex: 1, accounts: new Uint8Array([0]), data: new Uint8Array([7]) }] }
  const meta = { err: null, innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 2, accounts: new Uint8Array([0]), data: new Uint8Array([8]), stackHeight: 2 }] }] }
  assert.equal(toNTx(new Uint8Array(64), 42, raw, [], [], meta), null)
  const normalized = toNTx(new Uint8Array(64), 42, raw, [], [], meta, true)!
  assert.equal(normalized.version, 1)
  const result = observePrograms(normalized, 'geyser-primary')!
  assert.deepEqual(result.programs.map(program => [program.address, program.outer, program.inner]), [[unknown, 1, 0], [nested, 0, 1]])
  assert.deepEqual(result.edges, [{ caller: unknown, callee: nested, attribution: 'direct' }])
})

test('nested CPI attribution follows stack heights, while missing heights remain explicitly outer-root attributed', () => {
  const transaction = tx()
  transaction.keys.push(address(15), address(16))
  transaction.ixs.push({ prog: address(15), n: '0.1', stackHeight: 3, data: new Uint8Array([9]), accts: [] },
    { prog: address(16), n: '0.2', data: new Uint8Array([10]), accts: [] })
  assert.deepEqual(observePrograms(transaction, 'geyser')!.edges, [
    { caller: unknown, callee: nested, attribution: 'direct' }, { caller: nested, callee: address(15), attribution: 'direct' },
    { caller: unknown, callee: address(16), attribution: 'outer' },
  ])
})

test('lazy raw discovery resolves unknown program keys in lookup tables without encoding unrelated accounts', () => {
  const outer = address(40), inner = address(41)
  const result = observeRawPrograms({ signature: new Uint8Array(64), transaction: { message: {
    accountKeys: [bs58.decode(wallet)], versioned: true, config: { computeUnitLimit: 100000 },
    header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
    instructions: [{ programIdIndex: 1, accounts: new Uint8Array([0]), data: new Uint8Array([12]) }],
  } }, meta: { err: null, loadedWritableAddresses: [], loadedReadonlyAddresses: [bs58.decode(outer), bs58.decode(inner)],
    innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 2, accounts: new Uint8Array([0]), data: new Uint8Array([13]), stackHeight: 2 }] }] } }, 42, 'laserstream')!
  assert.equal(result.version, 1)
  assert.deepEqual(result.programs.map(program => program.address), [outer, inner])
  assert.equal(result.programs[0].samples[0].accounts[0].address, wallet)
  assert.equal(result.programs[0].samples[0].accounts[0].signer, true)
  assert.deepEqual(result.edges, [{ caller: outer, callee: inner, attribution: 'direct' }])
})

test('parsed full-detail notifications retain net-new programs with raw accounts and do not turn Anchor events into calls', () => {
  const value = { transaction: { signature: 'parsed-receipt', slot: 23, status: 'ok', accountKeys: [wallet, unknown, nested] }, instructions: [
    { programId: unknown, instructionIndex: 1, innerInstructionIndex: null, rawAccounts: [wallet], rawData: bs58.encode(new Uint8Array([7])) },
    { programId: nested, instructionIndex: 1, innerInstructionIndex: 0, rawAccounts: [wallet], rawData: bs58.encode(new Uint8Array([8])) },
    { programId: unknown, instructionIndex: 1, innerInstructionIndex: 1, decoded: { event: 'NotAnInstruction' } },
  ] }
  const normalized = parsedDiscoveryTransaction(value)!
  assert.equal(normalized.ixs.length, 2)
  assert.equal(observePrograms(normalized, 'helius-parsed')!.programs.length, 2)
})

test('raw JSON RPC normalizes actual mainnet V1 account and instruction data without relabelling the version', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/mainnet-v1.json', import.meta.url), 'utf8'))
  const result = rpcDiscoveryTransaction({ slot: fixture.slot, version: 1, transaction: { message: fixture.jsonMessage, signatures: [fixture.signature] }, meta: { err: null, loadedAddresses: { writable: [], readonly: [] } } })
  assert.equal(result.version, 1)
  assert.equal(result.sig, fixture.signature)
  assert.deepEqual(result.keys, fixture.jsonMessage.accountKeys)
  assert.equal(result.ixs.length, fixture.jsonMessage.instructions.length)
})

test('signature dedupe upgrades pending -> executed, enriches metadata, and does not inflate replay or overlapping lanes', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const index = new ProgramIndex({ db, now: () => 1000 })
    const first = observation()
    index.observeMany([{ ...first, executed: false, programs: [first.programs[0]] }])
    assert.equal(index.detail(unknown)!.program.pendingTransactions, 1)
    index.observeMany([first, { ...first, lane: 'helius-laserstream', finalized: true }, { ...first, lane: 'receipt-replay' }])
    assert.equal(index.detail(unknown)!.program.transactions, 1)
    assert.equal(index.detail(unknown)!.program.pendingTransactions, 0)
    assert.equal(index.detail(nested)!.program.innerInvocations, 1)
    assert.equal(index.totals().transactions, 1)
    assert.equal(index.totals().invocations, 2)
    assert.equal(index.detail(nested)!.receipts[0].finalized, true)
    assert.equal(index.detail(unknown)!.relationships[0].transactions, 1)
  } finally { db.close() }
})

test('real swap selectors give same-transaction atomic evidence; only a real SOL transfer yields a Jito hint', () => {
  const idl = JSON.parse(fs.readFileSync(new URL('../idl/meteora_dlmm.json', import.meta.url), 'utf8'))
  const swap = idl.instructions.find((ix: any) => ix.name === 'swap')
  const tip = 'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt'
  const transaction = tx()
  transaction.keys.push(idl.address, '11111111111111111111111111111111', tip)
  transaction.ixs.push({ prog: idl.address, n: '0.1', stackHeight: 2, accts: [0], data: new Uint8Array(swap.discriminator) },
    { prog: idl.address, n: '0.2', stackHeight: 2, accts: [0], data: new Uint8Array(swap.discriminator) })
  let result = observePrograms(transaction, 'geyser')!
  assert.equal(result.programs.find(program => program.address === unknown)!.atomic, true)
  assert.equal(result.bundleHint, false) // A tip account's presence proves nothing.
  const transfer = Buffer.alloc(12); transfer.writeUInt32LE(2); transfer.writeBigUInt64LE(1000n, 4)
  transaction.ixs.push({ prog: '11111111111111111111111111111111', n: '1', data: transfer, accts: [0, 5] })
  result = observePrograms(transaction, 'geyser')!
  assert.equal(result.bundleHint, true)
  transaction.failed = true
  const db = new DatabaseSync(':memory:')
  try { const index = new ProgramIndex({ db }); index.observeMany([observePrograms(transaction, 'geyser')!]); assert.equal(index.detail(unknown)!.program.atomicTransactions, 0) }
  finally { db.close() }
})

test('a missing published IDL invokes the real Composer route contract and persists learned provenance with live progress', async () => {
  const db = new DatabaseSync(':memory:'), updates: any[] = [], calls: string[] = []
  const learned = { address: unknown, metadata: { source: 'reconstructed from landed transactions' }, evidence: { instructionSamples: 25 }, caveats: ['arguments opaque'],
    instructions: [{ name: 'ix_07', discriminator: [7], accounts: [{ name: 'account_0', signer: true, writable: true }], args: [], argsHex: ['09'], argBytes: [1] }] }
  try {
    const index = new ProgramIndex({ db, now: () => 1000, composerUrl: 'https://composer.invalid', onUpdate: update => updates.push(update), fetcher: async input => {
      calls.push(String(input))
      return String(input).includes('/idl/') ? Response.json({ error: 'no published IDL account at sample' }, { status: 400 }) : Response.json(learned)
    } })
    index.observeMany([{ ...observation(), programs: [observation().programs[0]], edges: [] }])
    await index.next()
    assert.deepEqual(calls, [`https://composer.invalid/idl/${unknown}`, `https://composer.invalid/learn/${unknown}?signatures=250&seedBudget=2000000`])
    const detail = index.detail(unknown)!
    assert.equal(detail.program.state, 'ready')
    assert.equal(detail.program.idlSource, 'composer')
    assert.equal(detail.program.validation?.matched, 1)
    assert.equal(detail.program.validation?.unresolved, 1)
    assert.equal(detail.idlAvailable, true)
    assert.equal(JSON.parse(index.idl(unknown)!).address, unknown)
    assert.deepEqual(updates.flatMap(update => update.activity).filter(event => event.kind === 'progress').map(event => event.state), ['checking', 'learning', 'validating', 'ready'])
    assert.ok(updates.every((update, i) => !i || update.sequence > updates[i - 1].sequence))
  } finally { db.close() }
})

test('opaque argument bytes, unproven CPI signer privileges and mismatched constants remain distinguishable', () => {
  const sample = observation().programs[0].samples[0]
  const idl = { address: unknown, metadata: { source: 'reconstructed from landed transactions' }, instructions: [
    { name: 'ix_07', discriminator: [7], accounts: [{ name: 'a', address: address(29) }], argBytes: [1], args: [], argsHex: ['09'] },
  ] }
  assert.equal(validateInterface(idl, unknown, [sample]).mismatched, 1)
  idl.instructions[0].accounts[0].address = wallet
  assert.equal(validateInterface(idl, unknown, [sample]).matched, 1)
  assert.equal(validateInterface(idl, unknown, [sample]).unresolved, 1)
  assert.throws(() => validateInterface({ ...idl, address: nested }, unknown, [sample]), /identity/)
})

test('provider/version failures become scheduled retries, and a worker restart resumes interrupted jobs', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    let time = 1000
    const index = new ProgramIndex({ db, now: () => time, composerUrl: 'https://composer.invalid', fetcher: async input =>
      Response.json({ error: String(input).includes('/idl/') ? 'no published IDL account' : '0 transactions fetched; none contained a successful instruction' }, { status: 400 }) })
    index.observeMany([observation()])
    await index.next()
    const record = index.detail(unknown)!.program
    assert.equal(record.state, 'retrying')
    assert.equal(record.idlHash, null)
    assert.ok(record.nextAttemptTs! > time)
    db.prepare("UPDATE programs SET state='learning' WHERE address=?").run(unknown)
    time = 2000
    const restarted = new ProgramIndex({ db, now: () => time })
    assert.equal(restarted.detail(unknown)!.program.state, 'retrying')
    assert.equal(restarted.detail(unknown)!.program.nextAttemptTs, 2000)
  } finally { db.close() }
})

test('the queue prioritizes unindexed atomic/high-usage programs and serves the complete paginated set', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    const index = new ProgramIndex({ db, composerUrl: 'https://composer.invalid', fetcher: async () => Response.json({}, { status: 503 }) })
    const a = observation('a'), b = observation('b')
    a.programs = [a.programs[0]]; a.edges = []
    b.programs = [{ ...b.programs[1], atomic: true }]; b.edges = []
    index.observeMany([a, b])
    assert.equal(await index.next(), nested)
    const page = index.list({ limit: 1 })
    assert.equal(page.total, 2)
    assert.equal(page.hasMore, true)
    assert.notEqual(index.list({ limit: 1, offset: 1 }).items[0].address, page.items[0].address)
  } finally { db.close() }
})
