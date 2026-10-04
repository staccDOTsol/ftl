// Robinhood Chain swaps from the web app through an injected wallet (MetaMask,
// Coinbase, Rabby...). Quotes and calldata come from the stacc routing-api via
// the FTL server; the wallet signs and sends.

import { get } from './api'

const RH = {
  chainId: '0x1237',
  chainName: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
  blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
}

export const hasInjected = () => typeof window !== 'undefined' && !!(window as any).ethereum

export interface Quote {
  quote: string
  quoteDecimals: string
  quoteGasAdjustedDecimals?: string
  route?: any[][]
  methodParameters?: { calldata: string; value: string; to: string }
}

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

export function quote(token: string, amountEth: string, recipient?: string) {
  return get<Quote>('/api/quote/robinhood', { tokenIn: 'ETH', tokenOut: token, amount: toWei(amountEth), recipient, slippage: 5 })
}

// pools every hop of the route runs through, with their fee, so a 90% pool is visible before signing
export function routePools(q: Quote): { address: string; fee: number }[] {
  return (q.route ?? []).flat().map((h: any) => ({ address: h.address ?? h.poolId ?? '', fee: Number(h.fee ?? 0) }))
}

export async function send(q: Quote, from: string): Promise<string> {
  if (!q.methodParameters) throw new Error('quote has no calldata')
  const eth = (window as any).ethereum
  return eth.request({ method: 'eth_sendTransaction', params: [{ from, to: q.methodParameters.to, data: q.methodParameters.calldata, value: q.methodParameters.value }] })
}
