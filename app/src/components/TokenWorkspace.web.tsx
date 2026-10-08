import { useMemo, useState } from 'react'
import { useLocalSearchParams } from 'expo-router'
import { useLive } from '@/lib/live'
import { useLiveResource } from '@/lib/use-live-resource'
import { useSocial } from '@/lib/social'
import { useNow } from '@/lib/useNow'
import { activityBuckets, recentEvents } from '@/lib/market-model'
import { eventContext } from '@/lib/event-context'
import { ago, short, venue } from '@/lib/format'
import { liquidityLink, parseSwapLink } from '@/lib/swap-link'
import type { Chain, FlowEvent, PoolSummary, Post, ResearchCoinDetail, TokenSummary, WalletSummary } from '@/lib/types'
import { FLAG } from '@/theme'
import { Trade } from './Trade'
import SwapTerminal from './SwapTerminal.web'
import { Composer, PostItem } from './Posts'
import { ResearchReport } from './Research'
import { PoolYield } from './PoolYield.web'
import { ActivityFeed } from './ActivityFeed.web'
import { AppLink, Avatar, Choice, FollowButton, Icon, LiveBadge, Notice, Placeholder, RowSkeleton, useToast } from './MarketUI.web'

type Page = { token: TokenSummary; pools: PoolSummary[]; events: FlowEvent[]; wallets: WalletSummary[]; posts: Post[] }

export default function TokenWorkspace() {
  const { chain, address, event: eventId, action } = useLocalSearchParams<{ chain: Chain; address: string; event?: string; action?: string }>()
  const social = useSocial()
  const live = useLive()
  const now = useNow(3000)
  const toast = useToast()
  const [tab, setTab] = useState<'activity' | 'room' | 'pools' | 'research'>('activity')
  const [posted, setPosted] = useState<Post[]>([])
  const page = useLiveResource<Page>(`/api/token/${chain}/${address}${social.pubkey ? `?viewer=${social.pubkey}` : ''}`, 20_000, true)
  const origin = useLiveResource<FlowEvent>(eventId ? `/api/event/${encodeURIComponent(eventId)}` : null, 120_000)
  const events = useMemo(() => recentEvents([...(page.data?.events ?? []), ...live.events]).filter(event => event.chain === chain && event.token === address), [page.data?.events, live.events, chain, address])
  const posts = useMemo(() => {
    const byId = new Map([...(page.data?.posts ?? []), ...live.posts, ...posted].filter(post => post.chain === chain && post.token === address).map(post => [post.id, post]))
    return [...byId.values()].sort((a, b) => b.ts - a.ts)
  }, [page.data?.posts, live.posts, posted, chain, address])
  const tokenUpdate = live.tokens.get(`${chain}:${address}`)
  const token = page.data?.token ? { ...page.data.token, ...(tokenUpdate && tokenUpdate.lastTs >= page.data.token.lastTs ? tokenUpdate : {}) } : null
  if (!token || !page.data) return <div className="lq-page"><div className="lq-page-inner"><AppLink href="/" className="lq-back-link">← Discover</AppLink>{page.error ? <Placeholder title="Token details unavailable" body={page.error} action={<><button type="button" className="lq-button" onClick={() => void page.refresh()}>Try again</button>{chain === 'solana' ? <AppLink href={`/swap?out=${address}`} className="lq-button lq-button-primary">Open trade <Icon name="arrow" size={14} /></AppLink> : null}</>} /> : <RowSkeleton rows={7} />}</div></div>
  const label = token.symbol || short(token.address)
  const context = events.find(event => event.id === eventId) ?? eventContext(eventId, chain, address) ?? (origin.data?.id === eventId && origin.data?.chain === chain && origin.data?.token === address ? origin.data : null)
  const tradeAction = action === 'exit' ? 'exit' : action === 'sell' ? 'sell' : action === 'liquidity' || eventId ? 'liquidity' : undefined
  const initial = parseSwapLink({ in: tradeAction === 'sell' ? address : 'SOL', out: tradeAction === 'sell' ? 'SOL' : address, mode: tradeAction === 'exit' || tradeAction === 'liquidity' ? 'liquidity' : 'swap', action: tradeAction === 'exit' ? 'exit' : undefined, pool: context?.pool ?? undefined })
  const copy = async () => { try { await navigator.clipboard.writeText(address); toast('Token address copied') } catch { toast('Could not copy. Select the address in token details.', true) } }
  return <div className="lq-page lq-token-page"><div className="lq-page-inner">
    <div className="lq-token-breadcrumb"><AppLink href="/" className="lq-back-link">Discover</AppLink><Icon name="chevron" size={11} /><span>{label}</span><LiveBadge /></div>
    <header className="lq-token-header"><Avatar image={token.image || (address.toLowerCase() === '0xb051d6c1feb3e43b67a0a2b2aa7e0caa536614c4' ? 'https://www.liquidityxyz.fun/liquidityxyz-token.png' : undefined)} label={label} size={62} chain={chain} /><div><div className="lq-token-title"><h1>{label}</h1>{token.graduatedTs ? <span className="lq-graduated-badge">Graduated <Icon name="check" size={12} /></span> : token.launchedTs ? <span className="lq-curve-badge">On the curve</span> : null}</div><p>{token.name || (chain === 'solana' ? 'Solana token' : 'Robinhood token')}</p><button type="button" className="lq-copy-address" onClick={() => void copy()} aria-label="Copy token address">{chain === 'solana' ? 'SOL' : 'RH'}<i />{short(address, 5)}<Icon name="copy" size={12} /></button></div><div className="lq-token-header-actions"><FollowButton kind="token" chain={chain} address={address} /><button type="button" className="lq-button lq-mobile-trade-jump" onClick={() => document.getElementById('token-trade')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' })}>Trade <Icon name="arrow" size={14} /></button></div></header>
    <section className="lq-token-stats" aria-label="Token activity"><div><span>Activity score</span><strong className="lq-positive">{Math.round(token.score).toLocaleString()}</strong></div><div><span>Liquidity providers</span><strong>{token.lpWallets.toLocaleString()}</strong></div><div><span>Funded pools</span><strong>{token.fundedPools}<small> / {token.pools}</small></strong></div><div><span>{token.launchedTs ? 'Launched' : 'First pool'}</span><strong>{token.launchedTs || token.firstPoolTs ? `${ago((token.launchedTs || token.firstPoolTs)!, now)} ago` : '—'}</strong></div></section>
    {page.error ? <Notice onRetry={() => void page.refresh()}>Showing the last snapshot with live updates. Background refresh is reconnecting.</Notice> : null}
    <div className="lq-token-layout"><div className="lq-token-main">
      <LiquidityChart events={events} />
      {token.flags.filter(flag => flag !== 'first_pool').length ? <details className="lq-token-signals"><summary><Icon name="signal" size={15} />{token.flags.filter(flag => flag !== 'first_pool').length} on-chain signals{token.flags.includes('honeypot_fee') ? <span>High-fee pools detected</span> : null}<Icon name="chevron" size={13} /></summary><div>{token.flags.filter(flag => flag !== 'first_pool').map(flag => <p key={flag}><strong style={{ color: FLAG[flag].color }}>{FLAG[flag].label}</strong>{FLAG[flag].about}</p>)}</div></details> : null}
      <section className="lq-panel lq-token-details"><div className="lq-discovery-tabs">{([{ value: 'activity', label: 'Activity' }, { value: 'room', label: `The room ${posts.length || ''}` }, { value: 'pools', label: `Pools ${page.data.pools.length}` }, { value: 'research', label: 'Research' }] as const).map(item => <button type="button" key={item.value} aria-pressed={tab === item.value} className={tab === item.value ? 'is-active' : ''} onClick={() => setTab(item.value)}>{item.label}</button>)}</div>
        {tab === 'activity' ? <ActivityFeed events={events} chain={chain} token={address} title="Token activity" limit={45} /> : tab === 'room' ? <div className="lq-token-room"><Composer chain={chain} token={address} graduated={!!token.graduatedTs} onPosted={post => { setPosted(previous => [post, ...previous]); toast('Your call is in the room') }} />{posts.map(post => <PostItem key={post.id} p={post} now={now} />)}{!posts.length ? <Placeholder title="You’re early to the conversation" body="Share what you see. Calls posted before graduation can build your track record." /> : null}</div>
          : tab === 'pools' ? <div className="lq-token-pools">{page.data.pools.map(pool => <PoolRow key={pool.address} pool={pool} token={token} />)}{!page.data.pools.length ? <Placeholder title="Watching for a pool" body="Pools appear as the chain detects them." /> : null}</div>
            : <TokenResearch chain={chain} address={address} />}
      </section>
      {page.data.wallets.length ? <section className="lq-panel"><header className="lq-panel-header"><h2>Who’s in the liquidity</h2><span className="lq-eyebrow">{page.data.wallets.length} wallets</span></header><div className="lq-token-wallets">{page.data.wallets.slice(0, 6).map(wallet => <div key={wallet.address}><AppLink href={`/wallet/${chain}/${wallet.address}`}><Avatar label={wallet.address.slice(-2)} size={28} /><span>{wallet.label || short(wallet.address)}</span></AppLink><FollowButton kind="wallet" chain={chain} address={wallet.address} compact /></div>)}</div></section> : null}
      <details className="lq-token-about"><summary>About {label}<Icon name="chevron" size={12} /></summary>{token.description ? <p>{token.description}</p> : null}<p className="lq-contract-address">{address}</p><div>{token.website ? <a href={/^https?:/.test(token.website) ? token.website : `https://${token.website}`} target="_blank" rel="noreferrer">Website ↗</a> : null}{token.twitter ? <a href={/^https?:/.test(token.twitter) ? token.twitter : `https://x.com/${token.twitter.replace(/^@/, '')}`} target="_blank" rel="noreferrer">Twitter / X ↗</a> : null}</div></details>
    </div><aside className="lq-token-trade" id="token-trade">
      <div className="lq-trade-heading"><span className="lq-eyebrow">Make your move</span><LiveBadge /></div>
      {context ? <OriginMove event={context} /> : null}
      {chain === 'solana' ? <div className="lq-terminal-surface"><SwapTerminal key={`${JSON.stringify(initial)}:${eventId ?? ''}`} initial={initial} /></div> : <Trade key={`${chain}:${address}:${eventId ?? ''}:${tradeAction ?? ''}`} t={token} pools={page.data.pools} origin={context} initialAction={tradeAction} />}
      <div className="lq-token-trade-foot"><Icon name="wallet" size={14} />Your wallet stays in control.</div>
      {chain === 'solana' ? <AppLink href={`/swap?out=${address}`} className="lq-terminal-link">Open full trading workspace <Icon name="external" size={13} /></AppLink> : null}
    </aside></div>
  </div></div>
}

function OriginMove({ event }: { event: FlowEvent }) {
  const toast = useToast()
  return <div className="lq-origin-move"><Icon name="activity" size={14} /><span>From {event.kind === 'liq_remove' ? 'a liquidity pull' : event.kind === 'liq_add' ? 'a liquidity add' : 'an on-chain move'} · {event.stage}</span>{event.chain === 'solana'
    ? <a href={`https://solscan.io/tx/${event.tx}`} target="_blank" rel="noreferrer" aria-label="View originating transaction"><Icon name="external" size={13} /></a>
    : <button type="button" className="lq-icon-button" aria-label="Copy originating transaction" onClick={async () => { try { await navigator.clipboard.writeText(event.tx); toast('Transaction hash copied') } catch { toast('Could not copy transaction hash.', true) } }}><Icon name="copy" size={13} /></button>}</div>
}

export function LiquidityChart({ events }: { events: FlowEvent[] }) {
  const now = useNow(3000)
  const [window, setWindow] = useState<'5m' | '1h'>('5m')
  const to = Math.ceil(now / 10_000) * 10_000
  const from = to - (window === '5m' ? 300_000 : 3600_000)
  const buckets = activityBuckets(events, from, to, 40)
  const incoming = buckets.reduce((total, bucket) => total + bucket.incoming, 0)
  const outgoing = buckets.reduce((total, bucket) => total + bucket.outgoing, 0)
  const max = Math.max(1, ...buckets.map(bucket => Math.max(bucket.incoming, bucket.outgoing)))
  return <section className="lq-panel lq-liquidity-chart"><header><div><h2>Liquidity pulse</h2><p>Confirmed adds, pool births & pulls in the observed feed</p></div><Choice value={window} onChange={setWindow} options={[{ value: '5m', label: '5m' }, { value: '1h', label: '1h' }]} label="Activity chart timeframe" /></header><div className="lq-chart-legend"><span><i />{incoming} adds & pools</span><span><i />{outgoing} pulls</span><LiveBadge /></div><div className="lq-chart-canvas" role="img" aria-label={`${incoming} observed adds and pool births and ${outgoing} pulls over ${window === '5m' ? '5 minutes' : '1 hour'}`}><div className="lq-chart-guide"><span>{max}</span><span>0</span><span>{max}</span></div><div className="lq-chart-bars">{buckets.map((bucket, index) => <div key={index} title={`${new Date(bucket.ts).toLocaleTimeString()} · ${bucket.incoming} adds/pools · ${bucket.outgoing} pulls`}><span><i style={{ height: `${bucket.incoming / max * 100}%` }} /></span><span><i style={{ height: `${bucket.outgoing / max * 100}%` }} /></span></div>)}</div></div><div className="lq-chart-axis"><span>{new Date(from).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><span>Observed liquidity events · not price</span><span>Now</span></div></section>
}

function PoolRow({ pool, token }: { pool: PoolSummary; token: TokenSummary }) {
  const [expanded, setExpanded] = useState(false)
  return <div className="lq-pool-row"><div><span className={`lq-pool-status ${pool.funded ? 'is-funded' : ''}`} /><strong>{venue(pool.venue)}</strong><small>{pool.feeBps !== null ? `${(pool.feeBps / 100).toFixed(2)}% pool fee` : 'Fee unavailable'}</small><span className="lq-pool-funded">{pool.funded ? 'Funded' : 'Empty'}</span></div><div className="lq-pool-actions"><button type="button" className="lq-text-button" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>{expanded ? 'Hide details' : 'Pool details'}<Icon name="chevron" size={12} /></button>{token.chain === 'solana' ? <AppLink href={liquidityLink(token.address, pool.address)} className="lq-button lq-button-sm">Earn <Icon name="arrow" size={12} /></AppLink> : null}</div>{expanded ? <div className="lq-pool-expanded"><p>{pool.address}</p>{pool.chain === 'solana' ? <PoolYield venue={pool.venue} pool={pool.address} /> : <p>{pool.liqEvents} observed liquidity moves</p>}</div> : null}</div>
}

function TokenResearch({ chain, address }: { chain: Chain; address: string }) {
  const resource = useLiveResource<ResearchCoinDetail>(`/api/research/${chain}/${address}`, 30_000)
  return resource.data ? <div className="lq-token-research"><ResearchReport coin={resource.data} /><AppLink href={`/research/${chain}/${address}`} className="lq-text-link">Full research report <Icon name="arrow" size={14} /></AppLink></div> : resource.loading ? <RowSkeleton rows={4} /> : <Placeholder title="Research is catching up" body="Source coverage and on-chain history appear as they become available." action={<button type="button" className="lq-button" onClick={() => void resource.refresh()}>Check again</button>} />
}
