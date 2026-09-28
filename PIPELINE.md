# Pipeline, evidence and the safety gate

Audience: engineers working on Token Finder's analysis path.
Status: **implemented**. This document describes `src/core/` as it runs today:
the fast screen. Since Phase 3 its output is the input of the decision engine,
which decides the final verdict ([DECISION_ENGINE.md](DECISION_ENGINE.md)); the
Phase 1 gate's vetoes still reject, and the Phase 1 score is kept as the
"market score", no longer the ranking key.

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

Freshness is evaluated **per claim, before a winner is chosen**. A stale claim is
set aside for the decision and kept in `evidence.overridden`; only if *every*
claim is stale does the fact become STALE. Without this, one stale provider could
win the resolution and then drag a fact to STALE, discarding a perfectly current
reading from someone else.

## 3. Cross-provider resolution

`src/core/resolve.ts`. Rules, in order:

1. **Every answer rejected** -> `INVALID`. Never UNKNOWN: we did get an answer.
2. **Nobody answered** -> `UNKNOWN`.
3. **One valid claim** -> `MEASURED` at that provider's trust.
4. **Claims agree** -> `MEASURED`. Corroboration cannot make us less sure.
5. **Claims contradict** -> `CONFLICTED`, resolved conservatively, all claims retained.

Provider trust: `helius 1.0` (reads the chain directly), `rugcheck 0.95`,
`dexscreener 0.9`, `jupiter 0.85`.

### Precedence is per fact type, not global

There is no single "best provider". Each is authoritative for what it actually
observes, and silent on the rest:

| Fact | Precedence | Why |
|---|---|---|
| mint / freeze authority | **Helius (on-chain)** > RugCheck danger > Jupiter audit | Helius reads the mint account directly; the others report *about* it |
| tradability | derived from resolved depth | a venue with depth is one you can exit through |
| liquidity, volume, price | market providers, conservative | both observe venues; neither is canonical |
| rug history, named risks | **RugCheck** | the only source that asserts them, and history does not expire |
| holders, organic score | Jupiter | the only source that reports them |

A provider with precedence wins outright **when its claim is current**. When it is
stale it stops deciding, and the remaining current claims take over.

### Safety facts are resolved conservatively, bounded by freshness

For mint and freeze authority, in order:

1. **Stale claims do not decide.** An authority report from last week is not a
   statement about now. It is set aside and kept in `evidence.overridden`.
2. **A current on-chain read wins.** Helius reads the mint account directly, so
   where it has a current claim it outranks a third-party report of that same
   fact — including a RugCheck danger finding that has gone stale. This is what
   stops a week-old "mint authority still enabled" vetoing a token the chain now
   says is safe.
3. **Otherwise, a danger assertion beats silence.** RugCheck only ever reports
   problems, so the absence of a finding says nothing at all. With no on-chain
   claim — the default keyless setup — this is the governing rule, unchanged.
4. **Otherwise, a danger assertion beats a contradicting claim of safety**, as
   `CONFLICTED` with the dangerous reading as the value.
5. **CONFLICTED still fires the gate and still earns no positive credit.** A
   disputed claim of safety is not a claim of safety.

Nothing is silently discarded. A danger assertion that loses — on staleness or on
precedence — lands in `evidence.overridden` and sets `historicalDangerEvidence`, so
the token keeps a visible record that something once reported otherwise even though
it is no longer vetoed for it.

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

| Code | Nature | Fires when | Source | Re-checkable |
|---|---|---|---|---|
| `AUTHORITY_MINT_ACTIVE` | current-state | mint authority resolves to live, on **current** evidence | jupiter / rugcheck / helius | yes |
| `AUTHORITY_FREEZE_ACTIVE` | current-state | freeze authority resolves to live, on **current** evidence | jupiter / rugcheck / helius | yes |
| `CRITICAL_RUGCHECK` | **historical** | a `danger` finding naming a rugged token or a creator with rug history | rugcheck | **no** — history cannot be undone |
| `UNTRADEABLE` | current-state | liquidity measured at exactly 0 | derived | yes |
| `LIQUIDITY_TOO_LOW` | current-state | measured liquidity below `MIN_LIQUIDITY_USD` | dexscreener / jupiter | yes |
| `CATASTROPHIC_CONCENTRATION` | current-state | Jupiter-measured top holders >= `CATASTROPHIC_CONCENTRATION_PCT` (90) | jupiter only | yes |
| `MALFORMED_TOKEN` | current-state | a *critical* field failed validation | validation | yes |
| `PERMANENT_DELEGATE_ACTIVE` | current-state | Token-2022 permanent delegate is **set** (not renounced) | helius | yes — it can be renounced |
| `TRANSFER_HOOK_ACTIVE` | current-state | Token-2022 transfer hook has a program id set | helius | yes |
| `MINT_PAUSABLE` | current-state | mint is paused, or a pause authority exists | helius | yes |
| `DEFAULT_ACCOUNT_STATE_FROZEN` | current-state | new token accounts are created frozen | helius | yes |
| `NON_TRANSFERABLE` | current-state | the mint forbids transfers outright | helius | **no** — no authority can turn it off |
| `EXTREME_TRANSFER_FEE` | current-state | transfer fee >= `TRANSFER_FEE_VETO_BPS` (5000 = 50%) | helius | yes |

**Nature decides how staleness is treated.** A `current-state` veto requires FRESH or
AGING evidence: an old reading of a changeable fact — an authority that may since have
been revoked, liquidity that may since have been added — is not a fact about the
present. A `historical` veto is exempt by construction: a creator's rug history is as
true today as when it was recorded, so it fires on stale evidence and is not
re-checkable.

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

### Token-2022 extensions

Before this existed, Token Finder read every mint as legacy SPL: it asked for
`mintAuthority` and `freezeAuthority`, found both revoked, and called the token safe.
A Token-2022 mint can revoke both and still let a third party take tokens out of any
wallet holding it. Those powers live in *extensions*, and nothing looked at them.

`src/core/token-program.ts` holds the registry. Each extension is classified by what it
can do to a holder **right now**, not by how alarming its name is:

| Policy | Meaning |
|---|---|
| `HARD_VETO` | a third party can currently take, trap or block the position |
| `CONDITIONAL_VETO` | dangerous past a named threshold, tolerable below it |
| `PENALTY_ONLY` | reduces what a holder can realise without preventing exit |
| `INFORMATIONAL` | worth recording, no effect on safety |
| `NO_CURRENT_RISK_EFFECT` | present but disarmed, so it asserts nothing about danger |
| `UNKNOWN_POLICY` | not recognised — never vetoes, and marks coverage incomplete |

**The permanent delegate is the case the whole design turns on.** The *extension* is
permanent: it must be initialised before `InitializeMint` and can never be removed. The
*delegate* is not — it can be reassigned, or set to `None`, after which nobody can sign
as it. Verified against the SPL Extension Guide, Light Protocol's
`RESTRICTED_T22_EXTENSIONS.md` ("Can be set to `None` to permanently renounce"), Anza's
Pinocchio layout (`delegate: MaybeNull<Address>`) and Anchor's `OptionalNonZeroPubkey`
constraint. So:

- extension present, delegate **set** -> current-state veto, **re-checkable**
- extension present, delegate **renounced** -> no veto at all
- extension present, delegate **unreadable** -> UNKNOWN: no veto, and no reassurance

Reading "permanent" as "can never clear" would have produced a non-re-checkable
historical veto that is simply wrong, and would have rejected issuers who had already
given the power up. The same verification also *removed* a veto that looked obvious:
`PermissionedBurn` restricts burning to a co-signing authority rather than granting
seizure, and it does not touch transfers, so it is `INFORMATIONAL`.

**Extension evidence is only MEASURED when the read is complete.** Three cases must
never collapse together, and the model keeps them apart:

| Case | `tokenProgram` | `mintExtensions` |
|---|---|---|
| legacy mint — extensions do not apply | `LEGACY_SPL_TOKEN` | MEASURED, `[]` |
| Token-2022, every extension decoded | `TOKEN_2022` | MEASURED |
| Token-2022, one extension undecodable | `TOKEN_2022` | **UNKNOWN** |
| Helius not configured or unreachable | UNAVAILABLE | UNAVAILABLE |

Completeness is **measured, not assumed**. A bare SPL mint is 82 bytes; any extension
makes the account larger. So `space == 82` proves no extension exists, and `space > 82`
with an empty extension list proves the node did not decode them — which matters,
because an Agave node before 4.2 returned `"extensions": []` when it met a single
extension type it did not recognise, hiding every extension on the mint.

An extension name this build does not know never vetoes (the gate never fires on
UNKNOWN) but is recorded and marks the read incomplete. Silently skipping it would let
a future extension with real powers pass as a clean mint.

`observedExtensions` is kept alongside the Evidence for the same reason
`rugcheckFindings` is: an extension positively observed still vetoes even when the
surrounding picture is partial. Not knowing whether there are *others* is no reason to
ignore the permanent delegate in hand.

**Token program is read only from the mint account's `owner`.** It is never inferred
from whether extensions were found — a Token-2022 mint with no extensions is
indistinguishable from a legacy one by that test.

### Holder concentration is exact integer arithmetic

Concentration is a ratio of raw base units on both sides. `uiAmount` is not read at all.
Three separate reasons, only one of which is precision:

- **`uiAmount` is nullable, and null entries used to be dropped from the holder list.**
  A dropped holder understates concentration — failing toward *safety*, the one
  direction a safety metric must never fail in. Now an unreadable balance withdraws the
  whole set and concentration becomes non-measured.
- **`uiAmount == amount / 10^decimals` does not hold** under `ScaledUiAmount` or
  `InterestBearing`, which rebase the displayed figure while leaving raw balances
  untouched. Reading raw amounts makes those extensions irrelevant to concentration,
  which is correct.
- **A `u64` exceeds exact `number` range.** BONK's on-chain supply is
  `8799438501691764747`; through `Number()` it becomes `8799438501691764736`. Real
  token, real loss.

`decimals` is a `u8` (0–255), not the EVM 0–18 range. Bounding it at 18 rejected legal
mints, after which supply stayed in raw base units while holder balances were read in
UI units — and the resulting ratio came out near zero, so **a token that could not be
measured read as perfectly distributed**. `decimals` now plays no part in the ratio at
all, so no code path can mix units.

Division truncates downward, so a computed share above 1 is a genuine contradiction
between the supply reading and the balances, not a rounding artefact. It is rejected
rather than capped.

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

### `mintExtensions` is coverage-weighted, and that lowered every coverage figure

Adding Token-2022 extensions as a coverage signal (weight `0.052`, the same as freeze
authority, because it answers a question of the same severity) changed numbers that
already existed. That is deliberate: leaving it out would mean "we could not tell whether
this mint has a permanent delegate" cost nothing, and missing safety evidence has to
reduce coverage or the number means less than it claims.

The cost, measured across the fixture corpus rather than estimated:

| | value |
|---|---|
| coverage-weight total | 1.000 -> 1.052 |
| max attainable coverage with **no Helius key** | **0.9506** |
| largest per-token coverage delta observed | **-0.0495** |
| fixtures whose eligibility changed | **0 of 14** |
| previously-qualifying band now dropping to WATCH | coverage in [0.600, 0.6312) |

`tokenProgram` is deliberately **not** weighted. It is the key needed to interpret the
extension list, not an independent observation, and counting both would charge twice for
one call to one provider — the same reasoning that keeps `venueLiquidityUsd` out.

## 6. Ranking eligibility and the lifecycle

> **Since Phase 3 this is the fast screen, not the final verdict.** The ladder
> below still runs first and its vetoes still reject; the decision engine then
> adds deep intelligence, soft risk, opportunity and momentum, and sets one of
> six verdicts (HIGH_POTENTIAL, QUALIFIED, WATCH, INSUFFICIENT_DATA,
> HIGH_RISK, REJECTED). The exact ladder is in
> [DECISION_ENGINE.md](DECISION_ENGINE.md) §7; the screen's own result is kept
> on each decision for audit.

A numeric score is not a licence to appear in the ranking.

| Eligibility | Condition |
|---|---|
| `REJECTED` | any veto — checked first, so a strong score cannot buy past the gate |
| `INSUFFICIENT_DATA` | coverage < `MIN_COVERAGE_WATCH` (0.35) |
| `WATCH` | coverage < `MIN_COVERAGE_QUALIFY` (0.6) |
| `QUALIFIED` | clean gate, coverage at or above the qualify bar |

Eligibility outranks every sort key: the Board groups rows by verdict in the order
`QUALIFIED`, `WATCH`, `INSUFFICIENT_DATA`, `REJECTED` (`VERDICT_TIER` in
`src/core/ranking.ts`) and sorts only within a group. A rejected token therefore cannot
appear above a qualified one, whatever the sort.

### The live universe

A verdict is a statement about the present, so a verdict computed hours ago cannot sit on
the live ranking as though it were current. One predicate, `placementOf(token, now,
windowMs)` in `src/core/ranking.ts`, decides which tokens are live. Every surface uses it:
the Board rows, the Board's counts and segment totals, `/api/coverage`, `/api/tokens`, the
System page and `node src/cli.ts rank`. None of them keeps its own version of the rule.

| Placement | Condition | Where it appears |
|---|---|---|
| `LIVE` | evaluated, and last evaluated within `LIVE_WINDOW_MIN` (90 min) | the Board, ranked |
| `STALE` | evaluated, but longer ago than the window | search results, labelled as history; its Dossier says it is not on the live Board |
| `UNEVALUATED` | never evaluated under the current rules (for example, imported v1 snapshots) | the same; counted, never ranked |

Live tokens are further marked `FRESH` (evaluated within 30 minutes) or `AGING`.

The default window equals `FRESHNESS.liquidityUsd.agingMs`. The reasoning: past the point where the engine would no
longer trust the token's liquidity evidence, its verdict should not be on the live Board
either. Leaving the live universe deletes nothing. History, snapshots and verdict changes
stay, and the token's Dossier stays reachable.

**Retention is decoupled from ranking.** `store.prune()` takes no argument and applies
the store's own `RETENTION` policy. Before this, the monitor passed a value derived
from the ranking's `maxAgeHours` into `prune`, where it could lengthen token retention.
At the defaults it changed nothing, but a display setting should not be able to touch
a deletion policy at all, and it no longer can.

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

## 8. Failure isolation

**No single item or provider can abort a batch.** Three fan-out paths were fragile:

| Path | Was | Now |
|---|---|---|
| `pool()` in `util/http.ts` | `Promise.all(runners)` — rejected on the first failure *and* left the other runners consuming the cursor in the background | `poolSettled()` catches inside each runner; it cannot reject, and every item gets a recorded outcome |
| batch market fetch in `analyze.ts` | `Promise.all([dexscreener, jupiter])` — one timeout discarded a complete response from the other and ended the scan | `Promise.allSettled`; whichever side answered is kept, the other is recorded as a failure |
| per-token enrichment in `analyze.ts` | `Promise.all([rugcheck, helius, typesafe])` | `Promise.allSettled`; a failing provider becomes an UNAVAILABLE signal, not an exception |

### Failures carry their reason

Adapters report *why* they failed rather than collapsing to `null`. `getOutcome()`
returns `{ data, failure }`; `tryGetJson()` remains for cosmetic fetches but is no
longer used for anything feeding the evidence model, because it makes a provider
outage indistinguishable from a token having no data.

| Kind | Meaning | Retryable |
|---|---|---|
| `TIMEOUT` | the request exceeded its deadline | yes |
| `RATE_LIMITED` | 429 | yes |
| `NETWORK_ERROR` | never reached the provider | yes |
| `PROVIDER_UNAVAILABLE` | 5xx, or no key configured | yes (5xx) / no (no key) |
| `INVALID_RESPONSE` | answered, but unusable — 4xx, bad JSON, JSON-RPC error | **no** — the same request fails the same way |
| `UNKNOWN` | unclassified | **no** — retrying what we do not understand is how a scan becomes a rate-limit spiral |

A failed provider's signals become **UNAVAILABLE**, which is counted separately from
UNKNOWN in the coverage report. Failures are **not cached**, so a transient outage does
not lock a token out of safety data for the length of the cache TTL.

`ScanResult` carries `tokenFailures` and `providerFailures`; each token's `evaluation`
carries `providerFailures` for the tokens it affected.

## 9. Freshness applies to penalties, not just vetoes

A veto and a penalty make the same kind of claim about the world, so they answer
to the same rule. They did not always: hardening the gate against stale evidence
left the penalty path untouched, so a month-old RugCheck finding stopped vetoing
a token but kept taking 15% off its score — including when fresher evidence had
already shown the condition was gone.

### One rule, shared by every layer

`isEvidenceScorable()` in `src/core/evidence.ts` is the single definition of
"may this move a score". Scoring, penalties, risk flags, the safety gate and
ranking eligibility all call it. `gate.ts` no longer keeps a private copy — the
drift between a gate that checked freshness and a penalty loop that did not is
exactly what this centralisation prevents.

| Evidence state | Scorable | Reason reported |
|---|---|---|
| MEASURED / CONFLICTED, FRESH or AGING | **yes** | `scorable` |
| MEASURED, STALE | no | `stale` |
| UNKNOWN | no | `unknown` |
| INVALID | no | `invalid` — diagnostic preserved |
| UNAVAILABLE | no | `unavailable` |

AGING counts as current, at reduced confidence. Refusing it would make safety
data useless in the common case where it is cached.

### RugCheck findings are classified by nature

A named condition is not a value, so it does not fit `Evidence<T>` — but it
reaches the score through flags and the multiplier, so it needs the same
discipline. `src/core/rugcheck-signals.ts` classifies each finding:

| Nature | Meaning | Decays when stale | Can score |
|---|---|---|---|
| `CURRENT_STATE` | describes the token now; can stop being true | **yes** | yes |
| `HISTORICAL` | an event that happened; cannot un-happen | no | yes |
| `PERMANENT` | fixed at mint initialisation; cannot be removed | no | yes |
| `UNKNOWN_NATURE` | not confidently classifiable | n/a | **no** |

Current classifications, each with its rationale in code:

- **CURRENT_STATE** — mint authority, freeze authority, LP unlocked, LP provider
  count, low liquidity, mutable metadata, single-holder ownership, holder
  concentration, transfer fee. All revocable or continuously changing.
- **HISTORICAL** — creator history of rugged tokens, token already rugged.
- **PERMANENT** — permanent control enabled (Token-2022 permanent delegate,
  fixed at mint initialisation).
- **UNKNOWN_NATURE** — anything unrecognised. Recorded as evidence, never scored.

Unrecognised findings default to `UNKNOWN_NATURE` rather than being assumed
current-state. That costs a penalty on findings the system does not recognise,
which is the intended trade: a score should not move for a reason nobody can
articulate.

### When a penalty is withheld

1. **Nature unclassifiable** — evidence only.
2. **Current-state finding gone stale** — it no longer describes the present.
3. **Contradicted by canonical evidence** — if the chain currently shows the
   authority revoked, a RugCheck finding that it is live does not charge, even
   when the finding itself is fresh. Canonical current state governs
   current-state scoring.

### Suppression is never deletion

A withheld penalty leaves the finding fully visible. The flag is still raised,
its message carries `[not scored: <reason>]`, and its severity drops to `low` so
it cannot fire a high-severity alert on evidence that is not scoring. The token
additionally carries `historicalDangerEvidence` when a danger assertion lost to
staleness or precedence.

So a token can correctly report: *RugCheck previously reported mint authority
active · freshness STALE · current canonical state revoked · provider conflict
yes · score impact none.*

And the mirror holds: a **stale clean bill of health earns no safety credit**
either. RugCheck's numeric risk score goes STALE on the same window, so it stops
contributing to the safety component. Suppression cuts both ways.
