import type { Chain, FlowEvent, TokenSummary } from './types'

export type MarketChain = 'all' | Chain
export type MarketSort = 'hot' | 'new' | 'wallets'

export const tokenKey = (token: Pick<TokenSummary, 'chain' | 'address'>) => `${token.chain}:${token.address}`

// The HTTP snapshot supplies history; the stream can update it AND introduce
// newly discovered tokens. A late snapshot must not overwrite a newer event.
export function rankTokens(snapshot: TokenSummary[], updates: Iterable<TokenSummary>, chain: MarketChain, sort: MarketSort, since: number) {
  const byKey = new Map(snapshot.map(token => [tokenKey(token), token]))
  for (const token of updates) {
    const previous = byKey.get(tokenKey(token))
    if (!previous || token.lastTs >= previous.lastTs) byKey.set(tokenKey(token), { ...previous, ...token })
  }
  return [...byKey.values()]
    .filter(token => (chain === 'all' || token.chain === chain) && token.lastTs >= since && token.pools > 0)
    .sort((a, b) => {
      const order = sort === 'new' ? (b.firstPoolTs ?? 0) - (a.firstPoolTs ?? 0)
        : sort === 'wallets' ? b.lpWallets - a.lpWallets : b.score - a.score
      return order || b.lastTs - a.lastTs || tokenKey(a).localeCompare(tokenKey(b))
    })
}

export function recentEvents(events: FlowEvent[], chain: MarketChain = 'all', since = 0) {
  const unique = new Map<string, FlowEvent>()
  for (const event of events) {
    if ((chain !== 'all' && event.chain !== chain) || event.ts < since) continue
    const previous = unique.get(event.id)
    if (previous && previous.stage !== 'pending' && event.stage === 'pending') continue
    unique.set(event.id, previous ? { ...previous, ...event, tokenMeta: { ...previous.tokenMeta, ...event.tokenMeta } } : event)
  }
  return [...unique.values()].sort((a, b) => b.ts - a.ts)
}

// A chart of observed on-chain activity, never an invented price chart. Counts
// only confirmed moves and names the bounded sample in the UI.
export function activityBuckets(events: FlowEvent[], from: number, to: number, count = 24) {
  const size = Math.max(1, Math.floor(count))
  const buckets = Array.from({ length: size }, (_, i) => ({
    ts: from + (to - from) * i / size, incoming: 0, outgoing: 0, launches: 0,
  }))
  if (to <= from) return buckets
  for (const event of recentEvents(events)) {
    if (event.stage !== 'confirmed' || event.ts < from || event.ts > to) continue
    const index = Math.min(size - 1, Math.floor((event.ts - from) / (to - from) * size))
    if (event.kind === 'liq_remove') buckets[index].outgoing++
    else if (event.kind === 'liq_add' || event.kind === 'pool_init') buckets[index].incoming++
    else buckets[index].launches++
  }
  return buckets
}
