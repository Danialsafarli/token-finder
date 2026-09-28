/**
 * The Decision Engine.
 *
 *   DISCOVERY -> FAST SCREEN -> DEEP ANALYSIS -> DECISION
 *                (core/analyze)  (intel loop,     (here, at scan time,
 *                                 async)           from stored readings)
 *
 * Two questions, kept apart until the very end:
 *
 *   1. SAFETY / INTEGRITY - can this token be trusted enough to remain a
 *      candidate? Hard Gate v2 (decision/gate.ts) and the soft-risk
 *      integrity model (decision/integrity.ts).
 *   2. QUALITY / OPPORTUNITY - among survivors, which look more interesting?
 *      decision/opportunity.ts and decision/momentum.ts.
 *
 * ## The verdict ladder (decision-policy@1), evaluated in order
 *
 * | # | Verdict | When |
 * |---|---|---|
 * | 1 | REJECTED | any hard fail. Nothing below can override it - not momentum, not opportunity |
 * | 2 | INSUFFICIENT_DATA | market-evidence coverage below `minCoverageWatch` (0.35) |
 * | 3 | HIGH_RISK | integrity band HIGH or SEVERE - which needs confident evidence (decision/integrity.ts) |
 * | 4 | WATCH | market coverage below `minCoverageQualify` (0.6) |
 * | 5 | HIGH_POTENTIAL | every {@link HIGH_POTENTIAL} condition holds |
 * | 6 | QUALIFIED | otherwise |
 *
 * Deep intelligence can make a verdict *worse* (a hard fail, HIGH_RISK) on
 * confident evidence, and is *required* for HIGH_POTENTIAL. Its absence never
 * makes a verdict better: a token no one has analysed stays at most QUALIFIED,
 * and "no findings in a thin sample" is never counted as clean.
 *
 * ## Ranking inside a verdict
 *
 *   rank = opportunity - 40 x integrity risk - 10 x (1 - integrity coverage)
 *
 * The second term charges measured soft risk; the third charges what we could
 * not check, so an unanalysed token never outranks an equally good verified
 * one. Rejected tokens are not ranked at all.
 */

import { settleState } from '../core/lifecycle.ts';
import { assessIntegrity } from './integrity.ts';
import { assessOpportunity } from './opportunity.ts';
import { assessMomentum, type MarketObservation } from './momentum.ts';
import { hardGateV2 } from './gate.ts';
import { usableIntel } from './contract.ts';
import { DECISION_POLICY_VERSION, MODEL_VERSIONS } from './versions.ts';
import type { Eligibility, TokenSnapshot, TokenState } from '../types.ts';
import type { Decision, IntegrityAssessment, IntelligenceBundle, MomentumAssessment, OpportunityAssessment, Reason } from './types.ts';

export interface DecisionConfig {
  minCoverageQualify: number;
  minCoverageWatch: number;
}

/** Every condition HIGH_POTENTIAL needs. All of them; none is traded against another. */
export const HIGH_POTENTIAL = {
  minMarketCoverage: 0.7,
  minIntelligenceCoverage: 0.5,
  minIntegrityCoverage: 0.6,
  integrityBands: ['CLEAR', 'LOW'] as readonly string[],
  minOpportunity: 65,
  minOpportunityCoverage: 0.7,
  momentumStates: ['ACCELERATING', 'SUSTAINED'] as readonly string[],
  minMomentumConfidence: 0.5,
} as const;

export const RANK = { integrityPenalty: 40, uncertaintyPenalty: 10 } as const;

export interface DecisionInput {
  snapshot: TokenSnapshot;
  bundle: IntelligenceBundle;
  /** Stored market observations for this token, any order; the current one is added here. */
  history: MarketObservation[];
  now: number;
  config: DecisionConfig;
}

const r1 = (x: number): number => Math.round(x * 10) / 10;
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const pct = (x: number): string => `${Math.round(x * 100)}%`;

function observations(input: DecisionInput): MarketObservation[] {
  const s = input.snapshot;
  return [...input.history, { t: s.at, price: s.priceUsd, liquidity: s.liquidityUsd, holders: s.holders }];
}

function reasonsFor(
  s: TokenSnapshot,
  integrity: IntegrityAssessment,
  opportunity: OpportunityAssessment,
  momentum: MomentumAssessment,
  bundle: IntelligenceBundle,
  blockers: string[],
  coverage: Decision['coverage'],
): Reason[] {
  const out: Reason[] = [];
  const hardFails = s.evaluation?.vetoes ?? [];
  for (const v of hardFails.slice(0, 3)) out.push({ kind: 'hard_fail', code: v.code, text: v.reason, domain: v.family });

  // Positives: only what was actually measured and found good.
  const participation = opportunity.components.find((c) => c.key === 'participation');
  if (opportunity.effectiveParticipants !== null && opportunity.effectiveParticipants >= 10 && (participation?.coverage ?? 0) >= 0.9) {
    out.push({ kind: 'positive', code: 'INDEPENDENT_BUYERS', text: `strong independent buyer participation (${opportunity.effectiveParticipants} independent participants)`, domain: 'participation' });
  }
  const liquidity = opportunity.components.find((c) => c.key === 'liquidity');
  if ((liquidity?.value ?? 0) >= 0.6) out.push({ kind: 'positive', code: 'HEALTHY_LIQUIDITY', text: `healthy liquidity (${liquidity!.detail})`, domain: 'liquidity' });
  const token = integrity.domains.find((d) => d.key === 'tokenSecurity');
  if (token && token.clean.includes('mint authority revoked') && token.clean.includes('freeze authority revoked') && hardFails.length === 0) {
    out.push({ kind: 'positive', code: 'NO_AUTHORITY_RISK', text: 'no critical authority risk (mint and freeze revoked)', domain: 'tokenSecurity' });
  }
  if (momentum.state === 'SUSTAINED' || momentum.state === 'ACCELERATING') out.push({ kind: 'positive', code: `MOMENTUM_${momentum.state}`, text: `${momentum.state.toLowerCase()} momentum: ${momentum.reasons[0] ?? ''}`, domain: 'momentum' });
  const creator = integrity.domains.find((d) => d.key === 'creatorReputation');
  if (creator?.clean.length) out.push({ kind: 'positive', code: 'CREATOR_CLEAN', text: creator.clean[0]!, domain: 'creatorReputation' });
  const wash = bundle.wash.value;
  if (usableIntel(bundle.wash) && wash?.risk === 'LOW' && bundle.wash.coverage >= 0.5) out.push({ kind: 'positive', code: 'WASH_LOW', text: 'no material wash or manipulation pattern in a representative sample', domain: 'walletCoordination' });

  // Risks: the strongest soft-risk contributions, across domains.
  const risks = integrity.domains
    .flatMap((d) => d.contributions.map((c) => ({ ...c, domain: d.key })))
    .sort((a, b) => b.risk - a.risk)
    .slice(0, 5);
  for (const r of risks) out.push({ kind: 'risk', code: r.code, text: r.text, domain: r.domain });
  if (momentum.state === 'UNSTABLE' || momentum.state === 'DECLINING') out.push({ kind: 'risk', code: `MOMENTUM_${momentum.state}`, text: `${momentum.state.toLowerCase()} price action: ${momentum.reasons[0] ?? ''}`, domain: 'momentum' });

  for (const b of blockers) out.push({ kind: 'blocker', code: 'NOT_HIGHER', text: b });
  out.push({
    kind: 'coverage',
    code: 'COVERAGE',
    text: `coverage ${pct(coverage.decision)} (market evidence ${pct(coverage.market)}, deep intelligence ${pct(coverage.intelligence)})`,
  });
  return out;
}

export function decide(input: DecisionInput): Decision {
  const { snapshot: s, bundle, now, config } = input;
  const evaluation = s.evaluation;
  const screenEligibility = evaluation?.eligibility ?? 'INSUFFICIENT_DATA';
  const legacyVetoes = evaluation?.vetoes ?? [];

  const momentum = assessMomentum(observations(input), now, s.priceChange ? { m5: s.priceChange.m5, h1: s.priceChange.h1, h6: s.priceChange.h6, h24: s.priceChange.h24 } : null);
  const gate = hardGateV2(legacyVetoes, bundle, now);
  const integrity = assessIntegrity(s, bundle, momentum);
  const spanMs = momentum.spanMs;
  const opportunity = assessOpportunity(s, bundle, momentum, spanMs);

  const market = evaluation?.coverage.coverage ?? 0;
  const intelligence = bundle.coverage;
  const coverage = { market: r3(market), intelligence: r3(intelligence), decision: r3(0.6 * market + 0.4 * intelligence) };
  const confidence = r3(0.6 * (evaluation?.coverage.confidence ?? 0) + 0.4 * integrity.confidence);

  // --- the ladder ------------------------------------------------------------
  const blockers: string[] = [];
  let verdict: Eligibility;
  let basis: string;
  if (gate.hardFails.length > 0) {
    verdict = 'REJECTED';
    basis = `hard fail: ${gate.families.join(', ')}`;
  } else if (market < config.minCoverageWatch) {
    verdict = 'INSUFFICIENT_DATA';
    basis = `market evidence coverage ${pct(market)} is below ${pct(config.minCoverageWatch)}`;
  } else if (integrity.band === 'HIGH' || integrity.band === 'SEVERE') {
    verdict = 'HIGH_RISK';
    const driver = integrity.domains.find((d) => d.key === integrity.driver);
    basis = driver ? `serious integrity risk: ${driver.label.toLowerCase()} is ${driver.band === 'SEVERE' ? 'severe' : 'high'} risk` : 'serious integrity risk across several domains';
  } else if (market < config.minCoverageQualify) {
    verdict = 'WATCH';
    basis = `market evidence coverage ${pct(market)} is below ${pct(config.minCoverageQualify)}`;
    blockers.push(`qualifies at ${pct(config.minCoverageQualify)} market evidence coverage`);
  } else {
    const hp = HIGH_POTENTIAL;
    if (market < hp.minMarketCoverage) blockers.push(`market evidence coverage ${pct(market)} (needs ${pct(hp.minMarketCoverage)})`);
    if (intelligence < hp.minIntelligenceCoverage) blockers.push(`deep intelligence coverage ${pct(intelligence)} (needs ${pct(hp.minIntelligenceCoverage)})`);
    if (integrity.coverage < hp.minIntegrityCoverage) blockers.push(`integrity coverage ${pct(integrity.coverage)} (needs ${pct(hp.minIntegrityCoverage)})`);
    if (!hp.integrityBands.includes(integrity.band)) blockers.push(`integrity ${integrity.band.toLowerCase()} (needs clear or low)`);
    if (opportunity.score < hp.minOpportunity) blockers.push(`opportunity ${Math.round(opportunity.score)} (needs ${hp.minOpportunity})`);
    if (opportunity.coverage < hp.minOpportunityCoverage) blockers.push(`opportunity coverage ${pct(opportunity.coverage)} (needs ${pct(hp.minOpportunityCoverage)})`);
    if (!hp.momentumStates.includes(momentum.state)) blockers.push(`momentum ${momentum.state.toLowerCase().replace('_', ' ')} (needs sustained or accelerating)`);
    else if (momentum.confidence < hp.minMomentumConfidence) blockers.push(`momentum confidence ${momentum.confidence.toFixed(2)} (needs ${hp.minMomentumConfidence})`);
    if (blockers.length === 0) {
      verdict = 'HIGH_POTENTIAL';
      basis = 'safe, well covered, strong opportunity and real momentum';
    } else {
      verdict = 'QUALIFIED';
      basis = 'no hard fail, no actionable integrity risk, sufficient market evidence';
    }
  }

  // --- rank -------------------------------------------------------------------
  let rankScore: number | null = null;
  let rank: Decision['rank'] = null;
  if (verdict !== 'REJECTED') {
    const integrityPenalty = RANK.integrityPenalty * integrity.risk;
    const uncertaintyPenalty = RANK.uncertaintyPenalty * (1 - integrity.coverage);
    rankScore = r1(Math.max(0, Math.min(100, opportunity.score - integrityPenalty - uncertaintyPenalty)));
    rank = { opportunity: r1(opportunity.score), integrityPenalty: r1(integrityPenalty), uncertaintyPenalty: r1(uncertaintyPenalty) };
  }

  const decided: Decision = {
    policyVersion: DECISION_POLICY_VERSION,
    models: { ...MODEL_VERSIONS },
    decidedAt: now,
    verdict,
    screen: { eligibility: screenEligibility, vetoes: legacyVetoes.map((v) => v.code) },
    hardFails: gate.hardFails,
    hardFailFamilies: gate.families,
    integrity,
    opportunity,
    momentum,
    intelligence: {
      analyzedAt: bundle.analyzedAt,
      coverage: bundle.coverage,
      domains: [bundle.activity, bundle.wash, bundle.coordination, bundle.attribution, bundle.creator, bundle.network, bundle.security, bundle.holders].map((d) => ({
        key: d.domain,
        status: d.status,
        coverage: d.coverage,
        freshness: d.freshness,
        ruleVersion: d.ruleVersion,
        note: d.note,
      })),
    },
    coverage,
    confidence,
    rankScore,
    rank,
    reasons: [],
    basis,
  };
  const withVetoes: TokenSnapshot = { ...s, evaluation: evaluation ? { ...evaluation, vetoes: gate.hardFails } : evaluation };
  decided.reasons = reasonsFor(withVetoes, integrity, opportunity, momentum, bundle, verdict === 'QUALIFIED' || verdict === 'WATCH' ? blockers : [], coverage);
  return decided;
}

/**
 * Writes a decision into a snapshot: the verdict becomes the eligibility, the
 * hard fails become the vetoes, and the lifecycle settles through SCANNING
 * from the token's previous state. REJECTED <=> at least one hard fail,
 * always.
 */
export function applyDecision(snapshot: TokenSnapshot, decision: Decision, previousState: TokenState | null): TokenSnapshot {
  const evaluation = snapshot.evaluation;
  if (!evaluation) return { ...snapshot, decision };
  const state = settleState(previousState, decision.verdict);
  return {
    ...snapshot,
    evaluation: {
      ...evaluation,
      eligibility: decision.verdict,
      state,
      previousState,
      vetoes: decision.hardFails,
    },
    decision,
  };
}
