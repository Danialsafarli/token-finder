# Pipeline, evidence and the safety gate

Audience: engineers working on Token Finder's analysis path.
Status: **implemented**. This document describes `src/core/` as it runs today.

The prototype turned provider JSON into a number. This describes what replaced that:
a pipeline where every value carries its provenance, missing evidence is visible,
and some conditions remove a token from the ranking instead of nudging its score.

```
DISCOVERY            src/core/discover.ts        five feeds, deduped by mint
      |
PROVIDER VALIDATION  src/core/validate.ts        per-field type and range checks
      |
NORMALIZATION        src/sources/*.ts            raw JSON -> typed provider structs
      |
CROSS-PROVIDER       src/core/resolve.ts         one canonical evidence set
EVIDENCE
      |
SAFETY GATE          src/core/gate.ts            vetoes, evaluated before ranking
      |
SIGNAL ENGINE        src/core/score.ts           components from evidence only
      |
COVERAGE/CONFIDENCE  src/core/lifecycle.ts       three separate numbers
      |
SCORING              src/core/score.ts           weighted base x penalties
      |
RANKING ELIGIBILITY  src/core/lifecycle.ts       QUALIFIED / WATCH / ... / REJECTED
      |
MONITORING           src/core/monitor.ts         state transitions, events
```

## 1. Provider boundary validation

Nothing reaches the evidence model without passing `src/core/validate.ts`. Each
provider adapter builds a `ValidationReport`; rejected fields become `null` and are
recorded as a `FieldIssue` carrying the field path, the reason, and what arrived.

The distinction that matters:

| Situation | Result | Meaning |
|---|---|---|
| field absent | `null`, **no issue** | UNKNOWN — we never learned it |
| field present but impossible | `null`, **issue recorded** | INVALID — we got an answer and rejected it |

Deliberately not a schema framework. The set of consumed fields is small and stable,
and an explicit validator per field is easier to audit than a DSL — you can read
exactly what "impossible" means for each one.

### What each provider is checked for

| Provider | Field | Rule |
|---|---|---|
| DexScreener | `liquidity.usd` | number >= 0; negative money is impossible |
| | `priceUsd` | numeric string -> finite number >= 0 |
| | `pairCreatedAt` | ms timestamp, after Solana genesis, not in the future |
| | `volume.*` | number >= 0 per frame |
| | `priceChange.*` | -100 .. 1e6 %; below -100% is impossible |
| | `txns.*.buys/sells` | non-negative integers |
| | `info.*`, `dexId`, symbols | strings, length-capped |
| Jupiter | `audit.mintAuthorityDisabled` | **strict boolean** or null |
| | `audit.freezeAuthorityDisabled` | **strict boolean** or null |
| | `audit.topHoldersPercentage` | 0 .. 100 |
| | `audit.devBalancePercentage` | 0 .. 100 |
| | `organicScore` | 0 .. 100 |
| | `holderCount` | non-negative integer |
| | `liquidity`, `usdPrice`, `mcap`, `fdv` | number >= 0 |
| | `firstPool.createdAt` | ISO string or epoch -> valid ms timestamp |
| | `stats24h.holderChange` | signed; holders can genuinely fall |
| RugCheck | `score`, `score_normalised` | >= 0; normalised capped at 100 |
| | `risks[].level` | must be one of `danger`/`warn`/`info`/`good` |
| | `risks[].name` | required string; a nameless risk is dropped |
| Helius | `mintAuthority`, `freezeAuthority` | base58 address or null |
| | `decimals` | integer 0 .. 18 |
| | `supply` | numeric string >= 0 |
| | derived `top10Share` | rejected above 1.0 — balances cannot exceed supply |
| TypeSafe | response `noul` | finite number in 0 .. 1 (screening only, never scored) |

Two rules are load-bearing:

- **Strict booleans on authority fields.** A provider sending `"true"` or `1` is a
  provider we have stopped understanding, and guessing there is how a live mint
  authority silently becomes a revoked one.
- **An unrecognised RugCheck severity is dropped, not downgraded to `info`.** Quietly
  demoting an unknown-but-possibly-critical finding to noise is the same failure.

## 2. The evidence model

`src/core/evidence.ts`. Every fact the scorer, gate and UI read is an `Evidence<T>`:

```
value       the resolved value, or null
state       MEASURED | UNKNOWN | CONFLICTED | INVALID | STALE | UNAVAILABLE
source      the provider whose reading won
observedAt  when we saw it
freshness   FRESH | AGING | STALE | UNKNOWN
confidence  0-1, reduced by conflict, age and provider trust
notes       why this won, and what was rejected
claims      every provider claim, kept so disagreement stays visible
```

Only `MEASURED` and `CONFLICTED` can contribute points. **UNKNOWN is never zero, and
INVALID is never safe.** Each state is counted separately in the coverage report, so
"we do not know" can never be read as "it is zero", and "we rejected the answer" can
never be read as "there was nothing wrong".

### Freshness

Per-metric windows, because one global timeout is wrong in both directions — a
20-minute-old price change is useless while a 20-minute-old mint authority is as good
as new.

| Metric | FRESH within | AGING within | Then |
|---|---|---|---|
| `priceChange` | 15 min | 45 min | STALE |
| `volume24h`, `liquidityUsd`, `buyPressure` | 30 min | 90 min | STALE |
| `holders`, `topHoldersPct`, `rugcheckRisk`, `organicScore` | 6 h | 24 h | STALE |
| `mintAuthorityRevoked`, `freezeAuthorityRevoked` | 24 h | 7 d | STALE |
| `ageHours` | never stale — launch time is immutable | | |

AGING evidence is usable at reduced confidence. **STALE evidence is not usable at
all**, so stale market activity can never be scored as current momentum.

## 3. Cross-provider resolution

`src/core/resolve.ts`. Rules, in order:

1. **Every answer rejected** -> `INVALID`. Never UNKNOWN: we did get an answer.
2. **Nobody answered** -> `UNKNOWN`.
3. **One valid claim** -> `MEASURED` at that provider's trust.
4. **Claims agree** -> `MEASURED`. Corroboration cannot make us less sure.
5. **Claims contradict** -> `CONFLICTED`, resolved conservatively, all claims retained.

Provider trust: `helius 1.0` (reads the chain directly), `rugcheck 0.95`,
`dexscreener 0.9`, `jupiter 0.85`.

### Safety facts are resolved conservatively

For mint and freeze authority:

- **A danger assertion beats silence.** RugCheck only ever reports problems, so the
  absence of a finding says nothing at all. This is the SCORING.md §5.2 defect:
  RugCheck said "Mint Authority still enabled" while Jupiter's audit field was null,
  and the null won.
- **A danger assertion beats a contradicting claim of safety.** The result is
  `CONFLICTED` with the dangerous reading as the value, and both claims kept.
- **CONFLICTED still fires the gate, and still earns no positive safety credit.** A
  disputed claim of safety is not a claim of safety.

Deliberate consequence: an on-chain Helius read showing a revoked authority does *not*
override a RugCheck danger finding. On-chain is ground truth and RugCheck's report may
simply be stale, so this will sometimes be wrong in the safe direction. It is recorded
as a conflict rather than silently resolved — trusting one provider absolutely is how
the original defect happened.

### Market facts are resolved conservatively too, but differently

**Liquidity** takes the lower of DexScreener and Jupiter whether or not they agree: an
exit faces the depth that is really there, and the optimistic reading is the one that
costs money if wrong.

The two are only marked `CONFLICTED` when they differ by more than **3x**. DexScreener
sums the pairs it indexes; Jupiter aggregates a wider venue set, so a 40% gap is
*different scope*, not contradiction. An earlier 5% tolerance marked 18 of 23 live
tokens CONFLICTED, which made the flag meaningless — see the smoke-test note in
SCORING.md §7.

**Age** takes the *oldest* known pool: a relaunch should not inherit a fresh age.

**`venueLiquidityUsd`** is DexScreener's own depth, kept separate from the resolved
`liquidityUsd` and used only as the turnover denominator. It is excluded from coverage
because it is the same underlying fact.

## 4. The hard safety gate

`src/core/gate.ts`, evaluated **before** ranking. A penalty multiplier cannot express
"do not show this", because a strong enough token absorbs one and stays near the top.

| Code | Fires when | Source | Re-checkable |
|---|---|---|---|
| `AUTHORITY_MINT_ACTIVE` | mint authority resolves to live | jupiter / rugcheck / helius | yes — can be revoked later |
| `AUTHORITY_FREEZE_ACTIVE` | freeze authority resolves to live | jupiter / rugcheck / helius | yes |
| `CRITICAL_RUGCHECK` | a `danger` finding naming a rugged token or a creator with rug history | rugcheck | **no** — history cannot be undone |
| `UNTRADEABLE` | liquidity measured at exactly 0 | derived | yes |
| `LIQUIDITY_TOO_LOW` | measured liquidity below `MIN_LIQUIDITY_USD` | dexscreener / jupiter | yes |
| `CATASTROPHIC_CONCENTRATION` | Jupiter-measured top holders >= `CATASTROPHIC_CONCENTRATION_PCT` (90) | jupiter only | yes |
| `MALFORMED_TOKEN` | a *critical* field failed validation | validation | yes |

Design rules:

- **Never veto on UNKNOWN.** A veto requires a provider to have actually asserted the
  dangerous condition. Absence of evidence is not evidence of danger.
- **CONFLICTED counts as asserted**, because resolution already took the conservative
  reading.
- **Every veto carries its evidence**: code, reason, source, observed value, timestamp,
  and whether it can clear. A ranking decision nobody can audit is not a safety feature.
- **Concentration vetoes only on Jupiter's figure.** Helius `top10Share` includes AMM
  pool vaults, so vetoing on it would reject healthy tokens whose liquidity simply sits
  in a pool account. The `pool-vault-concentration-not-vetoed` fixture pins this.

The critical RugCheck list is deliberately short. Most `danger` findings (low
liquidity, unlocked LP) are already penalties and scoring inputs; promoting all of them
to vetoes would empty the board. The two listed describe an *actor or construction*
rather than a market condition.

## 5. Coverage, confidence and score are three numbers

Never multiplied together, never collapsed:

- **score** — how good the token looks.
- **coverage** — how much of that rests on real observation. Unknown signals keep their
  weight and earn zero, so 70% coverage caps the score at 70 before penalties
  (`score.ceiling`).
- **confidence** — what the observations are worth once provider disagreement,
  staleness and single-provider dependence are accounted for.

`CoverageReport` counts every eligible signal into exactly one bucket: `measured`,
`unknown`, `conflicted`, `invalid`, `stale`, `unavailable`. It also reports
`providerConcentration` and `dominantProvider` — a token whose entire profile comes
from one source is one outage, or one wrong field, away from being a different token.

## 6. Ranking eligibility and the lifecycle

A numeric score is not a licence to appear in the ranking.

| Eligibility | Condition |
|---|---|
| `REJECTED` | any veto — checked first, so a strong score cannot buy past the gate |
| `INSUFFICIENT_DATA` | coverage < `MIN_COVERAGE_WATCH` (0.35) |
| `WATCH` | coverage < `MIN_COVERAGE_QUALIFY` (0.6) |
| `QUALIFIED` | clean gate, coverage at or above the qualify bar |

`/api/tokens` shows `QUALIFIED` and `WATCH` by default; `?eligibility=all` reveals the
rest. Eligibility outranks every sort key, so even then a rejected token cannot appear
above a qualified one.

States: `DISCOVERED -> SCANNING -> {QUALIFIED | WATCH | INSUFFICIENT_DATA | REJECTED}`,
and every resting state can re-enter `SCANNING`. Nothing is irreversible — a permanent
state would mean trusting one observation forever, and a re-checkable veto must be able
to clear. Illegal transitions are refused rather than silently applied, so a caller bug
surfaces as a stuck token rather than one that teleported past the gate.

**The coverage thresholds are operator-tunable starting points, not calibrated against
outcome data.** Nothing here has been validated against whether a token actually rugged.

## 7. Signal correlation

`SIGNAL_FAMILIES` in `src/core/score.ts` records which signals share an underlying
fact. It is documentation and UI surface, **not** a reweighting mechanism — the weights
are unchanged, because calibrating them needs outcome data the project does not have.

| Family | Signals | Underlying fact | Relationship |
|---|---|---|---|
| depth | liquidity, activity | pooled liquidity USD | derived — one number drives 32% of weight |
| organic-interest | holders, safety.organic | Jupiter organic measurement | correlated — 15.6% from one provider |
| concentration | safety.concentration, `penalty:concentration` | top-holder % | derived — one fact charged twice |
| thin-liquidity | liquidity, `penalty:thin_liquidity` | pooled liquidity USD | derived — charged twice |
| authority | safety.mint, safety.freeze, `veto:AUTHORITY_*` | authority state | independent |

One correctness fix came out of this audit: **turnover now divides volume by the depth
of the venue that reported that volume**. Previously a token whose pair liquidity was
missing had DexScreener volume divided by Jupiter's wider aggregate, producing a ratio
describing no venue that exists.

The two double charges (concentration, thin liquidity) are **retained deliberately**
and documented rather than removed: the penalty models a cliff risk the graded score
cannot, and changing either without outcome data would be guessing.
