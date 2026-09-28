/**
 * Momentum v2: what the token's own observed history says about its trend.
 *
 * Phase 1 momentum was one blend of DexScreener's 1h and 6h change. That is a
 * provider's single reading; it cannot tell a steady climb from one candle, and
 * it says nothing about whether the move is still going. This model reads the
 * observations Token Finder itself recorded - every stored market snapshot, a
 * row per material change or half-hour heartbeat - and asks four questions:
 *
 *   direction      the log return over 30 min, 2 h and 6 h windows
 *   persistence    what share of the steps between observations went up
 *   acceleration   whether the recent rate exceeds the longer one
 *   stability      whether one step carries most of the move (a spike),
 *                  and whether liquidity left while the price rose
 *
 * ## Honesty rules
 *
 * - **No invented candles.** Only real observations are used. A window is
 *   measured only if an observation sits at or near its start; otherwise it
 *   is absent, not interpolated.
 * - **No precision from sparse data.** Fewer than three observations, or less
 *   than twenty minutes of them, is INSUFFICIENT_HISTORY with no score.
 * - **No one-candle hype.** ACCELERATING and SUSTAINED need the 2 h window,
 *   several steps and a move not carried by a single step.
 * - **Provider frames are shown, never mixed in.** DexScreener's 5m-24h
 *   changes ride along for comparison; they do not move the state.
 */

import { MODEL_VERSIONS } from './versions.ts';
import type { MomentumAssessment, MomentumState, MomentumWindow } from './types.ts';

export interface MarketObservation {
  t: number;
  price: number | null;
  liquidity: number | null;
  holders: number | null;
}

export const MOMENTUM = {
  minObservations: 3,
  minSpanMs: 20 * 60_000,
  /** A window counts when an observation lies within this share of its length of its start. */
  windowSlack: 0.25,
  /** Moves smaller than this between two observations are flat, not a step. */
  flatStep: 0.005,
  spikeShare: 0.7,
  spikeMinMove: 0.1,
  volatility: 0.15,
  risingMid: 0.03,
  fallingMid: -0.05,
} as const;

const WINDOWS: { key: MomentumWindow['key']; ms: number }[] = [
  { key: '30m', ms: 30 * 60_000 },
  { key: '2h', ms: 2 * 3_600_000 },
  { key: '6h', ms: 6 * 3_600_000 },
];

const SCORE: Record<MomentumState, number | null> = {
  ACCELERATING: 0.85,
  SUSTAINED: 0.75,
  NEUTRAL: 0.45,
  COOLING: 0.35,
  UNSTABLE: 0.2,
  DECLINING: 0.15,
  INSUFFICIENT_HISTORY: null,
};

const pct = (x: number): string => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const mins = (ms: number): string => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : `${Math.round(ms / 60_000)} min`);

export function assessMomentum(
  history: MarketObservation[],
  now: number,
  providerFrames: MomentumAssessment['providerFrames'] = null,
): MomentumAssessment {
  // Real observations only: a price, a time, within the last day, one per instant.
  const seen = new Set<number>();
  const points = history
    .filter((p) => p.price !== null && p.price > 0 && Number.isFinite(p.t) && p.t <= now && now - p.t <= 24 * 3_600_000)
    .sort((a, b) => a.t - b.t)
    .filter((p) => (seen.has(p.t) ? false : (seen.add(p.t), true)));

  const base: MomentumAssessment = {
    model: MODEL_VERSIONS.momentum,
    state: 'INSUFFICIENT_HISTORY',
    score: null,
    confidence: 0,
    observations: points.length,
    spanMs: points.length >= 2 ? (points.at(-1)!.t - points[0]!.t) : 0,
    windows: [],
    persistence: null,
    spikiness: null,
    liquidityChange: null,
    holderChange: null,
    providerFrames,
    reasons: [],
  };

  if (points.length < MOMENTUM.minObservations || base.spanMs < MOMENTUM.minSpanMs) {
    base.reasons.push(
      `${points.length} observation(s) over ${mins(base.spanMs)}; at least ${MOMENTUM.minObservations} over ${mins(MOMENTUM.minSpanMs)} are needed before a trend is stated`,
    );
    return base;
  }

  const last = points.at(-1)!;
  const windows: MomentumWindow[] = [];
  for (const w of WINDOWS) {
    const start = last.t - w.ms;
    // The observation closest to the window's start, from at or before it, or
    // at most `windowSlack` of the window after it.
    const candidates = points.filter((p) => p.t <= start + w.ms * MOMENTUM.windowSlack && p.t < last.t);
    const anchor = candidates.at(-1);
    if (!anchor) continue;
    const inside = points.filter((p) => p.t >= anchor.t);
    const logReturn = Math.log((last.price as number) / (anchor.price as number));
    windows.push({ key: w.key, spanMs: last.t - anchor.t, logReturn, change: Math.expm1(logReturn), observations: inside.length });
  }
  base.windows = windows;

  // Steps inside the longest measured window (or all of history when none).
  const longest = windows.at(-1);
  const from = longest ? last.t - longest.spanMs : points[0]!.t;
  const scope = points.filter((p) => p.t >= from);
  const steps: number[] = [];
  for (let i = 1; i < scope.length; i++) steps.push(Math.log((scope[i]!.price as number) / (scope[i - 1]!.price as number)));
  const moving = steps.filter((s) => Math.abs(s) >= MOMENTUM.flatStep);
  const persistence = moving.length === 0 ? null : moving.filter((s) => s > 0).length / moving.length;
  const absTotal = steps.reduce((a, s) => a + Math.abs(s), 0);
  const spikiness = steps.length >= 3 && absTotal > 0 ? Math.max(...steps.map(Math.abs)) / absTotal : null;
  const mean = steps.length ? steps.reduce((a, b) => a + b, 0) / steps.length : 0;
  const volatility = steps.length >= 3 ? Math.sqrt(steps.reduce((a, s) => a + (s - mean) ** 2, 0) / steps.length) : 0;
  base.persistence = persistence === null ? null : Math.round(persistence * 1000) / 1000;
  base.spikiness = spikiness === null ? null : Math.round(spikiness * 1000) / 1000;

  const firstLiq = scope.find((p) => p.liquidity !== null)?.liquidity ?? null;
  const lastLiq = [...scope].reverse().find((p) => p.liquidity !== null)?.liquidity ?? null;
  base.liquidityChange = firstLiq && lastLiq ? Math.round((lastLiq / firstLiq - 1) * 1000) / 1000 : null;
  const firstHolders = scope.find((p) => p.holders !== null)?.holders ?? null;
  const lastHolders = [...scope].reverse().find((p) => p.holders !== null)?.holders ?? null;
  base.holderChange = firstHolders !== null && lastHolders !== null ? lastHolders - firstHolders : null;

  const short = windows.find((w) => w.key === '30m');
  const mid = windows.find((w) => w.key === '2h');
  const long = windows.find((w) => w.key === '6h');
  const rate = (w: MomentumWindow | undefined): number | null => (w && w.spanMs > 0 ? w.logReturn / (w.spanMs / 3_600_000) : null);
  const totalMove = longest ? longest.logReturn : Math.log((last.price as number) / (points[0]!.price as number));

  const reasons: string[] = [];
  let state: MomentumState;
  const spiky = spikiness !== null && spikiness >= MOMENTUM.spikeShare && Math.abs(totalMove) >= MOMENTUM.spikeMinMove;
  const drained = base.liquidityChange !== null && base.liquidityChange <= -0.3 && totalMove > 0.2;
  const whipsaw = persistence !== null && persistence > 0.35 && persistence < 0.65 && volatility >= MOMENTUM.volatility;

  if (spiky) {
    state = 'UNSTABLE';
    reasons.push(`one step carries ${Math.round((spikiness as number) * 100)}% of the ${pct(Math.expm1(totalMove))} move: a spike, not a trend`);
  } else if (drained) {
    state = 'UNSTABLE';
    reasons.push(`price ${pct(Math.expm1(totalMove))} while liquidity ${pct(base.liquidityChange as number)}: the rise is not backed by depth`);
  } else if (whipsaw) {
    state = 'UNSTABLE';
    reasons.push(`large moves in both directions (step volatility ${(volatility * 100).toFixed(0)}%)`);
  } else if (!mid) {
    // Without two hours of observations, acceleration and persistence cannot
    // be told from a single burst, so neither is claimed.
    const r = short?.logReturn ?? totalMove;
    state = r <= MOMENTUM.fallingMid ? 'DECLINING' : 'NEUTRAL';
    reasons.push(`only ${mins(base.spanMs)} of observations; a 2 h window is needed before calling a trend sustained or accelerating`);
  } else {
    const rShort = rate(short);
    const rMid = rate(mid) as number;
    if (mid.logReturn > MOMENTUM.risingMid && short && short.logReturn > 0 && rShort !== null && rShort > rMid * 1.2 && (persistence ?? 0) >= 0.5) {
      state = 'ACCELERATING';
      reasons.push(`30 min ${pct(short.change)} at a faster rate than 2 h ${pct(mid.change)}, with ${Math.round((persistence ?? 0) * 100)}% of steps up`);
    } else if (mid.logReturn > MOMENTUM.risingMid && (persistence ?? 0) >= 0.55 && (!long || long.logReturn > 0)) {
      state = 'SUSTAINED';
      reasons.push(`2 h ${pct(mid.change)}${long ? `, 6 h ${pct(long.change)}` : ''}, ${Math.round((persistence ?? 0) * 100)}% of steps up`);
    } else if ((mid.logReturn > 0 && short !== undefined && short.logReturn <= 0) || (long !== undefined && long.logReturn > 0 && mid.logReturn <= 0)) {
      state = 'COOLING';
      reasons.push(`earlier gains (${long ? `6 h ${pct(long.change)}` : `2 h ${pct(mid.change)}`}) are not continuing (${short ? `30 min ${pct(short.change)}` : `2 h ${pct(mid.change)}`})`);
    } else if (mid.logReturn <= MOMENTUM.fallingMid && (persistence ?? 1) <= 0.4) {
      state = 'DECLINING';
      reasons.push(`2 h ${pct(mid.change)} with most steps down`);
    } else {
      state = 'NEUTRAL';
      reasons.push(`2 h ${pct(mid.change)}: no clear direction`);
    }
  }
  if (base.holderChange !== null && base.holderChange !== 0) reasons.push(`holders ${base.holderChange > 0 ? '+' : ''}${base.holderChange} over the window`);

  base.state = state;
  base.score = SCORE[state];
  base.confidence = Math.round(Math.min(1, points.length / 8) * Math.min(1, base.spanMs / (2 * 3_600_000)) * 1000) / 1000;
  base.reasons = reasons;
  return base;
}
