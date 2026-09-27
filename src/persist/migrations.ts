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
 * Migration 2 - the data backbone.
 *
 * Chain facts and their provenance. Every table here has a writer in
 * `src/ingest/` and a reader (a query in `chain-repository.ts` that a runtime
 * surface or the next phase consumes), a retention rule in `retention.ts`,
 * and only the indexes its queries use. See DATA_BACKBONE.md.
 *
 * Conventions carried from migration 1: raw amounts are TEXT, chain time
 * (`block_time`) and our time (`recorded_at`) are separate columns, every row
 * names its `source`, and anything interpreted says so (`derived`,
 * `confidence`, or a resolution column) rather than looking like a raw fact.
 */
const DATA_BACKBONE: Migration = {
  to: 2,
  name: 'data-backbone',
  purpose: 'discovery provenance, on-chain launches, pool activity, transfers, wallets, ingestion cursors and gaps',
  statements: [
    // --- discovery provenance ----------------------------------------------
    // First and latest sighting of a mint per source. The canonical identity
    // is the mint; this records who surfaced it and when, which is also how
    // chain-first and aggregator-first discovery can be compared.
    `CREATE TABLE token_discoveries (
       mint           TEXT NOT NULL,
       source         TEXT NOT NULL,
       first_seen_at  INTEGER NOT NULL,
       last_seen_at   INTEGER NOT NULL,
       times_seen     INTEGER NOT NULL DEFAULT 1,
       PRIMARY KEY (mint, source),
       CHECK (last_seen_at >= first_seen_at AND times_seen >= 1)
     )`,
    `CREATE INDEX idx_token_discoveries_seen ON token_discoveries(last_seen_at)`,

    // --- launches read from the chain ---------------------------------------
    // No foreign key to tokens: a launch is recorded before, and usually
    // without, the token ever being analysed.
    `CREATE TABLE token_launches (
       mint                   TEXT PRIMARY KEY,
       venue                  TEXT NOT NULL,
       signature              TEXT NOT NULL UNIQUE,
       slot                   INTEGER NOT NULL,
       block_time             INTEGER,
       fee_payer              TEXT NOT NULL,
       token_program          TEXT NOT NULL,
       decimals               INTEGER,
       initial_supply         TEXT,
       pool                   TEXT,
       pool_confirmed         INTEGER NOT NULL,
       fee_payer_initial_balance TEXT,
       mint_authority_revoked INTEGER NOT NULL,
       source                 TEXT NOT NULL,
       recorded_at            INTEGER NOT NULL,
       CHECK (pool_confirmed IN (0, 1) AND mint_authority_revoked IN (0, 1))
     )`,
    `CREATE INDEX idx_token_launches_time ON token_launches(block_time)`,
    `CREATE INDEX idx_token_launches_fee_payer ON token_launches(fee_payer, block_time)`,

    // --- the fetch ledger ---------------------------------------------------
    // Every transaction fetched, so none is fetched twice and every derived
    // row can be traced to one.
    `CREATE TABLE chain_transactions (
       signature    TEXT PRIMARY KEY,
       slot         INTEGER NOT NULL,
       tx_index     INTEGER,
       block_time   INTEGER,
       fee_payer    TEXT NOT NULL,
       status       TEXT NOT NULL,
       error        TEXT,
       fee_lamports TEXT,
       version      TEXT,
       source       TEXT NOT NULL,
       commitment   TEXT NOT NULL,
       recorded_at  INTEGER NOT NULL,
       CHECK (status IN ('SUCCESS','FAILED'))
     )`,
    `CREATE INDEX idx_chain_transactions_recorded ON chain_transactions(recorded_at)`,

    // --- what each transaction did to a tracked pool ------------------------
    // One row per (transaction, pool, mint), including the ones that are not
    // trades: an UNRESOLVED or FAILED row is a fact about the pool's traffic,
    // and dropping it would make the resolved ones look like all there was.
    `CREATE TABLE pool_activity (
       signature          TEXT NOT NULL,
       pool               TEXT NOT NULL,
       mint               TEXT NOT NULL REFERENCES tokens(mint) ON DELETE CASCADE,
       slot               INTEGER NOT NULL,
       tx_index           INTEGER,
       block_time         INTEGER,
       kind               TEXT NOT NULL,
       reason             TEXT,
       direction          TEXT,
       trader             TEXT,
       trader_resolution  TEXT,
       fee_payer          TEXT NOT NULL,
       token_amount       TEXT,
       token_decimals     INTEGER,
       quote_mint         TEXT,
       quote_amount       TEXT,
       quote_decimals     INTEGER,
       price_in_quote     REAL,
       pool_side_inferred INTEGER NOT NULL DEFAULT 0,
       confidence         REAL NOT NULL,
       source             TEXT NOT NULL,
       recorded_at        INTEGER NOT NULL,
       PRIMARY KEY (signature, pool, mint),
       CHECK (kind IN ('SWAP','LIQUIDITY_ADDED','LIQUIDITY_REMOVED','UNRESOLVED','NO_POOL_ACTIVITY','FAILED')),
       CHECK (direction IS NULL OR direction IN ('BUY','SELL')),
       CHECK (confidence >= 0 AND confidence <= 1),
       CHECK (pool_side_inferred IN (0, 1))
     )`,
    `CREATE INDEX idx_pool_activity_mint_time ON pool_activity(mint, block_time)`,
    `CREATE INDEX idx_pool_activity_trader ON pool_activity(trader, block_time)`,

    // --- transfer edges ------------------------------------------------------
    // Raw movements between owners, for the wallet graph. Bounded at write
    // time: token transfers of a tracked mint between two non-pool owners, and
    // SOL transfers between two keypair accounts above a floor. The trade leg
    // itself is already in pool_activity and is not repeated here.
    `CREATE TABLE transfer_edges (
       id           TEXT PRIMARY KEY,
       signature    TEXT NOT NULL,
       path         TEXT NOT NULL,
       slot         INTEGER NOT NULL,
       block_time   INTEGER,
       kind         TEXT NOT NULL,
       asset        TEXT NOT NULL,
       from_owner   TEXT NOT NULL,
       to_owner     TEXT NOT NULL,
       amount       TEXT NOT NULL,
       source       TEXT NOT NULL,
       recorded_at  INTEGER NOT NULL,
       CHECK (kind IN ('TOKEN_TRANSFER','SOL_TRANSFER'))
     )`,
    `CREATE INDEX idx_transfer_edges_from ON transfer_edges(from_owner, block_time)`,
    `CREATE INDEX idx_transfer_edges_to ON transfer_edges(to_owner, block_time)`,

    // --- wallets and their arrival ----------------------------------------------
    // "Observed" throughout: the first time Token Finder saw the wallet, which
    // is not the wallet's first transaction on Solana.
    `CREATE TABLE wallets (
       address            TEXT PRIMARY KEY,
       on_curve           INTEGER,
       first_observed_at  INTEGER NOT NULL,
       first_signature    TEXT NOT NULL,
       last_observed_at   INTEGER NOT NULL,
       CHECK (on_curve IS NULL OR on_curve IN (0, 1))
     )`,
    `CREATE INDEX idx_wallets_last ON wallets(last_observed_at)`,
    `CREATE TABLE wallet_token_activity (
       wallet             TEXT NOT NULL,
       mint               TEXT NOT NULL REFERENCES tokens(mint) ON DELETE CASCADE,
       first_observed_at  INTEGER NOT NULL,
       first_signature    TEXT NOT NULL,
       first_slot         INTEGER NOT NULL,
       last_observed_at   INTEGER NOT NULL,
       buys               INTEGER NOT NULL DEFAULT 0,
       sells              INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (wallet, mint),
       CHECK (buys >= 0 AND sells >= 0)
     )`,
    `CREATE INDEX idx_wallet_token_activity_arrival ON wallet_token_activity(mint, first_slot)`,

    // --- low-volume chain events ---------------------------------------------
    `CREATE TABLE chain_events (
       id          TEXT PRIMARY KEY,
       type        TEXT NOT NULL,
       mint        TEXT,
       signature   TEXT NOT NULL,
       slot        INTEGER NOT NULL,
       block_time  INTEGER,
       pool        TEXT,
       actor       TEXT,
       amount      TEXT,
       detail      TEXT,
       derived     INTEGER NOT NULL,
       confidence  REAL NOT NULL,
       source      TEXT NOT NULL,
       recorded_at INTEGER NOT NULL,
       CHECK (type IN ('POOL_CREATED','TOKEN_MINT','AUTHORITY_CHANGE')),
       CHECK (derived IN (0, 1) AND confidence >= 0 AND confidence <= 1)
     )`,
    `CREATE INDEX idx_chain_events_mint ON chain_events(mint, slot)`,

    // --- ingestion state -------------------------------------------------------
    // A cursor per collected address, so a restart resumes where it stopped,
    // and a gap row for every stretch that was seen but not collected - the
    // honest alternative to history that silently has holes.
    `CREATE TABLE ingest_cursors (
       key         TEXT PRIMARY KEY,
       signature   TEXT NOT NULL,
       slot        INTEGER NOT NULL,
       updated_at  INTEGER NOT NULL
     )`,
    `CREATE TABLE ingest_gaps (
       id           INTEGER PRIMARY KEY AUTOINCREMENT,
       key          TEXT NOT NULL,
       from_slot    INTEGER,
       to_slot      INTEGER,
       skipped      INTEGER,
       reason       TEXT NOT NULL,
       recorded_at  INTEGER NOT NULL
     )`,
    `CREATE INDEX idx_ingest_gaps_recorded ON ingest_gaps(recorded_at)`,
  ],
};

/**
 * Migration 3 - deep intelligence.
 *
 * What the actor analysis produces, and nothing it does not: wallet profiles
 * and the trades they rest on, funding observations with their
 * classification, relationship edges, clusters, launch attribution, security
 * events, creator profiles and per-token intelligence snapshots. Readers are
 * in `intel-repository.ts`; retention in `retention.ts` - confirmed security
 * events are never pruned. See DEEP_INTELLIGENCE.md.
 */
const DEEP_INTELLIGENCE: Migration = {
  to: 3,
  name: 'deep-intelligence',
  purpose: 'wallet profiles, funding, relationships, clusters, attribution, security events, creator profiles, token intelligence',
  statements: [
    // Liquidity attribution and reserve share, read by security detection.
    `ALTER TABLE pool_activity ADD COLUMN liquidity_actor TEXT`,
    `ALTER TABLE pool_activity ADD COLUMN reserve_fraction REAL`,
    // Role-aware concentration, beside the raw figure it never replaces.
    `ALTER TABLE holder_snapshots ADD COLUMN wallet_top10_pct REAL`,
    `ALTER TABLE holder_snapshots ADD COLUMN role_breakdown TEXT`,

    `CREATE TABLE wallet_profiles (
       wallet            TEXT PRIMARY KEY,
       analyzed_at       INTEGER NOT NULL,
       window_from       INTEGER,
       window_to         INTEGER,
       transactions      INTEGER NOT NULL,
       history_complete  INTEGER NOT NULL,
       first_seen_at     INTEGER,
       on_curve          INTEGER,
       features          TEXT NOT NULL,
       classification    TEXT NOT NULL,
       confidence        REAL NOT NULL,
       signals           TEXT NOT NULL,
       counter_signals   TEXT NOT NULL,
       coverage          REAL NOT NULL,
       truncation        TEXT,
       source            TEXT NOT NULL,
       CHECK (classification IN ('LIKELY_ORGANIC','AUTOMATED_TRADER','SNIPER','HIGH_FREQUENCY_TRADER','UNKNOWN','INSUFFICIENT_DATA')),
       CHECK (confidence >= 0 AND confidence <= 1 AND coverage >= 0 AND coverage <= 1)
     )`,
    `CREATE INDEX idx_wallet_profiles_analyzed ON wallet_profiles(analyzed_at)`,

    `CREATE TABLE wallet_trades (
       wallet          TEXT NOT NULL,
       signature       TEXT NOT NULL,
       mint            TEXT NOT NULL,
       direction       TEXT NOT NULL,
       token_amount    TEXT NOT NULL,
       token_decimals  INTEGER,
       quote_mint      TEXT,
       quote_amount    TEXT,
       quote_decimals  INTEGER,
       slot            INTEGER NOT NULL,
       tx_index        INTEGER,
       block_time      INTEGER,
       wallet_paid_fee INTEGER NOT NULL,
       source          TEXT NOT NULL,
       recorded_at     INTEGER NOT NULL,
       PRIMARY KEY (wallet, signature, mint),
       CHECK (direction IN ('BUY','SELL'))
     )`,
    `CREATE INDEX idx_wallet_trades_mint ON wallet_trades(mint, slot)`,

    `CREATE TABLE funding_edges (
       wallet            TEXT NOT NULL,
       funder            TEXT NOT NULL,
       signature         TEXT NOT NULL,
       lamports          TEXT NOT NULL,
       slot              INTEGER NOT NULL,
       block_time        INTEGER,
       first_inbound     INTEGER NOT NULL,
       history_from_start INTEGER NOT NULL,
       classification    TEXT NOT NULL,
       confidence        REAL NOT NULL,
       reasons           TEXT NOT NULL,
       source            TEXT NOT NULL,
       recorded_at       INTEGER NOT NULL,
       PRIMARY KEY (wallet, funder, signature),
       CHECK (classification IN ('DIRECT','LIKELY','INFRASTRUCTURE','UNKNOWN'))
     )`,
    `CREATE INDEX idx_funding_edges_funder ON funding_edges(funder)`,

    `CREATE TABLE address_stats (
       address         TEXT PRIMARY KEY,
       on_curve        INTEGER,
       recent_tx_count INTEGER,
       window_ms       INTEGER,
       checked_at      INTEGER NOT NULL
     )`,

    `CREATE TABLE wallet_edges (
       id          TEXT PRIMARY KEY,
       type        TEXT NOT NULL,
       a           TEXT NOT NULL,
       b           TEXT NOT NULL,
       directed    INTEGER NOT NULL,
       confidence  REAL NOT NULL,
       count       INTEGER NOT NULL,
       first_at    INTEGER,
       last_at     INTEGER,
       evidence    TEXT NOT NULL,
       detail      TEXT NOT NULL,
       updated_at  INTEGER NOT NULL,
       CHECK (type IN ('FUNDED','SHARED_FUNDER','TOKEN_TRANSFER','COORDINATED_ENTRY','REPEATED_ORDER_SIZE','SAME_LAUNCH_PARTICIPATION','CREATOR_ASSOCIATION'))
     )`,
    `CREATE INDEX idx_wallet_edges_a ON wallet_edges(a)`,
    `CREATE INDEX idx_wallet_edges_b ON wallet_edges(b)`,

    `CREATE TABLE wallet_clusters (
       id          TEXT PRIMARY KEY,
       level       TEXT NOT NULL,
       size        INTEGER NOT NULL,
       confidence  REAL NOT NULL,
       signals     TEXT NOT NULL,
       reasons     TEXT NOT NULL,
       updated_at  INTEGER NOT NULL,
       CHECK (level IN ('CONFIRMED_RELATIONSHIP','STRONG_CANDIDATE'))
     )`,
    `CREATE TABLE cluster_members (
       cluster_id  TEXT NOT NULL REFERENCES wallet_clusters(id) ON DELETE CASCADE,
       wallet      TEXT NOT NULL,
       PRIMARY KEY (cluster_id, wallet)
     )`,
    `CREATE INDEX idx_cluster_members_wallet ON cluster_members(wallet)`,

    `CREATE TABLE launch_attributions (
       mint                TEXT PRIMARY KEY,
       status              TEXT NOT NULL,
       creator             TEXT,
       confidence          REAL NOT NULL,
       basis               TEXT NOT NULL,
       fee_payer           TEXT,
       deployers           TEXT NOT NULL,
       mint_authority      TEXT,
       mint_authority_role TEXT,
       freeze_authority    TEXT,
       liquidity_creator   TEXT,
       initial_funder      TEXT,
       signature           TEXT,
       attributed_at       INTEGER NOT NULL,
       CHECK (status IN ('ATTRIBUTED','AMBIGUOUS','UNKNOWN'))
     )`,
    `CREATE INDEX idx_launch_attributions_creator ON launch_attributions(creator)`,

    `CREATE TABLE security_events (
       id             TEXT PRIMARY KEY,
       mint           TEXT NOT NULL,
       type           TEXT NOT NULL,
       status         TEXT NOT NULL,
       actor          TEXT,
       creator_linked INTEGER NOT NULL,
       signature      TEXT NOT NULL,
       slot           INTEGER NOT NULL,
       block_time     INTEGER,
       amount         TEXT,
       reasons        TEXT NOT NULL,
       evidence       TEXT NOT NULL,
       confidence     REAL NOT NULL,
       detected_at    INTEGER NOT NULL,
       CHECK (status IN ('CONFIRMED','STRONGLY_SUSPECTED','SUSPICIOUS','UNKNOWN')),
       CHECK (type IN ('SUPPLY_EXPANSION','AUTHORITY_REASSIGNED','FREEZE_ABUSE','LIQUIDITY_DRAIN','CREATOR_DUMP'))
     )`,
    `CREATE INDEX idx_security_events_mint ON security_events(mint)`,

    `CREATE TABLE creator_profiles (
       address             TEXT PRIMARY KEY,
       launches            INTEGER NOT NULL,
       first_launch_at     INTEGER,
       last_launch_at      INTEGER,
       confirmed           INTEGER NOT NULL,
       strongly_suspected  INTEGER NOT NULL,
       suspicious          INTEGER NOT NULL,
       status              TEXT NOT NULL,
       events              TEXT NOT NULL,
       reasons             TEXT NOT NULL,
       updated_at          INTEGER NOT NULL,
       CHECK (status IN ('MALICIOUS_HISTORY','SUSPICIOUS','CLEAN','INSUFFICIENT_HISTORY'))
     )`,

    `CREATE TABLE token_intelligence (
       id          INTEGER PRIMARY KEY AUTOINCREMENT,
       mint        TEXT NOT NULL,
       analyzed_at INTEGER NOT NULL,
       activity    TEXT NOT NULL,
       wash        TEXT NOT NULL,
       attribution TEXT NOT NULL,
       network     TEXT NOT NULL,
       wallets     TEXT NOT NULL,
       coverage    REAL NOT NULL,
       truncation  TEXT NOT NULL
     )`,
    `CREATE INDEX idx_token_intelligence_mint ON token_intelligence(mint, analyzed_at)`,
  ],
};

/**
 * Every migration, in order. Append only.
 */
export const MIGRATIONS: readonly Migration[] = [INITIAL, DATA_BACKBONE, DEEP_INTELLIGENCE];

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
