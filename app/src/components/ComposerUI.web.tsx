// Small presentational pieces shared by the Composer tabs.
import { useId, useMemo, useState, type ReactNode } from 'react'
import { short } from '@/lib/format'
import { solscanAccount, type ComposerFailure, type Tone } from '@/lib/composer'
import { useElapsed } from '@/lib/use-composer'
import { Icon, useToast } from './MarketUI.web'

export async function copyText(text: string) { await navigator.clipboard.writeText(text) }

export function CopyButton({ text, label, done = 'Copied', className = 'lq-icon-button', children }: { text: string; label: string; done?: string; className?: string; children?: ReactNode }) {
  const toast = useToast()
  return <button type="button" className={className} aria-label={label} title={label} onClick={async () => { try { await copyText(text); toast(done) } catch { toast('Could not copy. Select the text instead.', true) } }}>
    <Icon name="copy" size={14} />{children}
  </button>
}

export function downloadText(text: string, filename: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = filename; anchor.rel = 'noopener'
  document.body.appendChild(anchor); anchor.click(); anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function Address({ value, chars = 6, link = true }: { value: string; chars?: number; link?: boolean }) {
  return <span className="lq-composer-address" title={value}>
    {link ? <a href={solscanAccount(value)} target="_blank" rel="noreferrer">{short(value, chars)}</a> : <code>{short(value, chars)}</code>}
    <CopyButton text={value} label={`Copy ${value}`} done="Address copied" className="lq-composer-mini" />
  </span>
}

export function Badge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return <span className={`lq-composer-badge tone-${tone}`} title={title}><i />{children}</span>
}

const MAX_RENDERED_JSON = 400_000
export function JsonView({ value, label, filename, open = false }: { value: unknown; label: string; filename?: string; open?: boolean }) {
  const text = useMemo(() => JSON.stringify(value, null, 2) ?? 'null', [value])
  return <details className="lq-composer-json" open={open}>
    <summary><Icon name="chevron" size={12} />{label}<small>{(text.length / 1024).toFixed(1)} KB</small></summary>
    <div className="lq-composer-json-actions">
      <CopyButton text={text} label={`Copy ${label}`} className="lq-button lq-button-sm" done="JSON copied">Copy JSON</CopyButton>
      {filename ? <button type="button" className="lq-button lq-button-sm" onClick={() => downloadText(text, filename)}><Icon name="download" size={14} />Download</button> : null}
    </div>
    <pre tabIndex={0}>{text.length > MAX_RENDERED_JSON ? `${text.slice(0, MAX_RENDERED_JSON)}\n… truncated in view — copy or download for the full document` : text}</pre>
  </details>
}

// Everything the service said, verbatim: the error plus each guidance field.
export function FailureNotice({ failure, onRebuild, title }: { failure: ComposerFailure; onRebuild?: () => void; title?: string }) {
  const guidance = failure.guidance ? Object.entries(failure.guidance) : []
  return <div className="lq-composer-failure" role="alert">
    <strong>{title ?? (failure.stale ? 'Blockhash expired — rebuild, do not resend' : failure.status ? `The Composer answered ${failure.status}` : 'Request failed')}</strong>
    <p>{failure.message}</p>
    {guidance.length ? <dl>{guidance.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{renderGuidance(value)}</dd></div>)}</dl> : null}
    {failure.rebuild && onRebuild ? <button type="button" className="lq-button lq-button-sm lq-button-primary" onClick={onRebuild}><Icon name="refresh" size={14} />Rebuild</button> : null}
  </div>
}
function renderGuidance(value: unknown): ReactNode {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return <ul>{value.map((item, i) => <li key={i}>{item}</li>)}</ul>
  return <pre>{JSON.stringify(value, null, 2)}</pre>
}

// Slow routes (/learn, /intent, /yolo, /land) report elapsed time and can be
// cancelled; the AbortController stops waiting, the service may still finish.
export function CallStatus({ running, startedAt, finishedAt, cancelled, onCancel, slowNote, label }: { running: boolean; startedAt: number | null; finishedAt?: number | null; cancelled?: boolean; onCancel?: () => void; slowNote?: string; label: string }) {
  const seconds = useElapsed(startedAt, running, finishedAt)
  if (running) return <div className="lq-composer-status is-running" role="status" aria-live="polite">
    <span className="lq-spinner" /><span><strong>{label}</strong><small>{seconds}s elapsed{slowNote ? ` · ${slowNote}` : ''}</small></span>
    {onCancel ? <button type="button" className="lq-button lq-button-sm" onClick={onCancel}><Icon name="close" size={13} />Cancel</button> : null}
  </div>
  if (cancelled) return <div className="lq-composer-status" role="status"><Icon name="pause" size={14} /><span><strong>Cancelled</strong><small>Stopped waiting. The service may still finish the work on its side.</small></span></div>
  if (startedAt && finishedAt) return <div className="lq-composer-status is-done"><Icon name="check" size={14} /><span><small>Answered in {seconds}s</small></span></div>
  return null
}

export function Field({ label, hint, error, children, wide }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode; wide?: boolean }) {
  const id = useId()
  return <div className={`lq-composer-field ${wide ? 'is-wide' : ''} ${error ? 'has-error' : ''}`}>
    <label htmlFor={id}>{label}</label>
    {children(id)}
    {error ? <small className="lq-composer-field-error" role="alert">{error}</small> : hint ? <small>{hint}</small> : null}
  </div>
}

// A list of strings edited as one value per line (sweep values, lookup tables).
export function LinesInput({ id, value, onChange, placeholder, rows = 3, label }: { id: string; value: string[]; onChange: (value: string[]) => void; placeholder?: string; rows?: number; label?: string }) {
  const [draft, setDraft] = useState(() => value.join('\n'))
  const [seen, setSeen] = useState(value)
  if (seen !== value && value.join('\n') !== draft.split('\n').map(line => line.trim()).filter(Boolean).join('\n')) { setSeen(value); setDraft(value.join('\n')) }
  return <textarea id={id} aria-label={label} rows={rows} value={draft} placeholder={placeholder} spellCheck={false}
    onChange={event => { setDraft(event.target.value); const next = event.target.value.split(/[\n,]/).map(line => line.trim()).filter(Boolean); setSeen(next); onChange(next) }} />
}
