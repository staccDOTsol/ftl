import { useMemo, useState } from 'react'
import { useLive } from '@/lib/live'
import { ago, short, usd, usdOf, venue } from '@/lib/format'
import { eventLink } from '@/lib/event-context'
import { recentEvents, type MarketChain } from '@/lib/market-model'
import { useNow } from '@/lib/useNow'
import type { FlowEvent, Kind } from '@/lib/types'
import { KIND } from '@/theme'
import { AppLink, Avatar, Choice, Icon, LiveBadge, Placeholder } from './MarketUI.web'

type Filter = 'all' | 'in' | 'out' | 'new'
const matches = (kind: Kind, filter: Filter) => filter === 'all' || (filter === 'in' ? kind === 'liq_add' : filter === 'out' ? kind === 'liq_remove' : kind === 'pool_init' || kind === 'launch' || kind === 'graduate')

export function ActivityFeed({ chain = 'all', token, events, compact = false, limit = 12, title = 'Live activity', onExpand }: { chain?: MarketChain; token?: string; events?: FlowEvent[]; compact?: boolean; limit?: number; title?: string; onExpand?: () => void }) {
  const live = useLive()
  const now = useNow(1000)
  const [filter, setFilter] = useState<Filter>('all')
  const [paused, setPaused] = useState(false)
  const [hovering, setHovering] = useState(false)
  const [focused, setFocused] = useState(false)
  const [snapshot, setSnapshot] = useState<FlowEvent[]>([])
  const rows = useMemo(() => recentEvents(events ?? live.events, chain).filter(event => (!token || event.token === token) && matches(event.kind, filter)), [events, live.events, chain, token, filter])
  const frozen = paused || hovering || focused
  const visible = (frozen ? snapshot : rows).slice(0, limit)
  const newCount = frozen ? rows.filter(event => !snapshot.some(previous => previous.id === event.id)).length : 0
  function hold(kind: 'hover' | 'focus' | 'pause', value: boolean) {
    if (value && !frozen) setSnapshot(rows)
    if (kind === 'hover') setHovering(value)
    else if (kind === 'focus') setFocused(value)
    else setPaused(value)
  }
  return <section className={`lq-panel lq-activity ${compact ? 'is-compact' : ''}`} aria-label={title}>
    <header className="lq-panel-header"><h2><Icon name="activity" size={17} />{title}</h2><div className="lq-panel-header-actions"><LiveBadge compact /><button type="button" className="lq-icon-button" aria-label={paused ? 'Resume live activity' : 'Pause live activity'} aria-pressed={paused} onClick={() => hold('pause', !paused)} title={paused ? 'Resume live activity' : 'Pause live activity'}><Icon name={paused ? 'play' : 'pause'} size={13} /></button></div></header>
    <div className="lq-activity-controls"><Choice label="Activity type" value={filter} onChange={value => { setFilter(value); setPaused(false); setHovering(false); setFocused(false) }} options={[{ value: 'all', label: 'All' }, { value: 'in', label: 'Adds' }, { value: 'out', label: 'Pulls' }, { value: 'new', label: 'New' }]} />{!compact ? <span className="lq-activity-hint">{frozen ? `${newCount ? `${newCount} new · ` : ''}paused while reading` : 'Updates as moves arrive'}</span> : null}</div>
    <div className="lq-activity-list" onMouseEnter={() => hold('hover', true)} onMouseLeave={() => hold('hover', false)} onFocus={() => hold('focus', true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) hold('focus', false) }}>
      {visible.map(event => <ActivityItem key={event.id} event={event} now={now} compact={compact} prices={live.status?.prices} />)}
      {!visible.length ? <Placeholder title={!live.healthy && !events ? 'Reconnecting to the stream' : 'Watching for the next move'} body={!live.healthy && !events ? 'The feed will catch up automatically when the connection returns.' : 'Matching on-chain activity will appear here automatically.'} /> : null}
    </div>
    <footer className="lq-panel-footer"><span>{frozen ? `${newCount ? `${newCount} new · ` : ''}${paused ? 'Paused' : 'Held while reading'}` : 'Real moves. Straight from the chain.'}</span>{onExpand ? <button type="button" className="lq-text-button" onClick={onExpand}>Full feed <Icon name="arrow" size={13} /></button> : null}</footer>
  </section>
}

export function ActivityItem({ event, now, compact = false, prices }: { event: FlowEvent; now: number; compact?: boolean; prices?: Record<string, number> }) {
  const label = event.tokenMeta?.symbol || short(event.token)
  const amount = usdOf(event, prices)
  const incoming = event.kind !== 'liq_remove'
  const kind = event.kind === 'liq_add' ? 'Added liquidity' : event.kind === 'liq_remove' ? 'Pulled liquidity' : event.kind === 'pool_init' ? 'Opened a pool' : KIND[event.kind].label
  return <div className={`lq-activity-item ${!compact ? 'is-detailed' : ''} ${event.ts > now - 1800 ? 'is-fresh' : ''}`}>
    <Avatar image={event.tokenMeta?.image} label={label} size={compact ? 30 : 36} chain={event.chain} />
    <div className="lq-activity-main"><AppLink href={eventLink(event)} className="lq-activity-token" title={event.token ?? event.pool ?? event.wallet}>{label}<span className={`lq-kind-dot ${incoming ? 'is-in' : 'is-out'}`} /></AppLink><span className="lq-activity-sub">{kind}{!compact ? ` · ${venue(event.venue)}` : ''}</span></div>
    {!compact ? <AppLink href={`/wallet/${event.chain}/${event.wallet}`} className="lq-activity-wallet">{short(event.wallet)}</AppLink> : null}
    <div className="lq-activity-value"><strong className={incoming ? 'lq-positive' : 'lq-negative'}>{amount !== null && amount >= 0.01 ? `${incoming ? '+' : '−'}${usd(amount)}` : event.kind === 'launch' ? 'LAUNCH' : event.kind === 'graduate' ? 'GRAD' : '—'}</strong><span>{event.stage === 'pending' ? 'Pending' : event.stage === 'failed' ? 'Failed' : ago(event.confirmedTs ?? event.ts, now)}</span></div>
    {!compact ? <AppLink href={eventLink(event)} className="lq-row-open" label={`Open ${label} ${kind.toLowerCase()}`}><Icon name="arrow" size={15} /></AppLink> : null}
  </div>
}
