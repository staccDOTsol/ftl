import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Keypair, PublicKey, TransactionInstruction, type AccountInfo } from '@solana/web3.js'
import { ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ftl-t22-'))
process.env.DATA_DIR = tmp
const { db } = await import('../src/db.ts')
const { token2022Blocker, swapMint, mintAta, venueLeg, programOf, DirectVenueError } =
  await import('../src/solana/direct-adapter.ts')
const { composeRoute, decodeCompose, feeAta, FEE_RECIPIENT } = await import('../src/solana/compose.ts')
const { cpmmSwapInstruction } = await import('../src/solana/direct-raydium-cpmm.ts')
after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

const key = (seed: number) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey
const MINT = key(9), wallet = key(1)

/** A Token-2022 mint account: 82-byte base, padding to 165, account type 1
 * (Mint), then TLV entries of u16 type, u16 length, value. */
function mint2022(entries: [number, Buffer][], owner = TOKEN_2022_PROGRAM_ID): AccountInfo<Buffer> {
  const base = Buffer.alloc(166)
  base[44] = 6; base[45] = 1 // decimals, is_initialized
  base[165] = 1
  const tlv = entries.map(([type, value]) => {
    const head = Buffer.alloc(4)
    head.writeUInt16LE(type, 0); head.writeUInt16LE(value.length, 2)
    return Buffer.concat([head, value])
  })
  return { data: Buffer.concat([base, ...tlv]), owner, lamports: 1, executable: false, rentEpoch: 0 }
}
const metadataPointer = (): [number, Buffer] => [ExtensionType.MetadataPointer, Buffer.alloc(64, 7)]
function transferFee(olderBps: number, newerBps: number): [number, Buffer] {
  const value = Buffer.alloc(108)
  value.writeUInt16LE(olderBps, 72 + 16)
  value.writeUInt16LE(newerBps, 90 + 16)
  return [ExtensionType.TransferFeeConfig, value]
}
const transferHook = (program: PublicKey): [number, Buffer] =>
  [ExtensionType.TransferHook, Buffer.concat([key(5).toBuffer(), program.toBuffer()])]

test('benign Token-2022 extensions are swappable; pump.fun metadata and an unset hook included', () => {
  assert.equal(token2022Blocker(MINT, mint2022([])), null)
  assert.equal(token2022Blocker(MINT, mint2022([metadataPointer(), [ExtensionType.TokenMetadata, Buffer.alloc(90, 1)]])), null)
  assert.equal(token2022Blocker(MINT, mint2022([transferHook(PublicKey.default), metadataPointer()])), null)
  assert.equal(token2022Blocker(MINT, mint2022([transferFee(0, 0)])), null)
  assert.equal(token2022Blocker(MINT, mint2022([[ExtensionType.MintCloseAuthority, Buffer.alloc(32, 3)]])), null)
  assert.equal(token2022Blocker(MINT, mint2022([[ExtensionType.DefaultAccountState, Buffer.from([1])]])), null)
  const info = swapMint(MINT, mint2022([metadataPointer()]))
  assert.ok(info.tokenProgram.equals(TOKEN_2022_PROGRAM_ID))
  assert.equal(info.decimals, 6)
})

test('extensions that break exact-in pricing or in-kind fees are refused', () => {
  assert.equal(token2022Blocker(MINT, mint2022([transferFee(25, 0)])), 'non-zero transfer fee')
  assert.equal(token2022Blocker(MINT, mint2022([transferFee(0, 1)])), 'non-zero transfer fee', 'the newer epoch counts too')
  assert.equal(token2022Blocker(MINT, mint2022([transferHook(key(6))])), 'transfer hook program')
  assert.equal(token2022Blocker(MINT, mint2022([[ExtensionType.NonTransferable, Buffer.alloc(0)]])), 'non-transferable')
  assert.equal(token2022Blocker(MINT, mint2022([[ExtensionType.PermanentDelegate, Buffer.alloc(32, 4)]])), 'permanent delegate')
  assert.equal(token2022Blocker(MINT, mint2022([[ExtensionType.PausableConfig, Buffer.alloc(33)]])), 'pausable')
  assert.equal(token2022Blocker(MINT, mint2022([[ExtensionType.DefaultAccountState, Buffer.from([2])]])),
    'new token accounts start frozen')
  assert.equal(token2022Blocker(MINT, mint2022([[ExtensionType.ConfidentialTransferMint, Buffer.alloc(65)]])),
    'confidential transfers')
  assert.match(token2022Blocker(MINT, mint2022([[16, Buffer.alloc(129)]]))!, /ConfidentialTransferFeeConfig/)
  const rate = Buffer.alloc(52)
  rate.writeInt16LE(50, 50)
  assert.equal(token2022Blocker(MINT, mint2022([[ExtensionType.InterestBearingConfig, rate]])), 'non-zero interest rate')
  // A malformed tail or a wrong account-type byte is unreadable, never accepted.
  const bad = mint2022([metadataPointer()]); bad.data[165] = 2
  assert.equal(token2022Blocker(MINT, bad), 'unreadable mint extensions')
  assert.throws(() => swapMint(MINT, mint2022([transferFee(100, 100)])), DirectVenueError)
  assert.throws(() => swapMint(MINT, { ...mint2022([]), owner: key(8) }), DirectVenueError)
})

test('classic mints keep the classic program and ATA', () => {
  const classic = { data: Buffer.alloc(82), owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 }
  classic.data[44] = 9
  const info = swapMint(MINT, classic)
  assert.ok(info.tokenProgram.equals(TOKEN_PROGRAM_ID))
  assert.equal(info.decimals, 9)
  assert.ok(mintAta(wallet, MINT).equals(getAssociatedTokenAddressSync(MINT, wallet, false, TOKEN_PROGRAM_ID)))
  assert.ok(mintAta(wallet, MINT, TOKEN_2022_PROGRAM_ID)
    .equals(getAssociatedTokenAddressSync(MINT, wallet, false, TOKEN_2022_PROGRAM_ID)))
  assert.ok(programOf([info], MINT.toBase58()).equals(TOKEN_PROGRAM_ID))
})

test('a Token-2022 output leg pays the composer fee under Token-2022; classic legs are unchanged', () => {
  const SOL = new PublicKey('So11111111111111111111111111111111111111112')
  const inputAta = mintAta(wallet, SOL), outputAta = mintAta(wallet, MINT, TOKEN_2022_PROGRAM_ID)
  const { instruction, offsets } = cpmmSwapInstruction({ wallet, authority: key(20), config: key(21), pool: key(22),
    inputAta, outputAta, inputVault: key(23), outputVault: key(24), inputMint: SOL, outputMint: MINT,
    observation: key(25), outputTokenProgram: TOKEN_2022_PROGRAM_ID }, 1_000_000n, 900_000n)
  assert.deepEqual(offsets, { amountInOffset: 8, minOutOffset: 16 })
  assert.ok(instruction.keys[8].pubkey.equals(TOKEN_PROGRAM_ID) && instruction.keys[9].pubkey.equals(TOKEN_2022_PROGRAM_ID))
  const leg = venueLeg([instruction], instruction.programId, 1_000_000n, 900_000n, inputAta, outputAta, TOKEN_2022_PROGRAM_ID)
  assert.ok(leg.outputTokenProgram?.equals(TOKEN_2022_PROGRAM_ID))
  const composer = key(30)
  const route = composeRoute([{ leg, outputMint: MINT }], wallet, 800_000n, composer)
  const desc = decodeCompose(route.compose.data), at = (i: number) => route.compose.keys[i].pubkey
  const fee = desc.steps[0].fee!
  assert.ok(at(fee.tokenProgramIndex).equals(TOKEN_2022_PROGRAM_ID))
  assert.ok(at(fee.feeAtaIndex).equals(feeAta(MINT, TOKEN_2022_PROGRAM_ID)))
  assert.ok(at(fee.feeAtaIndex).equals(getAssociatedTokenAddressSync(MINT, FEE_RECIPIENT, true, TOKEN_2022_PROGRAM_ID)))
  assert.ok(at(desc.watch[fee.watchSlot]).equals(outputAta))
  // Classic legs carry no program override and keep the classic fee ATA.
  const classicLeg = venueLeg([new TransactionInstruction({ programId: instruction.programId, keys: instruction.keys,
    data: instruction.data })], instruction.programId, 1_000_000n, 900_000n, inputAta, mintAta(wallet, MINT))
  assert.equal(classicLeg.outputTokenProgram, undefined)
  const classic = decodeCompose(composeRoute([{ leg: classicLeg, outputMint: MINT }], wallet, 800_000n, composer).compose.data)
  const classicKeys = composeRoute([{ leg: classicLeg, outputMint: MINT }], wallet, 800_000n, composer).compose.keys
  assert.ok(classicKeys[classic.steps[0].fee!.tokenProgramIndex].pubkey.equals(TOKEN_PROGRAM_ID))
  assert.ok(classicKeys[classic.steps[0].fee!.feeAtaIndex].pubkey.equals(feeAta(MINT)))
})
