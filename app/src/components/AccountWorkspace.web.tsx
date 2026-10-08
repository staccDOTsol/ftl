import { useMemo, useState } from 'react'
import { useLocalSearchParams } from 'expo-router'
import { useLive } from '@/lib/live'
import { useLiveResource } from '@/lib/use-live-resource'
import { useNow } from '@/lib/useNow'
import { useSocial } from '@/lib/social'
import { ago, pct, short } from '@/lib/format'
import { recentEvents } from '@/lib/market-model'
import type { Chain, FlowEvent, Post, Profile, TokenSummary, WalletSummary } from '@/lib/types'
import { ActivityFeed } from './ActivityFeed.web'
import { PostItem } from './Posts'
import { AppLink, Avatar, Choice, FollowButton, Icon, LiveBadge, Notice, Placeholder, RowSkeleton, useToast } from './MarketUI.web'

type WalletPage = { wallet: WalletSummary; events: FlowEvent[]; tokens: (TokenSummary & { touchedTs: number; hit: boolean })[] }

export function WalletWorkspace() {
  const { chain, address } = useLocalSearchParams<{ chain: Chain; address: string }>()
  const resource = useLiveResource<WalletPage>(`/api/wallet/${chain}/${address}`, 30_000, true)
  const live = useLive()
  const now = useNow(5000)
  const toast = useToast()
  const [tab, setTab] = useState<'tokens' | 'moves'>('tokens')
  const events = useMemo(() => recentEvents([...(resource.data?.events ?? []), ...live.events]).filter(event => event.chain === chain && event.wallet === address), [resource.data?.events, live.events, chain, address])
  const wallet = resource.data?.wallet
  return <div className="lq-page lq-account-page"><div className="lq-page-inner"><div className="lq-token-breadcrumb"><AppLink href="/leaders" className="lq-back-link">Leaderboard</AppLink><Icon name="chevron" size={11} /><span>Wallet</span><LiveBadge /></div>
    {!wallet ? resource.error ? <Placeholder title="Wallet history unavailable" body={resource.error} action={<button type="button" className="lq-button" onClick={() => void resource.refresh()}>Try again</button>} /> : <RowSkeleton rows={6} /> : <>
      <header className="lq-account-header"><Avatar label={wallet.address.slice(-2)} chain={chain} size={64} /><div><div className="lq-eyebrow">{chain === 'solana' ? 'Solana' : 'Robinhood Chain'} · liquidity provider</div><h1>{wallet.label || short(address, 6)}</h1><button type="button" className="lq-copy-address" onClick={async () => { try { await navigator.clipboard.writeText(address); toast('Wallet address copied') } catch { toast('Could not copy wallet address.', true) } }}>{short(address, 8)}<Icon name="copy" size={12} /></button></div><div className="lq-account-header-actions"><FollowButton kind="wallet" chain={chain} address={address} />{chain === 'solana' ? <AppLink href={`/holdings?owner=${address}`} className="lq-button"><Icon name="wallet" size={14} />View holdings</AppLink> : null}</div></header>
      <section className="lq-token-stats"><div><span>Graduation hits</span><strong className="lq-positive">{wallet.hits}</strong></div><div><span>Early token entries</span><strong>{wallet.tokens}</strong></div><div><span>Hit rate</span><strong>{wallet.tokens ? pct(wallet.hitRate) : '—'}</strong></div><div><span>Latest move</span><strong>{ago(wallet.lastTs, now)} ago</strong></div></section>
      {resource.error ? <Notice onRetry={() => void resource.refresh()}>History refresh is reconnecting. Live moves continue below.</Notice> : null}
      <div className="lq-market-layout"><section className="lq-panel lq-wallet-record"><div className="lq-personal-toolbar"><Choice label="Wallet record" value={tab} onChange={setTab} options={[{ value: 'tokens', label: 'Early entries' }, { value: 'moves', label: 'Liquidity moves' }]} /><span className="lq-eyebrow">On-chain record</span></div>
        {tab === 'moves' ? <ActivityFeed events={events} limit={100} title="Wallet activity" /> : <>{resource.data!.tokens.map(token => <div className="lq-wallet-token" key={token.address}><AppLink href={`/token/${chain}/${token.address}`}><Avatar image={token.image} label={token.symbol || short(token.address)} size={37} chain={chain} /><span><strong>{token.symbol || short(token.address)}</strong><small>Entered {ago(token.touchedTs, now)} ago</small></span></AppLink><span className={token.hit ? 'lq-positive' : 'lq-muted'}>{token.hit ? 'Graduated ↗' : 'Not graduated'}</span><FollowButton kind="token" chain={chain} address={token.address} compact /></div>)}{!resource.data!.tokens.length ? <Placeholder title="Watching for early entries" body="Tokens appear here when this wallet supplies liquidity before graduation." /> : null}</>}
      </section><aside className="lq-market-rail"><section className="lq-board-explainer"><div className="lq-eyebrow">The liquidity trail</div><h2>Actions tell the story.</h2><dl><div><dt>{wallet.inits.toLocaleString()} pools opened</dt><dd>New pools initialized by this wallet.</dd></div><div><dt>{wallet.adds.toLocaleString()} liquidity adds</dt><dd>Observed deposits into pools.</dd></div><div><dt>{wallet.removes.toLocaleString()} liquidity pulls</dt><dd>Observed withdrawals from pools.</dd></div></dl><p>First seen {ago(wallet.firstTs, now)} ago. Activity does not measure trading returns.</p></section><ActivityFeed compact events={events} limit={5} title="Latest moves" /></aside></div>
    </>}
  </div></div>
}

type ProfilePage = { profile: Profile; follows: unknown[]; posts: Post[] }
export function ProfileWorkspace() {
  const { pubkey } = useLocalSearchParams<{ pubkey: string }>()
  const resource = useLiveResource<ProfilePage>(`/api/profile/${pubkey}`, 30_000)
  const live = useLive()
  const social = useSocial()
  const now = useNow(5000)
  const posts = useMemo(() => {
    const byId = new Map((resource.data?.posts ?? []).map(post => [post.id, post]))
    for (const post of live.posts) if (post.author.pubkey === pubkey) byId.set(post.id, post)
    return [...byId.values()].sort((a, b) => b.ts - a.ts)
  }, [resource.data?.posts, live.posts, pubkey])
  const profile = resource.data?.profile
  const calls = posts.filter(post => post.kind === 'call')
  const hits = calls.filter(post => post.hit === true).length
  const name = profile?.handle ? `@${profile.handle}` : short(pubkey, 6)
  return <div className="lq-page lq-account-page"><div className="lq-page-inner"><div className="lq-token-breadcrumb"><AppLink href="/leaders" className="lq-back-link">Leaderboard</AppLink><Icon name="chevron" size={11} /><span>Caller</span><LiveBadge /></div>
    {!profile ? resource.error ? <Placeholder title="Profile unavailable" body={resource.error} action={<button type="button" className="lq-button" onClick={() => void resource.refresh()}>Try again</button>} /> : <RowSkeleton rows={5} /> : <><header className="lq-account-header"><Avatar label={profile.handle || pubkey} size={64} /><div><div className="lq-eyebrow">A voice in the room</div><h1>{name}</h1><p>{profile.bio || `Joined ${ago(profile.createdTs, now)} ago`}</p></div>{pubkey !== social.pubkey ? <FollowButton kind="user" chain="solana" address={pubkey} /> : <AppLink href="/me" className="lq-button">Edit profile</AppLink>}</header><section className="lq-token-stats"><div><span>Calls posted</span><strong>{calls.length}</strong></div><div><span>Graduation hits</span><strong className="lq-positive">{hits}</strong></div><div><span>Following</span><strong>{resource.data!.follows.length}</strong></div><div><span>In the room</span><strong>{posts.length}<small> posts</small></strong></div></section>{resource.error ? <Notice onRetry={() => void resource.refresh()}>The profile could not refresh. Showing the last snapshot.</Notice> : null}<div className="lq-market-layout"><section className="lq-panel"><header className="lq-panel-header"><h2>Calls & conversations</h2><LiveBadge /></header>{posts.map(post => <PostItem key={post.id} p={post} now={now} showToken />)}{!posts.length ? <Placeholder title="Their first call is still ahead" body="Follow this profile to see new calls as they arrive." /> : null}</section><aside className="lq-market-rail"><section className="lq-board-explainer"><div className="lq-eyebrow">Build a record of your own</div><h2>Have a read on the market?</h2><p style={{ marginTop: 16, marginBottom: 18, fontSize: 12 }}>Open a token, share your call before graduation, and let the chain keep score.</p><AppLink href="/signals" className="lq-button lq-button-primary">Find your next call <Icon name="arrow" size={14} /></AppLink></section></aside></div></>}
  </div></div>
}
