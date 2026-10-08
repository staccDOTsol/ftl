# liquidityxyz e2e spec — requirements and status

Every requirement the owner gave on 2026-10-07/08, with its current status. Updated as work lands.

| # | Requirement (owner's words, condensed) | Status | Evidence |
| --- | --- | --- | --- |
| 1 | All adapters, all actions, proven on mainnet; init only where already funded | Done | README of aggregator-ag: add+remove receipts on all 8 venues; initialize on PumpSwap, DAMM v1, DAMM v2 |
| 2 | Implement the trade UI in ~/ftl; e2e product shipped and golden | Done, iterating | www.liquidityxyz.fun token pages: Swap + Liquidity tabs; wallet-standard, injected, embedded wallets |
| 3 | Redeploy everything | Done | Fly ftl-firehose (server), Vercel ftl-liquidity (web), Fly liquidityxyz-router (router) |
| 4 | Browser-wallet signing proven on mainnet | Done | Owner signed a Raydium CLMM add in the browser on the live site: https://solscan.io/tx/VXwJcsc7GMQFrceVckMXWHRx4ZQosUijkUx1pe2H2vQKjMdJQTUpkgeb2DUGwwp1YdUttuxkr7PQfwk45GyqGAA |
| 5 | Swaps must not price through dust pools | Done | Server quotes both routers, builds from the better (server/src/solana/router.ts bestQuote) |
| 6 | Highlight which venues have pools for this token | Done | Liquidity card venue chips carry pool counts; auto-selects the venue and pool with funded liquidity |
| 7 | Make it beautiful | In progress | Liquidity card redesign shipped; APR, crowd and share cards being added |
| 8 | Infer ticks/bins from entered amounts | In progress | Adapter-side inference (aggregator-ag worker); UI shows auto range and inferred price bounds |
| 9 | "What can I do with what I'm holding" | In progress | GET /api/holdings/solana/:owner + /holdings screen: balances, positions, ranked executable actions |
| 10 | Good APY estimates, reverse-engineered from the venues' own APIs | In progress | server/src/solana/pool-stats.ts + PoolYield card |
| 11 | Make it socialfi | In progress | Posts carry a move + tx; who's LPing this pool with follow; follow your own trading wallet |
| 12 | Router treats wrap/unwrap, LP deposits, withdrawals, multi-step as executable ops | In progress | wrap/unwrap build endpoint + WrapSol card; LP ops done; LST conversions not yet exposed in FTL |
| 13 | Feed → router loop: event → token → route → sign → confirm → back to feed | Done for swaps and LP | Feed events deep-link into the trade card with the originating pool; confirmed moves re-enter the feed through on-chain detection |

Still outside the product: LST mint/redeem through FTL (the LST router exists in aggregator-lst-deploy and simulated on mainnet but is not deployed behind api.liquidityxyz.fun).
