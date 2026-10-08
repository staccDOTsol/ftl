// Pure wrap/unwrap rules: what a server-built wrap transaction must look like
// before it is simulated or shown to a wallet. No network, no React.
import type { TransactionVersion, WireTransaction } from './solana-wire'

export type WrapDirection = 'wrap' | 'unwrap'
export interface WrapIntent { owner: string; direction: WrapDirection; lamports?: string; transactionVersion: TransactionVersion }
export interface WrapBuild {
  transaction: string; lastValidBlockHeight: number; transactionVersion: TransactionVersion; expectedSigners: string[]
  summary: { direction: WrapDirection; lamports: string; tokenAccount: string; createsTokenAccount?: boolean }
}

export function assertWrapBuild(build: WrapBuild, intent: WrapIntent, wire: WireTransaction): WireTransaction {
  if (!Number.isSafeInteger(build.lastValidBlockHeight) || build.lastValidBlockHeight <= 0) throw new Error('The wrap transaction has no valid expiry.')
  if (build.summary?.direction !== intent.direction || (intent.direction === 'wrap' && build.summary.lamports !== intent.lamports)) throw new Error('The server returned a different wrap operation than requested.')
  if (!/^[1-9][0-9]{0,19}$/.test(build.summary.lamports)) throw new Error('The wrap amount is not a positive integer.')
  if (wire.version !== intent.transactionVersion || build.transactionVersion !== intent.transactionVersion) throw new Error('The server returned a transaction version this wallet did not request.')
  if (wire.feePayer !== intent.owner || wire.requiredSignatures !== 1 || JSON.stringify(wire.signerKeys) !== JSON.stringify([intent.owner]) || JSON.stringify(build.expectedSigners) !== JSON.stringify([intent.owner])) {
    throw new Error('The wrap transaction requests an unexpected signer.')
  }
  return wire
}
