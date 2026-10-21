// Probe the direct router locally: why does a pair quote or not? Usage:
//   node --env-file-if-exists=.env scripts/route-probe.ts <inputMint> <outputMint> <amount>
import { DirectSolanaRouter } from '../src/solana/self-router.ts'
const [inputMint, outputMint, amount] = process.argv.slice(2)
const rpc = process.env.PROBE_RPC ?? process.env.SOLANA_RPC_URL!
const r = new DirectSolanaRouter(rpc, { composerProgramId: '2qiAsxua4dx5SPRD1CDXeNAKDKRepDQ1rags3vAoZ5fN' })
const t = Date.now()
try {
  const { quote } = await r.quote({ inputMint, outputMint, amount, slippageBps: 100, transactionVersion: '0' })
  console.log(`OK ${Date.now() - t}ms out ${quote.outAmount} hops ${quote.routePlan.length} [${quote.routePlan.map((h: any) => h.swapInfo.label).join(' > ')}]`)
} catch (e: any) {
  console.log(`FAIL ${Date.now() - t}ms ${e?.status ?? ''} ${e?.message}`)
}
process.exit(0)
