// Decodes real recent mainnet transactions for every venue through the same
// decoder the lanes use, from JSON-RPC getTransaction. Needs SOLANA_RPC_URL or DRPC_KEY.

import { test } from 'node:test'
import assert from 'node:assert'
import bs58 from 'bs58'
import { decode, parseWire, type NTx } from '../src/solana/decode.ts'
import { programIds, venueOf } from '../src/solana/programs.ts'

const RPC = process.env.SOLANA_RPC_URL ?? (process.env.DRPC_KEY ? `https://lb.drpc.live/solana/${process.env.DRPC_KEY}` : '')

async function rpc(method: string, params: unknown[]) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const j = await r.json() as any
  if (j.error) throw new Error(JSON.stringify(j.error))
  return j.result
}

export function fromRpc(sig: string, t: any): NTx {
  const w = parseWire(Buffer.from(t.transaction[0], 'base64'))
  const keys = [...w.keys.map(k => bs58.encode(k)), ...(t.meta?.loadedAddresses?.writable ?? []), ...(t.meta?.loadedAddresses?.readonly ?? [])]
  const ixs = w.ixs.map((ix, i) => ({ prog: keys[ix.prog], accts: ix.accts, data: ix.data, n: String(i) }))
  for (const g of t.meta?.innerInstructions ?? [])
    g.instructions.forEach((ix: any, j: number) => ixs.push({ prog: keys[ix.programIdIndex], accts: ix.accounts, data: bs58.decode(ix.data), n: `${g.index}.${j}` }))
  const bal = (a: any[]) => (a ?? []).map(b => ({ idx: b.accountIndex, mint: b.mint, owner: b.owner, amount: BigInt(b.uiTokenAmount.amount), decimals: b.uiTokenAmount.decimals }))
  return {
    sig, slot: t.slot, keys, ixs, failed: !!t.meta?.err, pre: bal(t.meta?.preTokenBalances), post: bal(t.meta?.postTokenBalances),
    lamports: { pre: t.meta.preBalances.map(BigInt), post: t.meta.postBalances.map(BigInt), fee: BigInt(t.meta.fee) },
  }
}

async function batch(sigs: string[]) {
  const out: any[] = []
  for (let i = 0; i < sigs.length; i += 50) {
    const body = sigs.slice(i, i + 50).map((s, k) => ({ jsonrpc: '2.0', id: k, method: 'getTransaction', params: [s, { encoding: 'base64', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }] }))
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const j = await r.json() as any[]
    const by = new Map(j.map(x => [x.id, x.result]))
    body.forEach(b => out.push(by.get(b.id) ?? null))
  }
  return out
}

// accounts that sit only in the rare transactions: pump.fun mint authority (create), pump migration
// wallet (migrate + pumpswap create_pool), Raydium CPMM / AMM v4 pool-creation fee receivers
const RARE = (process.env.RARE ? process.env.RARE.split(',') : null) ?? ['TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM', '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg', 'DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8', '7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5']

test('decodes recent transactions for every venue', { skip: !RPC, timeout: 600_000 }, async () => {
  const summary: Record<string, Record<string, number>> = {}
  for (const program of (process.env.RARE ? RARE : [...programIds, ...RARE])) {
    const venue = venueOf.get(program) ?? `rare:${program.slice(0, 6)}`
    const sigs = await rpc('getSignaturesForAddress', [program, { limit: 1000 }])
    const ok = sigs.filter((s: any) => !s.err).slice(0, Number(process.env.SAMPLE ?? 400)).map((s: any) => ({ signature: s.signature }))
    const txs = await batch(ok.map((s: any) => s.signature))
    summary[venue] = {}
    for (let i = 0; i < txs.length; i++) {
      const t = txs[i]
      if (!t) continue
      const evs = decode(fromRpc(ok[i].signature, t), 'geyser', 'confirmed')
      for (const e of evs) {
        summary[venue][`${e.kind}:${e.ix}`] = (summary[venue][`${e.kind}:${e.ix}`] ?? 0) + 1
        if (e.kind !== 'launch' && e.kind !== 'graduate') assert.ok(e.pool, `${venue} ${e.ix} has a pool (${e.tx})`)
        if (e.kind === 'liq_add' || e.kind === 'liq_remove' || (e.kind === 'pool_init')) {
          if (!e.amounts?.length) console.log('   no amounts', venue, e.ix, e.tx)
        }
        if (summary[venue][`${e.kind}:${e.ix}`] === 1) console.log('  ', venue, e.kind, e.ix, 'pool', e.pool?.slice(0, 8), 'mints', e.mints.map(m => m.slice(0, 6)).join('/'), 'amounts', JSON.stringify(e.amounts?.map(a => [a.mint.slice(0, 4), +a.ui.toPrecision(4)])), e.noLiquidity ? 'NO-LIQ' : '', e.tx.slice(0, 10))
      }
    }
  }
  console.log(JSON.stringify(summary, null, 1))
})
