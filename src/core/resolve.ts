/**
 * Cross-provider resolution.
 *
 * Takes what each provider said about a token and produces one canonical
 * {@link TokenEvidence} set. This is where disagreement is settled, and the
 * settlement rules are deliberately asymmetric between safety facts and market
 * facts.
 *
 * ## Resolution rules
 *
 * **Market facts** (liquidity, volume, holders, price change) use the most
 * trusted provider that answered. Where two disagree on *depth*, the lower
 * figure wins: liquidity is a claim about whether an exit exists, and the
 * optimistic reading is the one that costs money if wrong.
 *
 * **Safety facts** (mint and freeze authority) use conservative resolution:
 *
 * 1. A provider asserting danger beats a provider that is silent. Silence is
 *    not evidence of safety - RugCheck only ever reports problems, so the
 *    absence of a finding says nothing at all.
 * 2. A provider asserting danger beats a provider asserting safety. The token
 *    is marked CONFLICTED and both claims are retained. This is the case
 *    SCORING.md 5.2 documented: RugCheck said "Mint Authority still enabled"
 *    while Jupiter's audit field was null, and the null won.
 * 3. Because the dangerous reading wins, CONFLICTED safety evidence still
 *    fires the safety gate. It earns no positive credit in scoring either -
 *    a disputed claim of safety is not a claim of safety.
 *
 * The deliberate consequence of rule 2: an on-chain read from Helius showing a
 * revoked authority does *not* override a RugCheck danger finding. On-chain is
 * ground truth and RugCheck's report may simply be stale, so this will
 * sometimes be wrong in the safe direction. It is recorded as a conflict rather
 * than silently resolved, because trusting one provider absolutely is how the
 * original defect happened.
 */

import {
  resolve,
  unavailable,
  unknown,
  type Claim,
  type Evidence,
  type TokenEvidence,
} from './evidence.ts';
import type {
  FieldIssue,
  JupiterInfo,
  OnChainInfo,
  PairMetrics,
  RugcheckInfo,
} from '../types.ts';

/** Risk names RugCheck uses to assert that an authority is still live. */
const MINT_AUTHORITY_RISK = 'mint authority';
const FREEZE_AUTHORITY_RISK = 'freeze authority';

export interface ResolveInput {
  pairs: PairMetrics[];
  jupiter: JupiterInfo | null;
  rugcheck: RugcheckInfo | null;
  onchain: OnChainInfo | null;
  /** When each provider's data was observed, unix ms. */
  observedAt: {
    dexscreener: number;
    jupiter: number;
    rugcheck: number;
    onchain: number;
  };
  /** Whether Helius is configured at all; drives UNAVAILABLE vs UNKNOWN. */
  heliusConfigured: boolean;
  now: number;
}

/** Did this provider assert a dangerous condition for the named authority? */
function rugcheckAssertsLive(rug: RugcheckInfo | null, needle: string): boolean {
  return (rug?.risks ?? []).some(
    (risk) =>
      (risk.level === 'danger' || risk.level === 'warn') &&
      risk.name.toLowerCase().includes(needle),
  );
}

/** Picks the claim asserting danger; `false` means the authority is still live. */
function conservativeAuthority(claims: Claim<boolean>[]): number {
  const dangerous = claims.findIndex((claim) => claim.value === false);
  return dangerous === -1 ? 0 : dangerous;
}

/** Picks the lowest value - the reading that assumes the least depth. */
function lowestValue(claims: Claim<number>[]): number {
  let index = 0;
  for (let i = 1; i < claims.length; i++) {
    if ((claims[i]?.value ?? Infinity) < (claims[index]?.value ?? Infinity)) index = i;
  }
  return index;
}

/** True when this provider rejected the named field at its boundary. */
function issueFor(issues: FieldIssue[] | undefined, field: string): string | undefined {
  return issues?.find((issue) => issue.field === field)?.reason;
}

function claim<T>(
  provider: string,
  value: T | null,
  observedAt: number,
  invalid?: string,
): Claim<T> {
  return invalid === undefined
    ? { provider, value, observedAt }
    : { provider, value: null, observedAt, invalid };
}

/** Sums a numeric field across pairs, returning null when nothing was usable. */
function sumPairs(pairs: PairMetrics[], pick: (pair: PairMetrics) => number | null): number | null {
  const usable = pairs.map(pick).filter((value): value is number => value !== null);
  return usable.length === 0 ? null : usable.reduce((sum, value) => sum + value, 0);
}

export function resolveEvidence(input: ResolveInput): TokenEvidence {
  const { pairs, jupiter, rugcheck, onchain, observedAt, now } = input;

  const issues: FieldIssue[] = [
    ...pairs.flatMap((pair) => pair.issues),
    ...(jupiter?.issues ?? []),
    ...(rugcheck?.issues ?? []),
    ...(onchain?.issues ?? []),
  ];

  const hasPairs = pairs.length > 0;
  const dexLiquidity = sumPairs(pairs, (pair) => pair.liquidityUsd);

  // --- liquidity -----------------------------------------------------------
  // Two independent claims about exit depth. Lowest wins on disagreement.
  const liquidityUsd = resolve<number>(
    [
      ...(hasPairs
        ? [
            claim(
              'dexscreener',
              dexLiquidity,
              observedAt.dexscreener,
              dexLiquidity === null && pairs.some((p) => issueFor(p.issues, 'liquidity.usd'))
                ? 'every pair liquidity figure failed validation'
                : undefined,
            ),
          ]
        : []),
      ...(jupiter
        ? [
            claim(
              'jupiter',
              jupiter.liquidityUsd,
              observedAt.jupiter,
              issueFor(jupiter.issues, 'liquidity'),
            ),
          ]
        : []),
    ],
    {
      metric: 'liquidityUsd',
      now,
      resolveConflict: lowestValue,
      // The conservative figure wins whether or not the two agree: an exit
      // faces the depth that is really there, and the optimistic reading is
      // the one that costs money if wrong.
      chooseWinner: lowestValue,
      // DexScreener sums the pairs it indexes; Jupiter aggregates a wider set
      // of venues. A 40% gap between them is different scope, not a
      // contradiction, and calling it one would mark almost every token
      // CONFLICTED and make the flag meaningless. Only an order-of-magnitude
      // gap means one of them is actually wrong.
      equal: (a, b) => {
        const low = Math.min(a, b);
        const high = Math.max(a, b);
        if (high === 0) return true;
        if (low === 0) return false;
        return high / low <= 3;
      },
    },
  );

  // Turnover's denominator. Volume comes from DexScreener's pairs, so the
  // depth it is divided by has to be DexScreener's too - dividing by Jupiter's
  // wider aggregate describes no venue that exists. Kept separate from the
  // resolved `liquidityUsd`, which is deliberately the conservative figure
  // across providers and therefore often a different number.
  const venueLiquidityUsd = resolve<number>(
    hasPairs
      ? [
          claim(
            'dexscreener',
            dexLiquidity,
            observedAt.dexscreener,
            // A rejected depth figure is an unusable answer, not silence, and
            // must read INVALID so the reason survives into the UI.
            dexLiquidity === null && pairs.some((p) => issueFor(p.issues, 'liquidity.usd'))
              ? 'every pair liquidity figure failed validation'
              : undefined,
          ),
        ]
      : [],
    { metric: 'liquidityUsd', now },
  );

  // --- volume --------------------------------------------------------------
  // Only DexScreener reports 24h volume. No pair means no observation at all,
  // which is UNKNOWN - distinct from a pair that genuinely traded nothing.
  const volume24h = resolve<number>(
    hasPairs ? [claim('dexscreener', sumPairs(pairs, (pair) => pair.volume.h24), observedAt.dexscreener)] : [],
    { metric: 'volume24h', now },
  );

  // --- price change --------------------------------------------------------
  const best = pairs.reduce<PairMetrics | null>(
    (winner, pair) =>
      winner === null || (pair.liquidityUsd ?? -1) > (winner.liquidityUsd ?? -1) ? pair : winner,
    null,
  );
  const change = best?.priceChange;
  const changeComplete =
    change !== undefined &&
    change.m5 !== null &&
    change.h1 !== null &&
    change.h6 !== null &&
    change.h24 !== null;

  type Frames = { m5: number; h1: number; h6: number; h24: number };
  const changeClaims: Claim<Frames>[] = [];
  if (changeComplete) {
    changeClaims.push(
      claim<Frames>(
        'dexscreener',
        {
          m5: change.m5 as number,
          h1: change.h1 as number,
          h6: change.h6 as number,
          h24: change.h24 as number,
        },
        observedAt.dexscreener,
      ),
    );
  } else if (best !== null) {
    // A pair exists but its frames were incomplete or rejected: that is an
    // unusable answer, not silence.
    changeClaims.push(
      claim<Frames>(
        'dexscreener',
        null,
        observedAt.dexscreener,
        'incomplete or rejected price-change frames',
      ),
    );
  }

  const priceChange = resolve<Frames>(changeClaims, { metric: 'priceChange', now });

  // --- buy pressure --------------------------------------------------------
  const buys1h = sumPairs(pairs, (pair) => pair.txns.h1.buys);
  const sells1h = sumPairs(pairs, (pair) => pair.txns.h1.sells);
  const buys24h = sumPairs(pairs, (pair) => pair.txns.h24.buys);
  const sells24h = sumPairs(pairs, (pair) => pair.txns.h24.sells);

  const ratio = (buys: number | null, sells: number | null): number | null => {
    if (buys === null || sells === null) return null;
    const total = buys + sells;
    // Below ten trades the ratio is noise, not a demand signal.
    return total < 10 ? null : buys / total;
  };
  const pressureValue = ratio(buys1h, sells1h) ?? ratio(buys24h, sells24h);

  const buyPressure = resolve<number>(
    hasPairs ? [claim('dexscreener', pressureValue, observedAt.dexscreener)] : [],
    { metric: 'buyPressure', now },
  );

  // --- holders -------------------------------------------------------------
  const holders = resolve<number>(
    jupiter
      ? [claim('jupiter', jupiter.holderCount, observedAt.jupiter, issueFor(jupiter.issues, 'holderCount'))]
      : [],
    { metric: 'holders', now },
  );

  // --- age -----------------------------------------------------------------
  // Earliest known pool across providers. Immutable once known, so never stale.
  const launchTimes: Claim<number>[] = [];
  const earliestPair = pairs
    .map((pair) => pair.pairCreatedAt)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b)[0];
  if (earliestPair !== undefined) {
    launchTimes.push(claim('dexscreener', (now - earliestPair) / 3_600_000, observedAt.dexscreener));
  }
  if (jupiter?.firstPoolCreatedAt != null) {
    launchTimes.push(
      claim('jupiter', (now - jupiter.firstPoolCreatedAt) / 3_600_000, observedAt.jupiter),
    );
  }
  const ageHours = resolve<number>(launchTimes, {
    metric: 'ageHours',
    now,
    // The oldest known pool is the honest launch time, so the larger age wins.
    resolveConflict: (claims) => {
      let index = 0;
      for (let i = 1; i < claims.length; i++) {
        if ((claims[i]?.value ?? -1) > (claims[index]?.value ?? -1)) index = i;
      }
      return index;
    },
    equal: (a, b) => Math.abs(a - b) < 0.5,
  });

  // --- authorities ---------------------------------------------------------
  // `true` = revoked (safe), `false` = still live (dangerous), null = unknown.
  const authorityClaims = (
    auditValue: boolean | null,
    auditField: string,
    chainStated: boolean,
    chainAuthority: string | null,
    rugRisk: string,
  ): Claim<boolean>[] => {
    const claims: Claim<boolean>[] = [];

    if (rugcheckAssertsLive(rugcheck, rugRisk)) {
      claims.push(claim('rugcheck', false, observedAt.rugcheck));
    }
    if (jupiter) {
      claims.push(claim('jupiter', auditValue, observedAt.jupiter, issueFor(jupiter.issues, auditField)));
    }
    if (onchain && chainStated) {
      claims.push(claim('helius', chainAuthority === null, observedAt.onchain));
    }
    return claims;
  };

  const mintClaims = authorityClaims(
    jupiter?.audit.mintAuthorityDisabled ?? null,
    'audit.mintAuthorityDisabled',
    onchain?.mintAuthorityStated ?? false,
    onchain?.mintAuthority ?? null,
    MINT_AUTHORITY_RISK,
  );
  const freezeClaims = authorityClaims(
    jupiter?.audit.freezeAuthorityDisabled ?? null,
    'audit.freezeAuthorityDisabled',
    onchain?.freezeAuthorityStated ?? false,
    onchain?.freezeAuthority ?? null,
    FREEZE_AUTHORITY_RISK,
  );

  const mintAuthorityRevoked = resolve<boolean>(mintClaims, {
    metric: 'mintAuthorityRevoked',
    now,
    resolveConflict: conservativeAuthority,
  });
  const freezeAuthorityRevoked = resolve<boolean>(freezeClaims, {
    metric: 'freezeAuthorityRevoked',
    now,
    resolveConflict: conservativeAuthority,
  });

  // --- concentration -------------------------------------------------------
  // Helius top10Share includes AMM pool vaults, so it is an upper bound and is
  // NOT comparable to Jupiter's holder percentage. Mixing them would
  // manufacture a conflict on every healthy token, so Helius is recorded only
  // when Jupiter is silent, and the gate never vetoes on it.
  const concentrationClaims: Claim<number>[] = [];
  if (jupiter?.audit.topHoldersPercentage != null) {
    concentrationClaims.push(
      claim<number>('jupiter', jupiter.audit.topHoldersPercentage, observedAt.jupiter),
    );
  } else if (onchain?.top10Share != null) {
    concentrationClaims.push(claim<number>('helius', onchain.top10Share * 100, observedAt.onchain));
  } else if (jupiter) {
    concentrationClaims.push(
      claim<number>(
        'jupiter',
        null,
        observedAt.jupiter,
        issueFor(jupiter.issues, 'audit.topHoldersPercentage'),
      ),
    );
  }

  const topHoldersPct = resolve<number>(concentrationClaims, { metric: 'topHoldersPct', now });

  // --- rugcheck risk -------------------------------------------------------
  const rugcheckRisk = resolve<number>(
    rugcheck
      ? [claim('rugcheck', rugcheck.scoreNormalised, observedAt.rugcheck, issueFor(rugcheck.issues, 'score_normalised'))]
      : [],
    { metric: 'rugcheckRisk', now },
  );

  // --- organic score -------------------------------------------------------
  const organicScore = resolve<number>(
    jupiter
      ? [claim('jupiter', jupiter.organicScore, observedAt.jupiter, issueFor(jupiter.issues, 'organicScore'))]
      : [],
    { metric: 'organicScore', now },
  );

  // --- tradability ---------------------------------------------------------
  // Derived, not reported: a venue with positive depth is one you can exit
  // through. Unknown liquidity means unknown tradability, never "untradeable".
  const tradable: Evidence<boolean> =
    liquidityUsd.state === 'MEASURED' || liquidityUsd.state === 'CONFLICTED'
      ? {
          ...liquidityUsd,
          value: (liquidityUsd.value ?? 0) > 0,
          notes: [...liquidityUsd.notes, 'derived from resolved liquidity'],
          claims: [],
        }
      : input.heliusConfigured || hasPairs || jupiter !== null
        ? unknown<boolean>(['no usable liquidity reading, so tradability is unknown'])
        : unavailable<boolean>('no market provider answered');

  const conflicts = Object.entries({
    liquidityUsd,
    volume24h,
    priceChange,
    buyPressure,
    holders,
    ageHours,
    mintAuthorityRevoked,
    freezeAuthorityRevoked,
    topHoldersPct,
    rugcheckRisk,
    organicScore,
  })
    .filter(([, evidence]) => (evidence as Evidence<unknown>).state === 'CONFLICTED')
    .map(([key]) => key);

  return {
    liquidityUsd,
    venueLiquidityUsd,
    volume24h,
    priceChange,
    buyPressure,
    holders,
    ageHours,
    mintAuthorityRevoked,
    freezeAuthorityRevoked,
    topHoldersPct,
    rugcheckRisk,
    organicScore,
    tradable,
    issues,
    conflicts,
  };
}
