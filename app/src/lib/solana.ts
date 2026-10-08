import { PublicKey } from '@solana/web3.js'
import { API_URL } from './api'
import { assertQuoteMatches, SOL_MINT, type QuoteIntent, type SolanaQuote } from './solana-trade'
import { assertTransactionSignature, inspectTransaction, type TransactionVersion } from './solana-wire'

export async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(35_000),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.error) {
    const message = typeof data.error === 'string' ? data.error : data.error?.message
    throw new Error(message || data.message || `Trading service returned HTTP ${response.status}.`)
  }
  return data as T
}

export async function solanaRpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await request<{ result: T }>('/api/solana/rpc', { jsonrpc: '2.0', id: 1, method, params })
  return response.result
}

export function validateMint(mint: string) {
  try { return new PublicKey(mint.trim()).toBase58() } catch { throw new Error('Enter a valid Solana mint address.') }
}

const decimalsCache = new Map<string, number>([[SOL_MINT, 9]])
export async function mintDecimals(mint: string): Promise<number> {
  validateMint(mint)
  if (decimalsCache.has(mint)) return decimalsCache.get(mint)!
  const response = await solanaRpc<{ value: { owner: string; data: { parsed?: { type: string; info: { decimals?: number } } } } | null }>(
    'getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }])
  const account = response.value
  const decimals = account?.data.parsed?.info.decimals
  if (!account || !['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].includes(account.owner) ||
      account.data.parsed?.type !== 'mint' || typeof decimals !== 'number' || decimals < 0 || decimals > 18) {
    throw new Error('This address is not a supported SPL token mint.')
  }
  decimalsCache.set(mint, decimals)
  return decimals
}

export async function tokenBalance(owner: string, mint: string, nativeSol = true): Promise<string> {
  if (mint === SOL_MINT && nativeSol) {
    const balance = await solanaRpc<{ value: number }>('getBalance', [owner, { commitment: 'confirmed' }])
    if (!Number.isSafeInteger(balance.value)) throw new Error('SOL balance could not be represented exactly.')
    return String(balance.value)
  }
  const accounts = await solanaRpc<{ value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] }>(
    'getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }])
  return accounts.value.reduce((sum, item) => sum + BigInt(item.account.data.parsed.info.tokenAmount.amount), 0n).toString()
}

export async function getSolanaQuote(intent: QuoteIntent): Promise<SolanaQuote> {
  const query = new URLSearchParams({ ...intent, slippageBps: String(intent.slippageBps), swapMode: 'ExactIn', transactionVersion: intent.transactionVersion ?? '1' })
  const quote = await request<SolanaQuote>(`/api/quote/solana?${query}`)
  assertQuoteMatches(quote, intent)
  return quote
}

export const getRouterStatus = () => request<{ configured?: boolean; status?: string; available?: boolean; message?: string }>('/api/router/solana')

export const decodeTransaction = (encoded: string) => Uint8Array.from(atob(encoded), char => char.charCodeAt(0))
export function encodeTransaction(bytes: Uint8Array) { return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')) }

export interface BuiltSwap { swapTransaction: string; lastValidBlockHeight: number; transactionVersion: TransactionVersion; networkFeeLamports?: number
  /** Set when the server routed the built swap through the composer; quoteResponse is that route. */
  composed?: boolean; hops?: number; quoteResponse?: SolanaQuote }
export async function buildAndSimulate(quote: SolanaQuote, owner: string, transactionVersion: TransactionVersion): Promise<BuiltSwap> {
  const swap = await request<BuiltSwap>('/api/swap/solana', { quoteResponse: quote, userPublicKey: owner, wrapAndUnwrapSol: true, transactionVersion })
  if (!Number.isSafeInteger(swap.lastValidBlockHeight) || swap.lastValidBlockHeight <= 0) throw new Error('The transaction has no valid expiry. Request a fresh quote.')
  const transaction = inspectTransaction(decodeTransaction(swap.swapTransaction))
  if (transaction.version !== transactionVersion || swap.transactionVersion !== transactionVersion) throw new Error('The router returned a transaction version this wallet did not request.')
  if (transaction.feePayer !== owner || transaction.requiredSignatures !== 1) {
    throw new Error('The transaction requests an unexpected signer.')
  }
  const simulation = await solanaRpc<{ value: { err: unknown; logs?: string[] } }>('simulateTransaction', [swap.swapTransaction, {
    encoding: 'base64', commitment: 'confirmed', sigVerify: false, replaceRecentBlockhash: true,
  }])
  if (simulation.value.err) throw new Error(`Trade simulation failed (${JSON.stringify(simulation.value.err)}). No transaction was sent. Refresh your quote or try a smaller amount.`)
  const fee = await solanaRpc<{ value: number | null }>('getFeeForMessage', [encodeTransaction(transaction.message), { commitment: 'confirmed' }])
  if (fee.value === null || !Number.isSafeInteger(fee.value)) throw new Error('The transaction fee could not be checked. Request a fresh quote.')
  swap.networkFeeLamports = fee.value
  return swap
}

export function assertSignedMessage(unsigned: string, signed: Uint8Array) {
  assertTransactionSignature(decodeTransaction(unsigned), signed)
}

export async function sendSignedSwap(signed: Uint8Array, lastValidBlockHeight: number) {
  const height = await solanaRpc<number>('getBlockHeight', [{ commitment: 'confirmed' }])
  if (height > lastValidBlockHeight) throw new Error('The transaction expired before sending. Request a fresh quote.')
  return solanaRpc<string>('sendTransaction', [encodeTransaction(signed), { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }])
}

export type Confirmation = 'confirmed' | 'failed' | 'expired' | 'pending'
export async function transactionStatus(signature: string, lastValidBlockHeight: number): Promise<Confirmation> {
  const statuses = await solanaRpc<{ value: ({ err: unknown; confirmationStatus: string | null } | null)[] }>(
    'getSignatureStatuses', [[signature], { searchTransactionHistory: true }])
  const status = statuses.value[0]
  if (status?.err) return 'failed'
  if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return 'confirmed'
  if (status) return 'pending'
  const height = await solanaRpc<number>('getBlockHeight', [{ commitment: 'finalized' }])
  return height > lastValidBlockHeight ? 'expired' : 'pending'
}
