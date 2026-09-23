/**
 * The canonical internal evidence model.
 *
 * Raw provider JSON is not the scoring model. Everything the scorer, the safety
 * gate and the UI read is an {@link Evidence} record: a value plus how we came
 * to believe it, when, from whom, and how much that is worth.
 *
 * The states are not interchangeable, and collapsing any of them into "0" or
 * "unknown" is the class of bug this whole layer exists to prevent:
 *
 *   MEASURED     a provider returned a value that passed validation
 *   UNKNOWN      nobody returned anything - we never learned it
 *   CONFLICTED   providers disagreed; `value` holds the conservative reading
 *   INVALID      a provider returned something impossible; it was rejected
 *   STALE        measured, but too old to speak for the present
 *   UNAVAILABLE  the only provider that could answer is not configured
 *
 * Only MEASURED and CONFLICTED can contribute points. The rest earn nothing,
 * and each is reported separately so "we do not know" is never mistaken for
 * "it is zero", and "we rejected the answer" is never mistaken for "it is safe".
 */

import type { FieldIssue } from './validate.ts';

export type EvidenceState =
  | 'MEASURED'
  | 'UNKNOWN'
  | 'CONFLICTED'
  | 'INVALID'
  | 'STALE'
  | 'UNAVAILABLE';

export type Freshness = 'FRESH' | 'AGING' | 'STALE' | 'UNKNOWN';

/** One provider's claim about a single fact, before resolution. */
export interface Claim<T> {
  provider: string;
  value: T | null;
  /** Unix ms when we observed it (fetch time, or cache entry time). */
  observedAt: number;
  /** Present when this provider's value was rejected by validation. */
  invalid?: string;
}

export interface Evidence<T> {
  /** Null for every state except MEASURED and CONFLICTED. */
  value: T | null;
  state: EvidenceState;
  /** Winning provider, or null when nothing won. */
  source: string | null;
  observedAt: number | null;
  freshness: Freshness;
  /**
   * How much this datum is worth, 0-1. Reduced by conflict, by age, and by a
   * provider whose reading we trust less. Distinct from the value itself.
   */
  confidence: number;
  /** Human-readable trail: what each provider said and why this won. */
  notes: string[];
  /** Every provider claim, kept so a disagreement can be shown, not just counted. */
  claims: Claim<T>[];
}

/**
 * Per-metric freshness windows, in milliseconds.
 *
 * One global timeout would be wrong in both directions: a 20-minute-old price
 * change is useless while a 20-minute-old mint authority is as good as new.
 * These reflect how fast the underlying fact actually moves.
 */
export interface FreshnessWindow {
  /** Within this, the observation speaks for the present. */
  freshMs: number;
  /** Within this, usable with reduced confidence. Beyond it, STALE. */
  agingMs: number;
}

export const FRESHNESS: Record<string, FreshnessWindow> = {
  // Market state moves continuously; minutes matter.
  priceChange: { freshMs: 15 * 60_000, agingMs: 45 * 60_000 },
  volume24h: { freshMs: 30 * 60_000, agingMs: 90 * 60_000 },
  liquidityUsd: { freshMs: 30 * 60_000, agingMs: 90 * 60_000 },
  buyPressure: { freshMs: 30 * 60_000, agingMs: 90 * 60_000 },
  // Distribution changes over hours, not minutes.
  holders: { freshMs: 6 * 3_600_000, agingMs: 24 * 3_600_000 },
  topHoldersPct: { freshMs: 6 * 3_600_000, agingMs: 24 * 3_600_000 },
  rugcheckRisk: { freshMs: 6 * 3_600_000, agingMs: 24 * 3_600_000 },
  organicScore: { freshMs: 6 * 3_600_000, agingMs: 24 * 3_600_000 },
  // Authority is revoked once and then never changes again. An old reading of
  // "revoked" stays true; an old reading of "live" is still worth acting on.
  mintAuthorityRevoked: { freshMs: 24 * 3_600_000, agingMs: 7 * 24 * 3_600_000 },
  freezeAuthorityRevoked: { freshMs: 24 * 3_600_000, agingMs: 7 * 24 * 3_600_000 },
};

/** Launch time is immutable, so it is never stale. */
const NEVER_STALE: FreshnessWindow = {
  freshMs: Number.POSITIVE_INFINITY,
  agingMs: Number.POSITIVE_INFINITY,
};

export function windowFor(metric: string): FreshnessWindow {
  return FRESHNESS[metric] ?? NEVER_STALE;
}

export function freshnessOf(metric: string, observedAt: number | null, now: number): Freshness {
  if (observedAt === null) return 'UNKNOWN';
  const age = now - observedAt;
  const window = windowFor(metric);
  if (age <= window.freshMs) return 'FRESH';
  if (age <= window.agingMs) return 'AGING';
  return 'STALE';
}

/**
 * How much each provider's word is worth on a given fact.
 *
 * Helius reads the chain directly, so on authority it is ground truth rather
 * than a report about it. RugCheck and Jupiter are both second-hand, and
 * Jupiter's audit block is the one observed to carry nulls where RugCheck
 * carries a finding (SCORING.md 5.2), so it ranks slightly lower on safety.
 */
export const PROVIDER_TRUST: Record<string, number> = {
  helius: 1.0,
  rugcheck: 0.95,
  dexscreener: 0.9,
  jupiter: 0.85,
};

export function trustOf(provider: string): number {
  return PROVIDER_TRUST[provider] ?? 0.7;
}

/** Confidence multiplier applied for an aging observation. */
const AGING_CONFIDENCE = 0.8;
/** Confidence multiplier applied when providers disagreed. */
const CONFLICT_CONFIDENCE = 0.6;

export function unknown<T>(notes: string[] = []): Evidence<T> {
  return {
    value: null,
    state: 'UNKNOWN',
    source: null,
    observedAt: null,
    freshness: 'UNKNOWN',
    confidence: 0,
    notes,
    claims: [],
  };
}

export function unavailable<T>(reason: string): Evidence<T> {
  return { ...unknown<T>([reason]), state: 'UNAVAILABLE' };
}

/** True when this evidence may contribute points. */
export function isUsable<T>(evidence: Evidence<T>): boolean {
  return (
    (evidence.state === 'MEASURED' || evidence.state === 'CONFLICTED') && evidence.value !== null
  );
}

export interface ResolveOptions<T> {
  metric: string;
  now: number;
  /**
   * Picks the winner when providers disagree. Returns the index of the claim
   * to believe. Safety facts pass a conservative chooser here.
   */
  resolveConflict?: (claims: Claim<T>[]) => number;
  /**
   * Picks the winner even when providers agree, overriding "most trusted wins".
   * Used where the conservative reading should be taken regardless of who said
   * it - liquidity, where the optimistic figure is the expensive one to believe.
   */
  chooseWinner?: (claims: Claim<T>[]) => number;
  /**
   * Compares two values for agreement. Defaults to strict equality.
   *
   * For metrics where providers measure overlapping but different things,
   * this is what separates "different scope" from "someone is wrong".
   */
  equal?: (a: T, b: T) => boolean;
}

/**
 * Resolves one fact from every provider that spoke about it.
 *
 * The rules, in order:
 *
 * 1. **Invalid only.** Every provider that answered was rejected by validation
 *    -> INVALID. Never UNKNOWN: we did get an answer, it was just unusable, and
 *    that is a different thing to report.
 * 2. **Silence.** Nobody answered -> UNKNOWN.
 * 3. **One voice.** Exactly one valid claim -> MEASURED at that provider's trust.
 * 4. **Agreement.** Valid claims that agree -> MEASURED, confidence from the
 *    most trusted of them, since corroboration cannot make us less sure.
 * 5. **Contradiction.** -> CONFLICTED. `value` is whatever `resolveConflict`
 *    picks (for safety facts, the dangerous reading), confidence is reduced,
 *    and every claim is retained so the disagreement stays visible.
 *
 * Staleness is applied last: a winner older than its aging window becomes
 * STALE and stops being usable, whatever its provenance.
 */
export function resolve<T>(claims: Claim<T>[], options: ResolveOptions<T>): Evidence<T> {
  const { metric, now } = options;
  const equal = options.equal ?? ((a: T, b: T): boolean => a === b);

  const answered = claims.filter((claim) => claim.value !== null || claim.invalid !== undefined);
  const valid = claims.filter((claim) => claim.value !== null && claim.invalid === undefined);
  const invalid = claims.filter((claim) => claim.invalid !== undefined);

  if (answered.length === 0) return { ...unknown<T>(), claims };

  if (valid.length === 0) {
    return {
      value: null,
      state: 'INVALID',
      source: invalid[0]?.provider ?? null,
      observedAt: invalid[0]?.observedAt ?? null,
      freshness: 'UNKNOWN',
      confidence: 0,
      notes: invalid.map((claim) => `${claim.provider}: rejected - ${claim.invalid}`),
      claims,
    };
  }

  const notes = invalid.map((claim) => `${claim.provider}: rejected - ${claim.invalid}`);

  const first = valid[0] as Claim<T>;
  const disagreeing = valid.filter((claim) => !equal(claim.value as T, first.value as T));

  let winner: Claim<T>;
  let state: EvidenceState;
  let confidence: number;

  if (disagreeing.length === 0) {
    winner =
      options.chooseWinner !== undefined
        ? ((valid[options.chooseWinner(valid)] ?? first) as Claim<T>)
        : valid.reduce((best, claim) =>
            trustOf(claim.provider) > trustOf(best.provider) ? claim : best,
          );
    state = 'MEASURED';
    confidence = trustOf(winner.provider);
    if (valid.length > 1) {
      notes.push(
        `${valid.map((claim) => `${claim.provider}=${String(claim.value)}`).join(', ')}; within tolerance, took ${winner.provider}`,
      );
    }
  } else {
    const index = options.resolveConflict ? options.resolveConflict(valid) : 0;
    winner = (valid[index] ?? first) as Claim<T>;
    state = 'CONFLICTED';
    confidence = trustOf(winner.provider) * CONFLICT_CONFIDENCE;
    notes.push(
      `providers disagree: ${valid
        .map((claim) => `${claim.provider}=${String(claim.value)}`)
        .join(' vs ')}; took ${winner.provider}`,
    );
  }

  const freshness = freshnessOf(metric, winner.observedAt, now);
  if (freshness === 'STALE') {
    return {
      value: null,
      state: 'STALE',
      source: winner.provider,
      observedAt: winner.observedAt,
      freshness,
      confidence: 0,
      notes: [...notes, `observation is older than the ${metric} aging window`],
      claims,
    };
  }
  if (freshness === 'AGING') confidence *= AGING_CONFIDENCE;

  return {
    value: winner.value,
    state,
    source: winner.provider,
    observedAt: winner.observedAt,
    freshness,
    confidence: Math.round(confidence * 1000) / 1000,
    notes,
    claims,
  };
}

/**
 * The full evidence set for one token. Every downstream stage - gate, signals,
 * coverage, scoring - reads only this.
 */
export interface TokenEvidence {
  liquidityUsd: Evidence<number>;
  /**
   * DexScreener-only depth, used solely as the turnover denominator so the
   * ratio stays within one venue's own observation. Not part of coverage:
   * it is the same underlying fact as {@link TokenEvidence.liquidityUsd},
   * and counting it twice would inflate how much we appear to know.
   */
  venueLiquidityUsd: Evidence<number>;
  volume24h: Evidence<number>;
  priceChange: Evidence<{ m5: number; h1: number; h6: number; h24: number }>;
  buyPressure: Evidence<number>;
  holders: Evidence<number>;
  ageHours: Evidence<number>;
  mintAuthorityRevoked: Evidence<boolean>;
  freezeAuthorityRevoked: Evidence<boolean>;
  topHoldersPct: Evidence<number>;
  rugcheckRisk: Evidence<number>;
  organicScore: Evidence<number>;
  /** Whether any venue can actually be traded against. */
  tradable: Evidence<boolean>;
  /** Every field rejected at a provider boundary during this analysis. */
  issues: FieldIssue[];
  /** Metrics whose providers disagreed. */
  conflicts: string[];
}

export const EVIDENCE_KEYS = [
  'liquidityUsd',
  'volume24h',
  'priceChange',
  'buyPressure',
  'holders',
  'ageHours',
  'mintAuthorityRevoked',
  'freezeAuthorityRevoked',
  'topHoldersPct',
  'rugcheckRisk',
  'organicScore',
  'tradable',
] as const satisfies readonly (keyof TokenEvidence)[];
