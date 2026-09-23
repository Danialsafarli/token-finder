/**
 * Scoring integrity: the data-integrity guarantees from the previous phase,
 * re-expressed against the evidence-driven scorer.
 *
 * The invariants are unchanged - unknown earns nothing, a measured zero is not
 * unknown, a RugCheck danger reaches authority state - but they now hold at the
 * evidence layer rather than inside the scorer.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scoreToken, SIGNAL_FAMILIES, type FlagInput } from '../src/core/score.ts';
import { resolveEvidence } from '../src/core/resolve.ts';
import { runPipeline } from './pipeline.ts';
import { fixtureByName } from './fixtures.ts';
import type { ImpersonationAssessment, JupiterInfo, PairMetrics, RugcheckInfo } from '../src/types.ts';

const NOW = Date.now();

function pair(overrides: Partial<PairMetrics> = {}): PairMetrics {
  return {
    pairAddress: 'P1',
    dexId: 'raydium',
    baseSymbol: 'TEST',
    baseName: 'Test Token',
    url: '',
    quoteSymbol: 'SOL',
    priceUsd: 1,
    liquidityUsd: 100_000,
    fdv: null,
    marketCap: null,
    pairCreatedAt: NOW - 12 * 3_600_000,
    volume: { m5: 1_000, h1: 10_000, h6: 60_000, h24: 300_000 },
    priceChange: { m5: 0, h1: 5, h6: 3, h24: 10 },
    txns: {
      m5: { buys: 5, sells: 5 },
      h1: { buys: 60, sells: 40 },
      h6: { buys: 300, sells: 200 },
      h24: { buys: 500, sells: 400 },
    },
    websites: ['https://example.invalid'],
    socials: [],
    boosts: 0,
    issues: [],
    ...overrides,
  };
}

function jupiter(auditOverrides: Partial<JupiterInfo['audit']> = {}): JupiterInfo {
  return {
    symbol: 'TEST',
    name: 'Test Token',
    isVerified: false,
    tags: [],
    organicScore: 80,
    organicScoreLabel: 'high',
    holderCount: 2_000,
    liquidityUsd: 100_000,
    usdPrice: 1,
    mcap: 1_000_000,
    firstPoolCreatedAt: NOW - 12 * 3_600_000,
    audit: {
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: true,
      topHoldersPercentage: 15,
      devBalancePercentage: null,
      ...auditOverrides,
    },
    stats24h: { numBuys: null, numSells: null, numTraders: null, holderChange: null },
    issues: [],
  };
}

const cleanRug: RugcheckInfo = { score: 10, scoreNormalised: 5, risks: [], issues: [] };

interface BuildOptions {
  pairs?: PairMetrics[];
  jupiter?: JupiterInfo | null;
  rugcheck?: RugcheckInfo | null;
  impersonation?: ImpersonationAssessment | null;
}

function build(options: BuildOptions = {}): FlagInput {
  const pairs = options.pairs ?? [pair()];
  const jup = options.jupiter === undefined ? jupiter() : options.jupiter;
  const rug = options.rugcheck === undefined ? cleanRug : options.rugcheck;

  const evidence = resolveEvidence({
    pairs,
    jupiter: jup,
    rugcheck: rug,
    onchain: null,
    observedAt: { dexscreener: NOW, jupiter: NOW, rugcheck: NOW, onchain: NOW },
    heliusConfigured: false,
    now: NOW,
  });

  return {
    evidence,
    rugcheckRisks: rug?.risks ?? [],
    hasSocials: pairs.some((p) => p.socials.length > 0 || p.websites.length > 0),
    jupiterVerified: jup?.isVerified ?? false,
    minLiquidityUsd: 3_000,
    ...(options.impersonation === undefined ? {} : { impersonation: options.impersonation }),
  };
}

const componentOf = (input: FlagInput, key: string) =>
  scoreToken(input).components.find((c) => c.key === key);

describe('missing data must not earn points', () => {
  test('absent price history scores momentum as unknown, not neutral 0.5', () => {
    const momentum = componentOf(build({ pairs: [] }), 'momentum');
    assert.equal(momentum?.value, null);
    assert.ok(momentum?.unknownReason);
  });

  test('absent trade counts score pressure as unknown, not 0.4', () => {
    const pressure = componentOf(build({ pairs: [] }), 'pressure');
    assert.equal(pressure?.value, null);
  });

  test('absent holder count scores holders as unknown, not 0.2', () => {
    const jup = jupiter();
    jup.holderCount = null;
    const holders = componentOf(build({ jupiter: jup }), 'holders');
    assert.equal(holders?.value, null);
  });

  test('absent age scores age as unknown, not 0.3', () => {
    const jup = jupiter();
    jup.firstPoolCreatedAt = null;
    const age = componentOf(build({ pairs: [pair({ pairCreatedAt: null })], jupiter: jup }), 'age');
    assert.equal(age?.value, null);
  });

  test('a pairless token loses momentum, pressure and activity entirely', () => {
    const score = scoreToken(build({ pairs: [] }));
    assert.ok(score.unknown.includes('momentum'));
    assert.ok(score.unknown.includes('pressure'));
    assert.ok(score.unknown.includes('activity'));
    assert.ok(score.total < 70, `must not clear the alert threshold, got ${score.total}`);
  });

  test('unknown components keep their weight, so the score stays out of 100', () => {
    const full = scoreToken(build());
    const partial = scoreToken(build({ pairs: [] }));
    assert.ok(partial.ceiling < full.ceiling);
    assert.ok(partial.base <= partial.ceiling + 0.05);
  });
});

describe('unknown, zero and verified-low-risk are three different things', () => {
  test('unmeasured volume scores activity unknown and reduces coverage', () => {
    const activity = componentOf(build({ pairs: [] }), 'activity');
    assert.equal(activity?.value, null);
    assert.equal(activity?.coverage, 0);
  });

  test('a measured dead pool scores zero but stays fully covered', () => {
    const dead = build({
      pairs: [pair({ volume: { m5: 0, h1: 0, h6: 0, h24: 0 } })],
    });
    const activity = componentOf(dead, 'activity');
    assert.equal(activity?.value, 0, 'a real pool that traded nothing scores zero');
    assert.equal(activity?.coverage, 1, 'and it is still a measurement');
  });

  test('both earn zero points but only unknown lowers the ceiling', () => {
    const dead = scoreToken(build({ pairs: [pair({ volume: { m5: 0, h1: 0, h6: 0, h24: 0 } })] }));
    const unmeasured = scoreToken(build({ pairs: [] }));
    assert.ok(dead.ceiling > unmeasured.ceiling);
    assert.equal(dead.unknown.includes('activity'), false);
    assert.equal(unmeasured.unknown.includes('activity'), true);
  });

  test('verified-revoked authority earns full credit where unknown earns none', () => {
    const verified = componentOf(build(), 'safety');
    const unknownAuthority = componentOf(
      build({ jupiter: jupiter({ mintAuthorityDisabled: null, freezeAuthorityDisabled: null }) }),
      'safety',
    );

    assert.ok((verified?.value ?? 0) > (unknownAuthority?.value ?? 0));
    assert.equal(verified?.coverage, 1);
    assert.ok((unknownAuthority?.coverage ?? 1) < 1);
  });

  test('unknown authority earns no partial credit at all', () => {
    const known = componentOf(build(), 'safety');
    const unknown = componentOf(
      build({ jupiter: jupiter({ mintAuthorityDisabled: null, freezeAuthorityDisabled: null }) }),
      'safety',
    );
    assert.ok(
      Math.abs((known?.value ?? 0) - (unknown?.value ?? 0) - 0.5) < 0.001,
      'exactly the 0.5 authority sub-weight must be lost, never 0.35 partial credit',
    );
  });
});

describe('RugCheck danger reaches authority state', () => {
  const mintDanger: RugcheckInfo = {
    score: 900,
    scoreNormalised: 60,
    risks: [
      {
        name: 'Mint Authority still enabled',
        level: 'danger',
        description: 'More tokens can be minted by the owner',
        score: 900,
      },
    ],
    issues: [],
  };

  test('a danger overrides a null Jupiter audit field', () => {
    const input = build({
      jupiter: jupiter({ mintAuthorityDisabled: null }),
      rugcheck: mintDanger,
    });
    assert.equal(input.evidence.mintAuthorityRevoked.value, false);
    assert.ok(scoreToken(input).flags.some((f) => f.code === 'mint_authority'));
  });

  test('a danger overrides a contradicting claim of safety and flags the conflict', () => {
    const input = build({ jupiter: jupiter({ mintAuthorityDisabled: true }), rugcheck: mintDanger });
    assert.equal(input.evidence.mintAuthorityRevoked.state, 'CONFLICTED');
    assert.equal(input.evidence.mintAuthorityRevoked.value, false);
    assert.ok(
      scoreToken(input).flags.some((f) => f.code.startsWith('provider_conflict:')),
      'the disagreement must be visible',
    );
  });

  test('absence of a RugCheck risk is not evidence of revocation', () => {
    const input = build({
      jupiter: jupiter({ mintAuthorityDisabled: null }),
      rugcheck: { score: 0, scoreNormalised: 0, risks: [], issues: [] },
    });
    assert.equal(input.evidence.mintAuthorityRevoked.state, 'UNKNOWN');
  });
});

describe('advisory impersonation flag never moves the score', () => {
  const assessed = (probability: number): ImpersonationAssessment => ({
    status: 'assessed',
    probability,
    model: 'jev-1.13.0',
    at: NOW,
    questionId: 'impersonates_reference_token',
    evidence: {
      symbol: 'US DC',
      name: null,
      jupiterVerified: false,
      referenceListId: 'starter-2026-09-23',
      referenceMints: ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
    },
  });

  test('a high-probability assessment raises a flag but leaves total unchanged', () => {
    const without = scoreToken(build());
    const withFlag = scoreToken(build({ impersonation: assessed(0.95) }));
    assert.equal(withFlag.total, without.total);
    assert.ok(withFlag.flags.some((f) => f.code === 'impersonation_suspected'));
  });

  test('a low-probability assessment raises no flag', () => {
    const score = scoreToken(build({ impersonation: assessed(0.1) }));
    assert.equal(score.flags.some((f) => f.code === 'impersonation_suspected'), false);
  });

  test('a not_assessed result raises no flag and does not imply safety', () => {
    const score = scoreToken(
      build({
        impersonation: {
          status: 'not_assessed',
          probability: null,
          model: null,
          at: NOW,
          reason: 'api_error',
          questionId: 'impersonates_reference_token',
          evidence: {
            symbol: null,
            name: null,
            jupiterVerified: false,
            referenceListId: 'starter-2026-09-23',
            referenceMints: [],
          },
        },
      }),
    );
    assert.equal(score.flags.some((f) => f.code === 'impersonation_suspected'), false);
  });

  test('screening has no effect on vetoes or eligibility', () => {
    const base = runPipeline(fixtureByName('healthy-established'));
    assert.equal(base.eligibility, 'QUALIFIED');
    assert.deepEqual(base.vetoes, []);
  });
});

describe('signal correlation registry', () => {
  test('every declared family names its underlying fact and relationship', () => {
    assert.ok(SIGNAL_FAMILIES.length > 0);
    for (const family of SIGNAL_FAMILIES) {
      assert.ok(family.signals.length >= 2, `${family.family} must relate at least two signals`);
      assert.ok(family.underlying.length > 0);
      assert.ok(family.note.length > 20);
      assert.ok(
        ['independent', 'correlated', 'derived', 'provider-specific'].includes(family.relationship),
      );
    }
  });

  test('the depth family records that liquidity drives two components', () => {
    const depth = SIGNAL_FAMILIES.find((f) => f.family === 'depth');
    assert.ok(depth);
    assert.ok(depth.signals.includes('liquidity'));
    assert.ok(depth.signals.includes('activity'));
  });
});
