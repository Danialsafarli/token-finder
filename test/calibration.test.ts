/**
 * Calibration (Phase 4): outcome labels from stored facts only, and the two
 * findings the replay produced.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelOutcome, replayStability } from '../src/calibration/outcomes.ts';
import { decide } from '../src/decision/engine.ts';
import { gatherHistory, NO_SOURCES, type DecisionSources } from '../src/decision/inputs.ts';
import { VERDICT_TIER } from '../src/core/ranking.ts';
import type { MarketPoint } from '../src/persist/repository.ts';
import type { Eligibility } from '../src/types.ts';
import { bundle, CONFIG, HOUR, MIN, MINT, NOW, token } from './decision-helpers.ts';

const H6 = 6 * HOUR;

test('outcomes are MEASURED, PROXY or UNKNOWN - from events and same-pool liquidity, never price', () => {
  const at = NOW;
  const through = (liquidity: number, pool = 'P1') => Array.from({ length: 13 }, (_, i) => ({ t: at + (i + 1) * 30 * MIN, liquidity, pool }));

  assert.equal(labelOutcome(at, 50_000, through(40_000), [], H6, 'P1').label, 'SUSTAINED_LIQUIDITY');
  assert.equal(labelOutcome(at, 50_000, through(20_000), [], H6, 'P1').label, 'LIQUIDITY_DECLINED');
  const collapse = labelOutcome(at, 50_000, [{ t: at + 20 * MIN, liquidity: 4_000, pool: 'P1' }], [], H6, 'P1');
  assert.deepEqual([collapse.class, collapse.label], ['MEASURED', 'LIQUIDITY_COLLAPSE']);
  // A migration to another pool is not a collapse: the figures are not comparable.
  assert.equal(labelOutcome(at, 2_500_000, [{ t: at + 3 * MIN, liquidity: 10_000, pool: 'P2' }], [], H6, 'P1').class, 'UNKNOWN');
  assert.equal(labelOutcome(at, 50_000, [{ t: at + 3 * HOUR, liquidity: 45_000, pool: 'P1' }], [], H6, 'P1').class, 'PROXY');
  assert.equal(labelOutcome(at, 50_000, [{ t: at + 10 * MIN, liquidity: 45_000, pool: 'P1' }], [], H6, 'P1').label, 'NOT_OBSERVED');
  assert.equal(labelOutcome(at, 50_000, [], [{ type: 'LIQUIDITY_DRAIN', at: at + HOUR }], H6).label, 'CONFIRMED_DRAIN');
  assert.equal(labelOutcome(at, 50_000, [], [{ type: 'LIQUIDITY_DRAIN', at: at - HOUR }], H6).label, 'NOT_OBSERVED', 'an event before the verdict is not an outcome of it');

  // The live flip, replayed: stability@1 removes the bounce, keeps the danger.
  const seq = ['QUALIFIED', 'REJECTED', 'QUALIFIED', 'REJECTED', 'QUALIFIED', 'QUALIFIED'].map((verdict, i) => ({ verdict, t: i }));
  const r = replayStability(seq, (v) => VERDICT_TIER[v as Eligibility], 2);
  assert.equal(r.raw, 4);
  assert.equal(r.reversals, 3);
  assert.equal(r.stable, 2, 'QUALIFIED -> REJECTED immediately, back only after two clean readings');
  assert.equal(r.stableReversals, 0);
});

test('regression: a pool migration is not a liquidity collapse; a same-pool collapse is HIGH_RISK', () => {
  // Found in the replay: a $2.5M pump.fun curve followed by a $10K PumpSwap
  // pool read as a 99.6% collapse. And a real 90% same-pool collapse stayed
  // QUALIFIED because it only earned the 40% "liquidity leaving" risk.
  const points = (pools: string[], liquidity: number[]): MarketPoint[] =>
    liquidity.map((l, i) => ({ observedAt: NOW - (liquidity.length - i) * 10 * MIN, priceUsd: 0.01, liquidityUsd: l, volume24h: null, marketCap: null, fdv: null, buyRatio24h: null, poolAddress: pools[i]!, dexId: null }));
  const sources = (market: MarketPoint[]): DecisionSources => ({ ...NO_SOURCES, marketHistory: () => market });
  const decideWith = (market: MarketPoint[], currentPool: string, currentLiquidity: number) => {
    const t = token({ liquidityUsd: currentLiquidity });
    t.pair = { ...(t.pair ?? ({} as NonNullable<typeof t.pair>)), pairAddress: currentPool };
    t.priceUsd = 0.01;
    return decide({ snapshot: t, bundle: bundle(t, { analysed: false }), history: gatherHistory(sources(market), MINT, NOW, currentPool), now: NOW, config: CONFIG });
  };
  const codes = (d: ReturnType<typeof decide>) => d.integrity.domains.flatMap((x) => x.contributions.map((c) => c.code));

  const migrated = decideWith(points(['CURVE', 'CURVE', 'CURVE', 'CURVE'], [2_500_000, 2_450_000, 2_520_000, 2_510_000]), 'PUMPSWAP', 60_000);
  assert.ok(!codes(migrated).includes('LIQUIDITY_COLLAPSE'), 'another pool\'s liquidity is not compared');
  assert.ok(!codes(migrated).includes('LIQUIDITY_LEAVING'));

  const drained = decideWith(points(['POOL', 'POOL', 'POOL', 'POOL'], [66_000, 69_000, 56_000, 15_700]), 'POOL', 6_800);
  assert.ok(codes(drained).includes('LIQUIDITY_COLLAPSE'));
  assert.equal(drained.verdict, 'HIGH_RISK', 'serious soft risk on confident evidence');
  assert.equal(drained.hardFails.length, 0, 'not proof of a rug: never a hard fail on its own');
});
