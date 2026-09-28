/**
 * Safety / Integrity assessment: the soft-risk model.
 *
 * The hard gate answers "must this be removed?". This answers the softer
 * question: of what did not justify rejection, how much should still count
 * against the token, how sure are we, and on what evidence?
 *
 * ## Structure
 *
 * Seven domains, each built from contributions:
 *
 * | Domain | Weight | Reads |
 * |---|---|---|
 * | Token security | 0.20 | authorities, Token-2022 penalty extensions, RugCheck score and findings, authority reassignment |
 * | Liquidity safety | 0.15 | depth, LP findings, suspected drains, liquidity leaving |
 * | Holder integrity | 0.15 | role-aware concentration (never the raw figure), creator selling |
 * | Activity integrity | 0.15 | automated, sniper and organic shares of trading |
 * | Wallet coordination | 0.15 | coordinated trading, wash/manipulation |
 * | Creator reputation | 0.10 | the attributed creator's other launches, current rules only |
 * | Rug / malicious history | 0.10 | suspected events on this token, the serial network |
 *
 * ## Double counting
 *
 * Correlated evidence shares a *family*. Within a family only the strongest
 * contribution counts. Across families inside one domain the strongest counts
 * fully and each other adds a quarter of itself: shared funding, clustering
 * and coordinated trading are largely one observation seen three ways, and
 * summing them would charge a token three times for one fact. Domains are then
 * aggregated by weight - never multiplied together.
 *
 * ## Coverage and confidence
 *
 * A domain with nothing measured has risk `null` and band UNKNOWN - never
 * CLEAR. A risk becomes actionable (HIGH or SEVERE) only when the evidence
 * behind it has confidence >= 0.5; below that it is capped at ELEVATED, so
 * a thin sample can inform but not condemn. The integrity score earns nothing
 * for an unmeasured domain, exactly like the Phase 1 score: a beautiful number
 * on poor coverage cannot happen, because poor coverage caps the number.
 *
 * Bots are not scams: automation alone can reach ELEVATED, never HIGH.
 */

import { usableIntel } from './contract.ts';
import { MODEL_VERSIONS } from './versions.ts';
import type { TokenSnapshot } from '../types.ts';
import type {
  IntegrityAssessment,
  IntegrityDomain,
  IntegrityDomainKey,
  IntelligenceBundle,
  MomentumAssessment,
  RiskBand,
  RiskContribution,
} from './types.ts';

export const INTEGRITY_WEIGHTS: Record<IntegrityDomainKey, number> = {
  tokenSecurity: 0.2,
  liquiditySafety: 0.15,
  holderIntegrity: 0.15,
  activityIntegrity: 0.15,
  walletCoordination: 0.15,
  creatorReputation: 0.1,
  rugHistory: 0.1,
};

const LABELS: Record<IntegrityDomainKey, string> = {
  tokenSecurity: 'Token security',
  liquiditySafety: 'Liquidity safety',
  holderIntegrity: 'Holder integrity',
  activityIntegrity: 'Activity integrity',
  walletCoordination: 'Wallet coordination',
  creatorReputation: 'Creator reputation',
  rugHistory: 'Rug / malicious history',
};

/** Below this confidence a domain can be ELEVATED at most. */
export const ACTIONABLE_CONFIDENCE = 0.5;
/**
 * Below this coverage a domain can be ELEVATED at most. For activity and
 * coordination, coverage already includes how much of the market the sample
 * represents, so a confident reading of a sliver cannot condemn - found live,
 * where HIGH wash at confidence 0.84 came from about 3% of the market.
 */
export const ACTIONABLE_COVERAGE = 0.4;
/** Each non-strongest family in a domain adds this share of its risk. */
const SECONDARY_FAMILY_SHARE = 0.25;

const pctText = (x: number): string => `${Math.round(x * 100)}%`;
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

export function bandOf(risk: number | null): RiskBand {
  if (risk === null) return 'UNKNOWN';
  if (risk < 0.15) return 'CLEAR';
  if (risk < 0.3) return 'LOW';
  if (risk < 0.5) return 'ELEVATED';
  if (risk < 0.7) return 'HIGH';
  return 'SEVERE';
}

const BAND_RANK: Record<RiskBand, number> = { UNKNOWN: -1, CLEAR: 0, LOW: 1, ELEVATED: 2, HIGH: 3, SEVERE: 4 };

function build(
  key: IntegrityDomainKey,
  contributions: RiskContribution[],
  coverage: number,
  baseConfidence: number,
  clean: string[],
  unknown: string[],
): IntegrityDomain {
  const fired = contributions.filter((c) => c.risk > 0);
  const byFamily = new Map<string, RiskContribution>();
  for (const c of fired) {
    const prior = byFamily.get(c.family);
    if (!prior || c.risk > prior.risk) byFamily.set(c.family, c);
  }
  const families = [...byFamily.values()].sort((a, b) => b.risk - a.risk);
  let risk: number | null = null;
  if (coverage > 0 || families.length > 0) {
    const [first, ...rest] = families;
    risk = first ? clamp01(first.risk + rest.reduce((sum, c) => sum + c.risk * SECONDARY_FAMILY_SHARE, 0)) : 0;
  }
  const confidence = families[0]?.confidence ?? baseConfidence;
  // Actionability rests on the evidence that fired: a well-covered domain
  // does not lend its coverage to a reading taken from a sliver.
  const evidenceCoverage = Math.min(coverage, families[0]?.coverage ?? coverage);
  let band = bandOf(risk);
  if ((band === 'HIGH' || band === 'SEVERE') && (confidence < ACTIONABLE_CONFIDENCE || evidenceCoverage < ACTIONABLE_COVERAGE)) band = 'ELEVATED';
  return {
    key,
    label: LABELS[key],
    weight: INTEGRITY_WEIGHTS[key],
    risk: risk === null ? null : r3(risk),
    band,
    confidence: r3(confidence),
    coverage: r3(clamp01(coverage)),
    contributions: [...fired].sort((a, b) => b.risk - a.risk),
    clean,
    unknown,
  };
}

const measured = (token: TokenSnapshot, metric: string): { ok: boolean; value: unknown; confidence: number } => {
  const entry = token.ledger?.find((e) => e.metric === metric);
  const ok = entry !== undefined && (entry.state === 'MEASURED' || entry.state === 'CONFLICTED') && entry.freshness !== 'STALE';
  return { ok, value: ok ? entry!.value : null, confidence: ok ? entry!.confidence : 0 };
};

/** RugCheck findings still scoring (fresh, classified), split by what they are about. */
function rugcheckFindings(token: TokenSnapshot): { about: 'liquidity' | 'holders' | 'token'; level: 'high' | 'medium'; text: string; code: string }[] {
  return token.score.flags
    .filter((f) => f.code.startsWith('rugcheck:') && (f.level === 'high' || f.level === 'medium'))
    .map((f) => {
      const name = f.code.slice('rugcheck:'.length);
      const about: 'liquidity' | 'holders' | 'token' = /lp|liquidity/.test(name) ? 'liquidity' : /holder|ownership|owner/.test(name) ? 'holders' : 'token';
      return { about, level: f.level as 'high' | 'medium', text: f.message.replace(/^RugCheck:\s*/, 'RugCheck: ').split(' - ')[0] ?? f.message, code: f.code };
    })
    // Authority and rug findings are vetoes or authority evidence already.
    .filter((f) => !/authority|rugged|creator_history/.test(f.code));
}

export function assessIntegrity(token: TokenSnapshot, bundle: IntelligenceBundle, momentum: MomentumAssessment | null): IntegrityAssessment {
  const domains: IntegrityDomain[] = [];
  const rc = rugcheckFindings(token);
  const activeEvents = bundle.security.value?.active ?? [];
  const eventsOf = (type: string) => activeEvents.filter((e) => e.type === type && e.mint === bundle.mint);

  // --- token security -------------------------------------------------------------
  {
    const parts = [
      { metric: 'mintAuthorityRevoked', w: 0.3, label: 'mint authority' },
      { metric: 'freezeAuthorityRevoked', w: 0.2, label: 'freeze authority' },
      { metric: 'mintExtensions', w: 0.25, label: 'Token-2022 extensions' },
      { metric: 'rugcheckRisk', w: 0.25, label: 'RugCheck risk score' },
    ];
    const clean: string[] = [];
    const unknown: string[] = [];
    let coverage = 0;
    let confidence = 0;
    for (const p of parts) {
      const m = measured(token, p.metric);
      if (!m.ok) {
        unknown.push(p.label);
        continue;
      }
      coverage += p.w;
      confidence += p.w * m.confidence;
      if (p.metric === 'mintAuthorityRevoked' && m.value === true) clean.push('mint authority revoked');
      if (p.metric === 'freezeAuthorityRevoked' && m.value === true) clean.push('freeze authority revoked');
    }
    const contributions: RiskContribution[] = [];
    const risk = measured(token, 'rugcheckRisk');
    if (risk.ok && typeof risk.value === 'number') {
      if (risk.value > 50) contributions.push({ code: 'RUGCHECK_SCORE', family: 'rugcheck-score', risk: clamp01((risk.value - 50) / 100), confidence: risk.confidence, text: `RugCheck risk score ${Math.round(risk.value)}/100`, evidence: ['rugcheck'] });
      else clean.push(`RugCheck risk score ${Math.round(risk.value)}/100`);
    }
    for (const ext of token.onchain?.extensions ?? []) {
      if (ext.policy === 'PENALTY_ONLY' && ext.active === true) {
        contributions.push({ code: 'EXTENSION_PENALTY', family: 'extension', risk: 0.3, confidence: 1, text: `${ext.label}${ext.detail ? ` (${ext.detail})` : ''}`, evidence: [ext.id] });
      }
    }
    if (token.onchain?.extensionsComplete && (token.onchain.extensions ?? []).every((x) => x.active !== true || x.policy === 'INFORMATIONAL' || x.policy === 'NO_CURRENT_RISK_EFFECT')) {
      clean.push('no armed Token-2022 power over holders');
    }
    for (const f of rc.filter((x) => x.about === 'token')) {
      contributions.push({ code: 'RUGCHECK_FINDING', family: 'rugcheck-finding', risk: f.level === 'high' ? 0.35 : 0.15, confidence: 0.9, text: f.text, evidence: [f.code] });
    }
    for (const e of eventsOf('AUTHORITY_REASSIGNED')) {
      contributions.push({ code: 'AUTHORITY_REASSIGNED', family: 'authority-moved', risk: 0.3, confidence: e.confidence, text: `An authority was moved rather than revoked: ${e.reasons[0] ?? ''}`, evidence: [e.signature] });
    }
    domains.push(build('tokenSecurity', contributions, coverage, confidence / Math.max(coverage, 1e-9), clean, unknown));
  }

  // --- liquidity safety -----------------------------------------------------------
  {
    const liq = measured(token, 'liquidityUsd');
    const rug = measured(token, 'rugcheckRisk');
    const coverage = (liq.ok ? 0.7 : 0) + (rug.ok ? 0.3 : 0);
    const contributions: RiskContribution[] = [];
    const clean: string[] = [];
    const unknown: string[] = [];
    if (liq.ok && typeof liq.value === 'number') {
      const v = liq.value;
      if (v < 10_000) contributions.push({ code: 'THIN_DEPTH', family: 'depth', risk: 0.35, confidence: liq.confidence, text: `Only $${Math.round(v).toLocaleString('en-US')} of liquidity`, evidence: ['liquidityUsd'] });
      else if (v < 25_000) contributions.push({ code: 'SHALLOW_DEPTH', family: 'depth', risk: 0.2, confidence: liq.confidence, text: `Shallow liquidity: $${Math.round(v).toLocaleString('en-US')}`, evidence: ['liquidityUsd'] });
      else clean.push(`$${Math.round(v).toLocaleString('en-US')} of liquidity`);
    } else unknown.push('liquidity');
    const lp = rc.filter((x) => x.about === 'liquidity');
    for (const f of lp) contributions.push({ code: 'LP_FINDING', family: 'lp', risk: f.level === 'high' ? 0.35 : 0.15, confidence: 0.9, text: f.text, evidence: [f.code] });
    if (rug.ok && lp.length === 0) clean.push('no RugCheck LP finding');
    if (!rug.ok) unknown.push('LP lock state');
    for (const e of eventsOf('LIQUIDITY_DRAIN')) {
      if (e.status === 'CONFIRMED') continue; // a hard fail, not a soft risk
      contributions.push({ code: 'LIQUIDITY_DRAIN', family: 'drain', risk: e.status === 'STRONGLY_SUSPECTED' ? 0.6 : 0.25, confidence: e.confidence, text: `${e.status === 'STRONGLY_SUSPECTED' ? 'Strongly suspected' : 'Suspicious'} liquidity removal: ${e.reasons.join(', ')}`, evidence: [e.signature] });
    }
    if (momentum?.liquidityChange !== null && momentum?.liquidityChange !== undefined && momentum.liquidityChange <= -0.4) {
      contributions.push({ code: 'LIQUIDITY_LEAVING', family: 'drain', risk: 0.3, confidence: 0.8, text: `Liquidity fell ${pctText(-momentum.liquidityChange)} over the observed window`, evidence: ['market history'] });
    }
    domains.push(build('liquiditySafety', contributions, coverage, liq.confidence, clean, unknown));
  }

  // --- holder integrity -------------------------------------------------------------
  {
    const h = bundle.holders;
    const contributions: RiskContribution[] = [];
    const clean: string[] = [];
    const unknown: string[] = [];
    const v = h.value;
    // Never the raw figure: it counts bonding curves and pool vaults, which
    // are not holders. Role-aware when every owner resolved, else the
    // provider's own holder figure, else nothing.
    const pct = v ? (v.roleAware ? v.walletTop10Pct : v.providerTopPct) : null;
    const basis = v?.roleAware ? 'wallet-only top-10' : 'provider-reported top holders';
    const holderFindings = rc.filter((x) => x.about === 'holders');
    // Live, the on-chain wallet figure and the provider's disagreed by 7-10x
    // on real tokens. A figure disputed that sharply is kept (the higher,
    // conservative reading) and stated as disputed, but it is actionable only
    // when a second provider's finding corroborates it.
    const other = v?.roleAware ? v.providerTopPct : null;
    const disputed = pct !== null && other !== null && Math.max(pct, other) >= 3 * Math.max(1, Math.min(pct, other)) && Math.abs(pct - other) >= 30;
    const corroborated = holderFindings.length > 0;
    if (pct !== null) {
      if (pct > 30) {
        contributions.push({
          code: 'CONCENTRATION',
          family: 'concentration',
          risk: Math.min(0.8, ((pct - 30) / 50) * 0.7),
          confidence: disputed && !corroborated ? Math.min(h.confidence, ACTIONABLE_CONFIDENCE - 0.05) : h.confidence,
          text: `${basis} hold ${Math.round(pct)}%${disputed ? ` (disputed: the provider reports ${Math.round(other as number)}%${corroborated ? ', RugCheck corroborates the higher figure' : ''})` : ''}`,
          evidence: h.evidence.slice(0, 3),
        });
      } else clean.push(`${basis} hold ${Math.round(pct)}%`);
    } else {
      unknown.push(v && v.rawTop10Pct !== null ? 'wallet concentration (large-account owners unresolved; raw figure includes pools and curves)' : 'holder concentration');
    }
    for (const f of holderFindings) contributions.push({ code: 'HOLDER_FINDING', family: 'concentration', risk: f.level === 'high' ? 0.3 : 0.15, confidence: 0.9, text: f.text, evidence: [f.code] });
    for (const e of eventsOf('CREATOR_DUMP')) {
      contributions.push({ code: 'CREATOR_DUMP', family: 'insider-selling', risk: e.status === 'STRONGLY_SUSPECTED' ? 0.5 : 0.25, confidence: e.confidence, text: `Creator-linked selling: ${e.reasons[0] ?? ''}`, evidence: [e.signature] });
    }
    domains.push(build('holderIntegrity', contributions, h.coverage, h.confidence, clean, unknown));
  }

  // --- activity integrity --------------------------------------------------------------
  {
    const a = bundle.activity;
    const contributions: RiskContribution[] = [];
    const clean: string[] = [];
    const unknown: string[] = [];
    let coverage = 0;
    if (usableIntel(a) && a.value) {
      coverage = a.coverage;
      const view = a.value.byTrades.shares ? a.value.byTrades : a.value.byWallets.shares ? a.value.byWallets : null;
      const basis = view === a.value.byTrades ? 'trades' : 'wallets';
      if (view?.shares) {
        const s = view.shares;
        if (s.automated > 0.4) contributions.push({ code: 'AUTOMATION', family: 'automation', risk: Math.min(0.45, (s.automated - 0.4) * 0.9), confidence: a.confidence, text: `${pctText(s.automated)} of ${basis} by automated or high-frequency wallets`, evidence: a.evidence.slice(0, 1) });
        if (s.sniper > 0.25) contributions.push({ code: 'SNIPERS', family: 'snipers', risk: Math.min(0.6, (s.sniper - 0.25) * 1.2), confidence: a.confidence, text: `${pctText(s.sniper)} of ${basis} by snipers`, evidence: a.evidence.slice(0, 1) });
        if (view.classified >= 0.6 && s.likely_organic < 0.1) contributions.push({ code: 'NO_ORGANIC', family: 'organic-absence', risk: 0.2, confidence: a.confidence, text: `Only ${pctText(s.likely_organic)} of ${basis} look organic`, evidence: [] });
        if (s.likely_organic >= 0.2) clean.push(`${pctText(s.likely_organic)} of ${basis} likely organic`);
        if (s.unknown > 0.4) unknown.push(`${pctText(s.unknown)} of ${basis} unclassified`);
      } else unknown.push('activity composition (too few wallets classified to state shares)');
    } else unknown.push(a.status === 'SUPERSEDED' ? 'activity (reading from an obsolete rule)' : a.status === 'STALE' ? 'activity (reading too old)' : 'activity composition');
    domains.push(build('activityIntegrity', contributions, coverage, a.confidence, clean, unknown));
  }

  // --- wallet coordination ---------------------------------------------------------------
  {
    const a = bundle.activity;
    const w = bundle.wash;
    const c = bundle.coordination;
    const contributions: RiskContribution[] = [];
    const clean: string[] = [];
    const unknown: string[] = [];
    const covs: number[] = [];
    if (usableIntel(c) && c.value) {
      covs.push(c.coverage);
      const view = usableIntel(a) && a.value ? (a.value.byTrades.shares ? a.value.byTrades : a.value.byWallets) : null;
      const share = view?.shares?.coordinated ?? c.value.coordinatedWalletShare;
      if (share !== null && share !== undefined && share > 0.1) {
        contributions.push({ code: 'COORDINATION', family: 'coordination', risk: Math.min(0.7, (share - 0.1) * 1.2), confidence: c.confidence, coverage: view ? Math.min(c.coverage, a.coverage) : c.coverage, text: `${pctText(share)} of ${view === a.value?.byTrades ? 'trades' : 'wallets'} by wallets clustered with another trader of this token`, evidence: c.evidence.slice(0, 2) });
      } else if (share !== null && share !== undefined) clean.push(`${pctText(share)} coordinated`);
      if (c.value.clusters === 0) clean.push('no strong wallet cluster among analysed traders');
    } else unknown.push('wallet relationships');
    if (usableIntel(w) && w.value) {
      covs.push(w.coverage);
      if (w.value.risk === 'HIGH') contributions.push({ code: 'WASH_HIGH', family: 'manipulation', risk: w.confidence >= ACTIONABLE_CONFIDENCE ? 0.65 : 0.4, confidence: w.confidence, coverage: w.coverage, text: `Wash/manipulation risk HIGH: ${w.value.families.join(', ').toLowerCase()}`, evidence: w.evidence.slice(0, 3) });
      else if (w.value.risk === 'ELEVATED') contributions.push({ code: 'WASH_ELEVATED', family: 'manipulation', risk: 0.35, confidence: w.confidence, coverage: w.coverage, text: `Wash/manipulation risk elevated: ${w.value.families.join(', ').toLowerCase()}`, evidence: w.evidence.slice(0, 3) });
      else if (w.value.risk === 'LOW') clean.push('wash/manipulation risk low');
    } else unknown.push(w.status === 'INSUFFICIENT_DATA' ? 'wash analysis (too few trades)' : 'wash analysis');
    const coverage = covs.length ? covs.reduce((x, y) => x + y, 0) / 2 : 0;
    domains.push(build('walletCoordination', contributions, coverage, Math.max(c.confidence, w.confidence), clean, unknown));
  }

  // --- creator reputation -----------------------------------------------------------------
  {
    const cr = bundle.creator;
    const contributions: RiskContribution[] = [];
    const clean: string[] = [];
    const unknown: string[] = [];
    let coverage = 0;
    if (usableIntel(cr) && cr.value) {
      coverage = cr.coverage;
      const v = cr.value;
      if (v.status === 'MALICIOUS_HISTORY') contributions.push({ code: 'CREATOR_MALICIOUS', family: 'history', risk: 0.6, confidence: cr.confidence, text: `The creator has ${v.otherConfirmedLaunches} other launch(es) with a confirmed malicious event`, evidence: cr.evidence.slice(0, 3) });
      else if (v.status === 'SUSPICIOUS') contributions.push({ code: 'CREATOR_SUSPICIOUS', family: 'history', risk: v.otherSuspectedLaunches >= 2 ? 0.35 : 0.25, confidence: cr.confidence, text: `The creator has suspected, unconfirmed events on other launches`, evidence: cr.evidence.slice(0, 3) });
      else if (v.status === 'CLEAN') clean.push(`creator: ${v.launches} launches seen, none with a current-rule event`);
    } else unknown.push(cr.status === 'INSUFFICIENT_DATA' ? 'creator history (too little of it)' : 'creator history');
    if (bundle.attribution.value?.status === 'AMBIGUOUS') unknown.push('creator (attribution ambiguous)');
    domains.push(build('creatorReputation', contributions, coverage, cr.confidence, clean, unknown));
  }

  // --- rug / malicious history -------------------------------------------------------------
  {
    const s = bundle.security;
    const n = bundle.network;
    const contributions: RiskContribution[] = [];
    const clean: string[] = [];
    const unknown: string[] = [];
    const covs: number[] = [];
    if (s.status === 'AVAILABLE' || s.status === 'PARTIAL') {
      covs.push(s.coverage);
      // Types charged in their own domain are not charged again here.
      for (const e of activeEvents.filter((x) => x.mint === bundle.mint && (x.type === 'SUPPLY_EXPANSION' || x.type === 'FREEZE_ABUSE') && x.status !== 'CONFIRMED')) {
        contributions.push({ code: e.type, family: 'token-events', risk: e.status === 'STRONGLY_SUSPECTED' ? 0.55 : 0.2, confidence: e.confidence, text: `${e.status === 'STRONGLY_SUSPECTED' ? 'Strongly suspected' : 'Suspicious'} ${e.type.toLowerCase().replace('_', ' ')}: ${e.reasons[0] ?? ''}`, evidence: [e.signature] });
      }
      if (activeEvents.length === 0 && s.value) clean.push(`no current-rule security event in the mint history read (${s.value.mintHistory.toLowerCase()})`);
    } else unknown.push('token security events');
    if (usableIntel(n) && n.value) {
      covs.push(n.coverage);
      const best = n.value.findings[0];
      if (n.value.level === 'STRONG') contributions.push({ code: 'NETWORK_STRONG', family: 'network', risk: 0.55, confidence: n.confidence, text: `Linked by strong ties to an address with ${best?.confirmedLaunches ?? 0} confirmed malicious launch(es)`, evidence: n.evidence.slice(0, 2) });
      else if (n.value.level === 'MODERATE') contributions.push({ code: 'NETWORK_MODERATE', family: 'network', risk: 0.35, confidence: n.confidence, text: 'Linked to an address with a suspected or weakly linked malicious history', evidence: n.evidence.slice(0, 2) });
      else if (n.value.level === 'NONE') clean.push('no malicious address within the searched strong hops');
      else if (n.value.level === 'WEAK_ASSOCIATION') clean.push('only behavioural coincidence links (not a finding)');
    } else unknown.push('serial network');
    const coverage = covs.length ? covs.reduce((x, y) => x + y, 0) / 2 : 0;
    domains.push(build('rugHistory', contributions, coverage, Math.max(s.confidence, n.confidence), clean, unknown));
  }

  // --- aggregate ---------------------------------------------------------------------------
  const totalWeight = domains.reduce((sum, d) => sum + d.weight, 0);
  const coveredWeight = domains.reduce((sum, d) => sum + d.weight * d.coverage, 0);
  const coverage = coveredWeight / totalWeight;
  const earned = domains.reduce((sum, d) => sum + d.weight * d.coverage * (1 - (d.risk ?? 0)), 0);
  const risk = coveredWeight > 0 ? domains.reduce((sum, d) => sum + d.weight * d.coverage * (d.risk ?? 0), 0) / coveredWeight : 0;
  const confidence = coveredWeight > 0 ? domains.reduce((sum, d) => sum + d.weight * d.coverage * d.confidence, 0) / coveredWeight : 0;

  const ranked = [...domains].sort((a, b) => BAND_RANK[b.band] - BAND_RANK[a.band] || (b.risk ?? 0) - (a.risk ?? 0));
  const top = ranked[0]!;
  // Two elevated domains make a high risk only when both rest on evidence
  // that would have been actionable on its own terms.
  const elevated = domains.filter((d) => d.band === 'ELEVATED' && Math.min(d.coverage, d.contributions[0]?.coverage ?? d.coverage) >= ACTIONABLE_COVERAGE && d.confidence >= ACTIONABLE_CONFIDENCE).length;
  let band: RiskBand;
  if (coverage < 0.25) band = 'UNKNOWN';
  else if (top.band === 'SEVERE') band = 'SEVERE';
  else if (top.band === 'HIGH') band = 'HIGH';
  else if (elevated >= 2) band = 'HIGH';
  else band = top.band === 'UNKNOWN' ? 'CLEAR' : top.band;

  return {
    model: MODEL_VERSIONS.integrity,
    score: coverage > 0 ? Math.round((earned / totalWeight) * 1000) / 10 : null,
    band,
    risk: r3(risk),
    coverage: r3(coverage),
    confidence: r3(confidence),
    domains,
    driver: band === 'CLEAR' || band === 'UNKNOWN' ? null : top.key,
  };
}
