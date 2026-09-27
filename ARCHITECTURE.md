# Architecture

Audience: engineers working on Token Finder.
**Part 1 describes what exists. Parts 2–5 are proposals and are NOT IMPLEMENTED.**

> **A future subsystem is specified separately.** Technical Intelligence — chart
> structure, pivots, support/resistance and pattern detection — is designed in
> **[TECHNICAL_INTELLIGENCE.md](TECHNICAL_INTELLIGENCE.md)**. It is **PLANNED and
> NOT IMPLEMENTED**: nothing in `src/` refers to it, there is no OHLCV provider,
> and it would sit outside the Risk Score as an independent layer consumed only
> by a future Decision Engine.

> **Foundation Hardening II changed the analysis path substantially.** The stages
> between discovery and ranking are now a documented pipeline with a provider
> validation boundary, a canonical evidence model, deterministic cross-provider
> resolution, a hard safety gate, separate coverage/confidence accounting, ranking
> eligibility and a token lifecycle. See **[PIPELINE.md](PIPELINE.md)**, which is the
> authoritative description of `src/core/`. The notes below are updated in place where
> they described the old behaviour.

## Part 1 — Current architecture (as committed)

### Runtime shape

Single Node 24 process, no build step, **zero runtime dependencies**. TypeScript is executed
by native type stripping. `typescript` + `@types/node` are devDependencies used only by
`npm run typecheck`. Tests run on `node:test` with no framework (`npm test`).

The optional TypeSafe/Jev integration keeps this shape: it is a `fetch` call through the
existing `util/http.ts` client, not an SDK dependency.

```
src/cli.ts ── serve ──> src/server/index.ts ──> node:http ──> src/server/public/*
    │                        │
    │                        └── startMonitor() ──┐
    ├── scan / watch / analyze / rank / discover  │
    │                                             v
    └────────────────> src/core/monitor.ts  (chained setTimeout loop)
                             │
              discover.ts ──>│<── analyze.ts ──> score.ts
                             │         │
                             │         ├── sources/dexscreener.ts   LIVE
                             │         ├── sources/jupiter.ts       LIVE
                             │         ├── sources/rugcheck.ts      LIVE
                             │         ├── sources/helius.ts        key-gated, inactive
                             │         └── sources/birdeye.ts       key-gated, inactive
                             v
                        core/store.ts ──> persist/ ──> data/token-finder.sqlite
                             │
                        EventEmitter "bus" ──> SSE /api/stream ──> dashboard
```

### Pipeline stage status

| Stage | Status | What the code actually does |
|---|---|---|
| Token discovery | **IMPLEMENTED** | 5 feeds via `Promise.allSettled`; a failing feed logs and contributes nothing |
| Provider validation | **DONE** | `src/core/validate.ts` type- and range-checks every consumed field at the boundary. Impossible values (negative liquidity, NaN price, a pool older than Solana, a string in an authority boolean) are rejected and recorded as `FieldIssue`s rather than coerced |
| Normalization | **DONE** | Per-source normalizers produce typed structs carrying their own `issues[]`. Absent stays UNKNOWN; present-but-impossible becomes INVALID. Neither earns points |
| Cross-provider evidence | **DONE** | `src/core/resolve.ts` produces one canonical `TokenEvidence` set with state, source, freshness, confidence and every provider claim retained |
| Safety gate | **DONE** | `src/core/gate.ts` evaluates thirteen veto rules before ranking. Never vetoes on UNKNOWN |
| Token-2022 awareness | **DONE** | `src/core/token-program.ts` classifies mint extensions by what they can do to a holder now. Six can veto; an unrecognised one never vetoes and marks coverage incomplete. Requires a Helius key — without one, extension evidence is UNAVAILABLE |
| Coverage / confidence | **DONE** | `src/core/lifecycle.ts` reports both, separately from score |
| Ranking eligibility | **DONE** | QUALIFIED / WATCH / INSUFFICIENT_DATA / REJECTED; eligibility outranks every sort key |
| Lifecycle | **DONE** | Deterministic state machine, transitions validated, nothing irreversible |
| Initial filter | **IMPLEMENTED** | Drops `liquidity < MIN_LIQUIDITY_USD` and `age > MAX_AGE_HOURS`; sorts by liquidity and truncates to `MAX_ANALYZE_PER_SCAN` (60) |
| Market enrichment | **IMPLEMENTED** | Batched DexScreener pairs (30/call) + Jupiter search (100/call), run concurrently |
| On-chain safety | **NOT IMPLEMENTED in practice** | `helius.ts` returns `null` without a key, so the evidence is UNAVAILABLE. Its parser (`parseMint`) is now verified on live mainnet accounts through the public RPC (`scripts/verify-live.ts`); the Helius request itself has not run (no key) |
| On-chain discovery | **IMPLEMENTED** | pump.fun launches read from the chain and merged into discovery as `chain:pumpfun`, with first-sighting provenance per source. See [DATA_BACKBONE.md](DATA_BACKBONE.md) |
| Transaction ingestion | **IMPLEMENTED** | Survivors' pool transactions read into pool activity, transfer edges, wallets and chain events, within a budget, with gaps recorded. Read by deep intelligence |
| Deep intelligence | **IMPLEMENTED — diagnostics only** | `src/intel/`: buyer classes, funding, a typed wallet graph, conservative clusters, wash analysis, activity quality, attribution, security events, creator history and serial networks, in a staged cycle with hard budgets and recorded truncation. **Feeds no score, ranking or veto.** See [DEEP_INTELLIGENCE.md](DEEP_INTELLIGENCE.md) |
| Buyer / holder analysis | **PARTIAL** | `holderCount` and `topHoldersPercentage` read from Jupiter; large holders labelled by role, with a wallet-only share stored beside the raw one. Deep intelligence produces buyer classes and clusters, **not yet used by scoring or the gate** |
| Momentum | **PARTIAL** | DexScreener `priceChange` 1h/6h blended. **Fabricates 0% when no pair exists** (35% of tokens) |
| Scoring | **IMPLEMENTED** | 7 weighted components + multiplicative penalties — see `SCORING.md` |
| Ranking | **IMPLEMENTED** | In-memory sort by one of 6 keys, filtered, capped at 500 |
| Monitoring | **IMPLEMENTED** | Chained `setTimeout` (never stacks); diffs each snapshot and emits 6 event kinds |
| Dashboard | **IMPLEMENTED** | Static HTML/CSS/JS, SSE live updates, filters, sort, detail drawer with score breakdown + sparklines |

### Component inventory

**Discovery** (`core/discover.ts`) — feeds: `jupiter:recent`, `jupiter:organic`,
`dexscreener:profiles`, `dexscreener:boosts`, `birdeye:new`. Merged into a `Map` keyed by
mint; each feed that re-sees a mint appends its name to `sources[]`. Measured contribution:
`jupiter:organic` 39, `dexscreener:profiles` 11, `dexscreener:boosts` 8, `jupiter:recent` 5,
`birdeye:new` 0. Only 4 of 60 tokens were seen by more than one feed, and **`sources[]` is
never used as corroboration in scoring.**

**Deduplication** — mint-address keyed `Map` in `discover()`, plus `Map` keyed by
`baseToken.address` in `pairsForMints`. No cross-symbol or metadata-similarity dedup, so
copycat tokens are separate entries (RugCheck's `copycat_token` risk is the only detector).

**Liquidity filtering** — `totalLiquidity()` sums `liquidity.usd` across **all** pairs, falling
back to Jupiter's single number when the sum is 0. Fallback is silent and unvalidated.

**Rate-limit handling** (`util/http.ts`) — one serialized promise chain per host with a minimum
gap derived from a hardcoded RPM table; 429 sets a per-host `cooldownUntil` honouring
`retry-after`. **No provider returns rate-limit headers, so this is open-loop.**

**Retry logic** — `getJson` retries up to 2 times on 429 and 5xx with linear backoff
(500 ms × attempt); 4xx other than 429 throws immediately; `nullOn` (default `[404]`) resolves
to `null`. `tryGetJson` converts every failure into `null` and a debug log.

**Caching** — `TtlCache` (`util/cache.ts`), in-process only, FIFO eviction (not LRU).
RugCheck 20 min / 2000 entries, Helius 10 min. **Does not survive process restart** — measured:
a second CLI scan took 122.8 s vs. 123.0 s cold, i.e. no benefit.

**Persistence** (`core/store.ts` over `src/persist/`) — SQLite via the built-in
`node:sqlite`, WAL mode, zero runtime dependencies. `store.ts` keeps the public API it had as
a JSON store, so nothing downstream was rewritten; underneath, current state is a
write-through cache over the `tokens` table and history is queried from normalized tables.
Nine tables, `PRAGMA user_version` migrations, snapshot deduplication with guaranteed
retention of state transitions, and an age-based retention policy. `data/state.json` is now
**legacy import input only** and is never written again. Full detail:
**[PERSISTENCE.md](PERSISTENCE.md)**. Measured: 100-token scan persists in ~45 ms; the real
2,104-token JSON corpus imported in ~2 s to a 14.2 MB database.

**Error handling** — sources fail soft to `null`; `discover` uses `allSettled`; the server
wraps every request. **Gap:** `pool()` uses `Promise.all`, so if any worker in `analyze()`
throws synchronously (e.g. `scoreToken` on malformed input) the **entire scan aborts**.
`runScan` catches it in `startMonitor`, so the loop survives, but that scan yields nothing.

**SSE / realtime** — `EventEmitter` bus; `/api/stream` sends `hello` on connect and
relays `scan-start`, `scan-stage`, `scan`, `scan-failed` and `alert`. `scan-stage` is the
scan's real progress: `discover`, `discovered` (count), `market` (count), `safety` (count)
and `evaluated` (done of total) — counts, never a percentage. A scan that throws still emits
`scan-failed`, so the dashboard never shows a scan as running forever. 25 s keep-alive
ping, cleanup on `close`. Realtime is *within* the app only —
**all ingestion is polled REST; there is no websocket or gRPC feed from any provider.**

**Dashboard** — four routed surfaces: Board `/`, Dossier `/t/:mint`, Changes `/changes`
and System `/system`. It is buildless: plain ES modules served from `src/server/public/`,
typed with JSDoc and checked by `tsconfig.web.json`. The decision and its alternatives are
in [docs/adr/0001-frontend-architecture.md](docs/adr/0001-frontend-architecture.md).

The layers:

| Layer | Files | Owns |
|---|---|---|
| Ranking | `core/ranking.ts` | The one live-universe predicate, `placementOf`, and the verdict tiers. |
| Evidence ledger | `core/ledger.ts` | A compact per-signal projection of `TokenEvidence`, stored on each snapshot. |
| Capabilities | `core/capabilities.ts` | What this configuration can check: ON, DEGRADED, OFF or DISABLED. |
| Language | `server/present.ts` | Every human-readable label and reason. Nothing else phrases a verdict. |
| DTOs | `server/dto.ts` | View-shaped responses. The browser never receives a raw snapshot. |
| Security | `server/security.ts` | Host allowlist, same-origin check, CSP and headers, URL guard. |
| Rendering | `public/lib/html.js` | The single HTML sink: an escaping tagged template. |
| Observatory | `public/ui/orb.js`, `GET /api/orb` | The Board's animated signature: a Canvas 2D network with real token links over it, driven only by real state. See [docs/adr/0002](docs/adr/0002-intelligence-orb.md). |
| Live state | `public/lib/live.js` | The SSE connection, a heartbeat, and the `connecting`/`live`/`reconnecting`/`offline` state machine. |

The Board refetches on `scan`; every page listens for connection changes.

**API key requirements** — none to run. `HELIUS_API_KEY` and `BIRDEYE_API_KEY` are optional
and currently unset; both corresponding sources are inert. Chain collection uses the public
Solana endpoint when neither `SOLANA_RPC_URL` nor a Helius key is set.

**Test coverage** — `npm test` runs 417 `node:test` tests (engine, persistence, DTOs, security
boundary, render boundary). `npm run test:ui` runs 44 more in a real headless Chromium,
driven over the DevTools protocol with real pointer, touch and key events and no npm
dependency. `npm run lint` enforces the render and persistence boundaries. Discovery
against live providers is still verified only manually.

### Known defects carried by this baseline

1. ~~Missing market data scores as neutral rather than unknown~~ — **FIXED.** Unmeasured
   values are `null` end to end and earn zero; `score.coverage`/`score.ceiling` state the
   cost, and alerts require `coverage >= MIN_COVERAGE_ALERT` (`SCORING.md` §5.1).
2. ~~RugCheck `danger` authority findings never trigger the authority penalty~~ — **FIXED.**
   Authority is resolved across Jupiter, RugCheck and Helius; a stated danger wins over both
   silence and a contradicting claim, and disagreement raises `provider_conflict`
   (`SCORING.md` §5.2).
3. `lpLockedPct` is received from RugCheck and discarded.
4. `MonitorEvent` kind `'gone'` is declared in `types.ts` but never emitted — dead contract.
5. `cli.ts analyze` overwrites a token's `sources` with `['cli']`, destroying discovery provenance.
6. Helius/Birdeye requests have never executed against a real response (no keys). The
   Helius *parser* has, on live accounts through the public RPC (DATA_BACKBONE.md §1).
7. `store.prune` deletes tokens silently; no event records that a token stopped being tracked.
8. ~~`pool()` in `util/http.ts` still uses `Promise.all`, so one rejected worker aborts
   the scan~~ — **FIXED.** `poolSettled()` isolates every task; the batch always
   completes and each item keeps its outcome. See [PIPELINE.md](PIPELINE.md) §8.
9. ~~Snapshots written before evidence tracking carry no `coverage`/`unknown` field~~ —
   state is now versioned (`STATE_VERSION = 2`) and the previous file is copied aside
   before a migration. Legacy snapshots are still shown as "not recorded" until the next
   scan replaces them; there is no in-place upgrade of old rows.
10. ~~Still zero schema validation at the provider boundary~~ — **FIXED**, see
    [PIPELINE.md](PIPELINE.md) §1.
11. Coverage and veto thresholds are operator-tunable starting points, **not calibrated
    against outcome data**. Nothing has been validated against whether a token rugged.
12. Birdeye remains unexercised against a real response (no key).
13. `cli.ts analyze` still overwrites `sources` with `['cli']`.

## Part 2 — Target architecture (PROPOSAL — NOT IMPLEMENTED)

```
                    ┌──────────────── INGESTION ────────────────┐
  Helius WS/gRPC ──>│ pool-init events        (push, realtime)  │
  Jupiter/DexScr ──>│ polled feeds            (pull, reconcile) │
                    └────────────────────┬──────────────────────┘
                                         v
                              [1] DISCOVERY QUEUE            durable, deduped by mint
                                         v
                              [2] NORMALIZER                 schema-validated, UNKNOWN preserved
                                         v
                              [3] SAFETY GATE                hard veto — can terminate here
                                         v
                              [4] ENRICHMENT FAN-OUT         market · liquidity · holders · volume
                                         v
                              [5] ANALYSIS                   concentration · buyer quality ·
                                                             sybil/cluster · volume quality · momentum
                                         v
                              [6] SCORING                    explainable, per-component provenance
                                         v
                              [7] RANKING                    + watchlist
                                         v
                              [8] DECISION ENGINE            state machine (Part 4)
                                         v
                              [9] EXECUTION LAYER            paper | manual | capped | auto
                                         v
                             [10] POSITION MONITOR           exit rules, kill switch
                                         v
                             [11] AUDIT TRAIL                append-only, every decision
                                         v
                             [12] DASHBOARD / API
```

### Module dependency map

| Module | Depends on | Blocks |
|---|---|---|
| Normalizer + `UNKNOWN` type | — | everything downstream; **must land first** |
| Safety gate | normalizer, Helius key | scoring integrity, all trading |
| Provider cross-validation | normalizer | safety gate, scoring |
| Persistence (DB) | — | score history, clusters, trades, audit |
| Holder/cluster analysis | Helius, persistence | buyer quality, sybil detection |
| Volume quality | Jupiter organic fields | scoring v2 |
| Scoring v2 | all analysis modules | ranking, decision engine |
| Watchlist | persistence | decision engine |
| Paper trading | persistence, price feed, audit trail | manual mode |
| Decision engine | scoring v2, watchlist, paper trading | every trading mode |
| Risk limits (size, daily loss, kill switch) | persistence, audit trail | **hard prerequisite for any live mode** |
| Pre-trade revalidation | decision engine, safety gate | capped/auto modes |
| Wallet connection | key custody design | capped/auto modes |
| Execution (Jupiter swap) | wallet, risk limits, revalidation | capped/auto modes |

Critical path: **normalizer → cross-validation → safety gate → persistence → scoring v2**.
Nothing in trading should start before those five are done.

## Part 3 — Trading modes (PROPOSAL — NOT IMPLEMENTED)

No mode may be skipped. Each is a superset of the previous one plus new safeguards.

| Mode | What it does | Wallet | New infrastructure required |
|---|---|---|---|
| **1. Scan only** | discovery, scoring, ranking, alerts. *This is today's product.* | none | none |
| **2. Paper trading** | simulated entries/exits, P&L accounting, no chain writes | none | position ledger, fill simulation (slippage + price impact from pool depth), P&L engine, audit trail |
| **3. Manual confirmation** | engine proposes; a human approves each trade; execution is real | read-only connect, sign per trade | signing UX, per-trade expiry, pre-trade revalidation, execution adapter |
| **4. Capped auto** | engine executes autonomously inside hard caps | hot wallet, strictly limited balance | position-size limits, daily-loss limit, max concurrent positions, per-token cap, kill switch, rate limiter, circuit breaker on anomaly, mandatory pre-trade revalidation |
| **5. Full auto** | as above with raised caps | hot wallet | everything from mode 4 plus: proven paper→live correlation over a statistically meaningful sample, monitored alerting, independent watchdog process, documented incident runbook |

Promotion gates (proposed, must be explicit): mode 2→3 requires a paper track record on a
pre-registered strategy; 3→4 requires manual-mode fills matching paper expectations within a
stated tolerance; 4→5 requires sustained operation at caps with zero safety-limit breaches.

**Key custody is an unsolved design question.** No private key should live in `.env`, in this
repo, or in the app process. Modes 3–5 need a deliberate custody decision (hardware signer,
OS keychain, or a separate signer service) before any code is written.

## Part 4 — Decision engine state machine (PROPOSAL — NOT IMPLEMENTED)

```
            DISCOVERED
                 v
             SCANNING ──────────────> REJECTED   (terminal, with reason + TTL before re-look)
                 v
        ┌──── triage ────┐
        v                v
     WATCH           QUALIFIED
        │                v
        └──re-scan──> ENTRY_READY ──veto──> WATCH
                         v
          PAPER_POSITION | LIVE_POSITION
                         v
                    MONITORING ──> EXIT_SIGNAL ──> CLOSING ──> CLOSED
                         │                                       ^
                         └──────── EMERGENCY_EXIT ───────────────┘
```

Every transition carries `{from, to, at, reason, evidence[], provider_versions}` and is
appended to the audit trail. A state change with no recorded reason is a bug.

**Immediate rejection** — mint or freeze authority live and unrevoked; LP unlocked below
threshold; liquidity below floor; honeypot / sell-disabled detected; creator on a known-rug
list; token program not a recognized SPL variant; **required safety data unavailable**
(unknown is rejection, never a pass).

**Score downgrade** — liquidity falling; holder count falling; concentration rising; organic
volume share falling; provider disagreement appearing; a new RugCheck risk; momentum reversal.

**Entry veto** (at `ENTRY_READY`, re-checked immediately pre-trade) — price moved beyond the
decision's validity window; liquidity dropped since qualification; spread or price impact for
the intended size exceeds limit; position-size or daily-loss limit would be breached; max
concurrent positions reached; any safety datum now stale or unknown; quote older than N seconds.

**Emergency exit** — LP removal detected; authority re-enabled; a large holder dumping;
liquidity collapse beyond threshold; price collapse beyond stop; trading halted on the pair;
our own data pipeline degraded (exit rather than fly blind).

**Trading halt (global kill switch)** — daily loss limit hit; N consecutive losses; execution
failure rate above threshold; provider outage affecting safety checks; clock/state desync
detected; manual trigger. Halt must be **enforced in the execution path itself**, not merely
signalled to the UI.

## Part 5 — Persistence and performance (PROPOSAL — NOT IMPLEMENTED)

### What needs persisting

| Data | Shape | Retention | Why the current file cannot serve it |
|---|---|---|---|
| Discovered tokens | row per mint | indefinite | fine today |
| Scan snapshots | append-only, per scan per token | 30–90 d | whole-file rewrite makes append O(total) |
| Score history | time series | 90 d+ | capped at 240 points, silently truncated |
| Market snapshots | time series | 30 d | same |
| Risk events | append-only | indefinite | capped at 500, oldest dropped |
| Wallet clusters | graph / adjacency | indefinite | not modelled |
| Paper + live trades | ledger, immutable | indefinite | not modelled |
| Decisions + entry/exit reasons | append-only audit | indefinite — **must be tamper-evident** | not modelled |
| P&L | derived, recomputable | indefinite | not modelled |
| System events | append-only | 30 d | not modelled |

**Recommendation: SQLite** (via `node:sqlite`, keeping the zero-dependency property) with
WAL mode. Relational, transactional, append-friendly, single file, no server. Time series in
narrow tables with `(mint, at)` indexes; audit trail as an append-only table with no UPDATE
grant. Revisit Postgres + TimescaleDB only if this becomes multi-process or multi-user.
Keep `state.json` only as an export format.

### Performance model

Measured today: 60 deep tokens per scan, **123 s wall clock**, 173 KB state, RugCheck-bound.

| Scanned | RugCheck time at 30 RPM | State size at full history | Verdict |
|---|---|---|---|
| 100 | ~200 s | ~2.2 MB | already exceeds a 120 s interval — **scans overlap-block** |
| 1,000 | ~33 min | ~22 MB | infeasible; whole-file rewrite dominates |
| 10,000 | ~5.5 h | ~221 MB | infeasible on every axis |

Bottlenecks in order: **(1) RugCheck 30 RPM serialized per host** — the hard ceiling;
(2) **whole-file JSON rewrite** — O(total state) on a 1.5 s debounce, so cost grows with
tokens tracked, not tokens changed; (3) **everything in one heap** — `store` holds all tokens
and history permanently; (4) **`pool()` concurrency of 4** on deep lookups, itself gated by the
per-host serial chain, so the two limits compound; (5) **dashboard re-fetches the full list**
on every scan event; (6) Helius RPC credits once enabled — `getTokenLargestAccounts` per token
per scan would dominate cost.

Proposed direction (not to be implemented now): a durable priority queue instead of
"sort by liquidity, take 60"; **tiered refresh** (new/qualified tokens every scan, watchlist
hourly, cold tokens daily) so cost scales with interest rather than corpus size; persistent
cross-restart cache keyed by `(mint, provider, fetched_at)`; worker processes for enrichment
with the API limiter as a shared token-bucket service; incremental DB writes replacing the
file rewrite; SSE deltas instead of full-list refetch; drop raw provider payloads after
normalization.
