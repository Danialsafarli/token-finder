import { clamp01, logScore, bandScore } from '../util/num.ts';
import { isUsable, type Evidence, type TokenEvidence } from './evidence.ts';
import type { ImpersonationAssessment, RiskFlag, Score, ScoreComponent } from '../types.ts';

/**
 * Weights sum to 1. Safety carries the most because on a chain where anyone
 * can mint in seconds, the question that decides everything is whether the
 * token can be rugged, not how fast it is pumping.
 *
 * Unchanged from the prototype. Reweighting needs outcome data the project
 * does not yet have, and guessing new numbers would be a worse error than the
 * correlation it tried to fix - see SIGNAL_FAMILIES below.
 */
const WEIGHTS = {
  safety: 0.26,
  liquidity: 0.18,
  activity: 0.14,
  holders: 0.13,
  momentum: 0.12,
  pressure: 0.09,
  age: 0.08,
} as const;

/**
 * Safety sub-weights. Fixed, never renormalised over whichever parts exist:
 * renormalising lets one known sub-part stand in for four missing ones, which
 * is a neutral default wearing a different hat.
 */
const SAFETY_WEIGHTS = {
  mint: 0.3,
  freeze: 0.2,
  concentration: 0.2,
  rugcheck: 0.2,
  organic: 0.1,
} as const;

/**
 * Which scoring signals share an underlying fact.
 *
 * Documented rather than silently reweighted. The phase brief is explicit that
 * weights must not move without evidence, and there is no outcome data to
 * calibrate against - so this registry exists to make the correlation visible
 * in the UI and the docs, and to justify the one change that *is* a pure
 * correctness fix (see `activity` below).
 */
export const SIGNAL_FAMILIES: {
  family: string;
  signals: string[];
  underlying: string;
  relationship: 'independent' | 'correlated' | 'derived' | 'provider-specific';
  note: string;
}[] = [
  {
    family: 'depth',
    signals: ['liquidity', 'activity'],
    underlying: 'pooled liquidity in USD',
    relationship: 'derived',
    note:
      'Activity is volume divided by the same liquidity figure the liquidity component scores. They move in opposite directions on a bad reading, which limits the damage, but one number drives 32% of the weight.',
  },
  {
    family: 'organic-interest',
    signals: ['holders', 'safety.organic'],
    underlying: 'Jupiter organic activity measurement',
    relationship: 'correlated',
    note:
      'Holder count and Jupiter organicScore both proxy genuine interest, and both come from Jupiter. Combined 15.6% of weight from a single provider view.',
  },
  {
    family: 'concentration',
    signals: ['safety.concentration', 'penalty:concentration'],
    underlying: 'top-holder percentage',
    relationship: 'derived',
    note:
      'One fact charged twice: graded inside safety, then again as a x0.70 multiplier above 60%. Retained deliberately - the penalty models cliff risk that a graded score cannot - but it is a double charge and is counted as such here.',
  },
  {
    family: 'thin-liquidity',
    signals: ['liquidity', 'penalty:thin_liquidity'],
    underlying: 'pooled liquidity in USD',
    relationship: 'derived',
    note:
      'Below the floor the liquidity component already scores ~0, and the x0.65 penalty then applies to everything else. Also a double charge, retained for the same reason.',
  },
  {
    family: 'authority',
    signals: ['safety.mint', 'safety.freeze', 'veto:AUTHORITY_*'],
    underlying: 'mint and freeze authority state',
    relationship: 'independent',
    note:
      'Mint and freeze are genuinely separate powers. Since the safety gate now vetoes on a live authority, the scoring sub-parts only matter for tokens that pass the gate.',
  },
];

interface Part {
  key: string;
  label: string;
  value: number | null;
  weight: number;
  detail: string;
  unknownReason?: string;
  coverage: number;
}

/** Describes why an evidence item cannot be scored, in the user's language. */
function whyUnusable(evidence: Evidence<unknown>, metric: string): string {
  switch (evidence.state) {
    case 'INVALID':
      return `${metric} was rejected at the provider boundary (${evidence.notes[0] ?? 'failed validation'})`;
    case 'STALE':
      return `${metric} observation is too old to speak for the present`;
    case 'UNAVAILABLE':
      return `no provider configured that can report ${metric}`;
    default:
      return `no provider returned ${metric}`;
  }
}

function safetyComponent(evidence: TokenEvidence): Part {
  const notes: string[] = [];
  const missing: string[] = [];
  let earned = 0;
  let knownWeight = 0;

  const add = (
    weight: number,
    item: Evidence<unknown>,
    label: string,
    score: number | null,
    note: string,
  ): void => {
    if (!isUsable(item) || score === null) {
      missing.push(label);
      return;
    }
    earned += weight * clamp01(score);
    knownWeight += weight;
    notes.push(note);
  };

  // A revoked authority is worth full credit; a live one zero. Unknown and
  // conflicted-but-dangerous both earn nothing - a disputed claim of safety is
  // not a claim of safety.
  const mint = evidence.mintAuthorityRevoked;
  add(
    SAFETY_WEIGHTS.mint,
    mint,
    'mint authority',
    mint.value === null ? null : mint.value ? 1 : 0,
    `mint ${mint.value ? 'revoked' : 'LIVE'}${mint.state === 'CONFLICTED' ? ' (disputed)' : ''}`,
  );

  const freeze = evidence.freezeAuthorityRevoked;
  add(
    SAFETY_WEIGHTS.freeze,
    freeze,
    'freeze authority',
    freeze.value === null ? null : freeze.value ? 1 : 0,
    `freeze ${freeze.value ? 'revoked' : 'LIVE'}${freeze.state === 'CONFLICTED' ? ' (disputed)' : ''}`,
  );

  // 10% or less is healthy; at 70% the price is one wallet decision away.
  const concentration = evidence.topHoldersPct;
  add(
    SAFETY_WEIGHTS.concentration,
    concentration,
    'holder concentration',
    concentration.value === null ? null : 1 - clamp01(((concentration.value as number) - 10) / 60),
    `top holders ${(concentration.value as number | null)?.toFixed(0)}%`,
  );

  const rug = evidence.rugcheckRisk;
  add(
    SAFETY_WEIGHTS.rugcheck,
    rug,
    'rugcheck score',
    rug.value === null ? null : 1 - clamp01((rug.value as number) / 100),
    `rugcheck ${(rug.value as number | null)?.toFixed(0)}/100 risk`,
  );

  const organic = evidence.organicScore;
  add(
    SAFETY_WEIGHTS.organic,
    organic,
    'organic score',
    organic.value === null ? null : clamp01((organic.value as number) / 100),
    `organic ${(organic.value as number | null)?.toFixed(0)}`,
  );

  if (missing.length > 0) notes.push(`unknown: ${missing.join(', ')}`);

  const totalWeight = Object.values(SAFETY_WEIGHTS).reduce((sum, w) => sum + w, 0);

  if (knownWeight === 0) {
    return {
      key: 'safety',
      label: 'Safety',
      value: null,
      weight: WEIGHTS.safety,
      detail: 'no safety evidence from any provider',
      unknownReason: 'no provider returned authority, concentration or risk data',
      coverage: 0,
    };
  }

  return {
    key: 'safety',
    label: 'Safety',
    value: clamp01(earned / totalWeight),
    weight: WEIGHTS.safety,
    detail: notes.join(', '),
    coverage: knownWeight / totalWeight,
  };
}

function fmtHours(hours: number): string {
  return hours < 1 ? `${Math.round(hours * 60)}m` : `${hours.toFixed(1)}h`;
}

function known(key: string, label: string, value: number, weight: number, detail: string): Part {
  return { key, label, value: clamp01(value), weight, detail, coverage: 1 };
}

function unknownPart(key: string, label: string, weight: number, unknownReason: string): Part {
  return { key, label, value: null, weight, detail: 'unknown', unknownReason, coverage: 0 };
}

function components(evidence: TokenEvidence): ScoreComponent[] {
  const list: Part[] = [safetyComponent(evidence)];

  // --- liquidity -----------------------------------------------------------
  const liquidity = evidence.liquidityUsd;
  list.push(
    isUsable(liquidity)
      ? known(
          'liquidity',
          'Liquidity',
          logScore(liquidity.value as number, 5_000, 500_000),
          WEIGHTS.liquidity,
          `$${Math.round(liquidity.value as number).toLocaleString('en-US')} pooled${
            liquidity.state === 'CONFLICTED' ? ' (providers disagree, took the lower)' : ''
          }`,
        )
      : unknownPart('liquidity', 'Liquidity', WEIGHTS.liquidity, whyUnusable(liquidity, 'liquidity')),
  );

  // --- activity ------------------------------------------------------------
  // Turnover is volume over liquidity, and both must describe the SAME venue.
  // `venueLiquidityUsd` is DexScreener's own depth, matching the volume it
  // reported; the resolved `liquidityUsd` is the conservative figure across
  // providers and is often a different number, so dividing by it would produce
  // a ratio for a venue that does not exist.
  const volume = evidence.volume24h;
  const venueDepth = evidence.venueLiquidityUsd;
  const sameSource = isUsable(volume) && isUsable(venueDepth) && volume.source === venueDepth.source;

  if (!isUsable(volume)) {
    list.push(unknownPart('activity', 'Activity', WEIGHTS.activity, whyUnusable(volume, '24h volume')));
  } else if (!isUsable(venueDepth)) {
    list.push(
      unknownPart(
        'activity',
        'Activity',
        WEIGHTS.activity,
        'turnover needs the depth of the same venue that reported the volume',
      ),
    );
  } else if (!sameSource) {
    list.push(
      unknownPart(
        'activity',
        'Activity',
        WEIGHTS.activity,
        `turnover would mix ${volume.source} volume with ${venueDepth.source} liquidity, which describes no real venue`,
      ),
    );
  } else {
    const depth = venueDepth.value as number;
    const turnover = depth > 0 ? (volume.value as number) / depth : 0;
    list.push(
      known(
        'activity',
        'Activity',
        turnover > 0 ? bandScore(Math.log10(turnover), Math.log10(3), 0.65) : 0,
        WEIGHTS.activity,
        `${turnover.toFixed(1)}x turnover`,
      ),
    );
  }

  // --- holders -------------------------------------------------------------
  const holders = evidence.holders;
  list.push(
    isUsable(holders)
      ? known(
          'holders',
          'Holders',
          logScore(holders.value as number, 50, 5_000),
          WEIGHTS.holders,
          `${(holders.value as number).toLocaleString('en-US')} wallets`,
        )
      : unknownPart('holders', 'Holders', WEIGHTS.holders, whyUnusable(holders, 'holder count')),
  );

  // --- momentum ------------------------------------------------------------
  const change = evidence.priceChange;
  if (isUsable(change)) {
    const frames = change.value as { h1: number; h6: number };
    const blended = 0.6 * frames.h1 + 0.4 * frames.h6;
    list.push(
      known(
        'momentum',
        'Momentum',
        0.5 + Math.tanh(blended / 60) / 2,
        WEIGHTS.momentum,
        `1h ${frames.h1.toFixed(1)}%, 6h ${frames.h6.toFixed(1)}%`,
      ),
    );
  } else {
    list.push(
      unknownPart('momentum', 'Momentum', WEIGHTS.momentum, whyUnusable(change, 'price history')),
    );
  }

  // --- buy pressure --------------------------------------------------------
  const pressure = evidence.buyPressure;
  list.push(
    isUsable(pressure)
      ? known(
          'pressure',
          'Buy pressure',
          ((pressure.value as number) - 0.35) / 0.3,
          WEIGHTS.pressure,
          `${((pressure.value as number) * 100).toFixed(0)}% buys`,
        )
      : unknownPart('pressure', 'Buy pressure', WEIGHTS.pressure, whyUnusable(pressure, 'trade counts')),
  );

  // --- age -----------------------------------------------------------------
  // Sweet spot around 12h old: past the first chaotic minutes, still new.
  const age = evidence.ageHours;
  list.push(
    isUsable(age) && (age.value as number) > 0
      ? known(
          'age',
          'Age',
          bandScore(Math.log10(age.value as number), Math.log10(12), 0.75),
          WEIGHTS.age,
          `${fmtHours(age.value as number)} old`,
        )
      : unknownPart('age', 'Age', WEIGHTS.age, whyUnusable(age, 'pool creation time')),
  );

  return list.map((part) => ({
    key: part.key,
    label: part.label,
    value: part.value,
    weight: part.weight,
    detail: part.detail,
    coverage: part.coverage,
    ...(part.unknownReason === undefined ? {} : { unknownReason: part.unknownReason }),
  }));
}

export interface FlagInput {
  evidence: TokenEvidence;
  rugcheckRisks: { name: string; level: string; description: string }[];
  hasSocials: boolean;
  jupiterVerified: boolean;
  impersonation?: ImpersonationAssessment | null;
  minLiquidityUsd: number;
}

function riskFlags(input: FlagInput, coverage: number, unknownKeys: string[]): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const { evidence } = input;

  const mint = evidence.mintAuthorityRevoked;
  if (isUsable(mint) && mint.value === false) {
    flags.push({
      code: 'mint_authority',
      level: 'critical',
      message: 'Mint authority is still live - supply can be inflated at will.',
    });
  }
  const freeze = evidence.freezeAuthorityRevoked;
  if (isUsable(freeze) && freeze.value === false) {
    flags.push({
      code: 'freeze_authority',
      level: 'critical',
      message: 'Freeze authority is still live - holder accounts can be frozen.',
    });
  }

  for (const metric of evidence.conflicts) {
    flags.push({
      code: `provider_conflict:${metric}`,
      level: metric.includes('Authority') ? 'high' : 'medium',
      message: `Providers disagree on ${metric}; the conservative reading was used.`,
    });
  }

  const concentration = evidence.topHoldersPct;
  if (isUsable(concentration) && (concentration.value as number) >= 60) {
    flags.push({
      code: 'concentration',
      level: 'high',
      message: `Top holders control ${(concentration.value as number).toFixed(0)}% of supply.`,
    });
  }

  const liquidity = evidence.liquidityUsd;
  if (isUsable(liquidity) && (liquidity.value as number) < input.minLiquidityUsd) {
    flags.push({
      code: 'thin_liquidity',
      level: 'high',
      message: `Only ${Math.round(liquidity.value as number).toLocaleString('en-US')} USD of liquidity - exits will slip badly.`,
    });
  }

  const volume = evidence.volume24h;
  const venueDepth = evidence.venueLiquidityUsd;
  if (
    isUsable(volume) &&
    isUsable(venueDepth) &&
    volume.source === venueDepth.source &&
    (venueDepth.value as number) > 0
  ) {
    const turnover = (volume.value as number) / (venueDepth.value as number);
    if (turnover > 50 && (liquidity.value as number) < 100_000) {
      flags.push({
        code: 'wash_suspect',
        level: 'medium',
        message: `Volume is ${turnover.toFixed(0)}x liquidity - consistent with wash trading.`,
      });
    }
  }

  for (const risk of input.rugcheckRisks) {
    if (risk.level !== 'danger' && risk.level !== 'warn') continue;
    flags.push({
      code: `rugcheck:${risk.name.toLowerCase().replace(/\s+/g, '_')}`,
      level: risk.level === 'danger' ? 'high' : 'medium',
      message: `RugCheck: ${risk.name}${risk.description ? ` - ${risk.description}` : ''}`,
    });
  }

  if (evidence.issues.length > 0) {
    flags.push({
      code: 'provider_data_rejected',
      level: 'medium',
      message: `${evidence.issues.length} provider field(s) failed validation and were discarded: ${evidence.issues
        .slice(0, 3)
        .map((issue) => `${issue.field} (${issue.reason})`)
        .join('; ')}.`,
    });
  }

  if (unknownKeys.length > 0) {
    flags.push({
      code: 'incomplete_evidence',
      level: coverage < 0.6 ? 'medium' : 'low',
      message: `${Math.round(coverage * 100)}% evidence coverage - no data for: ${unknownKeys.join(', ')}. Missing evidence earns no points, so this token cannot score above ${Math.round(coverage * 100)}.`,
    });
  }

  if (!input.hasSocials) {
    flags.push({
      code: 'no_socials',
      level: 'low',
      message: 'No website or socials listed on the pair.',
    });
  }

  // Advisory only: reported, never scored.
  const imp = input.impersonation;
  if (imp?.status === 'assessed' && imp.probability !== null && imp.probability >= 0.7) {
    flags.push({
      code: 'impersonation_suspected',
      level: 'medium',
      message: `Advisory: naming resembles an established token (p=${imp.probability.toFixed(2)}, ${imp.model ?? 'unknown model'}). Not proof of fraud and not scored.`,
    });
  }

  if (input.jupiterVerified) {
    flags.push({ code: 'jup_verified', level: 'info', message: 'Verified on Jupiter.' });
  }

  return flags;
}

/**
 * Multiplier applied to the weighted base score, one factor per flag class.
 *
 * `impersonation_suspected` and `provider_conflict:*` are deliberately absent.
 * The first is an advisory model judgement; the second is already paid for by
 * the conflicted evidence earning no positive credit, and charging it again
 * would penalise the token for our uncertainty twice.
 */
const PENALTIES: Record<string, number> = {
  mint_authority: 0.55,
  freeze_authority: 0.45,
  concentration: 0.7,
  thin_liquidity: 0.65,
  wash_suspect: 0.8,
};

function grade(total: number): Score['grade'] {
  if (total >= 75) return 'A';
  if (total >= 60) return 'B';
  if (total >= 45) return 'C';
  if (total >= 30) return 'D';
  return 'F';
}

export function scoreToken(input: FlagInput): Score {
  const parts = components(input.evidence);

  // Unknown components contribute nothing to the numerator but keep their
  // weight, so missing evidence can never be worth a single point.
  const base = parts.reduce((sum, part) => sum + (part.value ?? 0) * part.weight, 0) * 100;

  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  const coverage =
    totalWeight > 0
      ? parts.reduce((sum, part) => sum + part.weight * part.coverage, 0) / totalWeight
      : 0;

  const unknown = parts.filter((part) => part.value === null).map((part) => part.key);

  const flags = riskFlags(input, coverage, unknown);
  let multiplier = 1;
  for (const flag of flags) {
    const specific = PENALTIES[flag.code];
    if (specific !== undefined) multiplier *= specific;
    else if (flag.code.startsWith('rugcheck:') && flag.level === 'high') multiplier *= 0.85;
  }
  multiplier = Math.max(multiplier, 0.1);

  const total = base * multiplier;

  return {
    total: Math.round(total * 10) / 10,
    base: Math.round(base * 10) / 10,
    grade: grade(total),
    penalty: Math.round((1 - multiplier) * 1000) / 10,
    coverage: Math.round(coverage * 1000) / 1000,
    ceiling: Math.round(coverage * 1000) / 10,
    unknown,
    components: parts,
    flags,
  };
}
