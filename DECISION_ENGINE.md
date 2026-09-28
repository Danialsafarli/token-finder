# Decision engine

Audience: engineers working on Token Finder's verdicts, and anyone reviewing
what a verdict claims. Status: **implemented** (Phase 3, `decision-policy@1`).
Nothing here is calibrated against outcomes; calibration is Phase 4. Every
threshold below is a stated starting point, not a measured optimum.

Phase 2 produced deep intelligence as diagnostics. This phase makes it decide
things - carefully. Two questions are kept apart until the last step:

1. **Safety / integrity** - can this token be trusted enough to remain a
   candidate?
2. **Quality / opportunity** - among the survivors, which look more interesting
   right now?

A dangerous token cannot become attractive because it is moving: opportunity
is computed separately and can never lift a verdict.

```
DISCOVERY        core/discover.ts        feeds + chain launches
    |
FAST SCREEN      core/analyze.ts         market, safety providers, evidence, Phase 1 gate
    |
DEEP ANALYSIS    intel/runner.ts         own loop, own budget - wallets, graph, wash, creator
    |  (stored)
DECISION         decision/*              at every scan, from stored rows only
    |
RANKING          core/ranking.ts         verdict tier, then rank score
```

The decision stage never calls a provider. It reads the latest stored
intelligence snapshot, the token's stored security events (and its creator's
and network's), and the token's recorded market history. That is what keeps
it cheap enough to run on every token of every scan without turning a scan
into a deep cycle (measured in §11).

It runs at two moments:

1. **At every scan**, for every token the scan evaluates.
2. **After every intelligence cycle**, for each token the cycle analysed
   (`decision/redecide.ts`), from its stored snapshot - the same market
   observation, never a new one - and the intelligence just written. Found
   in live verification: a creator drained 100% of a pool (verified
   on-chain), deep intelligence confirmed it, and the token stayed QUALIFIED,
   because a drained token falls below the discovery liquidity floor and is
   never scanned again. A re-decision that changes the verdict is a real
   transition: persisted (dated when decided, with no market row), announced,
   and pushed to every live surface over a `decision` stream event.

---

## 1. The intelligence contract

`decision/contract.ts` normalises Phase 2's stored rows into one typed bundle.
Every domain - activity, wash, coordination, attribution, creator, network,
security, holders - reports:

| Field | Meaning |
|---|---|
| `status` | AVAILABLE, PARTIAL, INSUFFICIENT_DATA, UNAVAILABLE, STALE, SUPERSEDED |
| `value` | the domain's reading, or null |
| `risk` | 0-1 where a risk is meaningful; null when not measured - never 0 for "unknown" |
| `confidence` | what the reading is worth |
| `coverage` | how much of what the domain could observe was observed |
| `freshness` | FRESH / AGING / STALE / UNKNOWN |
| `evidence`, `counterEvidence` | what supports it, what argues against it |
| `truncation` | what a budget cut |
| `ruleVersion` | the detection rule that produced it |

None of the non-AVAILABLE states is safe. UNKNOWN != SAFE, UNAVAILABLE != ZERO
RISK, INSUFFICIENT_DATA != CLEAN.

**Freshness.** Trading behaviour (activity, wash, coordination) is FRESH for an
hour and AGING to six; attribution, creator history and the network search age
over a day and a week. A STALE behavioural reading is not used at all. A
CONFIRMED security event is historical - it happened, with a transaction to
prove it - so it counts however old the analysis is, provided its rule is
current.

---

## 2. Rule versions and re-evaluation

A historical false positive produced under an older rule must not poison
future decisions forever. `decision/versions.ts` holds:

- `DECISION_POLICY_VERSION` - the ladder in §7 (`decision-policy@1`);
- `MODEL_VERSIONS` - hard-gate@2, integrity@1, opportunity@1, momentum@2,
  rank@1, and the Phase 1 score@1 kept beside them;
- `RULE_VERSIONS` - one per detection rule set (security-events@1, wash@2,
  activity-quality@2, cluster@1, attribution@1, creator-history@1,
  serial-network@1, buyer-class@1). `ACCEPTED_RULES` lists only the current
  one per domain.

Three distinct things, never merged:

| | Where | Used for decisions |
|---|---|---|
| **Historical observation** | `security_events` row, `security_event_revisions` | never deleted; always shown |
| **Current interpretation** | the row's `rule_version`, `superseded_at` | recomputed on every re-analysis |
| **Active decision evidence** | current rule **and** not superseded | the only thing the gate and integrity read |

**On write** (`IntelRepository.saveSecurityEvents`): under the same rule a
re-detection may only escalate (a later, more truncated read can miss a fact).
Under a newer rule the current reading wins even when weaker, and the earlier
reading is copied to `security_event_revisions` first (`REINTERPRETED`). Any
older-rule event on the mint that the current rule does **not** re-detect is
marked superseded and archived (`SUPERSEDED`). Before that sweep, the runner
re-reads each such event's own proof - its transaction, or its stored pool
reading - so the current rule judges the same facts the old one did.

**On read** (`contract.ts`): events split into active and superseded; creator
histories and serial-network findings are **re-counted from active events**,
so an address an old rule mistook for a rugger is not one today. A whole
intelligence snapshot without rule versions (written before Phase 3) is
SUPERSEDED as a unit until the token is re-analysed.

Pinned by tests: an unversioned CONFIRMED drain, a superseded-rule CONFIRMED
mint, and a later-superseded freeze all leave the verdict unrejected; the
same data re-detected under the current rule rejects.

---

## 3. Hard Gate v2

`decision/gate.ts`. The Phase 1 gate still runs and still decides every veto
it did. Every veto now carries a **family**, **confidence**, **freshness**,
**rule version**, **evidence** and **whether it can clear**.

| Family | Codes |
|---|---|
| CRITICAL_TOKEN_AUTHORITY_RISK | live mint or freeze authority, permanent delegate set, mint pausable |
| CRITICAL_TRANSFER_RESTRICTION | transfer hook, default-frozen accounts, non-transferable, fee >= 50% |
| CRITICAL_LIQUIDITY_RISK | no liquidity, liquidity below the floor |
| CRITICAL_HOLDER_CONCENTRATION | provider top holders >= 90% |
| DATA_INTEGRITY | critical provider field failed validation |
| CONFIRMED_CURRENT_RUG | RugCheck "rugged"; **or** a current-rule CONFIRMED liquidity drain on this token |
| CONFIRMED_MALICIOUS_TOKEN | a current-rule CONFIRMED supply expansion or freeze abuse on this token |
| STRONG_SERIAL_RUGGER | RugCheck creator history; **or** the rule below |
| EXTREME_MARKET_MANIPULATION | the rule below |

New intelligence hard fails, each with every condition required:

- **Confirmed rug / malicious token**: the event is CONFIRMED, on this mint,
  under the current rule and not superseded. Not re-checkable: it happened.
- **Serial rugger**: attribution ATTRIBUTED with confidence >= 0.6; strong
  links only (funding, transfers, shared direct funder, cluster) with path
  confidence >= 0.6; and **at least two distinct other launches** with a
  current-rule CONFIRMED event. One confirmed prior rug is serious soft risk,
  not a rejection.
- **Extreme manipulation**: wash risk HIGH on FRESH/AGING data, wash confidence
  >= 0.6, at least 3 of 4 families including round trips, round trips >= 40%
  of volume, >= 60 trades, and wash coverage >= 0.6 **after** market
  representativeness (§6). Re-checkable: the market can change.

Never a hard fail: bots, snipers, HFT, automation of any degree, one weak
relationship, one suspicious or one confirmed prior project, low-confidence
or ambiguous attribution, and missing or incomplete data. **REJECTED always
means at least one hard fail**, and momentum cannot override one.

---

## 4. Soft risk and integrity

`decision/integrity.ts`. Seven domains:

| Domain | Weight | Reads |
|---|---|---|
| Token security | 0.20 | authorities, penalty-only Token-2022 extensions, RugCheck score and non-authority findings, authority reassigned rather than revoked |
| Liquidity safety | 0.15 | depth (< $10K, < $25K), RugCheck LP findings, suspected drains, liquidity falling >= 40% over the observed window |
| Holder integrity | 0.15 | role-aware wallet concentration (or the provider's figure; **never the raw on-chain figure**), creator-linked selling |
| Activity integrity | 0.15 | automated share > 40%, sniper share > 25%, organic share < 10% |
| Wallet coordination | 0.15 | coordinated trading share, wash risk |
| Creator reputation | 0.10 | the creator's other launches, current-rule events only |
| Rug / malicious history | 0.10 | suspected supply expansion or freeze abuse on this token; serial network MODERATE or sub-threshold STRONG |

**Double counting.** Contributions carry a *family*. Within a family only the
largest counts. Across families in one domain the largest counts fully and
each other adds a quarter of itself. Shared funding, clustering and
coordinated trading are largely one observation seen three ways; wash's
relationship family reads the same clusters - so they are correlated families
in one domain, not three independent charges. Each event type is charged in
exactly one domain.

**Bands.** Risk < 0.15 CLEAR, < 0.3 LOW, < 0.5 ELEVATED, < 0.7 HIGH, else
SEVERE; UNKNOWN when nothing in the domain was measured. HIGH and SEVERE need
the evidence that fired to be both **confident (>= 0.5)** and **covered
(>= 0.4)**, using that evidence's own coverage - which, for activity, wash
and coordination, already includes how much of the market the sample
represents (§6). Otherwise the domain is capped at ELEVATED: a thin sample
can inform but not condemn. (Found live: wash HIGH at confidence 0.84 and 79%
snipers, each read from about 3% of the market.)

**Disputed concentration.** When the on-chain role-aware wallet figure and the
provider's top-holder figure differ by 3x and 30 points, the higher reading is
kept and stated as disputed, and it is actionable only if a second provider (a
RugCheck holder finding) corroborates it. (Found live: one system-owned wallet
holding ~80% of supply on-chain, which Jupiter's 10-13% did not count; RugCheck
did.) Automation alone is
capped at 0.45, so **bots alone reach ELEVATED, never HIGH**. Sniper
concentration can reach HIGH (0.7 of trades by snipers is 0.54).

**Global.** Integrity score = 100 x sum(w x coverage x (1 - risk)) / sum(w):
an unmeasured domain earns nothing, so poor coverage caps the number exactly
as it does the Phase 1 score. Risk is the coverage-weighted mean domain risk.
The band is the worst domain band, raised to HIGH when two domains are
ELEVATED on evidence that would have been actionable on its own terms, and
UNKNOWN below 25% coverage.

---

## 5. Opportunity

`decision/opportunity.ts`, separate from integrity.

| Component | Weight | Measures |
|---|---|---|
| Participation | 0.22 | independent participants (0.6) and holder breadth (0.4) |
| Capital quality | 0.18 | who the volume came from (0.6), turnover band (0.4) |
| Liquidity depth | 0.18 | pooled liquidity, log-scaled |
| Distribution | 0.12 | role-aware wallet concentration |
| Momentum | 0.20 | Momentum v2's state score |
| Maturity | 0.10 | age (0.7), how long Token Finder has observed it (0.3) |

**Independent participants**: likely-organic wallets count 1, automated 0.5,
snipers 0.25, unknown 0; wallets in coordinated clusters collapse to one per
cluster. Transaction count is never rewarded on its own - 100 wallets in one
cluster are one participant, and 20 independent buyers outrank them (tested).

Unknown parts earn zero and keep their weight. Band: STRONG >= 65, MODERATE
>= 45, WEAK below, UNKNOWN under 40% coverage.

---

## 6. Multi-pool activity coverage

A token trading on several pools was under-observed from one. Now:

- `core/analyze.ts` records every provider-reported pool (`snapshot.pools`),
  deduplicated, with venue, 24 h volume and trade counts.
- Deep intelligence reads the mint's own recent history - already fetched -
  and records each transaction against the one known pool it loads (a route
  through two is a trade on neither). No extra request.
- Deep collection (`ingest/budget.ts`) collects up to
  `INGEST_POOLS_PER_TOKEN` (default 2) pools per survivor: the display pair,
  then pools carrying >= `INGEST_MIN_POOL_VOLUME_SHARE` (20%) of 24 h volume.
  Cost is explicit: at most tokens x pools x tx-per-token fetches per cycle.
- Only compatible data is summed: volume-based readings use the quote currency
  most trades were priced in; trades in another are counted, not summed.
- `intel/coverage.ts` states how much of the market the sample represents:
  venue share (volume on observed pools), sample share (trades observed / the
  trades providers' counts imply for the observed span, over every pool) and
  span. **representativeness = min(1, sample / 0.5) x min(1, span / 30 min)**.
  Activity and wash coverage are multiplied by it, so a manipulation reading
  from a sliver of the market cannot drive a strong conclusion (tested: the
  same extreme wash reading rejects at representativeness 1 and does not at
  0.2).

---

## 7. The verdict ladder (`decision-policy@1`)

Evaluated in order; the first that applies decides.

| # | Verdict | Condition |
|---|---|---|
| 1 | **REJECTED** | at least one hard fail (§3) |
| 2 | **INSUFFICIENT_DATA** | market-evidence coverage < `MIN_COVERAGE_WATCH` (0.35) |
| 3 | **HIGH_RISK** | integrity band HIGH or SEVERE (§4) - no hard fail, but serious soft risk on confident evidence |
| 4 | **WATCH** | market-evidence coverage < `MIN_COVERAGE_QUALIFY` (0.6) |
| 5 | **HIGH_POTENTIAL** | all of: market coverage >= 0.7; deep-intelligence coverage >= 0.5; integrity coverage >= 0.6; integrity CLEAR or LOW; opportunity >= 65 with coverage >= 0.7; momentum SUSTAINED or ACCELERATING with confidence >= 0.5 |
| 6 | **QUALIFIED** | otherwise |

Deep intelligence can make a verdict **worse** on confident evidence and is
**required** for HIGH_POTENTIAL. Its absence never makes a verdict better: an
unanalysed token is at most QUALIFIED, and "nothing found in a thin sample" is
never counted as clean. Every unmet HIGH_POTENTIAL condition is reported as a
"not higher because" reason with its threshold.

Lifecycle: `DISCOVERED -> SCANNING -> {one of the six}`, every resting state
back to SCANNING. Nothing is irreversible.

---

## 8. Ranking

Within a verdict tier:

    rank = opportunity - 40 x integrity risk - 10 x (1 - integrity coverage)

The second term charges measured soft risk; the third charges what could not
be checked, so an unanalysed token never outranks an equally good verified
one. Rejected tokens are not ranked. Tiers: HIGH_POTENTIAL, QUALIFIED, WATCH,
INSUFFICIENT_DATA, HIGH_RISK, REJECTED. The Board's default segment is the
candidate ranking (first three); the others are their own segments.

The Phase 1 score (score@1) is still computed, stored and shown as the
"market score" - it is no longer the ranking key.

---

## 9. Momentum v2

`decision/momentum.ts`, from Token Finder's own stored observations (market
snapshots: a row per material change or 30-minute heartbeat, plus holder
counts), never interpolated.

- Fewer than 3 observations or under 20 minutes: **INSUFFICIENT_HISTORY**, no
  score.
- Windows 30 min / 2 h / 6 h are measured only when an observation lies at or
  within a quarter-window of the start.
- **UNSTABLE** when one step carries >= 70% of a >= 10% move, when price rises
  > 20% while liquidity falls >= 30%, or when steps whipsaw with >= 15% step
  volatility.
- Without the 2 h window only NEUTRAL or DECLINING are stated: a burst cannot
  be told from a trend.
- **ACCELERATING**: 2 h > +3%, 30 min positive at >= 1.2x the 2 h rate, >= 50%
  of steps up. **SUSTAINED**: 2 h > +3%, >= 55% of steps up, 6 h positive if
  measured. **COOLING**: earlier gains not continuing. **DECLINING**: 2 h <= -5%
  with most steps down. Otherwise **NEUTRAL**.
- Confidence = min(1, observations/8) x min(1, span/2 h).
- DexScreener's 5m-24h frames are shown beside it for comparison and never
  change the state.

---

## 10. Persistence (schema v4)

| Table / column | Holds |
|---|---|
| `security_events.rule_version`, `superseded_at`, `superseded_by` | the current interpretation of each finding |
| `security_event_revisions` | every earlier reading, REINTERPRETED or SUPERSEDED |
| `token_intelligence.rule_versions` | the rule set a snapshot was produced under |
| `token_snapshots.policy_version`, `rank_score`, `integrity_score`, `integrity_band`, `opportunity_score`, `momentum_state`, `decision_coverage` | each stored verdict's policy and model outputs |
| `verdict_transitions` | from, to, basis, reasons, component scores, hard fails, policy and models, per material verdict change - never pruned by age, cascades only with its token |

The full decision also travels in `tokens.payload`, so a restart restores it.
The Changes surface reads transitions with their reasons.

---

## 11. Performance

See §13 for live measurements. By construction:

- The decision stage makes **zero provider requests**: ~6 small indexed
  queries per token (latest intelligence row, events for the token, its
  creator's and up to 8 network targets' launches and events, 24 h of market
  and holder history).
- Deep analysis stays on its own loop with its own request and time budget;
  the decision reads its last result whenever it exists.
- Multi-pool reading from mint history costs nothing extra; multi-pool
  collection is capped by `INGEST_POOLS_PER_TOKEN`.
- `ScanResult.timings` records discovery, analysis, decision (with count),
  persistence, history rows, transitions and memory; the System page shows the
  last scan's.

---

## 12. Surfaces

- **Board**: five columns in the compact panel - token and why, rank (ring:
  combined coverage), state (integrity band and momentum), liquidity, age.
  Default segment: candidates. Search spans every verdict.
- **Dossier**: verdict and why (positives, risks, what blocks a higher
  verdict, coverage, policy); a strip with integrity, opportunity, momentum and
  rank side by side; **Activity Integrity** by wallets, trades and volume with
  unknown always drawn, wash risk, wallet independence and how much of the
  market was observed; **Rug Intelligence** for the token, its creator and its
  network with the relationship path, superseded findings kept apart as audit
  only, and explicit caveats when history coverage is incomplete; integrity
  by domain; raw and role-aware holder concentration; the Phase 1 score,
  collapsed.
- **Changes**: each transition's reasons and policy.
- **Observatory**: candidates by rank; only real verdict changes animate.
- **System**: decision policy and model versions, last scan timings.

---

## 13. Live verification (2026-09-28, mainnet, Helius, scratch database)

Engineering checks, not accuracy claims. About three hours of the real server
(scan every 120 s, collection every 60 s, deep intelligence every 180-240 s at
3 tokens and <= 150 requests per cycle) on a scratch database.

**Scale.** 59 scans, 448 tokens tracked, 102 deep-intelligence snapshots over
~98 tokens, 29 security events, 2,585 stored snapshots (all stamped
`decision-policy@1`), database 82.9 MB, integrity ok.

**Cost** (last scan, from `ScanResult.timings`): discovery 1.1 s, analysis
25.9 s, **decision 57.8 ms for 60 tokens (~1 ms each, zero provider
requests)**, persistence 119 ms, 46 history rows and 6 transitions, RSS 286 MB
(+18 MB during the scan). Scan wall time over 56 scans: min 14.2 s, median
31.8 s, max 122.9 s - provider-bound, as before. Deep-intelligence cycles:
22-75 s and 75-81 requests for 3 tokens, zero failures; collection cycles
18 s, 81 RPC calls, zero rate limiting.

**Verdicts on the live Board** at one point: 263 Qualified, 20 High risk, 26
Rejected, 0 Watch, 0 Insufficient data; High potential reached and lost by one
token (COLLECT: accelerating momentum, then an elevated wash reading
arrived). Momentum: 328 of 400 decided tokens had too little observed history;
the rest split 35 flat, 28 declining, 28 unstable, 4 accelerating, 3
sustained, 2 cooling. Spot checks read correctly - one step carrying 89% of a
-67% move was UNSTABLE; +100% over 2 h with an accelerating half-hour was
ACCELERATING.

**Rejections.** All 26 came from Phase 1 vetoes (18 catastrophic
concentration, 7 RugCheck critical, 1 liquidity floor); none looked false on
inspection. No intelligence hard fail reached the Board before the first fix
below.

**Findings, each fixed with a regression test written first:**

1. *A confirmed rug stayed Qualified.* Two tokens carried current-rule
   CONFIRMED liquidity drains; one was verified on-chain (a single `Withdraw`
   took the pool vault from 892.6T base units to 6,867, to the fee payer).
   Both stayed Qualified because a drained token is never scanned again.
   Fixed by re-deciding after each intelligence cycle (see the introduction).
   Re-run on a copy of the live database, both became REJECTED
   (CONFIRMED_CURRENT_RUG), and four tokens whose creator-linked wallets sold
   83-84% of supply within an hour became HIGH_RISK.
2. *Disputed concentration was actionable alone.* One system-owned wallet
   (117 and 297 SOL; verified to be a plain wallet) held ~80% of supply
   on-chain while Jupiter reported 10-13%. Now stated as disputed and
   actionable only with RugCheck's corroboration - which, for every such
   token seen, it had.
3. *Confident readings of a market sliver.* Wash HIGH at confidence 0.84 and
   79% snipers came from ~3% of the market. Now capped at ELEVATED (§4). One
   token that had been High risk on 71% coordinated trading from a small
   slice returned to Qualified.

**Coverage, honestly.** Wallet shares were stated for 27 of 98 analysed
tokens; only 14 samples represented at least half the market in their
window. Most activity and wash readings are therefore partial, and the engine
treats them so. Two of the most recent 15 snapshots found a second pool.

**Not yet addressed.** Verdicts near a hard threshold can flip between scans
(one token alternated Rejected / High risk / Qualified with its provider
concentration around 90%). There is no hysteresis; choosing one is a
calibration decision for Phase 4.

---

## 14. Known limitations

- **Nothing is calibrated.** Every threshold, weight and band is a starting
  point; Phase 4 backtests them against outcomes.
- **Deep intelligence reaches few tokens.** At 2-3 tokens per cycle most live
  tokens are unanalysed at any moment; they can be at most QUALIFIED, and
  their integrity is UNKNOWN (and charged as unverified in rank).
- **Momentum needs time.** A token seen for under 20 minutes has no momentum
  state; one seen for under ~1.5 hours cannot be SUSTAINED or ACCELERATING,
  so a genuinely new token cannot be HIGH_POTENTIAL on its first scans. That
  is deliberate.
- **Re-verification is bounded.** Up to five obsolete-rule findings per
  analysis are re-read. A finding whose proof is no longer stored and that the
  current rule cannot re-read is superseded rather than kept as evidence -
  the conservative choice for a current verdict, recorded in revisions.
- **Market coverage relies on provider trade counts.** Where DexScreener
  reports none, venue share stands in at half weight.
- **A pool loaded alongside another in one transaction** (a route) is read as
  neither.
- **No hysteresis.** A token whose evidence sits at a threshold can change
  verdict on consecutive scans; every change is recorded as a transition.
- **Re-decision covers analysed tokens only.** A token that stops being
  scanned and is not re-analysed keeps its last verdict until it leaves the
  live window, as before.
- **Wallet classifications are samples.** At most 12 wallets per token are
  profiled; composition shares are of the trades collected.
