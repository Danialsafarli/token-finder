/**
 * Schema definition and versioned migrations.
 *
 * The version lives in SQLite's own `PRAGMA user_version`, not in a table of
 * our own. It is written atomically with the migration that sets it, it costs
 * no query to read, and it cannot itself be missing - a fresh database reports
 * 0, which is exactly what "no migrations applied" means.
 *
 * ## Rules every migration here obeys
 *
 * - **Ordered and append-only.** A migration's `to` version is its identity.
 *   Once a migration has shipped it is never edited, because someone's database
 *   has already run it. Schema changes are new entries.
 * - **Applied inside one transaction, with the version bump.** Either the
 *   statements and the new `user_version` both land, or neither does. There is
 *   no state where the schema is new and the version says otherwise.
 * - **No `CREATE TABLE IF NOT EXISTS` as a substitute for versioning.** That
 *   idiom silently tolerates a schema that drifted from what the code expects.
 *   Each migration states exactly what it changes.
 * - **Never destructive to history.** A future migration may add tables or
 *   columns; dropping a column that holds collected history needs a deliberate
 *   copy-forward, not a `DROP`.
 *
 * ## Why the schema looks the way it does
 *
 * **Current state is a document; history is normalized.** `tokens.payload`
 * holds the whole current `TokenSnapshot` as JSON so the existing dashboard and
 * CLI keep working untouched, and so there is exactly one answer to "what is
 * this token now". History goes into narrow typed tables that can be queried,
 * aggregated and pruned. The alternative - archiving every full snapshot -
 * turns the database into an uncontrolled provider-response dump, which
 * PERSISTENCE.md explains is a thing worth not having.
 *
 * **Raw token amounts are TEXT, never INTEGER.** A `u64` exceeds the exact
 * range of a JavaScript number, and `node:sqlite` throws `ERR_OUT_OF_RANGE`
 * when reading such a value back rather than silently rounding. BONK's supply
 * (`8799438501691764747`) is past that line today. Storing the decimal string
 * keeps it exact and matches how `OnChainInfo` already carries it.
 *
 * **Every timestamp is unix milliseconds UTC**, and the two kinds are never
 * merged: `observed_at` is when the underlying fact was true, `recorded_at` is
 * when we wrote the row. Confusing them would make any future candle or
 * latency analysis quietly wrong.
 */

import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  /** The `user_version` this migration brings the database to. */
  to: number;
  name: string;
  /** Why this migration exists, for the reader of a schema they did not write. */
  purpose: string;
  statements: string[];
}

/**
 * Migration 1 - the initial schema.
 *
 * Deliberately not normalized to academic perfection. `mint` is repeated on
 * every history table rather than joined through a surrogate key, because every
 * query this project will realistically run is "give me X for this mint over
 * time", and that shape makes those queries and their indexes obvious.
 */
const INITIAL: Migration = {
  to: 1,
  name: 'initial-schema',
  purpose: 'tokens, scans, and the four historical snapshot streams',
  statements: [
    // --- canonical token identity -----------------------------------------
    `CREATE TABLE tokens (
       mint            TEXT PRIMARY KEY,
       symbol          TEXT,
       name            TEXT,
       first_seen_at   INTEGER NOT NULL,
       last_seen_at    INTEGER NOT NULL,
       launched_at     INTEGER,
       token_program   TEXT,
       decimals        INTEGER,
       raw_supply      TEXT,
       -- The full current TokenSnapshot. This is what the dashboard reads, and
       -- it is the single source of truth for "now".
       payload         TEXT NOT NULL,
       CHECK (decimals IS NULL OR (decimals >= 0 AND decimals <= 255)),
       CHECK (last_seen_at >= 0 AND first_seen_at >= 0)
     )`,
    `CREATE INDEX idx_tokens_last_seen ON tokens(last_seen_at)`,

    // --- scan execution metadata ------------------------------------------
    `CREATE TABLE scans (
       id           INTEGER PRIMARY KEY AUTOINCREMENT,
       started_at   INTEGER NOT NULL,
       finished_at  INTEGER,
       analyzed     INTEGER NOT NULL DEFAULT 0,
       fresh        INTEGER NOT NULL DEFAULT 0,
       duration_ms  INTEGER,
       CHECK (analyzed >= 0 AND fresh >= 0),
       CHECK (finished_at IS NULL OR finished_at >= started_at)
     )`,
    `CREATE INDEX idx_scans_started ON scans(started_at)`,

    // --- token verdict history --------------------------------------------
    // `is_transition` marks a row that exists because the lifecycle state or
    // eligibility changed. Retention never deletes those: they are the spine of
    // any later question about how a token behaved over its life.
    `CREATE TABLE token_snapshots (
       id            INTEGER PRIMARY KEY AUTOINCREMENT,
       mint          TEXT NOT NULL REFERENCES tokens(mint) ON DELETE CASCADE,
       scan_id       INTEGER REFERENCES scans(id) ON DELETE SET NULL,
       observed_at   INTEGER NOT NULL,
       recorded_at   INTEGER NOT NULL,
       score         REAL NOT NULL,
       base_score    REAL,
       grade         TEXT,
       penalty       REAL,
       score_coverage REAL,
       coverage      REAL,
       confidence    REAL,
       state         TEXT,
       eligibility   TEXT,
       veto_codes    TEXT,
       is_transition INTEGER NOT NULL DEFAULT 0,
       CHECK (is_transition IN (0, 1)),
       CHECK (score >= 0 AND score <= 100),
       CHECK (coverage IS NULL OR (coverage >= 0 AND coverage <= 1)),
       CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
     )`,
    `CREATE INDEX idx_token_snapshots_mint_time ON token_snapshots(mint, observed_at)`,
    `CREATE INDEX idx_token_snapshots_transition ON token_snapshots(is_transition, observed_at)`,
    `CREATE INDEX idx_token_snapshots_scan ON token_snapshots(scan_id)`,

    // --- market history ----------------------------------------------------
    // Shaped so future OHLCV reconstruction stays possible: a price with an
    // honest observation time, per mint, ordered. It is not a candle store and
    // does not pretend to be one - see PERSISTENCE.md.
    `CREATE TABLE market_snapshots (
       id             INTEGER PRIMARY KEY AUTOINCREMENT,
       mint           TEXT NOT NULL REFERENCES tokens(mint) ON DELETE CASCADE,
       scan_id        INTEGER REFERENCES scans(id) ON DELETE SET NULL,
       observed_at    INTEGER NOT NULL,
       recorded_at    INTEGER NOT NULL,
       price_usd      REAL,
       liquidity_usd  REAL,
       volume_24h     REAL,
       market_cap     REAL,
       fdv            REAL,
       buy_ratio_24h  REAL,
       change_m5      REAL,
       change_h1      REAL,
       change_h6      REAL,
       change_h24     REAL,
       pool_address   TEXT,
       dex_id         TEXT,
       CHECK (price_usd IS NULL OR price_usd >= 0),
       CHECK (liquidity_usd IS NULL OR liquidity_usd >= 0),
       CHECK (volume_24h IS NULL OR volume_24h >= 0)
     )`,
    `CREATE INDEX idx_market_snapshots_mint_time ON market_snapshots(mint, observed_at)`,

    // --- holder distribution history ---------------------------------------
    `CREATE TABLE holder_snapshots (
       id                  INTEGER PRIMARY KEY AUTOINCREMENT,
       mint                TEXT NOT NULL REFERENCES tokens(mint) ON DELETE CASCADE,
       scan_id             INTEGER REFERENCES scans(id) ON DELETE SET NULL,
       observed_at         INTEGER NOT NULL,
       recorded_at         INTEGER NOT NULL,
       holder_count        INTEGER,
       top_holders_pct     REAL,
       largest_holder_pct  REAL,
       -- u64 decimal strings, never INTEGER. See the module note.
       raw_top10           TEXT,
       raw_supply          TEXT,
       source              TEXT,
       CHECK (holder_count IS NULL OR holder_count >= 0),
       CHECK (top_holders_pct IS NULL OR (top_holders_pct >= 0 AND top_holders_pct <= 100))
     )`,
    `CREATE INDEX idx_holder_snapshots_mint_time ON holder_snapshots(mint, observed_at)`,

    // --- pool / venue history ----------------------------------------------
    // Separate from market_snapshots because a token can trade on several
    // pools, and pool migration is itself a signal future phases will want.
    `CREATE TABLE pool_snapshots (
       id              INTEGER PRIMARY KEY AUTOINCREMENT,
       mint            TEXT NOT NULL REFERENCES tokens(mint) ON DELETE CASCADE,
       scan_id         INTEGER REFERENCES scans(id) ON DELETE SET NULL,
       observed_at     INTEGER NOT NULL,
       recorded_at     INTEGER NOT NULL,
       pool_address    TEXT NOT NULL,
       dex_id          TEXT,
       quote_symbol    TEXT,
       liquidity_usd   REAL,
       price_usd       REAL,
       pair_created_at INTEGER
     )`,
    `CREATE INDEX idx_pool_snapshots_mint_time ON pool_snapshots(mint, observed_at)`,
    `CREATE INDEX idx_pool_snapshots_pool ON pool_snapshots(pool_address, observed_at)`,

    // --- canonical evidence summary ----------------------------------------
    // Bounded by construction: one row per coverage-weighted metric per stored
    // snapshot, around a dozen. This is what answers "what did Token Finder
    // believe at time T, on whose word, and how sure was it" without archiving
    // raw provider bodies.
    `CREATE TABLE evidence_snapshots (
       id          INTEGER PRIMARY KEY AUTOINCREMENT,
       snapshot_id INTEGER NOT NULL REFERENCES token_snapshots(id) ON DELETE CASCADE,
       mint        TEXT NOT NULL,
       observed_at INTEGER NOT NULL,
       metric      TEXT NOT NULL,
       state       TEXT NOT NULL,
       -- Rendered as text so one column can hold a number, a boolean or an
       -- enum without a type discriminator per row.
       value       TEXT,
       source      TEXT,
       freshness   TEXT,
       confidence  REAL,
       CHECK (state IN ('MEASURED','UNKNOWN','CONFLICTED','INVALID','STALE','UNAVAILABLE'))
     )`,
    `CREATE INDEX idx_evidence_snapshot ON evidence_snapshots(snapshot_id)`,
    `CREATE INDEX idx_evidence_mint_metric ON evidence_snapshots(mint, metric, observed_at)`,

    // --- provider diagnostics ----------------------------------------------
    `CREATE TABLE provider_failures (
       id        INTEGER PRIMARY KEY AUTOINCREMENT,
       mint      TEXT,
       scan_id   INTEGER REFERENCES scans(id) ON DELETE SET NULL,
       at        INTEGER NOT NULL,
       provider  TEXT NOT NULL,
       kind      TEXT NOT NULL,
       message   TEXT,
       retryable INTEGER,
       CHECK (retryable IS NULL OR retryable IN (0, 1))
     )`,
    `CREATE INDEX idx_provider_failures_time ON provider_failures(at)`,
    `CREATE INDEX idx_provider_failures_provider ON provider_failures(provider, at)`,

    // --- monitor events ----------------------------------------------------
    `CREATE TABLE events (
       id      TEXT PRIMARY KEY,
       at      INTEGER NOT NULL,
       kind    TEXT NOT NULL,
       mint    TEXT,
       symbol  TEXT,
       level   TEXT,
       message TEXT,
       data    TEXT
     )`,
    `CREATE INDEX idx_events_at ON events(at)`,

    // --- key/value metadata ------------------------------------------------
    // Holds the legacy-import marker, so a JSON import can never run twice.
    `CREATE TABLE meta (
       key   TEXT PRIMARY KEY,
       value TEXT NOT NULL
     )`,
  ],
};

/**
 * Every migration, in order. Append only.
 *
 * When a future phase adds transaction ingestion, it adds a migration here
 * creating `swap_events`, `wallets` and friends - it does not edit migration 1.
 * PERSISTENCE.md sketches those tables.
 */
export const MIGRATIONS: readonly Migration[] = [INITIAL];

/** The version a fully migrated database reports. */
export const TARGET_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.to), 0);

export function currentSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

/**
 * Brings a database up to {@link TARGET_SCHEMA_VERSION}.
 *
 * Each migration runs inside its own transaction together with its version
 * bump, so an interruption leaves the database at the last version that fully
 * applied - never between two. Returns the versions actually applied, which is
 * empty when the database was already current (making this idempotent).
 *
 * `PRAGMA user_version` cannot be parameterised, so the value is interpolated.
 * It comes from this module's own integer literals and never from input.
 */
export function migrate(db: DatabaseSync): number[] {
  const applied: number[] = [];
  let version = currentSchemaVersion(db);

  for (const migration of MIGRATIONS) {
    if (migration.to <= version) continue;

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of migration.statements) db.exec(statement);
      db.exec(`PRAGMA user_version = ${Math.trunc(migration.to)}`);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // A failed rollback means the transaction was already closed; the
        // original error is the one worth reporting.
      }
      throw error;
    }

    version = migration.to;
    applied.push(migration.to);
  }

  return applied;
}
