// Everything FTL reads from the environment. Secrets never leave this module
// except as connection parameters; log lines use `redact()`.

const env = (k: string): string | undefined => {
  const v = process.env[k]
  return v && v.trim() ? v.trim() : undefined
}
const on = (k: string): boolean => env(k) === '1'

const drpcKey = env('DRPC_KEY')
const solanaRpc = env('SOLANA_RPC_URL') ?? (drpcKey ? `https://lb.drpc.live/solana/${drpcKey}` : undefined)
const yellowstoneMaxMibPerHour = Number(env('YELLOWSTONE_MAX_MIB_PER_HOUR') ?? 0)
if (!Number.isSafeInteger(yellowstoneMaxMibPerHour) || yellowstoneMaxMibPerHour < 0 || yellowstoneMaxMibPerHour > 1024 * 1024)
  throw new Error('YELLOWSTONE_MAX_MIB_PER_HOUR must be a non-negative integer')
const laserstreamMaxMibPerHour = Number(env('HELIUS_LASERSTREAM_MAX_MIB_PER_HOUR') ?? 0)
if (!Number.isSafeInteger(laserstreamMaxMibPerHour) || laserstreamMaxMibPerHour < 0 || laserstreamMaxMibPerHour > 1024 * 1024)
  throw new Error('HELIUS_LASERSTREAM_MAX_MIB_PER_HOUR must be a non-negative integer')

function lpZapProgramId(v: string | undefined): string | undefined {
  if (v !== undefined && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) throw new Error('LP_ZAP_PROGRAM_ID must be a base58 program id')
  return v
}

export const config = {
  port: Number(env('PORT') ?? 8080),
  dataDir: env('DATA_DIR') ?? './data',

  // Robinhood Chain (4663) over dRPC. The keyed load balancer is the default;
  // RH_WSS_URL overrides it (another dRPC key, a dedicated node, ...).
  rhWss: env('RH_WSS_URL') ?? (drpcKey ? `wss://lb.drpc.live/robinhood/${drpcKey}` : undefined),
  rhHttp: env('RH_HTTP_URL') ?? (drpcKey ? `https://lb.drpc.live/robinhood/${drpcKey}` : undefined),

  // The primary Yellowstone provider can be Helius LaserStream, FluxRPC, or any
  // compatible service. Only explicitly enabled legacy/additional lanes race it.
  yellowstoneGrpcUrl: env('YELLOWSTONE_GRPC_URL'),
  yellowstoneXToken: env('YELLOWSTONE_X_TOKEN'),
  yellowstoneMaxPayloadBytesPerHour: yellowstoneMaxMibPerHour * 1024 * 1024,
  heliusParsedStream: on('HELIUS_PARSED_STREAM'),
  heliusTargetedStream: on('HELIUS_TARGETED_STREAM'),
  heliusLaserstreamUrl: env('HELIUS_LASERSTREAM_URL') ?? 'https://laserstream-mainnet-ewr.helius-rpc.com',
  heliusLaserstreamMaxPayloadBytesPerHour: laserstreamMaxMibPerHour * 1024 * 1024,
  drpcGeyser: on('DRPC_GEYSER'),
  tritonGrpcUrl: env('TRITON_GRPC_URL'),
  tritonXToken: env('TRITON_X_TOKEN'),
  tritonGeyser: on('TRITON_GEYSER'),
  tritonDeshred: on('TRITON_DESHRED'),
  tritonPreconfs: on('TRITON_PRECONFS'),
  preconfsUrl: env('TRITON_PRECONFS_URL') ?? 'https://preconfs.rpcpool.com',
  // Preconfs never inherits the Dragon's Mouth token or a region list.
  preconfsToken: env('TRITON_PRECONFS_TOKEN'),
  preconfsRegions: (env('TRITON_PRECONFS_REGIONS') ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  drpcGeyserUrl: env('DRPC_GEYSER_URL'),
  drpcKey,
  solanaRpc,
  // Quote/trade reads (direct router pool state, wrap/zap/holdings balance
  // reads) can use their own endpoint so feed and metadata traffic cannot
  // rate-limit quoting. Falls back to SOLANA_RPC_URL.
  solanaQuoteRpc: env('SOLANA_QUOTE_RPC_URL') ?? solanaRpc,
  // Direct Solana routing stays behind the server; never expose RPC credentials.
  solanaRouterUrl: env('SOLANA_ROUTER_URL'),
  solanaSelfRouter: env('SOLANA_SELF_ROUTER') === '1',
  // lp-zap composer program id. Optional: when unset the direct router never
  // discovers or builds composed (multi-hop) routes.
  lpZapProgramId: lpZapProgramId(env('LP_ZAP_PROGRAM_ID')),
  solanaDasRpc: env('SOLANA_DAS_URL') === 'off' ? undefined : (env('SOLANA_DAS_URL') ?? solanaRpc),

  // Liquidity moves on pools and tokens older than this are counted, not stored:
  // FTL follows young liquidity, not market makers rebalancing SOL/USDC.
  youngMs: Number(env('YOUNG_HOURS') ?? 72) * 3600_000,
  retainDays: Number(env('RETAIN_DAYS') ?? 14),
}

const urlSecrets = [config.solanaRpc, config.solanaQuoteRpc, config.solanaDasRpc, env('HELIUS_WAAS_SECURE_RPC_URL'), config.heliusLaserstreamUrl, config.yellowstoneGrpcUrl, config.tritonGrpcUrl, config.drpcGeyserUrl, config.rhWss, config.rhHttp]
  .flatMap(raw => {
    if (!raw) return []
    try {
      const u = new URL(raw)
      // Helius Secure RPC uses an unkeyed URL whose unique subdomain acts as
      // the credential. Treat that hostname like a query key in log output.
      const secureHeliusHost = u.hostname.endsWith('.helius-rpc.com') &&
        !['mainnet.helius-rpc.com', 'beta.helius-rpc.com'].includes(u.hostname) ? u.hostname : ''
      return [u.username, u.password, secureHeliusHost, ...u.searchParams.values()].filter(v => v.length >= 8)
    } catch { return [] }
  })
const secrets = [drpcKey, env('HELIUS_API_KEY'), config.yellowstoneXToken, config.tritonXToken, config.preconfsToken, ...urlSecrets].filter(Boolean) as string[]
export function redact(s: string): string {
  let out = s
  for (const k of secrets) out = out.split(k).join('***')
  return out
}
