/**
 * Human-facing language for engine output.
 *
 * Every phrase a person reads about a verdict is produced here, once, so the
 * Board, the Dossier and the Changes stream cannot describe the same fact three
 * different ways. Nothing here decides anything: each function restates a
 * conclusion the engine already reached (the eligibility ladder in
 * core/lifecycle.ts, the vetoes in core/gate.ts, the evidence states in
 * core/evidence.ts). Internal codes stay available in the evidence drill-down;
 * they are never the headline.
 */

import type { EvidenceState } from '../core/evidence.ts';
import { COVERAGE_WEIGHTS } from '../core/lifecycle.ts';
import type {
  Eligibility,
  LedgerEntry,
  RiskFlag,
  TokenSnapshot,
  Veto,
  VetoCode,
} from '../types.ts';

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export const VERDICT_LABEL: Record<Eligibility, string> = {
  QUALIFIED: 'Qualified',
  WATCH: 'Watch',
  INSUFFICIENT_DATA: 'Insufficient data',
  REJECTED: 'Rejected',
};

export const VERDICT_TONE: Record<Eligibility, Tone> = {
  QUALIFIED: 'good',
  WATCH: 'warn',
  INSUFFICIENT_DATA: 'neutral',
  REJECTED: 'bad',
};

/** Metric names as a person would say them. */
export const METRIC_LABEL: Record<string, string> = {
  mintAuthorityRevoked: 'Mint authority',
  freezeAuthorityRevoked: 'Freeze authority',
  mintExtensions: 'Token-2022 extensions',
  tokenProgram: 'Token program',
  topHoldersPct: 'Top-holder concentration',
  rugcheckRisk: 'RugCheck risk score',
  tradable: 'Tradability',
  liquidityUsd: 'Liquidity',
  volume24h: '24h volume',
  priceChange: 'Price momentum',
  buyPressure: 'Buy/sell balance',
  holders: 'Holder count',
  organicScore: 'Organic activity',
  ageHours: 'Token age',
};

export const METRIC_GROUP: Record<string, 'Safety' | 'Market' | 'Adoption' | 'Contract'> = {
  mintAuthorityRevoked: 'Safety',
  freezeAuthorityRevoked: 'Safety',
  mintExtensions: 'Safety',
  topHoldersPct: 'Safety',
  rugcheckRisk: 'Safety',
  tradable: 'Market',
  liquidityUsd: 'Market',
  volume24h: 'Market',
  priceChange: 'Market',
  buyPressure: 'Market',
  holders: 'Adoption',
  organicScore: 'Adoption',
  ageHours: 'Adoption',
  tokenProgram: 'Contract',
};

export const metricLabel = (metric: string): string => METRIC_LABEL[metric] ?? metric;

/** Short veto labels. The engine's full reason is shown beneath them. */
const VETO_LABEL: Record<VetoCode, string> = {
  AUTHORITY_MINT_ACTIVE: 'Mint authority still active',
  AUTHORITY_FREEZE_ACTIVE: 'Freeze authority still active',
  CRITICAL_RUGCHECK: 'Critical RugCheck finding',
  UNTRADEABLE: 'No tradable liquidity',
  LIQUIDITY_TOO_LOW: 'Liquidity below safety floor',
  CATASTROPHIC_CONCENTRATION: 'Top holders control the float',
  MALFORMED_TOKEN: 'Provider data failed validation',
  PERMANENT_DELEGATE_ACTIVE: 'Permanent delegate can move holder tokens',
  TRANSFER_HOOK_ACTIVE: 'Transfer hook can block transfers',
  MINT_PAUSABLE: 'Transfers can be paused',
  DEFAULT_ACCOUNT_STATE_FROZEN: 'New holder accounts start frozen',
  NON_TRANSFERABLE: 'Token cannot be transferred',
  EXTREME_TRANSFER_FEE: 'Transfer fee of 50% or more',
};

export function vetoLabel(code: string): string {
  return VETO_LABEL[code as VetoCode] ?? 'Safety veto';
}

/**
 * A veto's label, made specific where the veto carries the detail.
 *
 * CRITICAL_RUGCHECK covers two different findings - a creator with a rug
 * history, and a token RugCheck reports as already rugged. The veto's observed
 * value names which; "Critical RugCheck finding" alone would hide it.
 */
export function vetoLabelFor(veto: Pick<Veto, 'code' | 'observedValue'>): string {
  if (veto.code === 'CRITICAL_RUGCHECK') {
    const observed = veto.observedValue.toLowerCase();
    if (observed.includes('creator history')) return 'Creator has rugged tokens before';
    if (observed.includes('rugged')) return 'RugCheck reports it already rugged';
  }
  return vetoLabel(veto.code);
}

export interface VetoView {
  code: string;
  label: string;
  reason: string;
  source: string;
  observedValue: string;
  at: number;
  recheckable: boolean;
  nature: string;
}

export function vetoView(veto: Veto): VetoView {
  return {
    code: veto.code,
    label: vetoLabelFor(veto),
    reason: veto.reason,
    source: veto.source,
    observedValue: veto.observedValue,
    at: veto.at,
    recheckable: veto.recheckable,
    nature: veto.nature,
  };
}

/**
 * A risk flag worth putting in a one-line reason, or null.
 *
 * Flags that restate something shown elsewhere are skipped: coverage gaps are
 * shown as coverage, provider disagreement lives in the evidence ledger, and
 * verification is a badge. What remains are findings about the token itself.
 */
export function flagPhrase(flag: RiskFlag): string | null {
  const code = flag.code;
  if (code === 'concentration') return flag.message.replace(/\.$/, '');
  if (code === 'thin_liquidity') return 'Thin liquidity';
  if (code === 'wash_suspect') return 'Volume looks inflated relative to liquidity';
  if (code === 'mint_authority') return 'Mint authority reported active';
  if (code === 'freeze_authority') return 'Freeze authority reported active';
  if (code === 'no_socials') return 'No website or socials listed';
  if (code.startsWith('rugcheck:')) {
    const name = flag.message.replace(/^RugCheck:\s*/, '').split(' - ')[0] ?? '';
    return name ? `RugCheck: ${name.slice(0, 60)}` : 'RugCheck finding';
  }
  return null;
}

const FLAG_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export interface UnknownSignal {
  metric: string;
  label: string;
  state: EvidenceState;
  reason: string;
  /** True when no token can have this signal in the current configuration. */
  global: boolean;
}

const MEASURED_STATES: ReadonlySet<string> = new Set(['MEASURED', 'CONFLICTED']);

/** Why a signal was not measured, in words. */
export function unknownReason(
  state: string,
  metric: string,
  globallyOff: ReadonlySet<string>,
): string {
  if (globallyOff.has(metric)) return 'Needs a Helius API key';
  switch (state) {
    case 'UNAVAILABLE':
      return 'Provider could not be reached';
    case 'INVALID':
      return 'Provider value failed validation';
    case 'STALE':
      return 'Last reading too old to use';
    default:
      return 'No provider reported it';
  }
}

/** The coverage-bearing signals that were not measured, named. */
export function unknownSignals(
  entries: readonly Pick<LedgerEntry, 'metric' | 'state' | 'weight'>[],
  globallyOff: ReadonlySet<string>,
): UnknownSignal[] {
  return entries
    .filter((entry) => entry.weight > 0 && !MEASURED_STATES.has(entry.state))
    .map((entry) => ({
      metric: entry.metric,
      label: metricLabel(entry.metric),
      state: entry.state,
      reason: unknownReason(entry.state, entry.metric, globallyOff),
      global: globallyOff.has(entry.metric),
    }));
}

export interface SignalCounts {
  measured: number;
  signals: number;
}

/** Measured (including conflicted) out of eligible, from the engine's own report. */
export function signalCounts(token: TokenSnapshot): SignalCounts | null {
  const coverage = token.evaluation?.coverage;
  if (!coverage) return null;
  return { measured: coverage.measured + coverage.conflicted, signals: coverage.eligibleSignals };
}

export interface ReasonContext {
  globallyOff: ReadonlySet<string>;
  minCoverageQualify: number;
}

/**
 * The one-line reason shown beside a verdict.
 *
 * Restates the eligibility ladder in core/lifecycle.ts: any veto rejects; below
 * the watch threshold is insufficient data; below the qualify threshold is
 * watch. For qualified tokens the line names the most useful caveat - a risk
 * finding, then a token-specific gap - because "qualified" alone would read
 * identically on every row.
 */
export function verdictReason(token: TokenSnapshot, context: ReasonContext): { text: string; tone: Tone } {
  const evaluation = token.evaluation;
  if (evaluation == null) return { text: 'Not assessed', tone: 'neutral' };

  const counts = signalCounts(token);
  const coveragePct = Math.round(evaluation.coverage.coverage * 100);

  switch (evaluation.eligibility) {
    case 'REJECTED': {
      const [first, ...rest] = evaluation.vetoes;
      const label = first ? vetoLabelFor(first) : 'Failed the safety gate';
      return { text: rest.length ? `${label} · +${rest.length} more` : label, tone: 'bad' };
    }
    case 'INSUFFICIENT_DATA':
      return {
        text: counts ? `Only ${counts.measured} of ${counts.signals} signals measured` : 'Too little evidence',
        tone: 'neutral',
      };
    case 'WATCH':
      return {
        text: `Coverage ${coveragePct}% · needs ${Math.round(context.minCoverageQualify * 100)}% to qualify`,
        tone: 'warn',
      };
    default:
      break;
  }

  // Qualified: surface the most useful caveat.
  const flags = [...token.score.flags]
    .filter((flag) => flag.level !== 'info' && flag.level !== 'low')
    .sort((a, b) => (FLAG_RANK[a.level] ?? 9) - (FLAG_RANK[b.level] ?? 9));
  for (const flag of flags) {
    const phrase = flagPhrase(flag);
    if (phrase) return { text: phrase, tone: 'warn' };
  }

  if (token.ledger) {
    const specific = unknownSignals(token.ledger, context.globallyOff).filter((signal) => !signal.global);
    if (specific.length === 1) return { text: `No vetoes · ${specific[0]!.label.toLowerCase()} unknown`, tone: 'good' };
    if (specific.length > 1) return { text: `No vetoes · ${specific.length} signals unknown`, tone: 'good' };
  } else if (counts) {
    // Evaluated before the ledger existed: names are not known, but the engine's
    // own counts are. Never claim "all measured" without having checked.
    const globalWeighted = [...context.globallyOff].filter(
      (metric) => (COVERAGE_WEIGHTS as Record<string, number | undefined>)[metric],
    ).length;
    const unmeasured = counts.signals - counts.measured - globalWeighted;
    if (unmeasured > 0) {
      return { text: `No vetoes · ${unmeasured} signal${unmeasured === 1 ? '' : 's'} unknown`, tone: 'good' };
    }
  }

  const hasGlobalGap = context.globallyOff.size > 0;
  return {
    text: hasGlobalGap ? 'No vetoes · all available signals measured' : 'No vetoes · fully measured',
    tone: 'good',
  };
}

/** Why a verdict changed, for the Changes stream and the Dossier timeline. */
export function changeReason(change: {
  from: string | null;
  to: string | null;
  vetoCodes: string[];
  coverage: number | null;
}): string {
  const to = change.to as Eligibility | null;
  if (change.from === null) {
    if (to === 'REJECTED' && change.vetoCodes.length) return vetoLabel(change.vetoCodes[0]!);
    return 'First assessment';
  }
  if (to === 'REJECTED') {
    const [first, ...rest] = change.vetoCodes;
    if (!first) return 'Failed the safety gate';
    return rest.length ? `${vetoLabel(first)} · +${rest.length} more` : vetoLabel(first);
  }
  if (change.from === 'REJECTED') return 'Vetoes no longer apply';
  if (change.coverage !== null) {
    const pct = Math.round(change.coverage * 100);
    return to === 'QUALIFIED' ? `Coverage rose to ${pct}%` : `Coverage now ${pct}%`;
  }
  return 'Verdict changed';
}

/** Discovery feed names, readable. Paid promotion is labelled as such. */
export function sourceLabel(source: string): string {
  const known: Record<string, string> = {
    'jupiter:recent': 'Jupiter · recent',
    'jupiter:organic': 'Jupiter · organic trending',
    'dexscreener:profiles': 'DexScreener · new profile',
    'dexscreener:boosts': 'DexScreener · paid boost',
    'birdeye:new': 'Birdeye · new listing',
    cli: 'Manual lookup',
  };
  return known[source] ?? source;
}
