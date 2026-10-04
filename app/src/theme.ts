import { Platform } from 'react-native'
import type { Chain, Flag, Kind } from '@/lib/types'

// FTL is dark only: a firehose reads best as light on black.
export const C = {
  bg: '#07080B',
  surface: '#0E1015',
  raised: '#151821',
  line: '#1E222C',
  lineStrong: '#2A2F3B',
  text: '#ECEEF2',
  muted: '#8B93A1',
  faint: '#5A6170',
  accent: '#38F2C6',        // liquidity: the one brand color
  accentInk: '#03241C',
  good: '#4ADE80',
  warn: '#FFB020',
  bad: '#FF5D5D',
} as const

export const CHAIN: Record<Chain, { label: string; short: string; color: string }> = {
  solana: { label: 'Solana', short: 'SOL', color: '#A98BFF' },
  robinhood: { label: 'Robinhood', short: 'RH', color: '#CCFF00' },
}

export const KIND: Record<Kind, { label: string; verb: string; glyph: string; color: string }> = {
  pool_init: { label: 'Pool', verb: 'opened a pool', glyph: '◎', color: C.accent },
  liq_add: { label: 'Add', verb: 'added', glyph: '＋', color: '#5AA9FF' },
  liq_remove: { label: 'Pull', verb: 'pulled', glyph: '－', color: '#FF8A5B' },
  launch: { label: 'Launch', verb: 'launched', glyph: '✦', color: '#C9A7FF' },
  graduate: { label: 'Grad', verb: 'graduated', glyph: '▲', color: '#4ADE80' },
}

export const FLAG: Record<Flag, { label: string; color: string; about: string }> = {
  pounce: { label: 'pounce', color: '#FF6B3D', about: 'An independent pool on a launchpad token that has not graduated yet. In the book’s 24 h Robinhood sample, 31 of 33 graduations came from pounced launches.' },
  burst_4_300: { label: '4 in 5m', color: '#FF3D9A', about: 'Four distinct funded pools on one token within 300 seconds.' },
  burst_5_600: { label: '5 in 10m', color: '#FF3D9A', about: 'Five distinct funded pools on one token within 600 seconds.' },
  honeypot_fee: { label: 'fee ≥70%', color: '#FFB020', about: 'A pool with a static fee of 70% or more. A buyer routed through it loses most of the input.' },
  ladder: { label: 'ladder', color: '#4CC9F0', about: 'A pool initialized with no liquidity in the same transaction: it prints a price without depth.' },
  jit: { label: 'JIT', color: '#B48CFF', about: 'Liquidity added and pulled by the same wallet within a few blocks.' },
  multi_venue: { label: '5+ pools/1h', color: '#2DD4BF', about: 'Five or more pools on one token within its first hour.' },
  first_pool: { label: 'first pool', color: C.muted, about: 'The first pool FTL saw for this token.' },
}

export const F = {
  display: 'SpaceGrotesk_600SemiBold',
  displayBold: 'SpaceGrotesk_700Bold',
  body: 'SpaceGrotesk_400Regular',
  bodyMedium: 'SpaceGrotesk_500Medium',
  mono: 'JetBrainsMono_400Regular',
  monoBold: 'JetBrainsMono_600SemiBold',
}

export const MAX_W = 760
export const isWeb = Platform.OS === 'web'
