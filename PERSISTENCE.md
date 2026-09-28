# Persistence

How Token Finder stores what it observes, and why it stores it that way.

Token Finder used to keep everything in one `data/state.json`, rewritten whole
every scan. That works until you want to ask a question about the past — and
every capability on the roadmap (Buyer Intelligence, Bot/Sybil detection,
Momentum v2, Technical Intelligence) is a question about the past. This layer
exists so that history accumulates from now on, and so it can be trusted when
something reads it back.

---

## 1. Technology

**`node:sqlite`, built into Node 24. No runtime dependency was added.**

Token Finder has zero runtime dependencies, deliberately
([CLAUDE.md](CLAUDE.md)). The built-in module ships with the Node version this
project already requires, needs no flag, emits no experimental warning, and
covers what this phase needs: WAL, transactions, foreign keys, `CHECK`
constraints, prepared statements, named parameters. There was no limitation
that justified a dependency, so none was taken.

**No ORM.** The whole data layer is nine tables and a few dozen explicit
statements. Prisma or Drizzle would add a dependency, a build step and a second
schema language to keep in sync, in exchange for hiding SQL that is easier to
read than the abstraction would be.

**One sharp edge, and it shapes the schema.** `node:sqlite` throws
`ERR_OUT_OF_RANGE` when reading an `INTEGER` larger than
`Number.MAX_SAFE_INTEGER`, rather than silently rounding. That is the right
call, and it means **raw `u64` token amounts are stored as `TEXT`**. BONK's
on-chain supply is `8799438501691764747`, which is past that line today; through
`Number` it becomes `8799438501691764736`. Decimal strings keep it exact and
match how `OnChainInfo` already carries it.

---

## 2. Shape

```
  monitor / server / cli
        |   store.*                  the only surface they know about
        v
  src/core/store.ts                  compatibility layer + read cache
        v
  src/persist/repository.ts          domain operations
        v
  node:sqlite
```

**No SQL appears outside `src/persist/`.** Core logic calls
`saveTokenSnapshot`, `getTokenHistory`, `recordScan` — never a query. The schema
can change without the scanner knowing, and every write to the database is in
one directory.

`store.ts` keeps the exact public API it had as a JSON store, so the dashboard,
CLI and monitor were not rewritten for this change.

**Current state is cached; history is not.** `tokens()` is called on every
dashboard request, so current snapshots live in a write-through map: SQLite is
the source of truth and is what a restart reads, memory is a read cache updated
on the same call that writes the row. History is always queried — it is large,
append-only and read rarely.

---

## 3. Location

```
<TOKEN_FINDER_DATA_DIR>/token-finder.sqlite
```

Default `data/`, already overridable by `TOKEN_FINDER_DATA_DIR`, so tests and
smoke runs get an isolated database for free. `TOKEN_FINDER_DB_FILE` changes the
filename only: path separators, `..`, drive prefixes and bare `.` are rejected
in favour of the default, because allowing a path would let an environment
variable point the database at a tracked source file and have the app overwrite
it on first run.

`data/*.sqlite` and `data/*.sqlite-*` are gitignored, covering the WAL and
shared-memory sidecars.

---

## 4. Schema versioning

The version lives in SQLite's own `PRAGMA user_version`. It is written
atomically with the migration that sets it, costs no query to read, and cannot
itself be missing — a fresh database reports `0`, which is exactly what "no
migrations applied" means.

Rules every migration obeys:

- **Ordered and append-only.** A migration's target version is its identity.
  Once shipped it is never edited, because someone's database has already run
  it. Schema changes are new entries.
- **Applied inside one transaction, together with the version bump.** Either the
  statements and the new version both land or neither does. There is no state
  where the schema is new and the version disagrees.
- **No `CREATE TABLE IF NOT EXISTS` as a substitute for versioning.** That idiom
  silently tolerates a schema that drifted from what the code expects.
- **Never destructive to history.** Adding tables and columns is routine;
  removing a column that holds collected history needs a deliberate
  copy-forward, not a `DROP`.

Interrupting a migration leaves the database at the last version that fully
applied — never between two.

---

## 5. Tables

| Table | Holds |
|---|---|
| `tokens` | canonical identity, mint metadata, and the **full current snapshot** as JSON |
| `scans` | one row per scan: start, finish, analysed and fresh counts, duration |
| `token_snapshots` | verdict history — score, coverage, confidence, state, eligibility, veto codes |
| `market_snapshots` | price, liquidity, volume, market cap, FDV, buy ratio, timeframe changes, pool |
| `holder_snapshots` | holder count, top-holder concentration, raw `u64` amounts as TEXT |
| `pool_snapshots` | pool address, venue, quote, liquidity, price, pair creation |
| `evidence_snapshots` | per-metric canonical evidence: state, value, source, freshness, confidence |
| `provider_failures` | which provider failed, when, why, whether retryable |
| `events` | monitor notification feed |
| `meta` | key/value, including the legacy-import marker |

Migration 2 added the data backbone's tables ([DATA_BACKBONE.md](DATA_BACKBONE.md) §6).
Migration 3 added deep intelligence's: `wallet_profiles`, `wallet_trades`,
`funding_edges`, `address_stats`, `wallet_edges`, `wallet_clusters`,
`cluster_members`, `launch_attributions`, `security_events`,
`creator_profiles` and `token_intelligence`, plus nullable columns on
`pool_activity` and `holder_snapshots`. Writers, readers, indexes and
retention for each are in [DEEP_INTELLIGENCE.md](DEEP_INTELLIGENCE.md) §13.

**Current state is a document; history is normalized.** `tokens.payload` holds
the whole current `TokenSnapshot` as JSON so the existing dashboard works
untouched and there is exactly one answer to "what is this token now". History
goes into narrow typed tables that can be queried, aggregated and pruned. The
alternative — archiving every full snapshot — turns the database into an
uncontrolled provider-response dump.

The schema is **not normalized to academic perfection**. `mint` repeats on every
history table rather than joining through a surrogate key, because every query
this project will realistically run is "give me X for this mint over time", and
that shape makes those queries and their indexes obvious.

### Evidence storage

`evidence_snapshots` holds one row per coverage-weighted metric per stored
snapshot, around a dozen. It answers *what did Token Finder believe at time T,
on whose word, and how fresh was it* without archiving raw provider bodies.
Raw provider JSON is deliberately **not** persisted. It turned out to be the
largest table by far (measured in Phase 4: ~33 MB a day with its index), so
it has its own, shorter retention for ordinary snapshots (§13).

### Constraints

Type checking stops at the process boundary, so the schema enforces its own
rules: `NOT NULL` on identity and timestamps, `CHECK` on score (0–100), coverage
and confidence (0–1), decimals (0–255, the `u8` range), non-negative money and
counts, the evidence-state enum, and `FOREIGN KEY ... ON DELETE CASCADE` from
every history table to `tokens`.

### Indexes

Added for queries that exist, not speculatively:
`(mint, observed_at)` on each history table, `(is_transition, observed_at)` for
the transitions feed, `scan_id` for grouping a batch, `(pool_address,
observed_at)` for pool history, `(provider, at)` for diagnostics, plus
`last_seen_at` on tokens for retention.

---

## 6. Time

Every timestamp is **unix milliseconds, UTC**. Two kinds are kept apart and
never merged:

- **`observed_at`** — when the underlying fact was true.
- **`recorded_at`** — when we wrote the row.

Confusing them would make any future candle or latency analysis quietly wrong.
Verdict and market rows written from one snapshot share an `observed_at` by
construction, which is what makes the history join exact.

---

## 7. What gets stored, and when

A scanner running every two minutes would otherwise write ~700 near-identical
rows per token per day. Four rules decide, in priority order:

1. **First sighting** — always stored.
2. **State transition** — lifecycle state or eligibility changed. Always stored,
   flagged `is_transition`, and **never deleted by retention**.
   `WATCH → QUALIFIED` is the kind of fact this layer exists to keep.
3. **Material change** — score moved ≥ 1 point, coverage ≥ 0.05, or price,
   liquidity or volume ≥ 2% relative. Liquidity arriving from zero is always
   material: that is a change of kind, not of degree.
4. **Heartbeat** — nothing changed, but the last row is ≥ 30 minutes old.
   Without this, "no rows for six hours" could mean *stable* or *not scanned*,
   and those are different facts.

Anything else is suppressed. **Suppression drops a duplicate, never a change.**
Two observations sharing `(mint, observed_at)` are also treated as one, so the
history join can never produce a cartesian pair.

All thresholds are configurable (`SNAPSHOT_*` in `.env.example`).

---

## 8. Atomicity

One snapshot writes its verdict, market, holder, pool and provider-failure rows
in **one transaction**. They describe a single moment; half of them landing
would be a record of a moment that never existed. A constraint violation rolls
back the whole thing, including the `tokens` upsert.

Transactions are deliberately short — one token, not one scan. A scan-long
transaction would block the dashboard's readers for its whole duration and lose
the entire batch to one bad row.

`BEGIN IMMEDIATE` takes the write lock up front, converting a possible
mid-transaction `SQLITE_BUSY` into a wait at the start that the busy timeout
absorbs.

---

## 9. SQLite configuration

| Pragma | Value | Why |
|---|---|---|
| `journal_mode` | `WAL` | Readers do not block the writer and vice versa. The dashboard polls while the monitor scans — that is exactly this project's contention. Persists in the file. |
| `synchronous` | `NORMAL` | The documented safe pairing with WAL. A power loss can cost the last transactions, not the database; the data is re-derivable by scanning again, and a scan happens every two minutes. `FULL` would fsync every commit for durability this workload does not need. |
| `foreign_keys` | `ON` | Off by default in SQLite, and the schema leans on `ON DELETE CASCADE` so retention cannot orphan history. |
| `busy_timeout` | `5000` | A second process (a CLI command against a live server's data directory) should wait for a lock, not fail instantly. Far longer than any transaction here. |

---

## 10. Concurrency

`node:sqlite` is synchronous, and Node runs one thread, so writes within a
process serialise naturally — there is no write queue to get wrong. Analysis
concurrency (`poolSettled`, 4 at a time) is all *network* work; persistence
happens after, on the main thread, in short transactions.

Across processes, WAL plus the busy timeout handles it: a second connection
reads committed data immediately and waits briefly for the write lock. This is
tested with two live connections to one file.

---

## 11. Legacy JSON migration

`data/state.json` held real collected history that exists nowhere else, so the
importer is paranoid rather than convenient:

- **The JSON is never modified or deleted.** It is copied to
  `state.pre-sqlite-import-<timestamp>.json` before anything is written, and
  left in place afterwards.
- **One transaction.** Either every row lands or none does.
- **It runs at most once.** A marker in `meta` records completion, so restarting
  cannot double every history point. A missing `state.json` is *also* recorded
  as done, so a file restored later cannot be imported into an already-populated
  database.
- **Malformed input fails loudly and changes nothing.** Unreadable JSON, or JSON
  without a `tokens` object, returns a failure and leaves an empty database
  empty — and leaves no marker, so a corrected file can still be imported.
- **Rows that cannot be represented are counted, not dropped quietly.** The
  result carries `skippedTokens` with reasons. A partial import always says so.
- **Nothing is fabricated.** v1 snapshots have no `evaluation`, so imported
  history has `state`, `eligibility`, `coverage` and `confidence` as `NULL` —
  which reads as *not recorded*, because it was not. No transitions are invented
  either. The last known scan time becomes one scan row; the earlier scans were
  never individually recorded by the JSON store and are not conjured.

Measured on the real corpus: **2,104 tokens, 16,366 history points, 500 events
in ~2 seconds**, producing a 14.2 MB database from an 8.6 MB JSON file.

Re-importing deliberately requires clearing the `legacy_import.completed_at` key
from `meta` — or passing `force`, which only the tests do.

---

## 12. Rollback and failure

| Situation | Behaviour |
|---|---|
| **Database cannot be opened** | `DB_UNAVAILABLE`. The scanner keeps analysing, logs once, and records nothing. `store.persistenceFailure()` exposes the reason so a status view can say history is not being written rather than showing an empty chart. |
| **File is not a database** | `CORRUPT_DB`, non-retryable. The file is **left exactly as it is** — recreating it would destroy whatever was there. Needs a person. |
| **Migration fails** | `MIGRATION_FAILED`. The database stays at its last fully-applied version. |
| **A write fails** | `WRITE_FAILED`, returned as a value, not thrown. One lost snapshot never ends a scan. |
| **A read fails** | `READ_FAILED`. Reads degrade to empty; callers distinguish that from real emptiness via `persistenceFailure()`. |
| **Import fails** | `IMPORT_FAILED`. Rolled back, JSON untouched, no marker. |

Backups are **never deleted automatically** — not the pre-import copy, not the
older `state.v*.backup-*.json` files.

Diagnostics: `node src/cli.ts db` reports path, size (including WAL), schema
version, integrity, row counts, oldest/newest snapshot, transition count and
import status.

---

## 13. Retention

Storage is cheap and destroyed history is gone, so the defaults are
conservative and the rules are stated in one place.

| Data | Default | Configurable |
|---|---|---|
| Non-transition snapshot history | 90 days | `RETENTION_HISTORY_DAYS` |
| Per-metric evidence of non-transition snapshots | 14 days | `RETENTION_EVIDENCE_DAYS` |
| Evidence behind a verdict transition | as long as the transition | - |
| Token unseen before it is dropped | 180 days | `RETENTION_TOKEN_DAYS` |
| Provider-failure diagnostics | 14 days | `RETENTION_DIAGNOSTICS_DAYS` |
| Monitor events | 500 newest | `MAX_EVENTS` |
| Chain history and behavioural readings (pool activity, wallet trades, profiles, edges, clusters, probes, token intelligence) | 30 days | `RETENTION_CHAIN_DAYS` |
| Attribution, funding, creator profiles, unconfirmed security events | as tokens: 180 days | `RETENTION_TOKEN_DAYS` |
| **CONFIRMED security events** | never pruned | — |

- **State transitions are never deleted**, whatever their age.
- **Deletion is by age, not by count.** A row cap would discard a busy token's
  recent history to make room for a quiet one's.
- A token is only dropped after going cold for twice the history window, and its
  history cascades with it.
- Retention runs as one transaction, so a partial sweep cannot leave market
  history for a token whose verdict history was already deleted.
- **Retention is independent of the live ranking.** Leaving the live Board
  (`LIVE_WINDOW_MIN`, 90 minutes by default) is a display decision and deletes
  nothing. Earlier code passed twice the ranking's `MAX_AGE_HOURS` into `prune`,
  where it could raise the token retention period. At the defaults it had no
  effect (14 days against 180), but it meant a display setting could quietly
  change a deletion policy.
  `store.prune()` now takes no argument, and only the table above decides what
  is deleted. See [PIPELINE.md §6](PIPELINE.md#the-live-universe).

**Measured (Phase 4, the 409 MB development database):** growth ~67 MB a day,
half of it evidence. With the evidence rule a sweep costs 161 ms in steady
state; the first sweep after 14 days removes ~417k rows in 3.3 s, keeping the
evidence of every transition. Expected steady state at the defaults: 3-4 GB
(DEPLOYMENT.md §3).

**Not yet done:** downsampling old high-frequency history into lower resolution.
It is lossy, easy to get subtly wrong, and there is no accumulated history to
tune it against. Recorded here as the obvious next step.

---

## 14. Performance

Measured on the development machine, 100 tokens, Node 24:

| Operation | Time |
|---|---|
| Persist a 100-token scan (100 upserts + history) | **~45 ms** |
| Read all 100 current tokens | **< 1 ms** (cached) |
| History query for one mint | **~0.3 ms** |
| Query a 400-snapshot history | **~1–4 ms** |
| Import 2,104 tokens / 16,366 points from JSON | **~2 s** |

A scan's network phase takes tens of seconds, so persistence is roughly three
orders of magnitude from being the bottleneck.

**Where the next bottleneck is.** The write-through token cache holds every
current snapshot in memory; at ~4 KB of JSON each, 10,000 tokens is ~40 MB and
`tokens()` copies the array per call. That is the first thing to change at that
scale — probably a paged query with the cache reduced to a hot subset.

---

## 15. `state.json` is now legacy input only

**Decided explicitly:** after a successful import, **SQLite is the canonical
store**. `state.json` is read once, for the import, and **never written again**.
The file and its backups stay on disk untouched; deleting them is a human
decision.

There is no fallback path back to JSON, deliberately. Two writable sources of
truth is how they diverge.

---

## 16. Extending this

### Transaction ingestion — implemented as migration 2

**Done, in [DATA_BACKBONE.md](DATA_BACKBONE.md) §6.** The sketch below was the
plan; what shipped differs in one deliberate way: instead of a `swap_events`
table holding only resolved trades, `pool_activity` holds one row per
(transaction, pool, mint) *including* the readings that are not trades
(UNRESOLVED, NO_POOL_ACTIVITY, liquidity), because dropping those would make
the resolved ones look like all the pool's traffic. The conventions below were
kept. The original sketch, for reference:

```sql
CREATE TABLE swap_events (
  signature    TEXT NOT NULL,       -- with slot, the natural key
  slot         INTEGER NOT NULL,
  block_time   INTEGER,             -- chain time; NULL when unavailable
  ingested_at  INTEGER NOT NULL,    -- our time: never conflated with the above
  wallet       TEXT NOT NULL,
  mint         TEXT NOT NULL REFERENCES tokens(mint) ON DELETE CASCADE,
  pool_address TEXT,
  base_amount  TEXT NOT NULL,       -- raw u64 as decimal string, as everywhere
  quote_amount TEXT NOT NULL,
  direction    TEXT NOT NULL CHECK (direction IN ('BUY','SELL')),
  source       TEXT NOT NULL,       -- which provider or RPC supplied it
  PRIMARY KEY (signature, mint, wallet, direction)
);
CREATE INDEX idx_swap_mint_time ON swap_events(mint, block_time);
CREATE INDEX idx_swap_wallet ON swap_events(wallet, block_time);
```

The conventions that must carry over: raw amounts as TEXT, `block_time` and
`ingested_at` kept separate, `source` recorded, and the mint foreign key so
retention cascades.

### Deep intelligence — implemented as migration 3

**Done, in [DEEP_INTELLIGENCE.md](DEEP_INTELLIGENCE.md) §13.** Every table it
added is written by the intelligence cycle and read by a named consumer; none
was created ahead of its writer. Two retention choices are deliberate: a
CONFIRMED security event is never pruned, because a creator's history rests on
it and it cannot be re-derived once its transactions age out; and a stored
event's status can rise on re-detection but never fall, because a later,
more truncated read can miss the fact - **under the same rule**. Since
migration 4 a newer rule's reading wins (see below).

### Decision engine — implemented as migration 4

**Done, in [DECISION_ENGINE.md](DECISION_ENGINE.md) §10.** Additive only:

- `security_events` gains `rule_version`, `superseded_at`, `superseded_by`.
  Existing rows get NULL: unversioned, which the decision layer treats as
  superseded - kept and shown, never counted.
- `security_event_revisions` holds every earlier reading of an event before it
  was reinterpreted or superseded. Pruned with tokens (`RETENTION_TOKEN_DAYS`).
- `token_intelligence.rule_versions` records the rule set of each snapshot.
- `token_snapshots` gains `policy_version`, `rank_score`, `integrity_score`,
  `integrity_band`, `opportunity_score`, `momentum_state`,
  `decision_coverage`, so policies can be compared without parsing payloads.
- `verdict_transitions`: one row per material verdict change with from, to,
  basis, reasons, components, hard fails, policy and models. Like snapshot
  transitions it is never pruned by age; it cascades only with its token.

A verdict re-decided after an intelligence cycle, with no new market
observation, replaces the current row and appends history **only** when the
verdict changed - dated when it was decided, with no market, holder or pool
row, because none was observed.

### Technical Intelligence

`market_snapshots` is shaped so OHLCV reconstruction stays possible: a price
with an honest observation time, per mint, ordered, with the pool it came from.
It is **not** a candle store and does not pretend to be one — the sampling is
scan-driven and irregular, so any future aggregation must resample explicitly
rather than assume fixed intervals. Deduplication is what to watch: suppressed
duplicates mean a flat period has few rows, which is correct for storage and
must be interpolated deliberately, not accidentally.

---

## 17. Security

- Provider credentials are **redacted before anything is written**
  (`src/util/redact.ts`). Two layers: every configured secret is masked wherever
  it appears, and secret-shaped query parameters (`api-key`, `token`, `secret`,
  …) are masked in any URL — which covers a provider added later whose key never
  passes through `config`.
- This matters because some provider URLs carry the credential in the query
  string (Helius takes `?api-key=`), and an undici error reads
  `request to <url> failed`. That text reaches `provider_failures` **and** the
  `tokens.payload` JSON, so the payload is redacted as a whole.
- **Every free-text column** goes through redaction, not just the payload: the
  provider-failure message, both token identity columns, an event's message,
  symbol and data, and rendered evidence values. None of those is reachable
  with a credential today - token names come from providers, event messages are
  built from symbols and scores - but the guarantee is that no column *can*
  carry one, not that none currently does.
- Raw headers are never stored. Raw provider bodies are never stored. Birdeye
  and TypeSafe pass their keys in headers rather than URLs, and headers are
  never logged or persisted.
- Two tests pin this: one plants credential-shaped URL parameters in every sink
  in-process, and one runs a child process with `HELIUS_API_KEY` actually
  configured and asserts the key is absent from the database file, checked as
  bytes rather than through a query. Both were verified to fail when the
  redaction is removed.
- The database path cannot be steered into a tracked source directory (§3).
