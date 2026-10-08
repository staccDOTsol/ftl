# Solana pool stats: venue APIs behind `pool-stats.ts`

Recorded 2026-10-08 by loading each venue's own site in a browser, watching the
XHR it makes for a pool page, then replaying that request with `curl` against the
pools below. Every endpoint is unauthenticated JSON over HTTPS. Trimmed recordings
live in `server/test/fixtures/pool-stats.json`.

Verification pools: Raydium CLMM `2JtkunkYCRbe5YZuGU6kLFmNwN22Ba1pCicHoqW5Eqja`,
Raydium CPMM `fAjTnZ9QqJkUmrr8cXutkYhpVge2qqtSZNt9qKn7YC2`, Raydium AMM v4
`S2MiN5qmiRS8HBQMXcdJUhLwrBgX9P3naDuo4GkQ63t`, Orca `21gTfxAnhUDjJGZJDkTXctGFKT8TeiXx6pN1CEg9K1uW`,
Meteora DLMM `GNY3YbGqdhZv8R3kD2NRJQ4NLD6tb3PPthJ2mpUR89Lc`, Meteora DAMM v2
`3KphxamdB1apYohQStGATZrKGpk7Yf31G9H18Gpp8He7`, Meteora DAMM v1
`2E15yqhc8jBGpWfCXZjibB2qj7EDjp5A4x8NSk4363jd`, PumpSwap `7GZHLdhvZN1NSutNt1BJs5S9ArBobAdCvyGzwPo22LHA`.
Program owners were confirmed over RPC (`LBUZ…` DLMM, `cpamd…` DAMM v2, `Eo7W…` DAMM v1,
`pAMM…` PumpSwap). The Meteora and PumpSwap verification pools are near-empty
(TVL under $4, zero 24h volume), so active pools from the same endpoints are listed
alongside to show the units.

## Normalized output

`feeApr` is percent, 24h fees annualized: the venue's own number when it publishes a
true annualized figure (Raydium `day.feeApr`, DAMM v1 `apr`), else
`fees24hUsd / tvlUsd * 365 * 100`. `feeRateBps` is the swap fee as basis points
(25 = 0.25%). `rewardApr` is farm/emission APR as the venue reports it, null when
none. `totalApr = feeApr + rewardApr`. `source` is the venue API host.

## Raydium (CPMM, CLMM, AMM v4): one endpoint

`GET https://api-v3.raydium.io/pools/info/ids?ids=<pool>[,<pool>...]` (what raydium.io
calls). Body `{ success, data: [pool] }`; `data[i]` is `null` for unknown ids.

| field | unit | note |
|---|---|---|
| `programId` | base58 | `CPMMoo8…` CPMM, `CAMMCzo…` CLMM, `675kPX9…` AMM v4; checked against the requested venue |
| `tvl` | USD | |
| `feeRate` | fraction | `0.0025` = 0.25% -> `feeRateBps = feeRate * 10000` |
| `day.volume` / `day.volumeFee` | USD | 24h volume and 24h fees |
| `day.feeApr`, `day.apr` | percent | verified `day.volumeFee / tvl * 365 * 100 == day.feeApr` (0.322 / 1728.52 -> 6.8) |
| `day.rewardApr` | percent[] | one per farm reward; summed into `rewardApr` |
| `week.apr`, `month.apr` | percent | not used |

Verified: CLMM tvl 1728.52, vol 8.05, fees 0.322, feeRate 0.04 (4%), feeApr 6.8.
CPMM tvl 59.68, vol 282.13, fees 0.0141, feeRate 0.00005, feeApr 8.63.
AMM v4 tvl 9.48, vol 0.777, fees 0.00194, feeRate 0.0025, feeApr 7.48.
Headers: `access-control-allow-origin: *`, `cache-control: max-age=5`, Cloudflare, no
rate-limit headers seen.

## Orca Whirlpools

`GET https://api.orca.so/v2/solana/pools/<pool>` (what orca.so calls). Body `{ data: pool }`.
Numbers are decimal strings.

| field | unit | note |
|---|---|---|
| `tvlUsdc` | USD string | |
| `feeRate` | hundredths of a bp | `1600` = 0.16% -> `feeRateBps = feeRate / 100` |
| `stats["24h"].volume` / `.fees` / `.rewards` | USD strings | also `7d`, `30d` |
| `stats["24h"].yieldOverTvl`, top-level `yieldOverTvl` | fraction, 24h | not annualized; `fees / tvlUsdc` |
| `rewards[]` | | `emissionsPerSecond`, `active` |

No annualized APR is published, so `feeApr = fees / tvlUsdc * 365 * 100`.
Verified: tvl 3456.67, 24h vol 485.06, fees 0.7742, feeRate 1600 -> 16 bps,
feeApr 8.18 (venue `yieldOverTvl` 0.0002245 * 365 * 100 = 8.19, same within 0.2%).
Headers: `access-control-allow-origin: *`, Cloudflare. The old
`https://api.mainnet.orca.so/v1/whirlpool/list` still answers but is an 18 MB stale
dump (shows tvl 35k for this pool vs 3.5k live), so it is not used.

## Meteora DLMM and DAMM v2: the `datapi` hosts

The documented hosts `dlmm-api.meteora.ag`, `dammv2-api.meteora.ag` and
`amm-v2.meteora.ag` now answer 404 with an empty body for every path, including the
root. app.meteora.ag calls:

- DLMM: `GET https://dlmm.datapi.meteora.ag/pools/<pool>`
- DAMM v2: `GET https://damm-v2.datapi.meteora.ag/pools/<pool>`

Both return the same shape (bare object, `address` echoes the pool). Unknown pool:
404 with empty body.

| field | unit | note |
|---|---|---|
| `tvl` | USD | |
| `volume["24h"]`, `fees["24h"]`, `protocol_fees["24h"]` | USD | also `30m`,`1h`,`2h`,`4h`,`12h` |
| `fee_tvl_ratio["24h"]` | percent, 24h | `fees.24h / tvl * 100`, not annualized |
| `apr` (DLMM only) | percent, 24h | equals `fee_tvl_ratio["24h"]`: a daily ratio, NOT an APR |
| `apy` (DLMM only) | percent | `(1 + fee_tvl_ratio.24h/100)^365 - 1` (compounded) |
| `pool_config.base_fee_pct` | percent | `0.04` = 0.04% -> bps = `* 100`; DLMM adds `dynamic_fee_pct` |
| `has_farm`, `farm_apr`, `farm_apy` | percent | reward APR when `has_farm` |

So `feeApr = fees.24h / tvl * 365 * 100` (= `fee_tvl_ratio.24h * 365`).
Verified on an active DLMM pool (`5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6`, SOL-USDC):
tvl 4,574,416.90, 24h vol 21,403,331.54, fees 8,069.93, `apr` 0.1764 (daily), computed
APR 64.39, venue `apy` 90.28. The verification DLMM pool: tvl 3.67, 0 volume.
Active DAMM v2 (`4xp7kN4nVt19caq4kM629vL8vJEqpSFVdZAh27wvYPh8`): tvl 104,813.26,
24h vol 4,144,770.43, fees 83,920.82, base_fee_pct 2.5 -> 250 bps. The verification
DAMM v2 pool: tvl 0, created minutes earlier.
Headers: `access-control-allow-origin: *`, `x-ratelimit-limit: 300` per window
(`x-ratelimit-reset` epoch seconds), `x-ratelimit-remaining`.
List form for discovery: `/pools?limit=&order_by=volume_24h&order=desc`.

## Meteora DAMM v1 (dynamic AMM)

`GET https://damm-api.meteora.ag/pools?address=<pool>` (what app.meteora.ag/pools/<pool>
calls). Body is an array with one row; unknown address -> `[]`.

| field | unit | note |
|---|---|---|
| `pool_tvl` | USD string | |
| `trading_volume` / `fee_volume` | USD | 24h |
| `weekly_trading_volume` / `weekly_fee_volume` | USD | |
| `total_fee_pct` | percent string | `"0.3"` -> 30 bps |
| `apr` | percent | 24h fees annualized by the venue (7.93 vs 7.64 recomputed from the TVL snapshot) |
| `trade_apy` | percent string | daily compounded (`(1+r)^365-1`), e.g. 7.9357 |
| `daily_base_apy`, `weekly_trade_apy`, `farming_apy` | percent strings | farming APY -> `rewardApr` when > 0 |

Verified on `E5H5BXLranyJFHEzvR3R2j6kGDQ3Fnx8sPKSsgYqyya8` (DBR-USDC): tvl 5,783,528.72,
24h vol 403,388.85, fees 1,210.17, apr 7.93, trade_apy 7.94. The verification pool
reports all zeros (tvl 0).
Headers: `access-control-allow-origin: *`, `x-ratelimit-limit: 100`.

## PumpSwap

swap.pump.fun has no pool page; the deposit form (`/deposit`) shows "24h vol" and
"liquidity" for a pair and calls:

- `GET https://swap-api.pump.fun/v1/pools/<pool>`: `baseMint`, `quoteMint`, decimals,
  `creator`, `poolIndex`, `baseReserves`, `quoteReserves` (raw), `lpSupply`,
  `liquidityUSD` (string). No volume, no fee, even with `?include_vol=true`.
- `GET https://swap-api.pump.fun/v1/pools/pair?mintA=<quote>&mintB=<base>&sort=liquidity&include_vol=true`:
  array of every pool for the pair, each row as above plus `volumeUSD` (24h, string;
  matched the UI's "$3M") and `isCanonical`.

`pool-stats.ts` reads the pool, then the pair listing, and picks the matching
`address`. Unknown pool: 404 JSON `{ statusCode: 404 }`. Headers:
`x-ratelimit-limit: 1000`, `x-ratelimit-reset: 60`; no `access-control-allow-origin`
for a non-browser origin.

Fee rate: not published by the HTTP API; the site prices swaps client-side from the
on-chain pump-fees `FeeConfig` over its RPC. Read on 2026-10-08 with
`@pump-fun/pump-swap-sdk` (`OnlinePumpAmmSdk.swapSolanaState`):

- `flatFees` (pools that are not canonical pump graduations): lp 25 bps, protocol 5,
  creator 0 -> LPs earn 0.25% of volume.
- `feeTiers` (canonical pump pools, SOL quote), by market cap in SOL: under 420 SOL
  lp 2 / protocol 93 / creator 30; every tier from 420 SOL up lp 20 / protocol 5 with
  creator stepping 95 -> 5 bps as market cap grows. `stableFeeTiers` mirror this in
  USDC units.
- `GlobalConfig` legacy: lp 20, protocol 5, creator 5.

`PUMPSWAP_LP_FEE_BPS = { flat: 25, canonical: 20 }` in `pool-stats.ts` encodes the LP
share; `fees24hUsd = volumeUSD * lpBps / 10000`. Verified pool: liquidityUSD
0.0000677, volumeUSD 0, `isCanonical: false`. Active pool from the same SOL/USDC
listing (`Gf7sXMoP8iRw4iiXmJ1nq4vxcRycbGXy5RL8a8LnTd3v`): liquidity 7,946,190.91,
24h volume 2,873,168.23.

## Dead ends

`frontend-api-v3.pump.fun/coins/<pool|mint>` 404 (only `/sol-price` and auth checks are
used by the swap site). `swap-api.pump.fun/v1/pools/<pool>/{stats,fees,fee}`,
`/v1/pools?limit=`, `/v1/coins/<mint>/pools`, `/v1/{fees,config,global-config,fee-config}`
all 404. `app.meteora.ag/api/...` is the Next.js app, not an API.
