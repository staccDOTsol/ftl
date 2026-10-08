import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import { runtimeEventSample, mergeLearnedInstructions } from '../src/solana/program-interface.ts'
import { validateInterface } from '../src/solana/program-index.ts'

const program = 'DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH'
const authority = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], new PublicKey(program))[0].toBase58()
const event = { signature: 'receipt', n: '1.2', inner: true, data: Buffer.from('e445a52e51cb9a1d0001020304050607', 'hex').toString('base64'), accounts: [{ address: authority, signer: false, writable: false }] }

test('Anchor event CPI classification requires the canonical authority, magic tag, inner call and event bytes', () => {
  assert.equal(runtimeEventSample(event, program), true)
  assert.equal(runtimeEventSample({ ...event, inner: false }, program), false)
  assert.equal(runtimeEventSample({ ...event, accounts: [{ ...event.accounts[0], address: program }] }, program), false)
  assert.equal(runtimeEventSample({ ...event, data: Buffer.from([1, 2, 3]).toString('base64') }, program), false)
})
test('published instruction coverage excludes proven runtime events and decoded-only records without claiming their bytes were decoded', () => {
  const idl = { address: program, instructions: [{ name: 'real', discriminator: [7], accounts: [], args: [] }] }
  const validation = validateInterface(idl, program, [event, { ...event, data: '', accounts: [] }, { ...event, data: Buffer.from([7]).toString('base64'), accounts: [], inner: false }])
  assert.deepEqual(validation, { matched: 1, tested: 1, mismatched: 0, unresolved: 0, runtimeEvents: 1, missingData: 1 })
})
test('published IDL supplementation accepts only actual learned shapes that independently match observed gaps', () => {
  const idl = { address: program, instructions: [{ name: 'published', discriminator: [7], accounts: [], args: [] }] }
  const learned = { address: program, evidence: { instructionSamples: 30 }, instructions: [
    { name: 'learned', discriminator: [8], accounts: [], args: [], argBytes: [1], argsHex: ['09'] },
    { name: 'irrelevant', discriminator: [10], accounts: [], args: [] },
  ] }
  const sample = { ...event, inner: false, accounts: [], data: Buffer.from([8, 9]).toString('base64') }
  const merged = mergeLearnedInstructions(idl, learned, [sample])
  assert.deepEqual(merged.instructions.map(ix => ix.name), ['published', 'learned'])
  assert.equal(merged.evidence.composerExtensions, 1)
  assert.equal(idl.instructions.length, 1)
  assert.equal(validateInterface(merged, program, [sample]).matched, 1)
})
