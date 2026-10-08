// The Composer workspace: every route of the hosted Composer service, with the
// connected wallet as payer and every tab's state mirrored into the URL so a
// link reopens it prefilled (`run=1` also runs it, never signs).
import { useEffect, useEffectEvent, useMemo, useState } from 'react'
import { router, useLocalSearchParams } from 'expo-router'
import { buildBody, coerceArgs, composerRequest, isAddress, learnedRequirements, NATIVE_INSTRUCTIONS, parseComposerQuery, queryString, serializeComposerQuery, TABS, composerHref, instructionSpec, type ComposerState, type InterfaceRef } from '@/lib/composer'
import { useComposerCall, useComposerHealth, useProgramInterface, useRequirements } from '@/lib/use-composer'
import { short } from '@/lib/format'
import { BuiltView, ComposerWalletProvider, useComposerWallet } from './ComposerTx.web'
import { Address, Badge, CallStatus, FailureNotice, Field, JsonView } from './ComposerUI.web'
import { InstructionForm, InstructionPicker, OptionsForm, ProgramField, instructionChoices } from './ComposerForms.web'
import { AccountsTab, BatchTab, IdlTab, IntentTab, LandTab, SendTab, type TabProps } from './ComposerTabs.web'
import { Icon, useToast } from './MarketUI.web'
import '@/composer.css'

export default function Composer() {
  return <ComposerWalletProvider><Workspace /></ComposerWalletProvider>
}

type Params = Record<string, string | string[] | undefined>

function Workspace() {
  const params = useLocalSearchParams() as Params
  const wallet = useComposerWallet()
  const health = useComposerHealth()
  const toast = useToast()
  const parsed = useMemo(() => parseComposerQuery(params), [params])
  const [state, setState] = useState<ComposerState>(parsed)
  const [autorun, setAutorun] = useState(parsed.run)
  // URL <-> state. `written` holds the last few queries this page put in the
  // URL (a `run` marker keeps `run=1` pending until it is stripped); any other
  // incoming query is a navigation, such as a deep link, and replaces state.
  const incoming = queryString(serializeComposerQuery(parsed))
  const marked = (query: string, run: boolean) => run ? `${query}#run` : query
  const [written, setWritten] = useState<string[]>(() => [marked(incoming, parsed.run)])
  const [seen, setSeen] = useState(marked(incoming, parsed.run))
  if (marked(incoming, parsed.run) !== seen) {
    setSeen(marked(incoming, parsed.run))
    if (parsed.run || !written.includes(incoming)) { setState(parsed); setWritten(list => [...list.slice(-4), marked(incoming, parsed.run)]); if (parsed.run) setAutorun(true) }
  }
  const latest = written[written.length - 1]
  useEffect(() => {
    const query = serializeComposerQuery(state)
    const text = queryString(query)
    if (text === latest) return
    const timer = setTimeout(() => {
      setWritten(list => [...list.slice(-4), text])
      const next: Record<string, string | undefined> = { ...query }
      for (const key of Object.keys(params)) if (!(key in query)) next[key] = undefined
      router.setParams(next)
    }, 300)
    return () => clearTimeout(timer)
  }, [state, latest, params])

  const patch = (next: Partial<ComposerState>) => setState(previous => ({ ...previous, ...next }))
  const payer = wallet.address ?? (isAddress(state.payer) ? state.payer.trim() : null)
  const props: TabProps = { state, patch, payer, autorun, onAutoran: () => setAutorun(false) }
  const link = (run: boolean) => `${window.location.origin}${composerHref(state, { run })}`
  const copyLink = async (run: boolean) => { try { await navigator.clipboard.writeText(link(run)); toast(run ? 'Link copied. It runs this query when opened (it never signs).' : 'Prefilled link copied') } catch { toast('Could not copy the link', true) } }

  return <div className="lq-page lq-composer-page"><div className="lq-page-inner">
    <header className="lq-page-heading">
      <div><div className="lq-eyebrow">Solana / The Composer</div><h1>Compose any Solana transaction.</h1>
        <p>Say what you want, or build an instruction from a program’s IDL. The Composer, a hosted service, returns an unsigned transaction for your wallet. Plans are ranked by whether they actually simulate against mainnet, and nothing is signed until you click and approve it.</p></div>
      <div className="lq-page-heading-actions"><span className={`lq-composer-health ${health?.ok ? 'is-live' : health ? 'is-down' : ''}`} title={health?.note ?? ''}><i />{health ? health.ok ? `Service live${health.version ? ` · v${health.version}` : ''}` : 'Service unreachable' : 'Checking service…'}</span></div>
    </header>

    <section className="lq-composer-payer" aria-label="Payer">
      {wallet.address ? <>
        <Icon name="wallet" size={16} /><span><small>Payer · {wallet.name ?? 'connected wallet'}</small><Address value={wallet.address} chars={6} /></span>
        <p>Every builder uses this wallet as the payer. You approve each signature in the wallet.</p>
      </> : <>
        <Field label="Preview payer" hint="Without a wallet you can preview for any address. Signing needs that wallet connected." error={state.payer && !isAddress(state.payer) ? 'Not a base58 address' : null}>
          {id => <input id={id} value={state.payer} placeholder="Paste a wallet address to preview" spellCheck={false} autoComplete="off" onChange={event => patch({ payer: event.target.value.trim() })} />}
        </Field>
        <button type="button" className="lq-button lq-button-primary" onClick={wallet.connect}><Icon name="wallet" size={15} />Connect wallet</button>
      </>}
    </section>

    <div className="lq-composer-tabs" role="tablist" aria-label="Composer tools">
      {TABS.map(tab => <button key={tab.value} type="button" role="tab" id={`composer-tab-${tab.value}`} aria-selected={state.tab === tab.value} aria-controls="composer-panel" className={state.tab === tab.value ? 'is-active' : ''} onClick={() => patch({ tab: tab.value })}>{tab.label}</button>)}
    </div>

    <div id="composer-panel" role="tabpanel" aria-labelledby={`composer-tab-${state.tab}`} className="lq-composer-panel">
      {state.tab === 'intent' ? <IntentTab {...props} /> : null}
      {state.tab === 'build' ? <InstructionWorkbench key="build" {...props} mode="build" /> : null}
      {state.tab === 'diagnose' ? <InstructionWorkbench key="diagnose" {...props} mode="diagnose" /> : null}
      {state.tab === 'land' ? <LandTab {...props} /> : null}
      {state.tab === 'batch' ? <BatchTab {...props} /> : null}
      {state.tab === 'accounts' ? <AccountsTab {...props} /> : null}
      {state.tab === 'idl' ? <IdlTab {...props} /> : null}
      {state.tab === 'send' ? <SendTab {...props} /> : null}
    </div>

    <footer className="lq-composer-linkbar">
      <span><Icon name="external" size={13} />This tab, prefilled</span>
      <button type="button" className="lq-button lq-button-sm" onClick={() => void copyLink(false)}><Icon name="copy" size={13} />Copy link</button>
      <button type="button" className="lq-button lq-button-sm" onClick={() => void copyLink(true)}><Icon name="play" size={13} />Copy link that runs</button>
    </footer>
    <p className="lq-composer-fineprint">The Composer engine is a hosted service at its own domain; this page calls it directly from your browser. It builds and simulates, and its /send only relays a transaction you already signed. Simulation uses current mainnet state, so a plan that simulates can still fail later if prices or accounts change.</p>
  </div></div>
}

// ---------------------------------------------------- build / diagnose ----

function InstructionWorkbench({ state, patch, payer, autorun, onAutoran, mode }: TabProps & { mode: 'build' | 'diagnose' }) {
  const toast = useToast()
  const iface = useProgramInterface(state.program, state.idl)
  const current = iface.iface
  const published = current?.kind === 'published' ? current : null
  const knownIx = !!published && (published.idl.instructions ?? []).some(ix => ix.name === state.ix)
  const requirementsState = useRequirements(state.program, state.ix, knownIx)
  const learnedIx = current?.kind === 'learned' ? current.learned.instructions.find(ix => ix.name === state.ix) ?? null : null
  const native = current?.kind === 'native' ? NATIVE_INSTRUCTIONS.find(ix => ix.name === state.ix) ?? null : null
  const requirements = published ? requirementsState.data : learnedIx ? learnedRequirements(learnedIx) : null
  const argDefs = useMemo(() => published ? requirements?.args ?? [] : native ? native.args : [], [published, requirements, native])
  const ref: InterfaceRef | null = !current ? null : current.kind === 'published' ? { kind: 'published', idl: current.idl } : current.kind === 'learned' ? { kind: 'learned', learned: current.learned } : { kind: 'native' }
  const ready = !!ref && !!state.ix && (published ? !!requirements : current?.kind === 'learned' ? !!learnedIx : !!native)
  const [checked, setChecked] = useState(false)
  const argErrors = useMemo(() => checked ? coerceArgs(argDefs, state.args, published?.idl).errors : {}, [checked, argDefs, state.args, published])
  const call = useComposerCall<Record<string, unknown>>()
  const path = mode === 'build' ? '/tx/build' : '/diagnose'

  function run() {
    setChecked(true)
    if (!ref) return
    let body: Record<string, unknown>
    try { body = buildBody(state, payer, ref, argDefs) } catch (error) { call.fail(error); return }
    void call.run(signal => composerRequest<Record<string, unknown>>(path, body, signal), body)
  }
  const autoRun = useEffectEvent(() => { onAutoran(); run() })
  useEffect(() => { if (!autorun || !ready) return; const timer = setTimeout(autoRun, 0); return () => clearTimeout(timer) }, [autorun, ready])

  const changeProgram = (program: string) => patch({ program, ix: '', args: {}, accounts: {}, argsHex: '' })
  const changeIx = (ix: string) => patch({ ix, args: {}, argsHex: '' })
  const addToBatch = () => {
    if (!ref || ref.kind === 'learned') return
    try {
      const step = instructionSpec(state, ref, argDefs, payer)
      delete step.idl
      patch({ batch: { ...state.batch, instructions: [...state.batch.instructions, step] } })
      toast(`Added ${step.instruction} to the batch (${state.batch.instructions.length + 1} steps)`)
    } catch (error) { call.fail(error) }
  }
  const data = call.data
  const diagnosis = data && typeof data.diagnosis === 'object' ? data.diagnosis as { verdict?: string; accountsChecked?: number; findings?: Record<string, unknown>[] } : null

  return <div className="lq-composer-grid-2">
    <section className="lq-panel lq-composer-form" aria-label={mode === 'build' ? 'Build an instruction' : 'Diagnose an instruction'}>
      <header className="lq-panel-header"><h2>{mode === 'build' ? 'Build from an IDL' : 'Diagnose a failing instruction'}</h2></header>
      <p className="lq-panel-caption">{mode === 'build' ? 'Pick a program and instruction. The form follows the IDL: you supply what cannot be derived, the service resolves the rest and simulates.' : 'Build and simulate an instruction, then let the service check which accounts explain a failure.'}</p>
      <div className="lq-composer-form-body">
        <ProgramField value={state.program} onChange={changeProgram} iface={iface} allowNative />
        {current?.kind === 'published' || state.idl === 'learned' ? <label className="lq-composer-check"><input type="checkbox" checked={state.idl === 'learned'} onChange={event => patch({ idl: event.target.checked ? 'learned' : 'auto', ix: '', args: {}, argsHex: '' })} /><span>Use the learned interface instead of the published IDL</span></label> : null}
        {current ? <InstructionPicker value={state.ix} onChange={changeIx} choices={instructionChoices(current)} /> : null}
        {requirementsState.error ? <FailureNotice failure={requirementsState.error} title="Could not read the requirements" /> : null}
        {knownIx && !requirements && !requirementsState.error ? <p className="lq-composer-hint" role="status"><span className="lq-spinner" /> Reading what this instruction needs…</p> : null}
        {current && ready ? <InstructionForm state={state} patch={patch} iface={current} requirements={requirements} argDefs={argDefs} argErrors={argErrors} payer={payer} /> : null}
        {current?.kind === 'learned' && state.ix && !learnedIx ? <p className="lq-composer-warn">“{state.ix}” is not one of the learned instruction names for this program.</p> : null}
        <OptionsForm options={state.options} onChange={options => patch({ options })} extra={state.extra} onExtra={extra => patch({ extra })} payer={payer} />
      </div>
      <footer className="lq-composer-actions">
        {!payer ? <span className="lq-composer-hint">Connect a wallet or paste a preview payer.</span> : <span className="lq-composer-hint">Payer {short(payer, 5)}</span>}
        {mode === 'build' && ref && ref.kind !== 'learned' ? <button type="button" className="lq-button" disabled={!ready} onClick={addToBatch}><Icon name="plus" size={14} />Add to batch</button> : null}
        <button type="button" className="lq-button lq-button-primary" disabled={!ready || !payer || call.status === 'running'} onClick={run}>{mode === 'build' ? 'Build & simulate' : 'Diagnose'}<Icon name="arrow" size={14} /></button>
      </footer>
    </section>
    <section className="lq-composer-results" aria-label="Result" aria-live="polite">
      <CallStatus running={call.status === 'running'} startedAt={call.startedAt} finishedAt={call.finishedAt} cancelled={call.cancelled} onCancel={call.cancel} label={mode === 'build' ? 'Building and simulating…' : 'Building, simulating and checking accounts…'} />
      {call.error ? <FailureNotice failure={call.error} onRebuild={run} /> : null}
      {diagnosis ? <DiagnosisView diagnosis={diagnosis} /> : null}
      {data ? <BuiltView key={call.finishedAt ?? 0} response={data} builtAt={call.finishedAt ?? 0} onRebuild={run} rebuilding={call.status === 'running'} title={mode === 'build' ? `${state.ix || 'Instruction'} for ${payer ? short(payer, 4) : 'the payer'}` : 'Diagnosed transaction'} /> : null}
      {data ? <JsonView value={data} label="Full response" filename={`composer-${mode}-${state.ix || 'tx'}.json`} /> : null}
      {call.status === 'idle' && !call.error && !call.cancelled ? <div className="lq-composer-empty"><Icon name="compose" size={22} /><h3>{mode === 'build' ? 'Nothing built yet' : 'Nothing diagnosed yet'}</h3><p>{mode === 'build' ? 'The unsigned transaction, its simulation and every resolved account appear here.' : 'Findings name the accounts that explain a failed simulation, with the reason.'}</p></div> : null}
    </section>
  </div>
}

function DiagnosisView({ diagnosis }: { diagnosis: { verdict?: string; accountsChecked?: number; findings?: Record<string, unknown>[] } }) {
  const findings = diagnosis.findings ?? []
  return <section className="lq-composer-diagnosis" aria-label="Diagnosis">
    <header><span className="lq-eyebrow">Diagnosis · {diagnosis.accountsChecked ?? '?'} accounts checked</span><Badge tone={findings.length ? 'bad' : 'good'}>{findings.length ? `${findings.length} findings` : 'No account problems'}</Badge></header>
    {diagnosis.verdict ? <p>{diagnosis.verdict}</p> : null}
    <ol>{findings.map((finding, i) => <li key={i}>
      <strong><code>{String(finding.account ?? '?')}</code> {String(finding.problem ?? '')}</strong>
      {typeof finding.why === 'string' ? <p>{finding.why}</p> : null}
      <dl>{Object.entries(finding).filter(([key, value]) => !['account', 'problem', 'why'].includes(key) && value !== null && value !== undefined).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === 'string' && isAddress(value) ? <Address value={value} chars={5} /> : typeof value === 'string' ? value : JSON.stringify(value)}</dd></div>)}</dl>
    </li>)}</ol>
  </section>
}

