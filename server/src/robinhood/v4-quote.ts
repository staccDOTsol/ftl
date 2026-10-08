// One-hop, native-ETH quotes against the actual Robinhood Chain Uniswap v4
// pools FTL has seen. Pool keys come from the immutable Initialize receipt;
// prices and the final swap simulation come from the same live block.

import { AbiCoder, Interface, formatUnits } from 'ethers'
import { config } from '../config.ts'
import { db } from '../db.ts'
import { HttpError } from '../social.ts'

const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
const QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94'
const ROUTER = '0x204faca1764b154221e35c0d20abb3c525710498' // Universal Router 2.1.2
const ZERO = '0x0000000000000000000000000000000000000000'
const INITIALIZE = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438'
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const UINT = /^(0|[1-9][0-9]*)$/
const coder = AbiCoder.defaultAbiCoder()
const quoter = new Interface([
  'function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)',
])
const router = new Interface(['function execute(bytes commands,bytes[] inputs,uint256 deadline) payable'])
const SWAP = 'tuple(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)'

interface PoolRow { address: string; init_tx: string; mint_a: string; mint_b: string }
interface PoolKey { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string; id: string }
interface RpcLog { address: string; topics: string[]; data: string }
const keyCache = new Map<string, Promise<PoolKey | null>>()
let rpcId = 0

async function rpc(method: string, params: unknown[]): Promise<any> {
  if (!config.rhHttp) throw new HttpError(503, 'Robinhood Chain RPC is unavailable')
  const response = await fetch(config.rhHttp, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`)
  const result = await response.json() as any
  if (result.error || result.result === undefined) throw new Error(result.error?.message ?? 'RPC response missing result')
  return result.result
}

const word = (hex: string, index: number) => BigInt(`0x${hex.slice(2 + index * 64, 2 + (index + 1) * 64)}`)
const topicAddress = (hex: string) => `0x${hex.slice(-40)}`.toLowerCase()

async function readPoolKey(pool: PoolRow): Promise<PoolKey | null> {
  const receipt = await rpc('eth_getTransactionReceipt', [pool.init_tx])
  const log = (receipt?.logs as RpcLog[] | undefined)?.find(l =>
    l.address.toLowerCase() === PM && l.topics[0]?.toLowerCase() === INITIALIZE &&
    l.topics[1]?.toLowerCase() === pool.address.toLowerCase())
  if (!log || log.topics.length < 4 || log.data.length < 2 + 3 * 64) return null
  const currency0 = topicAddress(log.topics[2])
  const currency1 = topicAddress(log.topics[3])
  if (currency0 !== pool.mint_a?.toLowerCase() || currency1 !== pool.mint_b?.toLowerCase()) return null
  const fee = Number(word(log.data, 0))
  const signedTick = Number(word(log.data, 1) & 0xffffffn)
  const tickSpacing = signedTick >= 0x800000 ? signedTick - 0x1000000 : signedTick
  const hooks = `0x${log.data.slice(2 + 2 * 64 + 24, 2 + 3 * 64)}`.toLowerCase()
  if (fee > 0xffffff || tickSpacing <= 0 || currency0 !== ZERO || currency1 === ZERO) return null
  return { currency0, currency1, fee, tickSpacing, hooks, id: pool.address.toLowerCase() }
}

function poolKey(pool: PoolRow): Promise<PoolKey | null> {
  const id = pool.address.toLowerCase()
  let key = keyCache.get(id)
  if (!key) {
    key = readPoolKey(pool).then(result => { if (!result) keyCache.delete(id); return result },
      error => { keyCache.delete(id); throw error })
    keyCache.set(id, key)
  }
  return key
}

export function encodeV4Buy(key: PoolKey, amount: bigint, minOut: bigint, deadline: number): string {
  const k = [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
  // Matches Universal Router 2.1.2 / v4 SDK's V2_1_1 action encoding.
  const swap = coder.encode([SWAP], [[k, true, amount, minOut, 0n, '0x']])
  const settle = coder.encode(['address', 'uint256'], [key.currency0, amount])
  const take = coder.encode(['address', 'uint256'], [key.currency1, minOut])
  const actions = coder.encode(['bytes', 'bytes[]'], ['0x060c0f', [swap, settle, take]])
  return router.encodeFunctionData('execute', ['0x10', [actions], deadline])
}

export async function quoteV4(q: URLSearchParams, tokenDecimals = 18): Promise<unknown | null> {
  const token = q.get('tokenOut')?.toLowerCase() ?? ''
  if (q.get('tokenIn') !== 'ETH' || !ADDRESS.test(token)) return null
  if (q.get('type') && q.get('type') !== 'exactIn') throw new HttpError(400, 'only exact-input ETH swaps are supported')
  const rawAmount = q.get('amount') ?? ''
  if (!UINT.test(rawAmount) || rawAmount.length > 39) throw new HttpError(400, 'invalid ETH amount')
  const amount = BigInt(rawAmount)
  if (amount <= 0n || amount >= (1n << 128n)) throw new HttpError(400, 'invalid ETH amount')
  const recipient = q.get('recipient')
  if (recipient && !ADDRESS.test(recipient)) throw new HttpError(400, 'invalid recipient')
  const slippage = Number(q.get('slippage') ?? 5)
  if (!Number.isFinite(slippage) || slippage < 0.1 || slippage > 50)
    throw new HttpError(400, 'slippage must be between 0.1% and 50%')

  // Keep quote latency bounded on tokens with hundreds of pools. We do not
  // claim best execution across the chain; the chosen onchain pool is exposed.
  const pools = db.prepare(`SELECT address, init_tx, mint_a, mint_b FROM pools
    WHERE chain = 'robinhood' AND token = ? AND quote = ? AND funded = 1
    ORDER BY liq_events DESC, created_ts DESC LIMIT 12`).all(token, ZERO) as PoolRow[]
  if (!pools.length) return null
  let block: string
  try { block = await rpc('eth_blockNumber', []) } catch { throw new HttpError(503, 'Robinhood Chain quote RPC is unavailable') }

  const candidates = await Promise.all(pools.map(async pool => {
    try {
      const key = await poolKey(pool)
      if (!key || key.currency1 !== token) return null
      const data = quoter.encodeFunctionData('quoteExactInputSingle', [[
        [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks], true, amount, '0x',
      ]])
      const result = await rpc('eth_call', [{ to: QUOTER, data }, block])
      const output = quoter.decodeFunctionResult('quoteExactInputSingle', result)[0] as bigint
      return output > 0n ? { key, output } : null
    } catch { return null } // drained or hook-incompatible pool
  }))
  const ranked = candidates.filter((c): c is NonNullable<typeof c> => !!c)
    .sort((a, b) => a.output === b.output ? 0 : a.output > b.output ? -1 : 1)
  if (!ranked.length) throw new HttpError(404, 'No live ETH pool can fill this quote')

  const deadline = Math.floor(Date.now() / 1000) + 600
  for (const { key, output } of ranked) {
    const minOut = output * BigInt(Math.round((100 - slippage) * 100)) / 10_000n
    const calldata = encodeV4Buy(key, amount, minOut, deadline)
    if (recipient) {
      // A quote alone can succeed just before liquidity is pulled. Only serve
      // wallet-ready calldata that the router executes at the quoted block.
      try {
        await rpc('eth_call', [{ from: recipient, to: ROUTER, data: calldata, value: `0x${amount.toString(16)}` }, block])
      } catch { continue }
    }
    return {
      quote: output.toString(), quoteDecimals: formatUnits(output, tokenDecimals),
      source: 'uniswap-v4-direct', block, minTokensOut: minOut.toString(),
      route: [[{ address: key.id, fee: key.fee }]],
      ...(recipient ? { methodParameters: { calldata, value: `0x${amount.toString(16)}`, to: ROUTER } } : {}),
    }
  }
  throw new HttpError(409, 'Pool liquidity changed or the connected wallet cannot execute this quote; retry')
}
