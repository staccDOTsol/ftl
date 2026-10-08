import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js'
import { DirectSolanaRouter, rankDirectCandidates, unsignedV1 } from '../src/solana/self-router.ts'
import { decodeV1 } from '../src/solana/transaction-v1.ts'
import { transactionVersion } from '../src/solana/router.ts'

const payer = new PublicKey('So11111111111111111111111111111111111111112')
const recipient = new PublicKey('53cTDPa69sUXtn4FiuXiKEipJGkUUaNxoisBiuSFkd5i')
const hash = new PublicKey('11111111111111111111111111111111').toBase58()

test('direct V1 swap assembly keeps only the wallet signer and explicit resources', () => {
  const ix = SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports: 123 })
  const wire = unsignedV1(payer, hash, [ix])
  const decoded = decodeV1(Buffer.from(wire, 'base64'), { requireResources: true })
  assert.equal(transactionVersion(wire), '1')
  assert.equal(decoded.required, 1)
  assert.equal(decoded.config.computeUnitLimit, 800_000)
  assert.equal(decoded.config.loadedAccountsDataSizeLimit, 64 * 1024 * 1024)
  assert.equal(decoded.ixs.length, 1)
  assert.equal(Buffer.from(decoded.keys[0]).toString('hex'), payer.toBuffer().toString('hex'))
  assert.ok(decoded.signatures[0].every(byte => byte === 0))
})

test('direct V1 swap rejects unsupported programs and a second signer', () => {
  const unsupported = new TransactionInstruction({ programId: recipient, keys: [], data: Buffer.of(1) })
  assert.throws(() => unsignedV1(payer, hash, [unsupported]), /unsupported program/i)
  const extraSigner = new TransactionInstruction({ programId: SystemProgram.programId,
    keys: [{ pubkey: recipient, isSigner: true, isWritable: true }], data: Buffer.of(1) })
  assert.throws(() => unsignedV1(payer, hash, [extraSigner]), /another signer/i)
})

test('direct quotes rank by executable after-fee output, not discovery activity', () => {
  const highActivity = { out: 90n, minimum: 88n, liqEvents: 100 }
  const bestOutput = { out: 110n, minimum: 108n, liqEvents: 1 }
  const ranked = rankDirectCandidates([highActivity, bestOutput])
  assert.deepEqual(ranked, [bestOutput, highActivity])
})

test('direct build simulation fails closed on on-chain and provider errors', async () => {
  const original = globalThis.fetch
  const router = new DirectSolanaRouter('https://example.invalid')
  try {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      assert.equal(body.method, 'simulateTransaction')
      assert.equal(body.params[1].sigVerify, false)
      return new Response(JSON.stringify({ result: { value: { err: null } } }), { status: 200 })
    }
    assert.equal(await router['simulate']('AA=='), true)
    globalThis.fetch = async () => new Response(JSON.stringify({ result: {
      value: { err: { InstructionError: [0, { Custom: 6027 }] } },
    } }), { status: 200 })
    assert.equal(await router['simulate']('AA=='), false)
    globalThis.fetch = async () => new Response('Forbidden', { status: 403 })
    await assert.rejects(router['simulate']('AA=='), /simulation is temporarily unavailable/)
  } finally {
    globalThis.fetch = original
  }
})
