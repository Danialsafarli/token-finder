/**
 * Read-only queries for the calibration replay (src/calibration/replay.ts).
 *
 * Kept inside the persistence boundary like every other SQL statement. The
 * replay runs over a copy of a database, opened read-only, and never writes.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Eligibility } from '../types.ts';

export interface VerdictRow {
  mint: string;
  observedAt: number;
  eligibility: Eligibility;
  vetoCodes: string | null;
  /** 'phase-1' for rows written before decision policies were stamped. */
  policy: string;
}

export interface CalibrationSource {
  verdicts(): VerdictRow[];
  marketObservations(): { mint: string; t: number; liquidity: number | null; pool: string | null }[];
  confirmedEvents(): { mint: string; type: string; at: number }[];
  tokenPayloads(): string[];
  span(): { from: number | null; to: number | null; snapshots: number; tokens: number };
}

export class CalibrationReader implements CalibrationSource {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  verdicts(): VerdictRow[] {
    return (
      this.#db
        .prepare(`SELECT mint, observed_at, eligibility, veto_codes, COALESCE(policy_version, 'phase-1') AS policy FROM token_snapshots WHERE eligibility IS NOT NULL ORDER BY mint, observed_at`)
        .all() as { mint: string; observed_at: number; eligibility: Eligibility; veto_codes: string | null; policy: string }[]
    ).map((r) => ({ mint: r.mint, observedAt: r.observed_at, eligibility: r.eligibility, vetoCodes: r.veto_codes, policy: r.policy }));
  }

  marketObservations(): { mint: string; t: number; liquidity: number | null; pool: string | null }[] {
    return this.#db
      .prepare('SELECT mint, observed_at AS t, liquidity_usd AS liquidity, pool_address AS pool FROM market_snapshots ORDER BY mint, observed_at')
      .all() as { mint: string; t: number; liquidity: number | null; pool: string | null }[];
  }

  /** Current-interpretation CONFIRMED security events, dated by block time when known. */
  confirmedEvents(): { mint: string; type: string; at: number }[] {
    return this.#db
      .prepare(`SELECT mint, type, COALESCE(block_time, detected_at) AS at FROM security_events WHERE status = 'CONFIRMED' AND superseded_at IS NULL`)
      .all() as { mint: string; type: string; at: number }[];
  }

  tokenPayloads(): string[] {
    return (this.#db.prepare('SELECT payload FROM tokens').all() as { payload: string }[]).map((r) => r.payload);
  }

  span(): { from: number | null; to: number | null; snapshots: number; tokens: number } {
    const r = this.#db.prepare('SELECT MIN(observed_at) AS a, MAX(observed_at) AS b, COUNT(*) AS n, COUNT(DISTINCT mint) AS m FROM token_snapshots').get() as { a: number | null; b: number | null; n: number; m: number };
    return { from: r.a, to: r.b, snapshots: r.n, tokens: r.m };
  }
}
