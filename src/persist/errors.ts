/**
 * Persistence failure taxonomy.
 *
 * Token Finder's whole evidence model rests on one rule: a gap in what we know
 * must be visible as a gap. That rule does not stop at the provider boundary.
 * If the database cannot be opened, or a write is lost, the analysis is still
 * valid - but any claim that it was *recorded* is not, and the two must not be
 * confused.
 *
 * So persistence failures are typed, surfaced and counted rather than swallowed.
 * The scanner degrades explicitly: it keeps analysing, it says once that history
 * is not being written, and it never reports a history it does not have.
 */

export type PersistenceFailureKind =
  /** The database could not be opened at all - bad path, permissions, locked. */
  | 'DB_UNAVAILABLE'
  /** The file exists but SQLite rejects it as malformed. */
  | 'CORRUPT_DB'
  /** Schema migration could not be completed. The DB is left at its old version. */
  | 'MIGRATION_FAILED'
  | 'WRITE_FAILED'
  | 'READ_FAILED'
  /** Importing legacy JSON state failed; the JSON is left untouched. */
  | 'IMPORT_FAILED';

export interface PersistenceFailure {
  kind: PersistenceFailureKind;
  /** Short operation name, e.g. `saveTokenSnapshot`, `open`, `migrate`. */
  operation: string;
  message: string;
  /** Unix ms, UTC. */
  at: number;
  /**
   * Whether retrying the same operation could plausibly succeed. A locked
   * database can clear; a malformed one cannot, and retrying it in a loop turns
   * one problem into two.
   */
  retryable: boolean;
}

/** SQLite error text that means the file itself is not a usable database. */
const CORRUPTION_MARKERS = [
  'file is not a database',
  'database disk image is malformed',
  'malformed database schema',
  'file is encrypted',
];

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classifies a raw SQLite error into the taxonomy above.
 *
 * Corruption is separated from unavailability deliberately: they call for
 * opposite responses. An unavailable database is worth retrying and may fix
 * itself; a corrupt one needs a human, and quietly recreating it would destroy
 * the history this whole layer exists to keep.
 */
export function classifyDbError(
  operation: string,
  error: unknown,
  fallback: PersistenceFailureKind = 'WRITE_FAILED',
): PersistenceFailure {
  const message = messageOf(error);
  const lower = message.toLowerCase();

  let kind = fallback;
  let retryable = fallback === 'WRITE_FAILED' || fallback === 'READ_FAILED';

  if (CORRUPTION_MARKERS.some((marker) => lower.includes(marker))) {
    kind = 'CORRUPT_DB';
    retryable = false;
  } else if (lower.includes('unable to open') || lower.includes('permission denied')) {
    kind = 'DB_UNAVAILABLE';
    retryable = true;
  } else if (lower.includes('database is locked') || lower.includes('busy')) {
    // A lock clears on its own once the other writer commits.
    retryable = true;
  }

  return { kind, operation, message: message.slice(0, 300), at: Date.now(), retryable };
}

/**
 * Thrown only where the caller genuinely cannot continue - a migration that
 * would otherwise leave a half-applied schema. Ordinary read and write failures
 * are returned as values, not thrown, so one lost snapshot cannot end a scan.
 */
export class PersistenceError extends Error {
  readonly failure: PersistenceFailure;

  constructor(failure: PersistenceFailure) {
    super(`${failure.kind} during ${failure.operation}: ${failure.message}`);
    this.name = 'PersistenceError';
    this.failure = failure;
  }
}
