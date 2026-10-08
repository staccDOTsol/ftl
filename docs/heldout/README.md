# Held-out test of learned IDLs

The question: does an IDL learned for a Solana program with no published IDL decode mainnet transactions it never saw?

Each directory here is one program. `idl.json` is the frozen interface. `freeze.json` records its SHA-256, the slot it was frozen after, and the absence checks. `receipts.json` holds the raw held-out transactions. `proof.json` holds every hit and every miss.

## Results

All four programs whose interface the Composer learned in this session and that have no published IDL. The set was fixed before any freeze, and every result is published. Before the freeze, the live page's own validation read BiSoN 60/64, FLASHX8 3/64, 8W1e 1/64, and BSfD6 not yet validated.

| Program | Frozen IDL SHA-256 | Frozen after slot | Held-out tx | Decoded | Misses | PDAs re-derived |
| --- | --- | --- | --- | --- | --- | --- |
| [BSfD6SHZ…mrRW](https://solscan.io/account/BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW) (Anchor encoding) | `b7acd8fd254e0973a39e13823e5a27f2e6ae54ef158fb34aadebce9896938140` | 454577034 | 31 | **32 / 39** (82%) | 7 | 71 verified, 0 mismatched |
| [BiSoNHVp…Uypi](https://solscan.io/account/BiSoNHVpsVZW2F7rx2eQ59yQwKxzU5NvBcmKshCSUypi) (1-byte selectors) | `f9f46478d6e103bd36decd3b227fc46c02735c0a51a1dfbaa710e33580442341` | 454576312 | 30 | **29 / 30** (97%) | 1 | none in this IDL |
| [FLASHX8D…txB9](https://solscan.io/account/FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9) (1-byte selectors) | `7baabece33d84b62108123e762b6ab5aed7cfefde87c08c4d019e12767c7fc4c` | 454576653 | 32 | **23 / 97** (24%) | 74 | 0 (its PDA-bearing shape never matched) |
| [8W1eTHgg…VEAY](https://solscan.io/account/8W1eTHggBnxzPHc6cis83rPJgzDKCbqyo4W49dMYVEAY) (changing-prefix bot) | `ca69360356da7676a90044d044a0002fbca9def1b23b0926540f8666a00f94e9` | 454576847 | 32 | **0 / 32** (0%) | 32 | none |
| **All four** | | | 125 | **84 / 198** (42%) | 114 | 71 |

Frozen 2026-10-08 14:49–14:52 UTC. The 32 held-out signatures per program were the earliest successful ones collected after the freeze slot, with no filtering on whether they decode. A row can show fewer than 32 transactions because the RPC lists some transactions that only reference the program as an account; those are kept in `proof.json` as `notInvoked`, neither hit nor miss.

### The misses

- **8W1e (changing-prefix bot): a miss, and it stays one.** Its 32 held-out instructions used 22 distinct 8-byte prefixes. None was among the 132 prefixes in the learned file. The prefix looks per-transaction, so a static selector table cannot decode it. It is not relabelled.
- **FLASHX8: mostly a miss.** Selector `01` decodes every time (23/23). The main route instruction `00` arrives with 30, 32, 43, 45 or 83 accounts, but was frozen at exactly 44. One `03` carried 2 argument bytes against the frozen 1. Selectors `05` and `07` were never learned. `07` (82 bytes, no accounts, once per transaction) may be a custom log record. Nothing proves that, so it is counted as a miss.
- **BSfD6:** all 7 misses are the same shape. Selector `c360ed6c44a2dbe6` (`two_hop_swap`) with 20 accounts and a 27-byte payload. The frozen IDL only knows 21 bytes for that shape.
- **BiSoN:** one `02` instruction carried 18 argument bytes. The frozen shape has 17.

### Misses removed by the counter fix

On these held-out sets: none. Not one held-out instruction was an Anchor event self-CPI or a decoded-only record, so every miss above counts. `proof.json` reports a `legacyCounter` next to the corrected one; they are identical for all four.

On the live page the fix does change numbers, and that change is a metric fix, not new decoding. Read from the live API during this session, before the freeze, pump_fees showed 14 matched / 16 tested, with 7 Anchor event self-CPIs and 3 decoded-only records excluded. Under the old counter that is 14 / 26. Those 10 misses died because the counter was wrong. For 8W1e (1/64), FLASHX8 (3/64) and BiSoN (60/64) the fix excluded nothing, so their page numbers did not change.

## What was checked

1. **No published IDL.** The Anchor IDL account is derived locally (`createWithSeed(findProgramAddress([], program), "anchor:idl", program)`) and read from mainnet: it does not exist. The Solana Foundation registry (`idl.solana.com`: canonical PMP, fallback PMP, Anchor) returns 404. As a control, the same checker run against Jupiter in the same session returns *listed*, so the 404 is a real miss. SolanaFM returned 502 and is recorded as unavailable, not as an absence. All responses are in `freeze.json`.
2. **Freeze first.** The learned interface is fetched, written to `idl.json` and hashed, and the current slot is recorded, before any held-out signature is requested.
3. **Held out.** Only transactions at a slot greater than `frozenAfterSlot` are used. Each one is also checked against the IDL's own training example signatures.
4. **Authentic bytes.** Every ed25519 signature on every raw transaction is verified against its message bytes.
5. **Decode.** An instruction counts as decoded only if it matches all of these:
   - its selector
   - its exact account count
   - a payload length seen in training
   - every fixed account address
   - signer and writable flags (outer instructions)

   Every PDA recipe in the IDL is re-derived from its seeds and must equal the on-chain account. The bytes must round-trip.

## What this does not show

- **Argument semantics.** This is structural decoding: which instruction, which account sits in which position, payload length, and PDA derivations. Argument bytes stay opaque. No argument names or types are invented.
- **Names.** BiSoN, FLASHX8 and 8W1e instructions have no names. BSfD6's names (`collect_fee`, `pump_buy_v2`, `two_hop_swap`) come from matching its 8-byte selectors against published IDLs that declare the same hash. The name belongs to that published IDL. The account layout is this program's own.
- **Who produced the IDL.** The frozen file is what the live Composer service returned at freeze time. That proves nothing about how it was produced. The learner is binary-only and not published.
- **Breadth.** Coverage is programs in FTL's observed traffic, not every program on mainnet. Four programs and about 32 transactions each is a sample, not a census.
- **Time.** `frozenAt` comes from our clock. The slot is chain time, but it was also recorded by us. For a holdout that does not trust our clock, use `--fresh` below. It tests the hashed file against transactions that land after you run it, which is after this commit was public.

## Run it

Requires Node 24 or newer. Uses public mainnet RPC; no key needed. Set `SOLANA_RPC_URL` to use your own.

```bash
git clone https://github.com/staccDOTsol/ftl && cd ftl && (cd server && npm ci)
shasum -a 256 docs/heldout/*/idl.json
```

```bash
# Decode transactions that land after you start, with the frozen file
node server/scripts/composer-heldout.ts --fresh docs/heldout/BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW
```

```bash
# Refetch the published held-out signatures from mainnet and decode them again
node server/scripts/composer-heldout.ts --refetch docs/heldout/BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW
```

```bash
# Offline: re-hash the files and re-decode the archived receipts
node server/scripts/composer-heldout.ts --replay docs/heldout/8W1eTHggBnxzPHc6cis83rPJgzDKCbqyo4W49dMYVEAY
```

Each mode prints one line per instruction (`PASS`, `FAIL`, or `SKIP` for an excluded Anchor event self-CPI) and then a JSON summary. `--refetch` exits non-zero if mainnet disagrees with the published result.
