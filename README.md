# FTL — Follow The Liquidity

Realtime socialfi for liquidity: every pool birth, liquidity add and pull on Solana and Robinhood Chain, scored against the bot-structure fingerprints recorded in [staccDOTsol/the-book](https://github.com/staccDOTsol/the-book). Follow wallets and tokens, post calls that score at graduation, get alerts when they move.

- Web: https://ftl-liquidity.vercel.app
- API + websocket: https://ftl-firehose.fly.dev (`/api/status`, `/ws`)
- iOS / Android: Expo app in `app/`, built on EAS (`@staccoverflow/ftl-follow-the-liquidity`)

## Feeds

| Chain | Lane | Source | Stage |
|---|---|---|---|
| Robinhood (4663) | `logs` | dRPC websocket `eth_subscribe logs`: v4 PoolManager Initialize / ModifyLiquidity / Swap, chain-wide Pons TokenLaunched / PoolGraduated / PoolRegistered | executed |
| Solana | `preconf` | Triton Preconfs (Harmonic + BAM), raw wire txs before shreds | pending |
| Solana | `deshred` | Triton Dragon's Mouth `SubscribeDeshred`, before execution | pending |
| Solana | `geyser` | Triton Dragon's Mouth `Subscribe`, processed, with metadata | confirmed |
| Solana | `geyser-drpc` | dRPC Solana Geyser gRPC `Subscribe`, processed | confirmed |

All lanes race into one hub. The first lane to see an instruction posts it; an executed copy confirms it and fills in exact amounts from vault balance changes. `/api/status` reports each lane's events, first-seen wins and median lead over the executed copy.

Solana venues: Orca Whirlpools, Raydium AMM v4 / CPMM / CLMM / LaunchLab, Meteora DLMM / DAMM / DAMM v2 / DBC, pump.fun, PumpSwap. IDLs in `server/idl/` (Orca's is generated from `~/whirlpools/programs/whirlpool/src`). `node --test test/` decodes recent mainnet transactions for every venue.

## Flags (from the book)

`pounce` independent pool on a launchpad token before graduation · `burst_4_300` / `burst_5_600` distinct funded pools on one token within 5 / 10 minutes · `honeypot_fee` static fee ≥ 70% · `ladder` pool born with no liquidity in its own tx · `jit` add and pull by one wallet within a few blocks · `multi_venue` ≥ 5 pools in a token's first hour.

Liquidity moves are stored only for young pools and tokens (`YOUNG_HOURS`, default 72) or followed wallets; older pools are counted, not stored.

## Run

```sh
cd server && npm ci && cp .env.example .env   # fill in keys
npm start                                     # :8080
cd ../app && npm ci && EXPO_PUBLIC_API_URL=http://localhost:8080 npx expo start
```

## Deploy

```sh
fly deploy --remote-only -a ftl-firehose                          # API (secrets: fly secrets set ... -a ftl-firehose)
cd app && ./scripts/export-web.sh && cd dist && vercel deploy --prod --yes   # web
cd app && npx eas-cli@latest build -p all --profile preview      # APK + iOS simulator
```

Secrets the server reads: `DRPC_KEY`, `DRPC_GEYSER_URL`, `TRITON_GRPC_URL`, `TRITON_X_TOKEN`, `TRITON_PRECONFS_TOKEN`, `TRITON_PRECONFS_REGIONS`, `SOLANA_RPC_URL`. A lane without its secret stays off and says why in `/api/status`.
