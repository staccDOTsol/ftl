// Strict, finalized Robinhood Chain log source for Research. A missing RPC
// result, truncated log range, or block-hash mismatch is never an empty range.
import { id } from 'ethers'

export const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
export const SWAP_TOPIC = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f'
export const INIT_TOPIC = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438'
export const TRANSFER_TOPIC = id('Transfer(address,address,uint256)').toLowerCase()
export const PONS_V2_FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e'
export const PONS_V2_DEPLOYMENT_BLOCK = 26_841_846
export const PONS_LAUNCH_TOPIC = id('TokenLaunched(address,address,address,address,uint256,uint256)').toLowerCase()
export const PONS_BUY_TOPIC = id('CurveBuy(address,address,uint256,uint256,uint256,uint256)').toLowerCase()
export const PONS_SELL_TOPIC = id('CurveSell(address,address,uint256,uint256,uint256,uint256)').toLowerCase()
export const ZERO = '0x0000000000000000000000000000000000000000'
export const RH_QUOTES = new Map<string, { symbol: 'ETH' | 'WETH' | 'USDG'; decimals: number }>([
  [ZERO, { symbol: 'ETH', decimals: 18 }],
  ['0x0bd7d308f8e1639fab988df18a8011f41eacad73', { symbol: 'WETH', decimals: 18 }],
  ['0x5fc5360d0400a0fd4f2af552add042d716f1d168', { symbol: 'USDG', decimals: 6 }],
])

export interface ChainLog {
  address: string
  topics: string[]
  data: string
  blockNumber: string
  blockHash: string
  blockTimestamp?: string // dRPC extension; standard RPC omits this
  transactionHash: string
  logIndex: string
  removed?: boolean
}
export interface ChainBlock {
  number: string
  hash: string
  timestamp: string
}
export interface PoolPair { currency0: string; currency1: string }
export interface Transfer { token: string; from: string; to: string; amount: bigint; block: number; index: number; tx: string }
export interface PonsCurve { curve: string; token: string; quote: string; launchedBlock: number }

export const hexBlock = (n: number) => `0x${n.toString(16)}`
export function blockNumber(hex: string): number {
  const n = Number(BigInt(hex))
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid block number')
  return n
}
export function uintWord(data: string, i: number): bigint {
  if (!/^0x(?:[a-f\d]{64})+$/i.test(data) || data.length < 2 + (i + 1) * 64) throw new Error('Malformed ABI word')
  return BigInt(`0x${data.slice(2 + i * 64, 2 + (i + 1) * 64)}`)
}
export function signedWord(data: string, i: number): bigint {
  const n = uintWord(data, i)
  return n >> 255n ? n - (1n << 256n) : n
}
export function topicAddress(topic: string): string {
  if (!/^0x0{24}[a-f\d]{40}$/i.test(topic)) throw new Error('Malformed address topic')
  return `0x${topic.slice(-40).toLowerCase()}`
}
function wordAddress(data: string, i: number): string {
  const word = uintWord(data, i)
  if (word >> 160n) throw new Error('Malformed ABI address word')
  return `0x${word.toString(16).padStart(40, '0')}`
}
export function decodePonsLaunch(log: ChainLog): PonsCurve | null {
  if (log.address.toLowerCase() !== PONS_V2_FACTORY || log.topics[0]?.toLowerCase() !== PONS_LAUNCH_TOPIC) return null
  if (log.removed || log.topics.length !== 4 || !/^0x(?:[a-f\d]{64}){3}$/i.test(log.data) ||
    !/^0x[a-f\d]{64}$/i.test(log.transactionHash)) throw new Error('Malformed finalized Pons V2 launch log')
  const token = topicAddress(log.topics[1]), curve = topicAddress(log.topics[2])
  topicAddress(log.topics[3])
  const quote = wordAddress(log.data, 0)
  if (token === ZERO || curve === ZERO || token === quote || curve === quote)
    throw new Error('Invalid Pons V2 launch assets')
  return { token, curve, quote, launchedBlock: blockNumber(log.blockNumber) }
}
export function decodePonsCurveSwap(log: ChainLog, curve: PonsCurve, tokenDecimals: number,
  quoteDecimals: number, ts: number): {
  chain: 'robinhood'; id: string; token: string; quote: string; quoteSymbol: string;
  tokenUi: number; quoteUi: number; priceQuote: number; blockNumber: number; ts: number; finalized: true
} | null {
  const kind = log.topics[0]?.toLowerCase()
  if (kind !== PONS_BUY_TOPIC && kind !== PONS_SELL_TOPIC) return null
  if (log.removed || log.address.toLowerCase() !== curve.curve || log.topics.length !== 3 ||
    !/^0x(?:[a-f\d]{64}){4}$/i.test(log.data) || !/^0x[a-f\d]{64}$/i.test(log.transactionHash))
    throw new Error('Malformed finalized Pons V2 curve trade log')
  topicAddress(log.topics[1]); topicAddress(log.topics[2])
  const tokenRaw = uintWord(log.data, kind === PONS_BUY_TOPIC ? 1 : 0)
  const quoteRaw = uintWord(log.data, kind === PONS_BUY_TOPIC ? 0 : 1)
  const fee = uintWord(log.data, 2), tax = uintWord(log.data, 3)
  if (tokenRaw <= 0n || quoteRaw <= 0n || (kind === PONS_BUY_TOPIC && quoteRaw <= fee + tax))
    throw new Error('Unpriceable finalized Pons V2 curve trade')
  const tokenUi = amountUi(tokenRaw, tokenDecimals)
  const quoteUi = amountUi(quoteRaw, quoteDecimals)
  const priceQuote = quoteUi / tokenUi
  if (!Number.isFinite(tokenUi) || !Number.isFinite(quoteUi) || !Number.isFinite(priceQuote) ||
    tokenUi <= 0 || quoteUi <= 0 || priceQuote <= 0 || !Number.isSafeInteger(ts) || ts <= 0)
    throw new Error('Pons V2 curve trade exceeds safe research price range')
  return { chain: 'robinhood', id: `${log.transactionHash.toLowerCase()}:${blockNumber(log.logIndex)}`,
    token: curve.token, quote: curve.quote, quoteSymbol: RH_QUOTES.get(curve.quote)?.symbol ?? curve.quote,
    tokenUi, quoteUi, priceQuote, blockNumber: blockNumber(log.blockNumber), ts, finalized: true }
}
export function decodePoolInit(log: ChainLog): { id: string; pair: PoolPair } | null {
  if (log.address.toLowerCase() !== POOL_MANAGER || log.topics[0]?.toLowerCase() !== INIT_TOPIC || log.topics.length < 4) return null
  if (!/^0x[a-f\d]{64}$/i.test(log.topics[1])) throw new Error('Malformed pool id')
  return { id: log.topics[1].toLowerCase(), pair: { currency0: topicAddress(log.topics[2]), currency1: topicAddress(log.topics[3]) } }
}
export function decodeTransfer(log: ChainLog): Transfer | null {
  if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return null
  if (log.removed || log.topics.length !== 3 || !/^0x[a-f\d]{40}$/i.test(log.address) ||
    !/^0x[a-f\d]{64}$/i.test(log.transactionHash) || !/^0x[a-f\d]{64}$/i.test(log.data))
    throw new Error('Malformed finalized ERC-20 Transfer log')
  return { token: log.address.toLowerCase(), from: topicAddress(log.topics[1]), to: topicAddress(log.topics[2]),
    amount: BigInt(log.data), block: blockNumber(log.blockNumber), index: blockNumber(log.logIndex),
    tx: log.transactionHash.toLowerCase() }
}
function amountUi(amount: bigint, decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('Invalid token decimals')
  const whole = amount / 10n ** BigInt(decimals)
  const fractional = amount % 10n ** BigInt(decimals)
  return Number(whole) + Number(fractional) / 10 ** decimals
}
export function decodeSwap(log: ChainLog, pair: PoolPair, tokenDecimals: number, ts: number): {
  chain: 'robinhood'; id: string; token: string; quote: string; quoteSymbol: 'ETH' | 'WETH' | 'USDG';
  tokenUi: number; quoteUi: number; priceQuote: number; blockNumber: number; ts: number; finalized: true
} | null {
  if (log.address.toLowerCase() !== POOL_MANAGER || log.topics[0]?.toLowerCase() !== SWAP_TOPIC || log.removed) return null
  const c0 = pair.currency0.toLowerCase(), c1 = pair.currency1.toLowerCase()
  const q0 = RH_QUOTES.get(c0), q1 = RH_QUOTES.get(c1)
  if (!!q0 === !!q1) return null // unsupported or quote/quote pair
  const quote = q0 ? c0 : c1, token = q0 ? c1 : c0, q = (q0 ?? q1)!
  const a0 = signedWord(log.data, 0), a1 = signedWord(log.data, 1)
  if (a0 === 0n || a1 === 0n || (a0 > 0n) === (a1 > 0n)) return null
  const abs = (x: bigint) => x < 0n ? -x : x
  const tokenUi = amountUi(abs(q0 ? a1 : a0), tokenDecimals)
  const quoteUi = amountUi(abs(q0 ? a0 : a1), q.decimals)
  const priceQuote = quoteUi / tokenUi
  if (!Number.isFinite(tokenUi) || !Number.isFinite(quoteUi) || !Number.isFinite(priceQuote) ||
    tokenUi <= 0 || quoteUi <= 0 || priceQuote <= 0 || !Number.isSafeInteger(ts) || ts <= 0) return null
  if (!/^0x[a-f\d]{64}$/i.test(log.transactionHash)) throw new Error('Malformed swap transaction hash')
  return { chain: 'robinhood', id: `${log.transactionHash.toLowerCase()}:${blockNumber(log.logIndex)}`,
    token, quote, quoteSymbol: q.symbol, tokenUi, quoteUi, priceQuote,
    blockNumber: blockNumber(log.blockNumber), ts, finalized: true }
}

class RpcMethodError extends Error {
  readonly code: number | null
  constructor(method: string, code: number | null, message: string) {
    super(`Robinhood RPC ${method}: ${message}`)
    this.code = code
  }
}

function splittableLogError(error: unknown, depth: number): boolean {
  if (!(error instanceof RpcMethodError)) return false
  const message = error.message.toLowerCase()
  if (/rate.?limit|quota|credit|unauthorized|forbidden|invalid api|billing/.test(message)) return false
  if (/timed? out|timeout/.test(message)) return depth < 4
  return /too many|result limit|log limit|limit exceeded|response size|block range|range too|query returned more/.test(message)
}

export class StrictRhRpc {
  private id = 0
  private readonly url: string
  private readonly request: typeof fetch
  constructor(url: string, request: typeof fetch = fetch) { this.url = url; this.request = request }
  async batch(calls: { method: string; params: unknown[] }[]): Promise<any[]> {
    if (!calls.length) return []
    const body = calls.map(c => ({ jsonrpc: '2.0', id: ++this.id, ...c }))
    const response = await this.request(this.url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error(`Robinhood RPC HTTP ${response.status}`)
    const raw = await response.json() as any
    const results = Array.isArray(raw) ? raw : [raw]
    const byId = new Map<number, any>()
    for (const result of results) {
      if (!result || typeof result.id !== 'number' || byId.has(result.id))
        throw new Error('Robinhood RPC returned duplicate or invalid response IDs')
      byId.set(result.id, result)
    }
    return body.map(call => {
      const result = byId.get(call.id)
      if (result?.error) {
        const code = Number.isInteger(result.error.code) ? result.error.code as number : null
        const message = typeof result.error.message === 'string' ? result.error.message.slice(0, 180) : 'provider error'
        throw new RpcMethodError(call.method, code, message)
      }
      if (!result || result.result === undefined || result.result === null)
        throw new Error(`Robinhood RPC ${call.method} returned no complete result`)
      return result.result
    })
  }
  async call(method: string, params: unknown[]): Promise<any> { return (await this.batch([{ method, params }]))[0] }
  async finalizedHead(): Promise<{ number: number; hash: string; ts: number }> {
    const block = await this.call('eth_getBlockByNumber', ['finalized', false]) as ChainBlock
    if (!/^0x[a-f\d]{64}$/i.test(block.hash)) throw new Error('Finalized block hash missing')
    return { number: blockNumber(block.number), hash: block.hash.toLowerCase(), ts: blockNumber(block.timestamp) * 1000 }
  }
  async latestHead(): Promise<{ number: number; hash: string; ts: number }> {
    const block = await this.call('eth_getBlockByNumber', ['latest', false]) as ChainBlock
    if (!/^0x[a-f\d]{64}$/i.test(block.hash)) throw new Error('Latest block hash missing')
    return { number: blockNumber(block.number), hash: block.hash.toLowerCase(), ts: blockNumber(block.timestamp) * 1000 }
  }
  async getLogs(filter: { fromBlock: string; toBlock: string; address?: string | string[]; topics: (string | string[] | null)[] }): Promise<ChainLog[]> {
    const logs = await this.call('eth_getLogs', [filter])
    if (!Array.isArray(logs)) throw new Error('Malformed eth_getLogs result')
    return logs as ChainLog[]
  }
  async completeLogs(filter: { address?: string | string[]; topics: (string | string[] | null)[] }, from: number, to: number,
    depth = 0): Promise<ChainLog[]> {
    if (from > to) return []
    let split = false
    try {
      const logs = await this.getLogs({ ...filter, fromBlock: hexBlock(from), toBlock: hexBlock(to) })
      // dRPC returns more than 10,000 logs on the paid Robinhood endpoint.
      // The documented 10,000-entry free-tier cap is a possible exact count;
      // split only at that boundary (or a larger round cap), not at 1,000.
      // Otherwise trust JSON-RPC's all-logs-or-error contract; splitting every
      // large successful response multiplies billed bandwidth needlessly.
      if (logs.length !== 10_000 && logs.length < 100_000) return logs
      split = true
    } catch (error) {
      if (!splittableLogError(error, depth) || from === to)
        throw new Error(`Incomplete Robinhood logs at blocks ${from}-${to}: ${String(error)}`)
      split = true
    }
    if (!split || from === to) throw new Error(`Incomplete Robinhood logs at block ${from}: provider record limit`)
    const mid = Math.floor((from + to) / 2)
    const left = await this.completeLogs(filter, from, mid, depth + 1)
    const right = await this.completeLogs(filter, mid + 1, to, depth + 1)
    return [...left, ...right]
  }
  async verifiedBlocks(logs: ChainLog[], finalizedHead: number): Promise<Map<number, number>> {
    const byBlock = new Map<number, string>()
    for (const log of logs) {
      if (log.removed || !/^0x[a-f\d]{64}$/i.test(log.blockHash)) throw new Error('Removed or unhashed finalized log')
      const n = blockNumber(log.blockNumber)
      if (n > finalizedHead) throw new Error('Log is newer than finalized head')
      const prior = byBlock.get(n)
      if (prior && prior !== log.blockHash.toLowerCase()) throw new Error('Conflicting finalized block hashes')
      byBlock.set(n, log.blockHash.toLowerCase())
    }
    const numbers = [...byBlock.keys()]
    const out = new Map<number, number>()
    for (let i = 0; i < numbers.length; i += 100) {
      const chunk = numbers.slice(i, i + 100)
      const blocks = await this.batch(chunk.map(n => ({ method: 'eth_getBlockByNumber', params: [hexBlock(n), false] }))) as ChainBlock[]
      blocks.forEach((block, k) => {
        if (block.hash?.toLowerCase() !== byBlock.get(chunk[k]) || blockNumber(block.number) !== chunk[k])
          throw new Error('Finalized log block hash does not match canonical block')
        out.set(chunk[k], blockNumber(block.timestamp) * 1000)
      })
    }
    return out
  }

  async finalizedStampedTimes(logs: ChainLog[], from: number, to: number,
    finalizedHead: number): Promise<Map<number, number>> {
    if (to > finalizedHead || from > to) throw new Error('Invalid finalized log range')
    // dRPC enriches each log with its exact block timestamp. Other providers
    // may omit it; retain full per-block header verification in that case.
    if (logs.some(log => !log.blockTimestamp)) return this.verifiedBlocks(logs, finalizedHead)
    const byBlock = new Map<number, { hash: string; ts: number }>()
    for (const log of logs) {
      const n = blockNumber(log.blockNumber)
      if (n < from || n > to || log.removed || !/^0x[a-f\d]{64}$/i.test(log.blockHash))
        throw new Error('Invalid finalized stamped log')
      const hash = log.blockHash.toLowerCase()
      const ts = blockNumber(log.blockTimestamp!) * 1000
      const previous = byBlock.get(n)
      if (previous && (previous.hash !== hash || previous.ts !== ts))
        throw new Error('Inconsistent block hash or timestamp in finalized logs')
      byBlock.set(n, { hash, ts })
    }
    const anchors = [...new Set([from, to])]
    const blocks = await this.batch(anchors.map(n => ({ method: 'eth_getBlockByNumber',
      params: [hexBlock(n), false] }))) as ChainBlock[]
    const firstTs = blockNumber(blocks[0].timestamp) * 1000
    const lastTs = blockNumber(blocks.at(-1)!.timestamp) * 1000
    blocks.forEach((block, i) => {
      const n = anchors[i], log = byBlock.get(n)
      if (blockNumber(block.number) !== n || !/^0x[a-f\d]{64}$/i.test(block.hash) ||
        (log && (log.hash !== block.hash.toLowerCase() || log.ts !== blockNumber(block.timestamp) * 1000)))
        throw new Error('Finalized log range anchor does not match canonical block')
    })
    const ordered = [...byBlock].sort((a, b) => a[0] - b[0])
    let priorTs = firstTs
    for (const [, value] of ordered) {
      if (value.ts < priorTs || value.ts > lastTs) throw new Error('Finalized log timestamps are outside canonical range')
      priorTs = value.ts
    }
    const times = new Map(ordered.map(([n, value]) => [n, value.ts]))
    times.set(from, firstTs)
    times.set(to, lastTs)
    return times
  }
}
