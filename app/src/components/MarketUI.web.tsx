import { createContext, forwardRef, useCallback, useContext, useEffect, useRef, useState, type AnchorHTMLAttributes, type CSSProperties, type ReactNode } from 'react'
import { Link, type Href } from 'expo-router'
import { img } from '@/lib/format'
import { useLive } from '@/lib/live'
import { useSocial } from '@/lib/social'
import type { Chain } from '@/lib/types'

export type IconName = 'discover' | 'activity' | 'swap' | 'earn' | 'wallet' | 'trophy' | 'users' | 'search' | 'arrow' | 'external' | 'chevron' | 'close' | 'plus' | 'check' | 'pause' | 'play' | 'refresh' | 'settings' | 'copy' | 'clock' | 'filter' | 'signal' | 'menu' | 'github' | 'bell'
const paths: Record<IconName, ReactNode> = {
  discover: <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m8 15 2-5 6-1-2 5-6 1Z" /></>,
  activity: <path d="M2 12h5l3-8 4 16 3-8h5" />,
  swap: <><path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4" /></>,
  earn: <><path d="M4 19h16M6 15v-4m6 4V8m6 7V4M4 7l6-4" /></>,
  wallet: <><rect x="3" y="5" width="18" height="15" rx="3" /><path d="M3 9h18m-5 4h5v4h-5a2 2 0 0 1 0-4ZM5 5V3h12v2" /></>,
  trophy: <><path d="M8 3h8v6a4 4 0 0 1-8 0V3Zm4 10v6m-4 2h8M8 5H4v2a4 4 0 0 0 4 4m8-6h4v2a4 4 0 0 1-4 4" /></>,
  users: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v3" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  external: <path d="M14 3h7v7m0-7L10 14m0-10H4v16h16v-6" />,
  chevron: <path d="m8 4 8 8-8 8" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 12 4 4L19 6" />,
  pause: <path d="M9 5v14M15 5v14" />,
  play: <path d="m7 4 13 8-13 8V4Z" />,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.3 8a8 8 0 0 1 13.2-2L20 8M4 16l1.5 2A8 8 0 0 0 18.7 16" /></>,
  settings: <><path d="M4 7h16M4 17h16M8 4v6m8 4v6" /></>,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M15 8V3H3v13h5" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  filter: <><path d="M3 6h18M6 12h12M9 18h6" /></>,
  signal: <><path d="M5 19v-4m5 4v-8m5 8V7m5 12V3" /></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  github: <><path d="M8 20c-5 1-5-3-7-3m14 5v-4c0-1-.4-2-1-2 4 0 7-2 7-6 0-2-1-3-2-4 0-1 0-3-1-4-2 0-3 1-4 2a13 13 0 0 0-5 0C8 3 7 2 5 2c-1 1-1 3-1 4-1 1-2 2-2 4 0 4 3 6 7 6-1 0-1 1-1 2v4" /></>,
  bell: <><path d="M5 9a7 7 0 0 1 14 0v6l2 3H3l2-3V9Zm5 12h4" /></>,
}

export function Icon({ name, size = 18, className = '' }: { name: IconName; size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

// Expo Router forwards both RN's onPress and the DOM onClick. Consume the RN
// prop here so it doesn't become an unknown event handler on the anchor.
const RouterAnchor = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement> & { onPress?: unknown }>(function RouterAnchor({ onPress, ...props }, ref) {
  void onPress
  return <a {...props} ref={ref} />
})
export function AppLink({ href, children, className, label, onClick, current, title }: { href: string; children: ReactNode; className?: string; label?: string; onClick?: () => void; current?: boolean; title?: string }) {
  return <Link href={href as Href} asChild><RouterAnchor className={className} aria-label={label} aria-current={current ? 'page' : undefined} onClick={onClick} title={title}>{children}</RouterAnchor></Link>
}

export function Avatar({ image, label, size = 38, chain }: { image?: string | null; label: string; size?: number; chain?: Chain }) {
  const [failed, setFailed] = useState<string | null>(null)
  const src = img(image, size)
  let hash = 0
  for (const letter of label) hash = (hash * 31 + letter.charCodeAt(0)) % 360
  return <span className="lq-avatar" style={{ width: size, height: size, '--avatar-hue': hash } as CSSProperties}>
    <span>{label.replace(/^\$/, '').slice(0, 2).toUpperCase() || '?'}</span>
    {src && failed !== src ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(src)} /> : null}
    {chain ? <i className={`lq-chain-dot ${chain}`} title={chain === 'solana' ? 'Solana' : 'Robinhood Chain'} /> : null}
  </span>
}

export function LiveBadge({ compact = false }: { compact?: boolean }) {
  const live = useLive()
  const label = live.connected ? 'Live' : live.healthy ? 'Reconnecting · HTTP' : 'Reconnecting'
  return <span className={`lq-live-badge ${live.connected ? 'is-live' : 'is-reconnecting'}`} title={live.connected ? 'Connected to the live WebSocket' : live.healthy ? 'WebSocket reconnecting. Updates continue over HTTP.' : 'Waiting for a live connection'}>
    <i />{compact ? <span className="lq-sr-only">{label}</span> : label}
  </span>
}

export function Choice<T extends string>({ value, options, onChange, label, className = '' }: { value: T; options: { value: T; label: string; icon?: IconName }[]; onChange: (value: T) => void; label: string; className?: string }) {
  return <div className={`lq-choice ${className}`} role="group" aria-label={label}>
    {options.map(option => <button type="button" key={option.value} className={value === option.value ? 'is-active' : ''} aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
      {option.icon ? <Icon name={option.icon} size={15} /> : null}{option.label}
    </button>)}
  </div>
}

export function Placeholder({ title, body, action, busy = false }: { title: string; body?: string; action?: ReactNode; busy?: boolean }) {
  return <div className={`lq-placeholder ${busy ? 'is-loading' : ''}`} role={busy ? 'status' : undefined}>
    <div className="lq-placeholder-orbit"><Icon name={busy ? 'refresh' : 'activity'} size={24} /></div>
    <h3>{title}</h3>{body ? <p>{body}</p> : null}{action}
  </div>
}

export function RowSkeleton({ rows = 6 }: { rows?: number }) {
  return <div className="lq-skeleton-list" role="status" aria-label="Loading market data">
    {Array.from({ length: rows }, (_, i) => <div className="lq-skeleton-row" key={i}><i /><span><b /><em /></span><strong /><strong /></div>)}
  </div>
}

export function Notice({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return <div className="lq-notice" role="status"><span>{children}</span>{onRetry ? <button type="button" className="lq-text-button" onClick={onRetry}>Retry <Icon name="refresh" size={14} /></button> : null}</div>
}

const ToastContext = createContext<(message: string, error?: boolean) => void>(() => {})
export const useToast = () => useContext(ToastContext)
export function ToastProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<{ id: number; text: string; error: boolean }[]>([])
  const id = useRef(0)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const notify = useCallback((text: string, error = false) => {
    const key = ++id.current
    setMessages(previous => [...previous.slice(-2), { id: key, text, error }])
    const timer = setTimeout(() => { setMessages(previous => previous.filter(message => message.id !== key)); timers.current.delete(timer) }, 4500)
    timers.current.add(timer)
  }, [])
  useEffect(() => { const current = timers.current; return () => { for (const timer of current) clearTimeout(timer) } }, [])
  return <ToastContext.Provider value={notify}>{children}<div className="lq-toasts" aria-live="polite" aria-atomic="false">
    {messages.map(message => <div className={`lq-toast ${message.error ? 'is-error' : ''}`} key={message.id}><Icon name={message.error ? 'signal' : 'check'} size={17} /><span>{message.text}</span><button type="button" aria-label="Dismiss notification" onClick={() => setMessages(previous => previous.filter(item => item.id !== message.id))}><Icon name="close" size={15} /></button></div>)}
  </div></ToastContext.Provider>
}

export function FollowButton({ kind, chain, address, compact = false }: { kind: 'token' | 'wallet' | 'user'; chain: Chain; address: string; compact?: boolean }) {
  const social = useSocial()
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const following = social.isFollowing(kind, chain, address)
  return <button type="button" className={`lq-follow ${following ? 'is-following' : ''} ${compact ? 'is-compact' : ''}`} disabled={busy} aria-pressed={following} aria-label={`${following ? 'Unfollow' : 'Follow'} ${kind}`} onClick={async () => {
    if (busy) return
    setBusy(true)
    try { await social.toggle(kind, chain, address); toast(following ? 'Removed from your watchlist' : 'Following. New moves will appear in your feed.') }
    catch { toast('Could not update your watchlist. Try again.', true) }
    finally { setBusy(false) }
  }}><Icon name={following ? 'check' : 'plus'} size={14} />{!compact ? following ? 'Following' : 'Follow' : null}</button>
}

export function Dialog({ title, onClose, children, className = '' }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const dialog = ref.current
    dialog?.showModal()
    return () => { dialog?.close(); opener?.focus() }
  }, [])
  return <dialog ref={ref} className={`lq-dialog ${className}`} aria-label={title} onCancel={event => { event.preventDefault(); onClose() }} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="lq-dialog-inner"><header><h2>{title}</h2><button type="button" className="lq-icon-button" aria-label="Close dialog" onClick={onClose}><Icon name="close" /></button></header>{children}</div>
  </dialog>
}
