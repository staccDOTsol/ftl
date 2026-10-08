// The Composer workspace: URL <-> state, request bodies, IDL form models and
// response summaries. Dependency-free on purpose so `node --test` loads it
// without a bundler; the React surface lives in components/Composer*.web.tsx.
//
// The Composer engine is a hosted HTTP service. Every builder returns an
// UNSIGNED transaction for the payer named in the request; nothing here signs.

export const COMPOSER_URL = (process.env.EXPO_PUBLIC_COMPOSER_URL ?? 'https://the-composer-svc.fly.dev').replace(/\/$/, '')

// ---------------------------------------------------------------- state ----

export type ComposerTab = 'intent' | 'build' | 'land' | 'batch' | 'accounts' | 'diagnose' | 'idl' | 'send'
export type AccountsMode = 'derive' | 'probe' | 'find' | 'recipes'
export type IdlPreference = 'auto' | 'published' | 'learned'
export type BatchMode = 'single' | 'compose' | 'bundle'

export const TABS: { value: ComposerTab; label: string }[] = [
  { value: 'intent', label: 'Intent' },
  { value: 'build', label: 'Build' },
  { value: 'land', label: 'Land' },
  { value: 'batch', label: 'Batch' },
  { value: 'accounts', label: 'Accounts' },
  { value: 'diagnose', label: 'Diagnose' },
  { value: 'idl', label: 'IDL' },
  { value: 'send', label: 'Send' },
]
export const ACCOUNT_MODES: AccountsMode[] = ['derive', 'probe', 'find', 'recipes']

export interface ExtraAccount { pubkey: string; signer: boolean; writable: boolean }
export interface TxOptionsState { cu: string; priorityFee: string; tip: string; luts: string[]; blockhash: string; simulate: boolean; dryRun: boolean }
// One instruction in a batch, already in the service's IxSpec shape.
export interface BatchStep { programId: string; instruction: string; args: Record<string, unknown>; accounts: Record<string, string>; argsHex?: string; extraAccounts?: ExtraAccount[] }
export interface BatchState { instructions: BatchStep[]; mode: BatchMode; split: number[][]; tip: string }

export interface ComposerState {
  tab: ComposerTab
  mode: AccountsMode
  payer: string
  run: boolean
  // intent / yolo
  intent: string
  maxPlans: number
  yolo: boolean
  maxAttempts: string
  timeoutMs: string
  maxSpend: string
  programs: string[]
  // shared program + instruction
  program: string
  ix: string
  idl: IdlPreference
  args: Record<string, string>
  accounts: Record<string, string>
  argsHex: string
  extra: ExtraAccount[]
  options: TxOptionsState
  // land
  mint: string
  signatures: string
  refresh: boolean
  // derive / probe / find
  account: string
  sweep: string
  values: string[]
  existingOnly: boolean
  where: Record<string, string>
  select: string[]
  limit: string
  force: boolean
  // batch / send
  batch: BatchState
  tx: string
}

export const DEFAULT_MAX_PLANS = 3
export const MAX_PLANS = 8
export const YOLO_LIMITS = { maxAttempts: 8, timeoutMs: 240_000, maxSpend: 100_000 }

export function defaultOptions(): TxOptionsState { return { cu: '', priorityFee: '', tip: '', luts: [], blockhash: '', simulate: true, dryRun: false } }
export function defaultBatch(): BatchState { return { instructions: [], mode: 'single', split: [], tip: '' } }
export function defaultState(): ComposerState {
  return {
    tab: 'intent', mode: 'derive', payer: '', run: false,
    intent: '', maxPlans: DEFAULT_MAX_PLANS, yolo: false, maxAttempts: '', timeoutMs: '', maxSpend: '', programs: [],
    program: '', ix: '', idl: 'auto', args: {}, accounts: {}, argsHex: '', extra: [], options: defaultOptions(),
    mint: '', signatures: '', refresh: false,
    account: '', sweep: '', values: [], existingOnly: false, where: {}, select: [], limit: '', force: false,
    batch: defaultBatch(), tx: '',
  }
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
export const isAddress = (value: unknown): value is string => typeof value === 'string' && BASE58.test(value.trim())
export const NATIVE_PROGRAM = 'native'
// A program reference accepted by the service: a base58 program id, or the
// built-in `native` catalogue (transfers, ATAs, lookup tables).
export const isProgramRef = (value: string) => value.trim() === NATIVE_PROGRAM || isAddress(value)

// Query values arrive as string | string[] | undefined from Expo Router.
type Raw = string | string[] | undefined | null
type Params = Record<string, Raw>
const LIMIT = { text: 4000, value: 600, list: 64, spec: 24_000, tx: 8000 }
const first = (value: Raw) => (Array.isArray(value) ? value[0] : value) ?? ''
const text = (value: Raw, max = LIMIT.value) => first(value).slice(0, max)
const flag = (value: Raw) => ['1', 'true', 'yes', 'on'].includes(first(value).toLowerCase())
const list = (value: Raw) => first(value).split(',').map(item => item.trim()).filter(Boolean).slice(0, LIMIT.list)
const digits = (value: Raw) => { const v = first(value).trim(); return /^\d{1,20}$/.test(v) ? v : '' }
const prefixed = (params: Params, prefix: string) => {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(params)) {
    if (!key.startsWith(prefix) || key.length === prefix.length || key.length > 120) continue
    const v = text(value)
    if (v !== '') out[key.slice(prefix.length)] = v
  }
  return out
}
const TAB_NAMES = new Set<string>(TABS.map(tab => tab.value))

export function parseExtra(value: string): ExtraAccount[] {
  return value.split(',').map(item => item.trim()).filter(Boolean).slice(0, LIMIT.list).flatMap(item => {
    const [pubkey, flags = ''] = item.split(':')
    return isAddress(pubkey) ? [{ pubkey, signer: flags.includes('s'), writable: flags.includes('w') }] : []
  })
}
export const formatExtra = (extra: ExtraAccount[]) => extra.filter(item => isAddress(item.pubkey))
  .map(item => item.signer || item.writable ? `${item.pubkey}:${item.signer ? 's' : ''}${item.writable ? 'w' : ''}` : item.pubkey).join(',')

export function parseComposerQuery(params: Params | null | undefined): ComposerState {
  const p = params ?? {}
  const state = defaultState()
  const tab = text(p.tab).toLowerCase()
  if ((ACCOUNT_MODES as string[]).includes(tab)) { state.tab = 'accounts'; state.mode = tab as AccountsMode }
  else if (TAB_NAMES.has(tab)) state.tab = tab as ComposerTab
  const mode = text(p.mode).toLowerCase()
  if (state.tab === 'accounts' && (ACCOUNT_MODES as string[]).includes(mode)) state.mode = mode as AccountsMode
  state.payer = text(p.payer).trim()
  state.run = flag(p.run)
  state.intent = text(p.intent, LIMIT.text)
  const plans = Number(first(p.maxPlans))
  state.maxPlans = Number.isInteger(plans) && plans >= 1 ? Math.min(plans, MAX_PLANS) : DEFAULT_MAX_PLANS
  state.yolo = flag(p.yolo)
  state.maxAttempts = digits(p.maxAttempts)
  state.timeoutMs = digits(p.timeoutMs)
  state.maxSpend = digits(p.maxSpend)
  state.programs = list(p.programs).filter(isProgramRef)
  state.program = text(p.program).trim()
  state.ix = text(p.ix).trim()
  const idl = text(p.idl).toLowerCase()
  state.idl = idl === 'learned' || idl === 'published' ? idl : 'auto'
  state.args = prefixed(p, 'args.')
  state.accounts = prefixed(p, 'accounts.')
  state.argsHex = text(p.argsHex).replace(/\s+/g, '')
  state.extra = parseExtra(text(p.extra, LIMIT.text))
  state.options = { cu: digits(p.cu), priorityFee: digits(p.priorityFee), tip: digits(p.tip), luts: list(p.lut).filter(isAddress),
    blockhash: text(p.blockhash).trim(), simulate: first(p.simulate) !== '0', dryRun: flag(p.dryRun) }
  state.mint = text(p.mint).trim()
  state.signatures = digits(p.signatures)
  state.refresh = flag(p.refresh)
  state.account = text(p.account).trim()
  state.sweep = text(p.sweep).trim()
  state.values = list(p.values)
  state.existingOnly = flag(p.existingOnly)
  state.where = prefixed(p, 'where.')
  state.select = list(p.select)
  state.limit = digits(p.limit)
  state.force = flag(p.force)
  const spec = text(p.spec, LIMIT.spec)
  if (spec) state.batch = batchFromSpec(decodeSpec(spec)) ?? defaultBatch()
  state.tx = text(p.tx, LIMIT.tx).trim()
  // A bare deep link with only an intent opens the Intent tab.
  if (!TAB_NAMES.has(tab) && !(ACCOUNT_MODES as string[]).includes(tab) && !state.intent) {
    if (spec) state.tab = 'batch'
    else if (state.tx) state.tab = 'send'
    else if (state.program && state.ix) state.tab = 'build'
    else if (state.program) state.tab = 'idl'
  }
  return state
}

export const tabParam = (state: Pick<ComposerState, 'tab' | 'mode'>) => state.tab === 'accounts' ? state.mode : state.tab

// Only the fields the active tab uses are written, so a copied link carries
// exactly what that tab needs and nothing stale from another tab.
export function serializeComposerQuery(state: ComposerState, options: { run?: boolean } = {}): Record<string, string> {
  const q: Record<string, string> = {}
  const set = (key: string, value: string | number | boolean | null | undefined) => {
    if (value === undefined || value === null || value === '' || value === false) return
    q[key] = value === true ? '1' : String(value)
  }
  const entries = (prefix: string, record: Record<string, string>) => {
    for (const [key, value] of Object.entries(record)) if (key && value !== '') q[`${prefix}${key}`] = value
  }
  const tab = state.tab
  set('tab', tab === 'intent' ? '' : tabParam(state))
  if (tab === 'intent') {
    set('intent', state.intent)
    if (state.maxPlans !== DEFAULT_MAX_PLANS) set('maxPlans', state.maxPlans)
    set('yolo', state.yolo)
    if (state.yolo) { set('maxAttempts', state.maxAttempts); set('timeoutMs', state.timeoutMs); set('maxSpend', state.maxSpend) }
    set('programs', state.programs.join(','))
  } else if (tab === 'build' || tab === 'diagnose') {
    set('program', state.program); set('ix', state.ix)
    if (state.idl !== 'auto') set('idl', state.idl)
    entries('args.', state.args); entries('accounts.', state.accounts)
    set('argsHex', state.argsHex); set('extra', formatExtra(state.extra))
    const o = state.options
    set('cu', o.cu); set('priorityFee', o.priorityFee); set('tip', o.tip); set('lut', o.luts.join(',')); set('blockhash', o.blockhash)
    if (!o.simulate) q.simulate = '0'
    set('dryRun', o.dryRun)
  } else if (tab === 'land') {
    set('program', state.program); set('ix', state.ix); set('mint', state.mint); set('signatures', state.signatures); set('refresh', state.refresh)
  } else if (tab === 'accounts') {
    set('program', state.program); set('account', state.account)
    if (state.mode !== 'recipes') entries('accounts.', state.accounts)
    if (state.mode === 'derive' || state.mode === 'probe') entries('args.', state.args)
    if (state.mode === 'probe') { set('sweep', state.sweep); set('values', state.values.join(',')); set('existingOnly', state.existingOnly) }
    if (state.mode === 'find') { entries('where.', state.where); set('select', state.select.join(',')); set('limit', state.limit); set('force', state.force) }
  } else if (tab === 'batch') {
    if (state.batch.instructions.length) set('spec', encodeSpec(batchSpec(state.batch)))
  } else if (tab === 'idl') {
    set('program', state.program)
    if (state.idl !== 'auto') set('idl', state.idl)
  } else if (tab === 'send') set('tx', state.tx)
  if (state.payer) set('payer', state.payer)
  if (options.run) q.run = '1'
  return q
}

export function queryString(query: Record<string, string>) {
  // Keep `.` and `,` readable in links; URLSearchParams would escape them.
  return Object.entries(query).map(([key, value]) => `${encodeURIComponent(key).replace(/%2E/gi, '.')}=${encodeURIComponent(value).replace(/%2C/gi, ',')}`).join('&')
}
export function composerHref(partial: Partial<ComposerState> = {}, options: { run?: boolean } = {}) {
  const q = queryString(serializeComposerQuery({ ...defaultState(), ...partial }, options))
  return q ? `/composer?${q}` : '/composer'
}

// Entry points elsewhere in the app.
export function composerProgramHref(program: string, interfaceKind: 'published' | 'learned', ix?: string | null) {
  return composerHref({ tab: interfaceKind === 'learned' ? 'land' : 'build', program, ix: ix ?? '' })
}
export function composerTokenIntentHref(mint: string) {
  return composerHref({ intent: `buy 0.01 SOL of ${mint}`, maxPlans: DEFAULT_MAX_PLANS })
}
// The Program frontier's idlSource says where FTL found an interface. A
// published or shipped IDL opens Build; one the Composer reconstructed opens Land.
export function interfaceKindOf(idlSource: string | null | undefined, state?: string | null): 'published' | 'learned' {
  if (idlSource === 'composer') return 'learned'
  if (idlSource && /published|shipped/.test(idlSource)) return 'published'
  return state === 'ready' || state === 'partial' ? 'learned' : 'published'
}

// --------------------------------------------------------- base64url spec ----

function bytesToBinary(bytes: Uint8Array) { let out = ''; for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return out }
export function encodeSpec(value: unknown): string {
  return btoa(bytesToBinary(new TextEncoder().encode(JSON.stringify(value)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function decodeSpec(value: string): unknown {
  try {
    const b64 = value.trim().replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(b64 + '='.repeat((4 - b64.length % 4) % 4))
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0))))
  } catch { return null }
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const stringRecord = (value: unknown) => {
  const out: Record<string, string> = {}
  if (isObject(value)) for (const [key, v] of Object.entries(value)) if (typeof v === 'string' && v) out[key] = v
  return out
}
function stepFrom(value: unknown): BatchStep | null {
  if (!isObject(value) || typeof value.instruction !== 'string' || !value.instruction) return null
  const programId = typeof value.programId === 'string' ? value.programId : ''
  if (!programId) return null
  const step: BatchStep = { programId, instruction: value.instruction, args: isObject(value.args) ? value.args : {}, accounts: stringRecord(value.accounts) }
  if (typeof value.argsHex === 'string' && value.argsHex) step.argsHex = value.argsHex
  if (Array.isArray(value.extraAccounts)) step.extraAccounts = value.extraAccounts.flatMap(item => isObject(item) && isAddress(item.pubkey) ? [{ pubkey: item.pubkey, signer: item.signer === true, writable: item.writable === true }] : [])
  return step
}
export function batchFromSpec(value: unknown): BatchState | null {
  if (!isObject(value) || !Array.isArray(value.instructions)) return null
  const instructions = value.instructions.map(stepFrom).filter((step): step is BatchStep => !!step).slice(0, 16)
  const bundle = isObject(value.bundle) ? value.bundle : null
  const split = bundle && Array.isArray(bundle.split) ? bundle.split.filter(Array.isArray).map(group => group.filter((n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0)) : []
  const tip = bundle && (typeof bundle.tipLamports === 'number' || typeof bundle.tipLamports === 'string') && /^\d+$/.test(String(bundle.tipLamports)) ? String(bundle.tipLamports) : ''
  return { instructions, mode: bundle ? 'bundle' : isObject(value.compose) ? 'compose' : 'single', split, tip }
}
export function batchSpec(batch: BatchState): Record<string, unknown> {
  const spec: Record<string, unknown> = { instructions: batch.instructions }
  if (batch.mode === 'compose') spec.compose = {}
  if (batch.mode === 'bundle') {
    const bundle: Record<string, unknown> = {}
    if (batch.split.length) bundle.split = batch.split
    if (batch.tip) bundle.tipLamports = Number(batch.tip)
    spec.bundle = bundle
  }
  return spec
}
// "0 | 1,2" -> [[0],[1,2]]. Each group becomes one transaction of the bundle.
export function parseSplit(value: string): number[][] {
  return value.split('|').map(group => group.split(/[\s,]+/).filter(Boolean).map(Number).filter(n => Number.isInteger(n) && n >= 0)).filter(group => group.length)
}
export const formatSplit = (split: number[][]) => split.map(group => group.join(',')).join(' | ')

// ------------------------------------------------------------- IDL types ----

export type IdlType = string | { option: IdlType } | { coption: IdlType } | { vec: IdlType } | { array: [IdlType, number | unknown] } | { defined: string | { name: string; generics?: unknown[] } } | { generic: string } | Record<string, unknown>
export interface IdlField { name: string; type: IdlType; docs?: string[] }
export interface IdlTypeDef { name: string; type: { kind: string; fields?: (IdlField | IdlType)[]; variants?: { name: string; fields?: (IdlField | IdlType)[] }[]; alias?: IdlType } }
export interface AnchorIdl {
  address?: string
  name?: string
  version?: string | null
  metadata?: Record<string, unknown>
  instructions?: { name: string; discriminator?: number[]; accounts?: unknown[]; args?: IdlField[]; docs?: string[] }[]
  accounts?: { name: string; discriminator?: number[]; type?: IdlTypeDef['type'] }[]
  types?: IdlTypeDef[]
  errors?: { code: number; name: string; msg?: string }[]
  events?: unknown[]
}

export type FieldModel =
  | { kind: 'int'; label: string; signed: boolean; bits: number }
  | { kind: 'float'; label: string }
  | { kind: 'bool'; label: string }
  | { kind: 'string'; label: string }
  | { kind: 'pubkey'; label: string }
  | { kind: 'bytes'; label: string }
  | { kind: 'option'; label: string; inner: FieldModel }
  | { kind: 'vec'; label: string; inner: FieldModel }
  | { kind: 'array'; label: string; inner: FieldModel; len: number }
  | { kind: 'struct'; label: string; fields: { name: string; model: FieldModel }[] }
  | { kind: 'tuple'; label: string; items: FieldModel[] }
  | { kind: 'enum'; label: string; variants: { name: string; named: { name: string; model: FieldModel }[] | null; tuple: FieldModel[] | null }[] }
  | { kind: 'raw'; label: string }

const INT = /^(u|i)(8|16|32|64|128|256)$/
const isField = (value: unknown): value is IdlField => isObject(value) && typeof value.name === 'string' && 'type' in value
const definedName = (defined: unknown) => typeof defined === 'string' ? defined : isObject(defined) && typeof defined.name === 'string' ? defined.name : ''

export function typeLabel(type: IdlType): string {
  if (typeof type === 'string') return type === 'publicKey' ? 'pubkey' : type
  if (!isObject(type)) return 'unknown'
  if ('option' in type) return `Option<${typeLabel(type.option as IdlType)}>`
  if ('coption' in type) return `COption<${typeLabel(type.coption as IdlType)}>`
  if ('vec' in type) return `Vec<${typeLabel(type.vec as IdlType)}>`
  if ('array' in type && Array.isArray(type.array)) return `[${typeLabel(type.array[0] as IdlType)}; ${isObject(type.array[1]) ? 'N' : type.array[1]}]`
  if ('defined' in type) return definedName(type.defined) || 'defined'
  if ('generic' in type) return String(type.generic)
  return 'unknown'
}

export function findTypeDef(idl: AnchorIdl | null | undefined, name: string): IdlTypeDef | null {
  if (!idl || !name) return null
  const fromTypes = idl.types?.find(def => def.name === name)
  if (fromTypes) return fromTypes
  const account = idl.accounts?.find(def => def.name === name && def.type)
  return account?.type ? { name: account.name, type: account.type } : null
}

export function describeType(type: IdlType, idl?: AnchorIdl | null, depth = 0): FieldModel {
  const label = typeLabel(type)
  if (depth > 8) return { kind: 'raw', label }
  if (typeof type === 'string') {
    if (INT.test(type)) { const [, sign, bits] = INT.exec(type)!; return { kind: 'int', label, signed: sign === 'i', bits: Number(bits) } }
    if (type === 'f32' || type === 'f64') return { kind: 'float', label }
    if (type === 'bool') return { kind: 'bool', label }
    if (type === 'string') return { kind: 'string', label }
    if (type === 'pubkey' || type === 'publicKey') return { kind: 'pubkey', label: 'pubkey' }
    if (type === 'bytes') return { kind: 'bytes', label }
    return { kind: 'raw', label }
  }
  if (!isObject(type)) return { kind: 'raw', label }
  if ('option' in type || 'coption' in type) return { kind: 'option', label, inner: describeType(('option' in type ? type.option : (type as { coption: IdlType }).coption) as IdlType, idl, depth + 1) }
  if ('vec' in type) return { kind: 'vec', label, inner: describeType(type.vec as IdlType, idl, depth + 1) }
  if ('array' in type && Array.isArray(type.array) && Number.isInteger(type.array[1])) return { kind: 'array', label, inner: describeType(type.array[0] as IdlType, idl, depth + 1), len: Math.min(type.array[1] as number, 512) }
  if ('defined' in type) {
    const def = findTypeDef(idl, definedName(type.defined))
    if (!def || (isObject(type.defined) && Array.isArray(type.defined.generics) && type.defined.generics.length)) return { kind: 'raw', label }
    const kind = def.type.kind
    if (kind === 'struct') {
      const fields = def.type.fields ?? []
      if (fields.length && fields.every(isField)) return { kind: 'struct', label, fields: (fields as IdlField[]).map(field => ({ name: field.name, model: describeType(field.type, idl, depth + 1) })) }
      return { kind: 'tuple', label, items: (fields as IdlType[]).map(item => describeType(item, idl, depth + 1)) }
    }
    if (kind === 'enum') return { kind: 'enum', label, variants: (def.type.variants ?? []).map(variant => {
      const fields = variant.fields ?? []
      if (!fields.length) return { name: variant.name, named: null, tuple: null }
      return fields.every(isField)
        ? { name: variant.name, named: (fields as IdlField[]).map(field => ({ name: field.name, model: describeType(field.type, idl, depth + 1) })), tuple: null }
        : { name: variant.name, named: null, tuple: (fields as IdlType[]).map(item => describeType(item, idl, depth + 1)) }
    }) }
    if (kind === 'type' && def.type.alias) return describeType(def.type.alias, idl, depth + 1)
    return { kind: 'raw', label }
  }
  return { kind: 'raw', label }
}

export const isScalarModel = (model: FieldModel) => ['int', 'float', 'bool', 'string', 'pubkey'].includes(model.kind)

export function defaultValue(model: FieldModel): unknown {
  switch (model.kind) {
    case 'bool': return false
    case 'option': return null
    case 'vec': return []
    case 'array': return Array.from({ length: model.len }, () => defaultValue(model.inner))
    case 'struct': return Object.fromEntries(model.fields.map(field => [field.name, defaultValue(field.model)]))
    case 'tuple': return model.items.map(defaultValue)
    case 'enum': {
      const variant = model.variants[0]
      if (!variant) return null
      if (variant.named) return { [variant.name]: Object.fromEntries(variant.named.map(field => [field.name, defaultValue(field.model)])) }
      if (variant.tuple) return { [variant.name]: variant.tuple.map(defaultValue) }
      return variant.name
    }
    case 'bytes': return []
    default: return ''
  }
}

function intError(model: Extract<FieldModel, { kind: 'int' }>, value: string) {
  if (!/^-?\d+$/.test(value)) return `${model.label} must be a whole number`
  const n = BigInt(value)
  const min = model.signed ? -(2n ** BigInt(model.bits - 1)) : 0n
  const max = model.signed ? 2n ** BigInt(model.bits - 1) - 1n : 2n ** BigInt(model.bits) - 1n
  return n < min || n > max ? `${model.label} must be between ${min} and ${max}` : null
}

// Turns an editor value into the JSON the service expects, or explains why it
// cannot. Integers above 32 bits stay decimal strings ("strings are safer above
// 2^53"); enums are "Variant" or {"Variant": fields}; tuple structs are arrays.
export function normalizeValue(model: FieldModel, value: unknown, path = 'value'): unknown {
  const fail = (message: string): never => { throw new ComposerInputError(path, message) }
  switch (model.kind) {
    case 'int': {
      const v = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim().replace(/_/g, '') : ''
      if (v === '') fail(`enter ${model.label}`)
      const error = intError(model, v)
      if (error) fail(error)
      return model.bits <= 32 ? Number(v) : v
    }
    case 'float': {
      const n = typeof value === 'number' ? value : Number(String(value).trim())
      if (String(value).trim() === '' || !Number.isFinite(n)) fail(`${model.label} must be a number`)
      return n
    }
    case 'bool': {
      if (typeof value === 'boolean') return value
      const v = String(value).trim().toLowerCase()
      if (['true', '1', 'yes'].includes(v)) return true
      if (['false', '0', 'no', ''].includes(v)) return false
      return fail('must be true or false')
    }
    case 'string': return typeof value === 'string' ? value : String(value ?? '')
    case 'pubkey': {
      const v = typeof value === 'string' ? value.trim() : ''
      if (!isAddress(v)) fail('must be a base58 public key')
      return v
    }
    case 'bytes': {
      if (Array.isArray(value)) { if (!value.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) fail('bytes must be 0–255'); return value }
      const v = String(value ?? '').trim().replace(/^0x/i, '')
      if (!/^([0-9a-f]{2})*$/i.test(v)) fail('enter bytes as hex or a JSON array')
      return Array.from({ length: v.length / 2 }, (_, i) => parseInt(v.slice(i * 2, i * 2 + 2), 16))
    }
    case 'option': return value === null || value === undefined || value === '' ? null : normalizeValue(model.inner, value, path)
    case 'vec': {
      if (!Array.isArray(value)) fail('must be a list')
      return (value as unknown[]).map((item, i) => normalizeValue(model.inner, item, `${path}[${i}]`))
    }
    case 'array': {
      if (!Array.isArray(value) || value.length !== model.len) fail(`must have exactly ${model.len} items`)
      return (value as unknown[]).map((item, i) => normalizeValue(model.inner, item, `${path}[${i}]`))
    }
    case 'struct': {
      if (!isObject(value)) fail('must be an object')
      const record = value as Record<string, unknown>
      return Object.fromEntries(model.fields.map(field => [field.name, normalizeValue(field.model, record[field.name], `${path}.${field.name}`)]))
    }
    case 'tuple': {
      if (!Array.isArray(value) || value.length !== model.items.length) fail(`must be a list of ${model.items.length}`)
      return model.items.map((item, i) => normalizeValue(item, (value as unknown[])[i], `${path}[${i}]`))
    }
    case 'enum': {
      const name = typeof value === 'string' ? value : isObject(value) && Object.keys(value).length === 1 ? Object.keys(value)[0] : ''
      const variant = model.variants.find(item => item.name === name) ?? model.variants.find(item => item.name.toLowerCase() === name.toLowerCase())
      if (!variant) return fail(`choose one of ${model.variants.map(item => item.name).join(', ')}`)
      const inner = isObject(value) ? value[name] : undefined
      if (variant.named) {
        if (!isObject(inner)) fail(`${variant.name} needs its fields`)
        const record = inner as Record<string, unknown>
        return { [variant.name]: Object.fromEntries(variant.named.map(field => [field.name, normalizeValue(field.model, record[field.name], `${path}.${variant.name}.${field.name}`)])) }
      }
      if (variant.tuple) {
        if (!Array.isArray(inner) || inner.length !== variant.tuple.length) fail(`${variant.name} needs ${variant.tuple.length} values`)
        return { [variant.name]: variant.tuple.map((item, i) => normalizeValue(item, (inner as unknown[])[i], `${path}.${variant.name}[${i}]`)) }
      }
      return variant.name
    }
    default: return value
  }
}

// Args travel through the URL as text: scalars verbatim, everything else JSON.
export function parseArgText(model: FieldModel, raw: string): unknown {
  if (isScalarModel(model)) return model.kind === 'bool' ? raw.trim() === '' ? false : raw : raw
  if (model.kind === 'option' && raw.trim() === '') return null
  if (model.kind === 'bytes' && !raw.trim().startsWith('[')) return raw
  return JSON.parse(raw)
}
export function argTextOf(model: FieldModel, value: unknown): string {
  if (isScalarModel(model)) return typeof value === 'boolean' ? String(value) : String(value ?? '')
  if (model.kind === 'option' && (value === null || value === undefined)) return ''
  return JSON.stringify(value)
}

export class ComposerInputError extends Error {
  field: string
  constructor(field: string, message: string) { super(`${field}: ${message}`); this.field = field }
}

export interface ArgDef { name: string; type: IdlType; optional?: boolean; note?: string }
export function coerceArgs(defs: ArgDef[], raw: Record<string, string>, idl?: AnchorIdl | null): { value: Record<string, unknown>; errors: Record<string, string> } {
  const value: Record<string, unknown> = {}, errors: Record<string, string> = {}
  for (const def of defs) {
    const model = describeType(def.type, idl)
    const text = raw[def.name] ?? ''
    if (def.optional && text.trim() === '') continue
    try {
      if (model.kind === 'raw') { value[def.name] = looseJson(text); continue }
      value[def.name] = normalizeValue(model, text === '' && !isScalarModel(model) && model.kind !== 'option' ? defaultValue(model) : parseArgText(model, text), def.name)
    } catch (error) {
      errors[def.name] = error instanceof ComposerInputError ? error.message.slice(error.field.length + 2) : error instanceof SyntaxError ? 'not valid JSON' : String(error)
    }
  }
  return { value, errors }
}

// Free-form inputs (seed args, sweep values, raw args): JSON when it parses as
// an object/array/number/bool, otherwise the text itself. Integers beyond 2^53
// stay strings so they keep every digit.
export function looseJson(raw: string): unknown {
  const text = raw.trim()
  if (text === '') return ''
  if (/^-?\d+$/.test(text)) return Number.isSafeInteger(Number(text)) ? Number(text) : text
  if (/^[[{]/.test(text) || text === 'true' || text === 'false' || text === 'null') { try { return JSON.parse(text) } catch { return raw } }
  return raw
}

// --------------------------------------------------- learned interfaces ----

export interface LearnedAccount { name: string; signer?: boolean; writable?: boolean; address?: string; pda?: unknown; evidence?: string }
export interface LearnedInstruction { name: string; discriminator?: number[]; accounts: LearnedAccount[]; argBytes?: number[]; argsHex?: string[]; nameSource?: string; observedIn?: number; exampleSignatures?: string[]; shapeNote?: string; direction?: string | null; samplesGained?: number; samplesLost?: number }
export interface LearnedIdl { address: string; cached?: boolean; caveats?: string[]; evidence?: Record<string, unknown>; howToUse?: string; instructions: LearnedInstruction[]; metadata?: Record<string, unknown>; truncated?: string }

export interface Requirements {
  accounts: { autoFilled: string[]; derived: string[]; mustProvide: { name: string; optional?: boolean; signer?: boolean; writable?: boolean; evidence?: string }[] }
  args: ArgDef[]
  instruction?: string
  note?: string
  programId?: string
}
// Learned accounts are positional: a fixed address or a seed recipe is filled
// in by the service; everything else must be supplied.
export function learnedRequirements(ix: LearnedInstruction): Requirements {
  const autoFilled: string[] = [], derived: string[] = [], mustProvide: Requirements['accounts']['mustProvide'] = []
  for (const account of ix.accounts ?? []) {
    if (account.address) autoFilled.push(account.name)
    else if (account.pda) derived.push(account.name)
    else mustProvide.push({ name: account.name, signer: !!account.signer, writable: !!account.writable, optional: false, evidence: account.evidence })
  }
  return { accounts: { autoFilled, derived, mustProvide }, args: [], instruction: ix.name }
}

export const NATIVE_INSTRUCTIONS: { name: string; args: ArgDef[]; note: string }[] = [
  { name: 'transfer', args: [{ name: 'to', type: 'pubkey' }, { name: 'lamports', type: 'u64' }], note: 'System transfer from the payer.' },
  { name: 'createAtaIdempotent', args: [{ name: 'mint', type: 'pubkey' }, { name: 'owner', type: 'pubkey', optional: true, note: 'defaults to the payer' }, { name: 'tokenProgram', type: 'pubkey', optional: true, note: 'set Token-2022 for Token-2022 mints' }], note: 'Creates the associated token account if it does not exist.' },
  { name: 'syncNative', args: [], note: 'Syncs the payer’s wrapped-SOL account.' },
  { name: 'closeAccount', args: [], note: 'Closes the payer’s wrapped-SOL account back to the payer.' },
  { name: 'createLookupTable', args: [{ name: 'recentSlot', type: 'u64' }], note: 'Creates an address lookup table owned by the payer.' },
  { name: 'extendLookupTable', args: [{ name: 'table', type: 'pubkey' }, { name: 'addresses', type: { vec: 'pubkey' } }], note: 'Appends addresses to a lookup table.' },
]

// ------------------------------------------------------------- requests ----

const ensure = (condition: unknown, field: string, message: string) => { if (!condition) throw new ComposerInputError(field, message) }
const uint = (value: string, field: string, max?: number) => {
  if (value === '') return undefined
  ensure(/^\d+$/.test(value), field, 'must be a whole number')
  const n = Number(value)
  ensure(Number.isSafeInteger(n) && (max === undefined || n <= max), field, max === undefined ? 'is too large' : `must be at most ${max}`)
  return n
}
const requirePayer = (payer: string | null | undefined) => { ensure(isAddress(payer ?? ''), 'payer', 'connect a wallet or paste a payer address'); return payer!.trim() }

const programList = (programs: string[]) => {
  programs.forEach(program => ensure(isProgramRef(program), 'programs', `${program} is not a program id`))
  return programs.map(program => program.trim())
}
export function intentBody(state: ComposerState, payer: string | null) {
  ensure(state.intent.trim(), 'intent', 'say what you want to do')
  const body: Record<string, unknown> = { intent: state.intent.trim(), payer: requirePayer(payer), maxPlans: state.maxPlans }
  if (state.programs.length) body.programs = programList(state.programs)
  return body
}
export function yoloBody(state: ComposerState, payer: string | null) {
  ensure(state.intent.trim(), 'intent', 'say what you want to do')
  const body: Record<string, unknown> = { intent: state.intent.trim(), payer: requirePayer(payer) }
  const attempts = uint(state.maxAttempts, 'maxAttempts', YOLO_LIMITS.maxAttempts), timeout = uint(state.timeoutMs, 'timeoutMs', YOLO_LIMITS.timeoutMs), spend = uint(state.maxSpend, 'maxSpend', YOLO_LIMITS.maxSpend)
  if (attempts !== undefined) body.maxAttempts = attempts
  if (timeout !== undefined) body.timeoutMs = timeout
  if (spend !== undefined) body.maxSpend = spend
  if (state.programs.length) body.programs = programList(state.programs)
  return body
}

export function txOptions(options: TxOptionsState) {
  const out: Record<string, unknown> = {}
  const cu = uint(options.cu, 'computeUnitLimit', 1_400_000), fee = uint(options.priorityFee, 'priorityFeeMicroLamports'), tip = uint(options.tip, 'tipLamports')
  if (cu !== undefined) out.computeUnitLimit = cu
  if (fee !== undefined) out.priorityFeeMicroLamports = fee
  if (tip !== undefined) out.tipLamports = tip
  if (options.luts.length) { options.luts.forEach(lut => ensure(isAddress(lut), 'lookupTables', `${lut} is not a public key`)); out.lookupTables = options.luts }
  if (options.blockhash.trim()) out.blockhash = options.blockhash.trim()
  if (options.simulate) out.simulate = true
  if (options.dryRun) out.dryRun = true
  return out
}

export type InterfaceRef = { kind: 'published'; idl: AnchorIdl | null } | { kind: 'learned'; learned: LearnedIdl } | { kind: 'native' }

// The instruction spec shared by /tx/build, /diagnose and /tx/batch steps.
export function instructionSpec(state: Pick<ComposerState, 'program' | 'ix' | 'args' | 'accounts' | 'argsHex' | 'extra'>, iface: InterfaceRef, argDefs: ArgDef[], payer?: string | null): BatchStep & { idl?: unknown } {
  const program = state.program.trim()
  ensure(isProgramRef(program), 'program', 'enter a program id')
  ensure(state.ix.trim(), 'instruction', 'choose an instruction')
  const accounts: Record<string, string> = {}
  for (const [name, value] of Object.entries(state.accounts)) {
    if (!value.trim()) continue
    ensure(isAddress(value), `accounts.${name}`, 'must be a base58 public key')
    accounts[name] = value.trim()
  }
  const spec: BatchStep & { idl?: unknown } = { programId: program, instruction: state.ix.trim(), args: {}, accounts }
  if (iface.kind === 'learned') {
    // Learned instructions carry opaque argument bytes; signer slots left
    // blank are the payer's to sign.
    const ix = iface.learned.instructions.find(item => item.name === spec.instruction)
    for (const account of ix?.accounts ?? []) if (account.signer && !accounts[account.name] && !account.address && !account.pda && isAddress(payer ?? '')) accounts[account.name] = payer!.trim()
    spec.idl = iface.learned
    ensure(/^([0-9a-f]{2})*$/i.test(state.argsHex), 'argsHex', 'must be hex bytes')
    if (state.argsHex) spec.argsHex = state.argsHex.toLowerCase()
  } else {
    const { value, errors } = coerceArgs(argDefs, state.args, iface.kind === 'published' ? iface.idl : null)
    const failed = Object.entries(errors)[0]
    if (failed) throw new ComposerInputError(`args.${failed[0]}`, failed[1])
    // Keep args the form does not know about (e.g. hand-written deep links).
    for (const [name, text] of Object.entries(state.args)) if (!(name in value) && text !== '' && !argDefs.length) value[name] = looseJson(text)
    spec.args = value
    if (state.argsHex) { ensure(/^([0-9a-f]{2})*$/i.test(state.argsHex), 'argsHex', 'must be hex bytes'); spec.argsHex = state.argsHex.toLowerCase() }
  }
  const extra = state.extra.filter(item => item.pubkey.trim())
  extra.forEach(item => ensure(isAddress(item.pubkey), 'extraAccounts', `${item.pubkey} is not a public key`))
  if (extra.length) spec.extraAccounts = extra
  return spec
}

export function buildBody(state: ComposerState, payer: string | null, iface: InterfaceRef, argDefs: ArgDef[]) {
  const who = requirePayer(payer)
  const spec = instructionSpec(state, iface, argDefs, who)
  const body: Record<string, unknown> = { payer: who, instruction: spec.instruction, args: spec.args, accounts: spec.accounts }
  if (spec.idl) body.idl = spec.idl
  else body.programId = spec.programId
  if (spec.argsHex) body.argsHex = spec.argsHex
  if (spec.extraAccounts) body.extraAccounts = spec.extraAccounts
  const options = txOptions(state.options)
  if (Object.keys(options).length) body.options = options
  return body
}
export const diagnoseBody = buildBody

export function landBody(state: ComposerState, payer: string | null) {
  ensure(isAddress(state.program), 'program', 'enter the program id')
  ensure(state.ix.trim(), 'instruction', 'choose a learned instruction')
  const body: Record<string, unknown> = { programId: state.program.trim(), instruction: state.ix.trim(), payer: requirePayer(payer) }
  if (state.mint.trim()) { ensure(isAddress(state.mint), 'mint', 'must be a base58 mint'); body.mint = state.mint.trim() }
  const signatures = uint(state.signatures, 'signatures', 5000)
  if (signatures !== undefined) body.signatures = signatures
  if (state.refresh) body.refresh = true
  return body
}
// A deliberately unknown name makes /land answer with the instruction names it
// has observed, without building anything.
export const LAND_LIST_NAME = '__list_instructions__'
export function landListBody(program: string, payer: string | null) {
  return { programId: program.trim(), instruction: LAND_LIST_NAME, payer: isAddress(payer ?? '') ? payer!.trim() : '11111111111111111111111111111111' }
}

const seedRecord = (record: Record<string, string>, prefix: string, check: boolean) => {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(record)) {
    if (value.trim() === '') continue
    if (check) ensure(isAddress(value), `${prefix}.${name}`, 'must be a base58 public key')
    out[name] = check ? value.trim() : looseJson(value)
  }
  return out
}
export function deriveBody(state: ComposerState) {
  ensure(isProgramRef(state.program), 'program', 'enter the program id')
  ensure(state.account.trim(), 'account', 'choose an account to derive')
  return { programId: state.program.trim(), account: state.account.trim(), accounts: seedRecord(state.accounts, 'accounts', true), args: seedRecord(state.args, 'args', false) }
}
export function probeBody(state: ComposerState) {
  const base = deriveBody(state)
  ensure(state.sweep.trim(), 'sweep', 'name the seed input to sweep')
  ensure(state.values.length, 'values', 'add at least one value to try')
  const accounts = { ...base.accounts }, args = { ...base.args }
  delete accounts[state.sweep]; delete args[state.sweep]
  return { ...base, accounts, args, sweep: state.sweep.trim(), values: state.values.map(looseJson), existingOnly: state.existingOnly }
}
export function findBody(state: ComposerState, fieldTypes: Record<string, string> = {}) {
  ensure(isAddress(state.program), 'program', 'enter the program id')
  ensure(state.account.trim(), 'account', 'choose an account type')
  const where: Record<string, unknown> = {}
  for (const [path, value] of Object.entries(state.where)) {
    if (value.trim() === '') continue
    where[path] = fieldTypes[path] === 'bool' ? ['true', '1'].includes(value.trim().toLowerCase()) : value.trim()
  }
  const body: Record<string, unknown> = { programId: state.program.trim(), account: state.account.trim(), where }
  if (state.select.length) body.select = state.select
  const limit = uint(state.limit, 'limit', 10_000)
  if (limit !== undefined) body.limit = limit
  if (state.force) body.force = true
  return body
}
export function batchBody(state: ComposerState, payer: string | null) {
  const who = requirePayer(payer)
  ensure(state.batch.instructions.length, 'instructions', 'add at least one instruction')
  state.batch.instructions.forEach((step, i) => {
    ensure(isProgramRef(step.programId), `instructions[${i}].programId`, 'enter a program id')
    ensure(step.instruction, `instructions[${i}].instruction`, 'name the instruction')
  })
  if (state.batch.mode === 'bundle' && state.batch.split.length) {
    const seen = state.batch.split.flat()
    ensure(seen.every(i => i < state.batch.instructions.length), 'split', 'refers to a step that does not exist')
  }
  const body: Record<string, unknown> = { payer: who, ...batchSpec(state.batch) }
  const options = txOptions(state.options)
  if (Object.keys(options).length) body.options = options
  return body
}
export function sendBody(transaction: string) {
  const tx = transaction.trim().replace(/\s+/g, '')
  ensure(/^[A-Za-z0-9+/]+={0,2}$/.test(tx) && tx.length >= 100, 'transaction', 'paste a base64 signed transaction')
  return { transaction: tx }
}

// ------------------------------------------------------------ responses ----

// `stale`: the blockhash expired, so the transaction must be rebuilt, never resent.
// `rebuild`: the service's guidance says to rebuild rather than resend.
export interface ComposerFailure { status: number; message: string; guidance: Record<string, unknown> | null; raw: string; missingField: string | null; stale: boolean; rebuild: boolean }
export class ComposerError extends Error {
  failure: ComposerFailure
  constructor(failure: ComposerFailure) { super(failure.message); this.failure = failure }
}
const STALE = /blockhash ?not ?found|blockhashnotfound|block height exceeded|transaction expired|blockhash (has )?expired|stale blockhash/i
export function parseComposerError(status: number, raw: string): ComposerFailure {
  let message = raw.trim(), guidance: Record<string, unknown> | null = null
  try {
    const data = JSON.parse(raw)
    if (isObject(data)) {
      if (typeof data.error === 'string') message = data.error
      else if (isObject(data.error) && typeof data.error.message === 'string') message = data.error.message
      if (isObject(data.guidance)) guidance = data.guidance
    }
  } catch { /* plain-text serde rejection */ }
  message = message.replace(/^Failed to deserialize the JSON body into the target type: /, '').replace(/ at line \d+ column \d+$/, '')
  const missing = /missing field `([^`]+)`/.exec(message)
  const note = guidance && typeof guidance.note === 'string' ? guidance.note : ''
  const stale = STALE.test(message)
  return { status, message: message || `The Composer returned HTTP ${status}`, guidance, raw, missingField: missing?.[1] ?? null, stale, rebuild: stale || /rebuil/i.test(note) }
}
export const failureOf = (error: unknown): ComposerFailure => error instanceof ComposerError ? error.failure
  : { status: 0, message: error instanceof Error ? error.message : 'The request could not finish.', guidance: null, raw: '', missingField: null, stale: error instanceof Error && STALE.test(error.message), rebuild: error instanceof Error && STALE.test(error.message) }

export async function composerRequest<T>(path: string, body?: unknown, signal?: AbortSignal, base = COMPOSER_URL): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new ComposerError({ status: 0, message: 'Could not reach the Composer service. Check your connection and try again.', guidance: null, raw: String(error), missingField: null, stale: false, rebuild: false })
  }
  const raw = await response.text()
  if (!response.ok) throw new ComposerError(parseComposerError(response.status, raw))
  try { return JSON.parse(raw) as T } catch { throw new ComposerError({ status: response.status, message: 'The Composer returned a response that is not JSON.', guidance: null, raw, missingField: null, stale: false, rebuild: false }) }
}

export const NO_PUBLISHED_IDL = /no published IDL/i

export type Tone = 'good' | 'bad' | 'warn' | 'muted'
export function verdictTone(verdict: unknown): Tone {
  const v = String(verdict ?? '').toLowerCase()
  if (v === 'simulated' || v === 'ok' || v === 'success' || v === 'landed' || v === 'succeeded') return 'good'
  if (v.includes('fail') || v === 'gave-up' || v === 'error' || v === 'rejected') return 'bad'
  if (v === 'unbuildable' || v === 'skipped') return 'muted'
  return 'warn'
}
export const VERDICT_LABEL: Record<string, string> = {
  simulated: 'Simulates clean', 'simulation-failed': 'Simulation failed', unbuildable: 'Could not build', 'built-unsimulated': 'Built · not simulated', 'gave-up': 'Gave up', 'build-failed': 'Build failed',
}
export const verdictLabel = (verdict: unknown) => VERDICT_LABEL[String(verdict)] ?? String(verdict ?? 'unknown')

export interface SimulationSummary {
  ok: boolean
  kind: string
  errorName: string | null
  errorMessage: string | null
  errorCode: string | null
  failingProgram: string | null
  instructionIndex: number | null
  thrownIn: string | null
  note: string | null
  logs: string[]
  unitsConsumed: number | null
  fee: number | null
  bundle: { index: number; ok: boolean; err: string | null; logs: string[]; unitsConsumed: number | null }[] | null
}
const jsonText = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value)
export function summarizeSimulation(simulation: unknown): SimulationSummary | null {
  if (!isObject(simulation)) return null
  const result = isObject(simulation.result) ? simulation.result : null
  const value = result && isObject(result.value) ? result.value : isObject(simulation.value) ? simulation.value : simulation
  const error = isObject(simulation.error) ? simulation.error : null
  const kind = typeof simulation.kind === 'string' ? simulation.kind : 'transaction'
  const summary: SimulationSummary = { ok: false, kind, errorName: null, errorMessage: null, errorCode: null, failingProgram: null, instructionIndex: null, thrownIn: null, note: null, logs: [], unitsConsumed: null, fee: null, bundle: null }
  if (kind === 'bundle' && isObject(value)) {
    const results = Array.isArray(value.transactionResults) ? value.transactionResults : []
    summary.bundle = results.map((item: unknown, index: number) => {
      const r = isObject(item) ? item : {}
      return { index, ok: r.err === null || r.err === undefined, err: r.err === null || r.err === undefined ? null : jsonText(r.err), logs: Array.isArray(r.logs) ? r.logs.map(String) : [], unitsConsumed: typeof r.unitsConsumed === 'number' ? r.unitsConsumed : null }
    })
    const s = value.summary
    summary.ok = s === 'succeeded' || (isObject(s) && 'succeeded' in s)
    if (!summary.ok && isObject(s) && isObject(s.failed)) {
      const failed = s.failed
      const failure = isObject(failed.error) && Array.isArray(failed.error.TransactionFailure) ? failed.error.TransactionFailure[1] : failed.error
      summary.errorMessage = typeof failure === 'string' ? failure : jsonText(failure)
    }
    summary.logs = summary.bundle.flatMap(item => item.logs)
  } else if (isObject(value)) {
    summary.ok = value.err === null || (value.err === undefined && !error)
    if (value.err !== null && value.err !== undefined) summary.errorCode = jsonText(value.err)
    summary.logs = Array.isArray(value.logs) ? value.logs.map(String) : []
    summary.unitsConsumed = typeof value.unitsConsumed === 'number' ? value.unitsConsumed : null
    summary.fee = typeof value.fee === 'number' ? value.fee : null
  }
  if (error) {
    summary.ok = false
    summary.errorName = typeof error.name === 'string' ? error.name : null
    summary.errorMessage = typeof error.message === 'string' ? error.message : summary.errorMessage
    if (error.code !== undefined && error.code !== null) summary.errorCode = String(error.code)
    summary.failingProgram = typeof error.failingProgram === 'string' ? error.failingProgram : null
    summary.instructionIndex = typeof error.instructionIndex === 'number' ? error.instructionIndex : null
    summary.thrownIn = typeof error.thrownIn === 'string' ? error.thrownIn : null
    summary.note = typeof error.note === 'string' ? error.note : null
  }
  return summary
}

export interface ResolvedAccount { name: string; pubkey: string; signer: boolean; writable: boolean; optional?: boolean; source?: string }
export function resolvedAccountsOf(response: unknown): { step: string | null; accounts: ResolvedAccount[] }[] {
  if (!isObject(response)) return []
  const norm = (list: unknown): ResolvedAccount[] => Array.isArray(list) ? list.filter(isObject).map(item => ({ name: String(item.name ?? ''), pubkey: String(item.pubkey ?? ''), signer: item.signer === true, writable: item.writable === true, optional: item.optional === true, source: typeof item.source === 'string' ? item.source : undefined })) : []
  if (Array.isArray(response.resolvedAccounts)) return [{ step: null, accounts: norm(response.resolvedAccounts) }]
  if (Array.isArray(response.steps)) return response.steps.filter(isObject).map((step, i) => ({ step: `${i + 1}. ${String(step.instruction ?? '')}${typeof step.programId === 'string' ? ` · ${step.programId}` : ''}`, accounts: norm(step.resolvedAccounts) }))
  return []
}

// A transaction the service returned for the payer to sign: a single tx, or an
// ordered Jito bundle that must be signed in order and sent together.
export interface BuiltTransaction { transaction: string; signers: string[]; bytes: number | null; steps: number[] | null }
export interface BuiltResult { mode: 'single' | 'bundle' | 'none'; transactions: BuiltTransaction[]; blockhash: string | null; jito: { endpoints: string[]; rules: string[]; tipAccounts: string[] } | null; submit: string | null }
export function builtResultOf(response: unknown): BuiltResult {
  const none: BuiltResult = { mode: 'none', transactions: [], blockhash: null, jito: null, submit: null }
  if (!isObject(response)) return none
  const blockhash = typeof response.blockhash === 'string' ? response.blockhash : null
  const submit = typeof response.submit === 'string' ? response.submit : null
  const signers = (value: unknown) => Array.isArray(value) ? value.map(String) : []
  if (Array.isArray(response.bundle) && response.bundle.length) {
    const jito = isObject(response.jito) ? response.jito : {}
    return { mode: 'bundle', blockhash, submit,
      transactions: response.bundle.filter(isObject).filter(item => typeof item.transaction === 'string').map(item => ({ transaction: item.transaction as string, signers: signers(item.signers), bytes: typeof item.bytes === 'number' ? item.bytes : null, steps: Array.isArray(item.steps) ? item.steps.filter((n: unknown): n is number => typeof n === 'number') : null })),
      jito: { endpoints: Array.isArray(jito.endpoints) ? jito.endpoints.map(String).filter(url => /^https:\/\/[a-z0-9.-]+\.jito\.wtf\//.test(url)) : [], rules: Array.isArray(jito.rules) ? jito.rules.map(String) : [], tipAccounts: Array.isArray(jito.tipAccounts) ? jito.tipAccounts.map(String) : [] } }
  }
  if (typeof response.transaction === 'string' && response.transaction) return { mode: 'single', blockhash, submit, jito: null, transactions: [{ transaction: response.transaction, signers: signers(response.signers), bytes: typeof response.bytes === 'number' ? response.bytes : null, steps: null }] }
  return none
}

// /send answers with the signature; accept the shapes a relay commonly uses.
export function signatureOf(response: unknown): string | null {
  if (typeof response === 'string') return response
  if (!isObject(response)) return null
  for (const key of ['signature', 'txid', 'result']) if (typeof response[key] === 'string') return response[key] as string
  return null
}

export interface IntentPlan { summary?: string; why?: string; verdict?: string; confidence?: unknown; detail?: string; transaction?: string | null; simulation?: unknown; instructions?: unknown; bundle?: unknown; land?: unknown; [key: string]: unknown }

// The signable part of a plan: its own transaction, a bundle it carries (as a
// list of transactions or a whole batch response), or a /land result.
export function planResponse(plan: IntentPlan): Record<string, unknown> | null {
  if (typeof plan.transaction === 'string' && plan.transaction) return plan
  if (Array.isArray(plan.bundle) && plan.bundle.length) return { ...plan, bundle: plan.bundle }
  if (isObject(plan.bundle) && builtResultOf(plan.bundle).mode !== 'none') return plan.bundle
  if (isObject(plan.land) && builtResultOf(plan.land).mode !== 'none') return plan.land
  return null
}
export const planInstructions = (plan: IntentPlan): BatchStep[] | null => {
  const batch = batchFromSpec({ instructions: plan.instructions })
  return batch && batch.instructions.length ? batch.instructions : null
}
// `programsConsidered` is a count in current responses; older shapes listed ids.
export const consideredOf = (value: unknown): { count: number; ids: string[] } =>
  typeof value === 'number' ? { count: value, ids: [] } : Array.isArray(value) ? { count: value.length, ids: value.map(item => typeof item === 'string' ? item : JSON.stringify(item)) } : { count: 0, ids: [] }
export interface IntentResponse { intent?: string; payer?: string; plans?: IntentPlan[]; programsConsidered?: unknown; ranking?: unknown; [key: string]: unknown }
export interface YoloAttempt { attempt?: number; detail?: string; instructions?: BatchStep[]; summary?: string; verdict?: string; [key: string]: unknown }
export interface YoloResponse { verdict?: string; attempts?: number; log?: YoloAttempt[]; closest?: YoloAttempt; guidance?: Record<string, unknown>; transaction?: string; elapsedMs?: number; modelCalls?: number; spentMicros?: number; [key: string]: unknown }

// A yolo attempt carries real instruction specs; reopen them in Batch.
export function batchHrefFromInstructions(instructions: unknown, payer?: string) {
  const batch = batchFromSpec({ instructions })
  return batch && batch.instructions.length ? composerHref({ tab: 'batch', batch, payer: payer ?? '' }) : null
}

export const solscanTx = (signature: string) => `https://solscan.io/tx/${signature}`
export const solscanAccount = (address: string) => `https://solscan.io/account/${address}`
export const TX_STALE_MS = 60_000
