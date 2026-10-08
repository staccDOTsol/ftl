// Conservative trade observations from executed Yellowstone transactions.
// A row is emitted only when exactly one known swap instruction exists and the
// signer has exactly two nonzero token-balance deltas: one quote and one token.
// This is a transaction's effective net execution price, not a pool oracle.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WSOL, type NIx, type NTx } from './decode.ts'
import type { Lane } from '../../../shared/types.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const idlDir = path.join(here, '..', '..', 'idl')
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
export type QuoteSymbol = 'USDC' | 'SOL' | 'USDT'
const QUOTES = new Map<string, QuoteSymbol>([[USDC, 'USDC'], [WSOL, 'SOL'], [USDT, 'USDT']])
export const supportsQuoteMint = (mint: string): boolean => QUOTES.has(mint)
export const quoteSymbolFor = (mint: string): QuoteSymbol | null => QUOTES.get(mint) ?? null

const IDLS = [
  ['orca_whirlpool.json', 'orca'], ['raydium_clmm.json', 'raydium-clmm'],
  ['raydium_cp_swap.json', 'raydium-cpmm'], ['raydium_launchpad.json', 'raydium-launchlab'],
  ['meteora_dlmm.json', 'meteora-dlmm'], ['meteora_damm_v1.json', 'meteora-damm'],
  ['meteora_damm_v2.json', 'meteora-damm-v2'], ['meteora_dbc.json', 'meteora-dbc'],
  ['pump.json', 'pumpfun'], ['pump_amm.json', 'pumpswap'],
] as const

interface SwapSpec { venue: string; name: string }
const swapSpecs = new Map<string, Map<string, SwapSpec>>()
for (const [file, venue] of IDLS) {
  const idl = JSON.parse(fs.readFileSync(path.join(idlDir, file), 'utf8'))
  const program = idl.address ?? idl.metadata?.address
  const specs = new Map<string, SwapSpec>()
  for (const ix of idl.instructions ?? []) {
    const name = String(ix.name).replace(/[A-Z]/g, (c: string) => '_' + c.toLowerCase())
    if (!/^(swap(?:2|_|$)|buy(?:_|$)|sell(?:_|$))/.test(name)) continue
    const disc: number[] = ix.discriminator ?? [...crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)]
    specs.set(Buffer.from(disc).toString('hex'), { venue, name })
  }
  if (specs.size) swapSpecs.set(program, specs)
}

function swapSpec(ix: NIx): SwapSpec | null {
  const specs = swapSpecs.get(ix.prog)
  if (!specs || ix.data.length < 8) return null
  return specs.get(Buffer.from(ix.data.subarray(0, 8)).toString('hex')) ?? null
}

export function looksLikeSwap(program: string, data: Uint8Array): boolean {
  return swapSpec({ prog: program, data, accts: [], n: '' }) !== null
}

export interface SwapObservation {
  id: string                // transaction signature; extractor admits one swap per tx
  token: string
  quote: string
  quoteSymbol: QuoteSymbol
  tokenUi: number
  quoteUi: number
  priceQuote: number
  venue: string
  instruction: string
  slot: number
  bankId?: string | null     // Yellowstone bank identity for finality matching
  finalized?: boolean        // true only when source delivers finalized commitment
  ts: number                // UTC time when the executed stream reached FTL
}

export type SwapStreamEvent =
  | { t: 'open' | 'resume' | 'close' | 'pulse' | 'gap'; lane: Lane | 'laserstream' | 'robinhood-swaps'; ts: number; token?: string; reason?: string; fromSlot?: number; coveredThroughSlot?: number }
  | { t: 'slot'; lane: Lane; slot: number; bankId: string | null; status: 'finalized' | 'dead'; ts: number }

export function extractSwap(tx: NTx, ts = Date.now()): SwapObservation | null {
  if (tx.failed || !tx.pre || !tx.post || !tx.keys[0]) return null
  const matched = tx.ixs.map(swapSpec).filter((s): s is SwapSpec => s !== null)
  if (matched.length !== 1) return null
  const wallet = tx.keys[0]
  const delta = new Map<string, { raw: bigint; decimals: number }>()
  const add = (mint: string, decimals: number, raw: bigint) => {
    if (!mint || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18) return false
    const prev = delta.get(mint)
    if (prev && prev.decimals !== decimals) return false
    delta.set(mint, { raw: (prev?.raw ?? 0n) + raw, decimals })
    return true
  }
  for (const b of tx.pre) if (b.owner === wallet && !add(b.mint, b.decimals, -b.amount)) return null
  for (const b of tx.post) if (b.owner === wallet && !add(b.mint, b.decimals, b.amount)) return null
  const moved = [...delta].filter(([, d]) => d.raw !== 0n)
  if (moved.length !== 2) return null
  const quoteSide = moved.find(([mint]) => QUOTES.has(mint))
  const tokenSide = moved.find(([mint]) => !QUOTES.has(mint))
  if (!quoteSide || !tokenSide || quoteSide[1].raw * tokenSide[1].raw >= 0n) return null
  const [quote, q] = quoteSide
  const [token, t] = tokenSide
  const quoteUi = Number(q.raw < 0n ? -q.raw : q.raw) / 10 ** q.decimals
  const tokenUi = Number(t.raw < 0n ? -t.raw : t.raw) / 10 ** t.decimals
  const priceQuote = quoteUi / tokenUi
  if (!Number.isFinite(priceQuote) || priceQuote <= 0 || !Number.isFinite(quoteUi) || quoteUi <= 0 ||
    !Number.isFinite(tokenUi) || tokenUi <= 0 || !Number.isSafeInteger(tx.slot) || tx.slot < 0) return null
  return {
    id: tx.sig, token, quote, quoteSymbol: QUOTES.get(quote)!, tokenUi, quoteUi, priceQuote,
    venue: matched[0].venue, instruction: matched[0].name, slot: tx.slot, ts,
  }
}
