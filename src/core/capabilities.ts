/**
 * What this running instance can and cannot check.
 *
 * Token Finder runs without any API key by default, and in that mode several
 * checks simply do not happen: nothing reads the mint account, so Token-2022
 * extensions and the owning program are never inspected, and mint/freeze
 * authority come from third-party reports rather than the chain. The engine
 * already records that honestly - those signals resolve to UNAVAILABLE. This
 * module turns the same facts into something a person can read, so no surface
 * can present keyless mode as equivalent to full evidence.
 *
 * It reports configuration and observed provider health. It never probes a
 * provider itself.
 */

export type CapabilityState =
  /** Configured and, as far as recent scans show, working. */
  | 'ON'
  /** Configured, but a recent scan saw this provider fail. */
  | 'DEGRADED'
  /** Needs configuration that is absent. */
  | 'OFF'
  /** Deliberately switched off. */
  | 'DISABLED';

export interface Capability {
  id: string;
  label: string;
  /** What the capability does, in one sentence. */
  summary: string;
  state: CapabilityState;
  provider: string;
  /** What the user loses when it is not ON. Empty when ON. */
  impact: string;
  /** Environment variable that enables it, when that is the fix. */
  enableWith: string | null;
  /** Ledger metrics this capability is the only source for. */
  metrics: string[];
}

export interface CapabilityInput {
  helius: boolean;
  birdeye: boolean;
  typesafeEnabled: boolean;
  /** Providers that failed during the most recent scans. */
  failingProviders: ReadonlySet<string>;
}

function health(configured: boolean, provider: string, failing: ReadonlySet<string>): CapabilityState {
  if (!configured) return 'OFF';
  return failing.has(provider) ? 'DEGRADED' : 'ON';
}

export function capabilities(input: CapabilityInput): Capability[] {
  const failing = input.failingProviders;
  const marketFailing = failing.has('dexscreener') || failing.has('jupiter');

  return [
    {
      id: 'market',
      label: 'Market data',
      summary: 'Price, liquidity, volume and trading activity from DexScreener and Jupiter.',
      state: marketFailing ? 'DEGRADED' : 'ON',
      provider: 'dexscreener + jupiter',
      impact: marketFailing
        ? 'A market provider failed in a recent scan; affected tokens show those signals as unavailable.'
        : '',
      enableWith: null,
      metrics: ['liquidityUsd', 'volume24h', 'priceChange', 'buyPressure', 'tradable'],
    },
    {
      id: 'safety-reports',
      label: 'Third-party safety reports',
      summary: 'RugCheck risk findings and score, classified by whether they describe the present or the past.',
      state: health(true, 'rugcheck', failing),
      provider: 'rugcheck',
      impact: failing.has('rugcheck')
        ? 'RugCheck failed in a recent scan; affected tokens have no risk report.'
        : '',
      enableWith: null,
      metrics: ['rugcheckRisk'],
    },
    {
      id: 'onchain-authority',
      label: 'On-chain authority check',
      summary: 'Reads mint and freeze authority directly from the mint account.',
      state: health(input.helius, 'helius', failing),
      provider: 'helius',
      impact: input.helius
        ? ''
        : 'Mint and freeze authority come from Jupiter and RugCheck reports only; nothing confirms them against the chain.',
      enableWith: 'HELIUS_API_KEY',
      metrics: [],
    },
    {
      id: 'token-2022',
      label: 'Token-2022 extension analysis',
      summary:
        'Identifies the token program and inspects extensions such as permanent delegate, transfer hooks, pausing and transfer fees.',
      state: health(input.helius, 'helius', failing),
      provider: 'helius',
      impact: input.helius
        ? ''
        : 'Extensions are not inspected. A Token-2022 token with a permanent delegate or transfer hook cannot be detected, and is not vetoed for it.',
      enableWith: 'HELIUS_API_KEY',
      metrics: ['mintExtensions', 'tokenProgram'],
    },
    {
      id: 'holder-math',
      label: 'Exact holder concentration',
      summary: 'Computes top-holder share from raw on-chain balances with exact integer arithmetic.',
      state: health(input.helius, 'helius', failing),
      provider: 'helius',
      impact: input.helius
        ? ''
        : "Concentration comes from Jupiter's reported figure only, when Jupiter reports one.",
      enableWith: 'HELIUS_API_KEY',
      metrics: [],
    },
    {
      id: 'discovery-birdeye',
      label: 'Birdeye listing discovery',
      summary: 'Adds Birdeye new listings to the discovery feeds.',
      state: health(input.birdeye, 'birdeye', failing),
      provider: 'birdeye',
      impact: input.birdeye ? '' : 'Discovery uses Jupiter and DexScreener feeds only.',
      enableWith: 'BIRDEYE_API_KEY',
      metrics: [],
    },
    {
      id: 'impersonation',
      label: 'Impersonation screening',
      summary: 'Advisory check of whether a token name imitates an established token. Never affects the verdict.',
      state: input.typesafeEnabled ? health(true, 'typesafe', failing) : 'DISABLED',
      provider: 'typesafe',
      impact: input.typesafeEnabled ? '' : 'Switched off by design; it is advisory and does not affect verdicts.',
      enableWith: null,
      metrics: [],
    },
  ];
}

/**
 * Metrics no token can have in this configuration.
 *
 * A gap every token shares is a property of the instance, not of the token, so
 * it is stated once - on the Board banner and the System surface - instead of
 * being repeated as the "reason" on every row.
 */
export function globallyUnavailableMetrics(list: readonly Capability[]): Set<string> {
  const out = new Set<string>();
  for (const capability of list) {
    if (capability.state === 'OFF') for (const metric of capability.metrics) out.add(metric);
  }
  return out;
}
