import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { router, useGlobalSearchParams, usePathname } from 'expo-router'
import { get } from '@/lib/api'
import { ago, short, usd, usdOf } from '@/lib/format'
import { eventLink } from '@/lib/event-context'
import { useLive } from '@/lib/live'
import { useSocial } from '@/lib/social'
import { isMintLike } from '@/lib/swap-link'
import { onWalletConnectRequest, useWalletSession } from '@/lib/wallet-session'
import type { FlowEvent, TokenSummary, WalletSummary } from '@/lib/types'
import { KIND } from '@/theme'
import { AppLink, Avatar, Dialog, Icon, LiveBadge, Notice, Placeholder, ToastProvider, type IconName } from './MarketUI.web'
import '@/global.css'
import WalletObserver from './WalletObserver.web'

const HoldingsWallet = lazy(() => import('./HoldingsWallet.web'))
const NAV: { href: string; label: string; icon: IconName; section?: string }[] = [
  { href: '/', label: 'Discover', icon: 'discover', section: 'Market' },
  { href: '/swap', label: 'Trade', icon: 'swap' },
  { href: '/swap?mode=liquidity', label: 'Earn', icon: 'earn' },
  { href: '/holdings', label: 'Portfolio', icon: 'wallet' },
  { href: '/following', label: 'Following', icon: 'users', section: 'Your edge' },
  { href: '/leaders', label: 'Leaderboard', icon: 'trophy' },
  { href: '/signals', label: 'Signals', icon: 'signal' },
  { href: '/research', label: 'Research', icon: 'search' },
  { href: '/programs', label: 'Program frontier', icon: 'activity' },
  { href: '/composer', label: 'Composer', icon: 'compose' },
]

function Brand() {
  return <AppLink href="/" className="lq-brand" label="liquidityxyz home">
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="m6 22 7-15h7l-7 15H6Zm10 3 7-15h5l-7 15h-5Z" fill="currentColor" /></svg>
    <span>liquidity<span className="lq-brand-xyz">xyz</span></span>
  </AppLink>
}

export default function AppShell({ children }: { children: ReactNode }) {
  return <ToastProvider><Shell>{children}</Shell></ToastProvider>
}

function Shell({ children }: { children: ReactNode }) {
  const path = usePathname()
  const { mode } = useGlobalSearchParams<{ mode?: string }>()
  const live = useLive()
  const social = useSocial()
  const session = useWalletSession()
  const [search, setSearch] = useState(false)
  // 'browse' opens the portfolio after connecting; 'sign' keeps the person on
  // the surface that asked for a signer (the Composer).
  const [wallet, setWallet] = useState<false | 'browse' | 'sign'>(false)
  const [menu, setMenu] = useState(false)
  const [status, setStatus] = useState(false)
  const main = useRef<HTMLElement>(null)
  const selected = (href: string) => href === '/swap?mode=liquidity' ? path === '/swap' && mode === 'liquidity'
    : href === '/swap' ? path === '/swap' && mode !== 'liquidity'
      : href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`)

  useEffect(() => {
    let active = true
    void get<FlowEvent[]>('/api/feed', { limit: 300 }).then(events => { if (active) live.seed(events) }).catch(() => {})
    return () => { active = false }
  }, [live])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      const typing = target.closest('input, textarea, select, [contenteditable="true"]')
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' || event.key === '/' && !typing && !document.querySelector('dialog[open]')) {
        event.preventDefault(); setSearch(value => !value)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => onWalletConnectRequest(() => setWallet('sign')), [])
  useEffect(() => {
    setMenu(false)
    setStatus(false)
    const title = NAV.find(item => selected(item.href))?.label ?? (path.startsWith('/token/') ? 'Token' : path.startsWith('/wallet/') ? 'Wallet' : path.startsWith('/profile/') ? 'Profile' : 'Workspace')
    document.title = `${title} · liquidityxyz`
    // Place keyboard focus on the new work surface, without scrolling it.
    main.current?.focus({ preventScroll: true })
    // selected is intentionally evaluated only when the URL changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, mode])

  const nav = (close?: () => void) => <nav aria-label="Main navigation" className="lq-nav">
    {NAV.map(item => <div key={item.href}>{item.section ? <div className="lq-nav-section">{item.section}</div> : null}<AppLink href={item.href} label={item.label} current={selected(item.href)} className={`lq-nav-item ${selected(item.href) ? 'is-active' : ''}`} onClick={close}>
      <Icon name={item.icon} /><span>{item.label}</span>{item.href === '/' ? <i className="lq-nav-live" /> : null}
    </AppLink></div>)}
  </nav>

  return <div className="lq-shell">
    <WalletObserver />
    <a className="lq-skip" href="#workspace">Skip to content</a>
    <aside className="lq-sidebar">
      <Brand />
      {nav()}
      <div className="lq-sidebar-bottom">
        <AppLink href="/token/robinhood/0xb051d6c1feb3e43b67a0a2b2aa7e0caa536614c4" className="lq-official"><span className="lq-official-mark">L</span><span><strong>Meet $LXYZ</strong><small>The official token</small></span><Icon name="arrow" size={15} /></AppLink>
        <details className="lq-source"><summary><Icon name="github" size={15} /> Built in the open <Icon name="chevron" size={12} /></summary><div><a href="https://github.com/staccDOTsol/ftl" target="_blank" rel="noreferrer">App source ↗</a><a href="https://github.com/staccDOTsol/autobahn" target="_blank" rel="noreferrer">Router ↗</a><a href="https://github.com/staccDOTsol/permissionless-lst-engine" target="_blank" rel="noreferrer">LST engine ↗</a></div></details>
        <AppLink href="/me" current={path === '/me'} className="lq-profile-link"><Avatar label={social.profile?.handle ?? 'You'} size={32} /><span><strong>{social.profile?.handle ? `@${social.profile.handle}` : 'Your profile'}</strong><small>No sign-up needed</small></span><Icon name="settings" size={16} /></AppLink>
      </div>
    </aside>
    <div className="lq-app">
      <header className="lq-topbar">
        <button type="button" className="lq-icon-button lq-mobile-menu" aria-label="Open navigation" onClick={() => setMenu(true)}><Icon name="menu" /></button>
        <div className="lq-mobile-brand"><Brand /></div>
        <button type="button" className="lq-search-trigger" onClick={() => setSearch(true)} aria-label="Search tokens and wallets"><Icon name="search" size={17} /><span>Search tokens, wallets, anything on-chain</span><kbd>⌘ K</kbd></button>
        <div className="lq-topbar-end">
          <button type="button" className="lq-connection-button" onClick={() => setStatus(value => !value)} aria-expanded={status} aria-label="Connection status"><LiveBadge />{live.status ? <span className="lq-connected-count">{live.status.clients} connected</span> : null}</button>
          <button type="button" className="lq-icon-button lq-small-search" aria-label="Search tokens and wallets" onClick={() => setSearch(true)}><Icon name="search" /></button>
          <button type="button" className={`lq-button ${session.address ? '' : 'lq-button-primary'} lq-wallet-button`} onClick={() => session.address ? router.navigate(`/holdings?owner=${session.address}`) : setWallet('browse')}><Icon name="wallet" size={16} /><span>{session.address ? short(session.address) : 'Connect wallet'}</span></button>
        </div>
      </header>
      <MarketRibbon />
      <main id="workspace" ref={main} tabIndex={-1} data-route={path.split('/')[1] || 'discover'} className={`lq-workspace ${path.startsWith('/token/') ? 'lq-token-route' : ''}`}>
        {children}
      </main>
      <footer className="lq-statusbar">
        <button type="button" onClick={() => setStatus(value => !value)}><LiveBadge compact /><span>{live.connected ? 'Stream connected' : live.healthy ? 'HTTP fallback · reconnecting' : 'Reconnecting to stream'}</span></button>
        <span className="lq-status-prices">SOL <b>{live.status?.prices?.SOL ? `$${live.status.prices.SOL.toFixed(2)}` : '—'}</b><i /> ETH <b>{live.status?.prices?.ETH ? `$${live.status.prices.ETH.toFixed(2)}` : '—'}</b></span>
        <AppLink href="/me">Follow the liquidity <Icon name="arrow" size={12} /></AppLink>
      </footer>
      <nav className="lq-mobile-nav" aria-label="Quick navigation">
        {[NAV[0], NAV[1], NAV[2], NAV[3], NAV[5]].map(item => <AppLink key={item.href} href={item.href} current={selected(item.href)} className={selected(item.href) ? 'is-active' : ''}><Icon name={item.icon} size={19} /><span>{item.label === 'Leaderboard' ? 'Leaders' : item.label}</span></AppLink>)}
      </nav>
    </div>
    {search ? <SearchDialog onClose={() => setSearch(false)} /> : null}
    {wallet ? <Dialog title={wallet === 'sign' ? 'Connect a wallet to sign' : 'Your wallet. Your next move.'} onClose={() => setWallet(false)} className="lq-wallet-dialog"><p className="lq-dialog-copy">{wallet === 'sign' ? 'Transactions are built for this wallet. Nothing is signed until you approve it in your wallet.' : 'Connect to see your balances and positions, then trade or put your tokens to work.'}</p><Suspense fallback={<Placeholder title="Finding your wallets…" busy />}><HoldingsWallet onAddress={address => { setWallet(false); if (wallet === 'browse') router.navigate(`/holdings?owner=${address}`) }} /></Suspense></Dialog> : null}
    {menu ? <Dialog title="Explore liquidityxyz" onClose={() => setMenu(false)} className="lq-navigation-dialog">{nav(() => setMenu(false))}<AppLink href="/me" className="lq-nav-item" onClick={() => setMenu(false)}><Icon name="settings" />Your profile & settings</AppLink></Dialog> : null}
    {status ? <Dialog title="Connected to the action" onClose={() => setStatus(false)}><div className="lq-status-detail"><LiveBadge /><p>One shared stream delivers pool births, liquidity moves, token updates, and calls across the app.</p>{(live.status?.lanes ?? []).filter(lane => lane.enabled).map(lane => <div key={`${lane.chain}:${lane.lane}`}><span><i className={lane.connected ? 'is-up' : ''} />{lane.chain === 'solana' ? 'Solana' : 'Robinhood'}<small>{lane.lane}</small></span><b>{lane.connected ? 'Connected' : 'Reconnecting'}</b></div>)}<AppLink href="/me" className="lq-text-link" onClick={() => setStatus(false)}>Full stream diagnostics <Icon name="arrow" size={14} /></AppLink></div></Dialog> : null}
  </div>
}

function MarketRibbon() {
  const live = useLive()
  const [frozen, setFrozen] = useState<FlowEvent[] | null>(null)
  const events = useMemo(() => live.events.filter(event => event.token && event.stage === 'confirmed' && event.kind !== 'launch').slice(0, 10), [live.events])
  return <div className="lq-ribbon" onMouseEnter={() => setFrozen(events)} onMouseLeave={() => setFrozen(null)} onFocus={() => setFrozen(events)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFrozen(null) }}>
    <span className="lq-ribbon-label"><Icon name="activity" size={14} />ON CHAIN</span>
    <div className="lq-ribbon-track">
      {(frozen ?? events).map(event => {
        const amount = usdOf(event, live.status?.prices)
        return <AppLink key={event.id} href={eventLink(event)} className="lq-ribbon-item"><span>{event.tokenMeta?.symbol || short(event.token)}</span><b className={event.kind === 'liq_remove' ? 'lq-negative' : 'lq-positive'}>{KIND[event.kind].glyph} {amount !== null && amount >= 0.01 ? usd(amount) : KIND[event.kind].label}</b><small>{ago(event.ts)}</small></AppLink>
      })}
      {!events.length ? <span className="lq-ribbon-waiting">{live.healthy ? 'Listening for the next liquidity move…' : 'Connecting to Solana & Robinhood Chain…'}</span> : null}
    </div>
  </div>
}

function SearchDialog({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{ tokens: TokenSummary[]; wallets?: WalletSummary[] } | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  useEffect(() => {
    let active = true
    const text = query.trim()
    const timer = setTimeout(() => {
      const request = text ? get<{ tokens: TokenSummary[]; wallets?: WalletSummary[] }>('/api/search', { q: text })
        : get<TokenSummary[]>('/api/tokens/hot', { hours: 1, limit: 7 }).then(tokens => ({ tokens }))
      void request.then(data => { if (active) setResult(data) }).catch(() => { if (active) setError(true) }).finally(() => { if (active) setBusy(false) })
    }, text ? 180 : 0)
    return () => { active = false; clearTimeout(timer) }
  }, [query])
  const pasted = isMintLike(query)
  return <Dialog title="Find your next move" onClose={onClose} className="lq-search-dialog">
    <div className="lq-search-input"><Icon name="search" /><input ref={input} value={query} onChange={event => { setQuery(event.target.value); setBusy(true); setError(false); setResult(null) }} placeholder="Token, symbol, or wallet address" aria-label="Search tokens or wallets" autoComplete="off" autoCorrect="off" spellCheck={false} /></div>
    <div className="lq-search-results">
      <div className="lq-eyebrow">{query.trim() ? 'Search results' : 'Trending right now'}{busy ? <span className="lq-spinner" /> : null}</div>
      {error ? <Notice>Search is temporarily unavailable. Try another search.</Notice> : null}
      {result?.tokens.map(token => <AppLink key={`${token.chain}:${token.address}`} href={`/token/${token.chain}/${token.address}`} className="lq-search-result" onClick={onClose}>
        <Avatar label={token.symbol ?? short(token.address)} image={token.image} chain={token.chain} /><span><strong>{token.symbol || short(token.address)}</strong><small>{token.name || short(token.address, 8)}</small></span><em>{token.chain === 'solana' ? 'SOL' : 'RH'}</em><Icon name="arrow" size={16} />
      </AppLink>)}
      {result?.wallets?.map(wallet => <AppLink key={`${wallet.chain}:${wallet.address}`} href={`/wallet/${wallet.chain}/${wallet.address}`} className="lq-search-result" onClick={onClose}><Avatar label={wallet.address} chain={wallet.chain} /><span><strong>{wallet.label || short(wallet.address, 6)}</strong><small>Wallet · {wallet.adds} liquidity adds</small></span><Icon name="arrow" size={16} /></AppLink>)}
      {pasted ? <AppLink href={`/swap?out=${encodeURIComponent(query.trim())}`} className="lq-search-paste" onClick={onClose}><Icon name="swap" /><span>Trade this Solana token<small>Works with any mint address</small></span><Icon name="arrow" size={16} /></AppLink> : null}
      {result && !busy && !result.tokens.length && !result.wallets?.length && !pasted ? <Placeholder title="Nothing found yet" body="Try a token symbol, name, or the full address." /> : null}
    </div>
    <div className="lq-dialog-foot"><span>Search without connecting a wallet</span><span><kbd>esc</kbd> to close</span></div>
  </Dialog>
}
