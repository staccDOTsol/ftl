// The device keypair is the account: an ed25519 key whose public half is a
// Solana address. Native keeps the seed in the keychain/keystore; web keeps it
// in localStorage.

import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import * as Crypto from 'expo-crypto'
import nacl from 'tweetnacl'
import bs58 from 'bs58'

const KEY = 'ftl.seed.v1'

export interface Identity { pubkey: string; sign: (msg: string) => string }

async function load(): Promise<string | null> {
  if (Platform.OS === 'web') { try { return globalThis.localStorage?.getItem(KEY) ?? null } catch { return null } }
  return SecureStore.getItemAsync(KEY)
}
async function save(v: string) {
  if (Platform.OS === 'web') { try { globalThis.localStorage?.setItem(KEY, v) } catch {} return }
  await SecureStore.setItemAsync(KEY, v)
}

let cached: Promise<Identity> | null = null
export function identity(): Promise<Identity> {
  cached ??= (async () => {
    let seedB58 = await load()
    if (!seedB58) { seedB58 = bs58.encode(Crypto.getRandomBytes(32)); await save(seedB58) }
    const kp = nacl.sign.keyPair.fromSeed(bs58.decode(seedB58))
    return {
      pubkey: bs58.encode(kp.publicKey),
      sign: (msg: string) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey)),
    }
  })()
  return cached
}

export async function clearIdentity(): Promise<void> {
  try {
    if (Platform.OS === 'web') globalThis.localStorage?.removeItem(KEY)
    else await SecureStore.deleteItemAsync(KEY)
  } finally {
    cached = null
  }
}
