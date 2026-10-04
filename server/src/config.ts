// Everything FTL reads from the environment. Secrets never leave this module
// except as connection parameters; log lines use `redact()`.

const env = (k: string): string | undefined => {
  const v = process.env[k]
  return v && v.trim() ? v.trim() : undefined
}

const drpcKey = env('DRPC_KEY')

export const config = {
  port: Number(env('PORT') ?? 8080),
  dataDir: env('DATA_DIR') ?? './data',

  // Robinhood Chain (4663) over dRPC. The keyed load balancer is the default;
  // RH_WSS_URL overrides it (another dRPC key, a dedicated node, ...).
  rhWss: env('RH_WSS_URL') ?? (drpcKey ? `wss://lb.drpc.live/robinhood/${drpcKey}` : undefined),
  rhHttp: env('RH_HTTP_URL') ?? (drpcKey ? `https://lb.drpc.live/robinhood/${drpcKey}` : undefined),

  // Solana lanes. Each lane is optional; whichever lanes are configured race.
  tritonGrpcUrl: env('TRITON_GRPC_URL'),
  tritonXToken: env('TRITON_X_TOKEN'),
  tritonDeshred: env('TRITON_DESHRED') !== '0',
  preconfsUrl: env('TRITON_PRECONFS_URL') ?? 'https://preconfs.rpcpool.com',
  preconfsToken: env('TRITON_PRECONFS_TOKEN'),
  preconfsRegions: (env('TRITON_PRECONFS_REGIONS') ?? 'harmonic:ewr,bam:ewr').split(',').map(s => s.trim()).filter(Boolean),
  drpcGeyserUrl: env('DRPC_GEYSER_URL'),
  drpcKey,
  solanaRpc: env('SOLANA_RPC_URL') ?? (drpcKey ? `https://lb.drpc.live/solana/${drpcKey}` : undefined),

  // Liquidity moves on pools and tokens older than this are counted, not stored:
  // FTL follows young liquidity, not market makers rebalancing SOL/USDC.
  youngMs: Number(env('YOUNG_HOURS') ?? 72) * 3600_000,
  retainDays: Number(env('RETAIN_DAYS') ?? 14),
}

const secrets = [drpcKey, config.tritonXToken, config.preconfsToken].filter(Boolean) as string[]
export function redact(s: string): string {
  let out = s
  for (const k of secrets) out = out.split(k).join('***')
  return out
}
