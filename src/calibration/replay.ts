/**
 * Calibration replay: how the stored verdicts behaved against what happened.
 *
 * Read-only, over a Token Finder database - normally a copy of the live one.
 * It inspects; it does not tune. Every figure is a count over stored rows,
 * and every outcome is labelled by `calibration/outcomes.ts` (MEASURED, PROXY
 * or UNKNOWN - never price).
 *
 * Sections:
 *
 * 1. **Outcomes by verdict** at 6 h and 24 h, split by policy era.
 * 2. **Hard rejects** by veto code, with the measured outcomes after them -
 *    the rejects to review for being false.
 * 3. **Escapes** - tokens not rejected that then collapsed or were confirmed
 *    drained, and whether and how fast Token Finder rejected them.
 * 4. **Stability** - verdict flips in the stored sequences, and the same
 *    sequences replayed under `stability@1`.
 * 5. **Current decisions** - coverage invariants, bot-heavy tokens, disputed
 *    concentration, manipulation, creator and network history, High
 *    potential, momentum readiness.
 */

import type { CalibrationSource } from '../persist/calibration-reader.ts';
import { labelOutcome, replayStability, type ConfirmedEvent, type Observation, type OutcomeLabel } from './outcomes.ts';
import { VERDICT_TIER } from '../core/ranking.ts';
import { STABILITY } from '../decision/stability.ts';
import type { Eligibility, TokenSnapshot } from '../types.ts';

const HOUR = 3_600_000;
const HORIZONS = { '6h': 6 * HOUR, '24h': 24 * HOUR } as const;
type Horizon = keyof typeof HORIZONS;

interface DecisionPoint {
  mint: string;
  at: number;
  verdict: Eligibility;
  vetoes: string[];
  policy: string;
}

export interface CalibrationReport {
  database: { snapshots: number; tokens: number; from: number | null; to: number | null; decisionPoints: number };
  outcomes: Record<Horizon, { byVerdict: Record<string, Record<string, number>>; byClass: Record<string, number> }>;
  rejects: { byVeto: Record<string, Record<string, number>>; review: { mint: string; vetoes: string[]; outcome: string; detail: string }[] };
  escapes: { mint: string; verdict: string; outcome: OutcomeLabel; detail: string; laterRejected: boolean; rejectedAfterMin: number | null }[];
  stability: { tokens: number; transitions: number; reversals: number; stableTransitions: number; stableReversals: number; worst: { mint: string; transitions: number; stable: number }[] };
  current: {
    decided: number;
    byVerdict: Record<string, number>;
    invariants: { highPotentialUnderCovered: number; rejectedWithoutHardFail: number };
    qualifiedUnanalysed: number;
    botHeavy: { tokens: number; byVerdict: Record<string, number>; highRiskOnAutomationAlone: number };
    disputedConcentration: { tokens: number; corroborated: number; byVerdict: Record<string, number> };
    manipulation: { washElevated: number; washHigh: number; extremeHardFails: number };
    creatorHistory: { suspicious: number; malicious: number; networkModerate: number; networkStrong: number; serialHardFails: number; confirmedRugHardFails: number };
    highPotential: { tokens: number; blockedBy: Record<string, number> };
    momentum: { byState: Record<string, number>; insufficientShare: number };
  };
  notes: string[];
}

const inc = (o: Record<string, number>, k: string, n = 1): void => {
  o[k] = (o[k] ?? 0) + n;
};

function parseCodes(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
}

export function runCalibration(db: CalibrationSource): CalibrationReport {
  const notes: string[] = [];

  // --- decision points: each token's first verdict, and every change -------------------
  const rows = db.verdicts();
  const sequences = new Map<string, { verdict: string; t: number }[]>();
  const points: DecisionPoint[] = [];
  let last: { mint: string; verdict: string } | null = null;
  for (const r of rows) {
    const seq = sequences.get(r.mint) ?? [];
    seq.push({ verdict: r.eligibility, t: r.observedAt });
    sequences.set(r.mint, seq);
    if (last === null || last.mint !== r.mint || last.verdict !== r.eligibility) {
      points.push({ mint: r.mint, at: r.observedAt, verdict: r.eligibility, vetoes: parseCodes(r.vetoCodes), policy: r.policy });
    }
    last = { mint: r.mint, verdict: r.eligibility };
  }

  // --- observations and confirmed events ------------------------------------------------
  const obsByMint = new Map<string, Observation[]>();
  for (const o of db.marketObservations()) {
    const list = obsByMint.get(o.mint) ?? [];
    list.push({ t: o.t, liquidity: o.liquidity, pool: o.pool });
    obsByMint.set(o.mint, list);
  }
  const eventsByMint = new Map<string, ConfirmedEvent[]>();
  for (const e of db.confirmedEvents()) {
    const list = eventsByMint.get(e.mint) ?? [];
    list.push({ type: e.type, at: e.at });
    eventsByMint.set(e.mint, list);
  }
  const observationAt = (mint: string, at: number): Observation | null => {
    let best: Observation | null = null;
    for (const o of obsByMint.get(mint) ?? []) {
      if (Math.abs(o.t - at) <= 10 * 60_000 && (best === null || Math.abs(o.t - at) < Math.abs(best.t - at))) best = o;
    }
    return best;
  };

  // --- 1. outcomes by verdict --------------------------------------------------------------
  const outcomes = {} as CalibrationReport['outcomes'];
  const labelled = new Map<DecisionPoint, Record<Horizon, ReturnType<typeof labelOutcome>>>();
  for (const [name, ms] of Object.entries(HORIZONS) as [Horizon, number][]) {
    const byVerdict: Record<string, Record<string, number>> = {};
    const byClass: Record<string, number> = {};
    for (const p of points) {
      const here = observationAt(p.mint, p.at);
      const o = labelOutcome(p.at, here?.liquidity ?? null, obsByMint.get(p.mint) ?? [], eventsByMint.get(p.mint) ?? [], ms, here?.pool ?? null);
      const entry = labelled.get(p) ?? ({} as Record<Horizon, ReturnType<typeof labelOutcome>>);
      entry[name] = o;
      labelled.set(p, entry);
      const key = `${p.verdict} (${p.policy})`;
      byVerdict[key] ??= {};
      inc(byVerdict[key]!, `${o.class}:${o.label}`);
      inc(byClass, o.class);
    }
    outcomes[name] = { byVerdict, byClass };
  }

  // --- 2. hard rejects -----------------------------------------------------------------------
  const byVeto: Record<string, Record<string, number>> = {};
  const review: CalibrationReport['rejects']['review'] = [];
  for (const p of points) {
    if (p.verdict !== 'REJECTED') continue;
    const o = labelled.get(p)!['24h'];
    for (const v of p.vetoes.length ? p.vetoes : ['(none recorded)']) {
      byVeto[v] ??= {};
      inc(byVeto[v]!, `${o.class}:${o.label}`);
    }
    if (o.label === 'SUSTAINED_LIQUIDITY') review.push({ mint: p.mint, vetoes: p.vetoes, outcome: o.label, detail: o.detail });
  }

  // --- 3. escapes ------------------------------------------------------------------------------
  const escapes: CalibrationReport['escapes'] = [];
  const BAD: OutcomeLabel[] = ['CONFIRMED_DRAIN', 'CONFIRMED_ABUSE', 'LIQUIDITY_COLLAPSE'];
  for (const p of points) {
    if (p.verdict === 'REJECTED' || p.verdict === 'HIGH_RISK') continue;
    const o = labelled.get(p)!['24h'];
    if (!BAD.includes(o.label)) continue;
    const later = (sequences.get(p.mint) ?? []).find((s) => s.t > p.at && s.verdict === 'REJECTED');
    escapes.push({ mint: p.mint, verdict: p.verdict, outcome: o.label, detail: o.detail, laterRejected: later !== undefined, rejectedAfterMin: later ? Math.round((later.t - p.at) / 60_000) : null });
  }

  // --- 4. stability ------------------------------------------------------------------------------
  const tier = (v: string): number => VERDICT_TIER[v as Eligibility] ?? 9;
  let transitions = 0;
  let reversals = 0;
  let stableTransitions = 0;
  let stableReversals = 0;
  const worst: CalibrationReport['stability']['worst'] = [];
  for (const [mint, seq] of sequences) {
    const r = replayStability(seq, tier, STABILITY.confirmations);
    transitions += r.raw;
    reversals += r.reversals;
    stableTransitions += r.stable;
    stableReversals += r.stableReversals;
    if (r.raw >= 3) worst.push({ mint, transitions: r.raw, stable: r.stable });
  }
  worst.sort((a, b) => b.transitions - a.transitions);

  // --- 5. current decisions ----------------------------------------------------------------------
  const current: CalibrationReport['current'] = {
    decided: 0,
    byVerdict: {},
    invariants: { highPotentialUnderCovered: 0, rejectedWithoutHardFail: 0 },
    qualifiedUnanalysed: 0,
    botHeavy: { tokens: 0, byVerdict: {}, highRiskOnAutomationAlone: 0 },
    disputedConcentration: { tokens: 0, corroborated: 0, byVerdict: {} },
    manipulation: { washElevated: 0, washHigh: 0, extremeHardFails: 0 },
    creatorHistory: { suspicious: 0, malicious: 0, networkModerate: 0, networkStrong: 0, serialHardFails: 0, confirmedRugHardFails: 0 },
    highPotential: { tokens: 0, blockedBy: {} },
    momentum: { byState: {}, insufficientShare: 0 },
  };
  for (const payload of db.tokenPayloads()) {
    let t: TokenSnapshot;
    try {
      t = JSON.parse(payload) as TokenSnapshot;
    } catch {
      continue;
    }
    const d = t.decision;
    if (!d) continue;
    current.decided += 1;
    inc(current.byVerdict, d.verdict);
    if (d.verdict === 'HIGH_POTENTIAL' && (d.coverage.market < 0.7 || d.coverage.intelligence < 0.5)) current.invariants.highPotentialUnderCovered += 1;
    if (d.verdict === 'REJECTED' && d.hardFails.length === 0) current.invariants.rejectedWithoutHardFail += 1;
    if (d.verdict === 'QUALIFIED' && d.intelligence.analyzedAt === null) current.qualifiedUnanalysed += 1;
    const contributions = d.integrity.domains.flatMap((x) => x.contributions);
    const codes = new Set(contributions.map((c) => c.code));
    if (codes.has('AUTOMATION')) {
      current.botHeavy.tokens += 1;
      inc(current.botHeavy.byVerdict, d.verdict);
      const actionable = d.integrity.domains.filter((x) => x.band === 'HIGH' || x.band === 'SEVERE');
      if (d.verdict === 'HIGH_RISK' && actionable.length > 0 && actionable.every((x) => x.contributions.every((c) => c.code === 'AUTOMATION'))) current.botHeavy.highRiskOnAutomationAlone += 1;
    }
    const disputed = contributions.find((c) => c.text.includes('(disputed:'));
    if (disputed) {
      current.disputedConcentration.tokens += 1;
      if (disputed.text.includes('corroborates')) current.disputedConcentration.corroborated += 1;
      inc(current.disputedConcentration.byVerdict, d.verdict);
    }
    if (codes.has('WASH_ELEVATED')) current.manipulation.washElevated += 1;
    if (codes.has('WASH_HIGH')) current.manipulation.washHigh += 1;
    if (codes.has('CREATOR_SUSPICIOUS')) current.creatorHistory.suspicious += 1;
    if (codes.has('CREATOR_MALICIOUS')) current.creatorHistory.malicious += 1;
    if (codes.has('NETWORK_MODERATE')) current.creatorHistory.networkModerate += 1;
    if (codes.has('NETWORK_STRONG')) current.creatorHistory.networkStrong += 1;
    for (const f of d.hardFailFamilies) {
      if (f === 'EXTREME_MARKET_MANIPULATION') current.manipulation.extremeHardFails += 1;
      if (f === 'STRONG_SERIAL_RUGGER') current.creatorHistory.serialHardFails += 1;
      if (f === 'CONFIRMED_CURRENT_RUG' || f === 'CONFIRMED_MALICIOUS_TOKEN') current.creatorHistory.confirmedRugHardFails += 1;
    }
    if (d.verdict === 'HIGH_POTENTIAL') current.highPotential.tokens += 1;
    if (d.verdict === 'QUALIFIED') {
      for (const r of d.reasons) if (r.kind === 'blocker') inc(current.highPotential.blockedBy, r.text.replace(/\d+(\.\d+)?%?/g, '#').replace(/\(needs [^)]*\)/, '').trim());
    }
    inc(current.momentum.byState, d.momentum.state);
  }
  current.momentum.insufficientShare = current.decided ? Math.round(((current.momentum.byState.INSUFFICIENT_HISTORY ?? 0) / current.decided) * 1000) / 1000 : 0;

  const measured = outcomes['24h'].byClass.MEASURED ?? 0;
  notes.push(
    `${measured} of ${points.length} decision points have a MEASURED 24 h outcome; the rest are PROXY or UNKNOWN because tokens leave the discovery feeds. Measured outcomes over-represent survivors.`,
    'Price is never used as an outcome.',
    'Phase 1 rows (policy "phase-1") were produced by the Phase 1 gate and score; they are kept apart from decision-policy rows.',
  );

  const span = db.span();
  return {
    database: { snapshots: span.snapshots, tokens: span.tokens, from: span.from, to: span.to, decisionPoints: points.length },
    outcomes,
    rejects: { byVeto, review: review.slice(0, 25) },
    escapes,
    stability: { tokens: sequences.size, transitions, reversals, stableTransitions, stableReversals, worst: worst.slice(0, 10) },
    current,
    notes,
  };
}

/** The report as plain text for the terminal. */
export function formatCalibration(r: CalibrationReport): string {
  const lines: string[] = [];
  const iso = (t: number | null): string => (t === null ? '-' : new Date(t).toISOString().slice(0, 16).replace('T', ' '));
  const table = (o: Record<string, number>): string =>
    Object.entries(o)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
  lines.push(`Calibration replay - ${r.database.snapshots} stored verdicts over ${r.database.tokens} tokens, ${iso(r.database.from)} to ${iso(r.database.to)} UTC`);
  lines.push(`${r.database.decisionPoints} decision points (each token's first verdict and every change)`, '');
  for (const [h, o] of Object.entries(r.outcomes)) {
    lines.push(`Outcomes at ${h}: ${table(o.byClass)}`);
    for (const [v, counts] of Object.entries(o.byVerdict).sort()) lines.push(`  ${v}: ${table(counts)}`);
    lines.push('');
  }
  lines.push('Hard rejects by veto (24 h outcome):');
  for (const [v, counts] of Object.entries(r.rejects.byVeto)) lines.push(`  ${v}: ${table(counts)}`);
  lines.push(`  to review (rejected, liquidity then sustained 24 h): ${r.rejects.review.length}`);
  for (const x of r.rejects.review.slice(0, 10)) lines.push(`    ${x.mint} ${x.vetoes.join(',')} - ${x.detail}`);
  lines.push('', `Escapes (not rejected, then collapsed or confirmed drained within 24 h): ${r.escapes.length}`);
  for (const e of r.escapes.slice(0, 15)) lines.push(`  ${e.mint} ${e.verdict} -> ${e.outcome} (${e.detail}); ${e.laterRejected ? `rejected ${e.rejectedAfterMin} min after the verdict` : 'not rejected while observed'}`);
  const s = r.stability;
  lines.push('', `Stability: ${s.transitions} verdict changes over ${s.tokens} tokens, ${s.reversals} immediate reversals (A->B->A)`);
  lines.push(`  replayed under stability@1: ${s.stableTransitions} changes, ${s.stableReversals} reversals`);
  for (const w of s.worst.slice(0, 5)) lines.push(`  ${w.mint}: ${w.transitions} changes -> ${w.stable}`);
  const c = r.current;
  lines.push('', `Current decisions: ${c.decided} - ${table(c.byVerdict)}`);
  lines.push(`  invariants: High potential under-covered ${c.invariants.highPotentialUnderCovered}, Rejected without a hard fail ${c.invariants.rejectedWithoutHardFail}`);
  lines.push(`  Qualified without deep intelligence: ${c.qualifiedUnanalysed}`);
  lines.push(`  bot-heavy: ${c.botHeavy.tokens} (${table(c.botHeavy.byVerdict)}); High risk on automation alone: ${c.botHeavy.highRiskOnAutomationAlone}`);
  lines.push(`  disputed concentration: ${c.disputedConcentration.tokens}, corroborated ${c.disputedConcentration.corroborated} (${table(c.disputedConcentration.byVerdict)})`);
  lines.push(`  manipulation: wash elevated ${c.manipulation.washElevated}, wash high ${c.manipulation.washHigh}, extreme hard fails ${c.manipulation.extremeHardFails}`);
  lines.push(`  creator/network: suspicious ${c.creatorHistory.suspicious}, malicious ${c.creatorHistory.malicious}, network moderate ${c.creatorHistory.networkModerate}, strong ${c.creatorHistory.networkStrong}; serial hard fails ${c.creatorHistory.serialHardFails}, confirmed-rug hard fails ${c.creatorHistory.confirmedRugHardFails}`);
  lines.push(`  High potential: ${c.highPotential.tokens}; Qualified blocked by: ${table(c.highPotential.blockedBy)}`);
  lines.push(`  momentum: ${table(c.momentum.byState)} (insufficient history ${Math.round(c.momentum.insufficientShare * 100)}%)`);
  lines.push('', ...r.notes.map((n) => `note: ${n}`));
  return lines.join('\n');
}
