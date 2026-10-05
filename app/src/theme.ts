import { Platform } from 'react-native'
import type { Chain, Flag, Kind } from '@/lib/types'

// Palette is authored in oklch (perceptually even steps) and converted to hex,
// since React Native has no oklch(). Emotion: momentum + urgency. Neutrals are
// tinted toward the brand hue (250 → blue-black) so they never read as flat grey.
function oklch(L: number, C: number, H: number, alpha = 1): string {
  const h = (H * Math.PI) / 180
  const a = C * Math.cos(h), b = C * Math.sin(h)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  const hex = lin.map(x => {
    const c = Math.min(1, Math.max(0, x))
    const g = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055
    return Math.round(g * 255).toString(16).padStart(2, '0')
  }).join('')
  return alpha < 1 ? `#${hex}${Math.round(alpha * 255).toString(16).padStart(2, '0')}` : `#${hex}`
}

const N = 255 // neutral hue
export const C = {
  bg: oklch(0.145, 0.012, N),
  surface: oklch(0.178, 0.014, N),
  raised: oklch(0.215, 0.016, N),
  hover: oklch(0.2, 0.016, N),
  line: oklch(0.255, 0.016, N),
  lineStrong: oklch(0.32, 0.018, N),
  text: oklch(0.965, 0.006, N),
  muted: oklch(0.74, 0.016, N),
  faint: oklch(0.56, 0.016, N),
  ghost: oklch(0.42, 0.014, N),
  accent: oklch(0.87, 0.165, 165),     // mint: inflow, live, the one brand color
  accentDim: oklch(0.87, 0.165, 165, 0.14),
  accentInk: oklch(0.22, 0.05, 165),
  out: oklch(0.74, 0.16, 32),          // coral: liquidity leaving
  outDim: oklch(0.74, 0.16, 32, 0.14),
  heat: oklch(0.7, 0.24, 350),         // magenta: the book's crew fingerprints
  heatDim: oklch(0.7, 0.24, 350, 0.16),
  gold: oklch(0.86, 0.15, 85),
  violet: oklch(0.74, 0.15, 300),
  good: oklch(0.8, 0.17, 150),
  warn: oklch(0.83, 0.15, 75),
  bad: oklch(0.68, 0.2, 25),
} as const
export { oklch }

export const CHAIN: Record<Chain, { label: string; short: string; color: string }> = {
  solana: { label: 'Solana', short: 'SOL', color: oklch(0.72, 0.17, 300) },
  robinhood: { label: 'Robinhood', short: 'RH', color: oklch(0.92, 0.2, 125) },
}

export const KIND: Record<Kind, { label: string; verb: string; glyph: string; color: string; dim: string }> = {
  pool_init: { label: 'New pool', verb: 'opened a pool', glyph: '◎', color: C.accent, dim: C.accentDim },
  liq_add: { label: 'Add', verb: 'added', glyph: '+', color: C.accent, dim: C.accentDim },
  liq_remove: { label: 'Pull', verb: 'pulled', glyph: '−', color: C.out, dim: C.outDim },
  launch: { label: 'Launch', verb: 'launched', glyph: '✦', color: C.violet, dim: oklch(0.74, 0.15, 300, 0.14) },
  graduate: { label: 'Graduated', verb: 'graduated', glyph: '▲', color: C.gold, dim: oklch(0.86, 0.15, 85, 0.14) },
}

export const FLAG: Record<Flag, { label: string; color: string; about: string; hot: boolean }> = {
  pounce: { label: 'POUNCE', color: C.heat, hot: true, about: 'An independent pool on a launchpad token that has not graduated yet. In the book’s 24 h Robinhood sample, 31 of 33 graduations came from pounced launches.' },
  burst_4_300: { label: '4 IN 5M', color: C.heat, hot: true, about: 'Four distinct funded pools on one token within 300 seconds.' },
  burst_5_600: { label: '5 IN 10M', color: C.heat, hot: true, about: 'Five distinct funded pools on one token within 600 seconds.' },
  honeypot_fee: { label: 'FEE ≥70%', color: C.warn, hot: false, about: 'A pool with a static fee of 70% or more. A buyer routed through it loses most of the input.' },
  ladder: { label: 'LADDER', color: oklch(0.8, 0.12, 230), hot: false, about: 'A pool initialized with no liquidity in the same transaction: it prints a price without depth.' },
  jit: { label: 'JIT', color: C.violet, hot: false, about: 'Liquidity added and pulled by the same wallet within a few blocks.' },
  multi_venue: { label: '5+ POOLS/1H', color: oklch(0.82, 0.13, 190), hot: true, about: 'Five or more pools on one token within its first hour.' },
  first_pool: { label: 'FIRST POOL', color: C.accent, hot: false, about: 'The first pool seen for this token.' },
}

export const F = {
  display: 'SpaceGrotesk_600SemiBold',
  displayBold: 'SpaceGrotesk_700Bold',
  body: 'SpaceGrotesk_400Regular',
  bodyMedium: 'SpaceGrotesk_500Medium',
  mono: 'JetBrainsMono_400Regular',
  monoBold: 'JetBrainsMono_600SemiBold',
}

// type scale (1.2 minor third from 11): 11 · 13 · 15 · 18 · 22 · 28
export const T = { xs: 11, sm: 13, md: 15, lg: 18, xl: 22, xxl: 28 }

export const MAX_W = 1440
export const WIDE = 1080      // sidebar + right rail
export const MID = 760        // single-line tape rows
export const isWeb = Platform.OS === 'web'
export const EASE = [0.2, 0.8, 0.2, 1] as const
