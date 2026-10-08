import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { router, useLocalSearchParams } from 'expo-router'
import { live, useLive } from '@/lib/live'
import { useNow } from '@/lib/useNow'
import { useWalletSession } from '@/lib/wallet-session'
import { ago, short, usd, venue } from '@/lib/format'
import { fromAtomic } from '@/lib/solana-trade'
import { ACTION_LABEL, actionMint, getHoldings, isActionHref, isSolanaAddress, liquidityActionHref, SOL_MINT, type Holdings, type HoldingAction } from '@/lib/solana-holdings'
import { liquidityLink, swapLink } from '@/lib/swap-link'
import { retitle, useTokenMeta, type TokenMetaMap } from '@/lib/token-meta'
import HoldingsWallet from './HoldingsWallet.web'
import { ActivityFeed } from './ActivityFeed.web'
import { AppLink, Avatar, Choice, Icon, Notice, Placeholder, RowSkeleton, useToast } from './MarketUI.web'

type PortfolioSnapshot = { owner: string; data: Holdings; at: number }
const portfolioCache = new Map<string, PortfolioSnapshot>()

export default function Portfolio() {
  const { owner: ownerParam } = useLocalSearchParams<{ owner?: string }>()
  const session = useWalletSession()
  const owner = ownerParam && isSolanaAddress(ownerParam) ? ownerParam.trim() : session.address
  const [input, setInput] = useState(owner ?? '')
  const [result, setResult] = useState<PortfolioSnapshot | null>(() => owner ? portfolioCache.get(owner) ?? null : null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<'actions' | 'tokens' | 'positions'>('actions')
  const [changeWallet, setChangeWallet] = useState(false)
  const generation = useRef(0)
  const lastRead = useRef(0)
  const invalidateRead = useCallback(() => { generation.current++ }, [])
  const toast = useToast()
  const stream = useLive()
  const now = useNow(5000)
  const load = useCallback(async (address: string) => {
    const request = ++generation.current
    lastRead.current = Date.now()
    setLoading(true); setError(null)
    try {
      const data = await getHoldings(address)
      const snapshot = { owner: address, data, at: Date.now() }
      portfolioCache.set(address, snapshot)
      if (portfolioCache.size > 6) portfolioCache.delete(portfolioCache.keys().next().value!)
      if (generation.current === request) setResult(snapshot)
    } catch (error) { if (generation.current === request) setError(error instanceof Error ? error.message : 'Holdings could not load.') }
    finally { if (generation.current === request) setLoading(false) }
  }, [])
  useEffect(() => {
    const first = setTimeout(() => {
      if (owner) {
        const saved = portfolioCache.get(owner)
        if (saved) { lastRead.current = saved.at; setResult(saved); setError(null); setLoading(false) }
        if (!saved || Date.now() - saved.at > 15_000) void load(owner)
      }
      else { setResult(null); setError(null); setLoading(false) }
    }, 0)
    return () => { clearTimeout(first); invalidateRead() }
  }, [owner, load, invalidateRead])
  useEffect(() => {
    if (!owner) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = live.onEvent(event => {
      if (event.chain === 'solana' && event.wallet === owner && !timer && Date.now() - lastRead.current >= 15_000) timer = setTimeout(() => { timer = undefined; void load(owner) }, 2500)
    })
    const foreground = () => { if (document.visibilityState === 'visible' && Date.now() - lastRead.current > 30_000) void load(owner) }
    document.addEventListener('visibilitychange', foreground)
    return () => { off(); if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', foreground) }
  }, [owner, load])
  const choose = useCallback((address: string) => {
    if (!isSolanaAddress(address.trim())) { setError('Enter a valid Solana wallet address.'); return }
    setInput(address.trim()); setChangeWallet(false)
    if (owner === address.trim()) void load(address.trim())
    else router.setParams({ owner: address.trim() })
  }, [load, owner])
  const data = result?.owner === owner ? result.data : null
  const mints = useMemo(() => data ? [...data.tokens.map(token => token.mint), ...data.positions.positions.flatMap(position => [position.mintA, position.mintB]), ...data.actions.map(action => actionMint(action.href))] : [], [data])
  const meta = useTokenMeta(mints)
  const seen = (mint: string) => mint === SOL_MINT || !!data?.tokens.find(token => token.mint === mint)?.token || meta[mint]?.source === 'ftl'
  const sol = data ? Number(fromAtomic(data.sol.lamports, 9)) : null
  const events = useMemo(() => stream.events.filter(event => event.chain === 'solana' && event.wallet === owner), [stream.events, owner])
  return <div className="lq-page lq-portfolio-page"><div className="lq-page-inner">
    <header className="lq-page-heading"><div><div className="lq-eyebrow"><Icon name="wallet" size={14} />Your next move starts here</div><h1>{owner ? 'Your capital. In motion.' : 'A home for your next move.'}</h1><p>{owner ? 'Balances, liquidity positions, and the actions available to this wallet.' : 'See what you hold. Find what you can do. Put it to work.'}</p></div>{owner ? <div className="lq-page-heading-actions"><button type="button" className="lq-button" onClick={() => setChangeWallet(value => !value)}><Icon name="wallet" size={14} />Change wallet</button><button type="button" className="lq-icon-button" aria-label="Refresh portfolio" disabled={loading} onClick={() => void load(owner)}><Icon name="refresh" size={15} className={loading ? 'lq-is-spinning' : ''} /></button></div> : null}</header>
    {!owner || changeWallet ? <section className="lq-portfolio-connect"><div className="lq-connect-story"><div className="lq-connect-orbits" aria-hidden="true"><span /><span /><span /><Icon name="wallet" size={36} /></div><h2>One wallet.<br />Every possibility.</h2><p>Trade tokens. Add liquidity. Find your exit.<br />Start with the assets you already have.</p><span className="lq-eyebrow">No signature needed to explore</span></div><div className="lq-connect-form"><h2>Let’s see what you’re holding.</h2><p>Use a wallet you already have, or create an embedded wallet.</p><HoldingsWallet onAddress={choose} /><div className="lq-connect-divider"><span />or watch any wallet<span /></div><form onSubmit={event => { event.preventDefault(); choose(input) }}><label htmlFor="portfolio-owner">Solana wallet address</label><div><input id="portfolio-owner" value={input} onChange={event => { setInput(event.target.value); setError(null) }} placeholder="Paste a public wallet address" autoComplete="off" spellCheck={false} aria-invalid={!!error && !isSolanaAddress(input)} /><button type="submit" className="lq-button lq-button-primary" disabled={!input.trim() || loading}><Icon name="arrow" size={18} /><span className="lq-sr-only">View wallet</span></button></div></form>{error ? <Notice>{error}</Notice> : null}{changeWallet ? <button type="button" className="lq-text-button" onClick={() => setChangeWallet(false)}>Keep current wallet</button> : null}</div></section> : null}
    {owner && !changeWallet ? <>
      <div className="lq-portfolio-address"><Avatar label={owner.slice(-2)} size={24} /><span>Viewing {short(owner, 6)}</span><button type="button" className="lq-icon-button" aria-label="Copy wallet address" onClick={async () => { try { await navigator.clipboard.writeText(owner); toast('Wallet address copied') } catch { toast('Could not copy the wallet address.', true) } }}><Icon name="copy" size={12} /></button><span className="lq-portfolio-read-time">{loading ? 'Refreshing balances…' : result?.owner === owner ? `Updated ${ago(result.at, now)} ago` : 'Reading wallet…'}</span></div>
      {error ? <Notice onRetry={() => void load(owner)}>{data ? `Refresh failed. Showing the last balances. ${error}` : error}</Notice> : null}
      {loading && !data ? <RowSkeleton rows={7} /> : null}
      {data ? <>
        <section className="lq-portfolio-summary"><div className="lq-sol-balance"><span className="lq-eyebrow">Available SOL</span><strong>{sol?.toLocaleString(undefined, { maximumFractionDigits: 5 })}<span>SOL</span></strong><small>{sol !== null && stream.status?.prices?.SOL ? `≈ ${usd(sol * stream.status.prices.SOL)}` : 'Price unavailable'} · SOL balance only</small></div><div className="lq-portfolio-counts"><div><strong>{data.tokens.length}</strong><span>Token accounts</span></div><div><strong>{data.positions.positions.length}</strong><span>Positions found</span></div></div><div className="lq-portfolio-ctas"><AppLink href="/swap?mode=liquidity" className="lq-button lq-button-primary"><Icon name="earn" size={16} />Put SOL to work</AppLink><AppLink href="/swap" className="lq-button"><Icon name="swap" size={15} />Trade tokens</AppLink></div></section>
        {data.positions.error || data.positions.errors.length ? <Notice>{data.positions.error || `Some venues did not respond: ${data.positions.errors.map(error => venue(error.venue)).join(', ')}. Positions shown may be incomplete.`}</Notice> : null}
        <div className="lq-market-layout"><section className="lq-panel lq-portfolio-assets"><div className="lq-portfolio-tabs"><Choice label="Portfolio view" value={tab} onChange={setTab} options={[{ value: 'actions', label: `Your moves ${data.actions.length}` }, { value: 'tokens', label: `Tokens ${data.tokens.length}` }, { value: 'positions', label: `Positions ${data.positions.positions.length}` }]} /></div>
          {tab === 'actions' ? <><div className="lq-portfolio-section-title"><h2>What you can do, right now.</h2><p>Executable actions from this wallet’s actual balances and positions.</p></div>{data.actions.map((action, index) => <PortfolioAction key={`${action.href}:${index}`} action={action} meta={meta} href={liquidityActionHref(action, seen, data.positions.positions)} />)}{!data.actions.length ? <Placeholder title="Ready for your first move" body="Add SOL to your wallet or explore tokens with active liquidity." action={<AppLink href="/" className="lq-button">Explore the market <Icon name="arrow" size={14} /></AppLink>} /> : null}</>
            : tab === 'tokens' ? <div className="lq-asset-list">{data.tokens.map(token => {
              const record = meta[token.mint]
              const label = token.wrappedSol ? 'Wrapped SOL' : token.token?.symbol || record?.symbol || short(token.mint)
              const name = token.token?.name || record?.name
              const href = token.token ? `/token/solana/${token.mint}` : swapLink(SOL_MINT, token.mint)
              return <div className="lq-asset-row" key={token.account}><AppLink href={href}><Avatar image={token.token?.image || record?.image} label={label} size={37} /><span><strong>{label}</strong><small>{name || short(token.mint)}</small></span></AppLink><strong className="lq-asset-amount">{fromAtomic(token.amount, token.decimals)}</strong><AppLink href={swapLink(token.mint, token.mint === SOL_MINT ? undefined : SOL_MINT)} className="lq-quick-trade">Trade <Icon name="arrow" size={12} /></AppLink>{!token.wrappedSol ? <AppLink href={liquidityLink(token.mint)} className="lq-quick-earn" label={`Earn with ${label}`}><Icon name="earn" size={15} /></AppLink> : null}</div>
            })}{!data.tokens.length ? <Placeholder title="Your tokens will live here" body="This wallet has no token accounts with a balance." /> : null}</div>
              : <div className="lq-position-list">{data.positions.positions.map(position => {
                const mint = position.mintA !== SOL_MINT ? position.mintA : position.mintB
                const symbol = (address: string) => address === SOL_MINT ? 'SOL' : meta[address]?.symbol || short(address)
                return <div className="lq-position-row" key={`${position.venue}:${position.position}`}><div><Avatar image={meta[mint]?.image} label={symbol(mint)} size={36} /><span><strong>{symbol(position.mintA)} / {symbol(position.mintB)}</strong><small>{venue(position.venue)} · {short(position.pool)}</small></span></div><div className="lq-position-actions"><AppLink href={liquidityLink(mint, position.pool)} className="lq-button lq-button-sm">Add <Icon name="plus" size={12} /></AppLink><AppLink href={liquidityLink(mint, position.pool, 'exit')} className="lq-button lq-button-sm">Withdraw <Icon name="arrow" size={12} /></AppLink></div></div>
              })}{!data.positions.positions.length ? <Placeholder title="Your first position starts with SOL" body="Pick a token and an amount. FTL handles pool selection and the deposit route." action={<AppLink href="/swap?mode=liquidity" className="lq-button lq-button-primary">Explore Earn <Icon name="arrow" size={14} /></AppLink>} /> : null}</div>}
        </section><aside className="lq-market-rail"><ActivityFeed events={events} compact limit={7} title="This wallet’s live moves" /><div className="lq-watchlist-note"><Icon name="activity" size={22} /><h2>From the feed to your wallet.</h2><p>New activity from this wallet refreshes your holdings automatically while you’re here.</p><AppLink href={`/wallet/solana/${owner}`} className="lq-text-link">See wallet history <Icon name="arrow" size={14} /></AppLink></div></aside></div>
      </> : !loading && !error ? <Placeholder title="Choose a wallet to continue" /> : null}
    </> : null}
  </div></div>
}

function PortfolioAction({ action, meta, href }: { action: HoldingAction; meta: TokenMetaMap; href: string }) {
  const mint = actionMint(action.href)
  const title = mint ? retitle(action.title, mint, meta) : action.title
  const icon = action.kind === 'add' ? 'earn' : action.kind === 'exit' ? 'wallet' : 'swap'
  return <div className="lq-portfolio-action"><span className={`lq-action-icon ${action.kind === 'exit' || action.kind === 'sell' ? 'is-exit' : ''}`}><Icon name={icon} size={20} /></span><div><strong>{title}</strong><p>{action.detail}</p></div>{isActionHref(href) ? <AppLink href={href} className="lq-quick-trade" label={title}>{ACTION_LABEL[action.kind]}<Icon name="arrow" size={13} /></AppLink> : <span className="lq-muted">Unavailable</span>}</div>
}
