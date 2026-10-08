import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import bs58 from 'bs58'
import { parseWire } from '../src/solana/decode.ts'
import { toNTx } from '../src/solana/lanes.ts'
import { transaction } from '../src/solana/router.ts'

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/mainnet-v1.json', import.meta.url), 'utf8'))
const bytes = Buffer.from(fixture.transaction[0], 'base64')

test('finalized mainnet V1 bytes match independently decoded RPC JSON and wallet signatures', () => {
  const wire = parseWire(bytes), json = fixture.jsonMessage
  assert.equal(wire.version, 1)
  assert.equal(bs58.encode(wire.sig), fixture.signature)
  assert.deepEqual(wire.keys.map(bs58.encode), json.accountKeys)
  assert.deepEqual(wire.ixs.map(ix => ({ programIdIndex: ix.prog, accounts: ix.accts, data: bs58.encode(ix.data) })), json.instructions.map(({ programIdIndex, accounts, data }: any) => ({ programIdIndex, accounts, data })))
  assert.deepEqual(wire.lookups, [])
  assert.deepEqual(wire.transactionConfig, { priorityFeeLamports: String(json.transactionConfig.priorityFee), computeUnitLimit: json.transactionConfig.computeUnitLimit, loadedAccountsDataSizeLimit: json.transactionConfig.loadedAccountsDataSizeLimit, heapSize: json.transactionConfig.heapSize })
  assert.equal(fixture.meta.err, null)
  assert.ok(bytes.length > 1232)
  assert.equal(transaction(fixture.transaction[0], true), fixture.transaction[0])
})
test('V1 raw feed rejects truncated bytes and unsupported future versions without misclassifying them', () => {
  assert.throws(() => parseWire(bytes.subarray(0, bytes.length - 1)))
  const future = Buffer.from(bytes); future[0] = 0x82
  assert.throws(() => parseWire(future))
})
test('Geyser config presence identifies V1 before the shared versioned flag', () => {
  const idl = JSON.parse(fs.readFileSync(new URL('../idl/meteora_dbc.json', import.meta.url), 'utf8'))
  const ix = idl.instructions.find((v: any) => v.name === 'initialize_virtual_pool_with_spl_token')
  const key = bs58.decode('53cTDPa69sUXtn4FiuXiKEipJGkUUaNxoisBiuSFkd5i')
  const message = { versioned: true, config: { priorityFee: '9007199254740993', computeUnitLimit: 200000, loadedAccountsDataSizeLimit: 67108864 }, accountKeys: [key, bs58.decode(idl.address)], instructions: [{ programIdIndex: 1, accounts: Uint8Array.from([0]), data: Uint8Array.from(ix.discriminator) }], addressTableLookups: [] }
  const result = toNTx(new Uint8Array(64), 42, message, [], [], null)
  assert.equal(result?.version, 1)
  assert.equal(result?.transactionConfig?.priorityFeeLamports, '9007199254740993')
  assert.equal(result?.pre, undefined)
  assert.equal(result?.post, undefined)
  const { config: _config, ...v0 } = message
  assert.equal(toNTx(new Uint8Array(64), 42, v0, [], [], null)?.version, 0)
  assert.throws(() => toNTx(new Uint8Array(64), 42, message, [key], [], null), /lookup/)
})
test('pending V1 feed preserves zero resource requests without claiming execution', () => {
  const b = Buffer.from(bytes)
  // Fixture config has priority fee then compute/data limits.
  const computeAt = 42 + b[41] * 32 + 8
  b.writeUInt32LE(0, computeAt)
  const wire = parseWire(b)
  assert.equal(wire.transactionConfig?.computeUnitLimit, 0)
  assert.throws(() => transaction(b.toString('base64'), false), /positive/)
})
