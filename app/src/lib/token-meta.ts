// Symbol / name / image / decimals for any Solana mint, from
// GET /api/meta/solana (FTL row → DAS → mint account on the server). One
// in-memory cache feeds the swap terminal, the liquidity card and holdings.
import { useEffect, useMemo, useState } from 'react'
import { get } from './api'
import { cachedMeta, chunk, knownMeta, META_BATCH, missingMints, rememberMeta, uniqueMints, type TokenMetaMap, type TokenMetaRecord } from './token-meta-model'
export * from './token-meta-model'

const inflight = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()
const notify = () => { for (const listener of listeners) listener() }

async function fetchBatch(mints: string[]) {
  const learned: Record<string, TokenMetaRecord | null> = Object.fromEntries(mints.map(mint => [mint, null]))
  try {
    const result = await get<{ tokens: TokenMetaRecord[] }>('/api/meta/solana', { mints: mints.join(',') })
    for (const record of result.tokens ?? []) if (record?.mint) learned[record.mint] = record
    rememberMeta(learned)
  } catch {
    // Leave the cache untouched on a transport failure so the next mount retries.
  } finally {
    for (const mint of mints) inflight.delete(mint)
    notify()
  }
}

// Resolves whatever is not cached yet; always returns what is known afterwards.
export async function tokenMeta(mints: (string | null | undefined)[]): Promise<TokenMetaMap> {
  const wanted = uniqueMints(mints)
  const missing = missingMints(wanted).filter(mint => !inflight.has(mint))
  const batches = chunk(missing, META_BATCH).map(batch => {
    const task = fetchBatch(batch)
    for (const mint of batch) inflight.set(mint, task)
    return task
  })
  await Promise.all([...batches, ...wanted.map(mint => inflight.get(mint)).filter(Boolean)])
  return knownMeta(wanted)
}
export const tokenMetaOne = async (mint: string) => (await tokenMeta([mint]))[mint] ?? null
export const peekMeta = (mint: string) => cachedMeta(mint) ?? null

// Known records for `mints`, filling in from the server as they arrive. The
// returned map only changes identity when one of the requested mints changes.
export function useTokenMeta(mints: (string | null | undefined)[]): TokenMetaMap {
  const key = uniqueMints(mints).join(',')
  const [, bump] = useState(0)
  useEffect(() => {
    const wanted = key ? key.split(',') : []
    if (!wanted.length) return
    const listener = () => bump(value => value + 1)
    listeners.add(listener)
    if (missingMints(wanted).length) void tokenMeta(wanted)
    return () => { listeners.delete(listener) }
  }, [key])
  const snapshot = key ? key.split(',').map(mint => `${mint}:${cachedMeta(mint)?.symbol ?? ''}:${cachedMeta(mint)?.image ?? ''}`).join('|') : ''
  return useMemo(() => knownMeta(key ? key.split(',') : []), [snapshot]) // eslint-disable-line react-hooks/exhaustive-deps
}
