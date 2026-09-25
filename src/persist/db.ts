/**
 * Database connection, configuration and health.
 *
 * ## Why the built-in `node:sqlite`
 *
 * Token Finder has zero runtime dependencies, deliberately. Node 24 ships
 * `node:sqlite` (`DatabaseSync`, SQLite 3.53) with no flag and no experimental
 * warning on the runtime this project already requires, and it covers
 * everything this phase needs: WAL, transactions, foreign keys, `CHECK`
 * constraints, prepared statements and named parameters. There is no limitation
 * here that would justify a dependency, so none was added.
 *
 * One genuine sharp edge, and the reason for a rule elsewhere in the schema:
 * reading an `INTEGER` larger than `Number.MAX_SAFE_INTEGER` throws
 * `ERR_OUT_OF_RANGE` rather than rounding. That is arguably the right call, but
 * it means raw `u64` token amounts must be stored as TEXT. See
 * `migrations.ts`.
 *
 * No ORM. The queries here are a few dozen lines of explicit SQL against nine
 * tables; an abstraction layer would add a dependency, a build step and a
 * second schema language to keep in sync, in exchange for nothing.
 *
 * ## Pragmas, and why these
 *
 * - **`journal_mode = WAL`** - readers do not block the writer and the writer
 *   does not block readers. The dashboard polls while the monitor scans, so
 *   that is the exact contention this project has. WAL persists in the database
 *   file itself, so it is set once and survives reopening.
 * - **`synchronous = NORMAL`** - with WAL this is the documented safe pairing.
 *   A power loss can cost the last transactions, not the database. `FULL` would
 *   fsync every commit for durability this workload does not need: the data is
 *   re-derivable by scanning again, and a scan happens every two minutes.
 * - **`foreign_keys = ON`** - off by default in SQLite, and the schema leans on
 *   `ON DELETE CASCADE` so retention cannot leave orphaned history behind.
 * - **`busy_timeout = 5000`** - a second process (a CLI command run against a
 *   live server's data directory) should wait for a lock rather than fail
 *   instantly. Five seconds is far longer than any transaction here.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { classifyDbError, PersistenceError, type PersistenceFailure } from './errors.ts';
import { currentSchemaVersion, migrate, TARGET_SCHEMA_VERSION } from './migrations.ts';

export interface OpenOptions {
  /** Absolute path to the database file, or `':memory:'` for tests. */
  path: string;
  /** Skip migrations. Only used to test a deliberately stale schema. */
  migrateSchema?: boolean;
}

export interface OpenResult {
  db: DatabaseSync | null;
  /** Non-null when the database could not be opened or migrated. */
  failure: PersistenceFailure | null;
  /** Schema versions applied by this call. Empty when already current. */
  applied: number[];
  schemaVersion: number;
}

export function isMemoryPath(path: string): boolean {
  return path === ':memory:' || path.startsWith('file::memory:');
}

/**
 * Opens and prepares a database.
 *
 * Returns a failure rather than throwing, because the caller's correct response
 * is to degrade - keep analysing, stop claiming to record - not to crash. The
 * one exception is a migration that fails partway, which is genuinely
 * unrecoverable without a human and is reported as `MIGRATION_FAILED`.
 */
export function openDatabase(options: OpenOptions): OpenResult {
  const { path } = options;

  let db: DatabaseSync;
  try {
    if (!isMemoryPath(path)) mkdirSync(dirname(path), { recursive: true });
    db = new DatabaseSync(path);
  } catch (error) {
    return {
      db: null,
      failure: classifyDbError('open', error, 'DB_UNAVAILABLE'),
      applied: [],
      schemaVersion: 0,
    };
  }

  try {
    // WAL is meaningless for an in-memory database and SQLite refuses it there,
    // so it is skipped rather than failing an otherwise healthy open.
    if (!isMemoryPath(path)) db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
  } catch (error) {
    db.close();
    return {
      db: null,
      failure: classifyDbError('configure', error, 'DB_UNAVAILABLE'),
      applied: [],
      schemaVersion: 0,
    };
  }

  // A file that is not a database only reveals itself on the first real read.
  try {
    db.prepare('SELECT 1').get();
  } catch (error) {
    db.close();
    return {
      db: null,
      failure: classifyDbError('probe', error, 'CORRUPT_DB'),
      applied: [],
      schemaVersion: 0,
    };
  }

  if (options.migrateSchema === false) {
    return { db, failure: null, applied: [], schemaVersion: currentSchemaVersion(db) };
  }

  try {
    const applied = migrate(db);
    return { db, failure: null, applied, schemaVersion: currentSchemaVersion(db) };
  } catch (error) {
    const failure = classifyDbError('migrate', error, 'MIGRATION_FAILED');
    db.close();
    return { db: null, failure, applied: [], schemaVersion: 0 };
  }
}

/**
 * Runs `fn` inside a transaction, rolling back on any error.
 *
 * `BEGIN IMMEDIATE` takes the write lock up front rather than on first write.
 * That converts a possible mid-transaction `SQLITE_BUSY` - which would force a
 * rollback after work was already done - into a wait at the start, which the
 * busy timeout absorbs.
 *
 * Transactions here are deliberately short: one token's snapshot row plus its
 * market, holder, pool and evidence rows. A scan does not hold a single
 * transaction across every token, because that would block the dashboard's
 * readers for the whole scan and lose the entire batch to one bad row.
 */
export function transact<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Already closed by SQLite; the original error is the informative one.
    }
    throw error;
  }
}

/**
 * Closes a handle cleanly.
 *
 * Checkpoints with TRUNCATE first so the WAL is folded back and removed rather
 * than left beside the database. Never throws: this runs on process exit, which
 * is not a place to fail.
 */
export function closeDatabase(db: DatabaseSync | null): void {
  if (db === null) return;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // An unflushed WAL is read back correctly on the next open.
  }
  try {
    db.close();
  } catch {
    // Already closed.
  }
}

/** Throws when a database is not at the schema version the code expects. */
export function assertSchemaCurrent(db: DatabaseSync): void {
  const version = currentSchemaVersion(db);
  if (version === TARGET_SCHEMA_VERSION) return;
  throw new PersistenceError({
    kind: 'MIGRATION_FAILED',
    operation: 'assertSchemaCurrent',
    message: `schema is at version ${version}, expected ${TARGET_SCHEMA_VERSION}`,
    at: Date.now(),
    retryable: false,
  });
}

/**
 * SQLite's own consistency check, exposed for diagnostics.
 *
 * `quick_check` rather than `integrity_check`: it catches the corruption that
 * actually happens without walking every index, so it is cheap enough to run
 * from a CLI command on demand.
 */
export function quickCheck(db: DatabaseSync): { ok: boolean; detail: string } {
  try {
    const rows = db.prepare('PRAGMA quick_check').all() as Record<string, unknown>[];
    const first = rows[0];
    const detail = first === undefined ? 'no result' : String(Object.values(first)[0] ?? '');
    return { ok: detail === 'ok', detail };
  } catch (error) {
    return { ok: false, detail: classifyDbError('quick_check', error, 'READ_FAILED').message };
  }
}
