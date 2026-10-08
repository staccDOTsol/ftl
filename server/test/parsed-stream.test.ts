import test from 'node:test'
import assert from 'node:assert/strict'
import bs58 from 'bs58'
import { missingMatchedInstruction, parsedToRawEvents, selectParsedPrograms } from '../src/solana/parsed-stream.ts'
import { programIds, specs, RAYDIUM_AMM_V4, rolesOf } from '../src/solana/programs.ts'

const address = (n: number) => bs58.encode(Buffer.alloc(32, n))

test('catalog selection retains raw fallback for unsupported programs and names', () => {
  const catalog = new Map([...specs].filter(([program]) => program !== RAYDIUM_AMM_V4).map(([program, choices]) =>
    [program, { id: program, instructions: [...choices.values()].map(s => s.name) }] as const))
  const dbc = programIds.find(p => [...specs.get(p)!.values()].some(s => s.name === 'initialize_virtual_pool_with_token2022_transfer_hook'))!
  catalog.get(dbc)!.instructions = catalog.get(dbc)!.instructions.filter(n => n !== 'initialize_virtual_pool_with_token2022_transfer_hook')
  const selected = selectParsedPrograms(catalog)
  assert.equal(selected.selected.length, 10)
  assert.deepEqual(new Set(selected.fallback), new Set([RAYDIUM_AMM_V4, dbc]))
  assert.deepEqual(selected.missing[dbc], ['initialize_virtual_pool_with_token2022_transfer_hook'])
})

test('decoded launch maps exact named accounts and metadata to a real FTL event', () => {
  const program = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
  const spec = [...specs.get(program)!.values()].find(s => s.name === 'create_v2')!
  const wallet = address(240)
  const accounts = spec.accounts.map((name, i) => ({ name, pubkey: address(i + 1) }))
  const event = parsedToRawEvents({ transaction: {
    signature: address(241), slot: 123, accountKeys: [wallet, ...accounts.map(a => a.pubkey)],
    status: 'ok', tokenTransfers: [], nativeTransfers: [],
  }, instructions: [{ instructionIndex: 2, innerInstructionIndex: null, programId: program,
    instructionName: spec.name, decoded: { accounts, args: { name: 'Real Token', symbol: 'REAL', uri: 'https://example.test/t.json' } } }] })[0]
  assert.equal(event.kind, 'launch')
  assert.equal(event.n, '2')
  assert.equal(event.wallet, wallet)
  assert.equal(event.mints.length, 1)
  assert.equal(event.meta?.symbol, 'REAL')
  assert.equal(missingMatchedInstruction({ transaction: { signature: address(241) },
    instructions: [{ instructionIndex: 2, innerInstructionIndex: null, programId: program, decoded: { accounts } }],
    matchedIndexes: [0] }, [event]), false)
  assert.equal(missingMatchedInstruction({ transaction: { signature: address(241) },
    instructions: [{ instructionIndex: 2, innerInstructionIndex: null, programId: program, decoded: { accounts } }],
    matchedIndexes: [0] }, []), true)
  assert.equal(missingMatchedInstruction({ transaction: { signature: address(241) },
    instructions: [{ instructionIndex: 2, innerInstructionIndex: null, programId: program, decoded: { accounts } },
      { instructionIndex: 2, innerInstructionIndex: 0, programId: program, instructionName: 'Create',
        decoded: { accounts: [] } }],
    matchedIndexes: [0, 1] }, [event]), false)
})

test('raw liquidity instruction uses exact parsed vault transfers, and omits unsafe amounts', () => {
  const program = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'
  const [disc, spec] = [...specs.get(program)!.entries()].find(([, s]) => s.name === 'deposit')!
  const wallet = address(240), source = address(241)
  const accounts = spec.accounts.map((_, i) => address(i + 1))
  const vaultIndex = rolesOf(spec).vaults[0]
  const mintIndex = rolesOf(spec).mints[0]
  assert.ok(vaultIndex >= 0 && mintIndex >= 0)
  const value = { transaction: {
    signature: address(242), slot: 456, accountKeys: [wallet, source, ...accounts],
    status: 'ok', tokenTransfers: [{ fromTokenAccount: source, toTokenAccount: accounts[vaultIndex],
      fromUserAccount: wallet, toUserAccount: accounts[rolesOf(spec).pool], mint: accounts[mintIndex],
      rawTokenAmount: '2500000', decimals: 6 }], nativeTransfers: [],
  }, instructions: [{ instructionIndex: 1, innerInstructionIndex: 0, programId: program,
    instructionName: spec.name, rawData: bs58.encode(Buffer.from(disc, 'hex')), rawAccounts: accounts }] }
  const event = parsedToRawEvents(value)[0]
  assert.equal(event.kind, 'liq_add')
  assert.equal(event.n, '1.0')
  assert.deepEqual(event.amounts, [{ mint: accounts[mintIndex], ui: -2.5, decimals: 6 }])
  value.transaction.tokenTransfers[0].rawTokenAmount = Number.MAX_SAFE_INTEGER + 1 as any
  assert.equal(parsedToRawEvents(value)[0].amounts, undefined)
})

test('observed DAMM v2 owner alias maps only with otherwise identical account order', () => {
  const program = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'
  const spec = [...specs.get(program)!.values()].find(s => s.name === 'remove_all_liquidity')!
  const wallet = address(240)
  const accounts = spec.accounts.map((name, i) => ({ name: name === 'signer' ? 'owner' : name, pubkey: address(i + 1) }))
  const value = { transaction: { signature: address(241), slot: 789,
    accountKeys: [wallet, ...accounts.map(a => a.pubkey)], status: 'ok', tokenTransfers: [], nativeTransfers: [] },
  instructions: [{ instructionIndex: 4, innerInstructionIndex: null, programId: program,
    instructionName: spec.name, decoded: { accounts, args: {} } }] }
  assert.equal(parsedToRawEvents(value)[0]?.kind, 'liq_remove')
  assert.equal(parsedToRawEvents(value)[0]?.n, '4')
  accounts[0].name = 'unknown'
  assert.equal(parsedToRawEvents(value).length, 0)
})
