// Token-2022 direct-swap probe: quote, build and simulate (never send) the
// pairs that used to fail because their mints are Token-2022.
//   node --env-file-if-exists=.env scripts/token2022-probe.ts [--each] [--match <text>]
// The router reads pools from a throwaway DATA_DIR (never data/ftl.db). The
// local index and Birdeye are both empty here, so pools come from
// DexScreener's public pair list plus the canonical PumpSwap pool PDA, and are
// inserted as funded rows. `--each` also probes the deepest pool of every
// supported venue on its own (plus CPMM / DAMM v2 Token-2022 pools and a
// transfer-fee mint that must be refused), so venues the router would not
// pick get tested. `--match` keeps only probes whose label contains the text.
// PROBE_WALLET overrides the simulated wallet (e.g. a holder of the input).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js'
import { canonicalPumpPoolPda, PUMP_AMM_PROGRAM_ID } from '@pump-fun/pump-swap-sdk'

const RPC = process.env.PROBE_RPC ?? 'https://mainnet.helius-rpc.com/?api-key=f5f1e120-3a60-4e11-a9ed-2b91856e664a'
const COMPOSER = '2qiAsxua4dx5SPRD1CDXeNAKDKRepDQ1rags3vAoZ5fN'
const WALLET = process.env.PROBE_WALLET ?? '331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth'
const SOL = 'So11111111111111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
const XBRO = 'Fr28jEWz2msSCKLaHzus2nCKrwqbpTx2EyDYtsVVpump'
const SI = '3VPoXaRcXxju8qgkVRN87UuXZxbdBD7zyaXPDqqmpump'
const PUMP = 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn'
// Venue coverage only: Token-2022 mints with Raydium CPMM / Meteora DAMM v2
// pools, and a 30%/25% transfer-fee mint the router must refuse.
const DHC = 'DCHLn5uLCDjPcmyxqeV3EFA1hAT518RR3u7gQe8iUiYQ'
const VBC = '6N7aaD1NdJoxXGKVAPdt2Ajbnz862e2dXFt426YPNaKb'
const SOLADAO = 'AY2sSqL3wWTfuevCoRBqkvMoawArCunRfpnPzVmuxXoi'
const NAMES: Record<string, string> = { [SOL]: 'SOL', [USDC]: 'USDC', [BONK]: 'BONK', [XBRO]: '100XBRO', [SI]: 'SI',
  [PUMP]: 'PUMP', [DHC]: 'DHC', [VBC]: 'VBC', [SOLADAO]: 'SolaDao(fee)' }
const each = process.argv.includes('--each')
const matchAt = process.argv.indexOf('--match')
const match = matchAt > 0 ? process.argv[matchAt + 1] ?? '' : ''

const dataDir = process.env.PROBE_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ftl-t22-probe-'))
process.env.DATA_DIR = dataDir
const { db } = await import('../src/db.ts')
const { DirectSolanaRouter } = await import('../src/solana/self-router.ts')
const connection = new Connection(RPC, 'confirmed')

type Pool = { address: string; venue: string; mint_a: string; mint_b: string; liq: number }
const pairKey = (a: string, b: string) => [a, b].sort().join(':')

/** DexScreener dexId + labels → the router's venue key (unsupported venues drop out). */
function venueOf(dexId: string, labels: string[]): string | null {
  if (dexId === 'pumpswap') return 'pumpswap'
  if (dexId === 'orca') return 'orca'
  if (dexId === 'raydium') return labels.includes('CPMM') ? 'raydium-cpmm' : labels.includes('CLMM') ? 'raydium-clmm' : null
  if (dexId === 'meteora') return labels.includes('DLMM') ? 'meteora-dlmm' : labels.includes('DYN2') ? 'meteora-damm-v2' : null
  return null
}

const discovered = new Map<string, Pool[]>()
async function poolsFor(a: string, b: string): Promise<Pool[]> {
  const key = pairKey(a, b)
  if (discovered.has(key)) return discovered.get(key)!
  const token = a === SOL || a === USDC ? b : a
  const found: Pool[] = []
  try {
    const r = await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${token}`, { signal: AbortSignal.timeout(10_000) })
    const rows = r.ok ? await r.json() as any[] : []
    for (const p of rows) {
      const venue = venueOf(String(p.dexId), Array.isArray(p.labels) ? p.labels : [])
      const x = p.baseToken?.address, y = p.quoteToken?.address
      if (!venue || pairKey(x, y) !== key) continue
      found.push({ address: p.pairAddress, venue, mint_a: x, mint_b: y, liq: Math.max(1, Math.round(p.liquidity?.usd ?? 0)) })
    }
  } catch (error) { console.log(`  dexscreener ${token}: ${(error as Error).message}`) }
  // Pump coins graduate into the canonical PumpSwap pool against WSOL.
  for (const [base, quote] of [[a, b], [b, a]]) {
    if (quote !== SOL) continue
    const pda = canonicalPumpPoolPda(new PublicKey(base)).toBase58()
    if (found.some(p => p.address === pda)) continue
    const info = await connection.getAccountInfo(new PublicKey(pda))
    if (info?.owner.equals(PUMP_AMM_PROGRAM_ID)) found.push({ address: pda, venue: 'pumpswap', mint_a: base, mint_b: quote, liq: 1 })
  }
  found.sort((x, y) => y.liq - x.liq)
  discovered.set(key, found)
  return found
}

function seed(pools: Pool[]) {
  db.exec(`DELETE FROM pools`)
  const insert = db.prepare(`INSERT OR REPLACE INTO pools (chain,address,venue,mint_a,mint_b,liq_events,funded,created_ts)
    VALUES ('solana',?,?,?,?,?,1,0)`)
  for (const p of pools) insert.run(p.address, p.venue, p.mint_a, p.mint_b, p.liq)
}

async function simulate(wire: string): Promise<{ err: unknown; logs: string[]; units: number | null }> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'simulateTransaction',
      params: [wire, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }] }) })
  const j = await r.json() as any
  if (j.error) return { err: j.error, logs: [], units: null }
  return { err: j.result.value.err, logs: j.result.value.logs ?? [], units: j.result.value.unitsConsumed ?? null }
}

async function balances() {
  const owner = new PublicKey(WALLET)
  const lamports = await connection.getBalance(owner)
  const out: Record<string, string> = { SOL: (lamports / 1e9).toFixed(4) }
  for (const program of ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']) {
    const { value } = await connection.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(program) })
    for (const { account } of value) {
      const info = (account.data as any).parsed.info
      if (NAMES[info.mint]) out[NAMES[info.mint]] = info.tokenAmount.amount
    }
  }
  return out
}

type Row = { pair: string; pools: string; quote: string; hops: string; venues: string; simulate: string }
const table: Row[] = []
async function probe(label: string, inputMint: string, outputMint: string, amount: string, only?: Pool) {
  if (match && !label.includes(match)) return null
  const pools = only ? [only] : await poolsFor(inputMint, outputMint)
  seed(pools)
  const router = new DirectSolanaRouter(RPC, { composerProgramId: COMPOSER })
  const intent = { inputMint, outputMint, amount, slippageBps: 100, transactionVersion: '0' as const }
  const row: Row = { pair: label, pools: pools.map(p => `${p.venue}:${p.address.slice(0, 6)}`).slice(0, 4).join(' ') || '-',
    quote: '', hops: '', venues: '', simulate: '' }
  console.log(`\n== ${label} (${amount})`)
  let minimum: string
  try {
    const { quote } = await router.quote(intent)
    minimum = quote.otherAmountThreshold
    row.quote = `ok out=${quote.outAmount} min=${minimum}`
    row.hops = String(quote.hops ?? quote.routePlan.length)
    row.venues = quote.routePlan.map((h: any) => `${h.swapInfo.label}@${h.swapInfo.ammKey.slice(0, 6)}`).join(' > ')
    console.log(`  quote ${row.quote} via ${row.venues}${quote.composed ? ' (composed)' : ''}`)
  } catch (error: any) {
    row.quote = `FAIL ${error?.status ?? ''} ${error?.message}`
    console.log(`  quote ${row.quote}`)
    table.push(row)
    return null
  }
  try {
    const built = await router.swap(intent, WALLET, minimum)
    const wires: string[] = built.swapTransactions ?? [built.swapTransaction]
    const results: string[] = []
    for (const [i, wire] of wires.entries()) {
      let size = Buffer.from(wire, 'base64').length, version = '?'
      try { version = String(VersionedTransaction.deserialize(Buffer.from(wire, 'base64')).version) } catch { version = 'v1?' }
      const sim = await simulate(wire)
      const ok = sim.err === null
      results.push(ok ? `tx${i} ok (${sim.units} CU)` : `tx${i} ERR ${JSON.stringify(sim.err)}`)
      console.log(`  tx${i} v${version} ${size}B simulate ${ok ? `ok ${sim.units} CU` : `ERR ${JSON.stringify(sim.err)}`}`)
      if (!ok) for (const line of sim.logs.slice(-12)) console.log(`     | ${line}`)
    }
    row.simulate = results.join('; ')
  } catch (error: any) {
    row.simulate = `swap FAIL ${error?.status ?? ''} ${error?.message}`
    console.log(`  ${row.simulate}`)
  }
  table.push(row)
  return minimum
}

console.log(`DATA_DIR ${dataDir}`)
console.log('wallet balances (atomic)', await balances())
const bought = await probe('SOL→100XBRO', SOL, XBRO, '10000000')
await probe('100XBRO→SOL', XBRO, SOL, bought ?? '1000000000')
await probe('SOL→SI', SOL, SI, '10000000')
await probe('SOL→PUMP', SOL, PUMP, '10000000')
await probe('USDC→PUMP', USDC, PUMP, '1000000')
await probe('BONK→USDC', BONK, USDC, '100000000000')

if (each) {
  const pairs: [string, string, string][] = [[SOL, XBRO, '10000000'], [SOL, SI, '10000000'],
    [SOL, PUMP, '10000000'], [USDC, PUMP, '1000000'], [BONK, USDC, '100000000000'],
    // Token-2022 on the input side of every venue (the wallet holds PUMP).
    [PUMP, SOL, '10000000'], [PUMP, USDC, '10000000'],
    [SOL, DHC, '10000000'], [SOL, VBC, '10000000'], [SOL, SOLADAO, '10000000']]
  for (const [a, b, amount] of pairs) {
    const seen = new Set<string>()
    for (const pool of await poolsFor(a, b)) {
      if (seen.has(pool.venue)) continue
      seen.add(pool.venue)
      await probe(`${NAMES[a]}→${NAMES[b]} [${pool.venue} only]`, a, b, amount, pool)
    }
  }
}

console.log('\n| pair | pools offered | quote | hops | route | simulate |\n|---|---|---|---|---|---|')
for (const r of table) console.log(`| ${r.pair} | ${r.pools} | ${r.quote} | ${r.hops} | ${r.venues} | ${r.simulate} |`)
process.exit(0)
