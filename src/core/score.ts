import { clamp01, logScore, bandScore } from '../util/num.ts';
import type {
  JupiterInfo,
  OnChainInfo,
  RiskFlag,
  RugcheckInfo,
  Score,
  ScoreComponent,
  Timeframes,
} from '../types.ts';

export interface ScoreInput {
  liquidityUsd: number;
  volume24h: number;
  ageHours: number | null;
  priceChange: Timeframes;
  holders: number | null;
  buys24h: number | null;
  sells24h: number | null;
  buys1h: number | null;
  sells1h: number | null;
  jupiter: JupiterInfo | null;
  rugcheck: RugcheckInfo | null;
  onchain: OnChainInfo | null;
  hasSocials: boolean;
  minLiquidityUsd: number;
}

/**
 * Weights sum to 1. Safety carries the most because on a chain where anyone
 * can mint in seconds, the question that decides everything is whether the
 * token can be rugged, not how fast it is pumping.
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

/** Share of supply in the top wallets, 0-100, from whichever source has it. */
function concentrationPct(input: ScoreInput): number | null {
  const jup = input.jupiter?.audit.topHoldersPercentage;
  if (jup !== null && jup !== undefined) return jup;
  const chain = input.onchain?.top10Share;
  if (chain !== null && chain !== undefined) return chain * 100;
  return null;
}

function authorityState(input: ScoreInput): { mint: boolean | null; freeze: boolean | null } {
  const audit = input.jupiter?.audit;
  const chain = input.onchain;

  const mintDisabled = audit?.mintAuthorityDisabled ?? (chain ? chain.mintAuthority === null : null);
  const freezeDisabled =
    audit?.freezeAuthorityDisabled ?? (chain ? chain.freezeAuthority === null : null);

  return { mint: mintDisabled, freeze: freezeDisabled };
}

function safetyScore(input: ScoreInput): { value: number; detail: string } {
  const parts: { weight: number; value: number }[] = [];
  const notes: string[] = [];

  const { mint, freeze } = authorityState(input);
  // Unknown authority state scores 0.35: not trusted, not condemned.
  parts.push({ weight: 0.3, value: mint === null ? 0.35 : mint ? 1 : 0 });
  parts.push({ weight: 0.2, value: freeze === null ? 0.35 : freeze ? 1 : 0 });
  notes.push(`mint ${mint === null ? '?' : mint ? 'revoked' : 'LIVE'}`);
  notes.push(`freeze ${freeze === null ? '?' : freeze ? 'revoked' : 'LIVE'}`);

  const concentration = concentrationPct(input);
  if (concentration !== null) {
    // 10% or less is healthy; at 70% the price is one wallet decision away.
    parts.push({ weight: 0.2, value: 1 - clamp01((concentration - 10) / 60) });
    notes.push(`top holders ${concentration.toFixed(0)}%`);
  }

  const rugNorm = input.rugcheck?.scoreNormalised;
  if (rugNorm !== null && rugNorm !== undefined) {
    parts.push({ weight: 0.2, value: 1 - clamp01(rugNorm / 100) });
    notes.push(`rugcheck ${rugNorm.toFixed(0)}/100 risk`);
  }

  const organic = input.jupiter?.organicScore;
  if (organic !== null && organic !== undefined) {
    parts.push({ weight: 0.1, value: clamp01(organic / 100) });
    notes.push(`organic ${organic.toFixed(0)}`);
  }

  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  const value =
    totalWeight > 0 ? parts.reduce((s, p) => s + p.weight * p.value, 0) / totalWeight : 0.3;

  return { value: clamp01(value), detail: notes.join(', ') };
}

function ratio(buys: number | null, sells: number | null): number | null {
  if (buys === null || sells === null) return null;
  const total = buys + sells;
  if (total < 10) return null;
  return buys / total;
}

function fmtHours(hours: number): string {
  return hours < 1 ? `${Math.round(hours * 60)}m` : `${hours.toFixed(1)}h`;
}

function components(input: ScoreInput): ScoreComponent[] {
  const list: ScoreComponent[] = [];

  const safety = safetyScore(input);
  list.push({
    key: 'safety',
    label: 'Safety',
    value: safety.value,
    weight: WEIGHTS.safety,
    detail: safety.detail,
  });

  list.push({
    key: 'liquidity',
    label: 'Liquidity',
    value: logScore(input.liquidityUsd, 5_000, 500_000),
    weight: WEIGHTS.liquidity,
    detail: `$${Math.round(input.liquidityUsd).toLocaleString('en-US')} pooled`,
  });

  // Turnover: 24h volume against pooled liquidity. Near zero is a dead pool,
  // absurdly high is usually wash trading, so the ideal sits around 3x.
  const turnover = input.liquidityUsd > 0 ? input.volume24h / input.liquidityUsd : 0;
  list.push({
    key: 'activity',
    label: 'Activity',
    value: turnover > 0 ? bandScore(Math.log10(turnover), Math.log10(3), 0.65) : 0,
    weight: WEIGHTS.activity,
    detail: `${turnover.toFixed(1)}x turnover`,
  });

  const holders = input.holders;
  list.push({
    key: 'holders',
    label: 'Holders',
    value: holders === null ? 0.2 : logScore(holders, 50, 5_000),
    weight: WEIGHTS.holders,
    detail: holders === null ? 'unknown' : `${holders.toLocaleString('en-US')} wallets`,
  });

  // Momentum leans on 1h and 6h; the 24h window is too slow to say much about
  // a token that may only be hours old.
  const h1 = input.priceChange.h1;
  const h6 = input.priceChange.h6;
  const blended = 0.6 * h1 + 0.4 * h6;
  list.push({
    key: 'momentum',
    label: 'Momentum',
    value: clamp01(0.5 + Math.tanh(blended / 60) / 2),
    weight: WEIGHTS.momentum,
    detail: `1h ${h1.toFixed(1)}%, 6h ${h6.toFixed(1)}%`,
  });

  const pressure = ratio(input.buys1h, input.sells1h) ?? ratio(input.buys24h, input.sells24h);
  list.push({
    key: 'pressure',
    label: 'Buy pressure',
    value: pressure === null ? 0.4 : clamp01((pressure - 0.35) / 0.3),
    weight: WEIGHTS.pressure,
    detail: pressure === null ? 'too few trades' : `${(pressure * 100).toFixed(0)}% buys`,
  });

  // Sweet spot around 12h old: past the first chaotic minutes, still new.
  const age = input.ageHours;
  list.push({
    key: 'age',
    label: 'Age',
    value: age === null || age <= 0 ? 0.3 : bandScore(Math.log10(age), Math.log10(12), 0.75),
    weight: WEIGHTS.age,
    detail: age === null ? 'unknown' : `${fmtHours(age)} old`,
  });

  return list;
}

function riskFlags(input: ScoreInput): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const { mint, freeze } = authorityState(input);

  if (mint === false) {
    flags.push({
      code: 'mint_authority',
      level: 'critical',
      message: 'Mint authority is still live - supply can be inflated at will.',
    });
  }
  if (freeze === false) {
    flags.push({
      code: 'freeze_authority',
      level: 'critical',
      message: 'Freeze authority is still live - holder accounts can be frozen.',
    });
  }

  const concentration = concentrationPct(input);
  if (concentration !== null && concentration >= 60) {
    flags.push({
      code: 'concentration',
      level: 'high',
      message: `Top holders control ${concentration.toFixed(0)}% of supply.`,
    });
  }

  if (input.liquidityUsd < input.minLiquidityUsd) {
    flags.push({
      code: 'thin_liquidity',
      level: 'high',
      message: `Only ${Math.round(input.liquidityUsd).toLocaleString('en-US')} USD of liquidity - exits will slip badly.`,
    });
  }

  const turnover = input.liquidityUsd > 0 ? input.volume24h / input.liquidityUsd : 0;
  if (turnover > 50 && input.liquidityUsd < 100_000) {
    flags.push({
      code: 'wash_suspect',
      level: 'medium',
      message: `Volume is ${turnover.toFixed(0)}x liquidity - consistent with wash trading.`,
    });
  }

  for (const risk of input.rugcheck?.risks ?? []) {
    if (risk.level !== 'danger' && risk.level !== 'warn') continue;
    flags.push({
      code: `rugcheck:${risk.name.toLowerCase().replace(/\s+/g, '_')}`,
      level: risk.level === 'danger' ? 'high' : 'medium',
      message: `RugCheck: ${risk.name}${risk.description ? ` - ${risk.description}` : ''}`,
    });
  }

  if (!input.hasSocials) {
    flags.push({
      code: 'no_socials',
      level: 'low',
      message: 'No website or socials listed on the pair.',
    });
  }

  if (input.jupiter?.isVerified) {
    flags.push({ code: 'jup_verified', level: 'info', message: 'Verified on Jupiter.' });
  }

  return flags;
}

/** Multiplier applied to the weighted base score, one factor per flag class. */
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

export function scoreToken(input: ScoreInput): Score {
  const parts = components(input);
  const base = parts.reduce((sum, part) => sum + part.value * part.weight, 0) * 100;

  const flags = riskFlags(input);
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
    components: parts,
    flags,
  };
}
