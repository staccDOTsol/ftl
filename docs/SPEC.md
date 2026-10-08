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
| 7 | Make it beautiful | Done, live | Liquidity card redesign with venue counts, auto range, yield, crowd, share-move, wrap; further polish welcome |
| 8 | Infer ticks/bins from entered amounts | Done in code; router redeploy in flight | Adapter inference with 11 tests (aggregator-ag commit b3d2dd4); UI shows auto range and inferred price bounds once the router image updates |
| 9 | "What can I do with what I'm holding" | Done, live | GET api.liquidityxyz.fun/api/holdings/solana/:owner and the /holdings screen: balances, positions, ranked exits, sells, adds, buys |
| 10 | Good APY estimates, reverse-engineered from the venues' own APIs | Done, live | Raydium v3, Orca v2, Meteora datapi (DLMM, DAMM v2), DAMM v1 api, PumpSwap swap-api; GET /api/pool-stats/solana; PoolYield on every selected pool and position; research in server/src/solana/pool-stats.md |
| 11 | Make it socialfi | Done, live | Posts carry a move + tx with a move card; share-move composer after every confirmed LP op; who's in this pool with follow chips (GET /api/pool/:chain/:pool/wallets); follow your trading wallet |
| 12 | Router treats wrap/unwrap, LP deposits, withdrawals, multi-step as executable ops | Done for wrap/unwrap/LP/swap, live | POST /api/wrap/solana + WrapSol card inside the liquidity flow; LST conversions still not exposed in FTL |
| 14 | Publish the Sanctum fork and LST engine, open-source FTL | Done | github.com/staccDOTsol/permissionless-lst (embedding commit 5c5f850), github.com/staccDOTsol/permissionless-lst-engine (new, public), github.com/staccDOTsol/ftl now public |
| 15 | GitHub links in site footer | Done, live | Rail footer links to ftl, autobahn, permissionless-lst-engine; Me tab link |
| 16 | Jupiter-Terminal-style /swap page for the router | In progress | SwapTerminal.web.tsx at /swap |
| 13 | Feed → router loop: event → token → route → sign → confirm → back to feed | Done for swaps and LP | Feed events deep-link into the trade card with the originating pool; confirmed moves re-enter the feed through on-chain detection |

Still outside the product: LST mint/redeem through FTL (the LST router exists in aggregator-lst-deploy and simulated on mainnet but is not deployed behind api.liquidityxyz.fun).
