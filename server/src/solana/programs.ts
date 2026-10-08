// Solana venues FTL follows, and what each instruction means to it.
// Anchor IDLs supply discriminators and account order; the classifier maps
// instruction names onto FTL kinds. Raydium AMM v4 is native and hand-written.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Kind } from '../../../shared/types.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const idlDir = path.join(here, '..', '..', 'idl')

export interface IxSpec {
  program: string
  venue: string
  name: string
  kind: Kind
  accounts: string[]
  fundsOnInit?: boolean     // a pool_init that deposits the first liquidity itself
}

const VENUES: { file: string; venue: string }[] = [
  { file: 'orca_whirlpool.json', venue: 'orca' },
  { file: 'raydium_clmm.json', venue: 'raydium-clmm' },
  { file: 'raydium_cp_swap.json', venue: 'raydium-cpmm' },
  { file: 'raydium_launchpad.json', venue: 'raydium-launchlab' },
  { file: 'meteora_dlmm.json', venue: 'meteora-dlmm' },
  { file: 'meteora_damm_v1.json', venue: 'meteora-damm' },
  { file: 'meteora_damm_v2.json', venue: 'meteora-damm-v2' },
  { file: 'meteora_dbc.json', venue: 'meteora-dbc' },
  { file: 'pump.json', venue: 'pumpfun' },
  { file: 'pump_amm.json', venue: 'pumpswap' },
]

// name -> kind, per venue where names collide in meaning (cpmm `initialize` is a pool, launchpad `initialize` is a launch)
function classify(venue: string, name: string): { kind: Kind; fundsOnInit?: boolean } | null {
  const n = name
  if (venue === 'pumpfun') {
    if (n === 'create' || n === 'create_v2') return { kind: 'launch' }
    if (n === 'migrate' || n === 'migrate_v2') return { kind: 'graduate' }
    return null
  }
  if (venue === 'raydium-launchlab') {
    if (/^initialize(_v2|_with_token_2022)?$/.test(n)) return { kind: 'launch' }
    if (/^migrate_to_(amm|cpswap)$/.test(n)) return { kind: 'graduate' }
    return null
  }
  if (venue === 'meteora-dbc') {
    if (/^initialize_virtual_pool_with_/.test(n)) return { kind: 'launch' }
    if (n === 'migrate_meteora_damm' || n === 'migration_damm_v2') return { kind: 'graduate' }
    return null
  }
  if (venue === 'pumpswap') {
    if (n === 'create_pool') return { kind: 'pool_init', fundsOnInit: true }
    if (n === 'deposit') return { kind: 'liq_add' }
    if (n === 'withdraw') return { kind: 'liq_remove' }
    return null
  }
  if (venue === 'raydium-cpmm') {
    if (n === 'initialize' || n === 'initialize_with_permission') return { kind: 'pool_init', fundsOnInit: true }
    if (n === 'deposit') return { kind: 'liq_add' }
    if (n === 'withdraw') return { kind: 'liq_remove' }
    return null
  }
  if (venue === 'raydium-clmm') {
    if (n === 'create_pool' || n === 'create_customizable_pool') return { kind: 'pool_init' }
    if (/^(increase_liquidity(_v2)?|open_position(_v2|_with_token22_nft)?)$/.test(n)) return { kind: 'liq_add' }
    if (/^decrease_liquidity(_v2)?$/.test(n)) return { kind: 'liq_remove' }
    return null
  }
  if (venue === 'orca') {
    if (/^initialize_pool/.test(n)) return { kind: 'pool_init' }
    if (/^increase_liquidity/.test(n)) return { kind: 'liq_add' }
    if (/^decrease_liquidity/.test(n)) return { kind: 'liq_remove' }
    return null
  }
  if (venue === 'meteora-dlmm') {
    if (/^initialize_(lb_pair2?|customizable_permissionless_lb_pair2?|permission_lb_pair)$/.test(n)) return { kind: 'pool_init' }
    if (/^add_liquidity/.test(n)) return { kind: 'liq_add' }
    if (/^remove_(all_)?liquidity/.test(n)) return { kind: 'liq_remove' }
    return null
  }
  if (venue === 'meteora-damm') {
    if (/^initialize_(permissionless|customizable_permissionless|permissioned)/.test(n)) return { kind: 'pool_init', fundsOnInit: true }
    if (/^(add_balance_liquidity|add_imbalance_liquidity|bootstrap_liquidity)$/.test(n)) return { kind: 'liq_add' }
    if (/^(remove_balance_liquidity|remove_liquidity_single_side)$/.test(n)) return { kind: 'liq_remove' }
    return null
  }
  if (venue === 'meteora-damm-v2') {
    if (/^initialize_(pool|customizable_pool|pool_with_dynamic_config)$/.test(n)) return { kind: 'pool_init', fundsOnInit: true }
    if (n === 'add_liquidity') return { kind: 'liq_add' }
    if (n === 'remove_liquidity' || n === 'remove_all_liquidity') return { kind: 'liq_remove' }
    return null
  }
  return null
}

export const RAYDIUM_AMM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'

export const specs = new Map<string, Map<string, IxSpec>>()   // program -> disc hex -> spec
export const programIds: string[] = []
export const venueOf = new Map<string, string>()

for (const v of VENUES) {
  const idl = JSON.parse(fs.readFileSync(path.join(idlDir, v.file), 'utf8'))
  const program: string = idl.address ?? idl.metadata?.address
  const m = new Map<string, IxSpec>()
  for (const ix of idl.instructions) {
    const name: string = ix.name.replace(/[A-Z]/g, (c: string) => '_' + c.toLowerCase())
    const c = classify(v.venue, name)
    if (!c) continue
    const disc: number[] = ix.discriminator ?? [...crypto.createHash('sha256').update('global:' + name).digest().subarray(0, 8)]
    const accounts = flattenAccounts(ix.accounts)
    m.set(Buffer.from(disc).toString('hex'), { program, venue: v.venue, name, kind: c.kind, accounts, fundsOnInit: c.fundsOnInit })
  }
  specs.set(program, m)
  programIds.push(program)
  venueOf.set(program, v.venue)
}

// Raydium AMM v4: one-byte tags, accounts by position (serum-less layouts drop the trailing market accounts)
{
  const m = new Map<string, IxSpec>()
  m.set('01', { program: RAYDIUM_AMM_V4, venue: 'raydium-amm', name: 'initialize2', kind: 'pool_init', fundsOnInit: true,
    accounts: ['token_program', 'associated_token_program', 'system_program', 'rent', 'amm', 'amm_authority', 'amm_open_orders', 'lp_mint', 'coin_mint', 'pc_mint', 'pool_coin_token_account', 'pool_pc_token_account', 'pool_withdraw_queue', 'amm_target_orders', 'pool_temp_lp', 'serum_program', 'serum_market', 'user_wallet', 'user_token_coin', 'user_token_pc', 'user_lp_token_account'] })
  m.set('03', { program: RAYDIUM_AMM_V4, venue: 'raydium-amm', name: 'deposit', kind: 'liq_add',
    accounts: ['token_program', 'amm', 'amm_authority', 'amm_open_orders', 'amm_target_orders', 'lp_mint', 'pool_coin_token_account', 'pool_pc_token_account', 'serum_market', 'user_coin_token_account', 'user_pc_token_account', 'user_lp_token_account', 'user_owner', 'serum_event_queue'] })
  m.set('04', { program: RAYDIUM_AMM_V4, venue: 'raydium-amm', name: 'withdraw', kind: 'liq_remove',
    accounts: ['token_program', 'amm', 'amm_authority', 'amm_open_orders', 'amm_target_orders', 'lp_mint', 'pool_coin_token_account', 'pool_pc_token_account'] })
  specs.set(RAYDIUM_AMM_V4, m)
  programIds.push(RAYDIUM_AMM_V4)
  venueOf.set(RAYDIUM_AMM_V4, 'raydium-amm')
}

function flattenAccounts(accts: any[]): string[] {
  const out: string[] = []
  for (const a of accts ?? []) {
    if (a.accounts) out.push(...flattenAccounts(a.accounts))
    else out.push(String(a.name).replace(/[A-Z]/g, (c: string) => '_' + c.toLowerCase()))
  }
  return out
}

export function lookup(program: string, data: Uint8Array): IxSpec | null {
  const m = specs.get(program)
  if (!m || data.length < 1) return null
  if (program === RAYDIUM_AMM_V4) return m.get(Buffer.from(data.subarray(0, 1)).toString('hex')) ?? null
  if (data.length < 8) return null
  return m.get(Buffer.from(data.subarray(0, 8)).toString('hex')) ?? null
}

// ---- account roles ----------------------------------------------------------

const POOL_NAMES = ['whirlpool', 'pool_state', 'lb_pair', 'pool', 'amm', 'virtual_pool', 'pool_id']
const MINT_PAIRS: [string, string][] = [
  ['token_mint_a', 'token_mint_b'], ['token_mint_0', 'token_mint_1'], ['token_0_mint', 'token_1_mint'], ['vault_0_mint', 'vault_1_mint'],
  ['token_x_mint', 'token_y_mint'], ['token_mint_x', 'token_mint_y'], ['token_a_mint', 'token_b_mint'], ['base_mint', 'quote_mint'], ['coin_mint', 'pc_mint'], ['mint_a', 'mint_b'],
]
const LAUNCH_MINT = ['mint', 'base_mint', 'token_mint', 'token_a_mint']

export function roles(spec: IxSpec) {
  const idx = (n: string) => spec.accounts.indexOf(n)
  const pool = POOL_NAMES.map(idx).find(i => i >= 0) ?? -1
  let mints: number[] = []
  const dbcLaunch = spec.venue === 'meteora-dbc' && spec.kind === 'launch'
  if (dbcLaunch) {
    mints = [idx('base_mint'), idx('quote_mint')].filter(i => i >= 0)
  } else if (spec.kind === 'launch' || spec.kind === 'graduate') {
    const i = LAUNCH_MINT.map(idx).find(i => i >= 0)
    if (i !== undefined) mints = [i]
  } else {
    for (const [a, b] of MINT_PAIRS) {
      const ia = idx(a), ib = idx(b)
      if (ia >= 0 && ib >= 0) { mints = [ia, ib]; break }
    }
  }
  // accounts that hold the pool's reserves: their balance change is the liquidity that moved
  const vaults = spec.accounts.map((n, i) => (/(^|_)vault(_|$)|^reserve(_[xy])?$|^token_vault_|^pool_(coin|pc|base|quote)_token_account$|_vault_[ab01]$/.test(n) && !/authority|lp|program|bin_array|event|config|signer|_mint$/.test(n)) ? i : -1).filter(i => i >= 0)
  // single-mint instructions (DLMM one-side adds) still name the side they touch
  if (!mints.length && spec.kind !== 'launch' && spec.kind !== 'graduate') { const i = idx('token_mint'); if (i >= 0) mints = [i] }
  return { pool: (spec.kind === 'launch' && !dbcLaunch) || spec.kind === 'graduate' ? -1 : pool, mints, vaults }
}

export const roleCache = new Map<IxSpec, ReturnType<typeof roles>>()
export function rolesOf(spec: IxSpec) {
  let r = roleCache.get(spec)
  if (!r) { r = roles(spec); roleCache.set(spec, r) }
  return r
}
