import { useMemo, useState } from 'react'
import { useLive } from '@/lib/live'
import { ago, short } from '@/lib/format'
import { useNow } from '@/lib/useNow'
import type { TokenSummary } from '@/lib/types'
import { FLAG } from '@/theme'
import { AppLink, Avatar, FollowButton, Icon, Placeholder } from './MarketUI.web'

export function MarketBoard({ tokens, emptyAction, max = 12 }: { tokens: TokenSummary[]; emptyAction?: () => void; max?: number }) {
  const live = useLive()
  const now = useNow(3000)
  const [snapshot, setSnapshot] = useState<TokenSummary[] | null>(null)
  const [hovering, setHovering] = useState(false)
  const [focused, setFocused] = useState(false)
  const frozen = hovering || focused
  const rows = (frozen && snapshot ? snapshot : tokens).slice(0, max)
  return <div className="lq-market-table" role="table" aria-label="Trending tokens ranked by liquidity activity">
    <div className="lq-market-head" role="row"><span role="columnheader">#</span><span role="columnheader">Token</span><span role="columnheader" className="lq-pools-cell">Pools</span><span role="columnheader" className="lq-lps-cell">LPs</span><span role="columnheader">Activity score</span><span role="columnheader" className="lq-trade-cell">Make a move</span></div>
    <div role="rowgroup" onMouseEnter={() => { if (!frozen) setSnapshot(tokens); setHovering(true) }} onMouseLeave={() => setHovering(false)} onFocus={() => { if (!frozen) setSnapshot(tokens); setFocused(true) }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false) }}>
      {rows.map((token, index) => {
        const label = token.symbol || short(token.address)
        const flag = token.flags.includes('honeypot_fee') ? 'honeypot_fee' : token.flags.find(flag => FLAG[flag]?.hot)
        const history = live.tokenRate.get(`${token.chain}:${token.address}`)
        return <div className="lq-market-row" role="row" key={`${token.chain}:${token.address}`}>
          <span className="lq-rank" role="cell">{String(index + 1).padStart(2, '0')}</span>
          <div role="cell" className="lq-token-cell"><AppLink href={`/token/${token.chain}/${token.address}`} className="lq-token-identity"><Avatar image={token.image} label={label} size={38} chain={token.chain} /><span><strong>{label}{token.graduatedTs ? <span className="lq-graduated" title="Graduated">↗</span> : null}</strong><small>{token.name || short(token.address)}<span> · {ago(token.lastTs, now)}</span></small></span></AppLink>{flag ? <span className={`lq-token-flag ${flag === 'honeypot_fee' ? 'is-caution' : ''}`} title={FLAG[flag].about}>{flag === 'honeypot_fee' ? 'High-fee pools' : FLAG[flag].label}</span> : null}</div>
          <span role="cell" className="lq-pools-cell lq-data-value">{token.pools.toLocaleString()}<small>{token.fundedPools.toLocaleString()} funded</small></span>
          <span role="cell" className="lq-lps-cell lq-data-value">{token.lpWallets.toLocaleString()}<small>wallets</small></span>
          <div role="cell" className="lq-score-cell"><strong key={Math.round(token.score)} className="lq-score-number">{Math.round(token.score).toLocaleString()}</strong><MiniBars values={history} /></div>
          <div role="cell" className="lq-trade-cell"><AppLink href={token.chain === 'solana' ? `/swap?in=SOL&out=${token.address}` : `/token/${token.chain}/${token.address}`} className="lq-quick-trade" label={`Trade ${label}`}>Trade <Icon name="arrow" size={13} /></AppLink>{token.chain === 'solana' ? <AppLink href={`/swap?mode=liquidity&out=${token.address}`} className="lq-quick-earn" label={`Earn with ${label}`} title={`Earn with ${label}`}><Icon name="earn" size={15} /></AppLink> : <FollowButton kind="token" chain={token.chain} address={token.address} compact />}</div>
        </div>
      })}
    </div>
    {!tokens.length ? <Placeholder title="A little quiet here" body="Tokens appear as pools open and liquidity starts moving." action={emptyAction ? <button type="button" className="lq-button" onClick={emptyAction}>Show all tokens</button> : undefined} /> : null}
  </div>
}

export function MiniBars({ values }: { values?: number[] }) {
  const bars = useMemo(() => values ? Array.from({ length: 12 }, (_, i) => values.slice(Math.floor(i * values.length / 12), Math.floor((i + 1) * values.length / 12)).reduce((a, b) => a + b, 0)) : null, [values])
  if (!bars || bars.every(value => value === 0)) return <span className="lq-bars-empty" title="No new moves observed in this session">—</span>
  const max = Math.max(1, ...bars)
  return <span className="lq-mini-bars" role="img" aria-label={`${values?.reduce((a, b) => a + b, 0)} observed moves in the last minute`}>
    {bars.map((bar, index) => <i key={index} style={{ height: `${Math.max(7, bar / max * 100)}%`, opacity: bar ? .4 + index / 20 : .12 }} />)}
  </span>
}
