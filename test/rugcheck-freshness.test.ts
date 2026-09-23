/**
 * Freshness semantics for RugCheck penalties.
 *
 * The inconsistency this pins down: a stale RugCheck finding stopped triggering
 * a hard veto but kept applying its x0.85 score multiplier, so stale evidence
 * could still lower a token's *current* score after fresher evidence showed the
 * condition no longer held.
 *
 * The rule now: a current-state finding may only charge when it is current and
 * not contradicted by canonical evidence. Suppression withholds the penalty,
 * never the finding.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEvidence } from '../src/core/resolve.ts';
import { scoreToken } from '../src/core/score.ts';
import { evaluateGate } from '../src/core/gate.ts';
import {
  classifyRisk,
  decaysWhenStale,
  canAffectScore,
  RUGCHECK_SIGNAL_RULES,
} from '../src/core/rugcheck-signals.ts';
import {
  isEvidenceScorable,
  scorabilityOf,
  isCurrentEnough,
  unknown,
  type Evidence,
} from '../src/core/evidence.ts';
import { normalizePair } from '../src/sources/dexscreener.ts';
import { normalizeToken } from '../src/sources/jupiter.ts';
import { fixtureByName } from './fixtures.ts';
import type { JupiterInfo, OnChainInfo, RugcheckInfo, TokenEvidence } from '../src/types.ts';

const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** rugcheckRisk windows: FRESH <= 6h, AGING <= 24h, STALE beyond. */
const FRESH_AT = NOW - 1 * HOUR;
const AGING_AT = NOW - 12 * HOUR;
const STALE_AT = NOW - 10 * DAY;

const healthy = fixtureByName('healthy-established');

function risk(name: string, level = 'danger'): RugcheckInfo['risks'][number] {
  return { name, level, description: `${name} description`, score: 500 };
}

interface BuildOptions {
  risks?: RugcheckInfo['risks'];
  rugcheckAt?: number;
  /** null = Jupiter reports the mint authority revoked (the default). */
  auditMintDisabled?: boolean | null;
  onchainRevoked?: boolean;
  onchainAt?: number;
}

function buildEvidence(options: BuildOptions = {}): TokenEvidence {
  const jupiter: JupiterInfo = normalizeToken({
    ...(healthy.jupiter as object),
    audit: {
      mintAuthorityDisabled: options.auditMintDisabled === undefined ? true : options.auditMintDisabled,
      freezeAuthorityDisabled: true,
      topHoldersPercentage: 18,
      devBalancePercentage: 1,
    },
  } as never);

  const onchain: OnChainInfo | null = options.onchainRevoked
    ? {
        mintAuthority: null,
        freezeAuthority: null,
        mintAuthorityStated: true,
        freezeAuthorityStated: true,
        decimals: 9,
        supply: 1_000_000,
        top10Share: null,
        largestHolderShare: null,
        issues: [],
      }
    : null;

  const rugcheck: RugcheckInfo = {
    score: 500,
    scoreNormalised: 30,
    risks: options.risks ?? [],
    issues: [],
  };

  return resolveEvidence({
    pairs: [normalizePair(healthy.dexPairs[0] as never)],
    jupiter,
    rugcheck,
    onchain,
    observedAt: {
      dexscreener: NOW,
      jupiter: NOW,
      rugcheck: options.rugcheckAt ?? FRESH_AT,
      onchain: options.onchainAt ?? FRESH_AT,
    },
    heliusConfigured: options.onchainRevoked === true,
    now: NOW,
  });
}

function scoreOf(evidence: TokenEvidence) {
  return scoreToken({
    evidence,
    hasSocials: true,
    jupiterVerified: false,
    minLiquidityUsd: 3_000,
  });
}

const findingFor = (evidence: TokenEvidence, needle: string) =>
  evidence.rugcheckFindings.find((f) => f.name.toLowerCase().includes(needle));

describe('signal classification', () => {
  test('authority conditions are CURRENT_STATE, because they can be revoked', () => {
    assert.equal(classifyRisk('Mint Authority still enabled').nature, 'CURRENT_STATE');
    assert.equal(classifyRisk('Freeze Authority still enabled').nature, 'CURRENT_STATE');
  });

  test('liquidity and LP conditions are CURRENT_STATE, because they change continuously', () => {
    assert.equal(classifyRisk('Large amount of LP unlocked').nature, 'CURRENT_STATE');
    assert.equal(classifyRisk('Low amount of LP Providers').nature, 'CURRENT_STATE');
    assert.equal(classifyRisk('Low Liquidity').nature, 'CURRENT_STATE');
    assert.equal(classifyRisk('Mutable metadata').nature, 'CURRENT_STATE');
  });

  test('a creator rug history is HISTORICAL, because it cannot un-happen', () => {
    assert.equal(classifyRisk('Creator history of rugged tokens').nature, 'HISTORICAL');
  });

  test('concentration findings are CURRENT_STATE, because balances move', () => {
    assert.equal(classifyRisk('High holder concentration').nature, 'CURRENT_STATE');
    assert.equal(classifyRisk('Single holder ownership').nature, 'CURRENT_STATE');
  });

  test('an irrevocable mint-time extension is PERMANENT and survives staleness', () => {
    const classification = classifyRisk('Permanent control enabled');
    assert.equal(classification.nature, 'PERMANENT');
    assert.equal(decaysWhenStale('PERMANENT'), false);
  });

  test('an unrecognised finding is UNKNOWN_NATURE rather than guessed', () => {
    const classification = classifyRisk('Some Entirely Novel Condition');
    assert.equal(classification.nature, 'UNKNOWN_NATURE');
    assert.equal(classification.rationale, '');
  });

  test('only CURRENT_STATE decays with age', () => {
    assert.equal(decaysWhenStale('CURRENT_STATE'), true);
    assert.equal(decaysWhenStale('HISTORICAL'), false);
    assert.equal(decaysWhenStale('PERMANENT'), false);
    assert.equal(decaysWhenStale('UNKNOWN_NATURE'), false);
  });

  test('UNKNOWN_NATURE can never affect a score', () => {
    assert.equal(canAffectScore('UNKNOWN_NATURE'), false);
    assert.equal(canAffectScore('CURRENT_STATE'), true);
    assert.equal(canAffectScore('HISTORICAL'), true);
  });

  test('every classification rule carries a written rationale', () => {
    for (const rule of RUGCHECK_SIGNAL_RULES) {
      assert.ok(rule.rationale.length > 20, `${rule.match} needs a defensible rationale`);
      assert.notEqual(rule.nature, 'UNKNOWN_NATURE', 'a rule must commit to a nature');
    }
  });
});

describe('the centralized scorable-evidence rule', () => {
  test('FRESH and AGING are current; STALE and UNKNOWN are not', () => {
    assert.equal(isCurrentEnough('FRESH'), true);
    assert.equal(isCurrentEnough('AGING'), true);
    assert.equal(isCurrentEnough('STALE'), false);
    assert.equal(isCurrentEnough('UNKNOWN'), false);
  });

  test('each non-scorable state reports a distinct, explainable reason', () => {
    const make = (state: Evidence<number>['state']): Evidence<number> => ({
      ...unknown<number>(),
      state,
      value: state === 'STALE' ? null : 1,
      freshness: 'FRESH',
    });

    assert.equal(scorabilityOf(make('UNKNOWN')).reason, 'unknown');
    assert.equal(scorabilityOf(make('INVALID')).reason, 'invalid');
    assert.equal(scorabilityOf(make('STALE')).reason, 'stale');
    assert.equal(scorabilityOf(make('UNAVAILABLE')).reason, 'unavailable');

    for (const state of ['UNKNOWN', 'INVALID', 'STALE', 'UNAVAILABLE'] as const) {
      const s = scorabilityOf(make(state));
      assert.equal(s.scorable, false);
      assert.ok(s.explanation.length > 10, 'a suppression must be explainable');
    }
  });

  test('a measured, current value is scorable', () => {
    const evidence: Evidence<number> = {
      ...unknown<number>(),
      state: 'MEASURED',
      value: 42,
      freshness: 'FRESH',
    };
    assert.equal(isEvidenceScorable(evidence), true);
  });

  test('a measured but stale-fresh value is not scorable', () => {
    const evidence: Evidence<number> = {
      ...unknown<number>(),
      state: 'MEASURED',
      value: 42,
      freshness: 'STALE',
    };
    assert.equal(isEvidenceScorable(evidence), false, 'the gate and the penalty must agree');
  });
});

describe('A-F: penalty behaviour by freshness and nature', () => {
  const clean = () => scoreOf(buildEvidence());

  test('A. FRESH dangerous current-state finding applies its penalty', () => {
    const evidence = buildEvidence({
      risks: [risk('Large amount of LP unlocked')],
      rugcheckAt: FRESH_AT,
    });
    const finding = findingFor(evidence, 'lp unlocked');

    assert.equal(finding?.freshness, 'FRESH');
    assert.equal(finding?.scorable, true);
    assert.ok(scoreOf(evidence).total < clean().total, 'a current danger must still cost');
  });

  test('B. AGING dangerous current-state finding still applies (defined behaviour)', () => {
    const evidence = buildEvidence({
      risks: [risk('Large amount of LP unlocked')],
      rugcheckAt: AGING_AT,
    });
    const finding = findingFor(evidence, 'lp unlocked');

    assert.equal(finding?.freshness, 'AGING');
    assert.equal(finding?.scorable, true, 'AGING is current enough to charge');
    assert.ok(scoreOf(evidence).total < clean().total);
  });

  test('C. STALE current-state finding applies NO penalty', () => {
    const evidence = buildEvidence({
      risks: [risk('Large amount of LP unlocked')],
      rugcheckAt: STALE_AT,
    });
    const finding = findingFor(evidence, 'lp unlocked');
    const score = scoreOf(evidence);

    assert.equal(finding?.freshness, 'STALE');
    assert.equal(finding?.scorable, false);
    assert.match(finding?.suppressedReason ?? '', /no longer describes the present/);
    assert.equal(score.penalty, 0, 'a stale current-state condition must not charge');
  });

  test('D. STALE historical finding KEEPS its penalty', () => {
    const evidence = buildEvidence({
      risks: [risk('Creator history of rugged tokens')],
      rugcheckAt: STALE_AT,
    });
    const finding = findingFor(evidence, 'creator history');

    assert.equal(finding?.nature, 'HISTORICAL');
    assert.equal(finding?.freshness, 'STALE');
    assert.equal(finding?.scorable, true, 'the past does not expire');
    assert.ok(scoreOf(evidence).total < clean().total);
  });

  test('E. UNKNOWN evidence contributes nothing either way', () => {
    // No risks at all: nothing to charge, and nothing credited for the absence.
    const evidence = buildEvidence({ risks: [] });
    assert.deepEqual(evidence.rugcheckFindings, []);
    assert.equal(scoreOf(evidence).penalty, 0);
  });

  test('F. an unclassifiable finding is recorded but never scored', () => {
    const evidence = buildEvidence({ risks: [risk('Some Entirely Novel Condition')] });
    const finding = findingFor(evidence, 'novel');

    assert.equal(finding?.nature, 'UNKNOWN_NATURE');
    assert.equal(finding?.scorable, false);
    assert.match(finding?.suppressedReason ?? '', /could not be classified/);
    assert.equal(scoreOf(evidence).penalty, 0);
  });
});

describe('G-I: conflict-aware penalties', () => {
  test('G. fresh canonical safe + stale RugCheck dangerous -> no current penalty', () => {
    const evidence = buildEvidence({
      risks: [risk('Mint Authority still enabled')],
      rugcheckAt: STALE_AT,
      auditMintDisabled: null,
      onchainRevoked: true,
      onchainAt: FRESH_AT,
    });
    const score = scoreOf(evidence);

    assert.equal(evidence.mintAuthorityRevoked.value, true, 'current state is revoked');
    assert.equal(findingFor(evidence, 'mint authority')?.scorable, false);
    assert.equal(score.penalty, 0, 'stale evidence must not lower a current score');
    assert.equal(
      score.flags.some((f) => f.code === 'mint_authority'),
      false,
      'and no authority penalty flag',
    );
    assert.equal(
      evaluateGate(evidence).some((v) => v.code === 'AUTHORITY_MINT_ACTIVE'),
      false,
      'nor a veto - gate and penalty now agree',
    );
  });

  test('G. ...but the stale danger stays fully visible', () => {
    const evidence = buildEvidence({
      risks: [risk('Mint Authority still enabled')],
      rugcheckAt: STALE_AT,
      auditMintDisabled: null,
      onchainRevoked: true,
    });
    const finding = findingFor(evidence, 'mint authority');
    const score = scoreOf(evidence);

    assert.ok(finding, 'the finding is not deleted');
    assert.equal(finding?.freshness, 'STALE');
    assert.equal(evidence.historicalDangerEvidence, true);
    assert.ok(
      score.flags.some((f) => f.code === 'rugcheck:mint_authority_still_enabled'),
      'the flag is still raised',
    );
    const flag = score.flags.find((f) => f.code === 'rugcheck:mint_authority_still_enabled');
    assert.match(flag?.message ?? '', /not scored/, 'and says why it did not count');
  });

  test('H. fresh canonical dangerous + stale RugCheck safe -> danger governs', () => {
    // Jupiter currently reports the authority live; RugCheck has nothing.
    const evidence = buildEvidence({ auditMintDisabled: false, risks: [] });
    const score = scoreOf(evidence);

    assert.equal(evidence.mintAuthorityRevoked.value, false);
    assert.ok(score.flags.some((f) => f.code === 'mint_authority'));
    assert.ok(score.penalty > 0, 'a current danger still charges');
  });

  test('I. fresh RugCheck danger + fresh on-chain revoked -> canonical governs, conflict visible', () => {
    const evidence = buildEvidence({
      risks: [risk('Mint Authority still enabled')],
      rugcheckAt: FRESH_AT,
      auditMintDisabled: null,
      onchainRevoked: true,
      onchainAt: FRESH_AT,
    });
    const finding = findingFor(evidence, 'mint authority');
    const score = scoreOf(evidence);

    assert.equal(evidence.mintAuthorityRevoked.value, true, 'on-chain governs current state');
    assert.equal(evidence.mintAuthorityRevoked.state, 'CONFLICTED', 'the conflict is explicit');
    assert.equal(finding?.scorable, false, 'contradicted by canonical evidence');
    assert.match(finding?.suppressedReason ?? '', /contradicted by current/);
    assert.equal(score.penalty, 0, 'canonical current state governs current-state scoring');
    assert.ok(
      score.flags.some((f) => f.code.startsWith('provider_conflict:')),
      'and the disagreement is still reported',
    );
  });

  test('keyless mode is unchanged: fresh RugCheck danger with no chain read still charges', () => {
    const evidence = buildEvidence({
      risks: [risk('Mint Authority still enabled')],
      rugcheckAt: FRESH_AT,
      auditMintDisabled: null,
      onchainRevoked: false,
    });

    assert.equal(evidence.mintAuthorityRevoked.value, false);
    assert.equal(findingFor(evidence, 'mint authority')?.scorable, true);
    assert.ok(scoreOf(evidence).penalty > 0);
  });
});

describe('J-L: mixed findings, no accidental credit, determinism', () => {
  test('J. mixed natures and freshness are judged individually', () => {
    const evidence = buildEvidence({
      risks: [
        risk('Creator history of rugged tokens'),
        risk('Large amount of LP unlocked'),
        risk('Some Entirely Novel Condition'),
      ],
      rugcheckAt: STALE_AT,
    });

    const history = findingFor(evidence, 'creator history');
    const lp = findingFor(evidence, 'lp unlocked');
    const novel = findingFor(evidence, 'novel');

    assert.equal(history?.scorable, true, 'historical survives staleness');
    assert.equal(lp?.scorable, false, 'current-state does not');
    assert.equal(novel?.scorable, false, 'unclassified never scores');

    // Exactly one x0.85 charge applied.
    const score = scoreOf(evidence);
    assert.ok(Math.abs(score.penalty - 15) < 0.2, `expected one 15% charge, got ${score.penalty}%`);
  });

  test('K. suppressing a penalty never becomes a bonus', () => {
    // Both sides observed at the same moment, so the only difference is the
    // presence of the finding. (Holding the timestamp constant matters: a stale
    // observation also ages RugCheck's numeric risk score out of the safety
    // component, which is a separate, correct effect.)
    const noRisks = scoreOf(buildEvidence({ risks: [], rugcheckAt: STALE_AT }));
    const suppressed = scoreOf(
      buildEvidence({ risks: [risk('Large amount of LP unlocked')], rugcheckAt: STALE_AT }),
    );

    assert.equal(
      suppressed.total,
      noRisks.total,
      'a suppressed penalty leaves the score exactly where having no finding would',
    );
    assert.ok(suppressed.total <= noRisks.total, 'and never above it');
  });

  test('K. a suppressed finding neither charges nor credits the safety component', () => {
    const suppressed = buildEvidence({
      risks: [risk('Large amount of LP unlocked')],
      rugcheckAt: STALE_AT,
    });
    const clean = buildEvidence({ risks: [], rugcheckAt: STALE_AT });

    const safety = scoreOf(suppressed).components.find((c) => c.key === 'safety');
    const cleanSafety = scoreOf(clean).components.find((c) => c.key === 'safety');
    assert.equal(safety?.value, cleanSafety?.value);
  });

  test('a stale RugCheck risk score also stops crediting safety, separately from findings', () => {
    // The mirror of the fix: suppression must cut both ways. A stale numeric
    // risk score must not earn safety credit any more than a stale finding may
    // charge a penalty.
    const fresh = buildEvidence({ risks: [], rugcheckAt: FRESH_AT });
    const stale = buildEvidence({ risks: [], rugcheckAt: STALE_AT });

    assert.equal(fresh.rugcheckRisk.state, 'MEASURED');
    assert.equal(stale.rugcheckRisk.state, 'STALE');

    const freshSafety = scoreOf(fresh).components.find((c) => c.key === 'safety');
    const staleSafety = scoreOf(stale).components.find((c) => c.key === 'safety');

    assert.ok(
      (staleSafety?.value ?? 0) < (freshSafety?.value ?? 0),
      'a stale clean bill of health is not a clean bill of health',
    );
    assert.ok((staleSafety?.coverage ?? 1) < (freshSafety?.coverage ?? 0));
  });

  test('L. scoring stays deterministic across repeated runs', () => {
    const options: BuildOptions = {
      risks: [risk('Creator history of rugged tokens'), risk('Low Liquidity')],
      rugcheckAt: AGING_AT,
    };
    const a = scoreOf(buildEvidence(options));
    const b = scoreOf(buildEvidence(options));

    assert.equal(a.total, b.total);
    assert.equal(a.penalty, b.penalty);
    assert.deepEqual(
      a.flags.map((f) => f.code),
      b.flags.map((f) => f.code),
    );
  });

  test('a suppressed finding is downgraded in severity so it cannot raise a high alert', () => {
    const evidence = buildEvidence({
      risks: [risk('Large amount of LP unlocked')],
      rugcheckAt: STALE_AT,
    });
    const flag = scoreOf(evidence).flags.find((f) => f.code === 'rugcheck:large_amount_of_lp_unlocked');

    assert.ok(flag, 'still reported');
    assert.equal(flag?.level, 'low', 'but not as a live high-severity risk');
  });
});
