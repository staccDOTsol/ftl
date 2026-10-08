import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { inspectTransaction } from '../src/lib/solana-wire.ts'
import { assertWrapBuild } from '../src/lib/solana-wrap-model.ts'

const assertWrapIntent = (build, intent) => assertWrapBuild(build, intent, inspectTransaction(Uint8Array.from(Buffer.from(build.transaction, 'base64'))))

// Deterministic local fixture only; never a funded account.
const owner = Keypair.fromSeed(new Uint8Array(32).fill(3))
const other = Keypair.fromSeed(new Uint8Array(32).fill(4))
const hash = new PublicKey(new Uint8Array(32).fill(9)).toBase58()
function v0(payer, extraSigner) {
  const instructions = [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: other.publicKey, lamports: 1n })]
  if (extraSigner) instructions.push(SystemProgram.transfer({ fromPubkey: extraSigner.publicKey, toPubkey: payer.publicKey, lamports: 1n }))
  const bytes = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: hash, instructions }).compileToV0Message()).serialize()
  return Buffer.from(bytes).toString('base64')
}
const intent = { owner: owner.publicKey.toBase58(), direction: 'wrap', lamports: '5000', transactionVersion: '0' }
const build = () => ({ transaction: v0(owner), lastValidBlockHeight: 10, transactionVersion: '0', expectedSigners: [intent.owner], summary: { direction: 'wrap', lamports: '5000', tokenAccount: other.publicKey.toBase58(), createsTokenAccount: true } })

test('wrap build must match direction, amount, version, expiry and the single owner signer', () => {
  assert.equal(assertWrapIntent(build(), intent).feePayer, intent.owner)
  assert.throws(() => assertWrapIntent({ ...build(), lastValidBlockHeight: 0 }, intent), /expiry/)
  assert.throws(() => assertWrapIntent({ ...build(), summary: { ...build().summary, direction: 'unwrap' } }, intent), /different wrap operation/)
  assert.throws(() => assertWrapIntent({ ...build(), summary: { ...build().summary, lamports: '5001' } }, intent), /different wrap operation/)
  assert.throws(() => assertWrapIntent({ ...build(), transactionVersion: '1' }, intent), /transaction version/)
  assert.throws(() => assertWrapIntent(build(), { ...intent, transactionVersion: '1' }), /transaction version/)
  assert.throws(() => assertWrapIntent({ ...build(), expectedSigners: [other.publicKey.toBase58()] }, intent), /unexpected signer/)
  assert.throws(() => assertWrapIntent({ ...build(), transaction: v0(other) }, intent), /unexpected signer/)
  assert.throws(() => assertWrapIntent({ ...build(), transaction: v0(owner, other) }, intent), /unexpected signer/)
})
test('unwrap ignores the requested lamports but still requires a positive reported balance', () => {
  const unwrap = { owner: intent.owner, direction: 'unwrap', transactionVersion: '0' }
  assert.doesNotThrow(() => assertWrapIntent({ ...build(), summary: { direction: 'unwrap', lamports: '1', tokenAccount: other.publicKey.toBase58() } }, unwrap))
  assert.throws(() => assertWrapIntent({ ...build(), summary: { direction: 'unwrap', lamports: '0', tokenAccount: other.publicKey.toBase58() } }, unwrap), /positive integer/)
})
