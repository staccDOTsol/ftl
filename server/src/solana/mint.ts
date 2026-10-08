// Dependency-free so the research stream worker can validate mints without
// loading research.ts and the hub it starts.
import bs58 from 'bs58'

export function validSolanaMint(address: unknown): address is string {
  if (typeof address !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false
  try { return bs58.decode(address).length === 32 } catch { return false }
}
