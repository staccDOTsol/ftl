// Wrap / unwrap SOL as first-class executable operations. The browser signs;
// this service only assembles an unsigned transaction from current chain
// state through the configured RPC. The RPC URL never appears in a reply.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { validPublicKey } from './router.ts'

export type WrapDirection = 'wrap' | 'unwrap'
export interface WrapIntent { owner: string; direction: WrapDirection; lamports?: string; transactionVersion: '0' | '1' }
export interface WrapBuild {
  transaction: string; lastValidBlockHeight: number; transactionVersion: '0' | '1'; expectedSigners: string[]
  summary: { direction: WrapDirection; lamports: string; tokenAccount: string; createsTokenAccount: boolean }
}
type Options = { rpcUrl?: string; fetch?: typeof fetch; now?: () => number }

const U64_MAX = (1n << 64n) - 1n
const MAX_RESPONSE = 2_000_000
const RATE_CEILING = 30
// A wrap is at most ATA create + transfer + sync; an unwrap is one close.
export const WRAP_COMPUTE_UNITS = 100_000
export class RequestError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status } }
const fail = (message: string): never => { throw new RequestError(400, message) }
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const integer = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= U64_MAX

export function validateWrapRequest(value: unknown): WrapIntent {
  if (!object(value)) fail('Invalid wrap request')
  if (!validPublicKey(value.owner)) fail('Invalid Solana address')
  if (value.direction !== 'wrap' && value.direction !== 'unwrap') fail('direction must be wrap or unwrap')
  const transactionVersion = value.transactionVersion === undefined ? '1' : String(value.transactionVersion)
  if (transactionVersion !== '1' && transactionVersion !== '0') fail('transactionVersion must be 1 or 0')
  const intent: WrapIntent = { owner: value.owner, direction: value.direction, transactionVersion }
  if (value.direction === 'wrap') {
    if (typeof value.lamports !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value.lamports) || BigInt(value.lamports) > U64_MAX) fail('lamports must be a positive integer')
    intent.lamports = value.lamports
  }
  return intent
}

// Mirrors self-router unsignedV0: compute budget first, then the operation.
function unsignedV0(payer: PublicKey, blockhash: string, instructions: TransactionInstruction[]): string {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: WRAP_COMPUTE_UNITS }), ...instructions] }).compileToV0Message()
  const wire = Buffer.from(new VersionedTransaction(message).serialize())
  if (wire.length > 1232) throw new RequestError(422, 'Wrap transaction exceeds the V0 transaction limit')
  return wire.toString('base64')
}

export async function buildWrap(intent: WrapIntent & { rpcUrl: string; fetch?: typeof fetch }): Promise<WrapBuild> {
  const fetcher = intent.fetch ?? fetch
  // Every upstream failure collapses to a fixed message: provider errors can
  // carry the keyed endpoint and must never reach a client.
  async function rpc(method: string, params: unknown[]): Promise<any> {
    let r: Response
    try {
      r = await fetcher(intent.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), redirect: 'error', signal: AbortSignal.timeout(15_000) })
    } catch { throw new RequestError(503, 'Solana RPC is temporarily unavailable; retry shortly') }
    if (!r.ok) throw new RequestError(r.status === 429 ? 429 : 503, 'Solana RPC is temporarily unavailable; retry shortly')
    const reader = r.body?.getReader()
    if (!reader) throw new RequestError(502, 'Solana RPC returned an empty response')
    const chunks: Uint8Array[] = []; let size = 0
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_RESPONSE) { await reader.cancel(); throw new Error() } chunks.push(value) } } catch { throw new RequestError(502, 'Solana RPC returned an invalid response') }
    let data: any
    try { data = JSON.parse(Buffer.concat(chunks, size).toString()) } catch { throw new RequestError(502, 'Solana RPC returned invalid JSON') }
    if (!object(data) || data.jsonrpc !== '2.0' || data.error || !('result' in data)) throw new RequestError(502, 'Solana RPC request failed; retry shortly')
    return data.result
  }
  const owner = new PublicKey(intent.owner)
  const tokenAccount = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID)
  const [latest, account] = await Promise.all([
    rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]),
    rpc('getAccountInfo', [tokenAccount.toBase58(), { encoding: 'base64', commitment: 'confirmed' }]),
  ])
  const blockhash = latest?.value?.blockhash, lastValidBlockHeight = latest?.value?.lastValidBlockHeight
  if (!validPublicKey(blockhash) || !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight <= 0) throw new RequestError(502, 'Solana RPC returned an invalid blockhash')
  const exists = object(account?.value) && account.value.owner === TOKEN_PROGRAM_ID.toBase58()
  const instructions: TransactionInstruction[] = []
  let lamports: string
  if (intent.direction === 'wrap') {
    lamports = intent.lamports!
    if (!exists) instructions.push(createAssociatedTokenAccountIdempotentInstruction(owner, tokenAccount, owner, NATIVE_MINT, TOKEN_PROGRAM_ID))
    instructions.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: tokenAccount, lamports: BigInt(lamports) }), createSyncNativeInstruction(tokenAccount, TOKEN_PROGRAM_ID))
  } else {
    if (!exists) throw new RequestError(409, 'This wallet has no wrapped SOL account to unwrap')
    const balance = await rpc('getTokenAccountBalance', [tokenAccount.toBase58(), { commitment: 'confirmed' }])
    if (!integer(balance?.value?.amount)) throw new RequestError(502, 'Solana RPC returned an invalid wrapped SOL balance')
    lamports = balance.value.amount
    instructions.push(createCloseAccountInstruction(tokenAccount, owner, owner, [], TOKEN_PROGRAM_ID))
  }
  let transaction: string
  if (intent.transactionVersion === '1') {
    // Same V1 assembly the direct swap router emits (SIMD-0385 layout).
    const { unsignedV1 } = await import('./self-router.ts')
    try { transaction = unsignedV1(owner, blockhash, instructions, WRAP_COMPUTE_UNITS) }
    catch (e) { throw new RequestError(422, e instanceof Error ? e.message.replace(/Direct swap/g, 'Wrap') : 'Wrap transaction could not be assembled') }
  } else transaction = unsignedV0(owner, blockhash, instructions)
  return { transaction, lastValidBlockHeight, transactionVersion: intent.transactionVersion, expectedSigners: [intent.owner],
    summary: { direction: intent.direction, lamports, tokenAccount: tokenAccount.toBase58(), createsTokenAccount: intent.direction === 'wrap' && !exists } }
}

function reply(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(JSON.stringify(data))
}
export function createSolanaWrapHandler(options: Options) {
  const now = options.now ?? Date.now
  const buckets = new Map<string, { until: number; count: number }>()
  function limit(key: string, ceiling: number) {
    const time = now(), b = buckets.get(key)
    if (b && b.until > time) { if (++b.count > ceiling) throw new RequestError(429, 'Wrap request limit reached; retry shortly'); return }
    if (buckets.size > 10_000) { for (const [k, v] of buckets) if (v.until <= time) buckets.delete(k); if (buckets.size > 10_000) throw new RequestError(429, 'Wrap request limit reached; retry shortly') }
    buckets.set(key, { until: time + 60_000, count: 1 })
  }
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL, body: string): Promise<boolean> {
    if (req.method !== 'POST' || url.pathname !== '/api/wrap/solana') return false
    try {
      if (Buffer.byteLength(body) > 32_000) throw new RequestError(413, 'Wrap request is too large')
      let json: unknown
      try { json = JSON.parse(body) } catch { fail('Invalid JSON body') }
      const intent = validateWrapRequest(json)
      if (!options.rpcUrl) throw new RequestError(503, 'Solana wallet RPC is not configured yet')
      const peer = String(req.headers['fly-client-ip'] ?? req.socket.remoteAddress ?? 'unknown').slice(0, 100)
      limit(`ip:${peer}`, RATE_CEILING); limit('global', RATE_CEILING * 20)
      reply(res, 200, await buildWrap({ ...intent, rpcUrl: options.rpcUrl, fetch: options.fetch }))
    } catch (e) {
      const status = e instanceof RequestError ? e.status : 503
      if (status === 429) res.setHeader('retry-after', '60')
      reply(res, status, { error: e instanceof RequestError ? e.message : 'Wrap service is temporarily unavailable' })
    }
    return true
  }
}
