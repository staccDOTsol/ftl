// Requirements-driven instruction forms: typed Anchor argument editors, the
// accounts a caller must provide, and the advanced transaction options.
import { useMemo, useState } from 'react'
import { argTextOf, defaultValue, describeType, isAddress, isScalarModel, NATIVE_INSTRUCTIONS, typeLabel, type AnchorIdl, type ArgDef, type ComposerState, type ExtraAccount, type FieldModel, type LearnedInstruction, type Requirements, type TxOptionsState } from '@/lib/composer'
import type { InterfaceState, ProgramInterface } from '@/lib/use-composer'
import { short } from '@/lib/format'
import { Badge, CallStatus, Field, FailureNotice, LinesInput } from './ComposerUI.web'
import { Icon } from './MarketUI.web'

type Patch = (next: Partial<ComposerState>) => void

// ------------------------------------------------------------ editors ----

export function JsonTextEditor({ id, value, onChange, label, rows = 4 }: { id?: string; value: unknown; onChange: (value: unknown) => void; label: string; rows?: number }) {
  const text = JSON.stringify(value ?? null, null, 1)
  const [draft, setDraft] = useState(text)
  const [seen, setSeen] = useState(text)
  const [error, setError] = useState<string | null>(null)
  if (seen !== text) { setSeen(text); setDraft(text); setError(null) }
  return <div className="lq-composer-json-input">
    <textarea id={id} aria-label={label} rows={rows} value={draft} spellCheck={false} onChange={event => {
      setDraft(event.target.value)
      try { const parsed = JSON.parse(event.target.value); setError(null); setSeen(JSON.stringify(parsed ?? null, null, 1)); onChange(parsed) } catch { setError('Not valid JSON yet') }
    }} />
    {error ? <small className="lq-composer-field-error">{error}</small> : null}
  </div>
}

export function ValueEditor({ model, value, onChange, label, id, payer, depth = 0 }: { model: FieldModel; value: unknown; onChange: (value: unknown) => void; label: string; id?: string; payer?: string | null; depth?: number }) {
  switch (model.kind) {
    case 'int': case 'float': case 'string': case 'pubkey': {
      const numeric = model.kind === 'int' || model.kind === 'float'
      return <span className="lq-composer-input-row">
        <input id={id} aria-label={label} value={String(value ?? '')} inputMode={numeric ? model.kind === 'int' ? 'numeric' : 'decimal' : undefined} placeholder={model.label} spellCheck={false} autoComplete="off" autoCapitalize="off" onChange={event => onChange(event.target.value)} />
        {model.kind === 'pubkey' && payer && value !== payer ? <button type="button" className="lq-composer-chip" onClick={() => onChange(payer)} aria-label={`Use the payer for ${label}`}>payer</button> : null}
      </span>
    }
    case 'bool':
      return <label className="lq-composer-check"><input id={id} type="checkbox" checked={value === true || value === 'true'} onChange={event => onChange(event.target.checked)} /><span>{value === true || value === 'true' ? 'true' : 'false'}</span></label>
    case 'option': {
      const some = value !== null && value !== undefined && value !== ''
      return <div className="lq-composer-nested">
        <label className="lq-composer-check"><input id={id} type="checkbox" checked={some} aria-label={`${label}: provide a value`} onChange={event => onChange(event.target.checked ? defaultValue(model.inner) : null)} /><span>{some ? 'Some' : 'None'} <small>{model.label}</small></span></label>
        {some ? <ValueEditor model={model.inner} value={value} onChange={onChange} label={`${label} value`} payer={payer} depth={depth + 1} /> : null}
      </div>
    }
    case 'vec': {
      const items = Array.isArray(value) ? value : []
      return <div className="lq-composer-nested">
        {items.map((item, i) => <div className="lq-composer-item" key={i}><span>{i}</span><ValueEditor model={model.inner} value={item} label={`${label} item ${i + 1}`} payer={payer} depth={depth + 1} onChange={next => onChange(items.map((old, j) => j === i ? next : old))} /><button type="button" className="lq-composer-mini" aria-label={`Remove ${label} item ${i + 1}`} onClick={() => onChange(items.filter((_, j) => j !== i))}><Icon name="close" size={12} /></button></div>)}
        <button type="button" className="lq-text-button" onClick={() => onChange([...items, defaultValue(model.inner)])}><Icon name="plus" size={12} />Add {typeLabelOf(model.inner)}</button>
      </div>
    }
    case 'array': {
      const items = Array.isArray(value) ? value : []
      if (model.len > 16 || !isScalarModel(model.inner)) return <JsonTextEditor id={id} value={value} onChange={onChange} label={label} />
      return <div className="lq-composer-nested lq-composer-grid">{Array.from({ length: model.len }, (_, i) => <ValueEditor key={i} model={model.inner} value={items[i]} label={`${label} [${i}]`} payer={payer} depth={depth + 1} onChange={next => onChange(Array.from({ length: model.len }, (_, j) => j === i ? next : items[j] ?? defaultValue(model.inner)))} />)}</div>
    }
    case 'struct': {
      const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
      return <fieldset className="lq-composer-nested"><legend>{model.label}</legend>{model.fields.map(field => <div className="lq-composer-subfield" key={field.name}>
        <span>{field.name}<small>{field.model.label}</small></span>
        <ValueEditor model={field.model} value={record[field.name]} label={`${label}.${field.name}`} payer={payer} depth={depth + 1} onChange={next => onChange({ ...record, [field.name]: next })} />
      </div>)}</fieldset>
    }
    case 'tuple': {
      const items = Array.isArray(value) ? value : []
      return <fieldset className="lq-composer-nested"><legend>{model.label}</legend>{model.items.map((item, i) => <div className="lq-composer-subfield" key={i}>
        <span>{i}<small>{item.label}</small></span>
        <ValueEditor model={item} value={items[i]} label={`${label}[${i}]`} payer={payer} depth={depth + 1} onChange={next => onChange(model.items.map((m, j) => j === i ? next : items[j] ?? defaultValue(m)))} />
      </div>)}</fieldset>
    }
    case 'enum': {
      const name = typeof value === 'string' ? value : value && typeof value === 'object' ? Object.keys(value)[0] ?? '' : ''
      const variant = model.variants.find(item => item.name === name) ?? model.variants[0]
      const inner = value && typeof value === 'object' ? (value as Record<string, unknown>)[variant?.name ?? ''] : undefined
      const pick = (next: string) => {
        const chosen = model.variants.find(item => item.name === next)
        if (!chosen) return
        onChange(chosen.named ? { [chosen.name]: Object.fromEntries(chosen.named.map(field => [field.name, defaultValue(field.model)])) } : chosen.tuple ? { [chosen.name]: chosen.tuple.map(defaultValue) } : chosen.name)
      }
      return <div className="lq-composer-nested">
        <select id={id} aria-label={`${label} variant`} value={variant?.name ?? ''} onChange={event => pick(event.target.value)}>{model.variants.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select>
        {variant?.named ? variant.named.map(field => <div className="lq-composer-subfield" key={field.name}><span>{field.name}<small>{field.model.label}</small></span>
          <ValueEditor model={field.model} value={(inner as Record<string, unknown> | undefined)?.[field.name]} label={`${label}.${field.name}`} payer={payer} depth={depth + 1} onChange={next => onChange({ [variant.name]: { ...(inner as Record<string, unknown> ?? {}), [field.name]: next } })} /></div>) : null}
        {variant?.tuple ? variant.tuple.map((item, i) => <div className="lq-composer-subfield" key={i}><span>{i}<small>{item.label}</small></span>
          <ValueEditor model={item} value={Array.isArray(inner) ? inner[i] : undefined} label={`${label}.${variant.name}[${i}]`} payer={payer} depth={depth + 1} onChange={next => onChange({ [variant.name]: variant.tuple!.map((m, j) => j === i ? next : Array.isArray(inner) ? inner[j] : defaultValue(m)) })} /></div>) : null}
      </div>
    }
    default:
      return <JsonTextEditor id={id} value={value} onChange={onChange} label={label} />
  }
}
const typeLabelOf = (model: FieldModel) => model.label

// One top-level instruction argument. Its value lives in the URL as text:
// scalars verbatim, structured values as JSON.
export function ArgField({ def, idl, text, onText, error, payer }: { def: ArgDef; idl?: AnchorIdl | null; text: string; onText: (text: string) => void; error?: string | null; payer?: string | null }) {
  const model = useMemo(() => describeType(def.type, idl), [def.type, idl])
  const [asJson, setAsJson] = useState(false)
  const parsed = useMemo(() => {
    if (isScalarModel(model)) return { ok: true, value: text }
    if (text.trim() === '') return { ok: true, value: model.kind === 'option' ? null : defaultValue(model) }
    try { return { ok: true, value: JSON.parse(text) as unknown } } catch { return { ok: false, value: null } }
  }, [model, text])
  const structured = !isScalarModel(model) && model.kind !== 'raw' && model.kind !== 'bytes'
  return <Field label={<><code>{def.name}</code><small>{typeLabel(def.type)}{def.optional ? ' · optional' : ''}</small>{structured ? <button type="button" className="lq-composer-chip" aria-pressed={asJson} onClick={() => setAsJson(value => !value)}>{asJson ? 'Form' : 'JSON'}</button> : null}</>} error={error} hint={def.note}>
    {id => structured && !asJson && parsed.ok
      ? <ValueEditor id={id} model={model} value={parsed.value} label={def.name} payer={payer} onChange={next => onText(argTextOf(model, next))} />
      : model.kind === 'bool' ? <ValueEditor id={id} model={model} value={text} label={def.name} onChange={next => onText(String(next))} />
        : isScalarModel(model) ? <ValueEditor id={id} model={model} value={text} label={def.name} payer={payer} onChange={next => onText(String(next))} />
          : <textarea id={id} rows={3} value={text} spellCheck={false} placeholder={model.kind === 'bytes' ? 'hex bytes or a JSON array' : 'JSON'} onChange={event => onText(event.target.value)} />}
  </Field>
}

export function AccountInput({ name, value, onChange, payer, flags, evidence, required }: { name: string; value: string; onChange: (value: string) => void; payer?: string | null; flags?: { signer?: boolean; writable?: boolean; optional?: boolean }; evidence?: string; required?: boolean }) {
  const invalid = value.trim() !== '' && !isAddress(value)
  return <Field label={<><code>{name}</code><span className="lq-composer-flags">{flags?.signer ? <b title="Signer">S</b> : null}{flags?.writable ? <b title="Writable">W</b> : null}{flags?.optional ? <i>optional</i> : required ? <i>required</i> : null}</span></>}
    error={invalid ? 'Not a base58 public key' : null} hint={evidence}>
    {id => <span className="lq-composer-input-row">
      <input id={id} value={value} placeholder={flags?.signer ? 'blank = the payer signs' : 'base58 address'} spellCheck={false} autoComplete="off" autoCapitalize="off" onChange={event => onChange(event.target.value.trim())} />
      {payer && value !== payer ? <button type="button" className="lq-composer-chip" onClick={() => onChange(payer)} aria-label={`Use the payer for ${name}`}>payer</button> : null}
    </span>}
  </Field>
}

// ------------------------------------------------------------ program ----

export function ProgramField({ value, onChange, iface, label = 'Program', allowNative = false }: { value: string; onChange: (value: string) => void; iface?: InterfaceState & { cancel: () => void; retry: () => void; learn: () => void }; label?: string; allowNative?: boolean }) {
  const text = value.trim()
  const invalid = text !== '' && !(allowNative && text === 'native') && !isAddress(text)
  return <div className="lq-composer-program">
    <Field label={label} error={invalid ? 'Enter a base58 program id' : null} hint={allowNative ? 'A program id, or “native” for transfers, ATAs and lookup tables.' : undefined} wide>
      {id => <input id={id} value={value} placeholder="Program id" spellCheck={false} autoComplete="off" autoCapitalize="off" onChange={event => onChange(event.target.value.trim())} />}
    </Field>
    {iface ? <InterfaceStatus iface={iface} /> : null}
  </div>
}

export function InterfaceStatus({ iface }: { iface: InterfaceState & { cancel: () => void; retry: () => void; learn: () => void } }) {
  if (iface.status === 'loading-published') return <CallStatus running startedAt={iface.startedAt} label="Reading the published IDL…" onCancel={iface.cancel} />
  if (iface.status === 'loading-learned') return <CallStatus running startedAt={iface.startedAt} label="Learning the interface from landed transactions…" slowNote="uncached programs can take minutes" onCancel={iface.cancel} />
  if (iface.status === 'error' && iface.error) return <FailureNotice failure={iface.error} title="Could not read this program’s interface" />
  if (iface.status === 'no-idl') return <div className="lq-composer-iface is-missing"><Badge tone="warn">No published IDL</Badge><p>{iface.publishedError}</p><button type="button" className="lq-button lq-button-sm" onClick={iface.learn}>Learn it from landed transactions</button></div>
  const current = iface.iface
  if (!current) return null
  if (current.kind === 'native') return <div className="lq-composer-iface"><Badge tone="good">Built-in instructions</Badge><p>Transfers, associated token accounts and lookup tables, built by the service.</p></div>
  if (current.kind === 'published') {
    const meta = current.idl.metadata as { name?: string; version?: string; spec?: string } | undefined
    return <div className="lq-composer-iface"><Badge tone="good">Published IDL</Badge><p>{meta?.name ?? current.idl.name ?? 'Anchor IDL'}{meta?.version ? ` ${meta.version}` : ''} · {current.idl.instructions?.length ?? 0} instructions · read from the program’s on-chain IDL account</p></div>
  }
  return <div className="lq-composer-iface is-learned"><Badge tone="warn">Learned IDL</Badge><p>{String(current.learned.metadata?.source ?? 'reconstructed from landed transactions')} · {current.learned.instructions.length} instruction shapes{current.learned.cached ? ' · cached' : ''}</p>{current.publishedError ? <small>{current.publishedError}</small> : null}</div>
}

export interface InstructionChoice { name: string; detail: string }
export function instructionChoices(iface: ProgramInterface | null): InstructionChoice[] {
  if (!iface) return []
  if (iface.kind === 'native') return NATIVE_INSTRUCTIONS.map(ix => ({ name: ix.name, detail: ix.note }))
  if (iface.kind === 'published') return (iface.idl.instructions ?? []).map(ix => ({ name: ix.name, detail: `${ix.args?.length ?? 0} args · ${ix.accounts?.length ?? 0} accounts` }))
  return iface.learned.instructions.map(ix => ({ name: ix.name, detail: `seen in ${ix.observedIn ?? '?'} · ${ix.accounts.length} accounts · ${ix.argBytes?.join('/') ?? '?'}B opaque args` }))
}

export function InstructionPicker({ value, onChange, choices, label = 'Instruction' }: { value: string; onChange: (value: string) => void; choices: InstructionChoice[]; label?: string }) {
  const known = choices.some(choice => choice.name === value)
  return <Field label={label} hint={choices.find(choice => choice.name === value)?.detail} wide>
    {id => choices.length ? <select id={id} value={known ? value : ''} onChange={event => onChange(event.target.value)}>
      <option value="" disabled>{value && !known ? `${value} (not in this interface)` : 'Choose an instruction'}</option>
      {choices.map(choice => <option key={choice.name} value={choice.name}>{choice.name}</option>)}
    </select> : <input id={id} value={value} placeholder="instruction name" spellCheck={false} autoComplete="off" onChange={event => onChange(event.target.value.trim())} />}
  </Field>
}

// ------------------------------------------------------- instruction ----

export function InstructionForm({ state, patch, iface, requirements, argDefs, argErrors, payer }: { state: ComposerState; patch: Patch; iface: ProgramInterface; requirements: Requirements | null; argDefs: ArgDef[]; argErrors: Record<string, string>; payer: string | null }) {
  const [overrides, setOverrides] = useState<string[]>([])
  const setAccount = (name: string, value: string) => patch({ accounts: { ...state.accounts, [name]: value } })
  const setArg = (name: string, value: string) => patch({ args: { ...state.args, [name]: value } })
  const learnedIx: LearnedInstruction | null = iface.kind === 'learned' ? iface.learned.instructions.find(ix => ix.name === state.ix) ?? null : null
  const native = iface.kind === 'native' ? NATIVE_INSTRUCTIONS.find(ix => ix.name === state.ix) : null
  const derived = requirements ? [...requirements.accounts.derived, ...requirements.accounts.autoFilled] : []
  const shownOverrides = derived.filter(name => overrides.includes(name) || state.accounts[name])
  return <div className="lq-composer-ix">
    {learnedIx ? <div className="lq-composer-learned-note">
      <Badge tone="warn">Opaque arguments</Badge>
      <p>This instruction was learned from landed transactions. Its argument bytes are not decoded, so amounts cannot be typed in; pick bytes observed on-chain and read the simulation before signing.</p>
      {learnedIx.nameSource ? <p><strong>Name source:</strong> {learnedIx.nameSource}</p> : null}
      {learnedIx.shapeNote ? <p><strong>Shape:</strong> {learnedIx.shapeNote}</p> : null}
      {learnedIx.direction ? <p><strong>Direction:</strong> {learnedIx.direction}</p> : null}
    </div> : null}
    {native ? <p className="lq-composer-hint">{native.note}</p> : null}
    {requirements?.accounts.mustProvide.length ? <section><h3>Accounts you provide</h3><div className="lq-composer-fields">
      {requirements.accounts.mustProvide.map(account => <AccountInput key={account.name} name={account.name} value={state.accounts[account.name] ?? ''} onChange={value => setAccount(account.name, value)} payer={payer} flags={account} evidence={account.evidence} required={!account.optional && !account.signer} />)}
    </div></section> : null}
    {derived.length ? <section><h3>Derived for you</h3><p className="lq-composer-hint">The service fills these from the IDL’s seeds, fixed addresses and on-chain state. Override one only if you know better.</p>
      <div className="lq-composer-chips">{derived.map(name => <button type="button" key={name} className={`lq-composer-chip ${shownOverrides.includes(name) ? 'is-active' : ''}`} aria-pressed={shownOverrides.includes(name)} onClick={() => {
        if (shownOverrides.includes(name)) { setOverrides(list => list.filter(item => item !== name)); const next = { ...state.accounts }; delete next[name]; patch({ accounts: next }) }
        else setOverrides(list => [...list, name])
      }}>{name}</button>)}</div>
      {shownOverrides.length ? <div className="lq-composer-fields">{shownOverrides.map(name => <AccountInput key={name} name={`${name} (override)`} value={state.accounts[name] ?? ''} onChange={value => setAccount(name, value)} payer={payer} />)}</div> : null}
    </section> : null}
    {requirements?.note ? <p className="lq-composer-hint">{requirements.note}</p> : null}
    {argDefs.length ? <section><h3>Arguments</h3><div className="lq-composer-fields">
      {argDefs.map(def => <ArgField key={def.name} def={def} idl={iface.kind === 'published' ? iface.idl : null} text={state.args[def.name] ?? ''} onText={text => setArg(def.name, text)} error={argErrors[def.name]} payer={payer} />)}
    </div></section> : iface.kind === 'published' && requirements && !requirements.args.length ? <p className="lq-composer-hint">This instruction takes no arguments.</p> : null}
    {learnedIx ? <ArgsHexPicker ix={learnedIx} value={state.argsHex} onChange={argsHex => patch({ argsHex })} /> : null}
  </div>
}

function ArgsHexPicker({ ix, value, onChange }: { ix: LearnedInstruction; value: string; onChange: (value: string) => void }) {
  const samples = ix.argsHex ?? []
  const custom = value !== '' && !samples.includes(value)
  return <section><h3>Argument bytes</h3>
    <p className="lq-composer-hint">Observed after the discriminator in landed transactions ({ix.argBytes?.join(' / ') ?? '?'} bytes). Without bytes the transaction carries an empty payload, which the program will reject.</p>
    <div className="lq-composer-radios" role="radiogroup" aria-label="Argument bytes">
      {samples.map((hex, i) => <label key={hex}><input type="radio" name={`argsHex-${ix.name}`} checked={value === hex} onChange={() => onChange(hex)} /><code>{hex}</code><small>sample {i + 1}{ix.exampleSignatures?.[i] ? <> · <a href={`https://solscan.io/tx/${ix.exampleSignatures[i]}`} target="_blank" rel="noreferrer">tx {short(ix.exampleSignatures[i], 4)}</a></> : null}</small></label>)}
      <label><input type="radio" name={`argsHex-${ix.name}`} checked={custom || value === ''} onChange={() => onChange('')} /><span>Custom</span></label>
    </div>
    {custom || value === '' ? <Field label="Hex bytes" hint="Lowercase hex, no 0x." error={value && !/^([0-9a-f]{2})*$/i.test(value) ? 'Hex bytes only' : null}>{id => <input id={id} value={value} spellCheck={false} autoComplete="off" onChange={event => onChange(event.target.value.replace(/\s+/g, ''))} />}</Field> : null}
  </section>
}

// --------------------------------------------------------- options ----

export function OptionsForm({ options, onChange, extra, onExtra, payer }: { options: TxOptionsState; onChange: (options: TxOptionsState) => void; extra?: ExtraAccount[]; onExtra?: (extra: ExtraAccount[]) => void; payer?: string | null }) {
  const set = (next: Partial<TxOptionsState>) => onChange({ ...options, ...next })
  const open = !!(options.cu || options.priorityFee || options.tip || options.luts.length || options.blockhash || options.dryRun || !options.simulate || extra?.length)
  return <details className="lq-composer-advanced" open={open || undefined}>
    <summary><Icon name="settings" size={14} />Advanced options</summary>
    <label className="lq-composer-check"><input type="checkbox" checked={options.simulate} onChange={event => set({ simulate: event.target.checked })} /><span>Simulate against mainnet before showing it</span></label>
    <label className="lq-composer-check"><input type="checkbox" checked={options.dryRun} onChange={event => set({ dryRun: event.target.checked })} /><span>Dry run (service-side flag)</span></label>
    <div className="lq-composer-fields is-compact">
      <Field label="Compute unit limit" hint="Up to 1,400,000">{id => <input id={id} inputMode="numeric" value={options.cu} onChange={event => set({ cu: event.target.value.replace(/\D/g, '') })} />}</Field>
      <Field label="Priority fee" hint="micro-lamports per CU">{id => <input id={id} inputMode="numeric" value={options.priorityFee} onChange={event => set({ priorityFee: event.target.value.replace(/\D/g, '') })} />}</Field>
      <Field label="Tip" hint="lamports">{id => <input id={id} inputMode="numeric" value={options.tip} onChange={event => set({ tip: event.target.value.replace(/\D/g, '') })} />}</Field>
      <Field label="Blockhash" hint="Leave blank for a fresh one">{id => <input id={id} value={options.blockhash} spellCheck={false} onChange={event => set({ blockhash: event.target.value.trim() })} />}</Field>
      <Field label="Address lookup tables" hint="One per line" wide>{id => <LinesInput id={id} value={options.luts} onChange={luts => set({ luts })} rows={2} placeholder="lookup table address" />}</Field>
    </div>
    {onExtra ? <ExtraAccountsEditor extra={extra ?? []} onChange={onExtra} payer={payer} /> : null}
  </details>
}

function ExtraAccountsEditor({ extra, onChange, payer }: { extra: ExtraAccount[]; onChange: (extra: ExtraAccount[]) => void; payer?: string | null }) {
  const update = (i: number, next: Partial<ExtraAccount>) => onChange(extra.map((item, j) => j === i ? { ...item, ...next } : item))
  return <section className="lq-composer-extra"><h4>Extra (remaining) accounts</h4>
    {extra.map((item, i) => <div key={i} className="lq-composer-extra-row">
      <input aria-label={`Extra account ${i + 1}`} value={item.pubkey} placeholder="base58 address" spellCheck={false} onChange={event => update(i, { pubkey: event.target.value.trim() })} />
      <label className="lq-composer-check"><input type="checkbox" checked={item.signer} onChange={event => update(i, { signer: event.target.checked })} /><span>signer</span></label>
      <label className="lq-composer-check"><input type="checkbox" checked={item.writable} onChange={event => update(i, { writable: event.target.checked })} /><span>writable</span></label>
      <button type="button" className="lq-composer-mini" aria-label={`Remove extra account ${i + 1}`} onClick={() => onChange(extra.filter((_, j) => j !== i))}><Icon name="close" size={12} /></button>
    </div>)}
    <div className="lq-composer-chips"><button type="button" className="lq-text-button" onClick={() => onChange([...extra, { pubkey: '', signer: false, writable: false }])}><Icon name="plus" size={12} />Add account</button>{payer ? <button type="button" className="lq-text-button" onClick={() => onChange([...extra, { pubkey: payer, signer: false, writable: true }])}><Icon name="plus" size={12} />Add payer</button> : null}</div>
  </section>
}
