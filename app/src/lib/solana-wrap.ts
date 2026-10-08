// Wrap / unwrap SOL: build on the server, verify the returned wire against the
// intent, simulate and price it here before the wallet ever sees it.
import { request, solanaRpc, decodeTransaction, encodeTransaction } from './solana'
import { inspectTransaction } from './solana-wire'
import { assertWrapBuild, type WrapBuild, type WrapIntent } from './solana-wrap-model'
export * from './solana-wrap-model'

export const buildWrap = (intent: WrapIntent) => request<WrapBuild>('/api/wrap/solana', intent)

export const assertWrapIntent = (build: WrapBuild, intent: WrapIntent) => assertWrapBuild(build, intent, inspectTransaction(decodeTransaction(build.transaction)))

export async function simulateWrap(build: WrapBuild, intent: WrapIntent): Promise<number> {
  const wire = assertWrapIntent(build, intent)
  const simulation = await solanaRpc<{ value: { err: unknown } }>('simulateTransaction', [build.transaction, { encoding: 'base64', commitment: 'confirmed', sigVerify: false, replaceRecentBlockhash: true }])
  if (simulation.value.err) throw new Error(`${intent.direction === 'wrap' ? 'Wrap' : 'Unwrap'} simulation failed (${JSON.stringify(simulation.value.err)}). No transaction was sent.`)
  const fee = await solanaRpc<{ value: number | null }>('getFeeForMessage', [encodeTransaction(wire.message), { commitment: 'confirmed' }])
  if (fee.value === null || !Number.isSafeInteger(fee.value) || fee.value < 0) throw new Error('Could not verify the transaction network fee.')
  return fee.value
}
