import { useSyncExternalStore } from 'react'
import { get, post } from './api'
import { identity } from './identity'
import { live } from './live'
import type { Chain, Profile } from './types'

export interface FollowRow { kind: 'wallet' | 'token'; chain: Chain; address: string; ts: number }

class Social {
  pubkey: string | null = null
  profile: Profile | null = null
  follows: FollowRow[] = []
  ready = false
  private listeners = new Set<() => void>()
  private v = 0

  async init() {
    const id = await identity()
    this.pubkey = id.pubkey
    try {
      const r = await get<{ profile: Profile; follows: FollowRow[] }>(`/api/profile/${id.pubkey}`)
      this.profile = r.profile
      this.follows = r.follows
    } catch {}
    this.ready = true
    this.emit()
  }

  isFollowing(kind: 'wallet' | 'token', chain: Chain, address: string) {
    return this.follows.some(f => f.kind === kind && f.chain === chain && f.address === address)
  }

  async toggle(kind: 'wallet' | 'token', chain: Chain, address: string) {
    const on = !this.isFollowing(kind, chain, address)
    const prev = this.follows
    this.follows = on ? [{ kind, chain, address, ts: Date.now() }, ...prev] : prev.filter(f => !(f.kind === kind && f.chain === chain && f.address === address))
    this.emit()
    try {
      this.follows = await post<FollowRow[]>(on ? '/api/follow' : '/api/unfollow', { kind, chain, address })
      this.emit()
    } catch (e) { this.follows = prev; this.emit(); throw e }
  }

  async setHandle(handle: string, bio?: string) {
    this.profile = await post<Profile>('/api/me', { handle, bio })
    this.emit()
  }

  // a websocket filter for the Following tab
  followFilter() {
    return {
      wallets: this.follows.filter(f => f.kind === 'wallet').map(f => `${f.chain}:${f.address}`),
      tokens: this.follows.filter(f => f.kind === 'token').map(f => `${f.chain}:${f.address}`),
    }
  }

  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l) } }
  getV = () => this.v
  private emit() { this.v++; for (const l of this.listeners) l() }
}

export const social = new Social()
export function useSocial() {
  useSyncExternalStore(social.subscribe, social.getV, social.getV)
  return social
}

// fire-and-forget hook so the live store can tell followers about their targets
export function followedMatch(e: { chain: Chain; wallet: string; token: string | null }) {
  return social.follows.some(f => f.chain === e.chain && ((f.kind === 'wallet' && f.address === e.wallet) || (f.kind === 'token' && f.address === e.token)))
}
void live
