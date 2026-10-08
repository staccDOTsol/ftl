import type { Chain, FlowEvent } from './types'

const contexts = new Map<string, FlowEvent>()
export function rememberEvent(event: FlowEvent) {
  contexts.set(event.id, event)
  while (contexts.size > 100) contexts.delete(contexts.keys().next().value!)
}
export function eventContext(id: string | undefined, chain: Chain, token: string): FlowEvent | null {
  const event = id ? contexts.get(id) : undefined
  return event?.chain === chain && event.token === token ? event : null
}
export function eventLink(event: FlowEvent) {
  rememberEvent(event)
  return event.token
    ? `/token/${event.chain}/${event.token}?event=${encodeURIComponent(event.id)}&action=${event.kind === 'liq_remove' ? 'exit' : 'liquidity'}` as const
    : `/wallet/${event.chain}/${event.wallet}` as const
}
