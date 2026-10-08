// Pending-swap recovery shared by the token-page trade form and the swap
// terminal. One localStorage key: whichever surface submitted a transaction,
// the other sees it and refuses to start a second swap until it resolves.
import type { Confirmation } from './solana'

export const PENDING_KEY = 'liquidityxyz.solana.pending.v1'
export interface PendingSwap { signature: string; lastValidBlockHeight: number; state: Confirmation }

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/

// Pure: accepts the raw stored string so it can be unit tested without a DOM.
export function parsePending(stored: string | null | undefined): PendingSwap | null {
  try {
    const value = JSON.parse(stored || 'null')
    return value && typeof value === 'object' && value.state === 'pending' && typeof value.signature === 'string' && SIGNATURE.test(value.signature) && Number.isSafeInteger(value.lastValidBlockHeight)
      ? { signature: value.signature, lastValidBlockHeight: value.lastValidBlockHeight, state: 'pending' }
      : null
  } catch { return null }
}

export function readPending(): PendingSwap | null {
  try { return parsePending(localStorage.getItem(PENDING_KEY)) } catch { return null }
}

export function hasPending(): boolean {
  try { return !!localStorage.getItem(PENDING_KEY) } catch { return false }
}

// Persists only while pending; a resolved state clears the key. Throws when a
// pending state cannot be saved so callers never submit without recovery.
export function writePending(value: PendingSwap) {
  try {
    if (value.state === 'pending') localStorage.setItem(PENDING_KEY, JSON.stringify(value))
    else localStorage.removeItem(PENDING_KEY)
  } catch {
    if (value.state === 'pending') throw new Error('Could not save transaction recovery state. Nothing was submitted. Enable local storage and try again.')
  }
}
