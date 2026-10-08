import { request } from './solana'
import { isSolanaAddress, type Holdings } from './solana-holdings-model'
export * from './solana-holdings-model'

export function getHoldings(owner: string): Promise<Holdings> {
  const address = owner.trim()
  if (!isSolanaAddress(address)) return Promise.reject(new Error('Enter a valid Solana wallet address.'))
  return request<Holdings>(`/api/holdings/solana/${encodeURIComponent(address)}`)
}
