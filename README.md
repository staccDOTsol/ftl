# liquidityxyz — follow the liquidity

Realtime socialfi for liquidity: every pool birth, liquidity add and pull on Solana and Robinhood Chain, scored against the bot-structure fingerprints recorded in [staccDOTsol/the-book](https://github.com/staccDOTsol/the-book). Follow wallets and tokens, post calls that score at graduation, get alerts when they move.

- Web: https://liquidityxyz.fun (Vercel project `ftl-liquidity`)
- API + websocket: https://ftl-firehose.fly.dev, `api.liquidityxyz.fun` once DNS verifies (`/api/status`, `/ws`)
- iOS / Android: Expo app in `app/`, built on EAS (`@staccoverflow/ftl-follow-the-liquidity`)

## Feeds

| Chain | Lane | Source | Stage |
|---|---|---|---|
| Robinhood (4663) | `logs` | dRPC websocket `eth_subscribe logs`: v4 PoolManager Initialize / ModifyLiquidity / Swap, chain-wide Pons TokenLaunched / PoolGraduated / PoolRegistered | executed |
| Solana | `preconf` | Optional Triton Preconfs in explicitly selected Harmonic/BAM regions, raw wire txs before shreds | pending |
| Solana | `deshred` | Optional Triton Dragon's Mouth `SubscribeDeshred`, before execution | pending |
| Solana | `geyser-primary` | Helius LaserStream, FluxRPC or another Yellowstone-compatible gRPC provider, processed with metadata | confirmed |
| Solana | `geyser` | Optional legacy Triton Dragon's Mouth `Subscribe`, processed with metadata | confirmed |
| Solana | `geyser-drpc` | Optional dRPC Solana Geyser gRPC `Subscribe`, processed | confirmed |

Enabled lanes race into one hub. The first lane to see an instruction posts it; an executed copy confirms it and fills in exact amounts from vault balance changes. `/api/status` reports each lane's connection, configured and active stream counts, received messages, events, first-seen wins and median lead over the executed copy. These counts help audit usage; they are not provider billing figures.

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

### Solana provider and cost controls

Set `YELLOWSTONE_GRPC_URL` and `YELLOWSTONE_X_TOKEN` for one primary executed Solana stream. The Yellowstone gRPC endpoint may be [Helius LaserStream](https://www.helius.dev/laserstream/) or [FluxRPC Yellowstone](https://fluxrpc.com/docs/yellowstone/quickstart) if that product is enabled on the chosen provider plan. Both accept the key as the gRPC `x-token`; keep it only in server environment secrets. Set `SOLANA_RPC_URL` separately for standard server-side JSON-RPC and address lookup table reads. Set `SOLANA_DAS_URL` to a Helius DAS-capable server endpoint for `getAssetBatch`, including a Helius Secure RPC URL if enabled for the project. It falls back to `SOLANA_RPC_URL` if unset, or `off` disables DAS. Helius [prices DAS calls at 10 credits each](https://www.helius.dev/pricing). `META_RPC_DAILY_LIMIT` bounds metadata RPC requests across DAS and fallbacks when positive; 0 records usage without a cutoff. The app never needs a provider API key or Secure RPC hostname in its code.

Each executed Yellowstone lane reports a persisted, rolling one-hour protobuf payload estimate in `/api/status`. `YELLOWSTONE_MAX_MIB_PER_HOUR` is unset or 0 by default, so it does not interrupt live discovery. Set a positive value to opt into a circuit breaker. The estimate excludes transport overhead and provider-specific billing; compare it with the provider dashboard. A circuit pause creates a coverage gap, so dependent Research metrics stay unavailable until replay proves complete coverage.

Set `HELIUS_PARSED_STREAM=1` with server-side `HELIUS_API_KEY` to stream Helius confirmed transactions filtered by FTL instruction name. FTL checks Helius's `describeProgram` catalog before subscribing. Once every parsed subscription is accepted, the primary Flux Yellowstone filter narrows to programs whose FTL instructions are missing from the catalog; it automatically returns to all FTL programs if Parsed Streams disconnects or an event cannot be converted. `/api/status` shows parsed connection, subscription count, received JSON payload bytes, and the Flux program count. [Helius bills one credit per delivered parsed event](https://www.helius.dev/docs/parsed-streams); bytes shown by FTL are transport observations, not a billing estimate. Parsed Streams currently has no replay and its `blockTime` is null, so Research does not treat a disconnect as continuous historical coverage.

`HELIUS_TARGETED_STREAM=1` enables the combined finalized mint-filtered LaserStream and block-time source for Solana Research. It tracks every FTL-seen mint and replays from a persisted finalized checkpoint after reconnect. `HELIUS_BLOCKTIME_MAX_MIB_PER_HOUR` is 0 by default, so it measures payload without an automatic cutoff; a positive value opts into a circuit breaker. Compare `/api/status` payload telemetry with Helius dashboard billing because protobuf estimates exclude transport overhead.

`HOLDER_PROGRAM_BACKFILL=1` first recovers historical token-program identity from confirmed FTL launch events whose instruction fixes the base token program: Pump `create`/`create_v2`, Meteora DBC `initialize_virtual_pool_with_spl_token`/`initialize_virtual_pool_with_token2022`/`initialize_virtual_pool_with_token2022_transfer_hook`, and Raydium LaunchLab `initialize_with_token_2022`. The mapping is checked against the shipped venue IDLs and [Pump's `create_v2` account spec](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COIN_CREATION.md). Ambiguous instruction names are not inferred. Remaining unknown FTL-seen mints and known Token-2022 mints needing extension proof receive one finalized raw mint-account lookup each, batched 20 mints per `getMultipleAccounts` call against an explicit HTTPS Helius `SOLANA_DAS_URL`. One batch runs at a time on a 2-second default interval. The raw owner establishes token-program identity, and the same bytes provide the complete Token-2022 mint TLV. Confidential, unknown, or malformed extension types remain visibly pending. `HOLDER_PROGRAM_RPC_DAILY_LIMIT=0` measures calls without an arbitrary cutoff; a positive value opts into a daily cap, as does positive `META_RPC_DAILY_LIMIT`. Transient HTTP failures retry with bounded backoff; an interrupted or successful but unverifiable read is not silently repeated. `programBackfillStatus()` reports scanned launches, mapped/unknown and queued/retry/blocked/missing counts, extension verdicts, response bytes, calls, and estimated credits (one per ordinary Helius RPC call). [Helius prices most RPC calls at one credit](https://www.helius.dev/solana-rpc-nodes).

`HOLDER_BOOTSTRAP=1` separately enables a paced, single [Helius `getProgramAccountsV2` read](https://www.helius.dev/solana-rpc-nodes) for each FTL-seen Solana mint with a verified SPL Token or transparently verified Token-2022 program ID and active finalized mint-stream coverage. This requires `SOLANA_DAS_URL` to be an explicit Helius HTTPS endpoint; `HOLDER_BOOTSTRAP_INTERVAL_MS` defaults to 10,000 ms between attempts. Helius lists this paginated RPC at one credit per call. FTL requests at most 10,000 token accounts in that one read, then applies finalized transaction balance changes with no periodic snapshots. A pagination cursor, rejected read, interrupted attempt, or unreplayed stream gap leaves holder measures unavailable; FTL does not silently issue a second bootstrap read. Token-2022 mints with confidential, malformed, or unknown extensions remain pending because their complete balances are not proven public. For a bounded live proof, set `HOLDER_BOOTSTRAP_PROBE_MINT` to one exact FTL-seen Solana mint; other mints remain visibly pending and receive no bootstrap calls. Unset it for the full queue after checking account count, response size, and Fly volume capacity. Keep the bootstrap opt-in off until the mint-filtered transaction metadata and replay coverage have been verified against the live provider.

Triton streams are off by default even if old Triton credentials remain configured. To use a legacy executed Triton stream, set `TRITON_GEYSER=1` with `TRITON_GRPC_URL` and `TRITON_X_TOKEN`. `TRITON_DESHRED=1` enables its separate pre-execution stream. Preconfs requires **all three** of `TRITON_PRECONFS=1`, a dedicated `TRITON_PRECONFS_TOKEN`, and an explicit comma-separated `TRITON_PRECONFS_REGIONS` list, such as `harmonic:ewr,bam:ewr`. There is no token fallback and no automatic all-region subscription. Each listed region opens another stream, so select coverage deliberately. `DRPC_GEYSER=1` enables the optional dRPC executed stream when `DRPC_GEYSER_URL` and `DRPC_KEY` are set. Every additional executed stream sees overlapping transactions before the hub deduplicates them and may be billed separately.

Existing deployments that only set Triton or dRPC credentials will show Solana lanes disabled after this change until they set a primary provider or explicitly enable the desired legacy lanes. `/api/status` gives a reason for each disabled lane. Robinhood's dRPC connection continues to use `DRPC_KEY` independently.

### Helius embedded wallet (web)

The embedded trading wallet uses Helius Wallet Kit on the web and is separate from FTL's device key used to sign follows, calls, and likes. Put `HELIUS_API_KEY` and a comma-separated `HELIUS_WAAS_ORIGINS` (for example `https://liquidityxyz.fun`) in the Fly server environment. The static web app rewrites `/api/helius/*` to Fly, so the Wallet Kit's keyless same-origin bootstrap and registration keep the Helius API key out of the browser. Set `HELIUS_WAAS_SECURE_RPC_URL` to the keyless Secure RPC URL from the Helius dashboard if the WaaS bootstrap does not provide one; the SDK then sends wallet RPC reads and signed transactions directly to that URL. The Fly fallback proxy checks browser origin, rate-limits requests, and allows only the wallet's required RPC methods. The Helius project must have WaaS enabled and a paid plan.

`helius-wallet-kit` currently publishes web React and Next.js exports, with no React Native entry. The Expo iOS and Android builds cannot use this embedded wallet SDK yet. The web wallet route reports that limitation on native; the existing FTL social identity remains available on all platforms. Configure Helius sign-in methods in the project dashboard before inviting users.
