/**
 * Quality / Opportunity: among tokens that survived the gate, which look more
 * interesting right now?
 *
 * Deliberately separate from integrity. A dangerous token must not become
 * attractive because it is moving, so nothing here can lift a verdict: the
 * engine reads this only after the gate and the integrity bands have spoken,
 * and only a clean, well-covered token can turn a strong opportunity into
 * HIGH_POTENTIAL.
 *
 * | Component | Weight | Measures |
 * |---|---|---|
 * | Participation | 0.22 | independent buyers (clusters count once, bots part, unknowns nothing) and holder breadth |
 * | Capital quality | 0.18 | who the volume came from, and turnover near a healthy band |
 * | Liquidity depth | 0.18 | pooled liquidity, log-scaled |
 * | Distribution | 0.12 | role-aware wallet concentration |
 * | Momentum | 0.20 | Momentum v2's state score |
 * | Maturity | 0.10 | age, and how long Token Finder has observed it |
 *
 * Every component follows the project's rule: an unmeasured part earns zero
 * and keeps its weight, so opportunity cannot be assembled from what we failed
 * to see. Transaction count is never rewarded on its own: a hundred wallets in
 * one cluster are one participant.
 */

import { usableIntel } from './contract.ts';
import { MODEL_VERSIONS } from './versions.ts';
import type { TokenSnapshot } from '../types.ts';
import type { IntelligenceBundle, MomentumAssessment, OpportunityAssessment, OpportunityBand, OpportunityComponent } from './types.ts';

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const logScore = (v: number, lo: number, hi: number): number => (v <= lo ? 0 : v >= hi ? 1 : Math.log(v / lo) / Math.log(hi / lo));

/** Independence weight per activity class. Unknown earns nothing: not evidence. */
export const INDEPENDENCE = { likely_organic: 1, automated: 0.5, sniper: 0.25, unknown: 0 } as const;

function legacyComponent(token: TokenSnapshot, key: string): number | null {
  const c = token.score.components.find((x) => x.key === key);
  return c && c.value !== null ? c.value : null;
}

interface Part {
  w: number;
  value: number | null;
  note: string;
}

/** Sub-parts with fixed weights; unknown ones earn zero and reduce coverage. */
function combine(parts: Part[]): { value: number | null; coverage: number; detail: string } {
  const total = parts.reduce((s, p) => s + p.w, 0);
  const known = parts.filter((p) => p.value !== null);
  if (known.length === 0) return { value: null, coverage: 0, detail: parts.map((p) => p.note).join('; ') };
  return {
    value: known.reduce((s, p) => s + p.w * (p.value as number), 0) / total,
    coverage: known.reduce((s, p) => s + p.w, 0) / total,
    detail: parts.map((p) => p.note).join('; '),
  };
}

export function assessOpportunity(
  token: TokenSnapshot,
  bundle: IntelligenceBundle,
  momentum: MomentumAssessment,
  observedSpanMs: number,
): OpportunityAssessment {
  const activity = usableIntel(bundle.activity) ? bundle.activity.value : null;
  const coordination = usableIntel(bundle.coordination) ? bundle.coordination.value : null;

  // --- participation ------------------------------------------------------------
  let effective: number | null = null;
  if (activity && activity.byWallets.total >= 5) {
    const c = activity.byWallets.counts;
    // A cluster is one actor however many wallets it uses.
    const clusters = c.coordinated > 0 ? Math.max(1, Math.min(c.coordinated, coordination?.clusters ?? 1)) : 0;
    effective = c.likely_organic * INDEPENDENCE.likely_organic + c.automated * INDEPENDENCE.automated + c.sniper * INDEPENDENCE.sniper + clusters;
  }
  const holders = token.holders;
  const participation = combine([
    { w: 0.6, value: effective === null ? null : logScore(effective, 3, 60), note: effective === null ? 'independent buyers not measured' : `${effective.toFixed(1)} independent participants among ${activity!.byWallets.total} trading wallets` },
    { w: 0.4, value: holders === null ? null : logScore(holders, 50, 5_000), note: holders === null ? 'holder count unknown' : `${holders.toLocaleString('en-US')} holders` },
  ]);

  // --- capital quality -----------------------------------------------------------
  const volumeShares = activity?.byVolume.shares ?? null;
  const quality = volumeShares
    ? clamp01(volumeShares.likely_organic * INDEPENDENCE.likely_organic + volumeShares.automated * INDEPENDENCE.automated + volumeShares.sniper * INDEPENDENCE.sniper)
    : null;
  const turnover = legacyComponent(token, 'activity');
  const capital = combine([
    { w: 0.6, value: quality, note: quality === null ? 'volume composition not measured' : `${Math.round((volumeShares!.likely_organic) * 100)}% of volume from likely-organic wallets, ${Math.round(volumeShares!.coordinated * 100)}% coordinated` },
    { w: 0.4, value: turnover, note: turnover === null ? 'turnover unknown' : `turnover ${turnover >= 0.6 ? 'near' : 'away from'} a healthy band` },
  ]);

  // --- liquidity ------------------------------------------------------------------
  const liq = legacyComponent(token, 'liquidity');
  const liquidity = { value: liq, coverage: liq === null ? 0 : 1, detail: token.liquidityUsd === null ? 'liquidity unknown' : `$${Math.round(token.liquidityUsd).toLocaleString('en-US')} pooled` };

  // --- distribution -----------------------------------------------------------------
  const h = bundle.holders.value;
  const pct = h ? (h.roleAware ? h.walletTop10Pct : h.providerTopPct) : null;
  const distribution = {
    value: pct === null ? null : 1 - clamp01((pct - 15) / 60),
    coverage: pct === null ? 0 : h?.roleAware ? 1 : 0.7,
    detail: pct === null ? 'concentration not measured' : `${h?.roleAware ? 'wallet-only' : 'provider'} top holders ${Math.round(pct)}%`,
  };

  // --- momentum -----------------------------------------------------------------------
  const momentumPart = {
    value: momentum.score,
    coverage: momentum.score === null ? 0 : 1,
    detail: momentum.state === 'INSUFFICIENT_HISTORY' ? 'not enough observed history' : `${momentum.state.toLowerCase()} (confidence ${momentum.confidence.toFixed(2)})`,
  };

  // --- maturity -------------------------------------------------------------------------
  const age = legacyComponent(token, 'age');
  const maturity = combine([
    { w: 0.7, value: age, note: token.ageHours === null ? 'age unknown' : `${token.ageHours < 1 ? `${Math.round(token.ageHours * 60)} min` : `${token.ageHours.toFixed(1)} h`} old` },
    { w: 0.3, value: clamp01(observedSpanMs / (6 * 3_600_000)), note: `observed for ${Math.round(observedSpanMs / 60_000)} min` },
  ]);

  const components: OpportunityComponent[] = [
    { key: 'participation', label: 'Participation', weight: 0.22, value: participation.value, coverage: participation.coverage, detail: participation.detail },
    { key: 'capital', label: 'Capital quality', weight: 0.18, value: capital.value, coverage: capital.coverage, detail: capital.detail },
    { key: 'liquidity', label: 'Liquidity depth', weight: 0.18, value: liquidity.value, coverage: liquidity.coverage, detail: liquidity.detail },
    { key: 'distribution', label: 'Distribution', weight: 0.12, value: distribution.value, coverage: distribution.coverage, detail: distribution.detail },
    { key: 'momentum', label: 'Momentum', weight: 0.2, value: momentumPart.value, coverage: momentumPart.coverage, detail: momentumPart.detail },
    { key: 'maturity', label: 'Maturity', weight: 0.1, value: maturity.value, coverage: maturity.coverage, detail: maturity.detail },
  ].map((c) => ({ ...c, value: c.value === null ? null : Math.round(c.value * 1000) / 1000, coverage: Math.round(c.coverage * 1000) / 1000 })) as OpportunityComponent[];

  const score = components.reduce((s, c) => s + c.weight * (c.value ?? 0), 0) * 100;
  const coverage = components.reduce((s, c) => s + c.weight * c.coverage, 0);
  const band: OpportunityBand = coverage < 0.4 ? 'UNKNOWN' : score >= 65 ? 'STRONG' : score >= 45 ? 'MODERATE' : 'WEAK';

  return {
    model: MODEL_VERSIONS.opportunity,
    score: Math.round(score * 10) / 10,
    band,
    coverage: Math.round(coverage * 1000) / 1000,
    components,
    effectiveParticipants: effective === null ? null : Math.round(effective * 10) / 10,
  };
}
