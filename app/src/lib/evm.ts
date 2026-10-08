// Robinhood Chain swaps from the web app through an injected wallet (MetaMask,
// Coinbase, Rabby...). Quotes and calldata come from the stacc routing-api via
// the FTL server; the wallet signs and sends.

import { get } from './api'

const RH = {
  chainId: '0x1237',
  chainName: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
}

export const hasInjected = () => typeof window !== 'undefined' && !!(window as any).ethereum

export interface Quote {
  quote: string
  quoteDecimals: string
  quoteGasAdjustedDecimals?: string
  source?: string
  minTokensOut?: string
  feeBps?: number
  creatorTaxBps?: number
  route?: any[][]
  methodParameters?: { calldata: string; value: string; to: string }
}

export class WalletContextError extends Error {}

export async function connect(): Promise<string> {
  const eth = (window as any).ethereum
  const [account] = await eth.request({ method: 'eth_requestAccounts' })
  try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: RH.chainId }] }) }
  catch (e: any) {
    if (e?.code === 4902 || /Unrecognized chain/i.test(String(e?.message))) await eth.request({ method: 'wallet_addEthereumChain', params: [RH] })
    else throw e
  }
  return account.toLowerCase()
}

export function toWei(eth: string): string {
  const [i, f = ''] = eth.trim().split('.')
  return (BigInt(i || '0') * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18) || '0')).toString()
}

export async function quote(token: string, amountEth: string, recipient: string) {
  await assertWallet(recipient)
  return get<Quote>('/api/quote/robinhood', { tokenIn: 'ETH', tokenOut: token, amount: toWei(amountEth), recipient, slippage: 5 })
}

// pools every hop of the route runs through, with their fee, so a 90% pool is visible before signing
export function routePools(q: Quote): { address: string; fee: number }[] {
  return (q.route ?? []).flat().map((h: any) => ({ address: h.address ?? h.poolId ?? '', fee: Number(h.fee ?? 0) }))
}

async function assertWallet(from: string): Promise<void> {
  const eth = (window as any).ethereum
  if (!eth) throw new WalletContextError('Connect a wallet to swap.')
  let chainId: unknown
  let accounts: unknown
  try {
    [chainId, accounts] = await Promise.all([
      eth.request({ method: 'eth_chainId' }),
      eth.request({ method: 'eth_accounts' }),
    ])
  } catch {
    throw new WalletContextError('Wallet status is unavailable. Reconnect and try again.')
  }
  if (String(chainId).toLowerCase() !== RH.chainId)
    throw new WalletContextError('Switch your wallet to Robinhood Chain and request a new quote.')
  if (!Array.isArray(accounts) || String(accounts[0] ?? '').toLowerCase() !== from.toLowerCase())
    throw new WalletContextError('Your selected wallet changed. Reconnect and request a new quote.')
}

export async function send(q: Quote, from: string): Promise<string> {
  if (!q.methodParameters) throw new WalletContextError('Request a fresh quote before swapping.')
  await assertWallet(from)
  const eth = (window as any).ethereum
  return eth.request({ method: 'eth_sendTransaction', params: [{ from, to: q.methodParameters.to, data: q.methodParameters.calldata, value: q.methodParameters.value }] })
}

export async function transactionState(hash: string): Promise<'pending' | 'confirmed' | 'reverted'> {
  const eth = (window as any).ethereum
  if (!eth) throw new WalletContextError('Wallet status is unavailable.')
  const chainId = await eth.request({ method: 'eth_chainId' })
  if (String(chainId).toLowerCase() !== RH.chainId)
    throw new WalletContextError('Switch your wallet to Robinhood Chain to check this transaction.')
  const receipt = await eth.request({ method: 'eth_getTransactionReceipt', params: [hash] })
  if (!receipt) return 'pending'
  if (receipt.status === '0x1' || receipt.status === 1) return 'confirmed'
  if (receipt.status === '0x0' || receipt.status === 0) return 'reverted'
  throw new Error('Unrecognized transaction receipt status.')
}
