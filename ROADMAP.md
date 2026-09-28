# Roadmap

Audience: whoever plans and sequences Token Finder work.
**Phase 1 is complete and Phase 2 is complete.** Everything from Phase 3 on is still a
proposed sequence awaiting approval. See [PIPELINE.md](PIPELINE.md) for what was built.

Ordering principle: correctness of the data model before breadth of features, and every
safety mechanism before the capability it protects.

## Phase 0 — Baseline (DONE)

Prototype: 5 discovery feeds, 7-component scoring, monitoring loop, SSE dashboard, CLI,
JSON persistence. Audited in `ARCHITECTURE.md`, `SCORING.md`, `DATA_SOURCES.md`.
Known defects listed in `ARCHITECTURE.md` Part 1.

## Phase 1 — Data integrity (blocks everything else)

1. **DONE** — explicit `UNKNOWN` through normalization, scoring, the API and the UI. Missing
   data never coerces to `0` or a neutral default. Removes the fabricated-points defect
   (`SCORING.md` §5.1), and adds `coverage`/`ceiling` so the cost of missing evidence is
   visible on every token.
2. **DONE** — every consumed provider field is type- and range-checked at the boundary
   (`src/core/validate.ts`). Malformed values are rejected and recorded, never coerced.
3. **DONE** — `src/core/resolve.ts` resolves every fact across providers, with
   conservative rules for safety facts, and records disagreement as CONFLICTED with
   every claim retained.
4. Consume what we already receive: `lpLockedPct`, `dev`/`devMints`/`devMigrations`,
   Jupiter organic-volume fields, `holderChange`/`liquidityChange`. **Still open.**
5. **DONE** — 265 tests covering validation, resolution, gate, coverage, eligibility,
   lifecycle, Token-2022 extension policy, holder math and the Jev failure paths, over a
   deterministic 14-scenario fixture corpus.
6. **DONE** — Token-2022 awareness. The mint's owning program and extension list are
   read from the chain, six extensions can veto, and holder concentration is exact
   integer arithmetic over raw base units. Before this a Token-2022 mint with a
   permanent delegate scored as a clean token.

Exit criterion: no score contains a point derived from absent data. **Met**, and now
enforced at the boundary as well as in the scorer.

### Not part of Phase 1: advisory impersonation screening

An optional Jev-backed naming check shipped alongside Phase 1 (`SCORING.md` §6). It is
deliberately outside the scoring path: advisory flag only, off by default, fails to
"not assessed" rather than to "safe". It does not satisfy any Phase 2 requirement.

## Phase 2 — Safety gate (DONE)

Seven veto rules, evaluated before ranking, able to remove a token entirely
(`src/core/gate.ts`). Every veto carries code, reason, source, observed value,
timestamp and whether it can clear.

Two deliberate departures from the original sketch:

- **A Helius key is not required.** Authority is resolved across Jupiter, RugCheck and
  Helius, and a RugCheck `danger` finding is enough to veto on its own. Helius makes the
  reading stronger; it is not a precondition for having a gate.
- **Unknown safety data does not cause rejection.** The original note said "unknown ⇒
  rejection, not a pass". In practice that would reject most keyless-mode tokens, since
  Jupiter's audit block is frequently null. Unknown instead earns **zero credit** and
  lowers coverage, which keeps it out of QUALIFIED without pretending we found something
  dangerous. Vetoes require a provider to have actually asserted the danger.

## Phase 3 — Persistence — **DONE**

SQLite via the built-in `node:sqlite`, WAL mode, **zero runtime dependencies added**. Nine
tables behind a repository boundary (`src/persist/`); no SQL outside it. `PRAGMA user_version`
migrations, ordered and append-only. Tokens, verdict/market/holder/pool history, canonical
per-metric evidence, provider failures, events.

Legacy `data/state.json` is imported once — backed up first, in one transaction, at most once,
never fabricating the `evaluation` that v1 did not record — and is thereafter **legacy input
only**. SQLite is canonical.

Snapshot deduplication (material change, transition, 30-minute heartbeat) keeps a two-minute
scan loop from writing ~700 identical rows per token per day, and **state transitions are
never pruned**. Age-based retention, all thresholds configurable.

Full detail: **[PERSISTENCE.md](PERSISTENCE.md)**.

Still open from the original scope: the append-only **audit table** (nothing writes to it yet,
and an empty table is not a foundation) and the **persistent provider cache** keyed by
`(mint, provider, fetched_at)` — the in-memory TTL cache still serves that need. History
downsampling is also deferred; §13 of PERSISTENCE.md says why.

## Phase A — Product foundation — **DONE (on `feature/product-foundation`, in review)**

The product surface rebuilt on the engine without changing what the engine concludes.
No scoring weight, veto, evidence state, provider precedence, Token-2022 policy or schema
changed.

- **Correctness:** one live-universe predicate for every ranking surface (PIPELINE.md §6);
  history retention decoupled from display.
- **Security:** loopback bind; Host allowlist against DNS rebinding; same-origin check on
  `POST /api/scan`; a CSP with no `unsafe-inline`; an escaping render boundary and an
  `http(s)`-only URL guard, enforced by lint.
- **Surfaces:** Board, Dossier (evidence ledger, history, contract), Changes and System,
  on view-shaped DTOs (a Board row is about 0.5 KB).
- **Architecture:** buildless ES modules, recorded in
  [docs/adr/0001](docs/adr/0001-frontend-architecture.md).
- **Verification:** real-browser tests with real pointer, touch and key input; render-
  and security-boundary tests.

Not in scope, and not started: Buyer Intelligence, Bot/Sybil detection, Technical
Intelligence, any trading or wallet code. The Dossier's tab registry reserves **Activity**,
**Buyers** and **Technical** as unavailable entries. They are not rendered: a tab with
nothing behind it would suggest an analysis that does not exist.

## Landing and on-demand analysis — **in review (`feature/landing-experience`)**

`/` becomes the Landing, with two paths: analyse one token (the real pipeline, on
request, with real stages) or discover live (`/discover`). See
[docs/adr/0003](docs/adr/0003-landing.md). No engine semantics change.

## Observatory — **in review (`feature/intelligence-orb`)**

The Board's visual signature: a live network sphere with the few live tokens
that matter right now tethered around it, each surfaced for a stated reason. It
reacts only to real state (scans, verdict changes, connection). No engine change.
See [docs/adr/0002](docs/adr/0002-intelligence-orb.md).

## Phase 3a — Transaction ingestion (NEXT)

Signature, slot, block time, wallet, mint, pool, base/quote amounts, direction, source.
PERSISTENCE.md §16 sketches the schema and the conventions it must carry over — raw `u64`
amounts as TEXT, chain time never conflated with ingestion time. **Not started.**

## Phase 4 — Analysis depth

Holder concentration excluding pool vaults; wallet clustering and sybil/bundler detection;
buyer quality; volume quality from organic-volume fields; momentum across 5m/1h/6h with
explicit staleness.

## Phase 5 — Scoring v2

Rebuild on Phase 1 and 4 outputs. Per-component provenance (which provider, how fresh,
confidence). Calibrate grades against recorded outcomes instead of asserting thresholds.
Regression-test against a frozen fixture corpus (Phase T4).

## Phase 6a — Technical Intelligence Engine (PLANNED, specified)

Chart structure and pattern analysis as an **independent intelligence layer** —
never merged into the Risk Score, consumed only by a future Decision Engine.

Full specification: **[TECHNICAL_INTELLIGENCE.md](TECHNICAL_INTELLIGENCE.md)**.

Why it sits here, after Persistence and after Bot/Sybil Intelligence:

- **It needs candles, which the project does not have.** DexScreener publishes no
  OHLCV endpoint; it returns aggregate `m5`/`h1`/`h6`/`h24` scalars. A new
  pool-level OHLCV provider is the largest single piece of this phase.
- **It needs vetted volume.** Volume confirmation is load-bearing for most
  patterns, and wash trading is documented above 70% of reported volume on
  unregulated venues. Confirming patterns on unvetted volume would make the
  engine actively misleading, so Bot/Sybil/Bundler Intelligence must land first.
- **It needs durable history.** Pattern lifecycles, pivot history and a backtest
  corpus do not fit a whole-file JSON store, so Persistence must land first.

**Recommended change to the sequence:** pull the **OHLCV data layer earlier**,
in parallel with Persistence rather than inside this phase. It is the most
uncertain piece of work, Momentum v2 would independently benefit from real
candles, and — decisively — the backtest corpus can only accumulate in
wall-clock time. Starting collection during Persistence means this phase begins
with history to validate against instead of a cold start.

Initial scope is deliberately small (Tier 1 in the specification): market
structure labelling, break of structure, change of character, ranges,
compression/expansion, support/resistance zones, and the breakout / retest /
reclaim / **failed-breakout** lifecycle. Classical chart patterns come later and
only for tokens old enough to have the history — at the median analysed age of
~26 hours a token has one daily candle.

Exit criterion: detection quality measured against labelled fixtures, and
forward-return behaviour measured against an unconditional baseline. **No
profitability claim without that evidence.**

## Phase 6 — Realtime ingestion

Helius websocket/gRPC for pool-init events; polled feeds become reconciliation, not the
primary path. Durable discovery queue. Tiered refresh so cost scales with interest.

## Decision engine (product Phase 3) — **DONE on `feature/decision-engine`, in review**

Deep intelligence now decides: a normalised, rule-versioned intelligence
contract; Hard Gate v2; seven-domain soft risk and integrity; opportunity kept
separate from safety; Momentum v2 from observed history; multi-pool activity
with measured market coverage; six verdicts (HIGH_POTENTIAL ... REJECTED) with
persisted, reasoned transitions; re-decision after each intelligence cycle.
No trading. Calibration of every threshold against outcomes is product
Phase 4. See [DECISION_ENGINE.md](DECISION_ENGINE.md).

## Phase 7 — Watchlist and decision engine

State machine from `ARCHITECTURE.md` Part 4. Every transition writes a reason to the audit
trail. Still no trading.

## Phase 8 — Paper trading

Position ledger, fill simulation using real pool depth (slippage and price impact), P&L
accounting, exit rules. Must run long enough to produce a usable track record.

## Phase 9 — Risk limits

Position-size limits, daily-loss limit, max concurrent positions, per-token cap, kill switch,
circuit breakers, pre-trade revalidation. **Enforced in the execution path, not the UI.**
Built and tested before any real-money path exists.

## Phase 10 — Manual confirmation trading

Key custody decision first. Execution adapter (Jupiter swap), per-trade expiry, human approval
per trade, full audit trail.

## Phase 11 — Capped auto

Only after manual-mode fills match paper expectations within a stated tolerance. Hot wallet
with strictly limited balance. Independent watchdog process.

## Phase 12 — Full auto

Only after sustained capped operation with zero safety-limit breaches. Monitored alerting and
a documented incident runbook are part of the deliverable, not follow-up work.

## Testing strategy (original proposal)

> **Status:** superseded in part. `npm test` runs 417 tests and `npm run test:ui` runs 44
> real-browser tests; see the README. The tiers below are the original plan, kept for the
> parts not yet covered.

Runner: `node --test` keeps the zero-dependency property.

**T1 — Unit and data integrity** (with Phase 1)
Normalizers against recorded real payloads; malformed input (null/missing/wrong-type/extra
fields, unicode and RTL-override characters in names and symbols, absurd decimals); numeric
helpers (`logScore`, `bandScore`, `clamp01`) at boundaries; `UNKNOWN` propagation — assert that
an absent field can never produce points.

**T2 — Extreme and adversarial values**
Zero liquidity; liquidity of 1e-9 and 1e15; zero-volume tokens; negative and `Infinity`/`NaN`
price changes; zero-supply and 1e18-supply mints; age of 0 and of 10 years; `topHoldersPercentage`
of 0, 100 and >100; malicious metadata (script payloads, 10 KB symbols, homoglyph impersonation)
asserted safe through to dashboard rendering.

**T3 — Provider behaviour**
Outage per provider (all five, individually and in combination); 429 with and without
`retry-after`; 5xx with retry exhaustion; network timeout and socket reset; truncated and
non-JSON bodies; stale data (timestamps far in past/future); provider disagreement; duplicate
discovery across feeds; assert the documented fallback chain is actually taken and that one
provider outage never silently determines a score.

**T4 — Scoring regression**
Frozen fixture corpus of real tokens with expected component values and totals. Any weight or
formula change must show an intentional, reviewed diff. Golden-file style. Include the two
defect cases from `SCORING.md` §5.1 and §5.2 as permanent regression tests.

**T5 — Pipeline and concurrency**
`pool()` when a worker throws (today this aborts the whole scan); rate limiter under burst;
cache TTL and eviction; store atomicity across a simulated crash mid-write; prune correctness;
monitor loop non-overlap.

**T6 — Trading (before Phase 8 ships)**
Paper-trading accounting: fills, partial fills, fees, slippage, P&L, reconciliation to zero.
Execution simulation against recorded pool states. Risk limits: assert each limit blocks in the
execution path, not just the UI. Emergency exit and kill switch under adverse conditions
(provider down mid-position, liquidity pulled mid-exit). Pre-trade revalidation rejecting a
stale decision.

**Continuous:** typecheck on every change; a live smoke test that hits each provider and
reports LIVE / FALLBACK / UNAVAILABLE without asserting on values that legitimately change.
