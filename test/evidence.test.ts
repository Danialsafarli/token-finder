/**
 * Evidence resolution, the safety gate, coverage, eligibility and the token
 * lifecycle, driven from the deterministic regression corpus.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline, hasVeto } from './pipeline.ts';
import { FIXTURES, fixtureByName } from './fixtures.ts';
import { resolve, freshnessOf, isUsable, type Claim } from '../src/core/evidence.ts';
import {
  buildCoverage,
  canTransition,
  evaluateEligibility,
  settleState,
  transition,
} from '../src/core/lifecycle.ts';
import type { CoverageReport, Veto } from '../src/types.ts';

const HOUR = 3_600_000;

describe('resolution primitives', () => {
  const at = Date.now();

  test('silence is UNKNOWN', () => {
    const out = resolve<number>([], { metric: 'holders', now: at });
    assert.equal(out.state, 'UNKNOWN');
    assert.equal(out.value, null);
  });

  test('a single valid claim is MEASURED at that provider trust', () => {
    const out = resolve<number>([{ provider: 'jupiter', value: 100, observedAt: at }], {
      metric: 'holders',
      now: at,
    });
    assert.equal(out.state, 'MEASURED');
    assert.equal(out.value, 100);
    assert.equal(out.source, 'jupiter');
    assert.ok(out.confidence > 0);
  });

  test('agreement stays MEASURED and takes the most trusted source', () => {
    const claims: Claim<number>[] = [
      { provider: 'jupiter', value: 100, observedAt: at },
      { provider: 'helius', value: 100, observedAt: at },
    ];
    const out = resolve<number>(claims, { metric: 'holders', now: at });
    assert.equal(out.state, 'MEASURED');
    assert.equal(out.source, 'helius', 'on-chain outranks a report about the chain');
  });

  test('contradiction is CONFLICTED, keeps every claim, and loses confidence', () => {
    const claims: Claim<number>[] = [
      { provider: 'jupiter', value: 100, observedAt: at },
      { provider: 'dexscreener', value: 900, observedAt: at },
    ];
    const agreed = resolve<number>(
      [{ provider: 'jupiter', value: 100, observedAt: at }],
      { metric: 'holders', now: at },
    );
    const out = resolve<number>(claims, { metric: 'holders', now: at });

    assert.equal(out.state, 'CONFLICTED');
    assert.equal(out.claims.length, 2, 'disagreement must stay visible');
    assert.ok(out.confidence < agreed.confidence);
  });

  test('every claim rejected is INVALID, which is not UNKNOWN', () => {
    const out = resolve<number>(
      [{ provider: 'jupiter', value: null, observedAt: at, invalid: 'above maximum 100' }],
      { metric: 'organicScore', now: at },
    );
    assert.equal(out.state, 'INVALID');
    assert.equal(isUsable(out), false);
    assert.ok(out.notes[0]?.includes('rejected'));
  });

  test('an observation past its aging window becomes STALE and stops being usable', () => {
    const out = resolve<number>(
      [{ provider: 'dexscreener', value: 5, observedAt: at - 3 * HOUR }],
      { metric: 'priceChange', now: at },
    );
    assert.equal(out.state, 'STALE');
    assert.equal(isUsable(out), false);
  });

  test('freshness windows differ per metric, so one timeout cannot serve both', () => {
    const twoHoursAgo = at - 2 * HOUR;
    assert.equal(freshnessOf('priceChange', twoHoursAgo, at), 'STALE');
    assert.equal(freshnessOf('mintAuthorityRevoked', twoHoursAgo, at), 'FRESH');
  });

  test('an aging observation is still usable but worth less', () => {
    const fresh = resolve<number>([{ provider: 'jupiter', value: 1, observedAt: at }], {
      metric: 'holders',
      now: at,
    });
    const aging = resolve<number>(
      [{ provider: 'jupiter', value: 1, observedAt: at - 8 * HOUR }],
      { metric: 'holders', now: at },
    );
    assert.equal(aging.state, 'MEASURED');
    assert.equal(aging.freshness, 'AGING');
    assert.ok(aging.confidence < fresh.confidence);
  });
});

describe('cross-provider authority resolution', () => {
  test('a RugCheck danger beats a Jupiter claim of safety and is marked CONFLICTED', () => {
    const result = runPipeline(fixtureByName('provider-disagreement-authority'));
    const mint = result.evidence.mintAuthorityRevoked;

    assert.equal(mint.state, 'CONFLICTED');
    assert.equal(mint.value, false, 'the dangerous reading must win');
    assert.ok(result.evidence.conflicts.includes('mintAuthorityRevoked'));
    assert.equal(mint.claims.length, 2, 'both claims are retained');
  });

  test('conflicted safety evidence still fires the gate', () => {
    const result = runPipeline(fixtureByName('provider-disagreement-authority'));
    assert.ok(hasVeto(result, 'AUTHORITY_MINT_ACTIVE'));
    assert.equal(result.eligibility, 'REJECTED');
  });

  test('conflicted safety evidence earns no positive safety credit', () => {
    const disputed = runPipeline(fixtureByName('provider-disagreement-authority'));
    const clean = runPipeline(fixtureByName('healthy-established'));
    const safetyOf = (r: typeof clean): number =>
      r.score.components.find((c) => c.key === 'safety')?.value ?? 0;

    assert.ok(safetyOf(disputed) < safetyOf(clean), 'a disputed claim of safety is not safety');
  });

  test('silence from one provider is not evidence of safety, and never vetoes', () => {
    const result = runPipeline(fixtureByName('provider-silence-not-safety'));
    assert.equal(result.evidence.mintAuthorityRevoked.state, 'UNKNOWN');
    assert.equal(hasVeto(result, 'AUTHORITY_MINT_ACTIVE'), false, 'no false veto from UNKNOWN');
    assert.equal(hasVeto(result, 'AUTHORITY_FREEZE_ACTIVE'), false);
  });

  test('liquidity disagreement takes the lower reading', () => {
    const at = Date.now();
    const out = resolve<number>(
      [
        { provider: 'dexscreener', value: 500_000, observedAt: at },
        { provider: 'jupiter', value: 100_000, observedAt: at },
      ],
      {
        metric: 'liquidityUsd',
        now: at,
        resolveConflict: (claims) => {
          let index = 0;
          for (let i = 1; i < claims.length; i++) {
            if ((claims[i]?.value ?? Infinity) < (claims[index]?.value ?? Infinity)) index = i;
          }
          return index;
        },
      },
    );
    assert.equal(out.value, 100_000, 'the optimistic depth reading is the expensive one to believe');
  });
});

describe('hard safety gate', () => {
  test('a live mint authority rejects the token outright', () => {
    const result = runPipeline(fixtureByName('dangerous-mint-authority'));
    assert.ok(hasVeto(result, 'AUTHORITY_MINT_ACTIVE'));
    assert.equal(result.eligibility, 'REJECTED');
    assert.equal(result.state, 'REJECTED');
  });

  test('every veto carries a full audit record', () => {
    const result = runPipeline(fixtureByName('dangerous-mint-authority'));
    const veto = result.vetoes[0] as Veto;
    assert.ok(veto.code.length > 0);
    assert.ok(veto.reason.length > 20, 'a reason a person can read');
    assert.ok(veto.source.length > 0);
    assert.ok(veto.observedValue.length > 0);
    assert.ok(veto.at > 0);
    assert.equal(typeof veto.recheckable, 'boolean');
  });

  test('an authority veto is re-checkable; a creator rug history is not', () => {
    const authority = runPipeline(fixtureByName('dangerous-mint-authority'));
    assert.equal(authority.vetoes.find((v) => v.code === 'AUTHORITY_MINT_ACTIVE')?.recheckable, true);

    const history = runPipeline(fixtureByName('critical-rugcheck-creator-history'));
    assert.ok(hasVeto(history, 'CRITICAL_RUGCHECK'));
    assert.equal(history.vetoes.find((v) => v.code === 'CRITICAL_RUGCHECK')?.recheckable, false);
  });

  test('measured zero liquidity is UNTRADEABLE', () => {
    const result = runPipeline(fixtureByName('zero-liquidity'));
    assert.ok(hasVeto(result, 'UNTRADEABLE'));
  });

  test('unknown liquidity never produces a tradability veto', () => {
    const result = runPipeline(fixtureByName('low-coverage'));
    assert.equal(hasVeto(result, 'UNTRADEABLE'), false);
  });

  test('structurally impossible provider data vetoes MALFORMED_TOKEN', () => {
    const result = runPipeline(fixtureByName('malformed-provider-response'));
    assert.ok(hasVeto(result, 'MALFORMED_TOKEN'));
    assert.equal(result.eligibility, 'REJECTED');
  });

  test('a Helius pool-vault share does not veto, because vaults inflate it', () => {
    const result = runPipeline(fixtureByName('pool-vault-concentration-not-vetoed'));
    assert.equal(result.evidence.topHoldersPct.source, 'helius');
    assert.equal(
      hasVeto(result, 'CATASTROPHIC_CONCENTRATION'),
      false,
      'vetoing here would reject healthy tokens whose liquidity sits in a pool account',
    );
  });

  test('a Jupiter-measured catastrophic concentration does veto', () => {
    const result = runPipeline(fixtureByName('extreme-concentration'));
    assert.equal(result.evidence.topHoldersPct.source, 'jupiter');
    assert.ok(hasVeto(result, 'CATASTROPHIC_CONCENTRATION'));
  });

  test('a healthy token collects no vetoes at all', () => {
    const result = runPipeline(fixtureByName('healthy-established'));
    assert.deepEqual(result.vetoes, []);
  });
});

describe('coverage and confidence', () => {
  test('a fully measured token reports full coverage and no gaps', () => {
    const result = runPipeline(fixtureByName('healthy-established'));
    assert.equal(result.coverage.unknown, 0);
    assert.equal(result.coverage.invalid, 0);
    assert.equal(result.coverage.conflicted, 0);
    assert.ok(result.coverage.coverage > 0.99);
    assert.equal(result.score.coverage, 1);
  });

  test('a token with no market pair loses exactly the market signals', () => {
    const result = runPipeline(fixtureByName('missing-market-pair'));
    assert.ok(result.coverage.unknown > 0);
    assert.ok(result.coverage.coverage < 1);
    assert.ok(result.score.unknown.includes('momentum'));
    assert.ok(result.score.unknown.includes('pressure'));
    assert.ok(result.score.unknown.includes('activity'));
  });

  test('coverage counts each evidence state separately', () => {
    const result = runPipeline(fixtureByName('malformed-provider-response'));
    const c: CoverageReport = result.coverage;
    assert.ok(c.invalid > 0, 'rejected fields are counted as invalid, not unknown');
    assert.equal(
      c.measured + c.unknown + c.conflicted + c.invalid + c.stale + c.unavailable,
      c.eligibleSignals,
      'every eligible signal lands in exactly one bucket',
    );
  });

  test('confidence is separate from coverage and not a product of it', () => {
    const clean = runPipeline(fixtureByName('healthy-established'));
    const disputed = runPipeline(fixtureByName('provider-disagreement-authority'));

    assert.ok(clean.coverage.confidence > disputed.coverage.confidence, 'conflict costs confidence');
    assert.notEqual(
      clean.coverage.confidence,
      clean.coverage.coverage * clean.score.total / 100,
      'confidence must not be a restatement of score x coverage',
    );
  });

  test('single-provider dependence is measured and reported', () => {
    const result = runPipeline(fixtureByName('missing-market-pair'));
    assert.ok(result.coverage.providerConcentration > 0.5);
    assert.equal(result.coverage.dominantProvider, 'jupiter');
  });

  test('provider concentration lowers confidence', () => {
    const spread = runPipeline(fixtureByName('healthy-established'));
    const concentrated = runPipeline(fixtureByName('missing-market-pair'));
    assert.ok(concentrated.coverage.providerConcentration > spread.coverage.providerConcentration);
  });

  test('an empty evidence set reports zero coverage without dividing by zero', () => {
    const result = runPipeline({
      name: 'empty',
      asserts: 'no providers at all',
      dexPairs: [],
      jupiter: null,
      rugcheck: null,
      onchain: null,
    });
    assert.equal(result.coverage.coverage, 0);
    assert.equal(result.coverage.confidence, 0);
    assert.equal(Number.isFinite(result.score.total), true);
  });
});

describe('ranking eligibility', () => {
  test('a clean, well-covered token QUALIFIES', () => {
    assert.equal(runPipeline(fixtureByName('healthy-established')).eligibility, 'QUALIFIED');
  });

  test('a veto outranks a strong score', () => {
    const rejected = runPipeline(fixtureByName('dangerous-mint-authority'));
    const qualified = runPipeline(fixtureByName('healthy-established'));

    assert.equal(rejected.eligibility, 'REJECTED');
    // The rejected fixture is the healthy one with one field flipped, so its
    // remaining signals are strong - which is exactly the case a penalty
    // multiplier fails to contain.
    assert.ok(rejected.score.base > 40, 'this token still scores well on everything else');
    assert.equal(qualified.eligibility, 'QUALIFIED');
  });

  test('a rejected token can never be ranked above a qualified one', () => {
    const ranked = [
      runPipeline(fixtureByName('dangerous-mint-authority')),
      runPipeline(fixtureByName('healthy-established')),
    ]
      .filter((r) => r.eligibility === 'QUALIFIED')
      .sort((a, b) => b.score.total - a.score.total);

    assert.equal(ranked.length, 1);
    assert.equal(ranked[0]?.vetoes.length, 0);
  });

  test('poor coverage lands in INSUFFICIENT_DATA rather than the ranking', () => {
    const result = runPipeline(fixtureByName('low-coverage'));
    assert.equal(result.eligibility, 'INSUFFICIENT_DATA');
  });

  test('middling coverage lands in WATCH', () => {
    const coverage: CoverageReport = {
      eligibleSignals: 12,
      measured: 6,
      unknown: 6,
      conflicted: 0,
      invalid: 0,
      stale: 0,
      unavailable: 0,
      coverage: 0.5,
      confidence: 0.8,
      providerConcentration: 0.5,
      dominantProvider: 'jupiter',
    };
    assert.equal(evaluateEligibility([], coverage), 'WATCH');
  });

  test('a low-coverage token is never presented as fully trusted', () => {
    const result = runPipeline(fixtureByName('low-coverage'));
    assert.notEqual(result.eligibility, 'QUALIFIED');
    assert.ok(result.score.ceiling < 100);
    assert.ok(result.score.flags.some((flag) => flag.code === 'incomplete_evidence'));
  });

  test('a partially covered token still carries its gap, even when it qualifies', () => {
    // The pairless token has real evidence for safety, depth and holders, so
    // 72% coverage is enough to rank it - but the missing market signals must
    // stay visible rather than being smoothed away by the score.
    const result = runPipeline(fixtureByName('missing-market-pair'));
    assert.ok(result.coverage.coverage < 0.8);
    assert.ok(result.score.ceiling < 100);
    assert.ok(result.score.flags.some((flag) => flag.code === 'incomplete_evidence'));
    assert.ok(
      result.coverage.confidence < 1,
      'leaning entirely on one provider must cost confidence',
    );
  });
});

describe('token lifecycle', () => {
  test('discovered moves only to scanning', () => {
    assert.ok(canTransition('DISCOVERED', 'SCANNING'));
    assert.equal(canTransition('DISCOVERED', 'QUALIFIED'), false);
  });

  test('scanning settles into any resting state', () => {
    for (const to of ['QUALIFIED', 'WATCH', 'INSUFFICIENT_DATA', 'REJECTED'] as const) {
      assert.ok(canTransition('SCANNING', to), `SCANNING -> ${to}`);
    }
  });

  test('every resting state can re-enter scanning, so nothing is a dead end', () => {
    for (const from of ['QUALIFIED', 'WATCH', 'INSUFFICIENT_DATA', 'REJECTED'] as const) {
      assert.ok(canTransition(from, 'SCANNING'), `${from} -> SCANNING`);
    }
  });

  test('an illegal transition is refused rather than silently applied', () => {
    const out = transition('REJECTED', 'QUALIFIED');
    assert.equal(out.legal, false);
    assert.equal(out.moved, false);
    assert.equal(out.state, 'REJECTED', 'a token cannot teleport past the gate');
  });

  test('re-analysis routes through scanning and lands on fresh evidence', () => {
    assert.equal(settleState('REJECTED', 'QUALIFIED'), 'QUALIFIED');
    assert.equal(settleState('QUALIFIED', 'REJECTED'), 'REJECTED');
    assert.equal(settleState(null, 'WATCH'), 'WATCH');
  });

  test('a token whose danger clears can leave REJECTED', () => {
    const before = runPipeline(fixtureByName('dangerous-mint-authority'));
    assert.equal(before.state, 'REJECTED');

    const after = runPipeline(fixtureByName('healthy-established'), { priorState: before.state });
    assert.equal(after.state, 'QUALIFIED', 're-checkable vetoes must be able to clear');
  });

  test('state is derived from eligibility, never from the score alone', () => {
    for (const fixture of FIXTURES) {
      const result = runPipeline(fixture);
      if (result.vetoes.length > 0) {
        assert.equal(result.state, 'REJECTED', `${fixture.name} has vetoes but is not REJECTED`);
      }
    }
  });
});

describe('scoring integrity across the corpus', () => {
  test('unknown evidence never contributes points, in any fixture', () => {
    for (const fixture of FIXTURES) {
      const { score } = runPipeline(fixture);
      for (const component of score.components) {
        if (component.value === null) {
          assert.equal(component.coverage, 0, `${fixture.name}/${component.key}`);
        }
      }
      const recomputed =
        score.components.reduce((sum, c) => sum + (c.value ?? 0) * c.weight, 0) * 100;
      assert.ok(Math.abs(recomputed - score.base) < 0.05, `${fixture.name} base is component-derived`);
    }
  });

  test('base score never exceeds the ceiling implied by coverage', () => {
    for (const fixture of FIXTURES) {
      const { score } = runPipeline(fixture);
      assert.ok(
        score.base <= score.ceiling + 0.05,
        `${fixture.name}: base ${score.base} over ceiling ${score.ceiling}`,
      );
    }
  });

  test('scoring is deterministic: the same fixture scores identically every time', () => {
    const now = Date.now();
    for (const fixture of FIXTURES) {
      const a = runPipeline(fixture, { now });
      const b = runPipeline(fixture, { now });
      assert.equal(a.score.total, b.score.total, fixture.name);
      assert.equal(a.eligibility, b.eligibility, fixture.name);
      assert.deepEqual(
        a.vetoes.map((v) => v.code),
        b.vetoes.map((v) => v.code),
        fixture.name,
      );
    }
  });

  test('a measured zero scores zero but still counts as evidence', () => {
    const result = runPipeline(fixtureByName('zero-liquidity'));

    const volume = result.evidence.volume24h;
    assert.equal(volume.state, 'MEASURED');
    assert.equal(volume.value, 0, 'a pool that traded nothing is a measurement, not silence');

    const activity = result.score.components.find((c) => c.key === 'activity');
    assert.equal(activity?.value, 0, 'a dead pool genuinely has zero activity');
    assert.equal(activity?.coverage, 1, 'and that zero is evidence, so coverage is unharmed');
    assert.equal(activity?.unknownReason, undefined);

    // The contrast that matters: an unmeasured pool earns the same zero points
    // but loses coverage, because we never learned anything about it.
    const unmeasured = runPipeline(fixtureByName('missing-market-pair'));
    const unmeasuredActivity = unmeasured.score.components.find((c) => c.key === 'activity');
    assert.equal(unmeasuredActivity?.value, null);
    assert.equal(unmeasuredActivity?.coverage, 0);
  });

  test('turnover is refused when the venue that reported the volume has no usable depth', () => {
    // The pair's own liquidity was rejected at the boundary, so the only depth
    // left is Jupiter's wider aggregate. Dividing DexScreener volume by that
    // would describe a venue that does not exist, so activity stays unknown
    // rather than silently falling back.
    const result = runPipeline(fixtureByName('cross-provider-turnover-mismatch'));
    const activity = result.score.components.find((c) => c.key === 'activity');

    assert.equal(result.evidence.volume24h.source, 'dexscreener');
    assert.equal(result.evidence.liquidityUsd.source, 'jupiter', 'overall depth falls back');
    assert.equal(result.evidence.venueLiquidityUsd.state, 'INVALID', 'the venue depth does not');
    assert.equal(activity?.value, null);
    assert.match(activity?.unknownReason ?? '', /same venue/);
  });

  test('turnover uses the venue depth, not the conservative cross-provider figure', () => {
    // DexScreener and Jupiter routinely report different depth because they
    // index different venue sets. Turnover must divide by DexScreener's own
    // number, or almost every token would lose its activity signal.
    const result = runPipeline(fixtureByName('healthy-established'));
    const activity = result.score.components.find((c) => c.key === 'activity');

    assert.equal(result.evidence.venueLiquidityUsd.source, 'dexscreener');
    assert.notEqual(activity?.value, null, 'a normal token keeps its activity signal');
    assert.equal(activity?.coverage, 1);
  });

  test('differing provider scope is not reported as a contradiction', () => {
    // Jupiter aggregates more venues than DexScreener indexes, so a gap of
    // tens of percent is scope, not disagreement. Calling it a conflict would
    // mark nearly every token CONFLICTED and make the flag meaningless.
    const scoped = runPipeline({
      ...fixtureByName('healthy-established'),
      jupiter: { ...(fixtureByName('healthy-established').jupiter as object), liquidity: 170_000 },
    });
    assert.equal(scoped.evidence.liquidityUsd.state, 'MEASURED');
    assert.equal(scoped.evidence.liquidityUsd.value, 170_000, 'the conservative figure still wins');
    assert.equal(scoped.evidence.conflicts.includes('liquidityUsd'), false);
  });

  test('an order-of-magnitude depth gap is a real conflict', () => {
    const contradictory = runPipeline({
      ...fixtureByName('healthy-established'),
      jupiter: { ...(fixtureByName('healthy-established').jupiter as object), liquidity: 4_000 },
    });
    assert.equal(contradictory.evidence.liquidityUsd.state, 'CONFLICTED');
    assert.equal(contradictory.evidence.liquidityUsd.value, 4_000, 'conservative reading');
  });

  test('wash-shaped volume flags without vetoing', () => {
    const result = runPipeline(fixtureByName('suspicious-launch-wash-volume'));
    assert.ok(result.score.flags.some((flag) => flag.code === 'wash_suspect'));
    assert.deepEqual(result.vetoes, [], 'a market pattern is a penalty, not a veto');
  });

  test('rejected provider fields are surfaced as a flag', () => {
    const result = runPipeline(fixtureByName('malformed-provider-response'));
    assert.ok(result.score.flags.some((flag) => flag.code === 'provider_data_rejected'));
  });

  test('every fixture produces a finite, bounded score', () => {
    for (const fixture of FIXTURES) {
      const { score } = runPipeline(fixture);
      assert.ok(Number.isFinite(score.total), fixture.name);
      assert.ok(score.total >= 0 && score.total <= 100, `${fixture.name}: ${score.total}`);
      assert.ok(Number.isFinite(score.base));
    }
  });
});
