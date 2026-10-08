// Pure pieces of the on-demand token metadata client: record shape, the shared
// in-memory cache, batching and labels. No React or network imports, so
// `node --test` loads it directly; token-meta.ts adds the fetch and the hook.
const SOL_MINT = 'So11111111111111111111111111111111111111112'

export interface TokenMetaRecord {
  mint: string; symbol: string | null; name: string | null; image: string | null
  decimals: number | null; tokenProgram: 'token' | 'token-2022' | null; source: 'ftl' | 'das' | 'chain'
}
export type TokenMetaMap = Record<string, TokenMetaRecord>
export const META_BATCH = 50
export const META_TTL_MS = 10 * 60_000

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
export const isMintLike = (value: string) => BASE58.test(value.trim())

// `null` records a miss (not a mint, or nothing anywhere) so it is not re-asked
// on every render; both hits and misses expire after the TTL.
const cache = new Map<string, { at: number; record: TokenMetaRecord | null }>()

export function cachedMeta(mint: string, now = Date.now()): TokenMetaRecord | null | undefined {
  const hit = cache.get(mint)
  if (!hit) return undefined
  if (now - hit.at > META_TTL_MS) { cache.delete(mint); return undefined }
  return hit.record
}
export function rememberMeta(records: Record<string, TokenMetaRecord | null>, now = Date.now()) {
  for (const [mint, record] of Object.entries(records)) cache.set(mint, { at: now, record })
  if (cache.size > 5000) for (const key of [...cache.keys()].slice(0, 1000)) cache.delete(key)
}
export function clearMetaCache() { cache.clear() }

// Distinct valid mints, in first-seen order; SOL is well known and skipped.
export function uniqueMints(mints: (string | null | undefined)[]): string[] {
  const out: string[] = []
  for (const value of mints) {
    const mint = (value ?? '').trim()
    if (mint && mint !== SOL_MINT && isMintLike(mint) && !out.includes(mint)) out.push(mint)
  }
  return out
}
export const missingMints = (mints: string[], now = Date.now()) => mints.filter(mint => cachedMeta(mint, now) === undefined)
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
export function knownMeta(mints: string[], now = Date.now()): TokenMetaMap {
  const out: TokenMetaMap = {}
  for (const mint of mints) { const record = cachedMeta(mint, now); if (record) out[mint] = record }
  return out
}

export const shortMint = (mint: string) => mint === SOL_MINT ? 'SOL' : `${mint.slice(0, 4)}…${mint.slice(-4)}`
// Symbol when known, otherwise the short mint: the one rule every screen shares.
export const metaSymbol = (mint: string, meta?: TokenMetaMap | null, fallback?: string | null) => mint === SOL_MINT ? 'SOL' : meta?.[mint]?.symbol || fallback || shortMint(mint)
// "Sell A9EC…KnH4" → "Sell $BREAD" once the symbol is known.
export function retitle(title: string, mint: string, meta?: TokenMetaMap | null): string {
  const symbol = meta?.[mint]?.symbol
  return symbol ? title.split(shortMint(mint)).join(`$${symbol.slice(0, 14)}`) : title
}
