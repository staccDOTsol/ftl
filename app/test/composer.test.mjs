import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseComposerQuery, serializeComposerQuery, composerHref, queryString, defaultState, encodeSpec, decodeSpec, batchFromSpec, parseSplit, formatSplit,
  composerProgramHref, composerTokenIntentHref, interfaceKindOf, batchHrefFromInstructions,
  describeType, normalizeValue, coerceArgs, looseJson, typeLabel, learnedRequirements,
  buildBody, intentBody, yoloBody, landBody, landListBody, deriveBody, probeBody, findBody, batchBody, sendBody, instructionSpec,
  parseComposerError, failureOf, ComposerError, composerRequest, summarizeSimulation, builtResultOf, resolvedAccountsOf, signatureOf, verdictTone, verdictLabel,
  ComposerInputError, LAND_LIST_NAME, planResponse, planInstructions, consideredOf,
} from '../src/lib/composer.ts'

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
const MINT = 'D6omLFkwYgkajsVZxGRGVxpESJjTxzCCBnHj8QTxpump'
const PAYER = 'vvr9PcwwFFgnmdZu3cPXTFtxNULFPScYJ7eTd1VdTuv'
const LEARNED = 'BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW'
const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const query = href => Object.fromEntries(new URL(href, 'https://x.test').searchParams)
const roundTrip = state => parseComposerQuery(query(composerHref(state)))

test('the documented deep links open the right tab, prefilled', () => {
  const intent = parseComposerQuery(query(`/composer?intent=buy%200.01%20SOL%20of%20${MINT}&maxPlans=3`))
  assert.equal(intent.tab, 'intent')
  assert.equal(intent.intent, `buy 0.01 SOL of ${MINT}`)
  assert.equal(intent.maxPlans, 3)
  assert.equal(intent.run, false)

  const build = parseComposerQuery(query(`/composer?tab=build&program=${PUMP}&ix=buy&args.amount=1000000&args.max_sol_cost=100000&accounts.mint=${MINT}&run=1`))
  assert.equal(build.tab, 'build')
  assert.equal(build.program, PUMP)
  assert.equal(build.ix, 'buy')
  assert.deepEqual(build.args, { amount: '1000000', max_sol_cost: '100000' })
  assert.deepEqual(build.accounts, { mint: MINT })
  assert.equal(build.run, true)

  const land = parseComposerQuery(query(`/composer?tab=land&program=${LEARNED}&ix=pump_buy_v2&mint=${MINT}&signatures=400&refresh=1`))
  assert.deepEqual([land.tab, land.program, land.ix, land.mint, land.signatures, land.refresh], ['land', LEARNED, 'pump_buy_v2', MINT, '400', true])

  const derive = parseComposerQuery(query(`/composer?tab=derive&program=${PUMP}&account=bonding_curve&accounts.mint=${MINT}`))
  assert.deepEqual([derive.tab, derive.mode, derive.account, derive.accounts.mint], ['accounts', 'derive', 'bonding_curve', MINT])

  const probe = parseComposerQuery(query(`/composer?tab=probe&program=${PUMP}&account=bonding_curve&sweep=mint&values=${MINT},${PAYER}&existingOnly=1`))
  assert.deepEqual([probe.mode, probe.sweep, probe.values, probe.existingOnly], ['probe', 'mint', [MINT, PAYER], true])

  const find = parseComposerQuery(query(`/composer?tab=find&program=${PUMP}&account=BondingCurve&where.complete=false&where.creator=${PAYER}&select=creator,complete&limit=5&force=1`))
  assert.deepEqual([find.mode, find.where, find.select, find.limit, find.force], ['find', { complete: 'false', creator: PAYER }, ['creator', 'complete'], '5', true])
})

test('every tab round-trips through its URL and writes only what it uses', () => {
  const base = { ...defaultState(), payer: PAYER, program: PUMP, ix: 'buy', args: { amount: '5', track_volume: '[false]' }, accounts: { mint: MINT }, intent: 'buy it', maxPlans: 5 }
  const build = { ...base, tab: 'build', argsHex: 'ab01', extra: [{ pubkey: MINT, signer: false, writable: true }], options: { ...defaultState().options, cu: '200000', priorityFee: '1000', tip: '5000', luts: [PAYER], simulate: false, dryRun: true } }
  const back = roundTrip(build)
  for (const key of ['tab', 'program', 'ix', 'args', 'accounts', 'argsHex', 'extra', 'options', 'payer']) assert.deepEqual(back[key], build[key], key)
  assert.equal(back.intent, '', 'the build link carries no intent')

  const intent = roundTrip({ ...base, tab: 'intent', yolo: true, maxAttempts: '4', timeoutMs: '90000', maxSpend: '20000', programs: [PUMP, 'native'] })
  assert.deepEqual([intent.intent, intent.maxPlans, intent.yolo, intent.maxAttempts, intent.timeoutMs, intent.maxSpend, intent.programs], ['buy it', 5, true, '4', '90000', '20000', [PUMP, 'native']])
  assert.equal(intent.program, '', 'the intent link carries no program')

  const idl = roundTrip({ ...base, tab: 'idl', idl: 'learned' })
  assert.deepEqual([idl.tab, idl.program, idl.idl, idl.ix], ['idl', PUMP, 'learned', ''])

  const recipes = roundTrip({ ...base, tab: 'accounts', mode: 'recipes', account: 'bonding_curve' })
  assert.deepEqual([recipes.tab, recipes.mode, recipes.accounts], ['accounts', 'recipes', {}])

  const send = roundTrip({ ...base, tab: 'send', tx: 'AQAB'.repeat(40) })
  assert.equal(send.tx, 'AQAB'.repeat(40))

  assert.equal(composerHref({}), '/composer')
  assert.equal(composerHref({ intent: 'x' }, { run: true }), '/composer?intent=x&run=1')
  assert.equal(queryString({ 'args.amount': '1', values: 'a,b' }), 'args.amount=1&values=a,b')
})

test('junk in a link is dropped instead of reaching a request', () => {
  const state = parseComposerQuery({ tab: 'nope', maxPlans: '99', programs: 'not-a-program,native', cu: '12abc', signatures: '-3', extra: `${MINT}:sw,bad`, lut: 'x', simulate: '0', spec: 'not-base64!', intent: ['first', 'second'] })
  assert.equal(state.tab, 'intent')
  assert.equal(state.maxPlans, 8)
  assert.deepEqual(state.programs, ['native'])
  assert.equal(state.options.cu, '')
  assert.equal(state.signatures, '')
  assert.deepEqual(state.extra, [{ pubkey: MINT, signer: true, writable: true }])
  assert.deepEqual(state.options.luts, [])
  assert.equal(state.options.simulate, false)
  assert.deepEqual(state.batch.instructions, [])
  assert.equal(state.intent, 'first')
  assert.equal(parseComposerQuery({ maxPlans: '0' }).maxPlans, 3)
  assert.equal(parseComposerQuery(undefined).tab, 'intent')
  assert.equal(parseComposerQuery({ program: PUMP, ix: 'buy' }).tab, 'build', 'a bare program + instruction opens Build')
  assert.equal(parseComposerQuery({ program: PUMP }).tab, 'idl')
})

test('batch specs travel as base64url JSON and keep order, mode and split', () => {
  const batch = { mode: 'bundle', split: [[0], [1]], tip: '10000', instructions: [
    { programId: 'native', instruction: 'createAtaIdempotent', args: { mint: MINT, tokenProgram: T22 }, accounts: {} },
    { programId: PUMP, instruction: 'buy', args: { amount: '1000000', max_sol_cost: '100000', track_volume: [false] }, accounts: { mint: MINT }, argsHex: 'ff' },
  ] }
  const spec = encodeSpec({ instructions: batch.instructions, bundle: { split: batch.split, tipLamports: 10000 } })
  assert.match(spec, /^[A-Za-z0-9_-]+$/)
  const state = parseComposerQuery({ tab: 'batch', spec })
  assert.deepEqual(state.batch, batch)
  assert.deepEqual(roundTrip({ ...defaultState(), tab: 'batch', batch }).batch, batch)
  assert.equal(parseComposerQuery({ spec }).tab, 'batch')
  assert.deepEqual(decodeSpec(encodeSpec({ note: 'ünïcødé ✓' })), { note: 'ünïcødé ✓' })
  assert.equal(decodeSpec('%%%'), null)
  assert.equal(batchFromSpec({ instructions: [{ instruction: 'x' }] }).instructions.length, 0, 'a step without a program is dropped')
  assert.equal(batchFromSpec({ instructions: [], compose: {} }).mode, 'compose')
  assert.deepEqual(parseSplit('0 | 1, 2 |'), [[0], [1, 2]])
  assert.equal(formatSplit([[0], [1, 2]]), '0 | 1,2')
})

test('entry-point links: program inspector and token page', () => {
  assert.equal(composerProgramHref(PUMP, 'published'), `/composer?tab=build&program=${PUMP}`)
  assert.equal(composerProgramHref(LEARNED, 'learned', 'collect_fee'), `/composer?tab=land&program=${LEARNED}&ix=collect_fee`)
  assert.equal(composerTokenIntentHref(MINT), `/composer?intent=buy%200.01%20SOL%20of%20${MINT}`)
  assert.equal(interfaceKindOf('published', 'known'), 'published')
  assert.equal(interfaceKindOf('published+composer', 'ready'), 'published')
  assert.equal(interfaceKindOf('shipped', 'known'), 'published')
  assert.equal(interfaceKindOf('composer', 'ready'), 'learned')
  assert.equal(interfaceKindOf(null, 'partial'), 'learned')
  assert.equal(interfaceKindOf(null, 'queued'), 'published')
  const attempt = [{ programId: 'native', instruction: 'createAtaIdempotent', args: { mint: MINT }, accounts: {} }, { programId: PUMP, instruction: 'buy_exact_sol_in', args: { spendable_sol_in: 1000000, min_tokens_out: 1, track_volume: false }, accounts: { mint: MINT } }]
  const href = batchHrefFromInstructions(attempt, PAYER)
  const reopened = parseComposerQuery(query(href))
  assert.equal(reopened.tab, 'batch')
  assert.equal(reopened.payer, PAYER)
  assert.deepEqual(reopened.batch.instructions.map(step => step.instruction), ['createAtaIdempotent', 'buy_exact_sol_in'])
  assert.equal(batchHrefFromInstructions(undefined), null)
})

const IDL = {
  address: PUMP,
  types: [
    { name: 'OptionBool', type: { kind: 'struct', fields: ['bool'] } },
    { name: 'Params', type: { kind: 'struct', fields: [{ name: 'fee', type: 'u16' }, { name: 'owner', type: 'pubkey' }, { name: 'limits', type: { option: { vec: 'u64' } } }] } },
    { name: 'Side', type: { kind: 'enum', variants: [{ name: 'Buy' }, { name: 'Sell', fields: [{ name: 'min_out', type: 'u64' }] }, { name: 'Pair', fields: ['u8', 'bool'] }] } },
  ],
  accounts: [{ name: 'Legacy', type: { kind: 'struct', fields: [{ name: 'x', type: 'i8' }] } }],
}

test('Anchor types become form models and normalize to the service’s JSON encoding', () => {
  assert.equal(typeLabel({ option: { vec: 'publicKey' } }), 'Option<Vec<pubkey>>')
  assert.equal(typeLabel({ array: ['u8', 32] }), '[u8; 32]')
  assert.equal(typeLabel({ defined: { name: 'OptionBool', generics: [] } }), 'OptionBool')
  const optionBool = describeType({ defined: { name: 'OptionBool' } }, IDL)
  assert.equal(optionBool.kind, 'tuple')
  assert.deepEqual(normalizeValue(optionBool, [true]), [true], 'tuple structs are arrays')
  const u64 = describeType('u64')
  assert.equal(normalizeValue(u64, '18446744073709551615'), '18446744073709551615', 'wide integers stay decimal strings')
  assert.equal(normalizeValue(describeType('u16'), '7'), 7)
  assert.throws(() => normalizeValue(describeType('u8'), '256'), /between 0 and 255/)
  assert.throws(() => normalizeValue(describeType('i8'), '-129'), /between -128 and 127/)
  assert.throws(() => normalizeValue(u64, '1.5'), /whole number/)
  assert.throws(() => normalizeValue(describeType('pubkey'), 'nope'), /public key/)
  const params = describeType({ defined: 'Params' }, IDL)
  assert.deepEqual(normalizeValue(params, { fee: '30', owner: PAYER, limits: ['1', '2'] }), { fee: 30, owner: PAYER, limits: ['1', '2'] })
  assert.deepEqual(normalizeValue(params, { fee: '30', owner: PAYER, limits: null }).limits, null)
  const side = describeType({ defined: { name: 'Side' } }, IDL)
  assert.equal(normalizeValue(side, 'Buy'), 'Buy', 'unit variants are names')
  assert.deepEqual(normalizeValue(side, { sell: { min_out: '9' } }), { Sell: { min_out: '9' } }, 'variant names match loosely')
  assert.deepEqual(normalizeValue(side, { Pair: ['3', 'true'] }), { Pair: [3, true] })
  assert.throws(() => normalizeValue(side, 'Hold'), /choose one of Buy, Sell, Pair/)
  assert.equal(describeType({ defined: 'Legacy' }, IDL).kind, 'struct', 'legacy IDLs embed types in accounts')
  assert.equal(describeType({ defined: 'Missing' }, IDL).kind, 'raw')
  assert.deepEqual(normalizeValue(describeType({ array: ['u8', 2] }), ['1', '2']), [1, 2])
  assert.deepEqual(normalizeValue(describeType('bytes'), '0x0aff'), [10, 255])
})

test('URL text arguments coerce with field-level errors', () => {
  const defs = [{ name: 'amount', type: 'u64' }, { name: 'max_sol_cost', type: 'u64' }, { name: 'track_volume', type: { defined: { name: 'OptionBool', generics: [] } } }, { name: 'memo', type: { option: 'string' } }, { name: 'owner', type: 'pubkey', optional: true }]
  const ok = coerceArgs(defs, { amount: '1000000', max_sol_cost: '100000', track_volume: '[true]' }, IDL)
  assert.deepEqual(ok, { value: { amount: '1000000', max_sol_cost: '100000', track_volume: [true], memo: null }, errors: {} })
  const defaults = coerceArgs(defs, { amount: '1', max_sol_cost: '2' }, IDL)
  assert.deepEqual(defaults.value.track_volume, [false], 'an untouched structured arg uses its default')
  const bad = coerceArgs(defs, { amount: 'ten', track_volume: '[tru' }, IDL)
  assert.deepEqual(Object.keys(bad.errors).sort(), ['amount', 'max_sol_cost', 'track_volume'])
  assert.match(bad.errors.amount, /whole number/)
  assert.equal(bad.errors.track_volume, 'not valid JSON')
  assert.deepEqual([looseJson('42'), looseJson('{"u16be":19}'), looseJson('18446744073709551615'), looseJson(PAYER), looseJson('true')], [42, { u16be: 19 }, '18446744073709551615', PAYER, true])
})

const LEARNED_IDL = { address: LEARNED, metadata: { source: 'reconstructed from landed transactions' }, caveats: ['argument layout is NOT decoded'], instructions: [
  { name: 'collect_fee', argBytes: [17], argsHex: ['8f91956a00000000a08601000000000000'], accounts: [
    { name: 'account_0', signer: true, writable: true, evidence: 'varies across samples' },
    { name: 'account_1', signer: false, writable: true },
    { name: 'account_2', address: 'AVUCZyuT35YSuj4RH7fwiyPu82Djn2Hfg7y2ND2XcnZH', writable: true },
    { name: 'account_3', pda: { seeds: [] } },
  ] },
] }

test('request bodies: build (published, learned, native), intent, yolo and land', () => {
  const state = { ...defaultState(), program: PUMP, ix: 'buy', args: { amount: '1000000', max_sol_cost: '100000' }, accounts: { mint: MINT }, options: { ...defaultState().options, priorityFee: '1000' } }
  const defs = [{ name: 'amount', type: 'u64' }, { name: 'max_sol_cost', type: 'u64' }, { name: 'track_volume', type: { defined: { name: 'OptionBool' } } }]
  assert.deepEqual(buildBody(state, PAYER, { kind: 'published', idl: IDL }, defs), {
    payer: PAYER, programId: PUMP, instruction: 'buy', args: { amount: '1000000', max_sol_cost: '100000', track_volume: [false] }, accounts: { mint: MINT },
    options: { priorityFeeMicroLamports: 1000, simulate: true },
  })
  assert.throws(() => buildBody(state, null, { kind: 'published', idl: IDL }, defs), error => error instanceof ComposerInputError && error.field === 'payer')
  assert.throws(() => buildBody({ ...state, args: {} }, PAYER, { kind: 'published', idl: IDL }, defs), /args.amount: enter u64/)
  assert.throws(() => buildBody({ ...state, accounts: { mint: 'bad' } }, PAYER, { kind: 'published', idl: IDL }, defs), /accounts.mint/)
  assert.throws(() => buildBody({ ...state, options: { ...state.options, cu: '2000000' } }, PAYER, { kind: 'published', idl: IDL }, defs), /computeUnitLimit: must be at most 1400000/)

  const learned = buildBody({ ...state, program: LEARNED, ix: 'collect_fee', args: {}, accounts: { account_1: MINT }, argsHex: '8F91' }, PAYER, { kind: 'learned', learned: LEARNED_IDL }, [])
  assert.equal(learned.idl, LEARNED_IDL, 'learned instructions send the whole learned IDL')
  assert.equal(learned.programId, undefined)
  assert.equal(learned.argsHex, '8f91')
  assert.deepEqual(learned.accounts, { account_1: MINT, account_0: PAYER }, 'blank signer slots are the payer')
  assert.deepEqual(learnedRequirements(LEARNED_IDL.instructions[0]).accounts, { autoFilled: ['account_2'], derived: ['account_3'], mustProvide: [
    { name: 'account_0', signer: true, writable: true, optional: false, evidence: 'varies across samples' }, { name: 'account_1', signer: false, writable: true, optional: false, evidence: undefined }] })

  const nativeDefs = [{ name: 'mint', type: 'pubkey' }, { name: 'owner', type: 'pubkey', optional: true }, { name: 'tokenProgram', type: 'pubkey', optional: true }]
  const native = buildBody({ ...state, program: 'native', ix: 'createAtaIdempotent', args: { mint: MINT, tokenProgram: T22 }, accounts: {}, options: defaultState().options }, PAYER, { kind: 'native' }, nativeDefs)
  assert.deepEqual(native, { payer: PAYER, programId: 'native', instruction: 'createAtaIdempotent', args: { mint: MINT, tokenProgram: T22 }, accounts: {}, options: { simulate: true } })
  const spec = instructionSpec({ ...state, program: 'native', ix: 'transfer', args: { to: MINT, lamports: '5' }, accounts: {} }, { kind: 'native' }, [{ name: 'to', type: 'pubkey' }, { name: 'lamports', type: 'u64' }])
  assert.deepEqual(spec, { programId: 'native', instruction: 'transfer', args: { to: MINT, lamports: '5' }, accounts: {} })

  const intent = { ...defaultState(), intent: `  buy 0.001 SOL of ${MINT} `, maxPlans: 2, programs: [PUMP] }
  assert.deepEqual(intentBody(intent, PAYER), { intent: `buy 0.001 SOL of ${MINT}`, payer: PAYER, maxPlans: 2, programs: [PUMP] })
  assert.throws(() => intentBody({ ...intent, intent: ' ' }, PAYER), /intent/)
  assert.throws(() => intentBody({ ...intent, programs: ['6EF8rre'] }, PAYER), /programs: 6EF8rre is not a program id/, 'a half-typed program id is caught at request time')
  assert.deepEqual(yoloBody({ ...intent, maxAttempts: '2', timeoutMs: '45000' }, PAYER), { intent: `buy 0.001 SOL of ${MINT}`, payer: PAYER, maxAttempts: 2, timeoutMs: 45000, programs: [PUMP] })
  assert.throws(() => yoloBody({ ...intent, maxAttempts: '9' }, PAYER), /maxAttempts: must be at most 8/)
  assert.throws(() => yoloBody({ ...intent, timeoutMs: '300000' }, PAYER), /timeoutMs/)

  assert.deepEqual(landBody({ ...defaultState(), program: LEARNED, ix: 'pump_buy_v2', mint: MINT, signatures: '400', refresh: true }, PAYER), { programId: LEARNED, instruction: 'pump_buy_v2', payer: PAYER, mint: MINT, signatures: 400, refresh: true })
  assert.deepEqual(landListBody(LEARNED, null), { programId: LEARNED, instruction: LAND_LIST_NAME, payer: '11111111111111111111111111111111' })
})

test('request bodies: derive, probe, find, batch and send', () => {
  const state = { ...defaultState(), program: PUMP, account: 'bonding_curve', accounts: { mint: MINT, creator: '' }, args: { index: '{"u16be":19}' } }
  assert.deepEqual(deriveBody(state), { programId: PUMP, account: 'bonding_curve', accounts: { mint: MINT }, args: { index: { u16be: 19 } } })
  assert.deepEqual(probeBody({ ...state, sweep: 'mint', values: [MINT, PAYER], existingOnly: true }), { programId: PUMP, account: 'bonding_curve', accounts: {}, args: { index: { u16be: 19 } }, sweep: 'mint', values: [MINT, PAYER], existingOnly: true })
  assert.throws(() => probeBody({ ...state, sweep: 'mint' }), /values/)
  assert.deepEqual(findBody({ ...state, account: 'BondingCurve', where: { complete: 'true', creator: PAYER, empty: ' ' }, select: ['creator'], limit: '3', force: true }, { complete: 'bool' }),
    { programId: PUMP, account: 'BondingCurve', where: { complete: true, creator: PAYER }, select: ['creator'], limit: 3, force: true })
  const batch = { mode: 'bundle', split: [[0], [1]], tip: '1000', instructions: [{ programId: 'native', instruction: 'syncNative', args: {}, accounts: {} }, { programId: PUMP, instruction: 'buy', args: {}, accounts: {} }] }
  assert.deepEqual(batchBody({ ...defaultState(), batch }, PAYER), { payer: PAYER, instructions: batch.instructions, bundle: { split: [[0], [1]], tipLamports: 1000 }, options: { simulate: true } })
  assert.deepEqual(batchBody({ ...defaultState(), batch: { ...batch, mode: 'compose' } }, PAYER).compose, {})
  assert.throws(() => batchBody({ ...defaultState(), batch: { ...batch, split: [[0], [4]] } }, PAYER), /split/)
  assert.throws(() => batchBody({ ...defaultState(), batch: { ...batch, instructions: [] } }, PAYER), /instructions/)
  assert.deepEqual(sendBody(` ${'A'.repeat(120)}== `), { transaction: `${'A'.repeat(120)}==` })
  assert.throws(() => sendBody('not a transaction'), /base64/)
})

test('service errors keep the service’s words: serde text, JSON guidance, stale blockhash', () => {
  const serde = parseComposerError(422, 'Failed to deserialize the JSON body into the target type: missing field `payer` at line 1 column 2')
  assert.deepEqual([serde.message, serde.missingField, serde.stale, serde.guidance], ['missing field `payer`', 'payer', false, null])
  const guided = parseComposerError(400, JSON.stringify({ error: 'cannot derive accounts [mint] for `buy` — supply them in `accounts`', guidance: { missing: ['mint'], fix: 'add each of these' } }))
  assert.equal(guided.message, 'cannot derive accounts [mint] for `buy` — supply them in `accounts`')
  assert.deepEqual(guided.guidance.missing, ['mint'])
  const relay = parseComposerError(400, JSON.stringify({ error: 'rpc sendTransaction error: {"code":-32002,"message":"Transaction simulation failed: Blockhash not found"}', guidance: { note: 'A blockhash expires in about 60 seconds, so a transaction built minutes ago is stale and must be rebuilt rather than resent.' } }))
  assert.equal(relay.stale, true)
  assert.equal(relay.rebuild, true)
  const other = parseComposerError(400, JSON.stringify({ error: 'rpc sendTransaction error: insufficient funds', guidance: { note: 'must be rebuilt rather than resent.' } }))
  assert.deepEqual([other.stale, other.rebuild], [false, true], 'the relay’s guidance asks for a rebuild even when the blockhash is fine')
  assert.equal(failureOf(new Error('boom')).message, 'boom')
})

test('composerRequest returns JSON, raises ComposerError with guidance, and reports an unreachable service', async () => {
  const original = globalThis.fetch
  const calls = []
  try {
    globalThis.fetch = async (url, init) => { calls.push([url, init?.method, init?.body]); return new Response(JSON.stringify({ address: 'x', name: 'bonding_curve' }), { status: 200 }) }
    assert.deepEqual(await composerRequest('/derive', { a: 1 }, undefined, 'https://svc.test'), { address: 'x', name: 'bonding_curve' })
    assert.deepEqual(calls[0], ['https://svc.test/derive', 'POST', '{"a":1}'])
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'no published IDL account at X for program Y' }), { status: 400 })
    await assert.rejects(composerRequest('/idl/Y', undefined, undefined, 'https://svc.test'), error => error instanceof ComposerError && error.failure.status === 400 && /no published IDL/.test(error.message))
    globalThis.fetch = async () => { throw new TypeError('fetch failed') }
    await assert.rejects(composerRequest('/health', undefined, undefined, 'https://svc.test'), /Could not reach the Composer/)
  } finally { globalThis.fetch = original }
})

test('simulation, accounts and built transactions are summarized from real response shapes', () => {
  const failed = summarizeSimulation({ kind: 'transaction', error: { code: 3012, failingProgram: PUMP, instructionIndex: 0, message: 'The program expected this account to be already initialized', name: 'AccountNotInitialized', note: 'from Anchor logs', thrownIn: null },
    result: { value: { err: { InstructionError: [0, { Custom: 3012 }] }, fee: 5000, logs: ['Program log: Instruction: Buy'], unitsConsumed: 9548 } } })
  assert.deepEqual([failed.ok, failed.errorName, failed.errorCode, failed.failingProgram, failed.instructionIndex, failed.unitsConsumed, failed.fee, failed.logs.length], [false, 'AccountNotInitialized', '3012', PUMP, 0, 9548, 5000, 1])
  const clean = summarizeSimulation({ kind: 'transaction', result: { value: { err: null, logs: [], unitsConsumed: 1200 } } })
  assert.equal(clean.ok, true)
  const bundle = summarizeSimulation({ kind: 'bundle', result: { value: { summary: { failed: { error: { TransactionFailure: [[0, 0], 'Error processing Instruction 0: custom program error: 0xbc4'] }, tx_signature: '1' } }, transactionResults: [{ err: { InstructionError: [0, { Custom: 3012 }] }, logs: [] }] } } })
  assert.deepEqual([bundle.ok, bundle.errorMessage, bundle.bundle.length, bundle.bundle[0].ok], [false, 'Error processing Instruction 0: custom program error: 0xbc4', 1, false])
  assert.equal(summarizeSimulation(null), null)

  const single = builtResultOf({ blockhash: 'B', bytes: 660, mode: 'single', signers: [PAYER], transaction: 'AQ==', resolvedAccounts: [{ name: 'mint', pubkey: MINT, signer: false, writable: false, source: 'provided' }] })
  assert.deepEqual(single, { mode: 'single', blockhash: 'B', submit: null, jito: null, transactions: [{ transaction: 'AQ==', signers: [PAYER], bytes: 660, steps: null }] })
  assert.deepEqual(resolvedAccountsOf(single.transactions.length ? { resolvedAccounts: [{ name: 'mint', pubkey: MINT, signer: false, writable: false, source: 'provided' }] } : {}), [{ step: null, accounts: [{ name: 'mint', pubkey: MINT, signer: false, writable: false, optional: false, source: 'provided' }] }])
  const bundled = builtResultOf({ mode: 'bundle', blockhash: 'B', submit: 'sign every entry in order', bundle: [{ transaction: 'AA==', signers: [PAYER], bytes: 1, steps: [0] }, { transaction: 'AB==', signers: [PAYER], bytes: 2, steps: [1] }],
    jito: { endpoints: ['https://mainnet.block-engine.jito.wtf/api/v1/bundles', 'https://evil.example/api'], rules: ['at most 5 transactions per bundle'], tipAccounts: ['T'] } })
  assert.equal(bundled.mode, 'bundle')
  assert.deepEqual(bundled.jito.endpoints, ['https://mainnet.block-engine.jito.wtf/api/v1/bundles'], 'only Jito block engines are used for bundles')
  assert.deepEqual(bundled.transactions.map(tx => tx.steps), [[0], [1]])
  assert.equal(builtResultOf({ error: 'x' }).mode, 'none')
  assert.deepEqual(resolvedAccountsOf({ steps: [{ instruction: 'buy', programId: PUMP, resolvedAccounts: [] }] })[0].step, `1. buy · ${PUMP}`)
  assert.deepEqual([signatureOf({ signature: 's' }), signatureOf('s2'), signatureOf({ result: 's3' }), signatureOf({})], ['s', 's2', 's3', null])
  assert.deepEqual([verdictTone('simulated'), verdictTone('simulation-failed'), verdictTone('unbuildable'), verdictTone('built-unsimulated'), verdictTone('gave-up')], ['good', 'bad', 'muted', 'warn', 'bad'])
  assert.equal(verdictLabel('simulated'), 'Simulates clean')
})

test('intent plans: the real response shape (count of programs, build-failed plans with steps)', () => {
  const failed = { bundle: null, confidence: 0.2, detail: 'native.transfer: missing `to` (base58 pubkey)', land: null, transaction: null, verdict: 'build-failed', summary: 'Wrap 0.001 SOL', why: 'needs syncNative',
    instructions: [{ accounts: {}, args: { mint: 'So11111111111111111111111111111111111111112' }, instruction: 'createAtaIdempotent', programId: 'native' }, { accounts: { destination: '<wSOL ATA of user>' }, args: { amount: '1000000' }, instruction: 'transfer', programId: 'native' }] }
  assert.equal(planResponse(failed), null, 'nothing to sign')
  assert.deepEqual(planInstructions(failed).map(step => step.instruction), ['createAtaIdempotent', 'transfer'])
  assert.equal(verdictTone(failed.verdict), 'bad')
  assert.equal(verdictLabel(failed.verdict), 'Build failed')
  const signable = { ...failed, verdict: 'simulated', transaction: 'AQ==' }
  assert.equal(planResponse(signable), signable)
  assert.equal(planResponse({ ...failed, land: { transaction: 'AQ==', simulation: {} } }).transaction, 'AQ==')
  assert.equal(builtResultOf(planResponse({ ...failed, bundle: [{ transaction: 'AA==' }, { transaction: 'AB==' }] })).mode, 'bundle')
  assert.deepEqual(consideredOf(3), { count: 3, ids: [] })
  assert.deepEqual(consideredOf([PUMP]), { count: 1, ids: [PUMP] })
  assert.deepEqual(consideredOf(undefined), { count: 0, ids: [] })
})
