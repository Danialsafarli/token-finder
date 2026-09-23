# Scoring model — baseline audit

Audience: engineers working on Token Finder's ranking.
Status: describes `src/core/score.ts` as committed. **Nothing proposed here has been implemented.**

Evidence comes from a real 60-token scan (2026-09-23, keyless sources only) stored in
`data/state.json`. Numbers are measured, not estimated.

## 1. How a score is produced

```
base  = Σ (component.value × component.weight) × 100      # component.value in [0,1]
total = base × Π penalties                                # penalties are multiplicative
grade = A >=75 · B >=60 · C >=45 · D >=30 · F <30
```

`total` is bounded only by `multiplier >= 0.1`. There is no hard veto: **every token gets a
score and appears in the ranking**, however dangerous.

## 2. Components as implemented

| # | Component | Metric | Source | Normalization | Weight | Max pts |
|---|---|---|---|---|---|---|
| 1 | Safety | authority state, concentration, RugCheck risk, organic score | Jupiter `audit` then Helius; RugCheck `score_normalised`; Jupiter `organicScore` | weighted mean of *available* sub-parts, renormalized by present weight | 0.26 | 26.0 |
| 2 | Liquidity | sum of `liquidity.usd` over all pairs | DexScreener, else Jupiter `liquidity` | `logScore(v, 5e3, 5e5)` | 0.18 | 18.0 |
| 3 | Activity | 24h volume / liquidity (turnover) | DexScreener `volume.h24` | `bandScore(log10(t), log10(3), 0.65)` | 0.14 | 14.0 |
| 4 | Holders | `holderCount` | Jupiter **only** | `logScore(v, 50, 5e3)`; `null -> 0.2` | 0.13 | 13.0 |
| 5 | Momentum | `0.6*d1h + 0.4*d6h` | DexScreener `priceChange` | `0.5 + tanh(x/60)/2` | 0.12 | 12.0 |
| 6 | Buy pressure | buys / (buys+sells), 1h preferred | DexScreener `txns` | `(r-0.35)/0.3` clamped; `<10 trades -> 0.4` | 0.09 | 9.0 |
| 7 | Age | hours since earliest known pool | DexScreener `pairCreatedAt`, Jupiter `firstPool.createdAt` (min) | `bandScore(log10(h), log10(12), 0.75)` | 0.08 | 8.0 |

Why each is included: safety because rug-ability dominates expected value on new tokens;
liquidity because it decides whether an exit is possible at all; activity to punish both dead
and wash-traded pools; holders as a distribution-breadth proxy; momentum and pressure for
short-window demand; age to favour tokens past the chaotic open but still new.

Safety sub-weights: authority-mint 0.30, authority-freeze 0.20, concentration 0.20,
RugCheck 0.20, organic 0.10 — **renormalized over whichever parts exist.**

## 3. Penalties (the only downward force)

| Flag | Trigger as coded | Multiplier |
|---|---|---|
| `mint_authority` | authority state is **exactly `false`** | x0.55 |
| `freeze_authority` | authority state is **exactly `false`** | x0.45 |
| `concentration` | top holders >= 60% | x0.70 |
| `thin_liquidity` | liquidity < `MIN_LIQUIDITY_USD` | x0.65 |
| `wash_suspect` | turnover > 50x **and** liquidity < $100K | x0.80 |
| `rugcheck:*` at `danger` | any RugCheck danger risk | x0.85 each |
| `no_socials`, `jup_verified` | informational only | none |

Measured: **15 of 60 tokens received any penalty.** Flag frequency:
`no_socials` 27, `rugcheck:large_amount_of_lp_unlocked` 9, `rugcheck:low_liquidity` 6,
`rugcheck:low_amount_of_lp_providers` 6, `wash_suspect` 4, `concentration` 2,
`rugcheck:creator_history_of_rugged_tokens` 2, `rugcheck:mint_authority_still_enabled` 1,
`rugcheck:mutable_metadata` 1, `rugcheck:copycat_token` 1.

## 4. Signal classification

**POSITIVE SIGNALS** — liquidity depth, turnover near 3x, holder count, 1h/6h price change,
buy ratio, age near 12h, Jupiter `organicScore`, Jupiter verification (flag only, no points).

**RISK SIGNALS** — live mint/freeze authority, top-holder concentration, liquidity below
floor, extreme turnover, any RugCheck `danger`/`warn` risk.

**HARD VETO CONDITIONS — none exist.** No condition removes a token from the ranking. The
dashboard `hideRisky` filter is presentation-only and defaults to off.

**UNKNOWN / NOT MEASURED** — received from providers then discarded, or never requested:

| Available but unused | Source | Why it matters |
|---|---|---|
| `lpLockedPct` | RugCheck, in every response | LP lock % is the most direct rug predictor; `large_amount_of_lp_unlocked` was our 2nd most common risk yet the number itself is dropped |
| `dev`, `devMints`, `devMigrations` | Jupiter `audit` | Serial-launcher detection; `devMints: 8` means the creator has minted 8 tokens |
| `buyOrganicVolume`, `sellOrganicVolume`, `numOrganicBuyers`, `numNetBuyers` | Jupiter `stats*` | Volume quality — would replace the crude turnover heuristic |
| `holderChange`, `liquidityChange` | Jupiter `stats*` | Direction of holder/LP flow, not just level |
| `stats5m`, `stats1h`, `stats6h` | Jupiter | We read only `stats24h`, then take momentum from DexScreener instead |
| `launchpad`, `graduatedPool`, `graduatedAt` | Jupiter | Launch venue and bonding-curve graduation state |
| `circSupply`, `totalSupply` | Jupiter | Float vs. total supply; unlock overhang |
| `labels`, `priceNative` | DexScreener | Pair version and type |
| wallet clustering, sybil/bundler detection | not requested | Not measured at all |
| LP burn verification, creator on-chain history | not requested | Not measured at all |

## 5. Measured weaknesses

### 5.1 Missing data earns points

`analyze.ts` substitutes `EMPTY_FRAMES` (`{m5:0,h1:0,h6:0,h24:0}`) when no DexScreener pair
exists. Zero change is then scored as *neutral*, not *unknown*:

- Momentum: `0.5 + tanh(0/60)/2 = 0.500` -> **6.0 of 12 points awarded**
- Buy pressure: `null -> 0.4` -> **3.6 of 9 points awarded**

**21 of 60 tokens (35%) had no DexScreener pair.** 23 of 60 scored momentum at exactly 0.500.
22 of 60 had `volume24h === 0`.

Worked example — `JEANPHIL`, which **crossed `MIN_SCORE_ALERT=70` and raised an alert**:

```
pair: null   priceUsd: 0.00742   volume24h: 0   liquidityUsd: 595,906 (Jupiter only)

safety    0.972 x 0.26 = 25.3
liquidity 1.000 x 0.18 = 18.0
activity  0.000 x 0.14 =  0.0
holders   1.000 x 0.13 = 13.0
momentum  0.500 x 0.12 =  6.0   <- from data that does not exist
pressure  0.400 x 0.09 =  3.6   <- from data that does not exist
age       0.550 x 0.08 =  4.4
base 70.3   penalty 0%   total 70.3 (B)
```

**9.6 points — 13.7% of its score — are fabricated.** Scored honestly (unknown = no credit)
it lands at 60.7 and does not alert.

Average score without a pair 43.6, with a pair 61.1 — the defect does not dominate the
ranking, but it does manufacture individual false positives at the alert threshold.

### 5.2 A cross-provider `danger` signal is silently downgraded to partial credit

`authorityState()` reads `jupiter.audit.mintAuthorityDisabled ?? (helius ? ... : null)`.
**RugCheck is never consulted for authority state**, and the `mint_authority` penalty fires
only on exactly `false`, never on `null`.

Observed — token `PEPE` (`PEPEqnuuCDbBC89p1u9vpnP1KQ2oj1xTcQBsjt9X55m`):

| Provider | Says |
|---|---|
| RugCheck | `Mint Authority still enabled`, level `danger` — "More tokens can be minted by the owner" |
| Jupiter `audit.mintAuthorityDisabled` | `null` (unknown) |
| **Token Finder** | mint state "unknown" -> **0.35 partial credit**; x0.55 penalty **not applied** |

The strongest danger signal available was present in a response we had already parsed, and
was discarded. Only the generic x0.85 `rugcheck:*` multiplier applied.

### 5.3 Provider concentration and circularity

- **Holders (13%) come from Jupiter alone.** With no key there is no second source, and
  `null -> 0.2` still awards 2.6 points.
- **Safety is ~60% Jupiter-derived** when Helius is absent — which is the default.
- **Selection circularity:** `jupiter:organic` supplied **39 of 60** analyzed tokens, and
  Jupiter's `organicScore` is then a scoring input. We largely re-rank a list Jupiter
  pre-ranked, using Jupiter's own ranking signal.
- With no keys, **Helius contributes to 0 of 60 tokens** (`onchain present: 0`), so every
  on-chain fallback path is dead code in the default configuration.
- Only **4 of 60** tokens were found by more than one feed, and `sources` is stored but
  never used as corroboration in scoring.

### 5.4 Redundancy and correlation

- Liquidity (18%) and Activity (14%) share `liquidityUsd`; turnover divides by the same
  number, so one bad liquidity reading moves two components in opposite directions.
- Holders (13%) and Jupiter `organicScore` (inside Safety) both proxy organic interest.
- Concentration is charged twice: as a Safety sub-part *and* as the `concentration` penalty.

### 5.5 Exploitability

| Attack | Cost | Current defense |
|---|---|---|
| Seed removable liquidity to clear the floor | one-time capital | none — `lpLockedPct` is discarded |
| Split wash volume to sit near 3x turnover | low | `wash_suspect` needs >50x **and** <$100K |
| Airdrop to fresh wallets to inflate holders | very low | none — no clustering or sybil detection |
| Launch without a DexScreener pair | free | **rewarded** — 9.6 pts of fabricated credit (5.1) |
| Leave Jupiter audit fields unpopulated | free | **rewarded** — `null` earns 0.35 credit (5.2) |

### 5.6 Other defects

- **No hard veto** — live mint authority is penalized, never excluded.
- **`age` takes `min()` of pool timestamps**, so a relaunch on a new pool inherits the old age.
- Grade thresholds are uncalibrated against any outcome data; A/B/C/D/F is asserted.
- Baseline distribution: A 11, B 11, C 17, D 21, **F 0** — nothing was graded F.
