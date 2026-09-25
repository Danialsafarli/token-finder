/**
 * Database health and size diagnostics.
 *
 * Deliberately read-only and cheap: this answers "is persistence working and
 * how big is it" for a CLI command and a future status endpoint. It is not an
 * admin console, and it never repairs anything - a database that needs repair
 * needs a person who knows what was in it.
 */

import { statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { currentSchemaVersion, TARGET_SCHEMA_VERSION } from './migrations.ts';
import { isMemoryPath, quickCheck } from './db.ts';
import { IMPORT_COUNTS, IMPORT_MARKER, IMPORT_SOURCE } from './legacy-import.ts';

export interface DatabaseDiagnostics {
  path: string;
  /** Total bytes on disk, including the WAL and shared-memory sidecars. */
  sizeBytes: number | null;
  schemaVersion: number;
  targetSchemaVersion: number;
  schemaCurrent: boolean;
  rowCounts: Record<string, number>;
  oldestSnapshotAt: number | null;
  newestSnapshotAt: number | null;
  transitionCount: number;
  legacyImport: {
    completedAt: string | null;
    source: string | null;
    counts: string | null;
  };
  integrity: { ok: boolean; detail: string };
}

const COUNTED_TABLES = [
  'tokens',
  'scans',
  'token_snapshots',
  'market_snapshots',
  'holder_snapshots',
  'pool_snapshots',
  'evidence_snapshots',
  'provider_failures',
  'events',
] as const;

function sizeOf(path: string): number | null {
  if (isMemoryPath(path)) return null;
  let total = 0;
  // WAL mode keeps recent commits in `-wal` until a checkpoint, so reporting
  // only the main file would understate a busy database, sometimes by a lot.
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += statSync(`${path}${suffix}`).size;
    } catch {
      // A missing sidecar is normal, not an error.
    }
  }
  return total;
}

export function diagnose(db: DatabaseSync, path: string): DatabaseDiagnostics {
  const rowCounts: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    try {
      // Table names come from the frozen list above, never from input.
      rowCounts[table] = (
        db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }
      ).c;
    } catch {
      rowCounts[table] = -1;
    }
  }

  let oldest: number | null = null;
  let newest: number | null = null;
  let transitions = 0;
  try {
    const row = db
      .prepare(
        `SELECT MIN(observed_at) AS lo, MAX(observed_at) AS hi,
                SUM(is_transition) AS t
           FROM token_snapshots`,
      )
      .get() as { lo: number | null; hi: number | null; t: number | null };
    oldest = row.lo;
    newest = row.hi;
    transitions = row.t ?? 0;
  } catch {
    // Leaves the nulls, which read as "no history recorded".
  }

  const meta = (key: string): string | null => {
    try {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    } catch {
      return null;
    }
  };

  const schemaVersion = currentSchemaVersion(db);

  return {
    path,
    sizeBytes: sizeOf(path),
    schemaVersion,
    targetSchemaVersion: TARGET_SCHEMA_VERSION,
    schemaCurrent: schemaVersion === TARGET_SCHEMA_VERSION,
    rowCounts,
    oldestSnapshotAt: oldest,
    newestSnapshotAt: newest,
    transitionCount: transitions,
    legacyImport: {
      completedAt: meta(IMPORT_MARKER),
      source: meta(IMPORT_SOURCE),
      counts: meta(IMPORT_COUNTS),
    },
    integrity: quickCheck(db),
  };
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'in-memory';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
