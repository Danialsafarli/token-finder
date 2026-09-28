/**
 * What happened to a token after a verdict, from stored facts only.
 *
 * Calibration asks whether thresholds behave sensibly, not whether they would
 * have made money, so price is never an outcome here: a price that fell is
 * not a scam, and a price that rose is not a good token. Three classes, kept
 * apart:
 *
 * - **MEASURED** - a fact Token Finder observed after the verdict: a
 *   CONFIRMED security event (liquidity drain, supply expansion, freeze
 *   abuse) dated after it; pooled liquidity collapsing by at least 80%; or
 *   liquidity observed across the whole horizon, holding at least half its
 *   level (sustained) or not (declined).
 * - **PROXY** - suggestive but incomplete: observed for at least half the
 *   horizon without a collapse, then no longer observed.
 * - **UNKNOWN** - too little was observed after the verdict to say anything.
 *   Most tokens end here, because a token that leaves the discovery feeds is
 *   no longer observed; that is reported, never filled in.
 *
 * A known bias, stated wherever these labels are summarised: a token that
 * dies usually leaves the feeds, so it is more likely to be UNKNOWN than
 * measured. Measured outcomes over-represent survivors.
 */

export type OutcomeClass = 'MEASURED' | 'PROXY' | 'UNKNOWN';

export type OutcomeLabel =
  | 'CONFIRMED_DRAIN'
  | 'CONFIRMED_ABUSE'
  | 'LIQUIDITY_COLLAPSE'
  | 'SUSTAINED_LIQUIDITY'
  | 'LIQUIDITY_DECLINED'
  | 'SURVIVED_PART_OF_WINDOW'
  | 'NOT_OBSERVED';

export interface Outcome {
  class: OutcomeClass;
  label: OutcomeLabel;
  detail: string;
}

export interface Observation {
  t: number;
  liquidity: number | null;
  /** The pool the liquidity was read on; liquidity is compared within one pool only. */
  pool?: string | null;
}

export interface ConfirmedEvent {
  type: string;
  at: number;
}

export const OUTCOME_RULES = {
  /** A fall to this fraction of the verdict-time liquidity or below is a collapse. */
  collapseFraction: 0.2,
  /** Holding at least this fraction across the horizon is sustained. */
  sustainedFraction: 0.5,
  /** Observed this close to the end of the horizon counts as observed through it. */
  throughFraction: 0.9,
  /** Observed for this much of the horizon, without a collapse, is a proxy. */
  proxyFraction: 0.5,
  /** Below this, a liquidity figure is too small for a relative collapse to mean anything. */
  minLiquidityUsd: 1_000,
} as const;

const ABUSE = new Set(['SUPPLY_EXPANSION', 'FREEZE_ABUSE']);

/**
 * @param at when the verdict was made
 * @param liquidity pooled liquidity at the verdict, or null when not measured
 * @param later observations after the verdict (any order)
 * @param events CONFIRMED security events on this token, with their time
 * @param pool the pool the verdict-time liquidity was read on: a later reading
 *   on a different known pool (a migration, a new best pair) is not compared
 */
export function labelOutcome(at: number, liquidity: number | null, later: Observation[], events: ConfirmedEvent[], horizonMs: number, pool: string | null = null): Outcome {
  const end = at + horizonMs;
  const inWindow = (t: number): boolean => t > at && t <= end;
  const event = events.filter((e) => inWindow(e.at)).sort((a, b) => a.at - b.at)[0];
  if (event) {
    return {
      class: 'MEASURED',
      label: event.type === 'LIQUIDITY_DRAIN' ? 'CONFIRMED_DRAIN' : ABUSE.has(event.type) ? 'CONFIRMED_ABUSE' : 'CONFIRMED_ABUSE',
      detail: `${event.type.toLowerCase().replace('_', ' ')} confirmed ${Math.round((event.at - at) / 60_000)} min after the verdict`,
    };
  }
  // A reading with no recorded pool cannot be attributed, so it is not compared.
  const samePool = (o: Observation): boolean => pool === null || o.pool === pool;
  const obs = later.filter((o) => inWindow(o.t) && o.liquidity !== null && samePool(o)).sort((a, b) => a.t - b.t) as { t: number; liquidity: number }[];
  if (liquidity === null || liquidity < OUTCOME_RULES.minLiquidityUsd || obs.length === 0) {
    return { class: 'UNKNOWN', label: 'NOT_OBSERVED', detail: liquidity === null ? 'no liquidity measured at the verdict' : obs.length === 0 ? 'not observed after the verdict' : 'liquidity too small to compare' };
  }
  const low = Math.min(...obs.map((o) => o.liquidity));
  const collapse = obs.find((o) => o.liquidity <= liquidity * OUTCOME_RULES.collapseFraction);
  if (collapse) {
    return { class: 'MEASURED', label: 'LIQUIDITY_COLLAPSE', detail: `liquidity fell ${Math.round((1 - collapse.liquidity / liquidity) * 100)}% within ${Math.round((collapse.t - at) / 60_000)} min` };
  }
  const reached = obs[obs.length - 1]!.t - at;
  if (reached >= horizonMs * OUTCOME_RULES.throughFraction) {
    const kept = low / liquidity;
    return kept >= OUTCOME_RULES.sustainedFraction
      ? { class: 'MEASURED', label: 'SUSTAINED_LIQUIDITY', detail: `observed through the horizon; lowest liquidity ${Math.round(kept * 100)}% of the verdict's` }
      : { class: 'MEASURED', label: 'LIQUIDITY_DECLINED', detail: `observed through the horizon; liquidity fell to ${Math.round(kept * 100)}% of the verdict's` };
  }
  if (reached >= horizonMs * OUTCOME_RULES.proxyFraction) {
    return { class: 'PROXY', label: 'SURVIVED_PART_OF_WINDOW', detail: `observed for ${Math.round(reached / 60_000)} min of ${Math.round(horizonMs / 60_000)} without a collapse, then not observed` };
  }
  return { class: 'UNKNOWN', label: 'NOT_OBSERVED', detail: `observed for only ${Math.round(reached / 60_000)} min after the verdict` };
}

/** Consecutive stored verdicts replayed under the stability policy's rule (see decision/stability.ts). */
export function replayStability(sequence: { verdict: string; t: number }[], tier: (v: string) => number, confirmations: number): { raw: number; stable: number; reversals: number; stableReversals: number } {
  let raw = 0;
  let reversals = 0;
  for (let i = 1; i < sequence.length; i++) {
    if (sequence[i]!.verdict !== sequence[i - 1]!.verdict) raw += 1;
    if (i >= 2 && sequence[i]!.verdict === sequence[i - 2]!.verdict && sequence[i]!.verdict !== sequence[i - 1]!.verdict) reversals += 1;
  }
  // Toward danger immediately; toward safety after `confirmations` consecutive readings, taking the most conservative.
  const out: string[] = [];
  let current = sequence[0]?.verdict ?? null;
  let pending: { verdict: string; n: number } | null = null;
  for (const [i, s] of sequence.entries()) {
    if (i === 0 || current === null) {
      out.push(s.verdict);
      current = s.verdict;
      continue;
    }
    if (tier(s.verdict) >= tier(current)) {
      current = s.verdict;
      pending = null;
    } else {
      const n: number = (pending?.n ?? 0) + 1;
      const conservative: string = pending && tier(pending.verdict) > tier(s.verdict) ? pending.verdict : s.verdict;
      if (n >= confirmations) {
        current = conservative;
        pending = null;
      } else pending = { verdict: conservative, n };
    }
    out.push(current);
  }
  let stable = 0;
  let stableReversals = 0;
  for (let i = 1; i < out.length; i++) {
    if (out[i] !== out[i - 1]) stable += 1;
    if (i >= 2 && out[i] === out[i - 2] && out[i] !== out[i - 1]) stableReversals += 1;
  }
  return { raw, stable, reversals, stableReversals };
}
