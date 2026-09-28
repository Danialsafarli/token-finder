# Deep intelligence

Audience: engineers building the later phases (Activity Integrity, Rug
Intelligence, calibration) on top of what this phase produces, and anyone
reviewing what it claims.

This phase works out **who is behind a token's activity**: what kind of
wallets bought it, how they were funded, which of them are related, whether
the trading looks manufactured, who launched the token, and what that creator
did before. Written in Phase 2 as a diagnostics layer; **since Phase 3 the
decision engine reads it** - through the normalised, rule-versioned contract
described in [DECISION_ENGINE.md](DECISION_ENGINE.md), which decides what here
may reject, what is soft risk, and what is only shown. No threshold here is
calibrated against outcomes; calibration is Phase 4. Every figure below is an
engineering measurement, not an accuracy claim.

Sources, by the tiers in [CLAUDE.md](CLAUDE.md): RPC semantics from the
official Solana documentation (Tier 1); `getTransactionsForAddress` from
Helius's documentation (Tier 2); everything else from live mainnet
observation on 2026-09-27, stated as such. The jsonParsed `freezeAccount`
fields (`account`, `freezeAuthority`, `mint`) were first written from recall
and are now **confirmed against a live transaction**.

---

## 1. Rules that hold everywhere

- **UNKNOWN is never zero.** A feature that could not be measured has
  `quality: INSUFFICIENT` and `value: null`. A classification with too little
  history is `INSUFFICIENT_DATA`, not "organic".
- **Confidence, coverage and the finding stay three separate numbers.** None
  is multiplied into another.
- **Multi-signal only.** No class, cluster, wash risk or event rests on one
  observation.
- **Bot is not scam.** Automated and high-frequency traders are behaviours,
  not accusations. A scheduled buyer is `AUTOMATED_TRADER` and nothing more.
- **Infrastructure is never ownership.** Exchanges, bridges, relayers and
  program accounts never make two wallets related.
- **Weak evidence is reported, never merged.** Weak pairs stay pairs.
- **Price is never an event.** A collapse or an abandoned token is not a rug.
- **Every conclusion explains itself**: signals, counter-signals, reasons,
  evidence signatures and, for networks, the path.

---

## 2. The staged, bounded cycle

`src/intel/runner.ts`, started beside the monitor (`INTEL_ENABLED`) or run
by hand (`intel-run`, `intel <mint> --run`).

| Stage | What it does | Requests |
|---|---|---|
| **Fast screen** | Survivors only (QUALIFIED, then WATCH), evaluated within the live window, not analysed in the last `INTEL_TOKEN_REFRESH_MIN`; oldest-analysed first, then liquidity | 0 |
| **Transaction collection** | The creation transaction (attribution); the mint's oldest 5 and newest 100 transactions (security facts). Those that load the token's pool are recorded as pool activity through the same path collection uses | 2-3 |
| **Deep wallet analysis** | Up to `INTEL_WALLETS_PER_TOKEN`: the creator, the earliest buyers, the largest buyers. Per wallet: newest `INTEL_TX_PER_WALLET` transactions, and oldest `INTEL_ASC_LIMIT` when the newest page is not the whole history. A profile younger than `INTEL_PROFILE_TTL_HOURS` is reused | 1-2 per wallet |
| **Graph expansion** | Each funder is probed once (1,000 signatures) for being a hub; direct and likely funders are followed back up to `INTEL_GRAPH_DEPTH` hops. Edges and clusters are derived | 1 per funder, 1 per hop |
| **Creator history** | Security events, the creator's profile over every recorded launch, the serial-network search | 0 |

### Budgets and truncation

Every provider request goes through one `IntelBudget`: `INTEL_REQUESTS_PER_CYCLE`
split evenly over the tokens still to go, and one deadline
(`INTEL_CYCLE_MAX_MS`). A refusal is recorded once per reason. Each token's
`truncation` list names what was cut:

| Code | Meaning |
|---|---|
| `REQUEST_BUDGET`, `TIME_BUDGET` | a stage stopped before a named step |
| `WALLET_BUDGET` | N more traders were not analysed |
| `WINDOW` (per wallet) | only the newest N transactions were read |
| `FIRST_FUNDING` (per wallet) | oldest-first history unavailable or not read |
| `GRAPH_DEPTH`, `GRAPH_WIDTH` | funding chains stopped at a depth or width |
| `MINT_HISTORY` | only the newest 100 mint transactions were scanned |
| `MINT_ORIGIN` | the endpoint cannot read oldest-first |
| `POOL_UNKNOWN` | no pool is known, so trades could not be read from mint history |
| `POOL_ACTIVITY` | only the newest 1,000 pool readings were used |
| `LIQUIDITY_INFERRED` | N removals rested on an inferred pool side and were not used as evidence |

Truncation lowers **coverage**, which is the mean of four parts: wallet
coverage (an analysed wallet with a truncated window counts 0.75, one not
read counts 0), attribution (1 / 0.5 ambiguous / 0), activity-quality
coverage by trades, and mint-history completeness (1 / 0.5 / 0). The pure
stages still run on whatever was collected, so a truncated analysis is
smaller, never invented.

### Failure isolation

The cycle never throws into the server. Health is `AVAILABLE`, `PARTIAL`
(some requests failed, a budget cut something, or a token's analysis threw),
`FAILED` (every request failed), `STALE` or `UNAVAILABLE` (no database, or
switched off). A provider outage produces a token snapshot whose coverage
says how little was seen, and **no wallet profile**.

---

## 3. Wallet features and buyer authenticity

`features.ts`, `classify.ts`. Every feature is
`{value, quality: MEASURED | PARTIAL | INSUFFICIENT, basis, evidence[≤5]}`
over a stated window (`fromMs`, `toMs`, `transactions`, `historyComplete`).

Features: first seen on chain, age at first trade, transactions per hour,
failed share, trades / buys / sells, token diversity, fresh-launch buys
(≤ 60 s), early-entry share, fastest and median entry, launches entered,
cadence regularity (coefficient of variation, ≥ 10 gaps), median gap, most
transactions in 10 s, repeated buy-size share (±1 %, ≥ 5 priced buys), round
trips, median hold.

Trades are read from the wallet's own side (`wallet-trades.ts`): its token
change against its SOL (native plus wrapped, fee added back) or USDC/USDT
change. A token change with nothing paid is a transfer, not a trade.

| Class | Needs |
|---|---|
| `INSUFFICIENT_DATA` | fewer than 8 transactions or 3 trades |
| `SNIPER` | ≥ 2 sniper signals, one of them strong (entered this token ≤ 10 s after launch, or ≥ 3 launches within 60 s) |
| `HIGH_FREQUENCY_TRADER` | ≥ 2 of: ≥ 30 tx/h over ≥ 30 tx; median hold ≤ 120 s over ≥ 3 round trips; balanced churn over ≥ 20 trades |
| `AUTOMATED_TRADER` | ≥ 2 automation or HFT signals: regular cadence (CV ≤ 0.35), repeated sizes (≥ 60 %), many failures (≥ 25 %), bursts (≥ 5 in 10 s), many tokens (≥ 15 in ≤ 24 h) |
| `LIKELY_ORGANIC` | ≥ 3 organic signals and **no** automation or sniper signal; confidence capped at **0.7** |
| `UNKNOWN` | signals that do not agree (`MIXED`) |

`LAUNCH_SPECIALIST` (≥ 5 known launches) counts only when the median entry is
within 300 s: entering old launches is ordinary trading. This was found by a
test, where one early entry plus five late ones had made a "sniper".

Nothing is ever labelled human. Each result carries its confidence, signals,
counter-signals and coverage (the share of nine core features measured).

---

## 4. Funding

`funding.ts`. A wallet's first inbound SOL (a system transfer or an account
creation with lamports) is read from its **oldest** transactions, which
Helius returns directly (`getTransactionsForAddress`, ascending). Each funder
is probed once: its newest 1,000 signatures, their time span, and the
on-curve test.

| Class | When |
|---|---|
| `INFRASTRUCTURE` | the funder is off-curve (a program account); or sent ≥ 1,000 transactions within 24 h; or funded ≥ 25 of the wallets seen |
| `DIRECT` | the wallet's first SOL, whose start was seen, from a funder **checked** not to be a hub |
| `LIKELY` | an inbound transfer where either half is missing: earliest history not seen, or hub check not made |
| `UNKNOWN` | no inbound SOL observed |

Only `DIRECT` and `LIKELY` make edges. An exchange paying out to many
customers therefore links none of them. Live, 62 of 149 funding observations
were infrastructure. Their hub probes showed 1,000 transactions in 5 to 161
minutes.

---

## 5. The relationship graph and clusters

`graph.ts`, `cluster.ts`. Every edge keeps `type`, `a`, `b`, `directed`,
`confidence`, `count`, `firstAt`, `lastAt`, up to five evidence signatures and
detail.

| Edge | From |
|---|---|
| `FUNDED` | direct or likely funding (directed) |
| `SHARED_FUNDER` | two wallets whose first SOL came **directly** from the same funder (at most 24 siblings) |
| `TOKEN_TRANSFER` | SOL or tokens moved between two addresses whose nature was **checked** (analysed wallets, or funders probed and found not to be hubs) |
| `COORDINATED_ENTRY` | first buys of the same token within 2 slots; a crowd of more than 8 distinguishes nobody |
| `REPEATED_ORDER_SIZE` | the same uncommon buy size (3 significant figures) at least twice; sizes used by more than 8 wallets are ignored |
| `SAME_LAUNCH_PARTICIPATION` | ≥ 2 shared launches entered within 60 s |
| `CREATOR_ASSOCIATION` | an annotation on a hard edge touching a creator; never independent evidence |

Pairs are graded; clusters are connected components over the top two grades
only.

| Level | Requires |
|---|---|
| `CONFIRMED_RELATIONSHIP` | a hard link (direct funding or a transfer) **and** a behavioural or second hard link |
| `STRONG_CANDIDATE` | a hard link alone; a shared direct funder plus behaviour; or two behavioural kinds |
| `WEAK_CANDIDATE` | one kind of link; **never merged**, reported pair by pair |

A funding chain (grand-funder → funder → wallet) is one strong cluster: the
addresses are related. That does not make the wallet's trading
"coordinated", which needs another trader of the same token (§7).

---

## 6. Wash and manipulation

`wash.ts`. On the pool's resolved trades. At least 30 trades, 5 wallets and
50 % resolved are needed, or the answer is `INSUFFICIENT_DATA`.

| Family | Signals |
|---|---|
| Concentration | top-3 wallets' share of volume and of trades (≥ 60 %); trades per wallet (≥ 6) |
| Round trips | buy-then-sell of the same amount (±5 %) within 10 min, by one wallet or a related pair: ≥ 20 % of volume |
| Pattern | trades at a size recurring 3+ times: ≥ 40 % |
| Relationship | volume from wallets clustered with another trader of this token (≥ 30 %); related wallets trading in the same slot (≥ 10 %) |

`HIGH` = round trips **and** (relationship **or** concentration).
`ELEVATED` = any two families. `LOW` otherwise. Every signal reports its
value and threshold, and the counter-signals are listed. Nothing is
rejected on it.

---

## 7. Activity quality

`activity-quality.ts`. The traders of the collected trades, sorted into
coordinated (in a strong or confirmed cluster **with another trader of the
same token**), sniper, automated, likely organic and unknown. Three views,
each with its own denominator: by wallets, by trades, by volume. Unknown is
always shown. **No shares** below 30 % classified coverage, or below 5
trading wallets.

Found live and fixed: "coordinated" first meant "in any cluster". Every buyer
clustered with its own funding wallet was counted as coordination, and one
token read 80 % coordinated.

---

## 8. Attribution

`attribution.ts`. Roles are read separately from the creation transaction:
fee payer, deployers (signers other than the mint keypair), mint and freeze
authority (the mint authority labelled program or wallet), and the pool's
funder. The creator's initial funder is added from the funding graph.

| Case | Result |
|---|---|
| one signer, who paid and funded the pool | `ATTRIBUTED`, 0.85 |
| one signer, a different fee payer | `ATTRIBUTED` to the signer, 0.6: the payer is a relayer |
| several signers | `AMBIGUOUS`, no creator, every candidate kept |
| no creation transaction located | `UNKNOWN` |

The fee payer is never assumed to be the creator.

---

## 9. Security events

`security.ts`. Machine-verifiable actions, each with the transaction that
proves it. "Creator-linked" means the creator, the creation's signers, a
wallet fee payer, the creator's strong-cluster co-members and wallets it
funded directly.

| Event | Status |
|---|---|
| `SUPPLY_EXPANSION` (minted after launch) | CONFIRMED when minted to a creator-linked wallet that sold ≥ half within 24 h; STRONGLY_SUSPECTED to a linked wallet; SUSPICIOUS otherwise |
| `AUTHORITY_REASSIGNED` (moved, not revoked) | SUSPICIOUS |
| `FREEZE_ABUSE` | CONFIRMED at ≥ 3 frozen **holder wallets**; STRONGLY_SUSPECTED at 1-2; SUSPICIOUS when the owner was not reported. Program-owned accounts are not holders |
| `LIQUIDITY_DRAIN` | CONFIRMED when creator-linked and ≥ 80 % of the reserve; STRONGLY_SUSPECTED linked and ≥ 30 %; SUSPICIOUS unlinked and ≥ 80 %. Program actors (migrations) are skipped. Only readings of the pool's own balances count |
| `CREATOR_DUMP` | STRONGLY_SUSPECTED at ≥ 30 % of supply sold by linked wallets within an hour; SUSPICIOUS at ≥ 10 %; **never CONFIRMED**. No claim when the supply is unknown |

A re-detection may escalate a stored status but never lowers it, because a
later, more truncated read can miss a fact. A **CONFIRMED event is never
pruned**.

Found live and fixed:
- Transactions that never touched the pool (escrow fills) were read as 100 %
  liquidity drains. 23 false SUSPICIOUS events came from one token.
- A creator-signed freeze of a program vault was read as holder abuse.

---

## 10. Creator history and serial networks

`creator.ts`.

| Creator status | When |
|---|---|
| `MALICIOUS_HISTORY` | a CONFIRMED event on any of its recorded launches |
| `SUSPICIOUS` | suspected events only |
| `CLEAN` | ≥ 2 launches and no events: "nothing found in what we saw" |
| `INSUFFICIENT_HISTORY` | one launch or none |

The network search runs breadth-first from the creator (or every candidate
of an ambiguous launch), up to `INTEL_GRAPH_DEPTH` hops over **strong** links
only: direct or likely funding, transfers, shared direct funders and cluster
membership. Path confidence is the product of the edge confidences.

| Level | When |
|---|---|
| `STRONG` | an address with a confirmed history, path confidence ≥ 0.5 |
| `MODERATE` | a confirmed history through weaker paths, or a strongly suspected one |
| `WEAK_ASSOCIATION` | reachable **only** through behavioural coincidence. Stated explicitly as not a malicious finding; confidence 0 |
| `NONE` / `INSUFFICIENT_DATA` | nothing found / no creator to trace |

A brand-new creator wallet does not reset anything: if its first SOL came
directly from an address with a confirmed history, the one-hop path shows
it, with the evidence signature.

---

## 11. Holder roles

`core/holder-roles.ts`, called from `helius.onchainInfo` with one batched
`getMultipleAccounts` over the largest accounts. Each large account is
labelled bonding curve, pool, program-owned or wallet by its owner. A
wallet-only top-10 share is stored **beside** the raw one
(`holder_snapshots.wallet_top10_pct`, `role_breakdown`), never in its place.
It is null when any owner was unreadable, since an unreadable owner might be
a wallet. Nothing in scoring, the gate or ranking reads it, and a test
enforces that. Live: 60 of 60 scanned tokens were labelled, every owner
resolved.

---

## 12. Helius strategy

| Measure | Why |
|---|---|
| `getTransactionsForAddress` for wallet and mint history | one request per page of 100 full transactions (measured: 100 in ~120 ms, ~915 KB). Oldest-first makes first funding answerable at all |
| One `getSignaturesForAddress` page per funder, cached in `address_stats` for the profile TTL | the hub check costs one request, once |
| Profiles reused within `INTEL_PROFILE_TTL_HOURS` | re-analysing a token cost 2 requests and 0.5 s live |
| Mint-history trades recorded through collection's own path | a deeper sample for wash and activity at no extra request |
| Transaction cache for single fetches only, 1,000 entries, in-flight dedupe | caching history pages served **0 hits for ~200 MB** in a live cycle, so it was removed |
| `getTokenLargestAccounts` in its own lane | measured p50 2.8 s, p95 4.2 s, and an overload error inside HTTP 200 under a 5/s burst. So: two in flight, 8 s timeout, no retry, a five-minute pause after an overload, a day's memory of "too many accounts" per mint. A scan cannot stall on it |
| Helius pacing 300/min (was 120) | 15/s ran 30/30 clean in measurement. The public endpoint stays at 60/min, because it returns 429 above ~1/s |
| Wallet reads two at a time; one cycle budget shared by every stage | global throughput is bounded by the budget, not raised blindly |

Oldest-first history exists only on Helius. On any other endpoint the cycle
still runs, the first-funding reads are recorded as truncated, and funding
is therefore never `DIRECT`.

---

## 13. Persistence: schema v3

Migration 3 (`deep-intelligence`) is additive. Readers and writers are in
`persist/intel-repository.ts`.

| Table | Written by | Read by | Index | Retention |
|---|---|---|---|---|
| `wallet_profiles` | wallet analysis | reuse, activity quality, diagnostics | `analyzed_at` | chain window |
| `wallet_trades` | wallet analysis | graph, security (creator sells) | `(mint, slot)` | chain window, by chain time |
| `funding_edges` | funding | graph, network search, fan-out | `funder` | token window |
| `address_stats` | hub probe | funding classification | PK | chain window |
| `wallet_edges` | graph | clusters, network search | `a`, `b` | chain window |
| `wallet_clusters`, `cluster_members` | clustering | activity, wash, security links, network | `cluster_members.wallet` | chain window (members cascade) |
| `launch_attributions` | attribution | creator launches, diagnostics | `creator` | token window |
| `security_events` | security | creator profiles, diagnostics | `mint` | token window; **CONFIRMED never pruned** |
| `creator_profiles` | creator history | network search | PK | token window |
| `token_intelligence` | each analysis | `/api/intel`, System, refresh planning | `(mint, analyzed_at)` | chain window |

Also added: `pool_activity.liquidity_actor` and `reserve_fraction`, and
`holder_snapshots.wallet_top10_pct` and `role_breakdown`, all nullable. On
the live scratch database (v2, 120 snapshots, 596 transactions) the
migration applied in one transaction, integrity ok, with every row count
unchanged. CHECK constraints refuse impossible classes, levels, statuses and
event types.

---

## 14. Surfaces

Since Phase 3 the product surfaces are the Dossier's **Activity Integrity** and
**Rug Intelligence** sections (DECISION_ENGINE.md §12). The Phase 2 diagnostics remain:

- System page, **Deep intelligence (diagnostics)**: health, last cycle,
  classifications, funding, graph and cluster counts, attribution, creator
  history, security events, the most recent tokens with coverage and
  truncation, and the largest-accounts guard. The Board and the Dossier are
  unchanged.
- `GET /api/intel/:mint`: the latest snapshot, the attribution record and
  the events. 400 on a malformed mint, 404 when not analysed.
- CLI: `intel-run`, and `intel <mint> [--run]`.

---

## 15. Live mainnet verification (2026-09-27, Helius, scratch database)

Engineering checks only; none of this measures accuracy.

- **Scan:** 163 candidates, 60 analysed in 123 s. Holder roles recorded for
  60/60.
- **Collection:** 123 and 88 calls, none failed.
- **Intelligence, first cycle:** 2 tokens, 33 requests, 6.9 s.
- **Six-token cycles:** 101 requests in 23.6 s, and 233 requests in 62.3 s
  with nothing reused. Zero failures and zero rate-limited calls in both:
  152 history pages and 81 signature probes.
- **Memory:** transient growth ~105 MB during a six-token cycle after the
  cache change (~200 MB before).
- **Produced across 16 tokens:**
  - 114 profiles: 28 automated, 15 high-frequency, 10 likely organic,
    47 unknown, 14 insufficient data.
  - 149 funding observations: 87 direct, 62 infrastructure.
  - 190 edges.
  - 46 clusters: 3 confirmed, 43 strong candidates; sizes 2-6.
  - Attribution: 15 attributed, 1 ambiguous.
  - Wash: 12 insufficient data, 3 low, 1 high.
  - Security events after the fixes: 0.
- **The one HIGH wash reading:** three traders first funded by the same
  quiet wallet made 97 % of the volume, with 24 % in round trips. One of
  them is a high-frequency trader. It is reported as risk, with its
  counter-signal.
- **Restart:** each CLI run is a new process over the same file, so every
  second run is a restart check.
- **Secrets:** the key appears in no response, log or database file, and the
  child-process test proves the same.

---

## 16. Known limitations

- **Pool coverage is partial.** *(Phase 3: every provider-reported pool is now read from the mint's own history and up to two are collected; each reading states how much of the market it represents, and that caps its coverage. See DECISION_ENGINE.md §6.)* A busy token is still sampled, not read in full.
- **Windows are small.** Newest 100 transactions per wallet and per mint;
  older facts (an early mint, an old freeze) can be missed, and the
  truncation says so.
- **Oldest-first history is Helius-only.** Elsewhere, funding is never
  `DIRECT`.
- **The hub probe is recency-based.** A dormant exchange wallet could read
  as quiet; the fan-out rule (≥ 25 funded wallets seen) is the backstop.
- ~~**A rule change does not retract stored events.**~~ **Fixed in Phase 3.**
  Each event carries the rule version that found it; a re-analysis under a
  newer rule reinterprets or supersedes it (archiving the earlier reading),
  and only current-rule, unsuperseded events are decision evidence. See
  DECISION_ENGINE.md §2.
- **Clusters are rebuilt around the wallets just analysed**, from edges up to
  one neighbour away; a cluster held together further out can split.
- **Nothing is calibrated.** Every threshold is a starting point for Phase 4.
