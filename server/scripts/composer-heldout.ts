// Freeze a real Composer interface, then test strictly later mainnet
// transactions. Offline replay needs no RPC key and preserves failures.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import nacl from 'tweetnacl'
import { decodeV1 } from '../src/solana/transaction-v1.ts'
import { parseWire } from '../src/solana/decode.ts'
import { rpcDiscoveryTransaction, validProgram, type InstructionSample } from '../src/solana/program-observation.ts'
import { interfaceMatch, runtimeEventSample, selectorFor } from '../src/solana/program-interface.ts'
import WebSocket from 'ws'

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const flatten = (accounts: any[]): any[] => (accounts ?? []).flatMap(account => account.accounts ? flatten(account.accounts) : [account])
const args = process.argv.slice(2)
const option = (name: string, fallback?: string) => { const at = args.indexOf(`--${name}`); return at < 0 ? fallback : args[at + 1] }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const CONTROL_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'

export function authenticTransaction(row: any) {
  if (!Array.isArray(row.transaction) || row.transaction[1] !== 'base64') throw new Error('Proof needs exact base64 wire transactions')
  const bytes = Buffer.from(row.transaction[0], 'base64'), wire = parseWire(bytes)
  let signatures: Uint8Array[], message: Uint8Array, keys: Uint8Array[], header: { required: number; readonlySigned: number; readonlyUnsigned: number }
  if (wire.version === 1) {
    const decoded = decodeV1(bytes)
    signatures = decoded.signatures; message = decoded.message; keys = decoded.keys
    header = { required: bytes[1], readonlySigned: bytes[2], readonlyUnsigned: bytes[3] }
  } else {
    const decoded = VersionedTransaction.deserialize(bytes)
    signatures = decoded.signatures; message = decoded.message.serialize(); keys = decoded.message.staticAccountKeys.map(key => key.toBytes())
    header = { required: decoded.message.header.numRequiredSignatures, readonlySigned: decoded.message.header.numReadonlySignedAccounts, readonlyUnsigned: decoded.message.header.numReadonlyUnsignedAccounts }
  }
  if (!signatures.every((signature, i) => nacl.sign.detached.verify(message, signature, keys[i]))) throw new Error('A transaction signature did not verify')
  return { bytes, wire, header, signaturesVerified: signatures.length }
}

function recipeBytes(seed: any, accounts: any[], actual: InstructionSample['accounts']): Buffer | null {
  if (seed?.kind === 'const' && Array.isArray(seed.value)) return Buffer.from(seed.value)
  if (seed?.kind === 'const' && typeof seed.value === 'string') return Buffer.from(seed.value)
  if (seed?.kind === 'account' && typeof seed.path === 'string' && !seed.path.includes('.')) {
    const index = accounts.findIndex(account => account.name === seed.path)
    if (index >= 0) return Buffer.from(new PublicKey(actual[index].address).toBytes())
  }
  return null
}

// Anchor's IDL account: createWithSeed(findProgramAddress([], program), 'anchor:idl', program).
export async function anchorIdlAddress(program: string) {
  const id = new PublicKey(program), [base] = PublicKey.findProgramAddressSync([], id)
  return (await PublicKey.createWithSeed(base, 'anchor:idl', id)).toBase58()
}

export function verifyHeldout(idl: any, rows: any[], frozenAfterSlot: number) {
  let transactions = 0, instructions = 0, matched = 0, runtimeEvents = 0, signaturesVerified = 0
  let pdaVerified = 0, pdaUnresolved = 0, opaqueArguments = 0
  const failures: any[] = [], decoded: any[] = [], notInvoked: any[] = [], counterCorrections: any[] = []
  const trainingExamples = new Set(idl.instructions.flatMap((ix: any) => ix.exampleSignatures ?? []))
  for (const row of rows) {
    if (!Number.isSafeInteger(row.slot) || row.slot <= frozenAfterSlot) throw new Error('A held-out transaction is not strictly after the training boundary')
    const authentic = authenticTransaction(row)
    const tx = rpcDiscoveryTransaction(row)
    if (trainingExamples.has(tx.sig)) throw new Error('Training example leaked into the held-out set')
    const staticLength = authentic.wire.keys.length
    tx.keyFlags = tx.keys.map((_, i) => ({ signer: i < authentic.header.required, writable: i < authentic.header.required
      ? i < authentic.header.required - authentic.header.readonlySigned : i < staticLength
        ? i < staticLength - authentic.header.readonlyUnsigned : i < staticLength + (row.meta.loadedAddresses?.writable?.length ?? 0) }))
    signaturesVerified += authentic.signaturesVerified
    const programInstructions = tx.ixs.filter(ix => ix.prog === idl.address)
    // Listed because the program is a referenced account, not invoked: neither a hit nor a miss.
    if (!programInstructions.length) { notInvoked.push({ signature: tx.sig, slot: tx.slot }); continue }
    transactions++
    for (const instruction of programInstructions) {
      const sample: InstructionSample = { signature: tx.sig, n: instruction.n, inner: instruction.n.includes('.'), data: Buffer.from(instruction.data).toString('base64'),
        accounts: instruction.accts.map(index => ({ address: tx.keys[index]!, signer: tx.keyFlags![index].signer, writable: tx.keyFlags![index].writable })) }
      if (runtimeEventSample(sample, idl.address)) {
        // An Anchor event self-CPI is a log record, not a callable instruction. The old counter scored it as a miss.
        runtimeEvents++
        counterCorrections.push({ signature: tx.sig, slot: tx.slot, n: instruction.n, reason: 'Anchor event self-CPI (e445a52e51cb9a1d via __event_authority); excluded, not decoded' })
        continue
      }
      instructions++
      const candidates = idl.instructions.filter((ix: any) => interfaceMatch(ix, sample, true))
      let chosen: any, derived: any[] = []
      for (const candidate of candidates) {
        const accounts = flatten(candidate.accounts), recipes: any[] = []
        let valid = true
        for (const [index, account] of accounts.entries()) {
          if (!account.pda) continue
          const seeds = account.pda.seeds.map((seed: any) => recipeBytes(seed, accounts, sample.accounts))
          const programBytes = account.pda.program ? recipeBytes(account.pda.program, accounts, sample.accounts) : new PublicKey(idl.address).toBuffer()
          if (seeds.some((seed: any) => seed === null) || !programBytes) { recipes.push({ account: account.name, verdict: 'unresolved' }); continue }
          try {
            const expected = PublicKey.findProgramAddressSync(seeds, new PublicKey(programBytes))[0].toBase58()
            const agrees = expected === sample.accounts[index].address
            recipes.push({ account: account.name, verdict: agrees ? 'verified' : 'mismatch', expected, observed: sample.accounts[index].address })
            if (!agrees) valid = false
          } catch { valid = false }
        }
        if (valid) { chosen = candidate; derived = recipes; break }
      }
      if (!chosen) {
        failures.push({ signature: tx.sig, slot: tx.slot, n: instruction.n, reason: candidates.length ? 'PDA recipe mismatch' : 'Selector/account/payload shape not covered',
          selector: Buffer.from(instruction.data).subarray(0, idl.evidence?.discriminatorBytes ?? 8).toString('hex'), bytes: instruction.data.length, accounts: sample.accounts.length })
        continue
      }
      matched++
      pdaVerified += derived.filter(recipe => recipe.verdict === 'verified').length
      pdaUnresolved += derived.filter(recipe => recipe.verdict === 'unresolved').length
      const selector = selectorFor(chosen), argsHex = Buffer.from(instruction.data).subarray(selector.length).toString('hex')
      const rebuilt = Buffer.concat([Buffer.from(selector), Buffer.from(argsHex, 'hex')])
      if (!rebuilt.equals(Buffer.from(instruction.data))) throw new Error('Instruction bytes did not round-trip')
      const opaque = argsHex.length > 0 && !chosen.args?.length
      if (opaque) opaqueArguments++
      decoded.push({ signature: tx.sig, slot: tx.slot, n: instruction.n, instruction: chosen.name, nameSource: chosen.nameSource ?? null,
        selectorHex: Buffer.from(selector).toString('hex'), argsHex, argumentSemantics: opaque ? 'opaque; no argument names or types invented' : 'IDL-declared',
        accounts: flatten(chosen.accounts).map((account, i) => ({ name: account.name, address: sample.accounts[i].address })),
        pdaRecipes: derived, wireRoundTrip: true })
    }
  }
  return { transactions, instructions, matched, coverage: instructions ? matched / instructions : 0, runtimeEvents, signaturesVerified,
    pdaVerified, pdaUnresolved, opaqueArguments, failures, decoded, notInvoked, counterCorrections,
    legacyCounter: { tested: instructions + runtimeEvents, matched, note: 'The pre-fix counter, which also scored Anchor event self-CPIs as misses' },
    scope: 'Held-out structural decoding: instruction selectors, ordered accounts, payload lengths, independently derived PDAs and signed wire bytes. Opaque argument semantics are explicitly unresolved.' }
}

async function rpc(method: string, params: unknown[]) {
  // Public mainnet RPC needs no key; set SOLANA_RPC_URL to use your own provider.
  const endpoint = process.env.SOLANA_RPC_URL ?? process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com'
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) })
    let json: any
    try { json = await response.json() } catch { json = {} }
    if (response.ok && !json.error) return json.result
    if (response.status !== 429 && json.error?.code !== -32005) throw new Error(`Proof RPC failed: HTTP ${response.status}, code ${json.error?.code ?? 'none'}`)
    await sleep(Math.max(Number(response.headers.get('retry-after') ?? 0) * 1000, Math.min(500 * 2 ** attempt, 20_000)))
  }
  throw new Error('Proof RPC remained rate-limited')
}

async function catalogs(program: string, control = false) {
  const results: any[] = []
  for (const [name, url] of [
    ['Solana Foundation (canonical PMP, fallback PMP, Anchor)', `https://idl.solana.com/api/idl?programId=${program}`],
    ['SolanaFM IDL metadata catalog', `https://api.solana.fm/v0/programs/meta/${program}`],
  ]) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) }), text = await response.text()
      let body: any
      try { body = JSON.parse(text) } catch { body = text.slice(0, 500) }
      const listed = !!(response.ok && (body?.idl || body?.content || body?.result?.idlInformation?.idl || body?.result?.programInformation?.hasIdl === true))
      const miss = response.status === 404 || (response.ok && body?.result?.programInformation?.hasIdl === false)
      results.push({ name, url, checkedAt: new Date().toISOString(), httpStatus: response.status, verdict: listed ? 'listed' : miss ? 'missing' : 'unavailable', response: body })
      if (listed && !control) throw new Error(`Chosen program already has an IDL in ${name}`)
    } catch (error) {
      if ((error as Error).message.startsWith('Chosen program')) throw error
      results.push({ name, url, checkedAt: new Date().toISOString(), verdict: 'unavailable', error: 'Catalog request failed; not counted as an absence' })
    }
  }
  const key = process.env.HELIUS_API_KEY
  if (key) results.push(await new Promise(resolve => {
    const socket = new WebSocket('wss://fs-beta.helius-rpc.com', { headers: { 'x-api-key': key } })
    const name = 'Helius describeProgram parser catalog', url = 'wss://fs-beta.helius-rpc.com'
    const finish = (result: any) => { clearTimeout(timer); socket.terminate(); resolve({ name, url, checkedAt: new Date().toISOString(), ...result }) }
    const timer = setTimeout(() => finish({ verdict: 'unavailable', error: 'Catalog timeout; not counted as an absence' }), 12_000)
    socket.on('open', () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'describeProgram', params: [{ program }] })))
    socket.on('message', data => {
      let json: any
      try { json = JSON.parse(String(data)) } catch { return }
      if (json.id !== 1) return
      const listed = json.result?.id === program && Array.isArray(json.result.instructions) && json.result.instructions.length > 0
      const missing = /not found|unknown program|not supported|not registered/i.test(json.error?.message ?? '') || json.result === null
      finish({ verdict: listed ? 'listed' : missing ? 'missing' : 'unavailable', response: json })
    })
    socket.on('error', () => finish({ verdict: 'unavailable', error: 'Catalog connection failed; not counted as an absence' }))
  }))
  if (control) return results
  if (results.some(result => result.verdict === 'listed')) throw new Error('Chosen program is already present in a parser catalog')
  if (!results.some(result => result.name.startsWith('Solana Foundation') && result.verdict === 'missing')) throw new Error('Canonical PMP/Anchor catalog absence was not established')
  return results
}

function directoryFor(output: string) {
  const directory = path.resolve(output)
  if (!fs.existsSync(path.dirname(directory))) throw new Error('Proof output parent must already exist')
  fs.mkdirSync(directory, { recursive: true })
  return directory
}

// Successful transactions strictly after a slot: the earliest collected, with no filtering on whether they decode.
async function laterTransactions(program: string, afterSlot: number, sampleCount: number) {
  const heldout = new Map<string, any>()
  const failedListed = new Set<string>()
  const deadline = Date.now() + Number(option('wait', '120')) * 1000
  while (heldout.size < sampleCount && Date.now() < deadline) {
    await sleep(3000)
    const signatures = await rpc('getSignaturesForAddress', [program, { limit: 100, commitment: 'confirmed' }])
    for (const signature of signatures) if (signature.slot > afterSlot) {
      if (signature.err) { failedListed.add(signature.signature); continue }
      heldout.set(signature.signature, signature)
    }
  }
  if (heldout.size < sampleCount) throw new Error(`Only ${heldout.size} later successful transactions arrived; proof remains incomplete`)
  const signatures = [...heldout.values()].sort((a, b) => a.slot - b.slot || a.signature.localeCompare(b.signature)).slice(0, sampleCount)
  const rows: any[] = [], unreadable: string[] = []
  for (const signature of signatures) {
    await sleep(400) // public RPC getTransaction limits
    const row = await rpc('getTransaction', [signature.signature, { encoding: 'base64', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }])
    if (!row) unreadable.push(signature.signature); else rows.push(row)
  }
  return { rows, failedListed: [...failedListed], unreadable }
}

async function collect() {
  const output = option('output'), sampleCount = Number(option('sample', '32'))
  const resumed = args.includes('--collect-only') && output ? JSON.parse(fs.readFileSync(path.join(output, 'freeze.json'), 'utf8')) : null
  const program = option('program') ?? resumed?.program
  if (!validProgram(program) || !output || !Number.isSafeInteger(sampleCount) || sampleCount < 8 || sampleCount > 100)
    throw new Error('Usage: --program <program-id> --output <existing-parent/proof-directory> [--sample 32]')
  const composer = (process.env.COMPOSER_URL ?? 'https://the-composer-svc.fly.dev').replace(/\/$/, '')
  const directory = directoryFor(output)
  let idl: any, idlText: string, frozenAt: string, frozenAfterSlot: number, freeze: any
  if (resumed) {
    freeze = resumed
    idlText = fs.readFileSync(path.join(directory, 'idl.json'), 'utf8')
    if (digest(idlText) !== freeze.idlSha256) throw new Error('Frozen IDL hash changed before collection')
    idl = JSON.parse(idlText); frozenAt = freeze.frozenAt; frozenAfterSlot = freeze.frozenAfterSlot
  } else {
  const probe = await fetch(`${composer}/idl/${program}`, { signal: AbortSignal.timeout(30_000) })
  const probeBody = await probe.json() as any
  if (probe.ok || !/no published IDL account/.test(probeBody.error ?? '')) throw new Error('Chosen program has a published IDL or the absence probe failed')
  const account = await anchorIdlAddress(program)
  if (String(probeBody.error).match(/IDL account at ([1-9A-HJ-NP-Za-km-z]+)/)?.[1] !== account) throw new Error('Composer checked a different Anchor IDL account than the one derived here')
  const absent = await rpc('getAccountInfo', [account, { encoding: 'base64', commitment: 'confirmed' }])
  if (absent.value !== null) throw new Error('The purported absent on-chain IDL account exists')
  const executable = await rpc('getAccountInfo', [program, { encoding: 'base64', commitment: 'confirmed' }])
  if (!executable.value?.executable) throw new Error('Chosen address is not an executable on-chain program')
  // Positive control: the same checker must see a known published IDL, so a miss below is a real miss.
  const control = (await catalogs(CONTROL_PROGRAM, true)).map(({ response, ...check }) => check)
  if (!control.some(check => check.name.startsWith('Solana Foundation') && check.verdict === 'listed')) throw new Error('Catalog control failed to see a published IDL')
  const catalogChecks = await catalogs(program)
  const query = option('refresh', 'false') === 'true' ? '?refresh=true&signatures=250&seedBudget=2000000' : ''
  console.log(JSON.stringify({ phase: 'learning', program, composer, query }))
  const response = await fetch(`${composer}/learn/${program}${query}`, { signal: AbortSignal.timeout(15 * 60_000) })
  idl = await response.json() as any
  if (!response.ok || idl.address !== program || !Array.isArray(idl.instructions)) throw new Error('Composer did not return the requested learned interface')
  idlText = JSON.stringify(idl, null, 2) + '\n'; frozenAt = new Date().toISOString()
  frozenAfterSlot = await rpc('getSlot', [{ commitment: 'processed' }])
  freeze = { version: 1, program, frozenAt, frozenAfterSlot, idlSha256: digest(idlText),
    publishedIdl: { exists: false, anchorIdlAccount: account, independentlyChecked: true, checkedAtSlot: absent.context.slot, composerHttpStatus: probe.status },
    programAccount: { executable: true, owner: executable.value.owner, checkedAtSlot: executable.context.slot,
      accountDataSha256: digest(executable.value.data[0]) },
    catalogs: catalogChecks, catalogControl: { program: CONTROL_PROGRAM, checks: control }, composer, serviceReportedEvidence: idl.evidence,
    provenanceLimit: 'This records the artifact returned by the live service. It does not prove authorship, inference method or learner source availability.' }
  // The immutable artifact exists BEFORE any held-out signature is collected.
  fs.writeFileSync(path.join(directory, 'idl.json'), idlText)
  fs.writeFileSync(path.join(directory, 'freeze.json'), JSON.stringify(freeze, null, 2) + '\n')
  console.log(JSON.stringify({ phase: 'frozen', program, frozenAt, frozenAfterSlot, hash: digest(idlText), evidence: idl.evidence }))
  }
  if (args.includes('--freeze-only')) return
  const { rows, failedListed, unreadable } = await laterTransactions(program, frozenAfterSlot, sampleCount)
  const result = verifyHeldout(idl, rows, frozenAfterSlot)
  const receiptsText = JSON.stringify(rows, null, 2) + '\n'
  const proof = { ...freeze, version: 1, program, frozenAt, frozenAfterSlot, idlSha256: digest(idlText), receiptsSha256: digest(receiptsText),
    composer, requestedTransactions: sampleCount, failedListed, unreadable, training: idl.evidence, result,
    reproducible: `node server/scripts/composer-heldout.ts --replay ${output}`,
    limits: ['RPC metadata is a provider observation; transaction signatures are independently verified.', 'This verifies structural reconstruction. Unnamed arguments remain opaque; no semantics or profit guarantee is asserted.',
      'The frozen interface is never amended to fit the held-out batch. Every selected receipt and every failure is retained.'] }
  fs.writeFileSync(path.join(directory, 'receipts.json'), receiptsText)
  fs.writeFileSync(path.join(directory, 'proof.json'), JSON.stringify(proof, null, 2) + '\n')
  printRows(result)
  console.log(JSON.stringify({ phase: 'complete', program, output: directory, transactions: result.transactions, matched: result.matched,
    instructions: result.instructions, pdaVerified: result.pdaVerified, opaqueArguments: result.opaqueArguments, failures: result.failures.length, coverage: result.coverage }))
}

function replay(directory: string) {
  const proof = JSON.parse(fs.readFileSync(path.join(directory, 'proof.json'), 'utf8'))
  const idlText = fs.readFileSync(path.join(directory, 'idl.json'), 'utf8'), receiptsText = fs.readFileSync(path.join(directory, 'receipts.json'), 'utf8')
  if (digest(idlText) !== proof.idlSha256 || digest(receiptsText) !== proof.receiptsSha256) throw new Error('A frozen fixture hash changed')
  const result = verifyHeldout(JSON.parse(idlText), JSON.parse(receiptsText), proof.frozenAfterSlot)
  if (JSON.stringify(result) !== JSON.stringify(proof.result)) throw new Error('Offline replay disagrees with the published result')
  printRows(result)
  console.log(JSON.stringify({ replay: 'verified', program: proof.program, transactions: result.transactions, instructions: result.instructions, matched: result.matched,
    coverage: result.coverage, pdaVerified: result.pdaVerified, opaqueArguments: result.opaqueArguments, failures: result.failures.length }))
}

async function refetch(directory: string) {
  const proof = JSON.parse(fs.readFileSync(path.join(directory, 'proof.json'), 'utf8'))
  const idlText = fs.readFileSync(path.join(directory, 'idl.json'), 'utf8')
  if (digest(idlText) !== proof.idlSha256) throw new Error('Frozen IDL hash changed')
  const archived = JSON.parse(fs.readFileSync(path.join(directory, 'receipts.json'), 'utf8'))
  const rows = []
  for (const row of archived) {
    const signature = rpcDiscoveryTransaction(row).sig
    await sleep(400) // public RPC getTransaction limits
    const fetched = await rpc('getTransaction', [signature, { encoding: 'base64', commitment: 'finalized', maxSupportedTransactionVersion: 1 }])
    if (!fetched) throw new Error(`Signature unavailable from this RPC: ${signature}`)
    rows.push(fetched)
  }
  const result = verifyHeldout(JSON.parse(idlText), rows, proof.frozenAfterSlot)
  printRows(result)
  const agrees = (['transactions', 'instructions', 'matched', 'runtimeEvents', 'pdaVerified'] as const).every(key => result[key] === proof.result[key])
  console.log(JSON.stringify({ refetched: true, program: proof.program, idlSha256: proof.idlSha256, frozenAfterSlot: proof.frozenAfterSlot, transactions: result.transactions,
    instructions: result.instructions, matched: result.matched, misses: result.failures.length, coverage: result.coverage, pdaVerified: result.pdaVerified,
    agreesWithPublished: agrees }))
  if (!agrees) process.exitCode = 1
}

// One line per program instruction in the held-out set: hits, misses and counter exclusions in one table.
function printRows(result: ReturnType<typeof verifyHeldout>) {
  const rows = [
    ...result.decoded.map(row => ({ ...row, line: `PASS  ${row.instruction}  pda ${row.pdaRecipes.filter((r: any) => r.verdict === 'verified').length}/${row.pdaRecipes.length} verified  args ${row.argsHex.length / 2}B ${row.argumentSemantics.startsWith('opaque') ? 'opaque' : 'typed'}` })),
    ...result.failures.map(row => ({ ...row, line: `FAIL  ${row.reason}  selector ${row.selector} ${row.bytes}B ${row.accounts} accounts` })),
    ...result.counterCorrections.map(row => ({ ...row, line: 'SKIP  Anchor event self-CPI (log record, excluded from both sides)' })),
  ].sort((a, b) => a.slot - b.slot || a.signature.localeCompare(b.signature) || String(a.n).localeCompare(String(b.n), undefined, { numeric: true }))
  for (const row of rows) console.log(`${row.slot}  ${row.signature}  #${row.n}  ${row.line}`)
}

// The strongest holdout: transactions that did not exist when the frozen hash was published.
async function fresh(directory: string) {
  const freeze = JSON.parse(fs.readFileSync(path.join(directory, 'freeze.json'), 'utf8'))
  const idlText = fs.readFileSync(path.join(directory, 'idl.json'), 'utf8')
  if (digest(idlText) !== freeze.idlSha256) throw new Error('Frozen IDL hash changed')
  const sampleCount = Number(option('sample', '32')), startSlot = await rpc('getSlot', [{ commitment: 'confirmed' }])
  const { rows, failedListed, unreadable } = await laterTransactions(freeze.program, startSlot, sampleCount)
  const result = verifyHeldout(JSON.parse(idlText), rows, startSlot)
  printRows(result)
  console.log(JSON.stringify({ fresh: true, program: freeze.program, idlSha256: freeze.idlSha256, frozenAfterSlot: freeze.frozenAfterSlot, collectedAfterSlot: startSlot,
    transactions: result.transactions, instructions: result.instructions, matched: result.matched, misses: result.failures.length, coverage: result.coverage,
    pdaVerified: result.pdaVerified, runtimeEventsExcluded: result.runtimeEvents, failedListed: failedListed.length, unreadable: unreadable.length }))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = option('replay'), liveDirectory = option('refetch'), freshDirectory = option('fresh')
  if (directory) replay(directory); else if (liveDirectory) await refetch(liveDirectory); else if (freshDirectory) await fresh(freshDirectory); else await collect()
}
