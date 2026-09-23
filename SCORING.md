# Scoring model

Audience: engineers working on Token Finder's ranking.

Status: **§5.1 and §5.2 are fixed** (Phase 1, data integrity). This document now describes
`src/core/score.ts` as it behaves after that fix; the original audit findings are kept below
with their resolution, because the measured evidence is what justifies the change.
Everything in §5.3–§5.6 remains open.

Evidence comes from a real 60-token scan (2026-09-23, keyless sources only) stored in
`data/state.json`. Numbers are measured, not estimated.

## 1. How a score is produced

```
base     = Σ (component.value × component.weight) × 100   # component.value in [0,1] or UNKNOWN
total    = base × Π penalties                             # penalties are multiplicative
coverage = Σ (weight × component.coverage) / Σ weight     # share of weight backed by evidence
ceiling  = 100 × coverage                                 # the most this token could have scored
grade    = A >=75 · B >=60 · C >=45 · D >=30 · F <30
```

**An UNKNOWN component contributes 0 to the numerator and keeps its weight.** Missing evidence
therefore cannot earn a single point, and the score stays out of a fixed 100 rather than being
renormalised over whatever happened to be available. `ceiling` states the consequence directly:
a token with 65% coverage cannot exceed 65 before penalties.

Three states are distinguished throughout, and they are not interchangeable:

| State | Meaning | Points | Coverage |
|---|---|---|---|
| **measured value** | the provider returned a figure | scored normally | counts |
| **measured zero** | e.g. a real pool that traded nothing | 0 | counts |
| **UNKNOWN** | no provider returned anything | 0 | does **not** count |

`total` is bounded only by `multiplier >= 0.1`. There is still no hard veto: **every token gets a
score and appears in the ranking**, however dangerous. (Phase 2.)

## 2. Components as implemented

| # | Component | Metric | Source | Normalization | Weight | Max pts |
|---|---|---|---|---|---|---|
| 1 | Safety | authority state, concentration, RugCheck risk, organic score | Jupiter `audit`, **RugCheck risks**, then Helius; RugCheck `score_normalised`; Jupiter `organicScore` | fixed sub-weights; unknown sub-parts score 0 and are **not** renormalized away | 0.26 | 26.0 |
| 2 | Liquidity | sum of `liquidity.usd` over all pairs | DexScreener, else Jupiter `liquidity` | `logScore(v, 5e3, 5e5)` | 0.18 | 18.0 |
| 3 | Activity | 24h volume / liquidity (turnover) | DexScreener `volume.h24` | `bandScore(log10(t), log10(3), 0.65)` | 0.14 | 14.0 |
| 4 | Holders | `holderCount` | Jupiter **only** | `logScore(v, 50, 5e3)`; `null -> UNKNOWN` | 0.13 | 13.0 |
| 5 | Momentum | `0.6*d1h + 0.4*d6h` | DexScreener `priceChange` | `0.5 + tanh(x/60)/2`; no pair -> UNKNOWN | 0.12 | 12.0 |
| 6 | Buy pressure | buys / (buys+sells), 1h preferred | DexScreener `txns` | `(r-0.35)/0.3` clamped; `<10 trades -> UNKNOWN` | 0.09 | 9.0 |
| 7 | Age | hours since earliest known pool | DexScreener `pairCreatedAt`, Jupiter `firstPool.createdAt` (min) | `bandScore(log10(h), log10(12), 0.75)`; `null -> UNKNOWN` | 0.08 | 8.0 |

Why each is included: safety because rug-ability dominates expected value on new tokens;
liquidity because it decides whether an exit is possible at all; activity to punish both dead
and wash-traded pools; holders as a distribution-breadth proxy; momentum and pressure for
short-window demand; age to favour tokens past the chaotic open but still new.

Safety sub-weights: authority-mint 0.30, authority-freeze 0.20, concentration 0.20,
RugCheck 0.20, organic 0.10 — **fixed, never renormalized.** Renormalising let a single known
sub-part stand in for four missing ones, which is the same defect as a neutral default wearing
a different hat. A missing sub-part now scores 0 and keeps its weight, so absent safety evidence
visibly lowers the safety value instead of being invisible.

## 3. Penalties (the only downward force)

| Flag | Trigger as coded | Multiplier |
|---|---|---|
| `mint_authority` | authority resolves to live (`false`), including via a RugCheck danger | x0.55 |
| `freeze_authority` | authority resolves to live (`false`), including via a RugCheck danger | x0.45 |
| `provider_conflict` | providers disagree on authority; unsafe reading taken | none (flag only) |
| `incomplete_evidence` | one or more components are UNKNOWN | none (flag only) |
| `impersonation_suspected` | advisory Jev naming check, p >= 0.7 | **none — never scored** |
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

### 5.1 Missing data earns points — FIXED

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

#### Resolution

`analyze.ts` no longer substitutes `EMPTY_FRAMES`. `priceChange`, `volume24h`, `liquidityUsd`
and the trade counts are `null` when unmeasured, and `score.ts` maps each to UNKNOWN: zero
points, weight retained, listed in `score.unknown`.

Measured against the stored corpus of 159 tokens (re-scoring every snapshot with the fixed
scorer):

| | before | after |
|---|---|---|
| mean score | 43.8 | 38.4 |
| tokens at or above the 70 alert threshold | 14 | 13 |
| JEANPHIL | **70.2 (B, alerts)** | **60.6 (B, does not alert)** |

JEANPHIL lands within 0.1 of the 60.7 predicted above; the difference is a liquidity reading
that moved between the audit scan and the stored snapshot. A live scan reproduced it at 60.3
and emitted `score_down: JEANPHIL score 70.2 -> 60.3`.

Only one token stopped alerting, which matches the original finding: the defect manufactures
individual false positives at the threshold rather than distorting the whole ranking.

Alerting additionally now requires `coverage >= MIN_COVERAGE_ALERT` (default 0.6), so a high
score assembled from a third of the inputs cannot raise an alert at all.

### 5.2 A cross-provider `danger` signal is silently downgraded to partial credit — FIXED

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

#### Resolution

`authorityState()` now consults RugCheck alongside Jupiter and Helius. A `danger`/`warn` risk
naming an authority resolves that authority to **live**, and:

- it overrides a `null` from Jupiter — the PEPE case, which now takes the full x0.55 penalty;
- it overrides a *contradicting* claim of revocation, and raises `provider_conflict` so the
  disagreement is visible rather than silently resolved;
- its **absence** is still UNKNOWN, never evidence of revocation — RugCheck can only assert
  the dangerous case, so silence from it means nothing either way.

Unknown authority now earns 0 rather than 0.35 partial credit, removing the "leave Jupiter
audit fields unpopulated" reward listed in §5.5.

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
| Launch without a DexScreener pair | free | **fixed (5.1)** — earns 0 and lowers coverage below the alert gate |
| Leave Jupiter audit fields unpopulated | free | **fixed (5.2)** — earns 0; RugCheck danger still resolves authority |
| Name a token to impersonate an established one | free | advisory Jev flag only, never scored (§6) |

### 5.6 Other defects

- **No hard veto** — live mint authority is penalized, never excluded.
- **`age` takes `min()` of pool timestamps**, so a relaunch on a new pool inherits the old age.
- Grade thresholds are uncalibrated against any outcome data; A/B/C/D/F is asserted.
- Baseline distribution: A 11, B 11, C 17, D 21, **F 0** — nothing was graded F.


## 6. Impersonation screening (advisory, optional)

An optional check using TypeSafe's Jev model, off unless `TYPESAFE_ENABLED=true` and a key is
set. It answers one Noul question: does this token's naming mimic an established token?

What keeps it honest:

- **It never touches the score.** There is no penalty multiplier for it. It raises an
  `impersonation_suspected` flag at p >= 0.7 and nothing else. A naming judgement is not proof
  of fraud and must not silently move a ranking.
- **Evidence is supplied, not recalled.** The request carries an explicit list of reference
  tokens from `src/sources/reference-tokens.ts`. The model is never asked "is this real?",
  which would rest on unverifiable model knowledge.
- **Code does the exact work.** A deterministic pre-filter (normalisation, homoglyph folding,
  edit distance) decides whether any lookalike exists. No lookalike, no request. Tokens that
  are themselves on the reference list are never screened.
- **Failures are never "safe".** Missing credentials, HTTP errors, timeouts and malformed
  bodies all produce `not_assessed` with a reason. There is deliberately no status meaning
  "clean", so absence of an assessment cannot be read as absence of risk.
- **External text is untrusted.** Token names and symbols are control-stripped, whitespace
  collapsed and truncated, then placed only in a labelled state field — never concatenated
  into the question. Jev is documented as vulnerable to prompt injection placed in state, so
  the text is bounded rather than assumed harmless.

Stored on each snapshot as `impersonation`: status, probability, model id, timestamp, question
id, and the exact evidence references used.

**Known limitation:** the reference list is a hand-transcribed starter set. A wrong mint would
let a genuine token fail the self-match check and draw a false advisory flag. Because the flag
is never scored the blast radius is a misleading badge, not a ranking error — but the list
should be verified against a registry, or replaced by Jupiter's verified-token feed.

## 7. Foundation Hardening II — what changed in scoring

The weights in §2 and the penalties in §3 are **unchanged**. Calibrating them needs
outcome data this project does not have, and guessing new numbers would be a worse
error than the correlation it tried to fix. What changed is where the inputs come from
and what happens around the score.

### 7.1 Inputs now come from the evidence model

`scoreToken()` no longer reads provider structs. It reads a resolved `TokenEvidence`
set, so every component knows its source, freshness and confidence, and every
unusable state (UNKNOWN, INVALID, STALE, UNAVAILABLE) earns zero while keeping its
weight. See [PIPELINE.md](PIPELINE.md).

### 7.2 One correctness fix: turnover denominator

Activity is volume over liquidity. Previously the denominator was whatever liquidity
figure survived, which for a token with no DexScreener depth meant **DexScreener volume
divided by Jupiter's wider aggregate** — a ratio describing no real venue. Turnover now
requires the depth of the venue that reported the volume, and is UNKNOWN otherwise.

### 7.3 The score is no longer the only output

| Output | Says |
|---|---|
| `score.total` | how good the token looks |
| `score.coverage` / `score.ceiling` | how much of that rests on real observation |
| `evaluation.coverage.confidence` | what those observations are worth after conflict, age and provider concentration |
| `evaluation.vetoes` | conditions that remove it from the ranking entirely |
| `evaluation.eligibility` | QUALIFIED / WATCH / INSUFFICIENT_DATA / REJECTED |
| `evaluation.state` | lifecycle position |

These are never multiplied together. A high score on thin evidence is now visibly a
different object from a high score on complete evidence.

### 7.4 Hard veto replaces "penalise and hope"

§5.6 recorded that no condition removed a token from the ranking. Seven now do — see
[PIPELINE.md](PIPELINE.md) §4. The `mint_authority` and `freeze_authority` penalties in
§3 still exist for tokens that somehow pass the gate, but in practice a live authority
is now a rejection, not a x0.55 multiplier.

### 7.5 Signal correlation, documented not reweighted

§5.4 listed three correlated signal groups. They are now encoded in `SIGNAL_FAMILIES`
and surfaced in the docs, with the double charges (concentration, thin liquidity)
**retained deliberately** — the penalty models a cliff risk the graded score cannot.
See [PIPELINE.md](PIPELINE.md) §7 for the full table and the reasoning.

### 7.6 Measured effect on a live scan

25 tokens, 23 overlapping with the previous behaviour:

| | |
|---|---|
| mean score delta | **-1.22** (residual live-market drift between scans) |
| mean coverage delta | **0.000** |
| tokens with provider conflicts | 3 (all genuine launch-time disagreements) |
| vetoes fired | `AUTHORITY_MINT_ACTIVE`, `AUTHORITY_FREEZE_ACTIVE`, `CRITICAL_RUGCHECK` |
| newly rejected | `CRWV` (live mint + freeze authority), `SWEEP` (RugCheck critical) |

An earlier iteration of this phase showed a **-7.45** mean delta and 18 of 23 tokens
CONFLICTED. That was a defect in this work, not a finding: the liquidity conflict
tolerance was 5%, which is narrower than the genuine scope difference between
DexScreener and Jupiter, and it pushed turnover into a cross-provider refusal on nearly
every token. Both were fixed before this phase closed — the smoke test earned its keep.

### 7.7 Still open from §5

§5.3 (provider concentration) is now *measured and reported* per token rather than
fixed — with no key, Jupiter still supplies most of the evidence for most tokens, and
`providerConcentration` says so. §5.4 is documented, not resolved. §5.5's attack table
is unchanged except that the two rewarded attacks are now closed and the authority
attacks are vetoes. §5.6's grade calibration is untouched: A/B/C/D/F remains asserted.
