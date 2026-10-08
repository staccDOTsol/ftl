// Composer tabs other than Build/Diagnose: Intent (with the repair loop),
// Land, Batch, Accounts (derive / probe / find / recipes), IDL and Send.
import { useEffect, useEffectEvent, useMemo, useState, type ReactNode } from 'react'
import {
  batchBody, batchFromSpec, batchHrefFromInstructions, batchSpec, composerHref, composerRequest, consideredOf, deriveBody, failureOf, findBody, formatSplit, intentBody, isAddress, isProgramRef,
  landBody, landListBody, MAX_PLANS, NATIVE_INSTRUCTIONS, parseSplit, planInstructions, planResponse, probeBody, sendBody, solscanTx, verdictLabel, verdictTone, yoloBody, YOLO_LIMITS,
  typeLabel, type AnchorIdl, type BatchState, type BatchStep, type ComposerState, type IntentPlan, type IntentResponse, type LearnedIdl, type YoloAttempt, type YoloResponse,
} from '@/lib/composer'
import { useComposerCall, useProgramInterface, useRecipes, type RecipesResponse } from '@/lib/use-composer'
import { short } from '@/lib/format'
import { BuiltView, PastedTxCard, SimulationView } from './ComposerTx.web'
import { Address, Badge, CallStatus, CopyButton, downloadText, FailureNotice, Field, JsonView, LinesInput } from './ComposerUI.web'
import { AccountInput, InterfaceStatus, JsonTextEditor, OptionsForm, ProgramField } from './ComposerForms.web'
import { AppLink, Choice, Icon } from './MarketUI.web'

export interface TabProps { state: ComposerState; patch: (next: Partial<ComposerState>) => void; payer: string | null; autorun: boolean; onAutoran: () => void }

function Panel({ title, caption, children, actions, label }: { title: string; caption?: ReactNode; children: ReactNode; actions?: ReactNode; label?: string }) {
  return <section className="lq-panel lq-composer-form" aria-label={label ?? title}>
    <header className="lq-panel-header"><h2>{title}</h2></header>
    {caption ? <p className="lq-panel-caption">{caption}</p> : null}
    <div className="lq-composer-form-body">{children}</div>
    {actions ? <footer className="lq-composer-actions">{actions}</footer> : null}
  </section>
}
function Empty({ title, body }: { title: string; body: string }) {
  return <div className="lq-composer-empty"><Icon name="compose" size={22} /><h3>{title}</h3><p>{body}</p></div>
}
function PayerHint({ payer }: { payer: string | null }) {
  return <span className="lq-composer-hint">{payer ? `Payer ${short(payer, 5)}` : 'Connect a wallet or paste a preview payer.'}</span>
}
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function Verbatim({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return <p className="lq-composer-verbatim">{String(value)}</p>
  if (Array.isArray(value) && value.every(item => typeof item === 'string' || typeof item === 'number')) return <ul className="lq-composer-verbatim">{value.map((item, i) => <li key={i}>{String(item)}</li>)}</ul>
  return <pre className="lq-composer-verbatim">{JSON.stringify(value, null, 2)}</pre>
}

// --------------------------------------------------------------- intent ----

const EXAMPLES = ['buy 0.01 SOL of <mint>', 'wrap 0.05 SOL into wSOL', 'send 0.001 SOL to <address>', 'create my token account for <mint>']

export function IntentTab({ state, patch, payer, autorun, onAutoran }: TabProps) {
  const call = useComposerCall<IntentResponse & YoloResponse>()
  const [kind, setKind] = useState<'intent' | 'yolo'>('intent')
  function run() {
    let body: Record<string, unknown>
    try { body = state.yolo ? yoloBody(state, payer) : intentBody(state, payer) } catch (error) { call.fail(error); return }
    setKind(state.yolo ? 'yolo' : 'intent')
    void call.run(signal => composerRequest<IntentResponse & YoloResponse>(state.yolo ? '/yolo' : '/intent', body, signal), body)
  }
  const autoRun = useEffectEvent(() => { onAutoran(); run() })
  useEffect(() => { if (!autorun) return; const timer = setTimeout(autoRun, 0); return () => clearTimeout(timer) }, [autorun])
  const yoloHint = (key: keyof typeof YOLO_LIMITS, unit: string) => `Up to ${YOLO_LIMITS[key].toLocaleString()} ${unit}`
  return <div className="lq-composer-grid-2">
    <Panel title="Say what you want" caption="Plain language in, unsigned transactions out. Plans are ranked by whether they actually simulate against mainnet."
      actions={<><PayerHint payer={payer} /><button type="button" className="lq-button lq-button-primary" disabled={!payer || !state.intent.trim() || call.status === 'running'} onClick={run}>{state.yolo ? 'Build & repair' : 'Compose plans'}<Icon name="arrow" size={14} /></button></>}>
      <Field label="Intent" hint="Name mints, pools or accounts directly when you know them; the planner cannot derive what it cannot see." wide>
        {id => <textarea id={id} rows={4} value={state.intent} placeholder="buy 0.01 SOL of 9xYz…pump" onChange={event => patch({ intent: event.target.value })} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); run() } }} />}
      </Field>
      <div className="lq-composer-chips" aria-label="Examples">{EXAMPLES.map(example => <button type="button" key={example} className="lq-composer-chip" onClick={() => patch({ intent: example })}>{example}</button>)}</div>
      <label className="lq-composer-switch"><input type="checkbox" role="switch" checked={state.yolo} onChange={event => patch({ yolo: event.target.checked })} /><span><strong>Repair until it simulates</strong><small>Builds one transaction, simulates it, and repairs it from the simulation errors until it works or the budget runs out. Shows every attempt.</small></span></label>
      <div className="lq-composer-fields is-compact">
        {!state.yolo ? <Field label="Plans">{id => <select id={id} value={state.maxPlans} onChange={event => patch({ maxPlans: Number(event.target.value) })}>{Array.from({ length: MAX_PLANS }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}</select>}</Field> : <>
          <Field label="Max attempts" hint={yoloHint('maxAttempts', 'attempts')}>{id => <input id={id} inputMode="numeric" value={state.maxAttempts} placeholder="service default" onChange={event => patch({ maxAttempts: event.target.value.replace(/\D/g, '') })} />}</Field>
          <Field label="Timeout (ms)" hint={yoloHint('timeoutMs', 'ms')}>{id => <input id={id} inputMode="numeric" value={state.timeoutMs} placeholder="service default" onChange={event => patch({ timeoutMs: event.target.value.replace(/\D/g, '') })} />}</Field>
          <Field label="Max spend" hint={yoloHint('maxSpend', 'USDC micros of model spend')}>{id => <input id={id} inputMode="numeric" value={state.maxSpend} placeholder="service default" onChange={event => patch({ maxSpend: event.target.value.replace(/\D/g, '') })} />}</Field>
        </>}
        <Field label="Only these programs" hint="Optional. One program id per line." wide>{id => <LinesInput id={id} value={state.programs} rows={2} onChange={programs => patch({ programs })} placeholder="program id" />}</Field>
      </div>
    </Panel>
    <section className="lq-composer-results" aria-label="Plans" aria-live="polite">
      <CallStatus running={call.status === 'running'} startedAt={call.startedAt} finishedAt={call.finishedAt} cancelled={call.cancelled} onCancel={call.cancel} label={kind === 'yolo' ? 'Building, simulating, repairing…' : 'Planning and simulating…'} slowNote="a language model plans this; 20–60 s or more is normal" />
      {call.error ? <FailureNotice failure={call.error} /> : null}
      {call.data && kind === 'intent' ? <IntentResult data={call.data} builtAt={call.finishedAt ?? 0} payer={payer} onRerun={run} /> : null}
      {call.data && kind === 'yolo' ? <YoloResult data={call.data} builtAt={call.finishedAt ?? 0} payer={payer} onRerun={run} /> : null}
      {call.status === 'idle' && !call.error && !call.cancelled ? <Empty title="No plans yet" body="Each plan arrives with its verdict, its simulation and an unsigned transaction you can sign with the connected wallet." /> : null}
    </section>
  </div>
}

function IntentResult({ data, builtAt, payer, onRerun }: { data: IntentResponse; builtAt: number; payer: string | null; onRerun: () => void }) {
  const plans = data.plans ?? []
  const considered = consideredOf(data.programsConsidered)
  return <div className="lq-composer-stack">
    <header className="lq-composer-result-head"><span className="lq-eyebrow">{plans.length} {plans.length === 1 ? 'plan' : 'plans'}{data.payer ? ` for ${short(String(data.payer), 5)}` : ''}{considered.count ? ` · ${considered.count} programs considered` : ''}</span><p>“{data.intent}”</p></header>
    {!plans.length ? <div className="lq-composer-noplan"><Badge tone="muted">No plan</Badge><h3>This goal is outside what the Composer can build today.</h3><p>Nothing failed: the planner found no program in its catalogue that meets it. Its reasoning, verbatim:</p><Verbatim value={data.ranking} /></div>
      : data.ranking ? <details className="lq-composer-ranking"><summary><Icon name="chevron" size={12} />How these were ranked</summary><Verbatim value={data.ranking} /></details> : null}
    {plans.map((plan, i) => <PlanCard key={i} plan={plan} rank={i + 1} builtAt={builtAt} payer={payer} onRerun={onRerun} />)}
    {considered.ids.length ? <details className="lq-composer-ranking"><summary><Icon name="chevron" size={12} />Programs considered ({considered.count})</summary><ul className="lq-composer-considered">{considered.ids.map((item, i) => <li key={i}>{isAddress(item) ? <Address value={item} /> : <code>{item}</code>}</li>)}</ul></details> : null}
    <JsonView value={data} label="Full response" filename="composer-intent.json" />
  </div>
}

function PlanCard({ plan, rank, builtAt, payer, onRerun }: { plan: IntentPlan; rank: number; builtAt: number; payer: string | null; onRerun: () => void }) {
  const rebuild = useComposerCall<Record<string, unknown>>()
  const instructions = planInstructions(plan)
  const batchHref = instructions ? batchHrefFromInstructions(instructions, payer ?? undefined) : null
  const rebuildPlan = instructions && payer ? () => { void rebuild.run(signal => composerRequest<Record<string, unknown>>('/tx/batch', { payer, instructions, options: { simulate: true } }, signal)) } : onRerun
  const response = rebuild.data ?? planResponse(plan)
  return <article className={`lq-composer-plan tone-${verdictTone(plan.verdict)}`}>
    <header><span className="lq-composer-rank">#{rank}</span><div><h3>{plan.summary ?? 'Plan'}</h3>{plan.why ? <p>{plan.why}</p> : null}</div><Badge tone={verdictTone(plan.verdict)}>{verdictLabel(plan.verdict)}</Badge></header>
    {plan.confidence !== undefined && plan.confidence !== null ? <p className="lq-composer-meta">Confidence {typeof plan.confidence === 'number' ? plan.confidence <= 1 ? `${Math.round(plan.confidence * 100)}%` : plan.confidence : String(plan.confidence)} · measured by simulation, not the model’s own certainty</p> : null}
    {plan.detail ? <code className="lq-composer-detail">{plan.detail}</code> : null}
    {instructions ? <ul className="lq-composer-steps" aria-label="Plan steps">{instructions.map((step, i) => <li key={i}><code>{step.programId === 'native' ? 'native' : short(step.programId, 4)}</code> · <strong>{step.instruction}</strong><small>{JSON.stringify(step.args)}{Object.keys(step.accounts).length ? ` · accounts ${JSON.stringify(step.accounts)}` : ''}</small></li>)}</ul> : null}
    {rebuild.status === 'running' ? <CallStatus running startedAt={rebuild.startedAt} label="Rebuilding this plan…" onCancel={rebuild.cancel} /> : null}
    {rebuild.error ? <FailureNotice failure={rebuild.error} /> : null}
    {response ? <BuiltView key={rebuild.finishedAt ?? 0} response={response} builtAt={rebuild.finishedAt ?? builtAt} onRebuild={rebuildPlan} rebuilding={rebuild.status === 'running'} title={`Plan ${rank}`} />
      : plan.simulation ? <SimulationView simulation={plan.simulation} /> : <p className="lq-composer-hint">This plan has no transaction to sign{plan.verdict === 'unbuildable' || plan.verdict === 'build-failed' ? ': it could not be built. Open its steps in Batch to fix what the detail names.' : '.'}</p>}
    <div className="lq-composer-chips">{batchHref ? <AppLink href={batchHref} className="lq-text-link">Open steps in Batch <Icon name="arrow" size={12} /></AppLink> : null}</div>
    <JsonView value={plan} label="Plan details" />
  </article>
}

function YoloResult({ data, builtAt, payer, onRerun }: { data: YoloResponse; builtAt: number; payer: string | null; onRerun: () => void }) {
  const log = Array.isArray(data.log) ? data.log : []
  return <div className="lq-composer-stack">
    <header className="lq-composer-result-head"><span className="lq-eyebrow">Repair loop · {data.attempts ?? log.length} attempts{typeof data.elapsedMs === 'number' ? ` · ${(data.elapsedMs / 1000).toFixed(1)}s` : ''}{typeof data.modelCalls === 'number' ? ` · ${data.modelCalls} model calls` : ''}{typeof data.spentMicros === 'number' ? ` · ${data.spentMicros} USDC micros spent` : ''}</span>
      <Badge tone={verdictTone(data.verdict)}>{verdictLabel(data.verdict)}</Badge></header>
    {typeof data.transaction === 'string' ? <BuiltView response={data} builtAt={builtAt} onRebuild={onRerun} title="Repaired transaction" /> : null}
    {data.guidance ? <dl className="lq-composer-guidance">{Object.entries(data.guidance).map(([key, value]) => <div key={key}><dt>{key}</dt><dd><Verbatim value={value} /></dd></div>)}</dl> : null}
    {log.length ? <section aria-label="Attempt log"><h3 className="lq-composer-h3">Attempt log</h3><ol className="lq-composer-log">{log.map((attempt, i) => <AttemptItem key={i} attempt={attempt} closest={data.closest?.attempt === attempt.attempt} payer={payer} />)}</ol></section> : null}
    <JsonView value={data} label="Full response" filename="composer-yolo.json" />
  </div>
}
function AttemptItem({ attempt, closest, payer }: { attempt: YoloAttempt; closest: boolean; payer: string | null }) {
  const href = batchHrefFromInstructions(attempt.instructions, payer ?? undefined)
  return <li className={closest ? 'is-closest' : ''}>
    <header><strong>Attempt {attempt.attempt ?? '?'}</strong><Badge tone={verdictTone(attempt.verdict)}>{verdictLabel(attempt.verdict)}</Badge>{closest ? <Badge tone="warn">closest</Badge> : null}</header>
    {attempt.summary ? <p>{attempt.summary}</p> : null}
    {attempt.detail ? <code className="lq-composer-detail">{attempt.detail}</code> : null}
    {Array.isArray(attempt.instructions) ? <ul className="lq-composer-steps">{attempt.instructions.map((step, i) => <li key={i}><code>{step.programId === 'native' ? 'native' : short(String(step.programId), 4)}</code> · <strong>{step.instruction}</strong><small>{JSON.stringify(step.args ?? {})}{step.accounts && Object.keys(step.accounts).length ? ` · accounts ${JSON.stringify(step.accounts)}` : ''}</small></li>)}</ul> : null}
    {href ? <AppLink href={href} className="lq-text-link">Open these steps in Batch <Icon name="arrow" size={12} /></AppLink> : null}
  </li>
}

// ----------------------------------------------------------------- land ----

interface FoundName { name: string; observedIn: number | null; direction: string | null }
const foundNames = (guidance: Record<string, unknown> | null | undefined): FoundName[] | null => {
  const found = guidance?.found
  return Array.isArray(found) ? found.filter(isRecord).map(item => ({ name: String(item.name ?? ''), observedIn: typeof item.observedIn === 'number' ? item.observedIn : null, direction: typeof item.direction === 'string' ? item.direction : null })).filter(item => item.name) : null
}

export function LandTab({ state, patch, payer, autorun, onAutoran }: TabProps) {
  const listing = useComposerCall<FoundName[]>()
  const call = useComposerCall<Record<string, unknown>>()
  const [names, setNames] = useState<{ program: string; items: FoundName[] } | null>(null)
  const program = state.program.trim()
  const list = useEffectEvent(() => {
    void listing.run(async signal => {
      try { await composerRequest('/land', landListBody(program, payer), signal) } catch (error) {
        const items = foundNames(failureOf(error).guidance)
        if (items) { setNames({ program, items }); return items }
        throw error
      }
      return []
    })
  })
  useEffect(() => {
    if (!isAddress(program)) return
    const timer = setTimeout(list, 350)
    return () => clearTimeout(timer)
  }, [program])
  function run() {
    let body: Record<string, unknown>
    try { body = landBody(state, payer) } catch (error) { call.fail(error); return }
    void call.run(signal => composerRequest<Record<string, unknown>>('/land', body, signal), body)
  }
  const autoRun = useEffectEvent(() => { onAutoran(); run() })
  useEffect(() => { if (!autorun) return; const timer = setTimeout(autoRun, 0); return () => clearTimeout(timer) }, [autorun])
  useEffect(() => {
    const items = foundNames(call.error?.guidance)
    if (!items) return
    const timer = setTimeout(() => setNames({ program, items }), 0)
    return () => clearTimeout(timer)
  }, [call.error, program])
  const choices = names?.program === program ? names.items : []
  const chosen = choices.find(item => item.name === state.ix)
  return <div className="lq-composer-grid-2">
    <Panel title="Land an IDL-less instruction" caption="For programs with no published IDL. The Composer learns the instruction from landed transactions, builds it for your wallet, and repairs it from the simulation."
      actions={<><PayerHint payer={payer} /><button type="button" className="lq-button lq-button-primary" disabled={!payer || !isAddress(program) || !state.ix || call.status === 'running'} onClick={run}>Build for my wallet<Icon name="arrow" size={14} /></button></>}>
      <ProgramField value={state.program} onChange={value => patch({ program: value, ix: '', mint: '' })} />
      <CallStatus running={listing.status === 'running'} startedAt={listing.startedAt} cancelled={listing.cancelled} onCancel={listing.cancel} label="Reading the instructions seen on-chain…" slowNote="the first look at a program can take minutes" />
      {listing.error && !choices.length ? <FailureNotice failure={listing.error} title="Could not list learned instructions" /> : null}
      <Field label="Learned instruction" hint={chosen ? `Seen in ${chosen.observedIn ?? '?'} transactions${chosen.direction ? ` · ${chosen.direction}` : ''}` : 'Names come from transactions that landed; a name may be a hint borrowed from another program’s IDL.'} wide>
        {id => choices.length ? <select id={id} value={chosen ? state.ix : ''} onChange={event => patch({ ix: event.target.value })}>
          <option value="" disabled>{state.ix && !chosen ? `${state.ix} (not observed)` : 'Choose an instruction'}</option>
          {choices.map(item => <option key={item.name} value={item.name}>{item.name} · {item.observedIn ?? '?'} seen</option>)}
        </select> : <input id={id} value={state.ix} placeholder="learned instruction name" spellCheck={false} onChange={event => patch({ ix: event.target.value.trim() })} />}
      </Field>
      {chosen?.direction ? <p className="lq-composer-warn">{chosen.direction}</p> : null}
      <div className="lq-composer-fields is-compact">
        <Field label="Mint" hint="Optional: the token this instruction should act on." error={state.mint && !isAddress(state.mint) ? 'Not a base58 mint' : null} wide>{id => <input id={id} value={state.mint} spellCheck={false} placeholder="mint address" onChange={event => patch({ mint: event.target.value.trim() })} />}</Field>
        <Field label="Signatures to scan" hint="Raise it when an instruction is rare.">{id => <input id={id} inputMode="numeric" value={state.signatures} placeholder="service default" onChange={event => patch({ signatures: event.target.value.replace(/\D/g, '') })} />}</Field>
        <label className="lq-composer-check"><input type="checkbox" checked={state.refresh} onChange={event => patch({ refresh: event.target.checked })} /><span>Re-learn from fresh transactions</span></label>
      </div>
      <p className="lq-composer-hint">Learned instructions have opaque argument bytes: the Composer has not decoded them, so you cannot set amounts here. Read the simulation before signing.</p>
    </Panel>
    <section className="lq-composer-results" aria-label="Result" aria-live="polite">
      <CallStatus running={call.status === 'running'} startedAt={call.startedAt} finishedAt={call.finishedAt} cancelled={call.cancelled} onCancel={call.cancel} label="Learning, building and repairing…" slowNote="can take minutes for a program it has not seen" />
      {call.error ? <FailureNotice failure={call.error} onRebuild={run} /> : null}
      {call.data ? <><LandVerdict data={call.data} /><BuiltView key={call.finishedAt ?? 0} response={call.data} builtAt={call.finishedAt ?? 0} onRebuild={run} rebuilding={call.status === 'running'} title={`${state.ix} for ${payer ? short(payer, 4) : 'the payer'}`} /><Report data={call.data} /><JsonView value={call.data} label="Full response" filename={`composer-land-${state.ix}.json`} /></> : null}
      {call.status === 'idle' && !call.error && !call.cancelled ? <Empty title="Nothing landed yet" body="The repaired transaction, its simulation and the repair log appear here." /> : null}
    </section>
  </div>
}

const REPORTED = new Set(['transaction', 'simulation', 'resolvedAccounts', 'signers', 'blockhash', 'bytes', 'mode', 'submit', 'bundle', 'jito', 'steps', 'program', 'landed', 'next', 'trail'])
// /land answers with `landed`, a `next` sentence and a `trail` of the steps it
// took (learned → sampled → substituted → built); all shown as the service says.
function LandVerdict({ data }: { data: Record<string, unknown> }) {
  if (typeof data.landed !== 'boolean' && typeof data.next !== 'string') return null
  return <div className="lq-composer-guidance">
    {typeof data.landed === 'boolean' ? <Badge tone={data.landed ? 'good' : 'bad'}>{data.landed ? 'Landable: simulates clean' : 'Not landable yet'}</Badge> : null}
    {typeof data.next === 'string' ? <p className="lq-composer-verbatim">{data.next}</p> : null}
  </div>
}
function Report({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([key, value]) => !REPORTED.has(key) && value !== null && value !== undefined && value !== '')
  const trail = Array.isArray(data.trail) ? data.trail.filter(isRecord) : []
  return <>
    {trail.length ? <section aria-label="Repair trail"><h3 className="lq-composer-h3">Trail</h3><ol className="lq-composer-log">{trail.map((step, i) => <li key={i}>
      <header><strong>{String(step.step ?? `step ${i + 1}`)}</strong></header>
      <dl className="lq-composer-evidence">{Object.entries(step).filter(([key, value]) => key !== 'step' && value !== null && value !== undefined).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{key === 'signature' && typeof value === 'string' ? <a href={solscanTx(value)} target="_blank" rel="noreferrer">{short(value, 8)}</a> : typeof value === 'string' && isAddress(value) ? <Address value={value} chars={5} /> : typeof value === 'object' ? <code>{JSON.stringify(value)}</code> : String(value)}</dd></div>)}</dl>
    </li>)}</ol></section> : null}
    {entries.length ? <dl className="lq-composer-guidance" aria-label="What the service reported">{entries.map(([key, value]) => <div key={key}><dt>{key}</dt><dd><Verbatim value={value} /></dd></div>)}</dl> : null}
  </>
}

// ---------------------------------------------------------------- batch ----

function AccountsLines({ value, onChange, label }: { value: Record<string, string>; onChange: (value: Record<string, string>) => void; label: string }) {
  const text = Object.entries(value).map(([name, key]) => `${name} = ${key}`).join('\n')
  const [draft, setDraft] = useState(text)
  const [seen, setSeen] = useState(text)
  if (seen !== text) { setSeen(text); setDraft(text) }
  return <textarea aria-label={label} rows={Math.max(2, Object.keys(value).length + 1)} value={draft} spellCheck={false} placeholder="name = base58 address" onChange={event => {
    setDraft(event.target.value)
    const next: Record<string, string> = {}
    for (const line of event.target.value.split('\n')) { const [name, key] = line.split(/[=:]/).map(part => part?.trim()); if (name && key) next[name] = key }
    const normalized = Object.entries(next).map(([name, key]) => `${name} = ${key}`).join('\n')
    setSeen(normalized); onChange(next)
  }} />
}

function StepEditor({ step, index, count, onChange, onRemove, onMove }: { step: BatchStep; index: number; count: number; onChange: (step: BatchStep) => void; onRemove: () => void; onMove: (delta: number) => void }) {
  const native = step.programId === 'native'
  const buildHref = composerHref({ tab: 'build', program: step.programId, ix: step.instruction, args: Object.fromEntries(Object.entries(step.args).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)])), accounts: step.accounts, argsHex: step.argsHex ?? '' })
  return <li className="lq-composer-step">
    <header><strong>Step {index}</strong><span>{step.instruction || 'instruction'}{step.programId ? ` · ${step.programId === 'native' ? 'native' : short(step.programId, 4)}` : ''}</span>
      <div><button type="button" className="lq-composer-mini" aria-label={`Move step ${index} up`} disabled={index === 0} onClick={() => onMove(-1)}>↑</button><button type="button" className="lq-composer-mini" aria-label={`Move step ${index} down`} disabled={index === count - 1} onClick={() => onMove(1)}>↓</button><button type="button" className="lq-composer-mini" aria-label={`Remove step ${index}`} onClick={onRemove}><Icon name="close" size={12} /></button></div></header>
    <div className="lq-composer-fields is-compact">
      <Field label="Program" error={step.programId && !isProgramRef(step.programId) ? 'Program id or “native”' : null}>{id => <input id={id} value={step.programId} spellCheck={false} placeholder="program id or native" onChange={event => onChange({ ...step, programId: event.target.value.trim() })} />}</Field>
      <Field label="Instruction">{id => native ? <select id={id} value={step.instruction} onChange={event => onChange({ ...step, instruction: event.target.value })}><option value="" disabled>Choose</option>{NATIVE_INSTRUCTIONS.map(ix => <option key={ix.name} value={ix.name}>{ix.name}</option>)}</select> : <input id={id} value={step.instruction} spellCheck={false} onChange={event => onChange({ ...step, instruction: event.target.value.trim() })} />}</Field>
      <Field label="Args (JSON)" hint={native ? NATIVE_INSTRUCTIONS.find(ix => ix.name === step.instruction)?.args.map(arg => `${arg.name}: ${typeof arg.type === 'string' ? arg.type : 'Vec<pubkey>'}${arg.optional ? '?' : ''}`).join(', ') : 'Integers as numbers or decimal strings; tuple structs as arrays.'} wide>{id => <JsonTextEditor id={id} value={step.args} label={`Step ${index} args`} rows={3} onChange={value => onChange({ ...step, args: isRecord(value) ? value : {} })} />}</Field>
      <Field label="Accounts" hint="One per line: name = address" wide>{() => <AccountsLines value={step.accounts} label={`Step ${index} accounts`} onChange={accounts => onChange({ ...step, accounts })} />}</Field>
      <Field label="argsHex" hint="Raw argument bytes (learned instructions)">{id => <input id={id} value={step.argsHex ?? ''} spellCheck={false} onChange={event => onChange({ ...step, argsHex: event.target.value.replace(/\s+/g, '') || undefined })} />}</Field>
    </div>
    {step.extraAccounts?.length ? <p className="lq-composer-hint">{step.extraAccounts.length} extra accounts carried from the spec.</p> : null}
    {!native && isAddress(step.programId) && step.instruction ? <AppLink href={buildHref} className="lq-text-link">Edit in the Build form <Icon name="arrow" size={12} /></AppLink> : null}
  </li>
}

export function BatchTab({ state, patch, payer, autorun, onAutoran }: TabProps) {
  const batch = state.batch
  const call = useComposerCall<Record<string, unknown>>()
  const [nativeIx, setNativeIx] = useState('createAtaIdempotent')
  const setBatch = (next: Partial<BatchState>) => patch({ batch: { ...batch, ...next } })
  const steps = batch.instructions
  const setStep = (i: number, step: BatchStep) => setBatch({ instructions: steps.map((old, j) => j === i ? step : old) })
  const move = (i: number, delta: number) => { const next = [...steps]; const [item] = next.splice(i, 1); next.splice(i + delta, 0, item); setBatch({ instructions: next }) }
  function run() {
    let body: Record<string, unknown>
    try { body = batchBody(state, payer) } catch (error) { call.fail(error); return }
    void call.run(signal => composerRequest<Record<string, unknown>>('/tx/batch', body, signal), body)
  }
  const autoRun = useEffectEvent(() => { onAutoran(); run() })
  useEffect(() => { if (!autorun || !steps.length) return; const timer = setTimeout(autoRun, 0); return () => clearTimeout(timer) }, [autorun, steps.length])
  const [splitText, setSplitText] = useState(formatSplit(batch.split))
  const [seenSplit, setSeenSplit] = useState(batch.split)
  if (seenSplit !== batch.split && formatSplit(batch.split) !== formatSplit(parseSplit(splitText))) { setSeenSplit(batch.split); setSplitText(formatSplit(batch.split)) }
  return <div className="lq-composer-grid-2">
    <Panel title="Batch instructions" caption="Several instruction specs, built in order: one transaction, a composed transaction, or an ordered Jito bundle. Everything is simulated before you sign."
      actions={<><PayerHint payer={payer} /><button type="button" className="lq-button lq-button-primary" disabled={!payer || !steps.length || call.status === 'running'} onClick={run}>Build batch<Icon name="arrow" size={14} /></button></>}>
      <Choice value={batch.mode} onChange={mode => setBatch({ mode })} label="Batch mode" options={[{ value: 'single', label: 'One transaction' }, { value: 'compose', label: 'Compose' }, { value: 'bundle', label: 'Jito bundle' }]} />
      <p className="lq-composer-hint">{batch.mode === 'single' ? 'All steps in one transaction, in order.' : batch.mode === 'compose' ? 'Steps are wired through the Composer’s on-chain program in one transaction. The service must have that program configured; otherwise it says so.' : 'Steps are split into up to five transactions that land together or not at all. Each one is signed in order, then sent as one bundle.'}</p>
      {batch.mode === 'bundle' ? <div className="lq-composer-fields is-compact">
        <Field label="Split" hint="Step indexes per transaction, e.g. 0 | 1,2. Blank lets the service decide.">{id => <input id={id} value={splitText} placeholder="0 | 1,2" onChange={event => { setSplitText(event.target.value); const split = parseSplit(event.target.value); setSeenSplit(split); setBatch({ split }) }} />}</Field>
        <Field label="Tip (lamports)" hint="Paid to a Jito tip account in the last transaction">{id => <input id={id} inputMode="numeric" value={batch.tip} onChange={event => setBatch({ tip: event.target.value.replace(/\D/g, '') })} />}</Field>
      </div> : null}
      {steps.length ? <ol className="lq-composer-steps-editor" start={0}>{steps.map((step, i) => <StepEditor key={i} step={step} index={i} count={steps.length} onChange={next => setStep(i, next)} onRemove={() => setBatch({ instructions: steps.filter((_, j) => j !== i) })} onMove={delta => move(i, delta)} />)}</ol>
        : <p className="lq-composer-hint">No steps yet. Add built-in steps here, use “Add to batch” in Build, or open a repair attempt from Intent.</p>}
      <div className="lq-composer-chips">
        <label className="lq-composer-inline">Built-in<select value={nativeIx} onChange={event => setNativeIx(event.target.value)} aria-label="Built-in instruction">{NATIVE_INSTRUCTIONS.map(ix => <option key={ix.name} value={ix.name}>{ix.name}</option>)}</select></label>
        <button type="button" className="lq-button lq-button-sm" onClick={() => setBatch({ instructions: [...steps, { programId: 'native', instruction: nativeIx, args: {}, accounts: {} }] })}><Icon name="plus" size={13} />Add built-in step</button>
        <button type="button" className="lq-button lq-button-sm" onClick={() => setBatch({ instructions: [...steps, { programId: '', instruction: '', args: {}, accounts: {} }] })}><Icon name="plus" size={13} />Add program step</button>
      </div>
      <details className="lq-composer-advanced"><summary><Icon name="settings" size={14} />Edit the whole spec as JSON</summary>
        <JsonTextEditor value={batchSpec(batch)} label="Batch spec JSON" rows={10} onChange={value => { const next = batchFromSpec(value); if (next) patch({ batch: next }) }} />
      </details>
      <OptionsForm options={state.options} onChange={options => patch({ options })} />
    </Panel>
    <section className="lq-composer-results" aria-label="Result" aria-live="polite">
      <CallStatus running={call.status === 'running'} startedAt={call.startedAt} finishedAt={call.finishedAt} cancelled={call.cancelled} onCancel={call.cancel} label="Building and simulating the batch…" />
      {call.error ? <FailureNotice failure={call.error} onRebuild={run} /> : null}
      {call.data ? <><BuiltView key={call.finishedAt ?? 0} response={call.data} builtAt={call.finishedAt ?? 0} onRebuild={run} rebuilding={call.status === 'running'} title="Batch transaction" /><JsonView value={call.data} label="Full response" filename="composer-batch.json" /></> : null}
      {call.status === 'idle' && !call.error && !call.cancelled ? <Empty title="Nothing built yet" body="A single transaction or an ordered bundle appears here with its simulation." /> : null}
    </section>
  </div>
}

// ------------------------------------------------------------- accounts ----

export function AccountsTab(props: TabProps) {
  const { state, patch } = props
  const recipes = useRecipes(state.program, isAddress(state.program))
  return <div className="lq-composer-stack">
    <div className="lq-composer-subtabs"><Choice value={state.mode} onChange={mode => patch({ mode })} label="Account tool" options={[{ value: 'derive', label: 'Derive' }, { value: 'probe', label: 'Probe' }, { value: 'find', label: 'Find' }, { value: 'recipes', label: 'Recipes' }]} /></div>
    {state.mode === 'recipes' ? <RecipesView {...props} recipes={recipes} /> : state.mode === 'find' ? <FindTool {...props} recipes={recipes} /> : <DeriveTool {...props} recipes={recipes} />}
  </div>
}
type RecipesState = ReturnType<typeof useRecipes>
function RecipesStatus({ recipes }: { recipes: RecipesState }) {
  if (recipes.loading) return <p className="lq-composer-hint" role="status"><span className="lq-spinner" /> Reading seed recipes…</p>
  if (recipes.error) return <FailureNotice failure={recipes.error} title="No recipes for this program" />
  if (!recipes.data) return null
  return <p className="lq-composer-hint">{recipes.data.name ?? 'Program'} · {Object.keys(recipes.data.derivable).length} derivable accounts · {recipes.data.queryable?.length ?? 0} queryable types{recipes.data.hint ? ` · ${recipes.data.hint}` : ''}</p>
}

function DeriveTool({ state, patch, autorun, onAutoran, recipes }: TabProps & { recipes: RecipesState }) {
  const probe = state.mode === 'probe'
  const call = useComposerCall<Record<string, unknown>>()
  const recipe = recipes.data?.derivable[state.account]
  const guidance = call.error?.guidance
  const extraAccounts = Array.isArray(guidance?.needsAccounts) ? guidance.needsAccounts.map(String) : []
  const extraArgs = Array.isArray(guidance?.needsArgs) ? guidance.needsArgs.map(String) : []
  const needAccounts = [...new Set([...(recipe?.needs_accounts ?? []), ...extraAccounts, ...Object.keys(state.accounts)])]
  const needArgs = [...new Set([...(recipe?.needs_args ?? []), ...extraArgs, ...Object.keys(state.args)])]
  const sweepable = [...needAccounts, ...needArgs]
  function run() {
    let body: Record<string, unknown>
    try { body = probe ? probeBody(state) : deriveBody(state) } catch (error) { call.fail(error); return }
    void call.run(signal => composerRequest<Record<string, unknown>>(probe ? '/probe' : '/derive', body, signal), body)
  }
  const autoRun = useEffectEvent(() => { onAutoran(); run() })
  useEffect(() => { if (!autorun) return; const timer = setTimeout(autoRun, 0); return () => clearTimeout(timer) }, [autorun])
  const names = Object.keys(recipes.data?.derivable ?? {}).sort()
  const data = call.data
  return <div className="lq-composer-grid-2">
    <Panel title={probe ? 'Probe derived accounts' : 'Derive an account'} caption={probe ? 'Sweep one seed input across many values in one RPC call and see which derived accounts exist.' : 'Compute a program-derived address from the recipe the Composer knows for it.'}
      actions={<button type="button" className="lq-button lq-button-primary" disabled={!isProgramRef(state.program) || !state.account || call.status === 'running'} onClick={run}>{probe ? 'Probe' : 'Derive'}<Icon name="arrow" size={14} /></button>}>
      <ProgramField value={state.program} onChange={program => patch({ program, account: '', accounts: {}, args: {}, sweep: '' })} />
      <RecipesStatus recipes={recipes} />
      <Field label="Account" hint={recipe ? `Seeds: ${recipe.seeds.join(' · ')}${recipe.program ? ` · program ${recipe.program}` : ''}` : undefined} wide>
        {id => names.length ? <select id={id} value={names.includes(state.account) ? state.account : ''} onChange={event => patch({ account: event.target.value })}><option value="" disabled>{state.account && !names.includes(state.account) ? `${state.account} (no recipe)` : 'Choose an account'}</option>{names.map(name => <option key={name} value={name}>{name}</option>)}</select>
          : <input id={id} value={state.account} spellCheck={false} placeholder="account name, e.g. bonding_curve" onChange={event => patch({ account: event.target.value.trim() })} />}
      </Field>
      {recipe?.seen_on?.length ? <p className="lq-composer-hint">Seen on: {recipe.seen_on.join(', ')}</p> : null}
      {needAccounts.filter(name => !(probe && name === state.sweep)).length ? <section><h3>Seed accounts</h3><div className="lq-composer-fields">{needAccounts.filter(name => !(probe && name === state.sweep)).map(name => <AccountInput key={name} name={name} value={state.accounts[name] ?? ''} onChange={value => patch({ accounts: { ...state.accounts, [name]: value } })} required />)}</div></section> : null}
      {needArgs.filter(name => !(probe && name === state.sweep)).length ? <section><h3>Seed arguments</h3><div className="lq-composer-fields">{needArgs.filter(name => !(probe && name === state.sweep)).map(name => <Field key={name} label={<code>{name}</code>} hint={'Integer seeds are ambiguous: send {"u16be": 19} or {"u32le": 7}; a bare number is u64 little-endian.'}>{id => <input id={id} value={state.args[name] ?? ''} spellCheck={false} onChange={event => patch({ args: { ...state.args, [name]: event.target.value } })} />}</Field>)}</div></section> : null}
      {probe ? <div className="lq-composer-fields">
        <Field label="Sweep" hint="The one seed input that varies.">{id => sweepable.length ? <select id={id} value={state.sweep} onChange={event => patch({ sweep: event.target.value })}><option value="" disabled>Choose an input</option>{sweepable.map(name => <option key={name} value={name}>{name}</option>)}</select> : <input id={id} value={state.sweep} onChange={event => patch({ sweep: event.target.value.trim() })} />}</Field>
        <Field label="Values" hint="One per line: addresses, numbers or JSON." wide>{id => <LinesInput id={id} value={state.values} rows={4} onChange={values => patch({ values })} placeholder="value to try" />}</Field>
        <label className="lq-composer-check"><input type="checkbox" checked={state.existingOnly} onChange={event => patch({ existingOnly: event.target.checked })} /><span>Only list accounts that exist</span></label>
      </div> : null}
    </Panel>
    <section className="lq-composer-results" aria-label="Result" aria-live="polite">
      <CallStatus running={call.status === 'running'} startedAt={call.startedAt} finishedAt={call.finishedAt} cancelled={call.cancelled} onCancel={call.cancel} label={probe ? 'Probing…' : 'Deriving…'} />
      {call.error ? <FailureNotice failure={call.error} /> : null}
      {data && !probe ? <div className="lq-composer-derived"><span className="lq-eyebrow">{String(data.name ?? state.account)}</span>{typeof data.address === 'string' ? <strong><Address value={data.address} chars={10} /></strong> : null}{Array.isArray(data.seeds) ? <ul>{data.seeds.map((seed, i) => <li key={i}><code>{String(seed)}</code></li>)}</ul> : null}
        {typeof data.address === 'string' ? <div className="lq-composer-chips"><button type="button" className="lq-button lq-button-sm" onClick={() => patch({ mode: 'probe', sweep: recipe?.needs_accounts[0] ?? recipe?.needs_args[0] ?? '' })}>Probe variations</button></div> : null}</div> : null}
      {data && probe ? <ProbeResult data={data} /> : null}
      {data ? <JsonView value={data} label="Full response" /> : null}
      {call.status === 'idle' && !call.error && !call.cancelled ? <Empty title={probe ? 'Nothing probed yet' : 'Nothing derived yet'} body={probe ? 'Each tried value appears with whether its account exists, its owner and its size.' : 'The address appears here with the exact seeds used.'} /> : null}
    </section>
  </div>
}

function ProbeResult({ data }: { data: Record<string, unknown> }) {
  const found = Array.isArray(data.found) ? data.found.filter(isRecord) : []
  const errors = Array.isArray(data.errors) ? data.errors.filter(isRecord) : []
  return <section className="lq-composer-table-wrap" aria-label="Probe results">
    <p className="lq-composer-meta">{String(data.checked ?? found.length)} checked · {found.filter(item => item.exists).length} exist · {String(data.rpcCalls ?? '?')} RPC calls · sweep <code>{String(data.sweep ?? '')}</code></p>
    <table className="lq-composer-table"><thead><tr><th scope="col">Input</th><th scope="col">Address</th><th scope="col">Exists</th><th scope="col">Owner · size</th></tr></thead><tbody>
      {found.map((item, i) => <tr key={i}><td data-label="Input"><code>{Object.values(isRecord(item.inputs) ? item.inputs : {}).map(value => typeof value === 'string' ? short(value, 5) : JSON.stringify(value)).join(', ')}</code></td><td data-label="Address">{typeof item.address === 'string' ? <Address value={item.address} chars={5} /> : '—'}</td><td data-label="Exists"><Badge tone={item.exists ? 'good' : 'muted'}>{item.exists ? 'exists' : 'empty'}</Badge></td><td data-label="Owner · size">{typeof item.owner === 'string' ? short(item.owner, 4) : '—'}{typeof item.data_len === 'number' ? ` · ${item.data_len} B` : ''}{typeof item.lamports === 'number' ? ` · ${(item.lamports / 1e9).toFixed(4)} SOL` : ''}</td></tr>)}
    </tbody></table>
    {errors.length ? <ul className="lq-composer-errors">{errors.map((item, i) => <li key={i}><code>{JSON.stringify(item.value)}</code> {String(item.error ?? '')}</li>)}</ul> : null}
  </section>
}

function FindTool({ state, patch, autorun, onAutoran, recipes }: TabProps & { recipes: RecipesState }) {
  const call = useComposerCall<Record<string, unknown>>()
  const queryable = recipes.data?.queryable ?? []
  const type = queryable.find(item => item.account === state.account)
  const fields = type?.filterableFields ?? []
  const fieldTypes = Object.fromEntries(fields.map(field => [field.path, field.type]))
  const [newPath, setNewPath] = useState('')
  function run() {
    let body: Record<string, unknown>
    try { body = findBody(state, fieldTypes) } catch (error) { call.fail(error); return }
    void call.run(signal => composerRequest<Record<string, unknown>>('/find', body, signal), body)
  }
  const autoRun = useEffectEvent(() => { onAutoran(); run() })
  useEffect(() => { if (!autorun) return; const timer = setTimeout(autoRun, 0); return () => clearTimeout(timer) }, [autorun])
  const accounts = Array.isArray(call.data?.accounts) ? (call.data.accounts as unknown[]).filter(isRecord) : []
  return <div className="lq-composer-grid-2">
    <Panel title="Find accounts" caption="Scan a program’s accounts with IDL-typed filters. Prefer Derive or Probe: a scan is slow, and the service refuses enormous programs unless you force it."
      actions={<button type="button" className="lq-button lq-button-primary" disabled={!isAddress(state.program) || !state.account || call.status === 'running'} onClick={run}>Find<Icon name="arrow" size={14} /></button>}>
      <ProgramField value={state.program} onChange={program => patch({ program, account: '', where: {}, select: [] })} />
      <RecipesStatus recipes={recipes} />
      <Field label="Account type" wide>{id => queryable.length ? <select id={id} value={type ? state.account : ''} onChange={event => patch({ account: event.target.value, where: {}, select: [] })}><option value="" disabled>{state.account && !type ? `${state.account} (unknown type)` : 'Choose a type'}</option>{queryable.map(item => <option key={item.account} value={item.account}>{item.account}</option>)}</select>
        : <input id={id} value={state.account} spellCheck={false} placeholder="IDL account type, e.g. BondingCurve" onChange={event => patch({ account: event.target.value.trim() })} />}</Field>
      <section><h3>Filters</h3>
        {Object.entries(state.where).map(([path, value]) => <div key={path} className="lq-composer-extra-row"><code>{path}</code><small>{fieldTypes[path] ?? ''}</small><input aria-label={`Filter ${path}`} value={value} spellCheck={false} onChange={event => patch({ where: { ...state.where, [path]: event.target.value } })} /><button type="button" className="lq-composer-mini" aria-label={`Remove filter ${path}`} onClick={() => { const next = { ...state.where }; delete next[path]; patch({ where: next }) }}><Icon name="close" size={12} /></button></div>)}
        <div className="lq-composer-chips">
          {fields.length ? <select aria-label="Field to filter" value={newPath} onChange={event => setNewPath(event.target.value)}><option value="">Add a filter…</option>{fields.filter(field => !(field.path in state.where) && field.type !== 'array').map(field => <option key={field.path} value={field.path}>{field.path} · {field.type}</option>)}</select>
            : <input aria-label="Field path to filter" value={newPath} placeholder="field.path" onChange={event => setNewPath(event.target.value.trim())} />}
          <button type="button" className="lq-button lq-button-sm" disabled={!newPath} onClick={() => { patch({ where: { ...state.where, [newPath]: '' } }); setNewPath('') }}><Icon name="plus" size={13} />Add filter</button>
        </div>
      </section>
      {fields.length ? <section><h3>Return fields</h3><div className="lq-composer-chips">{fields.filter(field => field.type !== 'array').map(field => <label key={field.path} className="lq-composer-check is-chip"><input type="checkbox" checked={state.select.includes(field.path)} onChange={event => patch({ select: event.target.checked ? [...state.select, field.path] : state.select.filter(item => item !== field.path) })} /><span>{field.path}</span></label>)}</div></section> : null}
      <div className="lq-composer-fields is-compact">
        <Field label="Limit">{id => <input id={id} inputMode="numeric" value={state.limit} placeholder="service default" onChange={event => patch({ limit: event.target.value.replace(/\D/g, '') })} />}</Field>
        <label className="lq-composer-check"><input type="checkbox" checked={state.force} onChange={event => patch({ force: event.target.checked })} /><span>Force the scan{recipes.data?.gpaWarning ? ` (${recipes.data.gpaWarning})` : ''}</span></label>
      </div>
    </Panel>
    <section className="lq-composer-results" aria-label="Result" aria-live="polite">
      <CallStatus running={call.status === 'running'} startedAt={call.startedAt} finishedAt={call.finishedAt} cancelled={call.cancelled} onCancel={call.cancel} label="Scanning program accounts…" slowNote="large programs are slow to scan" />
      {call.error ? <FailureNotice failure={call.error} /> : null}
      {call.data ? <section className="lq-composer-table-wrap" aria-label="Accounts found">
        <p className="lq-composer-meta">{accounts.length} accounts{call.data.truncated ? ' · truncated at the limit' : ''}</p>
        <table className="lq-composer-table"><thead><tr><th scope="col">Address</th><th scope="col">Size · SOL</th><th scope="col">Fields</th></tr></thead><tbody>
          {accounts.map((item, i) => <tr key={i}><td data-label="Address">{typeof item.address === 'string' ? <Address value={item.address} chars={5} /> : '—'}</td><td data-label="Size · SOL">{typeof item.data_len === 'number' ? `${item.data_len} B` : '—'}{typeof item.lamports === 'number' ? ` · ${(item.lamports / 1e9).toFixed(4)}` : ''}</td><td data-label="Fields"><code>{isRecord(item.fields) ? JSON.stringify(item.fields) : ''}</code></td></tr>)}
        </tbody></table>
      </section> : null}
      {call.data ? <JsonView value={call.data} label="Full response" filename="composer-find.json" /> : null}
      {call.status === 'idle' && !call.error && !call.cancelled ? <Empty title="Nothing found yet" body="Matching accounts appear with the fields you asked for." /> : null}
    </section>
  </div>
}

function RecipesView({ state, patch, recipes }: TabProps & { recipes: RecipesState }) {
  const data: RecipesResponse | null = recipes.data
  const entries = Object.entries(data?.derivable ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return <div className="lq-composer-stack">
    <Panel title="Seed recipes" caption="Every program-derived account the Composer can compute for this program, with the seeds it uses and the instructions it appears on.">
      <ProgramField value={state.program} onChange={program => patch({ program, account: '' })} />
      <RecipesStatus recipes={recipes} />
      {data?.gpaWarning ? <p className="lq-composer-warn">Scan warning: {data.gpaWarning}</p> : null}
    </Panel>
    {data ? <>
      <section className="lq-panel lq-composer-table-wrap" aria-label="Derivable accounts"><header className="lq-panel-header"><h2>Derivable ({entries.length})</h2></header>
        <table className="lq-composer-table"><thead><tr><th scope="col">Account</th><th scope="col">Seeds</th><th scope="col">Needs</th><th scope="col">Seen on</th><th scope="col"><span className="lq-sr-only">Actions</span></th></tr></thead><tbody>
          {entries.map(([name, recipe]) => <tr key={name}><td data-label="Account"><code>{name}</code></td><td data-label="Seeds"><small>{recipe.seeds.join(' · ')}</small>{recipe.program ? <small> · {recipe.program}</small> : null}</td><td data-label="Needs"><small>{[...recipe.needs_accounts, ...recipe.needs_args.map(arg => `${arg} (arg)`)].join(', ') || '—'}</small></td><td data-label="Seen on"><small>{recipe.seen_on?.join(', ') ?? ''}</small></td>
            <td data-label="Actions"><span className="lq-composer-row-actions"><button type="button" className="lq-text-button" onClick={() => patch({ mode: 'derive', account: name })}>Derive</button><button type="button" className="lq-text-button" onClick={() => patch({ mode: 'probe', account: name, sweep: recipe.needs_accounts[0] ?? recipe.needs_args[0] ?? '' })}>Probe</button></span></td></tr>)}
        </tbody></table></section>
      {data.queryable?.length ? <section className="lq-panel lq-composer-table-wrap" aria-label="Queryable account types"><header className="lq-panel-header"><h2>Queryable types ({data.queryable.length})</h2></header>
        <table className="lq-composer-table"><thead><tr><th scope="col">Type</th><th scope="col">Filterable fields</th><th scope="col"><span className="lq-sr-only">Actions</span></th></tr></thead><tbody>
          {data.queryable.map(item => <tr key={item.account}><td data-label="Type"><code>{item.account}</code></td><td data-label="Fields"><small>{item.filterableFields.map(field => `${field.path}:${field.type}@${field.offset}`).join(', ') || 'none typed'}</small></td><td data-label="Actions"><button type="button" className="lq-text-button" onClick={() => patch({ mode: 'find', account: item.account, where: {}, select: [] })}>Find</button></td></tr>)}
        </tbody></table></section> : null}
      <JsonView value={data} label="Recipes JSON" filename={`${state.program}.recipes.json`} />
    </> : null}
  </div>
}

// ------------------------------------------------------------------ idl ----

export function IdlTab({ state, patch }: TabProps) {
  const iface = useProgramInterface(state.program, state.idl)
  const current = iface.iface
  return <div className="lq-composer-stack">
    <Panel title="Program interface" caption="The program’s published on-chain IDL, or, when it has none, the interface the Composer reconstructed from landed transactions — with its evidence and limits as the service states them.">
      <ProgramField value={state.program} onChange={program => patch({ program })} />
      <Choice value={state.idl} onChange={idl => patch({ idl })} label="Interface source" options={[{ value: 'auto', label: 'Published, else learned' }, { value: 'published', label: 'Published only' }, { value: 'learned', label: 'Learned' }]} />
      <InterfaceStatus iface={iface} />
    </Panel>
    {current?.kind === 'published' ? <PublishedIdl idl={current.idl} program={current.programId} /> : null}
    {current?.kind === 'learned' ? <LearnedIdlView learned={current.learned} program={current.programId} publishedError={current.publishedError} /> : null}
  </div>
}

function DownloadButton({ value, filename }: { value: unknown; filename: string }) {
  return <button type="button" className="lq-button lq-button-sm lq-button-primary" onClick={() => downloadText(JSON.stringify(value, null, 2), filename)}><Icon name="download" size={14} />Download JSON</button>
}

function PublishedIdl({ idl, program }: { idl: AnchorIdl; program: string }) {
  const meta = (idl.metadata ?? {}) as Record<string, unknown>
  const instructions = idl.instructions ?? []
  return <>
    <section className="lq-panel lq-composer-idl" aria-label="Published IDL">
      <header className="lq-panel-header"><h2>{String(meta.name ?? idl.name ?? 'IDL')} {meta.version ? <small>v{String(meta.version)}</small> : null}</h2><div className="lq-composer-chips"><DownloadButton value={idl} filename={`${program}.idl.json`} /><CopyButton text={JSON.stringify(idl, null, 2)} label="Copy IDL JSON" className="lq-button lq-button-sm" done="IDL copied">Copy</CopyButton></div></header>
      <div className="lq-composer-provenance"><Badge tone="good">Published</Badge><p>Read from the program’s on-chain IDL account{meta.spec ? ` · spec ${String(meta.spec)}` : ''}. {instructions.length} instructions · {idl.accounts?.length ?? 0} account types · {idl.types?.length ?? 0} types · {idl.errors?.length ?? 0} errors.</p></div>
      <ul className="lq-composer-idl-list">{instructions.map(ix => <li key={ix.name}>
        <div><strong>{ix.name}</strong><small>{(ix.args ?? []).map(arg => `${arg.name}: ${typeLabelSafe(arg.type)}`).join(', ') || 'no args'} · {ix.accounts?.length ?? 0} accounts</small></div>
        <AppLink href={composerHref({ tab: 'build', program, ix: ix.name })} className="lq-text-link">Build <Icon name="arrow" size={12} /></AppLink>
      </li>)}</ul>
      {idl.errors?.length ? <details className="lq-composer-ranking"><summary><Icon name="chevron" size={12} />Errors ({idl.errors.length})</summary><ul className="lq-composer-considered">{idl.errors.map(error => <li key={error.code}><code>{error.code}</code> {error.name}{error.msg ? ` — ${error.msg}` : ''}</li>)}</ul></details> : null}
    </section>
    <JsonView value={idl} label="IDL JSON" filename={`${program}.idl.json`} />
  </>
}
const typeLabelSafe = (type: unknown) => { try { return typeLabel(type as never) } catch { return '?' } }

function LearnedIdlView({ learned, program, publishedError }: { learned: LearnedIdl; program: string; publishedError: string | null }) {
  const evidence = Object.entries(learned.evidence ?? {})
  return <>
    <section className="lq-panel lq-composer-idl" aria-label="Learned IDL">
      <header className="lq-panel-header"><h2>Learned interface</h2><div className="lq-composer-chips"><DownloadButton value={learned} filename={`${program}.learned-idl.json`} /><CopyButton text={JSON.stringify(learned, null, 2)} label="Copy learned IDL JSON" className="lq-button lq-button-sm" done="Learned IDL copied">Copy</CopyButton></div></header>
      <div className="lq-composer-provenance"><Badge tone="warn">Learned · not published</Badge>
        <p><strong>Source:</strong> {String(learned.metadata?.source ?? 'reconstructed from landed transactions')}{learned.cached ? ' · served from the service’s cache' : ''}</p>
        {publishedError ? <p><strong>Published IDL:</strong> {publishedError}</p> : null}
        {learned.truncated ? <p className="lq-composer-warn"><strong>Truncated:</strong> {learned.truncated}</p> : null}
      </div>
      {learned.caveats?.length ? <section className="lq-composer-caveats"><h3>Caveats, as stated by the service</h3><ul>{learned.caveats.map((caveat, i) => <li key={i}>{caveat}</li>)}</ul></section> : null}
      {learned.howToUse ? <section className="lq-composer-caveats"><h3>How to use it</h3><p>{learned.howToUse}</p></section> : null}
      {evidence.length ? <dl className="lq-composer-evidence">{evidence.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></div>)}</dl> : null}
      <ul className="lq-composer-idl-list is-learned">{learned.instructions.map(ix => <li key={ix.name}>
        <div><strong>{ix.name}</strong><small>seen in {ix.observedIn ?? '?'} · {ix.accounts.length} accounts · {ix.argBytes?.join(' / ') ?? '?'} B opaque args · discriminator {ix.discriminator?.map(byte => byte.toString(16).padStart(2, '0')).join('') ?? '?'}</small>
          {ix.nameSource ? <small className="lq-composer-source">{ix.nameSource}</small> : null}
          {ix.shapeNote ? <small>{ix.shapeNote}</small> : null}
          {ix.direction ? <small className="lq-composer-warn">{ix.direction}</small> : null}
          <details><summary>Accounts and samples</summary>
            <ol className="lq-composer-learned-accounts">{ix.accounts.map(account => <li key={account.name}><code>{account.name}</code>{account.signer ? <b title="Signer">S</b> : null}{account.writable ? <b title="Writable">W</b> : null}{account.address ? <> <Address value={account.address} chars={4} /></> : account.pda ? <i> PDA</i> : null}{account.evidence ? <small>{account.evidence}</small> : null}</li>)}</ol>
            {ix.argsHex?.length ? <p>argsHex samples: {ix.argsHex.map(hex => <code key={hex}>{hex}</code>)}</p> : null}
            {ix.exampleSignatures?.length ? <p>Examples: {ix.exampleSignatures.map(sig => <a key={sig} href={solscanTx(sig)} target="_blank" rel="noreferrer">{short(sig, 5)}</a>)}</p> : null}
          </details>
        </div>
        <span className="lq-composer-row-actions"><AppLink href={composerHref({ tab: 'land', program, ix: ix.name })} className="lq-text-link">Land <Icon name="arrow" size={12} /></AppLink><AppLink href={composerHref({ tab: 'build', program, ix: ix.name, idl: 'learned', argsHex: ix.argsHex?.[0] ?? '' })} className="lq-text-link">Build</AppLink></span>
      </li>)}</ul>
    </section>
    <JsonView value={learned} label="Learned IDL JSON" filename={`${program}.learned-idl.json`} />
  </>
}

// ----------------------------------------------------------------- send ----

export function SendTab({ state, patch }: TabProps) {
  const valid = useMemo(() => { try { sendBody(state.tx); return true } catch { return false } }, [state.tx])
  return <div className="lq-composer-grid-2">
    <Panel title="Send a transaction" caption="Paste a base64 transaction. A signed one is relayed through the Composer’s /send, which only broadcasts; an unsigned one built for your wallet can be signed here first. The other tabs send automatically after you sign.">
      <Field label="Transaction (base64)" error={state.tx && !valid ? 'Paste a base64 transaction' : null} wide>
        {id => <textarea id={id} rows={7} value={state.tx} spellCheck={false} placeholder="AQAAAA…" onChange={event => patch({ tx: event.target.value.trim() })} />}
      </Field>
    </Panel>
    <section className="lq-composer-results" aria-label="Transaction">
      {valid ? <PastedTxCard key={state.tx} base64={state.tx} /> : <Empty title="Paste a transaction" body="You will see the fee payer, the signers, whether it is signed, and a Send button. Signed transactions go through the relay exactly as pasted." />}
    </section>
  </div>
}
