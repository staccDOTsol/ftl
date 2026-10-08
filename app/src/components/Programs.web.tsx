import { useEffect, useState } from 'react'
import { router, useLocalSearchParams } from 'expo-router'
import { API_URL } from '@/lib/api'
import { ago, short } from '@/lib/format'
import { useLive } from '@/lib/live'
import { useClock } from '@/lib/clock'
import { programStateLabel, type ProgramMode } from '@/lib/program-model'
import { composerProgramHref, interfaceKindOf } from '@/lib/composer'
import { useProgramDetail, useProgramIndex } from '@/lib/use-program-index'
import type { ProgramActivity, ProgramBucket, ProgramDetail, ProgramRecord } from '../../../shared/programs'
import { AppLink, Choice, Icon, Notice, useToast } from './MarketUI.web'
import '@/programs.css'

const count = (value: number) => value.toLocaleString()
const stamp = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export default function Programs() {
  const params = useLocalSearchParams<{ program?: string }>()
  const selected = typeof params.program === 'string' ? params.program : null
  const [mode, setMode] = useState<ProgramMode>('new')
  const [input, setInput] = useState(''), [search, setSearch] = useState('')
  const [hours, setHours] = useState('1')
  const live = useLive()
  const now = useClock()
  const index = useProgramIndex(mode, search, Number(hours))
  const { detail, error: detailError } = useProgramDetail(selected)
  useEffect(() => { const timer = setTimeout(() => setSearch(input.trim()), 200); return () => clearTimeout(timer) }, [input])
  const choose = (program: string | null) => router.setParams({ program: program ?? '' })
  const totals = index.data?.totals
  const activeSources = index.data?.coverage.sources.filter(source => source.connected).length ?? 0
  const discoveries = index.data?.buckets.reduce((total, bucket) => total + bucket.discoveries, 0) ?? 0
  return <div className="lq-page lq-program-page"><div className="lq-page-inner">
    <header className="lq-page-heading">
      <div><div className="lq-eyebrow">Solana / The Composer</div><h1>The program frontier.</h1><p>Every new program in our traffic. Outer instructions, inner calls, and interfaces reconstructed from landed transactions.</p></div>
      <div className="lq-page-heading-actions"><span className={`lq-program-connection ${live.connected && index.lastPushTs ? 'is-live' : ''}`}><i />{live.connected && index.lastPushTs ? 'WebSocket live' : live.connected ? 'Subscribing…' : 'HTTP · reconnecting'}</span><button type="button" className="lq-icon-button" aria-label="Refresh program index" disabled={index.loading} onClick={index.refresh}><Icon name="refresh" /></button></div>
    </header>
    {index.error ? <Notice onRetry={index.refresh}>{index.error}</Notice> : null}
    <section className="lq-program-pulse" aria-label="Discovery throughput">
      <div className="lq-program-metrics">
        <div><span>Net-new / {hours}h</span><strong>{totals ? count(discoveries) : '—'}</strong><small>first seen by this index</small></div>
        <div><span>Unseen programs</span><strong>{totals ? count(totals.unseen) : '—'}</strong><small>{activeSources} active sources</small></div>
        <div><span>Composer queue</span><strong>{totals ? count(totals.queued) : '—'}</strong><small>{totals?.active ?? 0} learning / validating</small></div>
        <div><span>Interfaces indexed</span><strong>{totals ? count(totals.ready + totals.partial) : '—'}</strong><small>{totals?.ready ?? 0} sample-covered · {totals?.partial ?? 0} refining</small></div>
        <div><span>Transactions seen</span><strong>{totals ? count(totals.transactions) : '—'}</strong><small>{totals ? count(totals.invocations) : '—'} program invocations</small></div>
      </div>
      <div className="lq-program-chart-heading"><div><span className="lq-eyebrow">Arrival stream</span><p><i />New programs <b />IDLs indexed</p></div><Choice value={hours} onChange={setHours} label="Arrival history" options={[{ value: '1', label: '1h' }, { value: '6', label: '6h' }, { value: '24', label: '24h' }]} /></div>
      <ArrivalChart buckets={index.data?.buckets ?? []} hours={Number(hours)} />
      <div className="lq-program-chart-foot"><span>{totals?.lastObservationTs ? `Last observed ${stamp(totals.lastObservationTs)}` : 'Waiting for observed traffic'}</span><span>Unique signatures · arrival-time buckets · durable history</span></div>
    </section>
    <div className={`lq-program-workbench ${selected ? 'has-inspector' : ''}`}>
      <section className="lq-panel lq-program-index" aria-label="Program index">
        <div className="lq-program-controls"><Choice value={mode} onChange={setMode} label="Program index view" options={[{ value: 'new', label: 'Net-new' }, { value: 'usage', label: 'High usage' }, { value: 'atomic', label: 'Atomic / bundled' }, { value: 'interfaces', label: 'IDL index' }, { value: 'working', label: 'Progress' }]} /><label className="lq-program-search"><Icon name="search" size={15} /><input value={input} onChange={event => setInput(event.target.value)} placeholder="Program or address" aria-label="Search programs" autoComplete="off" spellCheck={false} maxLength={80} /></label></div>
        <div className="lq-program-table-wrap"><table className="lq-program-table"><thead><tr><th scope="col">Program</th><th scope="col">Usage</th><th scope="col">Route evidence</th><th scope="col">Composer / IDL</th><th scope="col">First seen</th></tr></thead><tbody>
          {index.data?.items.map(program => <tr key={program.address} className={`${program.address === selected ? 'is-selected' : ''} ${now - program.firstSeenTs < 10_000 ? 'is-new' : ''}`}>
            <td><button type="button" className="lq-program-identity" aria-label={`Inspect ${program.name ?? program.address}`} aria-expanded={program.address === selected} onClick={() => choose(program.address)}><strong>{program.name ?? short(program.address, 7)}<Icon name="chevron" size={13} /></strong><span title={program.address}>{program.address}</span></button></td>
            <td data-label="Usage"><strong>{count(program.transactions)}<small>tx</small></strong><span>{count(program.outerInvocations)} outer / {count(program.innerInvocations)} CPI</span></td>
            <td data-label="Route evidence"><RouteEvidence program={program} /></td>
            <td data-label="Composer"><StateBadge program={program} /><span title={program.phase}>{program.phase}</span></td>
            <td data-label="First seen"><time dateTime={new Date(program.firstSeenTs).toISOString()} title={new Date(program.firstSeenTs).toLocaleString()}>{ago(program.firstSeenTs)}</time></td>
          </tr>)}
          {!index.data && index.loading ? Array.from({ length: 6 }, (_, i) => <tr key={i} className="lq-program-skeleton"><td colSpan={5}><i /></td></tr>) : null}
        </tbody></table></div>
        {index.data && !index.data.items.length ? <div className="lq-program-empty"><h3>{search ? 'No matching programs.' : 'Listening for the frontier.'}</h3><p>{search ? 'Try a full program address or clear the filters.' : 'Newly observed outer and CPI programs will arrive here automatically.'}</p>{search ? <button type="button" className="lq-text-button" onClick={() => setInput('')}>Clear search</button> : null}</div> : null}
        <footer className="lq-panel-footer"><span>{index.data ? `${count(index.data.items.length)} shown / ${count(index.data.total)} matching` : 'Opening the durable index…'}</span><span>Ranked within observed traffic</span></footer>
      </section>
      <aside className="lq-program-inspector" aria-label={selected ? 'Program inspector' : 'Composer activity'}>
        {selected ? detail ? <Inspector detail={detail} onClose={() => choose(null)} /> : <section className="lq-panel lq-program-detail"><header><h2>{short(selected, 8)}</h2><button type="button" className="lq-icon-button" aria-label="Close inspector" onClick={() => choose(null)}><Icon name="close" /></button></header>{detailError ? <Notice>{detailError}</Notice> : <p role="status">Reading program evidence…</p>}</section>
          : <section className="lq-panel"><header className="lq-panel-header"><h2>Composer activity</h2><span className="lq-eyebrow">Live</span></header><Activity events={index.data?.activity ?? []} onSelect={choose} /></section>}
        <section className="lq-panel lq-program-source"><header className="lq-panel-header"><h2>Source coverage</h2></header><div><span className={`lq-program-source-dot ${index.data?.coverage.composer.connected ? 'is-live' : ''}`} /><strong>Recovered Composer</strong><small>{index.data?.coverage.composer.connected ? 'Connected' : index.data?.coverage.composer.reason ?? 'Checking…'}</small></div>
          {index.data?.coverage.sources.map(source => <div key={source.lane}><span className={`lq-program-source-dot ${source.connected ? 'is-live' : ''}`} /><strong>{source.lane}</strong><small>{count(source.transactions)} observed</small></div>)}
          <p>{index.data?.coverage.note ?? 'Discoveries are scoped to the Solana transactions FTL observes.'}</p>
        </section>
      </aside>
    </div>
  </div></div>
}

function ArrivalChart({ buckets, hours }: { buckets: ProgramBucket[]; hours: number }) {
  const maximum = Math.max(1, ...buckets.flatMap(bucket => [bucket.discoveries, bucket.learned]))
  const width = 1000, height = 94, step = width / Math.max(1, buckets.length)
  return <div className="lq-program-arrivals"><svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Net-new program arrivals and indexed interfaces over ${hours} hours`}>
    <line x1="0" y1="92" x2={width} y2="92" className="lq-program-baseline" />
    {buckets.map((bucket, i) => <g key={bucket.ts}><title>{new Date(bucket.ts).toLocaleString()}: {bucket.discoveries} new programs, {bucket.learned} interfaces indexed, {bucket.transactions} transactions</title><rect x={i * step + 1} y={92 - (bucket.discoveries / maximum) * 80} width={Math.max(1, step * .62 - 2)} height={(bucket.discoveries / maximum) * 80} rx="1" className="lq-program-arrival-bar" /><rect x={i * step + step * .64} y={92 - (bucket.learned / maximum) * 80} width={Math.max(1, step * .3 - 1)} height={(bucket.learned / maximum) * 80} rx="1" className="lq-program-learned-bar" /></g>)}
  </svg><div><span>{hours}h ago</span><span>{count(maximum)} programs / bucket at peak</span><span>Now</span></div></div>
}
function StateBadge({ program }: { program: ProgramRecord }) {
  return <strong className={`lq-program-state state-${program.state}`}><i />{programStateLabel[program.state]}</strong>
}
function RouteEvidence({ program }: { program: ProgramRecord }) {
  return <div className="lq-program-evidence">{program.atomicTransactions ? <b title="Two or more recognized swap instructions inside the same transaction">{count(program.atomicTransactions)} atomic</b> : null}{program.bundleHintTransactions ? <b className="is-hint" title="A real SOL transfer to a Jito tip account; bundle membership has not been proven">{count(program.bundleHintTransactions)} Jito hints</b> : null}{program.closedPositiveTransactions ? <b className="is-hint" title="Observed closed-inventory positive quote balance. This is not a verified profit guard.">{count(program.closedPositiveTransactions)} positive receipts</b> : null}{!program.atomicTransactions && !program.bundleHintTransactions ? <span>Observing</span> : null}</div>
}
function Activity({ events, onSelect }: { events: ProgramActivity[]; onSelect: (address: string) => void }) {
  return <ol className="lq-program-activity">{events.length ? events.slice(0, 35).map(event => <li key={event.id} className={`event-${event.kind}`}><time dateTime={new Date(event.ts).toISOString()}>{stamp(event.ts)}</time><button type="button" onClick={() => onSelect(event.address)}><strong>{short(event.address, 6)}<span>{event.kind === 'discovered' ? 'NEW' : programStateLabel[event.state]}</span></strong><small>{event.message}</small></button></li>) : <li><p>The next discovery or learning transition will appear here.</p></li>}</ol>
}
function Inspector({ detail, onClose }: { detail: ProgramDetail; onClose: () => void }) {
  const program = detail.program, toast = useToast()
  // A published (or shipped) IDL opens the Build form; an interface the
  // Composer reconstructed opens Land, which builds learned instructions.
  const kind = interfaceKindOf(program.idlSource, program.state)
  return <section className="lq-panel lq-program-detail">
    <header><div><div className="lq-eyebrow">Program inspector</div><h2>{program.name ?? short(program.address, 8)}</h2></div><button type="button" className="lq-icon-button" aria-label="Close program inspector" onClick={onClose}><Icon name="close" /></button></header>
    <div className="lq-program-address"><code>{program.address}</code><button type="button" className="lq-icon-button" aria-label="Copy program address" onClick={async () => { try { await navigator.clipboard.writeText(program.address); toast('Program address copied') } catch { toast('Could not copy the address', true) } }}><Icon name="copy" size={14} /></button></div>
    <div className="lq-program-detail-actions"><a href={`https://solscan.io/account/${program.address}`} target="_blank" rel="noreferrer" className="lq-button lq-button-sm">Explorer <Icon name="external" size={13} /></a><AppLink href={composerProgramHref(program.address, kind)} className="lq-button lq-button-sm" label="Open in Composer" title={kind === 'learned' ? 'Land a learned instruction with your wallet' : 'Build an instruction from its IDL'}>Open in Composer <Icon name="compose" size={13} /></AppLink>{detail.idlAvailable ? <a href={`${API_URL}/api/programs/solana/${program.address}/idl`} className="lq-button lq-button-primary lq-button-sm" download={`${program.address}.json`}>Download IDL <Icon name="arrow" size={13} /></a> : <span className="lq-program-no-idl">IDL queued for discovery</span>}</div>
    <div className="lq-program-progress" aria-live="polite"><StateBadge program={program} /><p>{program.phase}</p><dl><div><dt>Observed shapes</dt><dd>{program.sampleCount}</dd></div><div><dt>Instruction shapes</dt><dd>{program.instructionCount || '—'}</dd></div><div><dt>Validation matches</dt><dd>{program.validation ? `${program.validation.matched}/${program.validation.tested}` : '—'}</dd></div><div><dt>Source</dt><dd>{program.idlSource ?? 'pending'}</dd></div></dl>{program.reason ? <p className="lq-program-warning">{program.reason}</p> : null}{program.nextAttemptTs ? <small>Retry {new Date(program.nextAttemptTs).toLocaleTimeString()} · attempt {program.attempts}</small> : null}{program.idlHash ? <small className="lq-program-hash" title={program.idlHash}>SHA-256 {program.idlHash.slice(0, 20)}…</small> : null}</div>
    <div className="lq-program-detail-section"><h3>Execution evidence</h3><RouteEvidence program={program} /><p>{count(program.outerInvocations)} outer invocations · {count(program.innerInvocations)} CPI invocations · {count(program.transactions)} unique transactions</p></div>
    {detail.relationships.length ? <div className="lq-program-detail-section"><h3>Call relationships</h3><ul className="lq-program-relations">{detail.relationships.map(edge => <li key={`${edge.direction}:${edge.address}:${edge.attribution}`}><span>{edge.direction === 'calls' ? '→' : '←'}</span><button type="button" onClick={() => router.setParams({ program: edge.address })} title={edge.address}>{edge.name ?? short(edge.address, 7)}<small>{edge.direction} · {edge.attribution === 'direct' ? 'stack-proven CPI' : 'outer-root attribution'}</small></button><b>{count(edge.transactions)}</b></li>)}</ul></div> : null}
    {detail.instructions.length ? <div className="lq-program-detail-section"><h3>Indexed instructions</h3><ul className="lq-program-instructions">{detail.instructions.map((ix, i) => <li key={`${ix.name}:${i}`}><strong>{ix.name}{ix.nameSource ? <span title={ix.nameSource}>name hint</span> : null}<AppLink href={composerProgramHref(program.address, ix.argsDecoded && kind === 'published' ? 'published' : 'learned', ix.name)} className="lq-program-compose" label={`Open ${ix.name} in the Composer`}>{ix.argsDecoded && kind === 'published' ? 'Build' : 'Land'} <Icon name="arrow" size={10} /></AppLink></strong><code>{ix.discriminator.map(byte => byte.toString(16).padStart(2, '0')).join(' ')}</code><small>{ix.accounts} accounts · {ix.pdaAccounts} PDA recipes · {ix.argsDecoded ? 'argument layout declared' : `${ix.argumentBytes?.join(' / ') ?? '?'}B opaque arguments`}</small></li>)}</ul>{detail.caveats.length ? <details className="lq-program-caveats"><summary>Reconstruction evidence & limits</summary>{detail.caveats.map((caveat, i) => <p key={i}>{caveat}</p>)}{detail.evidence ? <pre>{JSON.stringify(detail.evidence, null, 2)}</pre> : null}</details> : null}</div> : null}
    <div className="lq-program-detail-section"><h3>Transaction receipts</h3><ul className="lq-program-receipts">{detail.receipts.map(receipt => <li key={receipt.signature}><a href={`https://solscan.io/tx/${receipt.signature}`} target="_blank" rel="noreferrer"><code>{short(receipt.signature, 8)}</code><Icon name="external" size={12} /></a><span>V{receipt.version} · slot {count(receipt.slot)} · {receipt.failed ? 'failed' : receipt.finalized ? 'finalized' : 'executed'}</span>{receipt.atomic || receipt.bundleHint ? <small>{receipt.atomic ? 'Atomic route' : ''}{receipt.atomic && receipt.bundleHint ? ' / ' : ''}{receipt.bundleHint ? 'Jito tip' : ''}</small> : null}</li>)}</ul></div>
    <div className="lq-program-detail-section"><h3>Learning timeline</h3><Activity events={detail.activity} onSelect={address => router.setParams({ program: address })} /></div>
  </section>
}
