import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import nacl from 'tweetnacl'
import bs58 from 'bs58'
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { assertTransactionSignature, inspectTransaction, preferredTransactionVersion } from '../src/lib/solana-wire.ts'

const seed = new Uint8Array(32).fill(7)
const key = nacl.sign.keyPair.fromSeed(seed)

test('independently parses an actual Rust router DBC V1 transaction', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/router-dbc-v1.json', import.meta.url), 'utf8'))
  const bytes = Uint8Array.from(Buffer.from(fixture.wireBase64, 'base64'))
  const parsed = inspectTransaction(bytes)
  assert.equal(parsed.version, fixture.transactionVersion)
  assert.equal(parsed.feePayer, fixture.feePayer)
  assert.equal(parsed.message.length, fixture.messageLength)
  assert.deepEqual(parsed.message, bytes.slice(0, -64))
  assert.equal(parsed.requiredSignatures, 1)
  assert.ok(parsed.signatures[0].every(byte => byte === 0))
})
// Deterministic local fixture only; never used for a funded account or RPC send.
function v1(dataLength = 1800) {
  const configOffset = 42 + 64
  const headerOffset = configOffset + 8
  const payloadOffset = headerOffset + 4
  const bytes = new Uint8Array(payloadOffset + 1 + dataLength + 64)
  const view = new DataView(bytes.buffer)
  bytes.set([0x81, 1, 0, 1], 0)
  view.setUint32(4, 12, true)
  bytes.fill(9, 8, 40)
  bytes[40] = 1; bytes[41] = 2
  bytes.set(key.publicKey, 42)
  // The second inline account is the system program (32 zero bytes).
  view.setUint32(configOffset, 20_000, true)
  view.setUint32(configOffset + 4, 65536, true)
  bytes[headerOffset] = 1; bytes[headerOffset + 1] = 1
  view.setUint16(headerOffset + 2, dataLength, true)
  bytes[payloadOffset] = 0
  return bytes
}

test('V1 larger than legacy packet limit retains exact message and tail signature', () => {
  const bytes = v1()
  const parsed = inspectTransaction(bytes)
  assert.equal(parsed.version, '1')
  assert.ok(bytes.length > 1232)
  assert.equal(parsed.feePayer, bs58.encode(key.publicKey))
  assert.equal(parsed.message.length, bytes.length - 64)
  assert.equal(parsed.message[0], 0x81)
  const signed = bytes.slice()
  signed.set(nacl.sign.detached(parsed.message, key.secretKey), parsed.message.length)
  assert.doesNotThrow(() => assertTransactionSignature(bytes, signed))
  assert.deepEqual(inspectTransaction(signed).signatures[0], signed.slice(-64))
})

test('V1 rejects malformed limits, account indices, lengths and signature placement', () => {
  for (const mutate of [
    bytes => { bytes[4] = 0 },
    bytes => { bytes[4] = 13 },
    bytes => { bytes[4] = 44 },
    bytes => { bytes[41] = 65 },
    bytes => { bytes[2] = 1 },
    bytes => { bytes[118] = 2 },
    bytes => { bytes.fill(0, 106, 110) },
  ]) {
    const bytes = v1(); mutate(bytes)
    assert.throws(() => inspectTransaction(bytes))
  }
  assert.throws(() => inspectTransaction(v1().slice(0, -1)))
  assert.throws(() => inspectTransaction(v1(4000)))
  assert.throws(() => inspectTransaction(new Uint8Array([0x81])))
})

test('changed messages and invalid signatures cannot be submitted', () => {
  const bytes = v1(), parsed = inspectTransaction(bytes)
  const signed = bytes.slice()
  signed.set(nacl.sign.detached(parsed.message, key.secretKey), parsed.message.length)
  const changed = signed.slice(); changed[8] ^= 1
  assert.throws(() => assertTransactionSignature(bytes, changed))
  signed[signed.length - 1] ^= 1
  assert.throws(() => assertTransactionSignature(bytes, signed))
  assert.throws(() => assertTransactionSignature(bytes, bytes))
})

test('explicit V0 fallback retains its front signatures and verifies correctly', () => {
  const payer = Keypair.fromSeed(seed)
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: bs58.encode(new Uint8Array(32).fill(9)), instructions: [
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(new Uint8Array(32).fill(6)), lamports: 1 }),
  ] }).compileToV0Message()
  const transaction = new VersionedTransaction(message)
  const unsigned = transaction.serialize()
  transaction.sign([payer])
  const signed = transaction.serialize()
  assert.equal(inspectTransaction(signed).version, '0')
  assert.deepEqual(inspectTransaction(signed).message, message.serialize())
  assert.doesNotThrow(() => assertTransactionSignature(unsigned, signed))
  assert.throws(() => inspectTransaction(new Uint8Array(1233)))
})

test('negotiate V1 only when actually advertised and never downgrade a legacy-only wallet silently', () => {
  assert.equal(preferredTransactionVersion(['legacy', 0, 1]), '1')
  assert.equal(preferredTransactionVersion([0]), '0')
  assert.equal(preferredTransactionVersion(['legacy']), null)
  assert.equal(preferredTransactionVersion(['1']), null)
})

test('LP transactions preserve and verify every ephemeral position signature', () => {
  const payer = Keypair.fromSeed(new Uint8Array(32).fill(23))
  const position = Keypair.fromSeed(new Uint8Array(32).fill(24))
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: new PublicKey(new Uint8Array(32).fill(1)).toBase58(), instructions: [SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: position.publicKey, lamports: 1, space: 1, programId: SystemProgram.programId })] }).compileToV0Message()
  const tx = new VersionedTransaction(message)
  tx.sign([position])
  const partial = tx.serialize()
  assert.deepEqual(inspectTransaction(partial).signerKeys, [payer.publicKey.toBase58(), position.publicKey.toBase58()])
  tx.sign([payer])
  assert.doesNotThrow(() => assertTransactionSignature(partial, tx.serialize()))
  tx.signatures[1].fill(0)
  assert.throws(() => assertTransactionSignature(partial, tx.serialize()), /signature/)
})
