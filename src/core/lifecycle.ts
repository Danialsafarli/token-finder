/**
 * Coverage accounting, ranking eligibility and the token lifecycle.
 *
 * Three numbers are kept apart on purpose:
 *
 *   score       how good the token looks
 *   coverage    how much of that rests on real observation
 *   confidence  how much the observations themselves are worth
 *
 * A token can score 80 on two measured signals out of twelve. Collapsing these
 * into one figure is precisely what lets that token look like a strong
 * candidate, so nothing here ever multiplies them together.
 */

import { isUsable, type Evidence, type TokenEvidence } from './evidence.ts';
import type { CoverageReport, Eligibility, TokenState, Veto } from '../types.ts';

/**
 * Weight each signal carries in the coverage calculation.
 *
 * These mirror the scoring weights so "coverage" answers the question that
 * matters: what share of the *score* was actually observed. Safety is split
 * across its four evidence inputs.
 */
export const COVERAGE_WEIGHTS: Partial<
  Record<keyof Omit<TokenEvidence, 'issues' | 'conflicts'>, number>
> = {
  // `venueLiquidityUsd` is deliberately absent. It is the same underlying fact
  // as `liquidityUsd`, kept separately only so turnover divides by the depth of
  // the venue that reported the volume. Counting it here would inflate how much
  // we appear to know from one measurement.
  //
  // `tokenProgram` is absent for the same reason: it is the key needed to read
  // the extension list, not an independent observation, and counting both
  // would charge twice for one call to one provider.
  //
  // `mintExtensions` IS counted, at the same weight as freeze authority,
  // because it answers a question of the same severity - whether a third party
  // can take or trap the position - and because leaving it out would make "we
  // could not tell whether this mint has a permanent delegate" cost nothing.
  // Missing safety evidence has to reduce coverage or the number means less
  // than it claims. Note the consequence: with no Helius key configured this
  // signal is UNAVAILABLE for every token, and coverage is correspondingly
  // lower than it was before this weight existed.
  liquidityUsd: 0.18,
  volume24h: 0.07,
  priceChange: 0.12,
  buyPressure: 0.09,
  holders: 0.13,
  ageHours: 0.08,
  mintAuthorityRevoked: 0.078,
  freezeAuthorityRevoked: 0.052,
  topHoldersPct: 0.052,
  rugcheckRisk: 0.052,
  organicScore: 0.026,
  tradable: 0.07,
  mintExtensions: 0.052,
};

/** Confidence lost when one provider supplies most of the evidence. */
const CONCENTRATION_PENALTY = 0.25;

export function buildCoverage(evidence: TokenEvidence): CoverageReport {
  const entries = Object.entries(COVERAGE_WEIGHTS) as [
    keyof Omit<TokenEvidence, 'issues' | 'conflicts'>,
    number,
  ][];

  let measured = 0;
  let unknownCount = 0;
  let conflicted = 0;
  let invalid = 0;
  let stale = 0;
  let unavailable = 0;

  let coveredWeight = 0;
  let totalWeight = 0;
  let confidenceWeighted = 0;

  const byProvider = new Map<string, number>();

  for (const [key, weight] of entries) {
    const item = evidence[key] as Evidence<unknown>;
    totalWeight += weight;

    switch (item.state) {
      case 'MEASURED':
        measured++;
        break;
      case 'CONFLICTED':
        conflicted++;
        break;
      case 'INVALID':
        invalid++;
        break;
      case 'STALE':
        stale++;
        break;
      case 'UNAVAILABLE':
        unavailable++;
        break;
      default:
        unknownCount++;
    }

    if (isUsable(item)) {
      coveredWeight += weight;
      confidenceWeighted += weight * item.confidence;
      if (item.source !== null) {
        byProvider.set(item.source, (byProvider.get(item.source) ?? 0) + weight);
      }
    }
  }

  const coverage = totalWeight > 0 ? coveredWeight / totalWeight : 0;

  // Provider concentration: how much of what we DO know came from one source.
  let dominantProvider: string | null = null;
  let dominantWeight = 0;
  for (const [provider, weight] of byProvider) {
    if (weight > dominantWeight) {
      dominantWeight = weight;
      dominantProvider = provider;
    }
  }
  const providerConcentration = coveredWeight > 0 ? dominantWeight / coveredWeight : 0;

  // Confidence is the evidence-weighted mean of per-signal confidence, scaled
  // down when a single provider dominates. It is NOT multiplied by coverage:
  // they answer different questions and are reported separately.
  const meanConfidence = coveredWeight > 0 ? confidenceWeighted / coveredWeight : 0;
  const concentrationFactor = 1 - CONCENTRATION_PENALTY * Math.max(0, providerConcentration - 0.5) * 2;
  const confidence = Math.max(0, meanConfidence * concentrationFactor);

  return {
    eligibleSignals: entries.length,
    measured,
    unknown: unknownCount,
    conflicted,
    invalid,
    stale,
    unavailable,
    coverage: Math.round(coverage * 1000) / 1000,
    confidence: Math.round(confidence * 1000) / 1000,
    providerConcentration: Math.round(providerConcentration * 1000) / 1000,
    dominantProvider,
  };
}

export interface EligibilityConfig {
  /** Coverage at or above which a clean token can enter the main ranking. */
  minCoverageQualify: number;
  /**
   * Coverage below which the score is mostly a statement about what we failed
   * to observe, rather than about the token.
   */
  minCoverageWatch: number;
}

export const DEFAULT_ELIGIBILITY: EligibilityConfig = {
  minCoverageQualify: 0.6,
  minCoverageWatch: 0.35,
};

/**
 * Ranking eligibility.
 *
 * A numeric score is not a licence to appear in the ranking. Order matters: a
 * veto outranks everything, so a token cannot buy its way past the gate with a
 * strong score on its remaining signals.
 */
export function evaluateEligibility(
  vetoes: Veto[],
  coverage: CoverageReport,
  config: EligibilityConfig = DEFAULT_ELIGIBILITY,
): Eligibility {
  if (vetoes.length > 0) return 'REJECTED';
  if (coverage.coverage < config.minCoverageWatch) return 'INSUFFICIENT_DATA';
  if (coverage.coverage < config.minCoverageQualify) return 'WATCH';
  return 'QUALIFIED';
}

/**
 * Eligibility maps one-to-one onto the resting states of the lifecycle. The
 * verdict is decided in decision/engine.ts; this only names the state.
 */
export function stateForEligibility(eligibility: Eligibility): TokenState {
  return eligibility;
}

/**
 * Legal transitions.
 *
 * Every resting state can re-enter SCANNING, because fresh evidence must be
 * able to move a token in any direction - including out of REJECTED, when the
 * veto that put it there was re-checkable and no longer fires. Nothing here is
 * irreversible: a permanent state would mean trusting one observation forever.
 */
const RESTING: readonly TokenState[] = ['HIGH_POTENTIAL', 'QUALIFIED', 'WATCH', 'INSUFFICIENT_DATA', 'HIGH_RISK', 'REJECTED'];
const TRANSITIONS: Record<TokenState, readonly TokenState[]> = {
  DISCOVERED: ['SCANNING'],
  SCANNING: [...RESTING, 'SCANNING'],
  HIGH_POTENTIAL: ['SCANNING'],
  QUALIFIED: ['SCANNING'],
  WATCH: ['SCANNING'],
  INSUFFICIENT_DATA: ['SCANNING'],
  HIGH_RISK: ['SCANNING'],
  REJECTED: ['SCANNING'],
};

export function canTransition(from: TokenState, to: TokenState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: TokenState): readonly TokenState[] {
  return TRANSITIONS[from];
}

/**
 * Applies a transition, returning the new state and whether it actually moved.
 *
 * An illegal transition is refused rather than silently applied, so a bug in a
 * caller surfaces as a token stuck in a state rather than as a token that
 * teleported past the gate.
 */
export function transition(
  from: TokenState,
  to: TokenState,
): { state: TokenState; moved: boolean; legal: boolean } {
  if (from === to) return { state: from, moved: false, legal: true };
  if (!canTransition(from, to)) return { state: from, moved: false, legal: false };
  return { state: to, moved: true, legal: true };
}

/**
 * The full path a re-analysed token takes: whatever it was, through SCANNING,
 * to whatever the fresh evidence says it is now.
 */
export function settleState(previous: TokenState | null, eligibility: Eligibility): TokenState {
  const target = stateForEligibility(eligibility);
  if (previous === null) return target;

  const scanning = transition(previous, 'SCANNING');
  const settled = transition(scanning.state, target);
  return settled.legal ? settled.state : previous;
}
