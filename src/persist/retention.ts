/**
 * Retention.
 *
 * A scanner running every two minutes collects forever, so something has to
 * decide what to forget. That decision is stated here in one place rather than
 * scattered through delete statements, because the cost of getting it wrong is
 * asymmetric: storage is cheap and destroyed history is gone.
 *
 * ## The policy, and what it refuses to do
 *
 * - **State transitions are never deleted.** A row with `is_transition = 1`
 *   marks a token entering or leaving QUALIFIED, WATCH, REJECTED. It is the
 *   spine of every question a later phase will ask about how a token behaved,
 *   and it is a handful of rows per token. Retention skips them unconditionally
 *   - including when the whole token is pruned, which cascades, so a token must
 *   go cold for far longer before it is dropped entirely.
 * - **Deletion is by age, not by count.** A cap on rows would silently discard
 *   a busy token's recent history to make room for a quiet one's.
 * - **Defaults are conservative.** 90 days of full-resolution history, 180 days
 *   before a token unseen for that long is dropped. At this project's scale
 *   that is megabytes.
 * - **No downsampling yet.** Rolling old high-frequency history into lower
 *   resolution is the obvious next step, and it is deliberately not done here:
 *   it is lossy, it is easy to get subtly wrong, and there is no accumulated
 *   history to tune it against. PERSISTENCE.md records it as future work.
 */

import type { DatabaseSync } from 'node:sqlite';
import { transact } from './db.ts';
import { classifyDbError, type PersistenceFailure } from './errors.ts';

export interface RetentionPolicy {
  /** Days of non-transition snapshot history to keep. */
  historyDays: number;
  /** Days a token may go unseen before it and its history are dropped. */
  tokenDays: number;
  /** Days of provider-failure diagnostics to keep. */
  diagnosticsDays: number;
  /** Maximum monitor events retained, newest first. */
  maxEvents: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  historyDays: 90,
  tokenDays: 180,
  diagnosticsDays: 14,
  maxEvents: 500,
};

export interface RetentionResult {
  tokenSnapshots: number;
  marketSnapshots: number;
  holderSnapshots: number;
  poolSnapshots: number;
  providerFailures: number;
  events: number;
  tokens: number;
  transitionsPreserved: number;
  failure: PersistenceFailure | null;
}

const DAY_MS = 24 * 3_600_000;

/**
 * Applies the retention policy.
 *
 * Runs as one transaction so a partial sweep cannot leave market history for a
 * token whose verdict history was already deleted - which would look like a
 * token that traded without ever being evaluated.
 *
 * `now` is injectable so retention behaviour is testable without waiting 90
 * days or mutating the clock.
 */
export function applyRetention(
  db: DatabaseSync,
  policy: RetentionPolicy = DEFAULT_RETENTION,
  now: number = Date.now(),
): RetentionResult {
  const historyCutoff = now - policy.historyDays * DAY_MS;
  const tokenCutoff = now - policy.tokenDays * DAY_MS;
  const diagnosticsCutoff = now - policy.diagnosticsDays * DAY_MS;

  const result: RetentionResult = {
    tokenSnapshots: 0,
    marketSnapshots: 0,
    holderSnapshots: 0,
    poolSnapshots: 0,
    providerFailures: 0,
    events: 0,
    tokens: 0,
    transitionsPreserved: 0,
    failure: null,
  };

  try {
    transact(db, () => {
      // Counted before the sweep so the report can state plainly how much
      // history was protected rather than merely not mentioned.
      result.transitionsPreserved = (
        db
          .prepare('SELECT COUNT(*) AS c FROM token_snapshots WHERE is_transition = 1 AND observed_at < ?')
          .get(historyCutoff) as { c: number }
      ).c;

      // Verdict history: age-limited, transitions exempt.
      result.tokenSnapshots = db
        .prepare('DELETE FROM token_snapshots WHERE observed_at < ? AND is_transition = 0')
        .run(historyCutoff).changes as number;

      // The market/holder/pool streams carry no transition concept of their
      // own, so they follow the same age rule.
      result.marketSnapshots = db
        .prepare('DELETE FROM market_snapshots WHERE observed_at < ?')
        .run(historyCutoff).changes as number;
      result.holderSnapshots = db
        .prepare('DELETE FROM holder_snapshots WHERE observed_at < ?')
        .run(historyCutoff).changes as number;
      result.poolSnapshots = db
        .prepare('DELETE FROM pool_snapshots WHERE observed_at < ?')
        .run(historyCutoff).changes as number;

      result.providerFailures = db
        .prepare('DELETE FROM provider_failures WHERE at < ?')
        .run(diagnosticsCutoff).changes as number;

      // Events are capped by count because they are a notification feed, not
      // measurement history, and the dashboard reads only the newest.
      result.events = db
        .prepare(
          `DELETE FROM events WHERE id NOT IN (
             SELECT id FROM events ORDER BY at DESC LIMIT ?
           )`,
        )
        .run(policy.maxEvents).changes as number;

      // Tokens last. ON DELETE CASCADE removes whatever history remains, so a
      // token is only dropped after being cold for `tokenDays` - twice the
      // history window by default.
      result.tokens = db
        .prepare('DELETE FROM tokens WHERE last_seen_at < ?')
        .run(tokenCutoff).changes as number;
    });
  } catch (error) {
    result.failure = classifyDbError('applyRetention', error, 'WRITE_FAILED');
  }

  return result;
}
