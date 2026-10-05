import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { identity } from './identity'

export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'https://api.liquidityxyz.fun').replace(/\/$/, '')
export const WS_URL = API_URL.replace(/^http/, 'ws') + '/ws'

export class ApiError extends Error {
  status: number
  constructor(status: number, msg: string) { super(msg); this.status = status }
}

export async function get<T>(path: string, params?: Record<string, string | number | boolean | undefined | null>): Promise<T> {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
  const r = await fetch(`${API_URL}${path}${q.size ? `?${q}` : ''}`)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(r.status, (j as any)?.error ?? `HTTP ${r.status}`)
  return j as T
}

// every write is signed by the device key: FTL\nPOST\n<path>\n<ts>\n<sha256(body)>
export async function post<T>(path: string, body: unknown): Promise<T> {
  const id = await identity()
  const text = JSON.stringify(body ?? {})
  const ts = Date.now()
  const digest = bytesToHex(sha256(new TextEncoder().encode(text)))
  const sig = id.sign(`FTL\nPOST\n${path}\n${ts}\n${digest}`)
  const r = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ftl-pubkey': id.pubkey, 'x-ftl-ts': String(ts), 'x-ftl-sig': sig },
    body: text,
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(r.status, (j as any)?.error ?? `HTTP ${r.status}`)
  return j as T
}
