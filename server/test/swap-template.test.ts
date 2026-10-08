import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import bs58 from 'bs58'
import { ProgramIndex } from '../src/solana/program-index.ts'
import { observePrograms, swapTemplate, type SwapTemplate } from '../src/solana/program-observation.ts'
import { programIds } from '../src/solana/programs.ts'
import type { NTx } from '../src/solana/decode.ts'

const a = (byte: number) => bs58.encode(new Uint8Array(32).fill(byte))
const signer = a(1), inputAta = a(2), outputAta = a(3), venue = a(4)
const inputMint = a(5), outputMint = a(6)
const WSOL = 'So11111111111111111111111111111111111111112'
const u64 = (value: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(value); return b }
const keyAt = (tx: NTx) => (index: number) => tx.keys[index] ?? null
const flagAt = (tx: NTx) => (index: number) => tx.keyFlags?.[index]

/** One landed swap through exactly one unknown program: the signer spends
 * `amountIn` of inputMint into its ATA and receives `amountOut` of outputMint,
 * with the spend encoded once at byte 8 of the instruction data. */
function swapTx({ amountIn = 100n, amountOut = 90n, dataAmount = null as bigint | null, extraData = Buffer.alloc(0) } = {}): NTx {
  const held = 1000n
  const data = Buffer.concat([Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), u64(dataAmount ?? amountIn), u64(amountOut + 7n), extraData])
  return { sig: 'template-one', slot: 454560100, version: 1,
    keys: [signer, inputAta, outputAta, venue],
    keyFlags: [{ signer: true, writable: true }, { signer: false, writable: true }, { signer: false, writable: true }, { signer: false, writable: false }],
    ixs: [{ prog: venue, n: '0', data, accts: [0, 1, 2, 3] }],
    failed: false,
    pre: [{ idx: 1, mint: inputMint, owner: signer, amount: held, decimals: 6 }, { idx: 2, mint: outputMint, owner: signer, amount: 0n, decimals: 6 }],
    post: [{ idx: 1, mint: inputMint, owner: signer, amount: held - amountIn, decimals: 6 }, { idx: 2, mint: outputMint, owner: signer, amount: amountOut, decimals: 6 }],
    lamports: { pre: [10_000n], post: [10_000n], fee: 500n } }
}

test('a landed single-program swap becomes a template with its proven amount offset and named accounts', () => {
  const tx = swapTx()
  const template = swapTemplate(tx, 400_000, keyAt(tx), flagAt(tx))!
  assert.ok(template)
  assert.deepEqual({ program: template.program, signer: template.signer, inputMint: template.inputMint, outputMint: template.outputMint,
    amountIn: template.amountIn, amountOut: template.amountOut, amountOffset: template.amountOffset, amountProof: template.amountProof,
    nativeIn: template.nativeIn, nativeOut: template.nativeOut, lookupTables: template.lookupTables },
    { program: venue, signer, inputMint, outputMint, amountIn: '100', amountOut: '90', amountOffset: 8, amountProof: 'exact',
      nativeIn: null, nativeOut: null, lookupTables: [] })
  assert.deepEqual(template.tokenAccounts, [{ address: inputAta, mint: inputMint }, { address: outputAta, mint: outputMint }])
  assert.deepEqual(template.accounts, [
    { address: signer, signer: true, writable: true }, { address: inputAta, signer: false, writable: true },
    { address: outputAta, signer: false, writable: true }, { address: venue, signer: false, writable: false }])
  assert.equal(Buffer.from(template.data, 'base64').readBigUInt64LE(template.amountOffset), 100n)
})

test('templates are refused when the proof fails: ambiguous amounts, two accounts per mint, unnamed value, shipped venues, failure, extra programs', () => {
  const ambiguous = swapTx({ extraData: u64(100n) })
  assert.equal(swapTemplate(ambiguous, 800_000, keyAt(ambiguous), flagAt(ambiguous)), null, 'the spend appears twice')
  const missing = swapTx({ dataAmount: 55n })
  assert.equal(swapTemplate(missing, 800_000, keyAt(missing), flagAt(missing)), null, 'the balance spend is not in the data')
  const split = swapTx()
  split.post[1] = { ...split.post[1] } // a second output account for the same mint arrives
  const moved = swapTx()
  moved.pre.push({ idx: 3, mint: outputMint, owner: signer, amount: 5n, decimals: 6 })
  moved.post.push({ idx: 3, mint: outputMint, owner: signer, amount: 7n, decimals: 6 })
  assert.equal(swapTemplate(moved, 800_000, keyAt(moved), flagAt(moved)), null, 'two of the signer’s accounts hold one mint')
  const unnamed = swapTx()
  unnamed.ixs[0].accts = [0, 1, 3]
  assert.equal(swapTemplate(unnamed, 800_000, keyAt(unnamed), flagAt(unnamed)), null, 'the account the swap paid into is not named')
  const shipped = swapTx()
  shipped.ixs[0].prog = programIds[0]
  assert.equal(swapTemplate(shipped, 800_000, keyAt(shipped), flagAt(shipped)), null, 'programs FTL already routes are not templates')
  const failed = swapTx()
  failed.failed = true
  assert.equal(swapTemplate(failed, 800_000, keyAt(failed), flagAt(failed)), null, 'failed transactions are not templates')
  const two = swapTx()
  two.ixs.push({ prog: a(9), n: '1', data: new Uint8Array([2]), accts: [0] })
  assert.equal(swapTemplate(two, 800_000, keyAt(two), flagAt(two)), null, 'a second outer program is not a single-venue swap')
  const inner = swapTx()
  inner.ixs.push({ prog: a(10), n: '0.1', stackHeight: 2, data: new Uint8Array([3]), accts: [0] })
  assert.ok(swapTemplate(inner, 800_000, keyAt(inner), flagAt(inner)), 'CPI instructions do not disqualify the venue')
})

test('native SOL sides are attributed, and a program fee above the slot leaves a bounded amount proof', () => {
  // SOL in: the wallet's lamports drop by the spend plus the fee; the program's
  // own amount sits just under what left the wallet.
  const inNative = swapTx({ amountIn: 0n, amountOut: 90n, dataAmount: 475n })
  inNative.pre = [{ idx: 2, mint: outputMint, owner: signer, amount: 0n, decimals: 6 }]
  inNative.post = [{ idx: 2, mint: outputMint, owner: signer, amount: 90n, decimals: 6 }]
  inNative.lamports = { pre: [10_000n], post: [9_500n], fee: 0n }
  const template = swapTemplate(inNative, 1_200_000, keyAt(inNative), flagAt(inNative))!
  assert.deepEqual({ inputMint: template.inputMint, nativeIn: template.nativeIn, amountIn: template.amountIn, amountProof: template.amountProof },
    { inputMint: WSOL, nativeIn: 'lamports', amountIn: '475', amountProof: 'bounded' }, 'the unique slot in (90%,100%] of the spend is the bounded amount')
  // SOL out: no output token, the wallet's lamports rose.
  const outNative = swapTx({ amountIn: 100n, amountOut: 0n, dataAmount: 100n })
  outNative.pre = [{ idx: 1, mint: inputMint, owner: signer, amount: 1000n, decimals: 6 }]
  outNative.post = [{ idx: 1, mint: inputMint, owner: signer, amount: 900n, decimals: 6 }]
  outNative.lamports = { pre: [10_000n], post: [10_050n], fee: 50n }
  const out = swapTemplate(outNative, 1_200_000, keyAt(outNative), flagAt(outNative))!
  assert.deepEqual({ outputMint: out.outputMint, nativeOut: out.nativeOut, amountIn: out.amountIn },
    { outputMint: WSOL, nativeOut: 'lamports', amountIn: '100' })
})

test('the same shape refreshes at most every five minutes', () => {
  const tx = swapTx()
  assert.ok(swapTemplate(tx, 1_600_000, keyAt(tx), flagAt(tx)))
  const again = swapTx({ amountIn: 200n, amountOut: 180n })
  assert.equal(swapTemplate(again, 1_600_000 + 60_000, keyAt(again), flagAt(again)), null, 'the shape is not recaptured within the window')
  assert.ok(swapTemplate(again, 1_600_000 + 5 * 60_000 + 1, keyAt(again), flagAt(again)), 'a later landing refreshes it')
})

test('executed observations carry the template to the index, which keeps the latest landing per shape and matches it to a decoded interface', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const index = new ProgramIndex({ db, now: () => 5000 })
    const observation = observePrograms(swapTx(), 'geyser-primary', 2_300_000)!
    assert.ok(observation.templates?.length, 'the observation carries the template')
    index.observeMany([observation])
    const again = observePrograms(swapTx({ amountIn: 250n, amountOut: 220n }), 'geyser-primary', 2_600_001)
    again.templates![0].signature = 'template-two'
    index.observeMany([again as any])
    const rows = db.prepare('SELECT signature, ts FROM program_swap_templates').all() as { signature: string; ts: number }[]
    assert.deepEqual(rows.map(row => ({ signature: row.signature, ts: row.ts })), [{ signature: 'template-two', ts: 5000 }], 'one template per program, pair and shape, the latest landing')
    // No decoded interface yet: the pair has templates but nothing to replay through.
    assert.deepEqual(index.swapTemplates({ inputMint, outputMint }), [])
    const learned = { address: venue, metadata: { source: 'reconstructed from landed transactions' }, instructions: [
      { name: 'swap_v2', discriminator: [1, 2, 3, 4, 5, 6, 7, 8], argBytes: [16], args: [], accounts: [
        { name: 'account_0', signer: true, writable: true },
        { name: 'account_1', writable: true }, { name: 'account_2', writable: true }, { name: 'account_3' }] }] }
    db.prepare('INSERT INTO program_idls(address,body,source,hash,learned_ts) VALUES(?,?,?,?,?)')
      .run(venue, JSON.stringify(learned), 'composer', 'hash', 3000)
    const found = index.swapTemplates({ inputMint, outputMint })
    assert.equal(found.length, 1)
    assert.deepEqual({ signature: found[0].template.signature, programName: found[0].programName, idlSource: found[0].idlSource,
      name: found[0].instruction.name, accounts: found[0].instruction.accounts.length },
      { signature: 'template-two', programName: null, idlSource: 'composer', name: 'swap_v2', accounts: 4 })
    // A mis-shaped interface is not a decoded swap: one extra account.
    learned.instructions[0].accounts.push({ name: 'account_4' })
    db.prepare('UPDATE program_idls SET body=? WHERE address=?').run(JSON.stringify(learned), venue)
    assert.deepEqual(index.swapTemplates({ inputMint, outputMint }), [], 'the structural match is required')
  } finally { db.close() }
})
