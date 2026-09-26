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

Since then the parsing has been split out of the network call (`parseMint` in
`src/sources/helius.ts`) and verified against **real mainnet mint accounts** fetched from
the public Solana RPC:

| Mint | Result |
|---|---|
| USDC, BONK, TRUMP | `LEGACY_SPL_TOKEN`, extensions MEASURED-and-empty |
| PYUSD | `TOKEN_2022`, 8 extensions decoded, permanent delegate **set** -> `PERMANENT_DELEGATE_ACTIVE` |

That run also confirmed the jsonParsed `state` field names this build expects
(`permanentDelegate.delegate`, `transferFeeConfig.newerTransferFee.transferFeeBasisPoints`,
`mintCloseAuthority.closeAuthority`), and surfaced one real gap —
`confidentialTransferFeeConfig` was unregistered, correctly degraded to `UNKNOWN_POLICY`
and marked the read incomplete rather than passing silently. It is now registered.

**Still unexercised against a live response:** `getTokenLargestAccounts`. The public RPC
rate-limits it unconditionally (HTTP 429 on every attempt), so holder concentration has
**not** been verified end-to-end against the chain. It is covered by unit tests over
literal RPC payloads, which is not the same thing. Note the observed degradation is the
intended one: with the holder call failing, supply parsed correctly and concentration
came back `null`, not `0`.

That BONK run is also the concrete case for exact arithmetic: its on-chain supply is
`8799438501691764747`, which `Number()` renders as `8799438501691764736`.

### Birdeye — UNAVAILABLE DATA

`GET /defi/v2/tokens/new_listing` returned **401 Unauthorized** (`{success, message}`).
`newListings()` returns `[]` when unkeyed. Measured: `birdeye:new: 0 candidates`.
The `overview()` path is likewise unexercised.

### Where provider observations are now kept

Provider failures, per-metric canonical evidence (state, source, freshness,
confidence) and the market/holder/pool readings behind each verdict are
persisted to SQLite from this phase forward - see **[PERSISTENCE.md](PERSISTENCE.md)**.
Raw provider bodies are deliberately **not** stored, and credentials are
redacted before any write: some provider URLs carry the key in the query string
and an undici error embeds the URL it failed on.

### Keyed and keyless operation

The tool runs with no API key, and the product says what that costs instead of hiding
it. `src/core/capabilities.ts` is the one list of what this configuration can check. The
System page renders it, and the Board and Dossier derive their notices from it.

| Capability | Provider | Without its key |
|---|---|---|
| Market data | DexScreener + Jupiter | Keyless; always on. `DEGRADED` when either failed recently. |
| Third-party safety reports | RugCheck | Keyless; always on. |
| On-chain authority check | Helius | **Off.** Mint and freeze authority come from Jupiter and RugCheck reports only; nothing confirms them against the chain. |
| Token-2022 extension analysis | Helius | **Off.** Extensions are not inspected. A permanent delegate or transfer hook cannot be detected, and is not vetoed for. `mintExtensions` and `tokenProgram` are `UNAVAILABLE` for every token. |
| Exact holder concentration | Helius | **Off.** Concentration is Jupiter's reported figure, when Jupiter reports one. |
| Birdeye listing discovery | Birdeye | **Off.** Discovery uses the Jupiter and DexScreener feeds. |
| Impersonation screening | TypeSafe | `DISABLED` by design. Advisory only; never affects a verdict. |

For a metric that is off for every token, the Dossier gives the reason as "Needs a Helius
API key", not "no provider reported". The first reason describes the configuration; the
second would falsely describe the token.

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

## TypeSafe (Jev) — optional, advisory only

| | |
|---|---|
| Endpoint | `POST https://api.typesafe.ai/v1/systemone` |
| Auth | `Authorization: Bearer $TYPESAFE_API_KEY` — server-side only |
| Used for | one Noul question: does this token's naming impersonate an established token? |
| Default | **off** (`TYPESAFE_ENABLED=false`) |
| Budget | `TYPESAFE_MAX_PER_SCAN` (default 10), reset each scan |
| Cache | 6h in-process, keyed by mint + sanitised naming + reference-list id |
| Rate limit | 60 rpm self-imposed in `util/http.ts` |

Unlike every other source here, this one returns a **judgement, not a measurement**. It is
therefore kept out of the score entirely and surfaces only as an advisory flag.

Failure semantics differ from the other providers too. The rest fail soft to `null`, which
scoring reads as UNKNOWN. This one fails to an explicit `not_assessed` record carrying the
reason, because the question "was this checked?" has to stay answerable — a missing assessment
must never be mistaken for a clean one.

**Not verified against the live API.** No credentials were available, so the request and
response shapes come from the published API reference and the integration has only been
exercised against mocked responses. `node src/cli.ts typesafe-check` makes one minimal request
to confirm credentials and connectivity once a key is configured.

## Provider boundary and trust (Foundation Hardening II)

Every field listed in this document now passes an explicit validator before it can
reach scoring. The per-provider field rules are tabulated in
**[PIPELINE.md](PIPELINE.md) §1**; the short version is that a field which is *absent*
stays UNKNOWN and earns nothing, while a field which is *present but impossible* is
rejected, recorded as a `FieldIssue`, and reported as INVALID — a different state, and
never mistaken for zero or for safe.

Provider trust, used when two providers speak to the same fact:

| Provider | Trust | Why |
|---|---|---|
| Helius | 1.00 | reads the chain directly; on authority it is ground truth, not a report about it |
| RugCheck | 0.95 | second-hand, but the only source that asserts named danger conditions |
| DexScreener | 0.90 | direct venue observation, but only the venues it indexes |
| Jupiter | 0.85 | second-hand; its `audit` block is the one observed to carry nulls where RugCheck carries a finding |

### These providers do not measure the same liquidity

DexScreener sums the pairs it indexes. Jupiter aggregates a wider venue set. On a live
23-token sample the two differed by tens of percent on most tokens — **that is scope,
not disagreement**. Treating a 5% gap as a contradiction marked 18 of 23 tokens
CONFLICTED and made the flag meaningless, so the conflict threshold is 3x.

Two consequences, both deliberate:

- The **resolved** `liquidityUsd` is always the lower of the two, agreement or not: an
  exit faces the depth that is really there.
- **Turnover divides by DexScreener's own depth**, not the resolved figure, because the
  volume came from those pairs. Mixing them describes a venue that does not exist.

### Freshness

Each observation carries when it was seen, and each metric has its own window (see
PIPELINE.md §2). RugCheck and Helius results are cached for 20 and 10 minutes
respectively, so they can legitimately be older than the market data in the same
snapshot — which is exactly why freshness is per-metric rather than per-scan.
