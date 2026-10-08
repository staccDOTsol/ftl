import { useMemo } from 'react'
import { router, useLocalSearchParams } from 'expo-router'
import { parseSwapLink } from '@/lib/swap-link'
import { useLiveResource } from '@/lib/use-live-resource'
import { useLive } from '@/lib/live'
import { useTokenMeta } from '@/lib/token-meta'
import { short } from '@/lib/format'
import type { TokenSummary } from '@/lib/types'
import SwapTerminal from './SwapTerminal.web'
import { ActivityFeed } from './ActivityFeed.web'
import { AppLink, Avatar, Icon, LiveBadge, Notice, RowSkeleton } from './MarketUI.web'

export default function TradeWorkspace() {
  const params = useLocalSearchParams<{ in?: string; out?: string; amount?: string; mode?: string; pool?: string; action?: string; advanced?: string }>()
  // Keep every supported parameter, including Fable's pool/exit/advanced links.
  const initial = useMemo(() => parseSwapLink(params), [params])
  const key = JSON.stringify(initial)
  const earn = initial.mode === 'liquidity'
  const live = useLive()
  const tokens = useLiveResource<TokenSummary[]>('/api/tokens/hot?chain=solana&hours=12&limit=12', 30_000)
  const meta = useTokenMeta([initial.outputMint])
  const selected = initial.outputMint ? live.tokens.get(`solana:${initial.outputMint}`) ?? tokens.data?.find(token => token.address === initial.outputMint) : null
  const name = selected?.symbol || (initial.outputMint ? meta[initial.outputMint]?.symbol : null)
  return <div className="lq-page lq-trade-page"><div className="lq-page-inner">
    <header className="lq-page-heading"><div><div className="lq-eyebrow"><Icon name={earn ? 'earn' : 'swap'} size={14} />{earn ? 'Put your liquidity to work' : 'From signal to on-chain'}</div><h1>{earn ? 'Less setup. More flow.' : 'See it. Make your move.'}</h1><p>{earn ? 'One amount in. FTL finds the pool and builds your route.' : 'Choose your tokens. Get a live quote. Your wallet handles the rest.'}</p></div><AppLink href="/holdings" className="lq-button"><Icon name="wallet" size={14} />Your portfolio</AppLink></header>
    <div className="lq-trade-layout">
      <aside className="lq-trade-radar"><div className="lq-radar-heading"><h2>On the radar</h2><LiveBadge /></div><p>Active Solana tokens · 12h</p>{tokens.error ? <Notice onRetry={() => void tokens.refresh()}>Could not refresh tokens.</Notice> : null}{tokens.data === null && tokens.loading ? <RowSkeleton rows={5} /> : tokens.data?.slice(0, 8).map((token, index) => <AppLink key={token.address} href={earn ? `/swap?mode=liquidity&out=${token.address}` : `/swap?out=${token.address}`} className={`lq-radar-token ${token.address === initial.outputMint ? 'is-selected' : ''}`}><span>{String(index + 1).padStart(2, '0')}</span><Avatar image={token.image} label={token.symbol || short(token.address)} size={31} /><span><strong>{token.symbol || short(token.address)}</strong><small>{token.lpWallets} LPs · {token.fundedPools} funded pools</small></span><Icon name="arrow" size={13} /></AppLink>)}<AppLink href="/signals" className="lq-text-link">Explore every signal <Icon name="arrow" size={13} /></AppLink><div className="lq-route-principle"><span className="lq-eyebrow">You choose the outcome</span><h3>We handle the route.</h3><p>{earn ? 'Pool selection, token splits, and deposit steps come together in one guided flow.' : 'FTL compares available routes and refreshes your quote automatically.'}</p><div><Icon name="check" size={13} />Preview before signing</div><div><Icon name="check" size={13} />On-chain confirmation</div><div><Icon name="check" size={13} />Your keys, your control</div></div></aside>
      <section className="lq-terminal-column" aria-label={earn ? 'Earn liquidity' : 'Swap tokens'}><div className="lq-terminal-topline"><span><i className="lq-chain-dot solana" />Solana</span><span>Powered by FTL routing</span></div><div className="lq-terminal-surface"><SwapTerminal key={key} initial={initial} onModeChange={next => router.setParams({ in: next.inputMint, out: next.outputMint ?? '', amount: next.amount, mode: next.mode, pool: next.pool ?? '', action: next.action ?? '', advanced: next.advanced ? '1' : '' })} /></div><div className="lq-terminal-reassurance"><Icon name="wallet" size={14} /><span>Review the quote. Approve in your wallet.</span></div>{selected ? <div className="lq-selected-context"><AppLink href={`/token/solana/${selected.address}`}><Avatar image={selected.image} label={selected.symbol || short(selected.address)} size={32} /><span><strong>{name || short(selected.address)}</strong><small>View activity, pools & the conversation</small></span><Icon name="arrow" size={15} /></AppLink></div> : null}</section>
      <aside className="lq-trade-live"><ActivityFeed chain="solana" token={initial.outputMint ?? undefined} compact limit={8} title={name ? `${name} activity` : 'Live on Solana'} /><section className="lq-trade-next"><span className="lq-eyebrow">Keep the loop moving</span><h3>{earn ? 'Your positions, in one place.' : 'Found your token? Put it to work.'}</h3><p>{earn ? 'Check holdings, find an exit, or add to a position from your portfolio.' : 'Explore liquidity provision with automatic pool selection and SOL deposits.'}</p><AppLink href={earn ? '/holdings' : `/swap?mode=liquidity${initial.outputMint ? `&out=${initial.outputMint}` : ''}`} className="lq-text-link">{earn ? 'Open portfolio' : 'Explore Earn'} <Icon name="arrow" size={14} /></AppLink></section></aside>
    </div>
  </div></div>
}
