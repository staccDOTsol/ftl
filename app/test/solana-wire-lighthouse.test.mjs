import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import nacl from 'tweetnacl'
import { AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { assertTransactionSignature } from '../src/lib/solana-wire.ts'

// Deterministic local fixtures only; never funded or sent.
const key = byte => new PublicKey(new Uint8Array(32).fill(byte))
const payer = Keypair.fromSeed(new Uint8Array(32).fill(31))
const LIGHTHOUSE = new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95')
const program = key(40), vault = key(41), recipient = key(42), pool = key(43), oracle = key(44), probe = key(45)
const table = new AddressLookupTableAccount({ key: key(50), state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [key(51), pool, oracle] } })
const blockhash = key(9).toBase58()

const swap = (data = [1, 2, 3, 4]) => new TransactionInstruction({ programId: program, data: Buffer.from(data), keys: [
  { pubkey: payer.publicKey, isSigner: true, isWritable: true }, { pubkey: vault, isSigner: false, isWritable: true },
  { pubkey: pool, isSigner: false, isWritable: true }, { pubkey: oracle, isSigner: false, isWritable: false }] })
const transfer = () => SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient, lamports: 5 })
const assertion = (keys, data = [7, 0, 1]) => new TransactionInstruction({ programId: LIGHTHOUSE, data: Buffer.from(data), keys })
const ro = pubkey => ({ pubkey, isSigner: false, isWritable: false })
const original = () => [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), swap(), transfer()]

const compile = (instructions, version = 0, hash = blockhash) => {
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: hash, instructions })
  return new VersionedTransaction(version === 'legacy' ? message.compileToLegacyMessage() : message.compileToV0Message([table]))
}
const unsignedOf = (instructions, version) => compile(instructions, version).serialize()
const signedOf = (instructions, version, hash) => { const tx = compile(instructions, version, hash); tx.sign([payer]); return tx.serialize() }
const DIFFERENT = /different transaction/

test('(a) Phantom recompiling with Lighthouse assertions, shifted keys and lookup indices still verifies', () => {
  const unsigned = unsignedOf(original())
  // A leading assertion on a new account and the recipient reorders static keys and shifts every lookup index.
  const instructions = [assertion([ro(probe), ro(recipient)]), ...original(), assertion([ro(oracle), ro(payer.publicKey)])]
  const signed = signedOf(instructions)
  const before = VersionedTransaction.deserialize(unsigned).message, after = VersionedTransaction.deserialize(signed).message
  assert.notDeepEqual(after.staticAccountKeys.slice(0, 3).map(String), before.staticAccountKeys.slice(0, 3).map(String))
  assert.notDeepEqual(after.compiledInstructions[2].accountKeyIndexes, before.compiledInstructions[1].accountKeyIndexes)
  assert.equal(after.addressTableLookups.length, 1)
  assert.doesNotThrow(() => assertTransactionSignature(unsigned, signed))
  assert.doesNotThrow(() => assertTransactionSignature(unsignedOf(original(), 'legacy'), signedOf([...original(), assertion([ro(vault)])], 'legacy')))
})

test('(b) a changed data byte is rejected', () => {
  assert.throws(() => assertTransactionSignature(unsignedOf(original()), signedOf([original()[0], swap([1, 2, 3, 5]), transfer(), assertion([ro(probe)])])), DIFFERENT)
})

test('(c) an extra non-Lighthouse instruction, a dropped or reordered instruction is rejected', () => {
  const unsigned = unsignedOf(original())
  const drain = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: probe, lamports: 1 })
  assert.throws(() => assertTransactionSignature(unsigned, signedOf([...original(), drain])), DIFFERENT)
  assert.throws(() => assertTransactionSignature(unsigned, signedOf([...original(), assertion([ro(probe)]), drain])), DIFFERENT)
  assert.throws(() => assertTransactionSignature(unsigned, signedOf([original()[0], swap(), assertion([ro(probe)])])), DIFFERENT)
  assert.throws(() => assertTransactionSignature(unsigned, signedOf([original()[0], transfer(), swap()])), DIFFERENT)
})

test('(d) privilege changes through Lighthouse are rejected', () => {
  const unsigned = unsignedOf(original())
  const writable = pubkey => ({ pubkey, isSigner: false, isWritable: true })
  // Original lookup-loaded readonly oracle, original static readonly program, a new writable or signer key.
  for (const keys of [[writable(oracle)], [writable(program)], [writable(probe)], [{ pubkey: probe, isSigner: true, isWritable: false }]]) {
    assert.throws(() => assertTransactionSignature(unsigned, signedOf([...original(), assertion(keys)])), DIFFERENT)
  }
})

test('(e) signatures are verified over the message the wallet returned', () => {
  const unsigned = unsignedOf(original())
  const tx = compile([...original(), assertion([ro(probe)])])
  // Signed over the original message, not the one returned.
  tx.addSignature(payer.publicKey, nacl.sign.detached(VersionedTransaction.deserialize(unsigned).message.serialize(), payer.secretKey))
  assert.throws(() => assertTransactionSignature(unsigned, tx.serialize()), /signature/)
  tx.sign([payer])
  const signed = tx.serialize()
  assert.doesNotThrow(() => assertTransactionSignature(unsigned, signed))
  signed[1] ^= 1
  assert.throws(() => assertTransactionSignature(unsigned, signed), /signature/)
})

test('the wallet may set its own compute budget, within a priority-fee cap', () => {
  const price = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })
  assert.doesNotThrow(() => assertTransactionSignature(unsignedOf(original()), signedOf([price, ...original(), assertion([ro(probe)])])))
  assert.doesNotThrow(() => assertTransactionSignature(unsignedOf(original()), signedOf([ComputeBudgetProgram.setComputeUnitLimit({ units: 260_000 }), swap(), transfer(), assertion([ro(probe)])])))
  const bare = () => [swap(), transfer()]
  const unsigned = unsignedOf(bare())
  const limit = ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 })
  assert.doesNotThrow(() => assertTransactionSignature(unsigned, signedOf([limit, price, ...bare(), assertion([ro(probe)])])))
  assert.throws(() => assertTransactionSignature(unsigned, signedOf([price, price, ...bare()])), /repeated compute budget/)
  assert.throws(() => assertTransactionSignature(unsigned, signedOf([ComputeBudgetProgram.requestHeapFrame({ bytes: 64 * 1024 }), ...bare()])), /unexpected compute budget/)
  assert.throws(() => assertTransactionSignature(unsigned, signedOf([limit, ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000_000 }), ...bare()])), /priority fee/)
})

test('a version change is rejected; a refreshed blockhash is not', () => {
  const unsigned = unsignedOf(original())
  assert.throws(() => assertTransactionSignature(unsigned, signedOf([...original(), assertion([ro(probe)])], 'legacy')), DIFFERENT)
  assert.doesNotThrow(() => assertTransactionSignature(unsigned, signedOf([...original(), assertion([ro(probe)])], 0, key(8).toBase58())))
})
