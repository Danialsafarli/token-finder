/**
 * The decision engine, scenario by scenario.
 *
 * Each test states a situation a real token can be in and pins what the
 * engine must conclude - and, as often, what it must not. The engine runs for
 * real on data shaped exactly as the pipeline stores it (decision-helpers.ts).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bundle, CREATOR, event, history, HOUR, MIN, MINT, NOW, run, steadyRise, token } from './decision-helpers.ts';
import { assessMomentum } from '../src/decision/momentum.ts';
import { marketCoverage } from '../src/intel/coverage.ts';
import { ruleStatus, RULE_VERSIONS } from '../src/decision/versions.ts';
import { planDeepCollection, poolsFor } from '../src/ingest/budget.ts';
import { CANDIDATE_VERDICTS } from '../src/core/ranking.ts';

describe('decision engine: verdicts', () => {
  test('1. a healthy organic token is not rejected', () => {
    const t = token();
    const { decision } = run(t, bundle(t));
    assert.notEqual(decision.verdict, 'REJECTED');
    assert.notEqual(decision.verdict, 'HIGH_RISK');
    assert.equal(decision.hardFails.length, 0);
    assert.ok(decision.integrity.band === 'CLEAR' || decision.integrity.band === 'LOW', decision.integrity.band);
  });

  test('2. a bot-heavy but legitimate token takes a penalty, not a rejection', () => {
    const t = token();
    const bots = run(t, bundle(t, { shares: { automated: 0.8, likely_organic: 0.1, unknown: 0.1 } })).decision;
    const clean = run(token(), bundle(token())).decision;
    assert.equal(bots.hardFails.length, 0);
    assert.notEqual(bots.verdict, 'REJECTED');
    assert.notEqual(bots.verdict, 'HIGH_RISK', 'bots are not scams');
    const activity = bots.integrity.domains.find((d) => d.key === 'activityIntegrity')!;
    assert.equal(activity.band, 'ELEVATED');
    assert.ok(activity.contributions.some((c) => c.code === 'AUTOMATION'));
    assert.ok((bots.rankScore ?? 0) < (clean.rankScore ?? 0), 'the automation is charged in the ranking');
    assert.ok(bots.reasons.some((r) => r.kind === 'risk' && /automated/.test(r.text)));
  });

  test('3. a sniper-heavy token without manipulation is a significant risk, not an automatic rejection', () => {
    const t = token();
    const { decision } = run(t, bundle(t, { shares: { sniper: 0.7, likely_organic: 0.2, unknown: 0.1 } }));
    assert.equal(decision.hardFails.length, 0);
    assert.equal(decision.verdict, 'HIGH_RISK');
    assert.equal(decision.integrity.driver, 'activityIntegrity');
  });

  test('4. a low-coverage token cannot become Qualified or High potential', () => {
    const thin = token({ coverage: 0.45 });
    const { decision } = run(thin, bundle(thin, { shares: { likely_organic: 0.95, unknown: 0.05 } }), history(240, 10, (i) => 0.3 * Math.pow(1.03, i)));
    assert.equal(decision.verdict, 'WATCH');

    // Market evidence fine, deep intelligence absent: never High potential.
    const unanalysed = token();
    const b = bundle(unanalysed, { analysed: false });
    const second = run(unanalysed, b).decision;
    assert.notEqual(second.verdict, 'HIGH_POTENTIAL');
    assert.ok(second.reasons.some((r) => r.kind === 'blocker' && /deep intelligence coverage/.test(r.text)));
  });

  test('5. strong wash evidence is a major integrity risk', () => {
    const t = token();
    const { decision } = run(t, bundle(t, { wash: { risk: 'HIGH', confidence: 0.7, coverage: 0.9, families: ['ROUND_TRIPS', 'CONCENTRATION'], roundTrip: 0.25 } }));
    assert.equal(decision.hardFails.length, 0, 'two families are not the extreme case');
    assert.equal(decision.verdict, 'HIGH_RISK');
    assert.equal(decision.integrity.driver, 'walletCoordination');
  });

  test('6. extreme manipulation on representative data is a hard fail; on a sliver it is not', () => {
    const extreme = { risk: 'HIGH', confidence: 0.8, coverage: 0.95, families: ['ROUND_TRIPS', 'CONCENTRATION', 'RELATIONSHIP'], roundTrip: 0.55, trades: 120 };
    const t = token();
    const rejected = run(t, bundle(t, { wash: extreme })).decision;
    assert.equal(rejected.verdict, 'REJECTED');
    assert.deepEqual(rejected.hardFails.map((f) => f.code), ['EXTREME_MARKET_MANIPULATION']);
    const fail = rejected.hardFails[0]!;
    assert.equal(fail.family, 'EXTREME_MARKET_MANIPULATION');
    assert.ok((fail.confidence ?? 0) >= 0.6);
    assert.equal(fail.recheckable, true);
    assert.ok(fail.ruleVersion);

    // The same readings from a small slice of the market do not reject.
    const sliver = token();
    const partial = run(sliver, bundle(sliver, { wash: extreme, representativeness: 0.2 })).decision;
    assert.equal(partial.hardFails.length, 0);
    assert.notEqual(partial.verdict, 'REJECTED');
  });

  test('7. a confirmed current rug is rejected regardless of momentum', () => {
    const t = token();
    const rocket = history(240, 10, (i) => 0.2 * Math.pow(1.06, i));
    const { decision } = run(t, bundle(t, { events: [event({ type: 'LIQUIDITY_DRAIN', status: 'CONFIRMED', reasons: ['92% of the pool\'s token reserve removed', 'by a creator-linked wallet'] })] }), rocket);
    assert.equal(decision.verdict, 'REJECTED');
    assert.equal(decision.hardFails[0]!.code, 'CONFIRMED_CURRENT_RUG');
    assert.equal(decision.hardFails[0]!.recheckable, false);
    assert.equal(decision.rankScore, null, 'a rejected token is not ranked');
    assert.ok(['ACCELERATING', 'SUSTAINED'].includes(decision.momentum.state), 'the momentum was real, and irrelevant');
  });

  test('8. a serial-rugger network hard-fails only with the required evidence', () => {
    const target = 'Rugger1111111111111111111111111111111111111';
    const rugs = (n: number) => Array.from({ length: n }, (_, i) => event({ mint: `RugLaunch${i}`, type: 'LIQUIDITY_DRAIN', status: 'CONFIRMED' }));
    const serial = { network: { level: 'STRONG', findings: [{ target, pathConfidence: 0.85 }] }, targets: { [target]: { launches: ['RugLaunch0', 'RugLaunch1'], events: rugs(2) } } };

    const t = token();
    const strong = run(t, bundle(t, serial)).decision;
    assert.equal(strong.verdict, 'REJECTED');
    assert.equal(strong.hardFails[0]!.code, 'STRONG_SERIAL_RUGGER');
    assert.ok(strong.hardFails[0]!.evidence!.length > 0, 'the path is the evidence');

    // One confirmed prior rug: serious, but not serial.
    const once = token();
    const single = run(once, bundle(once, { ...serial, targets: { [target]: { launches: ['RugLaunch0'], events: rugs(1) } } })).decision;
    assert.equal(single.hardFails.length, 0);
    assert.equal(single.verdict, 'HIGH_RISK');

    // Two rugs, but the creator is ambiguous: no one to pin it on.
    const ambiguous = token();
    const amb = run(ambiguous, bundle(ambiguous, { ...serial, attribution: { status: 'AMBIGUOUS', confidence: 0.3 } })).decision;
    assert.equal(amb.hardFails.length, 0);

    // Two rugs through a weak path.
    const weakPath = token();
    const weak = run(weakPath, bundle(weakPath, { ...serial, network: { level: 'STRONG', findings: [{ target, pathConfidence: 0.4 }] } })).decision;
    assert.equal(weak.hardFails.length, 0);
  });

  test('9. weak creator suspicion is soft risk only', () => {
    const t = token();
    const { decision } = run(t, bundle(t, { creatorEvents: [event({ mint: 'OtherLaunch1', type: 'CREATOR_DUMP', status: 'SUSPICIOUS' })] }));
    const creator = decision.integrity.domains.find((d) => d.key === 'creatorReputation')!;
    assert.equal(creator.band, 'LOW');
    assert.equal(decision.hardFails.length, 0);
    assert.notEqual(decision.verdict, 'HIGH_RISK');
    assert.notEqual(decision.verdict, 'REJECTED');
  });

  test('10. an event from an obsolete rule cannot poison a current verdict', () => {
    const t = token();
    const legacy = [
      event({ type: 'LIQUIDITY_DRAIN', status: 'CONFIRMED', ruleVersion: null }), // written before versioning
      event({ type: 'SUPPLY_EXPANSION', status: 'CONFIRMED', ruleVersion: 'security-events@0' }), // a superseded rule
      event({ type: 'FREEZE_ABUSE', status: 'CONFIRMED', supersededAt: NOW - HOUR }), // current rule, later superseded
    ];
    const b = bundle(t, { events: legacy });
    const { decision } = run(t, b);
    assert.equal(decision.hardFails.length, 0, 'no hard fail from a finding that is no longer evidence');
    assert.notEqual(decision.verdict, 'REJECTED');
    assert.equal(b.security.value!.active.length, 0);
    assert.equal(b.security.value!.superseded.length, 3, 'kept for audit, not deleted');
    assert.deepEqual(b.security.value!.superseded.map((e) => e.ruleStatus), ['UNVERSIONED', 'SUPERSEDED', 'CURRENT']);

    // The same obsolete finding cannot make the creator a rugger either.
    const other = token();
    const creator = run(other, bundle(other, { creatorEvents: [event({ mint: 'OtherLaunch1', type: 'LIQUIDITY_DRAIN', status: 'CONFIRMED', ruleVersion: null })] })).decision;
    assert.equal(creator.integrity.domains.find((d) => d.key === 'creatorReputation')!.band, 'CLEAR');

    // A whole snapshot from before versioning is superseded, not trusted.
    const old = token();
    const oldBundle = bundle(old, { ruleVersions: null, wash: { risk: 'HIGH', confidence: 0.9, coverage: 0.95, families: ['ROUND_TRIPS', 'CONCENTRATION', 'RELATIONSHIP'], roundTrip: 0.6, trades: 200 } });
    assert.equal(oldBundle.wash.status, 'SUPERSEDED');
    assert.equal(run(old, oldBundle).decision.hardFails.length, 0);
  });

  test('11. bonding-curve concentration does not create a false holder-risk rejection', () => {
    const t = token({
      providerTopPct: null,
      holderRoles: { rawTop10Share: 0.96, walletTop10Share: 0.06, byRole: { BONDING_CURVE: 0.9, WALLET: 0.06 }, resolved: 10, total: 10 },
    });
    const b = bundle(t);
    const { decision } = run(t, b);
    assert.equal(decision.hardFails.length, 0);
    assert.equal(b.holders.value!.rawTop10Pct, 96, 'the raw measurement is kept');
    assert.equal(b.holders.value!.walletTop10Pct, 6);
    const holders = decision.integrity.domains.find((d) => d.key === 'holderIntegrity')!;
    assert.equal(holders.band, 'CLEAR');
    assert.equal(holders.contributions.length, 0);
  });

  test('12. unresolved holder roles lower coverage and never invent a figure', () => {
    const resolved = token();
    const unresolved = token({
      providerTopPct: null,
      holderRoles: { rawTop10Share: 0.7, walletTop10Share: null, byRole: { POOL: 0.3, WALLET: 0.3, UNKNOWN: 0.1 }, resolved: 8, total: 10 },
    });
    const a = bundle(resolved);
    const b = bundle(unresolved);
    assert.ok(b.holders.coverage < a.holders.coverage);
    assert.equal(b.holders.value!.walletTop10Pct, null, 'withheld, not estimated');
    assert.equal(b.holders.value!.roleAware, false);
    const holders = run(unresolved, b).decision.integrity.domains.find((d) => d.key === 'holderIntegrity')!;
    assert.equal(holders.contributions.length, 0, 'the raw figure is not charged');
    assert.ok(holders.unknown.some((u) => /owners unresolved/.test(u)));
  });

  test('13. high momentum on an unsafe token is still rejected', () => {
    const t = token({ vetoCodes: ['AUTHORITY_MINT_ACTIVE'] });
    const { decision, snapshot } = run(t, bundle(t), history(240, 10, (i) => 0.2 * Math.pow(1.05, i)));
    assert.equal(decision.verdict, 'REJECTED');
    assert.equal(decision.hardFails[0]!.family, 'CRITICAL_TOKEN_AUTHORITY_RISK');
    assert.equal(snapshot.evaluation!.eligibility, 'REJECTED');
    assert.equal(snapshot.evaluation!.vetoes.length, 1, 'REJECTED always carries its hard fail');
  });

  test('14. a safe token with weak momentum is not High potential', () => {
    const t = token();
    const flat = history(180, 15, (i) => 0.5 * (i % 2 === 0 ? 1 : 1.003));
    const { decision } = run(t, bundle(t), flat);
    assert.equal(decision.verdict, 'QUALIFIED');
    assert.ok(decision.reasons.some((r) => r.kind === 'blocker' && /momentum/.test(r.text)));
  });

  test('15. safe, strong opportunity, real momentum and sufficient coverage reach High potential', () => {
    const t = token();
    const { decision, snapshot } = run(t, bundle(t), steadyRise(180, 15));
    assert.equal(decision.verdict, 'HIGH_POTENTIAL', JSON.stringify(decision.reasons.filter((r) => r.kind === 'blocker')));
    assert.equal(snapshot.evaluation!.state, 'HIGH_POTENTIAL');
    assert.ok(decision.opportunity.score >= 65);
    assert.ok(['ACCELERATING', 'SUSTAINED'].includes(decision.momentum.state));
    assert.ok(decision.reasons.some((r) => r.kind === 'positive'));
    assert.ok(CANDIDATE_VERDICTS.has(decision.verdict));
  });

  test('16. a missing provider degrades to unknown, never to safe', () => {
    const t = token({ states: { rugcheckRisk: 'UNAVAILABLE', mintExtensions: 'UNAVAILABLE' }, coverage: 0.7 });
    const b = bundle(t, { analysed: false });
    const { decision } = run(t, b);
    for (const key of ['activityIntegrity', 'walletCoordination', 'creatorReputation', 'rugHistory'] as const) {
      const domain = decision.integrity.domains.find((d) => d.key === key)!;
      assert.equal(domain.band, 'UNKNOWN', `${key} is unknown, not clear`);
      assert.equal(domain.risk, null);
    }
    const security = decision.integrity.domains.find((d) => d.key === 'tokenSecurity')!;
    assert.ok(security.unknown.includes('RugCheck risk score'));
    assert.ok(decision.integrity.coverage < 0.6);
    assert.notEqual(decision.verdict, 'HIGH_POTENTIAL');
    assert.equal(b.activity.status, 'UNAVAILABLE');
    assert.ok(decision.rank!.uncertaintyPenalty > 0, 'what could not be checked costs rank');
  });

  test('17. partial multi-pool coverage lowers confidence in activity and wash', () => {
    const full = token();
    const fullBundle = bundle(full, { representativeness: 1 });
    const part = token();
    const partBundle = bundle(part, { representativeness: 0.25 });
    assert.ok(partBundle.activity.coverage < fullBundle.activity.coverage);
    assert.ok(partBundle.wash.coverage < fullBundle.wash.coverage);
    assert.equal(partBundle.activity.status, 'PARTIAL');
  });
});

describe('decision engine: ranking and explanation', () => {
  test('100 coordinated wallets do not look better than 20 independent ones', () => {
    const coordinated = token();
    const crowd = run(coordinated, bundle(coordinated, { wallets: 100, walletShares: { coordinated: 1 }, clusters: [{ level: 'CONFIRMED_RELATIONSHIP', size: 100, confidence: 0.9 }] })).decision;
    const independent = token();
    const few = run(independent, bundle(independent, { wallets: 20, walletShares: { likely_organic: 1 } })).decision;
    assert.ok((few.opportunity.effectiveParticipants ?? 0) > (crowd.opportunity.effectiveParticipants ?? 0));
    assert.equal(crowd.opportunity.effectiveParticipants, 1, 'one cluster is one participant');
    const p = (d: typeof few) => d.opportunity.components.find((c) => c.key === 'participation')!.value ?? 0;
    assert.ok(p(few) > p(crowd));
  });

  test('rank = opportunity - integrity penalty - unverified penalty, and every hard fail explains itself', () => {
    const t = token();
    const { decision } = run(t, bundle(t, { shares: { automated: 0.8, likely_organic: 0.1, unknown: 0.1 } }));
    const r = decision.rank!;
    assert.ok(Math.abs(decision.rankScore! - Math.max(0, r.opportunity - r.integrityPenalty - r.uncertaintyPenalty)) < 0.2);
    const rejected = token({ vetoCodes: ['LIQUIDITY_TOO_LOW'] });
    const fail = run(rejected, bundle(rejected)).decision.hardFails[0]!;
    for (const field of ['code', 'reason', 'family', 'confidence', 'freshness', 'ruleVersion'] as const) assert.ok(fail[field] !== undefined, field);
    assert.equal(typeof fail.recheckable, 'boolean');
  });

  test('a decision names its policy and model versions', () => {
    const t = token();
    const { decision } = run(t, bundle(t));
    assert.equal(decision.policyVersion, 'decision-policy@1');
    assert.equal(decision.models.integrity, 'integrity@1');
    assert.equal(decision.models.momentum, 'momentum@2');
  });

  test('rule status: only current versions are evidence', () => {
    assert.equal(ruleStatus('security', RULE_VERSIONS.security), 'CURRENT');
    assert.equal(ruleStatus('security', 'security-events@0'), 'SUPERSEDED');
    assert.equal(ruleStatus('security', null), 'UNVERSIONED');
  });
});

describe('Momentum v2', () => {
  test('fewer than three observations, or under twenty minutes, is insufficient history with no score', () => {
    const two = assessMomentum([{ t: NOW - 30 * MIN, price: 1, liquidity: null, holders: null }, { t: NOW, price: 2, liquidity: null, holders: null }], NOW);
    assert.equal(two.state, 'INSUFFICIENT_HISTORY');
    assert.equal(two.score, null);
    const short = assessMomentum([0, 5, 10, 15].map((m) => ({ t: NOW - m * MIN, price: 1 + m / 100, liquidity: null, holders: null })), NOW);
    assert.equal(short.state, 'INSUFFICIENT_HISTORY');
  });

  test('one candle carrying the move is unstable, not momentum', () => {
    const points = [0, 15, 30, 45, 60, 75, 90, 105, 120].map((m, i) => ({ t: NOW - (120 - m) * MIN, price: i === 8 ? 2 : 1 + i * 0.001, liquidity: 100_000, holders: null }));
    const m = assessMomentum(points, NOW);
    assert.equal(m.state, 'UNSTABLE');
    assert.ok((m.spikiness ?? 0) >= 0.7);
  });

  test('a price rising while liquidity drains is unstable', () => {
    const points = Array.from({ length: 10 }, (_, i) => ({ t: NOW - (9 - i) * 15 * MIN, price: 1 * Math.pow(1.04, i), liquidity: 100_000 * Math.pow(0.9, i), holders: null }));
    assert.equal(assessMomentum(points, NOW).state, 'UNSTABLE');
  });

  test('a steady rise over two hours is sustained; without two hours it is not claimed', () => {
    const steady = Array.from({ length: 11 }, (_, i) => ({ t: NOW - (10 - i) * 15 * MIN, price: Math.pow(1.02, i), liquidity: 100_000, holders: null }));
    const m = assessMomentum(steady, NOW);
    assert.ok(['SUSTAINED', 'ACCELERATING'].includes(m.state), m.state);
    assert.ok(m.confidence >= 0.5);
    const brief = steady.slice(-4);
    const b = assessMomentum(brief, NOW);
    assert.ok(!['SUSTAINED', 'ACCELERATING'].includes(b.state), b.state);
  });

  test('provider frames ride along and never change the state', () => {
    const steady = Array.from({ length: 11 }, (_, i) => ({ t: NOW - (10 - i) * 15 * MIN, price: 1, liquidity: 100_000, holders: null }));
    const a = assessMomentum(steady, NOW, { m5: 50, h1: 400, h6: 900, h24: 900 });
    const b = assessMomentum(steady, NOW, null);
    assert.equal(a.state, b.state);
    assert.deepEqual(a.providerFrames, { m5: 50, h1: 400, h6: 900, h24: 900 });
  });
});

describe('multi-pool coverage', () => {
  const pools = [
    { address: 'A', dexId: 'raydium', quoteSymbol: 'SOL', liquidityUsd: 100_000, volume24h: 80_000, txnsH1: 60, txns24h: 1_200 },
    { address: 'B', dexId: 'meteora', quoteSymbol: 'SOL', liquidityUsd: 40_000, volume24h: 15_000, txnsH1: 20, txns24h: 300 },
    { address: 'C', dexId: 'orca', quoteSymbol: 'USDC', liquidityUsd: 5_000, volume24h: 5_000, txnsH1: 5, txns24h: 60 },
  ];
  const trades = (pool: string, n: number, spanMin: number) =>
    Array.from({ length: n }, (_, i) => ({ pool, blockTime: NOW - Math.round((i / n) * spanMin * MIN), quoteMint: 'SOL-MINT' }));

  test('observing only a minor pool is a small, stated share of the market', () => {
    const c = marketCoverage(trades('B', 20, 60), pools, 'SOL-MINT', NOW);
    assert.equal(c.knownPools, 3);
    assert.equal(c.observedPools, 1);
    assert.equal(c.venueShare, 0.15);
    assert.ok((c.sampleShare ?? 1) < 0.3, String(c.sampleShare));
    assert.ok(c.representativeness < 0.6);
    assert.match(c.note, /1 of 3 pool/);
  });

  test('observing the main pools densely is representative', () => {
    const c = marketCoverage([...trades('A', 70, 60), ...trades('B', 20, 60)], pools, 'SOL-MINT', NOW);
    assert.equal(c.observedPools, 2);
    assert.ok((c.representativeness ?? 0) >= 0.9, String(c.representativeness));
  });

  test('trades in another quote currency are counted but never summed into volume', () => {
    const mixed = [...trades('A', 40, 60), ...Array.from({ length: 10 }, (_, i) => ({ pool: 'C', blockTime: NOW - i * MIN, quoteMint: 'USDC-MINT' }))];
    const c = marketCoverage(mixed, pools, 'SOL-MINT', NOW);
    assert.equal(c.excludedFromVolume, 10);
    assert.equal(c.observedTrades, 50);
  });

  test('deep collection takes secondary pools only when they carry real volume, deduplicated', () => {
    const t = token();
    t.pools = [
      { address: 'PoolAddr1111111111111111111111111111111111', dexId: 'raydium', quoteSymbol: 'SOL', liquidityUsd: 1, volume24h: 60_000, txnsH1: 1, txns24h: 1 },
      { address: 'Second', dexId: 'meteora', quoteSymbol: 'SOL', liquidityUsd: 1, volume24h: 35_000, txnsH1: 1, txns24h: 1 },
      { address: 'Dust', dexId: 'orca', quoteSymbol: 'SOL', liquidityUsd: 1, volume24h: 1_000, txnsH1: 1, txns24h: 1 },
    ];
    assert.deepEqual(poolsFor(t, null, 3, 0.2).map((p) => p.address), ['PoolAddr1111111111111111111111111111111111', 'Second']);
    const plan = planDeepCollection({ tokens: [t], lastCollectedAt: () => null, launchPool: () => null, tokensPerCycle: 1, liveWindowMs: 90 * MIN, now: NOW, poolsPerToken: 2, minPoolVolumeShare: 0.2 });
    assert.deepEqual(plan.work.map((w) => [w.pool, w.rank]), [['PoolAddr1111111111111111111111111111111111', 0], ['Second', 1]]);
    // A high-risk survivor is still collected, after the candidates.
    const risky = token();
    risky.mint = 'Risky';
    risky.evaluation!.eligibility = 'HIGH_RISK';
    const both = planDeepCollection({ tokens: [risky, t], lastCollectedAt: () => null, launchPool: () => null, tokensPerCycle: 2, liveWindowMs: 90 * MIN, now: NOW });
    assert.deepEqual(both.work.map((w) => w.mint), [MINT, 'Risky']);
    void CREATOR;
  });
});
