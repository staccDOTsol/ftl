// liquidityxyz (FTL: follow the liquidity). Wire types shared by the server and the app.
// The server is the only writer; the app treats every field as read-only.

export type Chain = 'solana' | 'robinhood'

// launch: a token is born on a launchpad (pump.fun create, Pons TokenLaunched, ...)
// pool_init: a new pool for a token (Initialize / initialize_pool / create_pool ...)
// liq_add / liq_remove: liquidity moves in or out of a pool
// graduate: a launchpad curve completes and migrates to an AMM
export type Kind = 'launch' | 'pool_init' | 'liq_add' | 'liq_remove' | 'graduate'

// Solana events race through up to three lanes. The first lane to see a
// transaction creates the event; later lanes upgrade it.
//   preconf  — Triton Preconfs (Harmonic / BAM), before shreds
//   deshred  — Triton Deshred, from shreds, before execution
//   geyser   — Dragon's Mouth at processed commitment (Triton), executed with metadata
//   geyser-drpc — the same Yellowstone Subscribe served by dRPC
// Robinhood events arrive executed (dRPC log subscription), so they start confirmed.
export type Stage = 'pending' | 'confirmed' | 'failed'
export type Lane = 'preconf' | 'deshred' | 'geyser' | 'geyser-primary' | 'geyser-drpc' | 'helius-parsed' | 'helius-laserstream' | 'logs'

export type Flag =
  | 'pounce'        // a pool on a launchpad token before it graduates (the book's crew shape)
  | 'burst_4_300'   // 4 distinct funded pools on one token within 300 s
  | 'burst_5_600'   // 5 distinct funded pools on one token within 600 s
  | 'honeypot_fee'  // static pool fee >= 70%
  | 'ladder'        // pool initialized with no liquidity in the same tx (price print)
  | 'jit'           // liquidity added and removed by one wallet within a few blocks/slots
  | 'multi_venue'   // >= 5 pools on a token within its first hour
  | 'first_pool'    // the first pool FTL saw for this token

export interface Amount {
  mint: string
  symbol?: string
  ui: number        // signed, from the wallet's side: negative = put into the pool
  decimals: number
}

export interface FlowEvent {
  id: string                 // `${chain}:${tx}:${n}`
  chain: Chain
  kind: Kind
  stage: Stage
  lane: Lane                 // lane that saw it first
  venue: string              // 'orca' | 'raydium-cpmm' | 'meteora-dlmm' | 'uniswap-v4' | 'pons' | ...
  ix: string                 // instruction or event name, e.g. 'initialize_pool_v2', 'ModifyLiquidity'
  pool: string | null
  token: string | null       // the subject token (the non-quote side)
  quote: string | null       // quote asset (SOL, USDC, ETH, USDG, ...) when known
  wallet: string             // fee payer / tx.from
  amounts: Amount[]
  quoteUi: number | null     // size of the quote leg, absolute
  feeBps: number | null      // static pool fee in basis points when known
  tx: string
  slot: number               // Solana slot or Robinhood L2 block
  ts: number                 // ms epoch when FTL first saw it
  confirmedTs?: number       // ms epoch when the executed copy arrived
  flags: Flag[]
  tokenMeta?: TokenMeta
}

export interface TokenMeta { symbol?: string; name?: string; image?: string; decimals?: number; description?: string; twitter?: string; website?: string }

export interface TokenSummary extends TokenMeta {
  chain: Chain
  address: string
  launchedTs: number | null
  launchVenue: string | null
  graduatedTs: number | null
  firstPoolTs: number | null
  pools: number
  fundedPools: number
  lpWallets: number
  events: number
  lastTs: number
  score: number
  flags: Flag[]
  followers?: number
}

export interface WalletSummary {
  chain: Chain
  address: string
  label: string | null
  inits: number
  adds: number
  removes: number
  tokens: number             // distinct launchpad tokens it touched before graduation
  hits: number               // ...of which later graduated
  hitRate: number            // hits / tokens (0 when tokens = 0)
  firstTs: number
  lastTs: number
  followers?: number
}

export interface PoolSummary {
  chain: Chain
  address: string
  venue: string
  token: string | null
  quote: string | null
  feeBps: number | null
  createdTs: number | null
  creator: string | null
  liqEvents: number
  funded: boolean
}

export interface Profile { pubkey: string; handle: string | null; bio: string | null; createdTs: number }

export interface Post {
  id: number
  author: Profile
  chain: Chain
  token: string
  kind: 'call' | 'comment'
  body: string
  ts: number
  likes: number
  liked?: boolean
  tokenMeta?: TokenMeta
  // a call is scored once the token graduates after it was posted
  hit?: boolean
}

export interface CallerSummary { profile: Profile; calls: number; hits: number; hitRate: number }

// Research covers FTL-seen coins on both chains. Outputs stay null when a source is
// unavailable or its coverage is insufficient. One output can be ready alone.
export interface ResearchCoin {
  chain: Chain
  address: string
  symbol?: string
  name?: string
  image?: string
  status: 'queued' | 'collecting' | 'ready' | 'insufficient_data' | 'source_unavailable' | 'error'
  statusReason: string | null
  firstSeenTs: number
  updatedTs: number | null
  nextRefreshTs: number | null
  priceQuote: 'USDC' | 'SOL' | 'USDT' | 'USDG' | 'WETH' | 'ETH' | null
  holderStrength: {
    score: number | null
    reason: string | null
    retentionPct: number | null
    top20SharePct: number | null
    top20ShareChangePct: number | null
    baselineTs: number | null
    observedTs: number | null
  }
  bottoming: {
    signs: number | null
    reason: string | null
    drawdownPct: number | null
    sellersCapitulated: boolean | null
    lowHolding: boolean | null
    demandReturning: boolean | null
    observedTs: number | null
  }
  coverage: {
    holderBootstrapAttempts: number
    holderState: 'unconfigured' | 'pending' | 'fetching' | 'live' | 'stale' | 'unavailable'
    holderAccounts: number | null
    holderOwners: number | null
    holderLastSlot: number | null
    holderCoveredThroughSlot: number | null
    holderBootstrapResponseBytes: number | null
    holderBootstrapPageAccounts: number | null
    holderBootstrapDbGrowthBytes: number | null
    priceCandles: number
    priceTrades: number
    holderWindowDays: number | null
    priceWindowDays: number | null
    priceStreamState: 'unconfigured' | 'observing' | 'subscribed_unverified' | 'stale' | 'gap'
    priceStreamLastTs: number | null
    priceStreamLagMs: number | null
    priceStreamReason: string | null
  }
  liveLiquidity: {
    poolInits: number
    adds: number
    removes: number
    observationStartTs: number | null
    lastEventTs: number | null
  }
  methodology: {
    holderStrength: string
    bottoming: string
    holderSource: string
    priceSource: string
  }
  provisional?: {
    state: 'unconfigured' | 'catching_up' | 'live' | 'stale'
    reason: string | null
    finality: 'provisional'
    finalizedThroughBlock: number | null
    observedFromBlock: number | null
    observedThroughBlock: number | null
    observedAt: number | null
    finalityLagMs: number | null
    holderTransferEvents: number | null
    touchedWallets: number | null
    knownV4SwapEvents: number | null
    rollbackCount: number
  }
}

export interface ResearchCoinDetail extends ResearchCoin {
  priceHistory: { ts: number; open: number; high: number; low: number; close: number; volumeQuote: number; trades: number }[]
  holderHistory: { ts: number; top20SharePct: number | null; trackedOwners: number }[]
}

export interface ResearchList {
  items: ResearchCoin[]
  total: number
  backlog: number
  nextCursor: string | null
  coverageNote: string
}

export interface LaneStatus {
  lane: Lane
  chain: Chain
  enabled: boolean
  connected: boolean
  reason?: string            // why a lane is off, e.g. 'TRITON_X_TOKEN not set'
  lastMsgTs: number | null
  msgs: number
  events: number
  firstSeenWins: number      // events this lane saw before any other lane
  p50LeadMs?: number         // median lead over the confirmed copy
  lagMs?: number             // how far behind the source's own timestamp the lane is running
  configuredStreams?: number // subscriptions enabled on this lane
  activeStreams?: number     // subscriptions currently connected
  filterPrograms?: number    // DEX program filters actually covering FTL events
  estimatedPayloadBytes?: number // sampled protobuf estimate, not billed traffic
  payloadSamples?: number
  budgetLimitBytes?: number
  budgetWindowMs?: number
  estimatedWindowPayloadBytes?: number
  budgetPayloadSamples?: number
  circuitOpenUntil?: number
}

export interface Status {
  startedTs: number
  lanes: LaneStatus[]
  clients: number
  eventsStored: number
  prices?: Record<string, number>
  researchStream?: {
    connected: boolean
    trackedMints: number
    activeFallbackPrograms?: number
    latestFinalizedSlot: number | null
    estimatedWindowPayloadBytes: number
    budgetPayloadSamples: number
    budgetLimitBytes: number
    budgetWindowMs: number
    circuitOpenUntil?: number
  }
}

export type ServerMsg =
  | { t: 'event'; e: FlowEvent }
  | { t: 'upgrade'; id: string; stage: Stage; confirmedTs?: number; amounts?: Amount[]; quoteUi?: number | null; flags?: Flag[] }
  | { t: 'token'; s: TokenSummary }
  | { t: 'post'; p: Post }
  | { t: 'research'; keys: string[]; enrolled: boolean; all: boolean; ts: number }
  | { t: 'status'; s: Status }
  | { t: 'meta'; chain: Chain; address: string; m: TokenMeta }
  | { t: 'hello'; serverTs: number }

export type ClientMsg =
  | { t: 'filter'; chains?: Chain[]; kinds?: Kind[]; flaggedOnly?: boolean; minQuote?: number; follow?: { wallets: string[]; tokens: string[] } }
  | { t: 'ping' }
