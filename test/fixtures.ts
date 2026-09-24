/**
 * Deterministic regression corpus.
 *
 * These are raw provider payloads, shaped as the real APIs return them, so the
 * whole pipeline - validation, resolution, gate, coverage, scoring, eligibility
 * - can be exercised without a network. Live APIs cannot be a regression test:
 * they change under you, and the interesting cases (malformed responses,
 * provider disagreement) are exactly the ones you cannot summon on demand.
 *
 * Each scenario names the property it exists to pin down.
 */

import {
  LEGACY_SPL_TOKEN_PROGRAM_ID,
  ruleFor,
  TOKEN_2022_PROGRAM_ID,
} from '../src/core/token-program.ts';
import type { MintExtension, OnChainInfo } from '../src/types.ts';

/** Raw shapes, deliberately typed loosely: fixtures must be able to be wrong. */
export interface RawFixture {
  name: string;
  /** What this fixture is here to prove. */
  asserts: string;
  dexPairs: Record<string, unknown>[];
  jupiter: Record<string, unknown> | null;
  rugcheck: Record<string, unknown> | null;
  onchain: Record<string, unknown> | null;
}

const HOUR = 3_600_000;

/** A healthy, deep, well-covered pair. The control case. */
function healthyPair(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chainId: 'solana',
    dexId: 'raydium',
    url: 'https://dexscreener.com/solana/healthy',
    pairAddress: 'HealthyPair1111111111111111111111111111111',
    baseToken: { address: 'Mint1111111111111111111111111111111111111', name: 'Healthy Token', symbol: 'HEALTHY' },
    quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
    priceUsd: '0.0042',
    liquidity: { usd: 250_000 },
    fdv: 4_200_000,
    marketCap: 4_200_000,
    pairCreatedAt: Date.now() - 12 * HOUR,
    volume: { m5: 5_000, h1: 30_000, h6: 180_000, h24: 750_000 },
    priceChange: { m5: 0.4, h1: 6.2, h6: 4.1, h24: 18.0 },
    txns: {
      m5: { buys: 20, sells: 14 },
      h1: { buys: 180, sells: 120 },
      h6: { buys: 900, sells: 700 },
      h24: { buys: 3_400, sells: 2_600 },
    },
    info: {
      imageUrl: 'https://example.invalid/icon.png',
      websites: [{ url: 'https://example.invalid' }],
      socials: [{ type: 'twitter', url: 'https://x.invalid/healthy' }],
    },
    boosts: { active: 0 },
    ...overrides,
  };
}

function healthyJupiter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'Mint1111111111111111111111111111111111111',
    name: 'Healthy Token',
    symbol: 'HEALTHY',
    isVerified: false,
    tags: [],
    organicScore: 78,
    organicScoreLabel: 'high',
    holderCount: 4_200,
    liquidity: 250_000,
    usdPrice: 0.0042,
    mcap: 4_200_000,
    firstPool: { createdAt: new Date(Date.now() - 12 * HOUR).toISOString() },
    audit: {
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: true,
      topHoldersPercentage: 18,
      devBalancePercentage: 1.2,
    },
    stats24h: { numBuys: 3_400, numSells: 2_600, numTraders: 1_900, holderChange: 120 },
    ...overrides,
  };
}

function cleanRugcheck(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { score: 120, score_normalised: 8, risks: [], ...overrides };
}

/**
 * An ordinary legacy SPL mint, both authorities revoked, as the raw fixture
 * shape. Extension coverage is structural here: the legacy program has no
 * extension mechanism, so "none" is a fact about the program, not a short read.
 */
function rawLegacyOnchain(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    programId: LEGACY_SPL_TOKEN_PROGRAM_ID,
    tokenProgram: 'LEGACY_SPL_TOKEN',
    extensions: [],
    extensionsComplete: true,
    mintAuthority: null,
    freezeAuthority: null,
    mintAuthorityStated: true,
    freezeAuthorityStated: true,
    decimals: 9,
    supply: 1_000_000,
    rawSupply: '1000000000000000',
    rawTop10: null,
    largestAccountsCount: null,
    top10Share: null,
    largestHolderShare: null,
    issues: [],
    ...overrides,
  };
}

export const FIXTURES: RawFixture[] = [
  {
    name: 'healthy-established',
    asserts: 'a deep, fully-covered, veto-free token reaches QUALIFIED with coverage 1',
    dexPairs: [healthyPair()],
    jupiter: healthyJupiter(),
    rugcheck: cleanRugcheck(),
    // A fully-covered token now includes a chain read: the owner program is
    // what says which token model applies, and without it the extension
    // question is open. An ordinary legacy SPL mint answers it structurally.
    onchain: rawLegacyOnchain(),
  },

  {
    name: 'newly-launched',
    asserts: 'a very young token still scores, with age scored rather than unknown',
    dexPairs: [
      healthyPair({
        pairCreatedAt: Date.now() - 0.5 * HOUR,
        liquidity: { usd: 42_000 },
        volume: { m5: 9_000, h1: 40_000, h6: 40_000, h24: 40_000 },
        priceChange: { m5: 12, h1: 60, h6: 60, h24: 60 },
      }),
    ],
    jupiter: healthyJupiter({
      holderCount: 240,
      liquidity: 42_000,
      firstPool: { createdAt: new Date(Date.now() - 0.5 * HOUR).toISOString() },
    }),
    rugcheck: cleanRugcheck(),
    onchain: null,
  },

  {
    name: 'missing-market-pair',
    asserts: 'no DexScreener pair leaves momentum/pressure/activity UNKNOWN, earning zero',
    dexPairs: [],
    jupiter: healthyJupiter({ liquidity: 586_000, holderCount: 16_600 }),
    rugcheck: cleanRugcheck(),
    onchain: null,
  },

  {
    name: 'dangerous-mint-authority',
    asserts: 'a live mint authority vetoes with AUTHORITY_MINT_ACTIVE and forces REJECTED',
    dexPairs: [healthyPair()],
    jupiter: healthyJupiter({
      audit: {
        mintAuthorityDisabled: false,
        freezeAuthorityDisabled: true,
        topHoldersPercentage: 18,
        devBalancePercentage: 1,
      },
    }),
    rugcheck: cleanRugcheck(),
    onchain: null,
  },

  {
    name: 'provider-disagreement-authority',
    asserts:
      'RugCheck danger beats a Jupiter claim of safety: CONFLICTED, conservative reading, still vetoed',
    dexPairs: [healthyPair()],
    jupiter: healthyJupiter(),
    rugcheck: cleanRugcheck({
      score: 900,
      score_normalised: 55,
      risks: [
        {
          name: 'Mint Authority still enabled',
          level: 'danger',
          description: 'More tokens can be minted by the owner',
          score: 900,
        },
      ],
    }),
    onchain: null,
  },

  {
    name: 'provider-silence-not-safety',
    asserts: 'a null Jupiter audit field with no other source stays UNKNOWN and never vetoes',
    dexPairs: [healthyPair()],
    jupiter: healthyJupiter({
      audit: {
        mintAuthorityDisabled: null,
        freezeAuthorityDisabled: null,
        topHoldersPercentage: 18,
        devBalancePercentage: 1,
      },
    }),
    rugcheck: cleanRugcheck(),
    onchain: null,
  },

  {
    name: 'extreme-concentration',
    asserts: 'a Jupiter-measured 94% top-holder share vetoes CATASTROPHIC_CONCENTRATION',
    dexPairs: [healthyPair()],
    jupiter: healthyJupiter({
      audit: {
        mintAuthorityDisabled: true,
        freezeAuthorityDisabled: true,
        topHoldersPercentage: 94,
        devBalancePercentage: 60,
      },
    }),
    rugcheck: cleanRugcheck(),
    onchain: null,
  },

  {
    name: 'pool-vault-concentration-not-vetoed',
    asserts:
      'a 97% Helius top10Share does NOT veto, because pool vaults inflate it - no false veto',
    dexPairs: [healthyPair()],
    jupiter: healthyJupiter({
      audit: {
        mintAuthorityDisabled: true,
        freezeAuthorityDisabled: true,
        topHoldersPercentage: null,
        devBalancePercentage: null,
      },
    }),
    rugcheck: cleanRugcheck(),
    onchain: rawLegacyOnchain({
      top10Share: 0.97,
      largestHolderShare: 0.8,
      rawTop10: '970000000000000',
      largestAccountsCount: 10,
    }),
  },

  {
    name: 'zero-liquidity',
    asserts: 'a measured zero liquidity vetoes UNTRADEABLE, distinct from unknown liquidity',
    dexPairs: [healthyPair({ liquidity: { usd: 0 }, volume: { m5: 0, h1: 0, h6: 0, h24: 0 } })],
    jupiter: healthyJupiter({ liquidity: 0 }),
    rugcheck: cleanRugcheck(),
    onchain: null,
  },

  {
    name: 'malformed-provider-response',
    asserts:
      'impossible values are rejected at the boundary, become INVALID (not zero), and veto MALFORMED_TOKEN',
    dexPairs: [
      healthyPair({
        liquidity: { usd: -5_000 },
        priceUsd: 'not-a-number',
        pairCreatedAt: 32_503_680_000_000,
        volume: { m5: 0, h1: Number.NaN, h6: -10, h24: 'lots' },
        txns: {
          m5: { buys: 1, sells: 1 },
          h1: { buys: -4, sells: 2.5 },
          h6: { buys: 10, sells: 10 },
          h24: { buys: 10, sells: 10 },
        },
      }),
    ],
    jupiter: healthyJupiter({
      // A string where a safety boolean belongs: never coerced.
      audit: {
        mintAuthorityDisabled: 'true',
        freezeAuthorityDisabled: 1,
        topHoldersPercentage: 150,
        devBalancePercentage: -3,
      },
      holderCount: 12.5,
      organicScore: 900,
    }),
    rugcheck: cleanRugcheck({ score_normalised: 'high', risks: 'nope' }),
    onchain: null,
  },

  {
    name: 'low-coverage',
    asserts: 'a token with almost nothing measured lands in INSUFFICIENT_DATA, not the ranking',
    dexPairs: [],
    jupiter: {
      id: 'Mint1111111111111111111111111111111111111',
      name: 'Sparse',
      symbol: 'SPARSE',
      isVerified: false,
      liquidity: 12_000,
    },
    rugcheck: null,
    onchain: null,
  },

  {
    name: 'critical-rugcheck-creator-history',
    asserts: 'a creator with a rug history vetoes CRITICAL_RUGCHECK and is not re-checkable',
    dexPairs: [healthyPair()],
    jupiter: healthyJupiter(),
    rugcheck: cleanRugcheck({
      score: 2_000,
      score_normalised: 80,
      risks: [
        {
          name: 'Creator history of rugged tokens',
          level: 'danger',
          description: 'This creator has rugged before',
          score: 2_000,
        },
      ],
    }),
    onchain: null,
  },

  {
    name: 'suspicious-launch-wash-volume',
    asserts: 'implausible turnover on thin liquidity raises wash_suspect without vetoing',
    dexPairs: [
      healthyPair({
        liquidity: { usd: 20_000 },
        volume: { m5: 100_000, h1: 400_000, h6: 900_000, h24: 1_600_000 },
        priceChange: { m5: 1, h1: 2, h6: 3, h24: 4 },
      }),
    ],
    jupiter: healthyJupiter({ liquidity: 20_000, holderCount: 90 }),
    rugcheck: cleanRugcheck(),
    onchain: null,
  },

  {
    name: 'cross-provider-turnover-mismatch',
    asserts:
      'volume from DexScreener with liquidity from Jupiter leaves activity UNKNOWN rather than computing a fictional ratio',
    // Pair liquidity is rejected, so the resolved liquidity comes from Jupiter
    // while volume still comes from DexScreener.
    dexPairs: [healthyPair({ liquidity: { usd: -1 } })],
    jupiter: healthyJupiter({ liquidity: 250_000 }),
    rugcheck: cleanRugcheck(),
    onchain: null,
  },
];

export function fixtureByName(name: string): RawFixture {
  const found = FIXTURES.find((fixture) => fixture.name === name);
  if (!found) throw new Error(`no fixture named ${name}`);
  return found;
}

/**
 * A legacy SPL mint with both authorities revoked and no extensions.
 *
 * The control case for every Token-2022 test: an ordinary mint whose extension
 * evidence is MEASURED-and-empty because the legacy program has no extension
 * mechanism at all, not because a read came back short.
 */
export function legacyOnchain(overrides: Partial<OnChainInfo> = {}): OnChainInfo {
  return {
    programId: LEGACY_SPL_TOKEN_PROGRAM_ID,
    tokenProgram: 'LEGACY_SPL_TOKEN',
    extensions: [],
    extensionsComplete: true,
    mintAuthority: null,
    freezeAuthority: null,
    mintAuthorityStated: true,
    freezeAuthorityStated: true,
    decimals: 9,
    supply: 1_000_000,
    rawSupply: '1000000000000000',
    rawTop10: null,
    largestAccountsCount: null,
    top10Share: null,
    largestHolderShare: null,
    issues: [],
    ...overrides,
  };
}

/** A Token-2022 mint carrying the given extensions, fully decoded. */
export function token2022Onchain(
  extensions: MintExtension[],
  overrides: Partial<OnChainInfo> = {},
): OnChainInfo {
  return legacyOnchain({
    programId: TOKEN_2022_PROGRAM_ID,
    tokenProgram: 'TOKEN_2022',
    extensions,
    extensionsComplete: true,
    ...overrides,
  });
}

/** Builds one extension record from its registry rule, as helius.ts would. */
export function extensionFixture(
  id: string,
  active: boolean | null,
  overrides: Partial<MintExtension> = {},
): MintExtension {
  const rule = ruleFor(id);
  if (rule === null) throw new Error(`no extension rule for ${id}`);
  return {
    id,
    label: rule.label,
    policy: rule.policy,
    active,
    rationale: rule.rationale,
    recheckable: rule.recheckable,
    detail: null,
    magnitude: null,
    ...overrides,
  };
}
