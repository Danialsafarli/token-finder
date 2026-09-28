# Calibration

Audience: anyone asking whether Token Finder's thresholds behave sensibly, and
anyone changing one. Status: **implemented** (Phase 4). The replay inspects;
it does not tune. Every change below cites the evidence that justified it.

Run it on a **copy** of a database (it opens the file read-only):

```bash
node src/cli.ts calibrate --db path/to/copy.sqlite --json report.json
```

Code: `src/calibration/outcomes.ts` (labels), `src/calibration/replay.ts` (the
report), `src/persist/calibration-reader.ts` (the queries).

---

## 1. What counts as an outcome

Calibration asks whether a verdict was sensible, not whether it made money.
**Price is never an outcome.** A price that fell is not a scam, and a price
that rose is not a good token.

| Class | Label | From |
|---|---|---|
| MEASURED | `CONFIRMED_DRAIN`, `CONFIRMED_ABUSE` | a current-rule CONFIRMED security event on the token, dated after the verdict |
| MEASURED | `LIQUIDITY_COLLAPSE` | pooled liquidity fell to <= 20% of the verdict's level, on the **same pool** |
| MEASURED | `SUSTAINED_LIQUIDITY` / `LIQUIDITY_DECLINED` | observed through the horizon; lowest liquidity >= 50% of the verdict's, or not |
| PROXY | `SURVIVED_PART_OF_WINDOW` | observed for at least half the horizon without a collapse, then no longer observed |
| UNKNOWN | `NOT_OBSERVED` | too little observed after the verdict to say anything |

Liquidity is compared within one pool only. A pump.fun bonding curve
migrating to PumpSwap, or a new best pair, is not a collapse (see §3.1).

**The bias, stated once and meant everywhere:** a token that dies usually
leaves the discovery feeds, so it stops being observed and lands in UNKNOWN.
MEASURED outcomes over-represent survivors. No figure below is an accuracy
claim.

## 2. The replay (2026-09-28, the development database)

51,694 stored verdicts over 7,386 tokens, 2026-09-23 01:40 to 2026-09-28
21:11 UTC; 5,538 decision points (each token's first verdict and every
change). 48,085 rows came from the Phase 1 gate and score, 3,609 from
`decision-policy@1`; they are reported apart.

### 2.1 Outcomes at 24 hours

| Class | Count |
|---|---|
| MEASURED | 83 |
| PROXY | 37 |
| UNKNOWN | 5,418 |

98% of decision points have no measured outcome. That is the headline
finding: **outcome coverage, not threshold choice, is the binding limit on
calibration.** Among the measured ones:

| Verdict at the time | Sustained | Declined | Collapsed | Confirmed drain |
|---|---|---|---|---|
| QUALIFIED (Phase 1) | 36 | 13 | 19 | - |
| QUALIFIED (policy@1) | - | - | 1 | 1 |
| HIGH_RISK (policy@1) | - | - | 2 | - |
| REJECTED (Phase 1) | 4 | 2 | 5 | - |

### 2.2 Hard rejects

By veto, 24 h outcome: catastrophic concentration 352 unknown, 1 collapsed;
RugCheck critical 336 unknown, 4 proxy, 3 sustained, 2 declined; liquidity
below the floor 124 unknown, 4 collapsed, 3 proxy; live mint/freeze authority
1 sustained each.

Four rejects were followed by sustained liquidity: three RugCheck-critical
readings (two tokens) and one live-authority token. **None is a false reject
on that evidence**: sustained liquidity does not clear a live mint authority
or whatever RugCheck found critical. No hard-gate threshold was changed.

### 2.3 Escapes: not rejected, then collapsed

21 decision points were QUALIFIED and then collapsed or were confirmed
drained within 24 h. Most were rejected on the very scan that observed the
collapse, because the pool fell below the liquidity floor. **Some same-pool
collapses stayed QUALIFIED while observed**, because liquidity was still above
the floor (for example $170K -> $14K on one PumpSwap pool within 45 minutes).
See §3.2.

### 2.4 Verdict stability

209 verdict changes; 7 immediate reversals (A -> B -> A). Replayed under
`stability@1`: 123 changes, 1 reversal. See §3.3.

### 2.5 The current decisions (751, `decision-policy@1`)

| Check | Result |
|---|---|
| Verdicts | 625 Qualified, 79 Rejected, 47 High risk, 0 High potential |
| High potential under-covered | 0 (invariant holds) |
| Rejected without a hard fail | 0 (invariant holds) |
| Qualified without deep intelligence | 560 - at most Qualified by design, charged as unverified in rank |
| Bot-heavy | 0 tokens with an automation charge; none High risk on automation alone |
| Disputed concentration | 27; 23 corroborated by RugCheck (20 High risk, 5 Qualified, 2 Rejected) |
| Manipulation | wash HIGH readings on 10 tokens; 0 extreme-manipulation hard fails (samples too thin to condemn) |
| Creator / rug history | 33 serial-rugger hard fails, **all from RugCheck's creator history**; 0 from Token Finder's own network rule; 1 confirmed current rug |
| Momentum | 83% INSUFFICIENT_HISTORY |
| Opportunity | all tokens p50 16.8, p90 33.8, max 61; analysed tokens (69) p50 31.5, p90 49.3, max 61 |

## 3. What changed, and why

### 3.1 Liquidity is compared within one pool (defect; `momentum@3`)

A $2.5M pump.fun bonding curve followed by a $10K PumpSwap pool read as a
99.6% collapse. Of 123 pool switches in the history, 3 would have read as a
>= 80% collapse. Momentum's liquidity readings now use only observations on the
current pool (`decision/inputs.ts`); any other point keeps its price and loses
its liquidity.

A first version kept points with **no recorded pool** as comparable. Found in
the live review of this very change: a token whose display pool alternated
between a ~$600K PumpSwap pool and a ~$6K Meteora pool had $1.1M readings of
unknown pool set against the $6K pool, and was marked High risk for a "99%
collapse" that never happened. Unattributed readings are now excluded too.
With both fixes the collapse rule fires on 3 of 751 current tokens, all of
them genuinely drained. Regression tests: `test/calibration.test.ts`.

### 3.2 A same-pool liquidity collapse is actionable soft risk (`integrity@2`)

Of 13 same-pool falls of >= 80% from the window's peak (peak >= $5K), **none
recovered to half within 6 h**; 6 stayed low and 7 were never observed again.
Before, such a token earned only the 40% "liquidity leaving" risk (0.3) and
stayed Qualified. Now a same-pool drawdown of >= 80% from the observed peak is
a 0.55 risk at confidence 0.8: HIGH_RISK, **never a hard fail** - a collapse is
a rug's signature, not proof of one. The 40% rule is unchanged.

### 3.3 Better verdicts need confirmation (`stability@1`, `decision-policy@2`)

A worse verdict applies on the reading that says so - every hard fail
included, CONFIRMED_CURRENT_RUG first among them. A better verdict needs two
consecutive independent readings and takes the most conservative of them. See
DECISION_ENGINE.md §7a. The replay above is the evidence: reversals 7 -> 1,
changes 209 -> 123, and no danger delayed by construction.

### 3.4 Not changed

- **Hard-gate thresholds** (concentration 90%, liquidity floor, RugCheck
  critical, authorities): no measured false reject (§2.2).
- **HIGH_POTENTIAL** (opportunity >= 65, momentum sustained or accelerating,
  deep-intelligence coverage >= 0.5): it is currently **unreachable** - no token
  exceeded 61 - mostly because momentum history and deep intelligence are
  missing, not because the bar is mis-set. With no outcome for any High
  potential token there is no evidence for lowering it, and lowering it to
  make the tier appear would be tuning to a wish.
- **Disputed concentration, wash, bots**: behaving as designed (§2.5).

## 4. Still uncalibrated

- Integrity weights and band edges; opportunity weights; the rank formula.
- The High potential bar (no outcomes).
- Wash and coordination thresholds (samples rarely represent half the market).
- Outcome coverage: until tokens are followed after they leave the feeds
  (for example by reading their pools directly), most outcomes stay UNKNOWN.
