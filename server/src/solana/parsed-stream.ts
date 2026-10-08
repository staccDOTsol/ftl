// Helius Parsed Streams selects FTL's exact instruction names on the server.
// A parallel Yellowstone subscription stays on the programs the parser cannot
// cover, and widens to every program whenever this connection is not healthy.
import WebSocket from 'ws'
import bs58 from 'bs58'
import { config, redact } from '../config.ts'
import type { RawEvent } from '../hub.ts'
import { decode, type NIx, type NTx, type TokenBal } from './decode.ts'
import { programIds, specs, venueOf, RAYDIUM_AMM_V4 } from './programs.ts'

const PARSED_URL = 'wss://beta.helius-rpc.com'
const DISCOVERY_URL = 'wss://fs-beta.helius-rpc.com'
const CONNECT_TIMEOUT_MS = 15_000
const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const isAddress = (s: unknown): s is string => typeof s === 'string' && s.length >= 32 && s.length <= 44

export interface ParsedStreamStatus {
  connected: boolean
  msgs: number
  lastMsgTs: number | null
  configuredStreams: number
  activeStreams: number
  filterPrograms: number
  subscriptions: number
  estimatedPayloadBytes: number
  reason?: string
}

interface SelectedProgram { program: string; names: string[] }
export interface CatalogSelection { selected: SelectedProgram[]; fallback: string[]; missing: Record<string, string[]> }

export function selectParsedPrograms(catalog: Map<string, { id: string; instructions: string[] }>): CatalogSelection {
  const selected: SelectedProgram[] = []
  const fallback: string[] = []
  const missing: Record<string, string[]> = {}
  for (const program of programIds) {
    const wanted = [...(specs.get(program)?.values() ?? [])].map(s => s.name)
    const entry = catalog.get(program)
    const names = entry?.id === program ? new Set(entry.instructions.map(normalized)) : new Set<string>()
    const supported = wanted.filter(n => names.has(normalized(n)))
    const absent = wanted.filter(n => !names.has(normalized(n)))
    if (supported.length) selected.push({ program, names: supported })
    if (absent.length) { fallback.push(program); missing[program] = absent }
  }
  return { selected, fallback, missing }
}

function rawAmount(v: unknown): bigint | null {
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v)
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v)
  return null
}

function parsedBalances(transaction: any, keys: string[]): Pick<NTx, 'pre' | 'post' | 'lamports'> {
  const transfers = transaction?.tokenTransfers
  if (!Array.isArray(transfers)) return {}
  const index = new Map(keys.map((key, i) => [key, i]))
  const delta = new Map<number, TokenBal>()
  const add = (account: unknown, mint: unknown, owner: unknown, decimals: unknown, amount: bigint) => {
    const idx = index.get(String(account))
    if (idx === undefined || !isAddress(mint) || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18) return
    const old = delta.get(idx)
    if (old && (old.mint !== mint || old.decimals !== decimals)) return
    delta.set(idx, { idx, mint, owner: typeof owner === 'string' ? owner : '', decimals, amount: (old?.amount ?? 0n) + amount })
  }
  for (const t of transfers) {
    const amount = rawAmount(t?.rawTokenAmount)
    if (amount === null) return {} // Precision cannot be proved; omit amounts.
    add(t.fromTokenAccount, t.mint, t.fromUserAccount, t.decimals, -amount)
    add(t.toTokenAccount, t.mint, t.toUserAccount, t.decimals, amount)
  }
  let lamports: NTx['lamports']
  if (Array.isArray(transaction?.nativeTransfers) && keys[0]) {
    let walletDelta = 0n
    for (const t of transaction.nativeTransfers) {
      const amount = rawAmount(t?.amount)
      if (amount === null) return {}
      if (t.fromUserAccount === keys[0]) walletDelta -= amount
      if (t.toUserAccount === keys[0]) walletDelta += amount
    }
    lamports = { pre: [0n], post: [walletDelta], fee: 0n }
  }
  return { pre: [], post: [...delta.values()], lamports }
}

function ixAccounts(ix: any, keys: string[], expected: string[], program: string): number[] | null {
  let accounts: string[]
  if (Array.isArray(ix?.rawAccounts) && ix.rawAccounts.length) accounts = ix.rawAccounts
  else if (Array.isArray(ix?.decoded?.accounts)) {
    // Live DAMM v2 notifications use `owner` for the local IDL's `signer`
    // in the same account position. Apply only this observed one-role alias;
    // all other positions must agree before using the ordered pubkeys.
    const ordered = ix.decoded.accounts
    if (venueOf.get(program) === 'meteora-damm-v2' && ordered.length === expected.length &&
        expected.every((name, i) => normalized(name) === normalized(ordered[i]?.name) ||
          (name === 'signer' && ordered[i]?.name === 'owner'))) {
      accounts = ordered.map((a: any) => a.pubkey)
    } else {
    const byName = new Map<string, string>()
    for (const a of ix.decoded.accounts) if (typeof a?.name === 'string' && isAddress(a?.pubkey)) byName.set(normalized(a.name), a.pubkey)
    accounts = expected.map(name => byName.get(normalized(name)) ?? '')
    }
  } else return null
  const index = new Map(keys.map((key, i) => [key, i]))
  const out: number[] = []
  for (const account of accounts) {
    const idx = index.get(account)
    if (idx === undefined) return null
    out.push(idx)
  }
  return out
}

function launchMeta(ix: any): RawEvent['meta'] {
  const args = ix?.decoded?.args
  if (!args || typeof args !== 'object') return undefined
  const name = typeof args.name === 'string' ? args.name : undefined
  const symbol = typeof args.symbol === 'string' ? args.symbol : undefined
  const uri = typeof args.uri === 'string' ? args.uri : undefined
  return name || symbol || uri ? { name, symbol, uri } : undefined
}

// Every decoded instruction is matched back to FTL's local discriminator and
// account schema. For an undecoded instruction, the actual base58 bytes decide.
// Missing accounts or unsafe transfer amounts never become invented values.
export function parsedToRawEvents(value: any): RawEvent[] {
  const transaction = value?.transaction
  const keys: string[] = transaction?.accountKeys
  if (!Array.isArray(keys) || !keys.length || !keys.every(isAddress) ||
      typeof transaction?.signature !== 'string' || !Number.isSafeInteger(transaction?.slot) ||
      !Array.isArray(value?.instructions)) return []
  const ixs: NIx[] = []
  const metaByN = new Map<string, RawEvent['meta']>()
  for (const ix of value.instructions) {
    const program = ix?.programId
    const choices = specs.get(program)
    if (!choices || !Number.isSafeInteger(ix?.instructionIndex) || ix.instructionIndex < 0) continue
    const raw = typeof ix.rawData === 'string' ? bs58.decode(ix.rawData) : null
    let chosen: { disc: string; spec: (typeof choices extends Map<string, infer S> ? S : never) } | undefined
    if (raw) {
      const disc = Buffer.from(raw.subarray(0, program === RAYDIUM_AMM_V4 ? 1 : 8)).toString('hex')
      const spec = choices.get(disc)
      if (spec) chosen = { disc, spec }
    } else if (typeof ix.instructionName === 'string') {
      const pair = [...choices.entries()].find(([, spec]) => normalized(spec.name) === normalized(ix.instructionName))
      if (pair) chosen = { disc: pair[0], spec: pair[1] }
    }
    if (!chosen) continue
    const accts = ixAccounts(ix, keys, chosen.spec.accounts, program)
    if (!accts) continue
    const inner = ix.innerInstructionIndex
    const n = inner === null || inner === undefined ? String(ix.instructionIndex)
      : Number.isSafeInteger(inner) && inner >= 0 ? `${ix.instructionIndex}.${inner}` : ''
    if (!n) continue
    ixs.push({ prog: program, accts, data: raw ?? Buffer.from(chosen.disc, 'hex'), n })
    if (chosen.spec.kind === 'launch') metaByN.set(n, launchMeta(ix))
  }
  if (!ixs.length) return []
  const tx: NTx = { sig: transaction.signature, slot: transaction.slot, keys, ixs,
    failed: transaction.status !== 'ok', ...parsedBalances(transaction, keys) }
  const events = decode(tx, 'helius-parsed', 'confirmed')
  for (const event of events) if (event.kind === 'launch' && !event.meta) event.meta = metaByN.get(event.n)
  return events
}

export function missingMatchedInstruction(value: any, events: RawEvent[]): boolean {
  if (!Array.isArray(value?.matchedIndexes) || !Array.isArray(value?.instructions)) return true
  for (const index of value.matchedIndexes) {
    const ix = value.instructions[index]
    if (!ix || !specs.has(ix.programId)) continue
    // Helius can match an emitted Anchor event by the instruction-name
    // fallback (for example RemoveLiquidity alongside remove_liquidity).
    // Event records have neither instruction accounts nor raw data and are
    // not a missing FTL instruction.
    if (!(Array.isArray(ix.rawAccounts) && ix.rawAccounts.length) &&
        !(Array.isArray(ix.decoded?.accounts) && ix.decoded.accounts.length) &&
        typeof ix.rawData !== 'string') continue
    const n = ix.innerInstructionIndex === null || ix.innerInstructionIndex === undefined
      ? String(ix.instructionIndex) : `${ix.instructionIndex}.${ix.innerInstructionIndex}`
    if (!events.some(event => event.n === n && event.tx === value.transaction?.signature)) return true
  }
  return false
}

function socket(url: string, key: string): WebSocket {
  // Header authentication keeps the key out of URLs and WebSocket error strings.
  return new WebSocket(url, { headers: { 'x-api-key': key } })
}

async function discover(key: string): Promise<Map<string, { id: string; instructions: string[] }>> {
  return await new Promise((resolve, reject) => {
    const ws = socket(DISCOVERY_URL, key)
    const result = new Map<string, { id: string; instructions: string[] }>()
    const pending = new Map<number, string>()
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error('catalog discovery timed out')) }, CONNECT_TIMEOUT_MS)
    const fail = (reason: string) => { clearTimeout(timeout); ws.terminate(); reject(new Error(reason)) }
    ws.on('open', () => {
      for (const [i, program] of programIds.entries()) {
        pending.set(i + 1, program)
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'describeProgram', params: [{ program }] }))
      }
    })
    ws.on('message', data => {
      let message: any
      try { message = JSON.parse(String(data)) } catch { return }
      const program = pending.get(message.id)
      if (!program) return
      pending.delete(message.id)
      if (message.result?.id === program && Array.isArray(message.result.instructions))
        result.set(program, message.result)
      if (!pending.size) { clearTimeout(timeout); ws.close(); resolve(result) }
    })
    ws.on('error', () => fail('catalog discovery connection failed'))
    ws.on('close', () => { if (pending.size) fail('catalog discovery disconnected') })
  })
}

export function startParsedStream(onEvent: (event: RawEvent) => void,
  onState: (status: ParsedStreamStatus, fallbackPrograms: string[]) => void): void {
  const key = process.env.HELIUS_API_KEY?.trim()
  const status: ParsedStreamStatus = { connected: false, msgs: 0, lastMsgTs: null,
    configuredStreams: config.heliusParsedStream ? 1 : 0, activeStreams: 0, filterPrograms: 0,
    subscriptions: 0, estimatedPayloadBytes: 0 }
  if (!config.heliusParsedStream || !key) {
    status.reason = !config.heliusParsedStream ? 'HELIUS_PARSED_STREAM=1 not set' : 'HELIUS_API_KEY not set'
    onState({ ...status }, programIds)
    return
  }
  let attempt = 0
  const run = async () => {
    let catalog: Map<string, { id: string; instructions: string[] }>
    try { catalog = await discover(key) }
    catch (e) {
      status.reason = redact(String(e))
      onState({ ...status }, programIds)
      setTimeout(run, Math.min(30_000, 1000 * 2 ** attempt++))
      return
    }
    const selected = selectParsedPrograms(catalog)
    if (!selected.selected.length) {
      status.reason = 'catalog has no supported FTL instruction names'
      onState({ ...status }, programIds)
      setTimeout(run, 30_000)
      return
    }
    const ws = socket(PARSED_URL, key)
    const expected = new Set(selected.selected.map((_, i) => i + 1))
    let healthy = false
    let degraded = false
    let lastStatus = 0
    let closed = false
    const connectionTimeout = setTimeout(() => { status.reason = 'parsed subscriptions timed out'; ws.terminate() }, CONNECT_TIMEOUT_MS)
    const disconnect = (reason: string) => {
      if (closed) return
      closed = true
      clearTimeout(connectionTimeout)
      ws.terminate()
      status.connected = false
      status.activeStreams = 0
      status.subscriptions = 0
      status.reason = reason
      onState({ ...status }, programIds)
      setTimeout(run, Math.min(30_000, 1000 * 2 ** attempt++))
    }
    ws.on('open', () => {
      for (const [i, entry] of selected.selected.entries()) ws.send(JSON.stringify({
        jsonrpc: '2.0', id: i + 1, method: 'parsedTransactionSubscribe',
        params: [{ programs: [entry.program], instructionNames: entry.names, includeFailed: false, includeCpi: true },
          { commitment: 'confirmed', details: 'full' }],
      }))
    })
    ws.on('message', data => {
      const body = String(data)
      status.estimatedPayloadBytes += Buffer.byteLength(body)
      let message: any
      try { message = JSON.parse(body) } catch { return }
      if (expected.has(message.id)) {
        if (message.error || !Number.isSafeInteger(message.result)) {
          disconnect(`parsed subscription rejected: ${message.error?.code ?? 'unknown'}`)
          return
        }
        expected.delete(message.id)
        status.subscriptions++
        if (!expected.size) {
          clearTimeout(connectionTimeout)
          healthy = true
          attempt = 0
          status.connected = true
          status.activeStreams = 1
          status.filterPrograms = selected.selected.length
          status.reason = selected.fallback.length ? `Flux retains ${selected.fallback.length} unsupported programs` : undefined
          onState({ ...status }, selected.fallback)
          console.log(`[sol:helius-parsed] subscribed to ${selected.selected.length} validated programs; Flux retains ${selected.fallback.length}`)
        }
        return
      }
      if (message.method !== 'parsedTransactionNotification') return
      status.msgs++
      status.lastMsgTs = Date.now()
      try {
        const value = message.params?.result?.value
        const events = parsedToRawEvents(value)
        if (missingMatchedInstruction(value, events) && !degraded) {
          degraded = true
          status.reason = 'parsed event could not be converted; Flux restored to all programs'
          onState({ ...status }, programIds)
        }
        for (const event of events) onEvent(event)
      } catch (e) { console.error('[sol:helius-parsed] decode', redact(String(e))) }
      if (status.lastMsgTs - lastStatus >= 5_000) {
        lastStatus = status.lastMsgTs
        onState({ ...status }, degraded ? programIds : selected.fallback)
      }
    })
    ws.on('error', () => disconnect('parsed WebSocket error'))
    ws.on('close', () => disconnect('parsed WebSocket disconnected'))
    // The subscription response is the acceptance barrier; health is revoked
    // immediately on connection loss, before Flux's broader filter is restored.
    if (!healthy) onState({ ...status }, programIds)
  }
  void run()
}
