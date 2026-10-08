// Latest-head Robinhood Chain activity, kept separate from finalized Research.
// This overlay is rebuilt from the finalized boundary on startup or a reorg;
// it never writes holder balances, trade candles, or a scored bottoming sign.
import { config, redact } from '../config.ts'
import { db } from '../db.ts'
import { bus, lookupPool } from '../hub.ts'
import { POOL_MANAGER, SWAP_TOPIC, TRANSFER_TOPIC, ZERO, StrictRhRpc,
  blockNumber, decodeTransfer, hexBlock, signedWord, type ChainBlock, type ChainLog } from './research-source.ts'

export interface RobinhoodProvisionalStatus {
  state: 'unconfigured' | 'catching_up' | 'live' | 'stale'
  reason: string | null
  finality: 'provisional'
  finalizedThroughBlock: number | null
  observedFromBlock: number | null
  observedThroughBlock: number | null
  observedAt: number | null
  finalityLagMs: number | null
  holderTransferEvents: number | null
  touchedWallets: number | null
  knownV4SwapEvents: number | null
  rollbackCount: number
}

interface Contribution { transfers: number; swaps: number; wallets: Set<string> }
interface Bucket { hash: string; byToken: Map<string, Contribution> }
interface Total { transfers: number; swaps: number; wallets: Map<string, number> }
type Head = { number: number; hash: string; ts: number }
type Rpc = Pick<StrictRhRpc, 'call' | 'completeLogs' | 'finalizedHead' | 'latestHead'>

const validHash = (hash: unknown): hash is string => typeof hash === 'string' && /^0x[a-f\d]{64}$/i.test(hash)
const validAddress = (address: unknown): address is string => typeof address === 'string' && /^0x[a-f\d]{40}$/i.test(address)
const empty = (): Contribution => ({ transfers: 0, swaps: 0, wallets: new Set() })

export class RobinhoodProvisionalSource {
  private readonly rpc: Rpc
  private readonly tokenForPool: (poolId: string) => string | null
  private readonly changed: (tokens: Set<string>) => void
  private readonly blocks = new Map<number, Bucket>()
  private readonly totals = new Map<string, Total>()
  private readonly pendingChanged = new Set<string>()
  private cursor: number | null = null
  private cursorHash: string | null = null
  private finalized: Head | null = null
  private latest: Head | null = null
  private observedAt: number | null = null
  private state: RobinhoodProvisionalStatus['state'] = 'catching_up'
  private reason: string | null = null
  private running = false
  private rollbacks = 0

  constructor(rpc: Rpc, tokenForPool: (poolId: string) => string | null,
    changed: (tokens: Set<string>) => void = () => {}) {
    this.rpc = rpc
    this.tokenForPool = tokenForPool
    this.changed = changed
  }

  private queueChanged(tokens: Iterable<string>): void {
    for (const token of tokens) this.pendingChanged.add(token)
  }

  private flushChanged(): void {
    if (!this.pendingChanged.size) return
    const changed = new Set(this.pendingChanged)
    this.pendingChanged.clear()
    this.changed(changed)
  }

  status(token: string): RobinhoodProvisionalStatus {
    const total = this.totals.get(token.toLowerCase())
    const complete = this.state === 'live'
    return {
      state: this.state,
      reason: this.reason ?? (complete
        ? 'Latest-head activity is unfinalized and can be reversed. Transfer events are not holder balances; swap counts cover only indexed Uniswap v4 pools.'
        : 'Replaying latest-head logs from the finalized boundary.'),
      finality: 'provisional',
      finalizedThroughBlock: this.finalized?.number ?? null,
      observedFromBlock: this.finalized ? this.finalized.number + 1 : null,
      observedThroughBlock: this.cursor,
      observedAt: this.observedAt,
      finalityLagMs: this.latest && this.finalized ? Math.max(0, this.latest.ts - this.finalized.ts) : null,
      holderTransferEvents: complete ? total?.transfers ?? 0 : null,
      touchedWallets: complete ? total?.wallets.size ?? 0 : null,
      knownV4SwapEvents: complete ? total?.swaps ?? 0 : null,
      rollbackCount: this.rollbacks,
    }
  }

  private clear(finalized: Head): void {
    const affected = new Set(this.totals.keys())
    this.blocks.clear()
    this.totals.clear()
    this.cursor = finalized.number
    this.cursorHash = finalized.hash
    this.finalized = finalized
    this.state = 'catching_up'
    this.queueChanged(affected)
  }

  private contribution(bucket: Bucket, token: string): Contribution {
    let c = bucket.byToken.get(token)
    if (!c) { c = empty(); bucket.byToken.set(token, c) }
    return c
  }

  private stage(logs: ChainLog[], from: number, to: number, kind: 'transfer' | 'swap',
    buckets: Map<number, Bucket>, ids: Set<string>): void {
    for (const log of logs) {
      const n = blockNumber(log.blockNumber)
      if (n < from || n > to || log.removed || !validHash(log.blockHash) ||
        !validHash(log.transactionHash) || !Number.isSafeInteger(blockNumber(log.logIndex)))
        throw new Error('Malformed or out-of-range provisional log')
      const key = `${log.transactionHash.toLowerCase()}:${blockNumber(log.logIndex)}`
      if (ids.has(key)) throw new Error('Duplicate provisional log')
      ids.add(key)
      let bucket = buckets.get(n)
      if (!bucket) { bucket = { hash: log.blockHash.toLowerCase(), byToken: new Map() }; buckets.set(n, bucket) }
      if (bucket.hash !== log.blockHash.toLowerCase()) throw new Error('Mixed provisional block hashes')
      if (kind === 'transfer') {
        // ERC-721 shares the Transfer signature but has an indexed token ID.
        // Only the three-topic ERC-20 form represents fungible holder movement.
        if (log.topics.length === 4) continue
        const transfer = decodeTransfer(log)
        if (!transfer || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC)
          throw new Error('Unexpected provisional Transfer log')
        const c = this.contribution(bucket, transfer.token)
        c.transfers++
        if (transfer.from !== ZERO) c.wallets.add(transfer.from)
        if (transfer.to !== ZERO) c.wallets.add(transfer.to)
      } else {
        if (log.address.toLowerCase() !== POOL_MANAGER || log.topics[0]?.toLowerCase() !== SWAP_TOPIC ||
          !validHash(log.topics[1])) throw new Error('Unexpected provisional v4 Swap log')
        const a0 = signedWord(log.data, 0), a1 = signedWord(log.data, 1)
        if (a0 === 0n || a1 === 0n || (a0 > 0n) === (a1 > 0n)) continue
        const token = this.tokenForPool(log.topics[1].toLowerCase())?.toLowerCase()
        if (token && validAddress(token)) this.contribution(bucket, token).swaps++
      }
    }
  }

  private add(bucket: Bucket): void {
    for (const [token, c] of bucket.byToken) {
      let total = this.totals.get(token)
      if (!total) { total = { transfers: 0, swaps: 0, wallets: new Map() }; this.totals.set(token, total) }
      total.transfers += c.transfers
      total.swaps += c.swaps
      for (const wallet of c.wallets) total.wallets.set(wallet, (total.wallets.get(wallet) ?? 0) + 1)
    }
  }

  private remove(bucket: Bucket): void {
    for (const [token, c] of bucket.byToken) {
      const total = this.totals.get(token)
      if (!total) throw new Error('Missing provisional aggregate')
      total.transfers -= c.transfers
      total.swaps -= c.swaps
      for (const wallet of c.wallets) {
        const refs = total.wallets.get(wallet) ?? 0
        if (refs <= 1) total.wallets.delete(wallet)
        else total.wallets.set(wallet, refs - 1)
      }
      if (total.transfers === 0 && total.swaps === 0) this.totals.delete(token)
    }
  }

  private prune(finalized: Head): void {
    const changed = new Set<string>()
    for (const [n, bucket] of this.blocks) {
      if (n > finalized.number) continue
      for (const token of bucket.byToken.keys()) changed.add(token)
      this.remove(bucket)
      this.blocks.delete(n)
    }
    this.finalized = finalized
    if (this.cursor !== null && this.cursor < finalized.number) {
      this.cursor = finalized.number
      this.cursorHash = finalized.hash
    }
    this.queueChanged(changed)
  }

  private async canonicalBlock(n: number): Promise<Head> {
    const block = await this.rpc.call('eth_getBlockByNumber', [hexBlock(n), false]) as ChainBlock
    if (blockNumber(block.number) !== n || !validHash(block.hash)) throw new Error('Invalid canonical provisional block')
    return { number: n, hash: block.hash.toLowerCase(), ts: blockNumber(block.timestamp) * 1000 }
  }

  private async scan(from: number, to: number): Promise<void> {
    const before = await this.canonicalBlock(to)
    const [transfers, swaps] = await Promise.all([
      this.rpc.completeLogs({ topics: [TRANSFER_TOPIC] }, from, to),
      this.rpc.completeLogs({ address: POOL_MANAGER, topics: [SWAP_TOPIC] }, from, to),
    ])
    const buckets = new Map<number, Bucket>()
    const ids = new Set<string>()
    this.stage(transfers, from, to, 'transfer', buckets, ids)
    this.stage(swaps, from, to, 'swap', buckets, ids)
    const after = await this.canonicalBlock(to)
    if (before.hash !== after.hash || buckets.get(to)?.hash && buckets.get(to)?.hash !== after.hash)
      throw new Error('Provisional chain changed while reading logs')
    const changed = new Set<string>()
    for (const [n, bucket] of buckets) {
      if (this.blocks.has(n)) throw new Error('Provisional range overlaps committed block')
      this.blocks.set(n, bucket)
      this.add(bucket)
      for (const token of bucket.byToken.keys()) changed.add(token)
    }
    this.cursor = to
    this.cursorHash = after.hash
    this.queueChanged(changed)
  }

  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const [finalized, latest] = await Promise.all([this.rpc.finalizedHead(), this.rpc.latestHead()])
      if (finalized.number > latest.number) throw new Error('Finalized head exceeds latest head')
      this.latest = latest
      if (this.cursor === null) this.clear(finalized)
      else {
        const canonical = this.cursor > latest.number ? null : await this.canonicalBlock(this.cursor)
        if (!canonical || canonical.hash !== this.cursorHash) {
          this.rollbacks++
          this.clear(finalized)
        }
      }
      this.prune(finalized)
      this.state = 'catching_up'
      while (this.cursor! < latest.number) {
        const from = this.cursor! + 1
        await this.scan(from, Math.min(latest.number, from + 999))
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      this.state = 'live'
      this.reason = null
      this.observedAt = Date.now()
    } catch (error) {
      this.state = 'stale'
      this.reason = `Latest-head replay is waiting for RPC: ${redact(String(error)).slice(0, 180)}`
      throw error
    } finally {
      this.running = false
      this.flushChanged()
    }
  }
}

let source: RobinhoodProvisionalSource | null = null
let started = false
export function robinhoodProvisionalStatus(token: string): RobinhoodProvisionalStatus {
  return source?.status(token) ?? {
    state: 'unconfigured', reason: 'Latest-head Robinhood research source is not enabled.',
    finality: 'provisional', finalizedThroughBlock: null, observedFromBlock: null,
    observedThroughBlock: null, observedAt: null, finalityLagMs: null,
    holderTransferEvents: null, touchedWallets: null, knownV4SwapEvents: null, rollbackCount: 0,
  }
}

export function startRobinhoodProvisional(rpc?: StrictRhRpc): void {
  if (started) return
  started = true
  const upstream = rpc ?? (config.rhHttp ? new StrictRhRpc(config.rhHttp) : null)
  if (!upstream) return
  const seen = new Set((db.prepare("SELECT address FROM research_tokens WHERE chain='robinhood'").all() as { address: string }[])
    .map(row => row.address.toLowerCase()))
  bus.on('research', (chain: string, token: string) => { if (chain === 'robinhood') seen.add(token.toLowerCase()) })
  source = new RobinhoodProvisionalSource(upstream, id => {
    const token = lookupPool('robinhood', id)?.token?.toLowerCase()
    return token && seen.has(token) ? token : null
  }, tokens => { for (const token of tokens) if (seen.has(token)) bus.emit('research', 'robinhood', token, false) })
  let publishedState: string | null = null
  const run = () => void (async () => {
    try { await source!.tick() }
    catch (error) { console.error('[rh:provisional] latest replay pending:', redact(String(error)).slice(0, 260)) }
    const status = source!.status(ZERO)
    const state = `${status.state}:${status.rollbackCount}`
    if (state !== publishedState) {
      publishedState = state
      // The source-wide state/finality or rollback changed. Force visible
      // rows to refetch even when a token has zero events in this window.
      for (const token of seen) bus.emit('research', 'robinhood', token, false)
    }
  })()
  setInterval(run, 3_000).unref()
  run()
}
