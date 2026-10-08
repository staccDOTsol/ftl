import { useMemo, useState } from 'react'
import { useLive } from '@/lib/live'
import { useLiveResource } from '@/lib/use-live-resource'
import { useNow } from '@/lib/useNow'
import { activityBuckets, rankTokens, recentEvents, type MarketChain, type MarketSort } from '@/lib/market-model'
import { ago, pct, short, usd, usdOf } from '@/lib/format'
import type { Flag, Post, TokenSummary, WalletSummary } from '@/lib/types'
import { FLAG } from '@/theme'
import { PostItem } from './Posts'
import { ActivityFeed } from './ActivityFeed.web'
import { MarketBoard } from './MarketBoard.web'
import { AppLink, Avatar, Choice, FollowButton, Icon, LiveBadge, Notice, Placeholder, RowSkeleton } from './MarketUI.web'

const chains: { value: MarketChain; label: string }[] = [{ value: 'all', label: 'All chains' }, { value: 'solana', label: 'Solana' }, { value: 'robinhood', label: 'Robinhood' }]
const sortOptions: { value: MarketSort; label: string }[] = [{ value: 'hot', label: 'Trending' }, { value: 'new', label: 'New pools' }, { value: 'wallets', label: 'Most LPs' }]

export default function Discover({ signals = false }: { signals?: boolean }) {
  const live = useLive()
  const now = useNow(3000)
  const [chain, setChain] = useState<MarketChain>('all')
  const [sort, setSort] = useState<MarketSort>('hot')
  const [view, setView] = useState<'tokens' | 'activity' | 'calls'>('tokens')
  const [flag, setFlag] = useState<Flag | 'all'>('all')
  const [limit, setLimit] = useState(12)
  const [query, setQuery] = useState('')
  const hours = signals ? 12 : 1
  const resource = useLiveResource<TokenSummary[]>(`/api/tokens/hot?hours=${hours}&limit=100`, 30_000)
  const ranked = useMemo(() => rankTokens(resource.data ?? [], live.tokens.values(), chain, sort, now - hours * 3600_000)
    .filter(token => (flag === 'all' || token.flags.includes(flag)) && (!query.trim() || `${token.symbol ?? ''} ${token.name ?? ''} ${token.address}`.toLowerCase().includes(query.trim().toLowerCase()))),
  // The stream mutates its token Map in place and publishes this revision.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [resource.data, live.tokens, live.tokenTick, chain, sort, now, hours, flag, query])
  const spotlight = ranked.find(token => token.chain === 'solana' && token.fundedPools > 0 && !token.flags.includes('honeypot_fee'))

  return <div className="lq-page lq-discover"><div className="lq-page-inner">
    <header className="lq-page-heading"><div><div className="lq-eyebrow"><span className="lq-tiny-dot" />{signals ? 'Read the on-chain signals' : 'Your edge starts on-chain'}</div><h1>{signals ? 'Find the signal.' : 'Follow the liquidity.'}</h1><p>{signals ? 'See the structure behind the move. Pools, funding, and the wallets arriving first.' : 'See what’s moving. Follow who’s early. Make your move.'}</p></div><div className="lq-page-heading-actions"><AppLink href="/swap" className="lq-button"><Icon name="swap" size={15} />Quick trade</AppLink></div></header>
    <MarketPulse />
    <div className="lq-market-layout">
      <div className="lq-market-main">
        {!signals && spotlight ? <TokenSpotlight token={spotlight} /> : null}
        <section className="lq-panel lq-discovery-panel">
          <div className="lq-discovery-tabs" role="group" aria-label="Discovery view">
            {([{ value: 'tokens', label: signals ? 'Tokens' : 'Trending', icon: 'signal' }, { value: 'activity', label: 'Live feed', icon: 'activity' }, { value: 'calls', label: 'The room', icon: 'users' }] as const).map(tab => <button type="button" key={tab.value} className={view === tab.value ? 'is-active' : ''} aria-pressed={view === tab.value} onClick={() => setView(tab.value)}><Icon name={tab.icon} size={16} />{tab.label}{tab.value === 'activity' ? <i /> : null}</button>)}
            <span className="lq-discovery-period">{hours}H ACTIVITY</span>
          </div>
          {view !== 'calls' ? <div className="lq-market-toolbar"><Choice value={chain} options={chains} onChange={value => { setChain(value); setLimit(12) }} label="Filter by chain" />{view === 'tokens' ? <button type="button" className="lq-icon-button" aria-label="Refresh trending tokens" disabled={resource.loading} onClick={() => void resource.refresh()}><Icon name="refresh" size={14} className={resource.loading ? 'lq-is-spinning' : ''} /></button> : <LiveBadge />}</div> : null}
          {view === 'tokens' ? <>
            <div className="lq-board-tools"><Choice value={sort} options={sortOptions} onChange={setSort} label="Sort tokens" className="lq-flat-choice" /><label className="lq-inline-search"><Icon name="search" size={14} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter tokens" aria-label="Filter trending tokens" /></label></div>
            {signals ? <details className="lq-signal-options"><summary><Icon name="filter" size={14} />{flag === 'all' ? 'Signal filters & definitions' : FLAG[flag].label}<Icon name="chevron" size={12} /></summary><div><button type="button" aria-pressed={flag === 'all'} onClick={() => setFlag('all')}>All signals</button>{(['pounce', 'burst_5_600', 'multi_venue', 'honeypot_fee', 'ladder', 'jit'] as Flag[]).map(item => <button type="button" key={item} aria-pressed={flag === item} onClick={() => setFlag(item)} title={FLAG[item].about}>{FLAG[item].label}</button>)}</div>{flag !== 'all' ? <p>{FLAG[flag].about}</p> : null}</details> : null}
            {resource.error ? <Notice onRetry={() => void resource.refresh()}>{resource.data ? 'Showing the last snapshot. Live token updates continue.' : 'The token board could not load. Live activity is still available.'}</Notice> : null}
            {resource.data === null && resource.loading && !ranked.length ? <RowSkeleton rows={7} /> : <MarketBoard key={`${chain}:${sort}:${flag}:${query}`} tokens={ranked} max={limit} emptyAction={query || flag !== 'all' || chain !== 'all' ? () => { setQuery(''); setFlag('all'); setChain('all') } : undefined} />}
            <footer className="lq-panel-footer"><span>{ranked.length ? `${Math.min(limit, ranked.length)} of ${ranked.length} active tokens` : 'Watching for active tokens'}<span className="lq-footer-detail"> · ranked by liquidity, not price</span></span>{ranked.length > limit ? <button type="button" className="lq-text-button" onClick={() => setLimit(value => value + 12)}>Show more <Icon name="plus" size={13} /></button> : <LiveBadge />}</footer>
          </> : view === 'activity' ? <ActivityFeed chain={chain} limit={80} title="On-chain tape" /> : <CallsRoom />}
        </section>
        <EarnInvitation />
      </div>
      <aside className="lq-market-rail">
        <ActivityFeed compact chain={chain} limit={7} onExpand={() => setView('activity')} />
        <LeadersPreview />
      </aside>
    </div>
  </div></div>
}

export function MarketPulse() {
  const live = useLive()
  const now = useNow(3000)
  const events = useMemo(() => recentEvents(live.events).filter(event => event.stage === 'confirmed' && event.ts >= now - 3600_000), [live.events, now])
  const buckets = useMemo(() => activityBuckets(events, now - 60_000, now, 30), [events, now])
  const max = Math.max(1, ...buckets.map(bucket => bucket.incoming + bucket.outgoing + bucket.launches))
  const adds = events.filter(event => event.kind === 'liq_add' || event.kind === 'pool_init')
  const pulls = events.filter(event => event.kind === 'liq_remove')
  const sum = (rows: typeof events) => {
    const values = rows.map(event => usdOf(event, live.status?.prices)).filter((value): value is number => value !== null && Number.isFinite(value))
    return values.length ? values.reduce((a, b) => a + b, 0) : null
  }
  const span = events.length ? ago(events[events.length - 1].ts, now) : '—'
  const arrivals = [live.perMinute('solana'), live.perMinute('robinhood')].filter((value): value is number => value !== null)
  return <section className="lq-market-pulse" aria-label="Recent market activity">
    <div className="lq-pulse-main"><div className="lq-pulse-top"><span className="lq-eyebrow">The market, right now</span><LiveBadge /></div><div className="lq-pulse-body"><div><strong>{arrivals.length ? arrivals.reduce((a, b) => a + b, 0).toLocaleString() : '—'}</strong><span>stream arrivals<small>observed · last 60s</small></span></div><div className="lq-pulse-bars" role="img" aria-label="Confirmed observed events in the last 60 seconds">{buckets.map((bucket, index) => <i key={index} style={{ height: `${Math.max(4, (bucket.incoming + bucket.outgoing + bucket.launches) / max * 100)}%`, opacity: .22 + index / 38 }} title={`${bucket.incoming + bucket.outgoing + bucket.launches} observed moves`} />)}</div></div></div>
    <div className="lq-pulse-metric"><span className="lq-eyebrow"><span className="lq-flow-arrow is-in">↗</span>Liquidity in</span><strong className="lq-positive">{usd(sum(adds))}</strong><small>{adds.length} adds & pool births</small></div>
    <div className="lq-pulse-metric"><span className="lq-eyebrow"><span className="lq-flow-arrow is-out">↘</span>Liquidity out</span><strong className="lq-negative">{usd(sum(pulls))}</strong><small>{pulls.length} pulls · same sample</small></div>
    <div className="lq-pulse-note" title="Values are the priced quote sides of the latest observed events, not market-wide volume. Unknown prices are excluded."><Icon name="activity" size={14} /><span>{span} priced sample<br /><b>Latest {events.length || '—'} events</b></span></div>
  </section>
}

function TokenSpotlight({ token }: { token: TokenSummary }) {
  const label = token.symbol || short(token.address)
  return <section className="lq-token-spotlight"><div className="lq-spotlight-label"><span><i />IN THE FLOW</span><span>Trending on Solana</span></div><div className="lq-spotlight-content"><AppLink href={`/token/${token.chain}/${token.address}`} className="lq-spotlight-token"><Avatar image={token.image} label={label} size={55} /><div><h2>{label}</h2><p>{token.name || short(token.address)}</p></div></AppLink><div className="lq-spotlight-facts"><span><strong>{token.lpWallets.toLocaleString()}</strong>LP wallets</span><span><strong>{token.fundedPools}</strong>funded pools</span></div><div className="lq-spotlight-actions"><AppLink href={`/swap?out=${token.address}`} className="lq-button lq-button-primary">Trade <Icon name="arrow" size={14} /></AppLink><AppLink href={`/swap?mode=liquidity&out=${token.address}`} className="lq-button">Earn <Icon name="earn" size={14} /></AppLink></div></div></section>
}

export function EarnInvitation() {
  return <section className="lq-earn-invitation"><div className="lq-earn-art" aria-hidden="true"><svg width="100" height="90" viewBox="0 0 100 90" fill="none"><path d="m50 10 34 18v34L50 80 16 62V28L50 10Z" stroke="currentColor" strokeOpacity=".3" /><path d="m50 25 21 12v22L50 71 29 59V37l21-12Z" stroke="currentColor" strokeOpacity=".6" /><path d="m50 40 8 5v9l-8 5-8-5v-9l8-5Z" fill="currentColor" /><path d="M50 10v15m34 3L71 37M16 62l13-3M50 80v-9" stroke="currentColor" /></svg></div><div><div className="lq-eyebrow">Less setup. More possibility.</div><h2>One amount. A liquidity position.</h2><p>Pick a token, enter SOL. FTL finds the pool and handles the route.</p></div><AppLink href="/swap?mode=liquidity" className="lq-button lq-button-primary">Explore Earn <Icon name="arrow" size={15} /></AppLink></section>
}

export function LeadersPreview() {
  const resource = useLiveResource<WalletSummary[]>('/api/leaderboard/wallets?min=2', 30_000, true)
  return <section className="lq-panel lq-leaders-preview"><header className="lq-panel-header"><h2><Icon name="trophy" size={16} />Early, on record</h2><AppLink href="/leaders" className="lq-text-link" label="See the leaderboard"><Icon name="arrow" size={15} /></AppLink></header><p className="lq-panel-caption">Top wallets by tokens that graduated.</p>
    {resource.error && !resource.data ? <Notice onRetry={() => void resource.refresh()}>The board is reconnecting.</Notice> : null}
    {!resource.data && resource.loading ? <RowSkeleton rows={3} /> : resource.data?.slice(0, 3).map((wallet, index) => <div className="lq-mini-leader" key={`${wallet.chain}:${wallet.address}`}><span className={`lq-medal lq-medal-${index}`}>{index + 1}</span><AppLink href={`/wallet/${wallet.chain}/${wallet.address}`}><strong>{wallet.label || short(wallet.address)}</strong><small>{wallet.tokens} early entries <span>· {pct(wallet.hitRate)} hit rate</span></small></AppLink><span className="lq-leader-hits">{wallet.hits}<small>grads</small></span><FollowButton kind="wallet" chain={wallet.chain} address={wallet.address} compact /></div>)}
    {resource.data?.length === 0 ? <Placeholder title="The board is taking shape" body="Wallets qualify after two early token entries." /> : null}
    <footer className="lq-panel-footer"><AppLink href="/leaders" className="lq-text-link">Meet the leaderboard <Icon name="arrow" size={13} /></AppLink><span>On-chain records</span></footer>
  </section>
}

export function CallsRoom() {
  const live = useLive()
  const now = useNow(5000)
  const resource = useLiveResource<Post[]>('/api/posts?kind=call&limit=20', 30_000)
  const posts = useMemo(() => {
    const result = new Map((resource.data ?? []).map(post => [post.id, post]))
    for (const post of live.posts) if (post.kind === 'call') result.set(post.id, post)
    return [...result.values()].sort((a, b) => b.ts - a.ts).slice(0, 25)
  }, [resource.data, live.posts])
  return <div className="lq-calls-room"><header><div><h2>Calls with receipts.</h2><p>Call a token before it graduates. Build a track record.</p></div><LiveBadge /></header>{resource.error ? <Notice onRetry={() => void resource.refresh()}>Calls could not refresh.</Notice> : null}{!resource.data && resource.loading && !posts.length ? <RowSkeleton rows={3} /> : posts.map(post => <PostItem key={post.id} p={post} now={now} showToken />)}{!posts.length && !resource.loading ? <Placeholder title="Be the first to call it" body="Open a token and share what you see. Your call scores when it graduates." action={<AppLink href="/signals" className="lq-button">Find a token <Icon name="arrow" size={14} /></AppLink>} /> : null}</div>
}
