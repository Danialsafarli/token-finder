/**
 * Verdict stability (decision/stability.ts): a noisy reading at a threshold
 * cannot bounce a verdict, and confirmed danger is never delayed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, type DecisionInput } from '../src/decision/engine.ts';
import { STABILITY, type PreviousVerdict } from '../src/decision/stability.ts';
import type { Decision } from '../src/decision/types.ts';
import { bundle, CONFIG, event, MIN, NOW, steadyRise, token } from './decision-helpers.ts';

/** One reading at `at`, decided against the previous stored verdict. */
function reading(at: number, vetoCodes: string[] | undefined, previous: Decision | null, events = [] as ReturnType<typeof event>[]): Decision {
  const t = token(vetoCodes ? { vetoCodes } : {});
  t.at = at;
  const input: DecisionInput = {
    snapshot: t,
    bundle: bundle(t, { events }),
    history: steadyRise(),
    now: at,
    config: CONFIG,
    previous: previous ? ({ verdict: previous.verdict, decidedAt: previous.decidedAt, hardFails: previous.hardFails, stability: previous.stability ?? null } satisfies PreviousVerdict) : null,
  };
  return decide(input);
}

test('a noisy reading at the concentration threshold cannot bounce the verdict', () => {
  // The live case: provider concentration around 90%, so the Phase 1 veto
  // fires on one scan and not the next.
  const first = reading(NOW, undefined, null);
  assert.equal(first.verdict, 'HIGH_POTENTIAL', 'the fixture is a clean, well-covered token');

  const vetoed = reading(NOW + 2 * MIN, ['CATASTROPHIC_CONCENTRATION'], first);
  assert.equal(vetoed.verdict, 'REJECTED', 'toward danger: immediately');

  const clear = reading(NOW + 4 * MIN, undefined, vetoed);
  assert.equal(clear.verdict, 'REJECTED', 'one clearing reading is held');
  assert.equal(clear.stability?.held, true);
  assert.equal(clear.stability?.raw, 'HIGH_POTENTIAL');
  assert.ok(clear.hardFails.length > 0, 'a held REJECTED keeps the hard fail it was rejected on');
  assert.match(clear.basis, /held at Rejected/);

  // The same observation re-decided (new intelligence, same market reading) is not a second confirmation.
  const redecided = reading(NOW + 4 * MIN, undefined, clear);
  assert.equal(redecided.verdict, 'REJECTED');

  const vetoedAgain = reading(NOW + 6 * MIN, ['CATASTROPHIC_CONCENTRATION'], clear);
  assert.equal(vetoedAgain.verdict, 'REJECTED');
  assert.equal(vetoedAgain.stability?.pending, null, 'a danger reading resets the pending upgrade');

  // Confirmation: two consecutive independent clearing readings.
  const one = reading(NOW + 8 * MIN, undefined, vetoedAgain);
  const two = reading(NOW + 10 * MIN, undefined, one);
  assert.equal(one.verdict, 'REJECTED');
  assert.equal(two.verdict, 'HIGH_POTENTIAL', `a better verdict applies after ${STABILITY.confirmations} readings`);
  assert.equal(two.hardFails.length, 0);
});

test('a confirmed current rug bypasses stability entirely', () => {
  const first = reading(NOW, undefined, null);
  // A pending upgrade from a worse verdict must not slow a hard fail either.
  const held = reading(NOW + 2 * MIN, undefined, { ...first, verdict: 'HIGH_RISK', stability: undefined });
  assert.equal(held.verdict, 'HIGH_RISK');
  assert.equal(held.stability?.held, true);

  const rug = event({ type: 'LIQUIDITY_DRAIN', status: 'CONFIRMED' });
  const rugged = reading(NOW + 2 * MIN, undefined, held, [rug]);
  assert.equal(rugged.verdict, 'REJECTED', 'on the very reading that confirms it');
  assert.equal(rugged.hardFails[0]!.code, 'CONFIRMED_CURRENT_RUG');
  assert.equal(rugged.stability?.held, false);
});
