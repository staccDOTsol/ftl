import { PublicKey } from '@solana/web3.js'
import { createHash } from 'node:crypto'
import type { InstructionSample } from './program-observation.ts'

const EVENT_CPI = Buffer.from('e445a52e51cb9a1d', 'hex')
const eventAuthorities = new Map<string, string>()
const flat = (accounts: any[]): any[] => (accounts ?? []).flatMap(account => account.accounts ? flat(account.accounts) : [account])
export const selectorFor = (ix: any): number[] => ix.discriminator ?? [...createHash('sha256').update(`global:${String(ix.name).replace(/[A-Z]/g, c => '_' + c.toLowerCase())}`).digest().subarray(0, 8)]

export function runtimeEventSample(sample: InstructionSample, program: string): boolean {
  if (!sample.inner || sample.accounts.length !== 1) return false
  const bytes = Buffer.from(sample.data, 'base64')
  if (bytes.length < 16 || !bytes.subarray(0, 8).equals(EVENT_CPI)) return false
  try {
    let authority = eventAuthorities.get(program)
    if (!authority) {
      authority = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], new PublicKey(program))[0].toBase58()
      eventAuthorities.set(program, authority)
    }
    return sample.accounts[0].address === authority
  } catch { return false }
}

export function interfaceMatch(ix: any, sample: InstructionSample, learned: boolean): boolean {
  const bytes = Buffer.from(sample.data, 'base64'), selector = Buffer.from(selectorFor(ix)), accounts = flat(ix.accounts)
  if (!selector.length || !bytes.subarray(0, selector.length).equals(selector) || sample.accounts.length < accounts.length) return false
  if ((learned || ix.observedIn) && sample.accounts.length !== accounts.length) return false
  if (Array.isArray(ix.argBytes) && !ix.argBytes.includes(bytes.length - selector.length)) return false
  return accounts.every((account, i) => {
    const observed = sample.accounts[i]
    if (account.address && account.address !== observed.address) return false
    if (!sample.inner && (account.signer ?? account.isSigner) === true && observed.signer === false) return false
    if (!sample.inner && (account.writable ?? account.isMut) === true && observed.writable === false) return false
    return true
  })
}

export function indexableSamples(samples: InstructionSample[], address: string) {
  const events = samples.filter(sample => runtimeEventSample(sample, address))
  const missing = samples.filter(sample => !sample.data || sample.rawDataKnown === false)
  return { samples: samples.filter(sample => !events.includes(sample) && !missing.includes(sample)), runtimeEvents: events.length, missingData: missing.length }
}

// Supplement a published IDL only with instruction shapes the actual Composer
// learned and that match real observed bytes/accounts. No catch-all selector or
// invented schema is used to turn an unknown encoding into "complete" coverage.
export function mergeLearnedInstructions(idl: any, learned: any, samples: InstructionSample[]) {
  if (!learned || learned.address !== (idl.address ?? idl.metadata?.address) || !Array.isArray(learned.instructions)) return idl
  const document = structuredClone(idl)
  const usable = indexableSamples(samples, learned.address).samples
  const gaps = usable.filter(sample => !document.instructions.some((ix: any) => interfaceMatch(ix, sample, false)))
  let added = 0
  for (const candidate of learned.instructions) {
    if (!gaps.some(sample => interfaceMatch(candidate, sample, true))) continue
    if (document.instructions.some((ix: any) => JSON.stringify(selectorFor(ix)) === JSON.stringify(selectorFor(candidate)) && flat(ix.accounts).length === flat(candidate.accounts).length)) continue
    document.instructions.push(candidate); added++
  }
  if (added) {
    document.evidence = { ...document.evidence, composerSupplement: learned.evidence, publishedBase: true, composerExtensions: added }
    document.caveats = [...(document.caveats ?? []), ...(learned.caveats ?? []),
      'Published instructions retain their declared ABI. Supplemental instructions retain the Composer’s inferred names, positional accounts and opaque-argument evidence.']
  }
  return document
}
