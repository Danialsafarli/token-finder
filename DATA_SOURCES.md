# Data sources — live validation and strategy

Audience: engineers wiring providers into Token Finder.
Part 1 is measured. Part 2 is a proposal; **none of it is implemented.**

Probe run 2026-09-23 against live mainnet endpoints, no API keys configured.

## Part 1 — Live validation (measured)

| Provider | Status | Auth | Latency | Used for |
|---|---|---|---|---|
| DexScreener | **LIVE** | none | 21–104 ms | discovery, pairs, price, liquidity, volume, txns, age, socials |
| Jupiter | **LIVE** | none | 52–135 ms | discovery, metadata, holders, audit, organic score, liquidity fallback |
| RugCheck | **LIVE** | none | 82 ms | risk list, normalized risk score |
| Helius | **UNAVAILABLE** | API key required | 401 in 75 ms | nothing — 0 of 60 tokens enriched |
| Birdeye | **UNAVAILABLE** | API key required | 401 in 108 ms | nothing — 0 candidates returned |

### DexScreener — LIVE DATA

| Endpoint | Result |
|---|---|
| `/token-profiles/latest/v1` | 200, 30 items — `url, chainId, tokenAddress, icon, header, openGraph, description, links, cto` |
| `/token-boosts/latest/v1` | 200, 30 items — adds `totalAmount, amount` |
| `/latest/dex/tokens/{mint}` | 200, 10 pairs — `chainId, dexId, url, pairAddress, labels, baseToken, quoteToken, priceNative, priceUsd, txns, volume, priceChange, liquidity, fdv, marketCap, pairCreatedAt, info` |

Fields we consume: `liquidity.usd` (e.g. `{usd: 96264.92, base: 7513530, quote: 479.42}`),
`txns.h24` (e.g. `{buys: 2878, sells: 2297}`), `volume`, `priceChange`, `pairCreatedAt`
(epoch ms, verified as a real date), `info.socials`, `info.websites`, `info.imageUrl`, `boosts`.
Discarded: `labels`, `priceNative`, `openGraph`, `cto`, `header`.

Freshness: `pairCreatedAt` resolved to a correct ISO timestamp; price/volume windows are
provider-computed rolling aggregates, not tick data.

**Known inconsistency — coverage gap.** `/latest/dex/tokens/{mint}` returned no Solana pair
for **21 of 60** tokens that Jupiter reported as live with non-zero liquidity. DexScreener is
therefore *not* a complete view of tradable tokens. This gap is the direct cause of the
fabricated-momentum defect in `SCORING.md` §5.1.

Fallback behaviour: `tryGetJson` swallows the error and returns `null`; `pairsForMints` simply
omits the mint from its map. `analyze.ts` then substitutes zeros. **There is no "unknown" state.**

### Jupiter — LIVE DATA

| Endpoint | Result |
|---|---|
| `/tokens/v2/recent` | 200, 30 items |
| `/tokens/v2/search?query={mints}` | 200, 1 item for a single mint |
| `/tokens/v2/toporganicscore/1h?limit=100` | 200, 100 items |

Fields actually received: `id, name, symbol, icon, decimals, twitter, dev, circSupply,
totalSupply, tokenProgram, launchpad, metaLaunchpad, partnerConfig, graduatedPool,
graduatedAt, holderCount, fdv, mcap, usdPrice, priceBlockId, liquidity, stats5m, stats1h,
stats6h, stats24h, firstPool, audit, organicScore, organicScoreLabel, tags, createdAt, updatedAt`.

Verified live values: `audit = {mintAuthorityDisabled: true, freezeAuthorityDisabled: true,
topHoldersPercentage: 16.60, devBalancePercentage: 0.019, devMigrations: 1, devMints: 8}`;
`organicScore: 84.47`, `organicScoreLabel: "high"`, `holderCount: 8417`;
`firstPool: {id, createdAt: "2026-09-18T21:27:52Z"}`;
`stats24h` keys: `priceChange, holderChange, liquidityChange, volumeChange, buyVolume,
sellVolume, buyOrganicVolume, sellOrganicVolume, numBuys, numSells, numTraders,
numOrganicBuyers, numNetBuyers`.

We consume roughly a third of this. Discarded fields are listed in `SCORING.md` §4.

**Known inconsistency — `audit` fields can be `null`.** Observed on token `PEPE`, where
RugCheck simultaneously reported mint authority as live. Jupiter's audit block is *not*
authoritative and must be cross-checked.

Coverage: **60 of 60** analyzed tokens had Jupiter data — currently our most complete source,
and consequently our largest single-provider dependency.

### RugCheck — LIVE DATA

`/v1/tokens/{mint}/report/summary` returned 200 in 82 ms.
Response keys: `tokenProgram, tokenType, risks, score, score_normalised, lpLockedPct`.

Verified: a healthy token returned `{risks: [], score: 1, score_normalised: 1,
lpLockedPct: 42.39}` — confirming **lower = safer** for both score fields. Individual risks
carry large raw scores (`Mint Authority still enabled` had `score: 50000`), so only
`score_normalised` (0–100) is safe to use as a ratio, which is what the code does.

**`lpLockedPct` is received in every response and discarded by `rugcheck.ts`.**

Coverage: **60 of 60**. Risks list non-empty for 15 of 60.

### Helius — UNAVAILABLE DATA

`POST https://mainnet.helius-rpc.com/?api-key=` returned **401 Unauthorized**. With no key,
`onchainInfo()` returns `null` before making any call. Measured: `onchain present: 0 of 60`.
Every on-chain code path — `getAccountInfo` authority parsing, `getTokenLargestAccounts`
concentration — is **unexercised and untested against a real response.**

### Birdeye — UNAVAILABLE DATA

`GET /defi/v2/tokens/new_listing` returned **401 Unauthorized** (`{success, message}`).
`newListings()` returns `[]` when unkeyed. Measured: `birdeye:new: 0 candidates`.
The `overview()` path is likewise unexercised.

### Rate limits encountered

**No provider returned any rate-limit header** — not `x-ratelimit-*`, `ratelimit-*`, or
`retry-after`. Our limiter in `src/util/http.ts` is therefore **open-loop**: self-imposed
RPM values (DexScreener 120, Jupiter 120, RugCheck 30, Birdeye 50, Helius 120) are guesses,
not negotiated. No 429 was observed in either scan.

RugCheck at 30 RPM is the structural bottleneck: 60 tokens = ~120 s. Measured cold scan
123.0 s, second scan 122.8 s — **no improvement, because `TtlCache` is per-process and a CLI
invocation starts empty.** The 20-minute cache only helps inside a long-lived `serve` process.

## Part 2 — Proposed provider strategy (NOT IMPLEMENTED)

Principle: no single provider should decide a ranking where independent verification exists.

| Concern | Canonical | Validation | Fallback | Notes |
|---|---|---|---|---|
| New-token discovery | Helius (webhook/WS on pool-init) | Jupiter `recent` | DexScreener profiles/boosts, Birdeye | today: polled REST only |
| Price / market | DexScreener | Jupiter `usdPrice` | Birdeye | disagreement >X% should flag, not average |
| Liquidity | DexScreener pair sum | Jupiter `liquidity` | Birdeye | today Jupiter is silent fallback with no comparison |
| LP lock / burn | RugCheck `lpLockedPct` | Helius (verify burn on-chain) | — | currently discarded |
| Mint/freeze authority | **Helius (on-chain truth)** | RugCheck risks, Jupiter `audit` | — | on-chain must outrank any API opinion |
| Holder count | Helius (`getTokenAccounts`) | Jupiter `holderCount` | Birdeye | today Jupiter-only |
| Holder concentration | Helius, pool vaults excluded | Jupiter `topHoldersPercentage` | RugCheck | today includes pool vaults = upper bound |
| Creator history | Jupiter `dev`/`devMints` | Helius tx history | RugCheck `creator_history_of_rugged_tokens` | all three currently unused or partial |
| Volume quality | Jupiter organic volume fields | DexScreener txns | Birdeye | today a turnover ratio only |
| Momentum | DexScreener `priceChange` | Jupiter `stats5m/1h/6h` | Birdeye | today DexScreener-only, zeros on absence |
| Realtime | Helius WS / Yellowstone gRPC | — | polling | no realtime ingestion exists |
| Execution | Jupiter swap API | — | — | no execution exists |

Cross-validation rules to add: treat provider **disagreement as a risk signal** rather than
picking a winner; require two independent sources before any safety component earns full
credit; propagate an explicit `UNKNOWN` state end-to-end instead of coercing to a neutral number.
