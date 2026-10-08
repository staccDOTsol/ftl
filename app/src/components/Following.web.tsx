import { useMemo, useState } from 'react'
import { useLive } from '@/lib/live'
import { useLiveResource } from '@/lib/use-live-resource'
import { useSocial } from '@/lib/social'
import { useNow } from '@/lib/useNow'
import { short } from '@/lib/format'
import { recentEvents } from '@/lib/market-model'
import type { FlowEvent, Post } from '@/lib/types'
import { ActivityFeed } from './ActivityFeed.web'
import { LeadersPreview } from './Discover.web'
import { PostItem } from './Posts'
import { AppLink, Avatar, Choice, FollowButton, Icon, LiveBadge, Notice, Placeholder } from './MarketUI.web'

export default function Following() {
  const social = useSocial()
  return <div className="lq-page"><div className="lq-page-inner"><header className="lq-page-heading"><div><div className="lq-eyebrow">Your people. Your signals.</div><h1>A feed with your fingerprints.</h1><p>Every move from the wallets, tokens, and callers you follow.</p></div><AppLink href="/leaders" className="lq-button"><Icon name="plus" size={14} />Find your people</AppLink></header><div className="lq-market-layout"><div>{social.pubkey ? <PersonalFeed pubkey={social.pubkey} /> : <Placeholder title="Getting your feed ready…" busy />}</div><aside className="lq-market-rail"><LeadersPreview /><section className="lq-watchlist-note"><Icon name="bell" size={22} /><h2>Good signals find you.</h2><p>Follow with one tap. Your feed updates as their transactions hit the chain.</p><AppLink href="/me" className="lq-text-link">Set up alerts <Icon name="arrow" size={14} /></AppLink></section></aside></div></div></div>
}

function PersonalFeed({ pubkey }: { pubkey: string }) {
  const social = useSocial()
  const live = useLive()
  const now = useNow(3000)
  const [tab, setTab] = useState<'moves' | 'calls' | 'list'>('moves')
  // Include follow count in the request key so new follows immediately hydrate
  // their history; WebSocket rows provide the ongoing stream without polling it.
  const follows = social.follows
  const events = useLiveResource<FlowEvent[]>(`/api/feed?as=${pubkey}&limit=150&v=${follows.length}`, 30_000)
  const posts = useLiveResource<Post[]>(`/api/posts?viewer=${pubkey}&following=${pubkey}&kind=call&v=${follows.length}`, 30_000)
  const shownEvents = useMemo(() => {
    const targets = new Set(follows.filter(follow => follow.kind !== 'user').map(follow => `${follow.kind}:${follow.chain}:${follow.address}`))
    return recentEvents([...(events.data ?? []), ...live.events]).filter(event => targets.has(`wallet:${event.chain}:${event.wallet}`) || targets.has(`token:${event.chain}:${event.token}`))
  }, [events.data, live.events, follows])
  const shownPosts = useMemo(() => {
    const people = new Set(follows.filter(follow => follow.kind === 'user').map(follow => follow.address))
    const byId = new Map((posts.data ?? []).map(post => [post.id, post]))
    for (const post of live.posts) if (post.kind === 'call' && (people.has(post.author.pubkey) || post.author.pubkey === pubkey)) byId.set(post.id, post)
    return [...byId.values()].filter(post => people.has(post.author.pubkey) || post.author.pubkey === pubkey).sort((a, b) => b.ts - a.ts)
  }, [posts.data, live.posts, follows, pubkey])
  return <section className="lq-panel lq-personal-feed"><div className="lq-personal-toolbar"><Choice label="Your feed" value={tab} onChange={setTab} options={[{ value: 'moves', label: 'Their moves', icon: 'activity' }, { value: 'calls', label: 'Calls', icon: 'users' }, { value: 'list', label: `Following ${follows.length}` }]} /><LiveBadge /></div>
    {!follows.length ? <div className="lq-follow-start"><span className="lq-follow-start-mark"><Icon name="users" size={34} /></span><div className="lq-eyebrow">Make the feed yours</div><h2>Follow the wallets.<br />Catch the next move.</h2><p>Start with an early liquidity provider on the leaderboard, or follow a token you’re watching. Their next moves land here.</p><AppLink href="/leaders" className="lq-button lq-button-primary">Find a wallet to follow <Icon name="arrow" size={15} /></AppLink></div>
      : tab === 'moves' ? <>{events.error ? <Notice onRetry={() => void events.refresh()}>History could not refresh. New matching moves still stream here.</Notice> : null}<ActivityFeed events={shownEvents} limit={100} title="Your live feed" /></>
        : tab === 'calls' ? <>{posts.error ? <Notice onRetry={() => void posts.refresh()}>Calls could not refresh.</Notice> : null}{shownPosts.map(post => <PostItem key={post.id} p={post} now={now} showToken />)}{!shownPosts.length ? <Placeholder title="Your circle’s next call lands here" body="Follow a caller from the leaderboard or from a token’s conversation." action={<AppLink href="/leaders" className="lq-text-link">Find callers <Icon name="arrow" size={14} /></AppLink>} /> : null}</>
          : <div className="lq-follow-list">{follows.map(follow => <div key={`${follow.kind}:${follow.chain}:${follow.address}`}><Avatar label={follow.address.slice(-2)} chain={follow.kind !== 'user' ? follow.chain : undefined} size={38} /><AppLink href={follow.kind === 'user' ? `/profile/${follow.address}` : `/${follow.kind}/${follow.chain}/${follow.address}`}><strong>{short(follow.address, 6)}</strong><small>{follow.kind === 'user' ? 'Caller' : `${follow.chain === 'solana' ? 'Solana' : 'Robinhood'} ${follow.kind}`}</small></AppLink><FollowButton kind={follow.kind} chain={follow.chain} address={follow.address} /></div>)}</div>}
  </section>
}
