// Everything FTL reads from the environment. Secrets never leave this module
// except as connection parameters; log lines use `redact()`.

const env = (k: string): string | undefined => {
  const v = process.env[k]
  return v && v.trim() ? v.trim() : undefined
}
const on = (k: string): boolean => env(k) === '1'

const drpcKey = env('DRPC_KEY')
const solanaRpc = env('SOLANA_RPC_URL') ?? (drpcKey ? `https://lb.drpc.live/solana/${drpcKey}` : undefined)

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
  solanaDasRpc: env('SOLANA_DAS_URL') === 'off' ? undefined : (env('SOLANA_DAS_URL') ?? solanaRpc),

  // Liquidity moves on pools and tokens older than this are counted, not stored:
  // FTL follows young liquidity, not market makers rebalancing SOL/USDC.
  youngMs: Number(env('YOUNG_HOURS') ?? 72) * 3600_000,
  retainDays: Number(env('RETAIN_DAYS') ?? 14),
}

const urlSecrets = [config.solanaRpc, config.solanaDasRpc, config.yellowstoneGrpcUrl, config.tritonGrpcUrl, config.drpcGeyserUrl, config.rhWss, config.rhHttp]
  .flatMap(raw => {
    if (!raw) return []
    try {
      const u = new URL(raw)
      return [u.username, u.password, ...u.searchParams.values()].filter(v => v.length >= 8)
    } catch { return [] }
  })
const secrets = [drpcKey, config.yellowstoneXToken, config.tritonXToken, config.preconfsToken, ...urlSecrets].filter(Boolean) as string[]
export function redact(s: string): string {
  let out = s
  for (const k of secrets) out = out.split(k).join('***')
  return out
}
