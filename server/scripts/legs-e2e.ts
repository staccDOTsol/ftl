// Router + 100x.broker legs, end to end, simulation only:
//   node --env-file-if-exists=.env scripts/legs-e2e.ts <inputMint> <outputMint> <amount> <wallet> [badBeat]
import { createSolanaRouterHandler } from '../src/solana/router.ts'
import { DirectSolanaRouter } from '../src/solana/self-router.ts'
const [inputMint, outputMint, amount, wallet, bad] = process.argv.slice(2)
const RPC = process.env.PROBE_RPC!
const local = new DirectSolanaRouter(RPC, { composerProgramId: '2qiAsxua4dx5SPRD1CDXeNAKDKRepDQ1rags3vAoZ5fN' })
const h: any = createSolanaRouterHandler({ localRouter: local, rpcUrl: RPC } as any)
const q = new URLSearchParams({ inputMint, outputMint, amount, slippageBps: '100', swapMode: 'ExactIn', transactionVersion: '0', ...(bad === '1' ? { badBeat: '1' } : {}) })
const t = Date.now()
const quote = await h.quote(q)
console.log(`quote ${Date.now() - t}ms out ${quote.outAmount} hops ${quote.routePlan.length} legs ${quote.legs?.error ?? `${Number(quote.legs.totalLamports) / 1e9} SOL`} `
  + JSON.stringify(quote.legs?.hops?.map((x: any) => [x.long.ticker ?? x.long.mint.slice(0, 4), x.long.side, x.short.ticker ?? x.short.mint.slice(0, 4), x.short.side])))
const built = await h.buildSwap({ userPublicKey: wallet, quoteResponse: quote, wrapAndUnwrapSol: true, transactionVersion: '0', ...(bad === '1' ? { badBeat: true } : {}) }, true)
const wires: string[] = built.swapTransactions
for (const [i, w] of wires.entries()) {
  const r: any = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'simulateTransaction', params: [w, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }] }) }).then(r => r.json())
  const v = r.result?.value
  console.log(`  ${i + 1}/${wires.length} ${Buffer.from(w, 'base64').length}B ${built.transactionLabels?.[i] ?? ''}: ${v?.err ? 'ERR ' + JSON.stringify(v.err) + ' ' + (v.logs ?? []).filter((l: string) => /failed|Error/.test(l)).slice(0, 2).join(' | ') : 'ok cu ' + v?.unitsConsumed}`)
}
process.exit(0)
