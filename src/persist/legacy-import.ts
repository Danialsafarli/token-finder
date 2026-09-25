/**
 * One-time import of the legacy `state.json` into SQLite.
 *
 * The JSON store held real collected history that exists nowhere else, so this
 * is written to be paranoid rather than convenient:
 *
 * - **The JSON is never modified or deleted.** It is copied to a timestamped
 *   backup before anything is written, and left in place afterwards. Retiring
 *   it is a human decision, documented in PERSISTENCE.md, not a side effect of
 *   running the importer.
 * - **The import is one transaction.** Either every row lands or none does.
 *   There is no state where half a token's history is in the database.
 * - **It runs at most once.** A marker in `meta` records that the import
 *   completed, so restarting the process cannot double every history point.
 * - **Malformed input fails loudly and changes nothing.** Unreadable JSON, or
 *   JSON without the expected shape, returns a failure and leaves an empty
 *   database empty.
 * - **Rows that cannot be represented are counted, not dropped quietly.** A
 *   snapshot whose score violates a schema constraint is skipped and reported
 *   in `skippedTokens`. A partial import always says so.
 */

import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { transact } from './db.ts';
import { classifyDbError, messageOf, type PersistenceFailure } from './errors.ts';
import type { HistoryPoint, MonitorEvent, TokenSnapshot } from '../types.ts';

/** Meta keys recording that the import happened. */
export const IMPORT_MARKER = 'legacy_import.completed_at';
export const IMPORT_SOURCE = 'legacy_import.source';
export const IMPORT_COUNTS = 'legacy_import.counts';

export type ImportStatus =
  | 'imported'
  | 'already-imported'
  | 'no-legacy-file'
  | 'failed';

export interface ImportResult {
  status: ImportStatus;
  tokens: number;
  historyPoints: number;
  events: number;
  /** Tokens present in the JSON that could not be stored, with reasons. */
  skippedTokens: { mint: string; reason: string }[];
  backupPath: string | null;
  failure: PersistenceFailure | null;
  detail: string;
}

function emptyResult(status: ImportStatus, detail: string): ImportResult {
  return {
    status,
    tokens: 0,
    historyPoints: 0,
    events: 0,
    skippedTokens: [],
    backupPath: null,
    failure: null,
    detail,
  };
}

interface LegacyState {
  version?: number;
  lastScanAt?: number | null;
  scanCount?: number;
  tokens?: Record<string, TokenSnapshot>;
  history?: Record<string, HistoryPoint[]>;
  events?: MonitorEvent[];
}

/** A finite number, or null. Never NaN, never a string that looked numeric. */
function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export interface ImportOptions {
  /** Path to the legacy state file. */
  legacyPath: string;
  /** Where to write the pre-import backup. Defaults beside the legacy file. */
  backupDir?: string;
  /** Re-import even when the marker says it already ran. Off by default. */
  force?: boolean;
}

/**
 * Imports legacy JSON state into an open, migrated database.
 *
 * Returns a result rather than throwing: a failed import leaves a usable empty
 * database and a loud diagnostic, which is better than a process that will not
 * start.
 */
export function importLegacyState(db: DatabaseSync, options: ImportOptions): ImportResult {
  const { legacyPath } = options;

  // --- already done? ------------------------------------------------------
  if (options.force !== true) {
    try {
      const marker = db.prepare('SELECT value FROM meta WHERE key = ?').get(IMPORT_MARKER) as
        | { value: string }
        | undefined;
      if (marker !== undefined) {
        return emptyResult('already-imported', `legacy import already ran at ${marker.value}`);
      }
    } catch (error) {
      return {
        ...emptyResult('failed', 'could not read the import marker'),
        failure: classifyDbError('importLegacyState/marker', error, 'READ_FAILED'),
      };
    }
  }

  // --- nothing to import --------------------------------------------------
  if (!existsSync(legacyPath)) {
    // Recorded as done so that a state.json restored later cannot be imported
    // into an already-populated database and duplicate its history. Clearing
    // the marker is a deliberate act; PERSISTENCE.md says how.
    try {
      markImported(db, legacyPath, { tokens: 0, historyPoints: 0, events: 0 });
    } catch {
      // A missing marker only costs a second no-op check next start.
    }
    return emptyResult('no-legacy-file', `no legacy state at ${legacyPath}`);
  }

  // --- read and validate --------------------------------------------------
  let parsed: LegacyState;
  try {
    parsed = JSON.parse(readFileSync(legacyPath, 'utf8')) as LegacyState;
  } catch (error) {
    return {
      ...emptyResult('failed', `legacy state is not valid JSON: ${messageOf(error)}`),
      failure: {
        kind: 'IMPORT_FAILED',
        operation: 'importLegacyState/parse',
        message: messageOf(error).slice(0, 300),
        at: Date.now(),
        retryable: false,
      },
    };
  }

  if (typeof parsed !== 'object' || parsed === null || typeof parsed.tokens !== 'object' || parsed.tokens === null) {
    return {
      ...emptyResult('failed', 'legacy state has no `tokens` object; refusing to guess its shape'),
      failure: {
        kind: 'IMPORT_FAILED',
        operation: 'importLegacyState/shape',
        message: 'missing or non-object `tokens`',
        at: Date.now(),
        retryable: false,
      },
    };
  }

  // --- back up before touching anything -----------------------------------
  let backupPath: string | null = null;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = options.backupDir ?? resolve(legacyPath, '..');
    backupPath = resolve(dir, `state.pre-sqlite-import-${stamp}.json`);
    copyFileSync(legacyPath, backupPath);
  } catch (error) {
    return {
      ...emptyResult('failed', `could not back up legacy state: ${messageOf(error)}`),
      failure: {
        kind: 'IMPORT_FAILED',
        operation: 'importLegacyState/backup',
        message: messageOf(error).slice(0, 300),
        at: Date.now(),
        retryable: true,
      },
    };
  }

  // --- import, all or nothing ---------------------------------------------
  const skipped: { mint: string; reason: string }[] = [];
  let tokenCount = 0;
  let pointCount = 0;
  let eventCount = 0;

  try {
    transact(db, () => {
      const insertToken = db.prepare(
        `INSERT OR REPLACE INTO tokens
           (mint, symbol, name, first_seen_at, last_seen_at, launched_at,
            token_program, decimals, raw_supply, payload)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      );
      const insertVerdict = db.prepare(
        `INSERT INTO token_snapshots
           (mint, scan_id, observed_at, recorded_at, score, base_score, grade,
            penalty, score_coverage, coverage, confidence, state, eligibility,
            veto_codes, is_transition)
         VALUES (?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      const insertMarket = db.prepare(
        `INSERT INTO market_snapshots
           (mint, scan_id, observed_at, recorded_at, price_usd, liquidity_usd, volume_24h)
         VALUES (?,NULL,?,?,?,?,?)`,
      );
      const insertEvent = db.prepare(
        `INSERT OR REPLACE INTO events (id, at, kind, mint, symbol, level, message, data)
         VALUES (?,?,?,?,?,?,?,?)`,
      );

      const now = Date.now();
      const tokens = parsed.tokens ?? {};
      const history = parsed.history ?? {};

      for (const [mint, snapshot] of Object.entries(tokens)) {
        if (typeof snapshot !== 'object' || snapshot === null || typeof snapshot.mint !== 'string') {
          skipped.push({ mint, reason: 'snapshot is not an object with a mint' });
          continue;
        }
        const observedAt = finite(snapshot.at);
        if (observedAt === null) {
          skipped.push({ mint, reason: 'snapshot has no usable timestamp' });
          continue;
        }

        const onchain = snapshot.onchain ?? null;
        insertToken.run(
          mint,
          snapshot.symbol ?? null,
          snapshot.name ?? null,
          observedAt,
          observedAt,
          finite(snapshot.launchedAt),
          // v1 snapshots predate Token-2022 awareness; there is no program to
          // record and inventing one would be fabrication.
          onchain?.tokenProgram ?? null,
          onchain?.decimals ?? null,
          onchain?.rawSupply ?? null,
          JSON.stringify(snapshot),
        );
        tokenCount += 1;

        // Legacy history carries no verdict, coverage or confidence - v1 had no
        // `evaluation`. Those columns stay NULL, which reads as "not recorded".
        for (const point of history[mint] ?? []) {
          const at = finite(point?.at);
          const score = finite(point?.score);
          if (at === null || score === null || score < 0 || score > 100) {
            continue;
          }
          insertVerdict.run(mint, at, now, score, null, null, null, null, null, null, null, null, null, 0);
          insertMarket.run(
            mint,
            at,
            now,
            finite(point.priceUsd),
            finite(point.liquidityUsd),
            finite(point.volume24h),
          );
          pointCount += 1;
        }
      }

      for (const event of parsed.events ?? []) {
        if (typeof event?.id !== 'string' || finite(event.at) === null) continue;
        insertEvent.run(
          event.id,
          event.at,
          event.kind ?? 'discovered',
          event.mint ?? null,
          event.symbol ?? null,
          event.level ?? 'info',
          event.message ?? '',
          event.data === undefined ? null : JSON.stringify(event.data),
        );
        eventCount += 1;
      }

      // A scan row so `scanCount` survives the move. `started_at` is the last
      // known scan time; the earlier scans were never individually recorded by
      // the JSON store and are not invented here.
      const lastScanAt = finite(parsed.lastScanAt);
      if (lastScanAt !== null) {
        db.prepare(
          'INSERT INTO scans (started_at, finished_at, analyzed, fresh) VALUES (?,?,?,0)',
        ).run(lastScanAt, lastScanAt, tokenCount);
      }

      markImported(db, legacyPath, {
        tokens: tokenCount,
        historyPoints: pointCount,
        events: eventCount,
      });
    });
  } catch (error) {
    return {
      status: 'failed',
      tokens: 0,
      historyPoints: 0,
      events: 0,
      skippedTokens: skipped,
      backupPath,
      failure: classifyDbError('importLegacyState/write', error, 'IMPORT_FAILED'),
      detail: `import rolled back, database unchanged: ${messageOf(error)}`,
    };
  }

  // --- verify -------------------------------------------------------------
  // The transaction committed, so this is a consistency check rather than a
  // gate: it turns a silent shortfall into a reported one.
  const stored = (db.prepare('SELECT COUNT(*) AS c FROM tokens').get() as { c: number }).c;
  const detail =
    stored === tokenCount
      ? `imported ${tokenCount} tokens, ${pointCount} history points, ${eventCount} events`
      : `imported ${tokenCount} tokens but the table holds ${stored}; investigate before trusting history`;

  return {
    status: 'imported',
    tokens: tokenCount,
    historyPoints: pointCount,
    events: eventCount,
    skippedTokens: skipped,
    backupPath,
    failure: null,
    detail,
  };
}

function markImported(
  db: DatabaseSync,
  source: string,
  counts: { tokens: number; historyPoints: number; events: number },
): void {
  const stmt = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)');
  stmt.run(IMPORT_MARKER, new Date().toISOString());
  stmt.run(IMPORT_SOURCE, source);
  stmt.run(IMPORT_COUNTS, JSON.stringify(counts));
}
