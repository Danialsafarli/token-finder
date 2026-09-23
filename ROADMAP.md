# Roadmap

Audience: whoever plans and sequences Token Finder work.
**Nothing below is implemented. This is a proposed sequence awaiting approval.**

Ordering principle: correctness of the data model before breadth of features, and every
safety mechanism before the capability it protects.

## Phase 0 — Baseline (DONE)

Prototype: 5 discovery feeds, 7-component scoring, monitoring loop, SSE dashboard, CLI,
JSON persistence. Audited in `ARCHITECTURE.md`, `SCORING.md`, `DATA_SOURCES.md`.
Known defects listed in `ARCHITECTURE.md` Part 1.

## Phase 1 — Data integrity (blocks everything else)

1. Introduce an explicit `UNKNOWN` state through normalization, scoring and the UI. Missing
   data must never coerce to `0` or a neutral default. Removes the fabricated-points defect.
2. Schema-validate every provider response at the boundary; reject and log malformed payloads
   rather than coercing them.
3. Cross-validate providers; record disagreement as a first-class signal.
4. Consume what we already receive: `lpLockedPct`, `dev`/`devMints`/`devMigrations`,
   Jupiter organic-volume fields, `holderChange`/`liquidityChange`.
5. First test suite (Phase T1 below) — without it, nothing after this is verifiable.

Exit criterion: no score contains a point derived from absent data.

## Phase 2 — Safety gate

Hard veto rules, evaluated before scoring and able to terminate a token. Requires a Helius key
so authority state is read on-chain rather than taken on a provider's word. Unknown safety data
⇒ rejection, not a pass.

## Phase 3 — Persistence

SQLite via `node:sqlite`, WAL mode. Migrate tokens, snapshots, score history, events. Add the
append-only audit table now, before anything needs to write to it. Persistent provider cache
keyed by `(mint, provider, fetched_at)`.

## Phase 4 — Analysis depth

Holder concentration excluding pool vaults; wallet clustering and sybil/bundler detection;
buyer quality; volume quality from organic-volume fields; momentum across 5m/1h/6h with
explicit staleness.

## Phase 5 — Scoring v2

Rebuild on Phase 1 and 4 outputs. Per-component provenance (which provider, how fresh,
confidence). Calibrate grades against recorded outcomes instead of asserting thresholds.
Regression-test against a frozen fixture corpus (Phase T4).

## Phase 6 — Realtime ingestion

Helius websocket/gRPC for pool-init events; polled feeds become reconciliation, not the
primary path. Durable discovery queue. Tiered refresh so cost scales with interest.

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

## Testing strategy (PROPOSAL — currently zero tests exist)

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
