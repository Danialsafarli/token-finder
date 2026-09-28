/**
 * Verdict stability (`stability@1`): one noisy reading cannot bounce a verdict.
 *
 * Found in live verification: a token alternated REJECTED / HIGH_RISK /
 * QUALIFIED between consecutive scans because its provider concentration sat
 * around the 90% hard threshold. Every reading was honest; the flipping was
 * not useful to anyone.
 *
 * The policy is deliberately asymmetric, because the two errors are not equal:
 *
 * - **Toward danger, immediately.** A verdict that gets worse - a hard fail,
 *   HIGH_RISK, less evidence - applies on the reading that says so. Nothing
 *   here can delay a CONFIRMED_CURRENT_RUG, a CONFIRMED_MALICIOUS_TOKEN or any
 *   other hard fail, and no danger is smoothed away.
 * - **Toward safety, on confirmation.** A verdict that gets better must be
 *   seen on {@link STABILITY}.confirmations consecutive, *independent*
 *   readings - distinct market observations; a re-decision of the same
 *   observation with new intelligence counts once. Until then the previous
 *   verdict is held, and says so. When it is confirmed, the most conservative
 *   of the confirming readings is applied, never the best.
 *
 * So QUALIFIED -> REJECTED -> QUALIFIED on one noisy reading becomes
 * QUALIFIED -> REJECTED (immediately) -> REJECTED, held -> QUALIFIED only once
 * a second reading agrees. A held REJECTED keeps the hard fails it was
 * rejected on: REJECTED always means at least one hard fail.
 *
 * A previous verdict older than `maxHoldAgeMs` is not held against a token:
 * hysteresis is about consecutive readings, not about a token that left the
 * feeds and came back hours later.
 */

import { VERDICT_TIER } from '../core/ranking.ts';
import type { Eligibility, Veto } from '../types.ts';

export const STABILITY_RULE = 'stability@1';

export const STABILITY = {
  /** Independent readings needed before a better verdict applies. */
  confirmations: 2,
  /** A previous verdict older than this is not held (it is not a "previous reading" any more). */
  maxHoldAgeMs: 60 * 60_000,
} as const;

/** The part of the previous decision stability reads. */
export interface PreviousVerdict {
  verdict: Eligibility;
  decidedAt: number;
  hardFails: Veto[];
  stability?: StabilityRecord | null;
}

export interface PendingUpgrade {
  /** The most conservative verdict among the readings seen so far. */
  verdict: Eligibility;
  confirmations: number;
  since: number;
  /** The market observation the last confirming reading used. */
  lastObservedAt: number;
}

export interface StabilityRecord {
  rule: typeof STABILITY_RULE;
  /** What this reading alone would decide. */
  raw: Eligibility;
  /** The previous verdict was kept, pending confirmation of a better one. */
  held: boolean;
  pending: PendingUpgrade | null;
}

export interface StabilityOutcome {
  verdict: Eligibility;
  record: StabilityRecord;
}

const tier = (v: Eligibility): number => VERDICT_TIER[v];
/** The worse (more conservative) of two verdicts. */
const worse = (a: Eligibility, b: Eligibility): Eligibility => (tier(a) >= tier(b) ? a : b);

/**
 * @param raw the verdict this reading's evidence supports on its own
 * @param observedAt the market observation this reading used
 */
export function stabilize(raw: Eligibility, observedAt: number, previous: PreviousVerdict | null, now: number): StabilityOutcome {
  const settled = (verdict: Eligibility): StabilityOutcome => ({ verdict, record: { rule: STABILITY_RULE, raw, held: false, pending: null } });
  if (previous === null || now - previous.decidedAt > STABILITY.maxHoldAgeMs) return settled(raw);
  // Same or worse: applies now. This is the path every hard fail takes.
  if (tier(raw) >= tier(previous.verdict)) return settled(raw);

  const before = previous.stability?.pending ?? null;
  // The same observation read again (a re-decision) is not a new confirmation.
  const repeat = before !== null && before.lastObservedAt === observedAt;
  const confirmations = repeat ? before.confirmations : (before?.confirmations ?? 0) + 1;
  const conservative = before ? worse(before.verdict, raw) : raw;
  if (confirmations >= STABILITY.confirmations) return settled(conservative);
  return {
    verdict: previous.verdict,
    record: {
      rule: STABILITY_RULE,
      raw,
      held: true,
      pending: { verdict: conservative, confirmations, since: before?.since ?? now, lastObservedAt: observedAt },
    },
  };
}
