/**
 * The live ranking universe.
 *
 * One question, answered in one place: *is this token currently assessed?*
 * Before this module, four different code paths answered it four different ways
 * - the list filter let unevaluated legacy imports through, the coverage summary
 * counted "legacy" by a different field, the retention sweep decided how long a
 * token stayed visible, and the UI totals counted whatever came back. They
 * disagreed by a factor of fifteen.
 *
 * Every surface that shows or counts "live" tokens now goes through
 * {@link placementOf}: the Board, its segment counts, the System surface, the
 * compatibility endpoints and the CLI ranking.
 *
 * ## The rule
 *
 * A token is LIVE when it has a safety evaluation **and** was last evaluated
 * within the live window. Otherwise it is history:
 *
 *   UNEVALUATED  no evaluation exists - imported from the pre-evaluation JSON
 *                store, or never analysed. Its data is kept; it is never ranked.
 *   STALE        evaluated, but not re-evaluated within the window. Its verdict
 *                describes the past and is shown only as history.
 *
 * ## Why the window is 90 minutes
 *
 * It is not a taste choice. It is the engine's own aging window for market
 * evidence (`FRESHNESS.liquidityUsd.agingMs`): past it, the engine itself marks
 * liquidity STALE and refuses to let it veto or score. A verdict resting on
 * liquidity the engine would not use is not a current verdict, so the Board
 * cannot show it as one. A test pins the two numbers together.
 *
 * ## What this is not
 *
 * This is not retention. Retention decides how long *history* is kept (months,
 * see `persist/retention.ts`); this decides what is *current* (minutes). The
 * regression this replaced was exactly those two being coupled.
 */

import { FRESHNESS } from './evidence.ts';
import type { Eligibility, TokenSnapshot } from '../types.ts';

export type Universe = 'LIVE' | 'STALE' | 'UNEVALUATED';

/** Within the live window: FRESH before the market fresh window, AGING after. */
export type LiveFreshness = 'FRESH' | 'AGING';

/** Default live window, derived from the engine rather than restated. */
export const DEFAULT_LIVE_WINDOW_MS = FRESHNESS.liquidityUsd!.agingMs;

/** Inside the live window, how long a verdict counts as fresh rather than aging. */
export const FRESH_WITHIN_MS = FRESHNESS.liquidityUsd!.freshMs;

const ELIGIBILITIES: ReadonlySet<Eligibility> = new Set([
  'QUALIFIED',
  'WATCH',
  'INSUFFICIENT_DATA',
  'REJECTED',
]);

export interface Placement {
  universe: Universe;
  /** Null outside the live universe. */
  freshness: LiveFreshness | null;
  /** Milliseconds since the token was last evaluated. */
  ageMs: number;
  /** Null for unevaluated tokens. */
  eligibility: Eligibility | null;
}

/**
 * Where a token belongs right now.
 *
 * `== null` is deliberate: snapshots imported from the v1 JSON store have no
 * `evaluation` key at all, so the value is `undefined`, not `null`.
 */
export function placementOf(
  token: TokenSnapshot,
  now: number,
  windowMs: number = DEFAULT_LIVE_WINDOW_MS,
): Placement {
  const ageMs = Math.max(0, now - token.at);
  const eligibility = token.evaluation?.eligibility;

  if (token.evaluation == null || eligibility === undefined || !ELIGIBILITIES.has(eligibility)) {
    return { universe: 'UNEVALUATED', freshness: null, ageMs, eligibility: null };
  }
  if (!Number.isFinite(token.at) || ageMs > windowMs) {
    return { universe: 'STALE', freshness: null, ageMs, eligibility };
  }
  return {
    universe: 'LIVE',
    freshness: ageMs <= FRESH_WITHIN_MS ? 'FRESH' : 'AGING',
    ageMs,
    eligibility,
  };
}

export function isLive(token: TokenSnapshot, now: number, windowMs?: number): boolean {
  return placementOf(token, now, windowMs).universe === 'LIVE';
}

export interface UniverseCounts {
  live: number;
  stale: number;
  unevaluated: number;
  total: number;
  /** Live tokens only, by eligibility. The Board's segment counts. */
  byEligibility: Record<Eligibility, number>;
}

export function countUniverse(
  tokens: readonly TokenSnapshot[],
  now: number,
  windowMs?: number,
): UniverseCounts {
  const counts: UniverseCounts = {
    live: 0,
    stale: 0,
    unevaluated: 0,
    total: tokens.length,
    byEligibility: { QUALIFIED: 0, WATCH: 0, INSUFFICIENT_DATA: 0, REJECTED: 0 },
  };
  for (const token of tokens) {
    const placement = placementOf(token, now, windowMs);
    if (placement.universe === 'LIVE') {
      counts.live++;
      counts.byEligibility[placement.eligibility as Eligibility]++;
    } else if (placement.universe === 'STALE') {
      counts.stale++;
    } else {
      counts.unevaluated++;
    }
  }
  return counts;
}

/** The live tokens, in no particular order. */
export function liveTokens(
  tokens: readonly TokenSnapshot[],
  now: number,
  windowMs?: number,
): TokenSnapshot[] {
  return tokens.filter((token) => isLive(token, now, windowMs));
}

/** Verdict tier: a rejected token can never sort above a qualified one. */
export const VERDICT_TIER: Record<Eligibility, number> = {
  QUALIFIED: 0,
  WATCH: 1,
  INSUFFICIENT_DATA: 2,
  REJECTED: 3,
};

/**
 * Current age since launch.
 *
 * Snapshots store `ageHours` as it was when the snapshot was taken, so it
 * freezes. Presented values are recomputed from `launchedAt`, which does not.
 */
export function currentAgeHours(token: TokenSnapshot, now: number): number | null {
  if (typeof token.launchedAt === 'number' && Number.isFinite(token.launchedAt)) {
    return Math.max(0, (now - token.launchedAt) / 3_600_000);
  }
  return null;
}
