// The research LaserStream delivers ~1.5k finalized mint-matched transactions a
// second. Here, off the API thread, the SDK materializes them and they are
// decoded; the main thread replays the resulting callbacks in emission order.
import { parentPort, workerData } from 'node:worker_threads'
import { blockTimeUsage, setFallbackPrograms, startBlockTimeStream, type BlockTimeStreamOptions } from './blocktime.ts'
import type { HolderTransactionUpdate } from './holders.ts'

type Item = [name: string, args: unknown[]]
let items: Item[] = []
setInterval(() => { if (items.length) { parentPort!.postMessage({ t: 'calls', items }); items = [] } }, 20)
setInterval(() => parentPort!.postMessage({ t: 'usage', usage: blockTimeUsage() }), 1000)

// Fallback results travel in the same ordered stream as the callbacks that
// acknowledged them, as they resolved in-process before.
const fallback = (id: number, programs: string[], lastPrimarySlot?: number | null) => {
  let result: Promise<boolean>
  try { result = setFallbackPrograms(programs, lastPrimarySlot) } catch (error) { result = Promise.reject(error) }
  result.then(applied => { items.push(['@fallback', [id, applied]]) },
    error => { items.push(['@fallback', [id, false, String(error)]]) })
}

type ResearchListener = (chain: string, address: string, enrolled: boolean) => void
let researchListener: ResearchListener | null = null
const earlyResearch: [string, string, boolean][] = []
parentPort!.on('message', (m: any) => {
  if (m?.t === 'research') {
    if (researchListener) researchListener(m.chain, m.address, m.enrolled)
    else earlyResearch.push([m.chain, m.address, m.enrolled])
  } else if (m?.t === 'fallback') fallback(m.id, m.programs, m.lastPrimarySlot)
})

const copyKey = (key: Uint8Array) => new Uint8Array(key)
const slimBalances = (balances: any[] | undefined) => Array.isArray(balances)
  ? balances.map(b => ({ accountIndex: b.accountIndex, mint: b.mint, owner: b.owner, programId: b.programId,
    uiTokenAmount: b.uiTokenAmount ? { amount: b.uiTokenAmount.amount } : undefined }))
  : undefined

// onHolderTransaction reads only slot, index, err, token balances and the
// account keys those balances index. Cloning the whole SDK update would cost
// the main thread most of what moving the stream saves.
function slimHolderUpdate(update: any): HolderTransactionUpdate {
  const info = update.transaction, meta = info?.meta
  if (!info || !meta) return { slot: Number(update.slot) }
  const pre = slimBalances(meta.preTokenBalances), post = slimBalances(meta.postTokenBalances)
  const all: Uint8Array[] = [...(info.transaction?.message?.accountKeys ?? []),
    ...(meta.loadedWritableAddresses ?? []), ...(meta.loadedReadonlyAddresses ?? [])]
  const accountKeys: Uint8Array[] = []
  for (const b of [...(pre ?? []), ...(post ?? [])]) {
    const i = b.accountIndex ?? -1
    if (i >= 0 && all[i] && !accountKeys[i]) accountKeys[i] = copyKey(all[i])
  }
  return { slot: Number(update.slot), transaction: { index: Number(info.index),
    transaction: { message: { accountKeys } },
    meta: { err: meta.err ? true : undefined, preTokenBalances: pre, postTokenBalances: post } } }
}

const options: BlockTimeStreamOptions = {
  ...(workerData.fromSlot === undefined ? {} : { fromSlot: workerData.fromSlot }),
  subscribeResearch: listener => {
    researchListener = listener
    for (const [chain, address, enrolled] of earlyResearch.splice(0)) listener(chain, address, enrolled)
    return () => { researchListener = null }
  },
}
for (const name of workerData.callbacks as (keyof BlockTimeStreamOptions)[]) {
  ;(options as any)[name] = name === 'onHolderTransaction'
    ? (update: unknown) => { items.push([name, [slimHolderUpdate(update)]]) }
    : (...args: unknown[]) => { items.push([name, args]) }
}

if (workerData.fallback) fallback(0, workerData.fallback.programs, workerData.fallback.lastPrimarySlot)
startBlockTimeStream(options).catch(error => { items.push(['onGap', [`research stream could not start: ${String(error)}`]]) })
