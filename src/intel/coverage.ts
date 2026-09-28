/**
 * How much of a token's market an activity sample represents.
 *
 * Wash and activity readings are only as good as the trades they read, and
 * those trades come from a bounded sample: the pools Token Finder knows, and
 * within each, the transactions it had budget to collect. A reading over 40
 * trades means one thing when the market made 45 in that time and another
 * when it made 4,000. This module states which, from three measurements:
 *
 * - **venue share**: of the token's 24 h volume (every pool a market provider
 *   reported), how much sits on pools we have any readings from;
 * - **sample share**: of the trades the providers' own counts imply happened
 *   during the span we observed, how many we actually hold;
 * - **span**: how long that observed stretch is. Every trade of a five-minute
 *   window is still five minutes.
 *
 *   representativeness = min(1, sample / 0.5) x min(1, span / 30 min)
 *
 * With no provider trade counts, the sample share cannot be computed and the
 * venue share stands in at half weight: knowing we watch the right pool is
 * not the same as knowing we saw its trades.
 *
 * The decision layer multiplies a domain's coverage by this, so a manipulation
 * reading taken from a sliver of the market cannot drive a strong conclusion.
 */

import type { MarketCoverage, PoolCoverage } from '../decision/types.ts';
import type { PoolRef } from '../types.ts';

export const COVERAGE_RULES = {
  fullSampleShare: 0.5,
  fullSpanMs: 30 * 60_000,
  noCountsWeight: 0.5,
} as const;

export interface ObservedTrade {
  pool: string;
  blockTime: number | null;
  quoteMint: string | null;
}

const HOUR = 3_600_000;

export function marketCoverage(trades: ObservedTrade[], pools: PoolRef[], volumeQuote: string | null, now: number): MarketCoverage {
  const recent = trades.filter((t) => t.blockTime !== null && now - t.blockTime <= 24 * HOUR);
  const times = recent.map((t) => t.blockTime as number);
  const windowMs = times.length >= 2 ? Math.max(60_000, Math.max(...times) - Math.min(...times)) : times.length === 1 ? 60_000 : null;
  const byPool = new Map<string, number>();
  for (const t of recent) byPool.set(t.pool, (byPool.get(t.pool) ?? 0) + 1);

  const known = new Map(pools.map((p) => [p.address, p]));
  // Pools we collected from that no provider listed are still pools we saw.
  for (const address of byPool.keys()) {
    if (!known.has(address)) known.set(address, { address, dexId: 'unknown', quoteSymbol: '?', liquidityUsd: null, volume24h: null, txnsH1: null, txns24h: null });
  }
  const all = [...known.values()];
  const totalVolume = all.reduce((s, p) => s + (p.volume24h ?? 0), 0);
  const volumesKnown = all.some((p) => p.volume24h !== null) && totalVolume > 0;

  const poolViews: PoolCoverage[] = all.map((p) => ({
    address: p.address,
    dexId: p.dexId,
    quoteSymbol: p.quoteSymbol,
    observedTrades: byPool.get(p.address) ?? 0,
    reportedTrades24h: p.txns24h,
    volumeShare: volumesKnown ? Math.round(((p.volume24h ?? 0) / totalVolume) * 1000) / 1000 : null,
  }));

  const observedPools = poolViews.filter((p) => p.observedTrades > 0).length;
  const venueShare = volumesKnown ? poolViews.filter((p) => p.observedTrades > 0).reduce((s, p) => s + (p.volumeShare ?? 0), 0) : null;

  // Trades the providers' counts imply in the span we observed, over every
  // pool: an hourly rate where the span is short, the daily one otherwise.
  let expected: number | null = null;
  if (windowMs !== null) {
    let total = 0;
    let any = false;
    for (const p of all) {
      const rate = windowMs <= HOUR && p.txnsH1 !== null ? p.txnsH1 / HOUR : p.txns24h !== null ? p.txns24h / (24 * HOUR) : null;
      if (rate === null) continue;
      any = true;
      total += rate * windowMs;
    }
    expected = any ? Math.max(1, total) : null;
  }
  const observed = recent.length;
  const sampleShare = expected === null ? null : Math.min(1, observed / expected);
  const spanFactor = windowMs === null ? 0 : Math.min(1, windowMs / COVERAGE_RULES.fullSpanMs);
  const representativeness =
    sampleShare !== null
      ? Math.min(1, sampleShare / COVERAGE_RULES.fullSampleShare) * spanFactor
      : (venueShare ?? 0) * COVERAGE_RULES.noCountsWeight * spanFactor;

  const excluded = volumeQuote === null ? 0 : recent.filter((t) => t.quoteMint !== null && t.quoteMint !== volumeQuote).length;
  const minutes = windowMs === null ? 0 : Math.round(windowMs / 60_000);
  const note =
    observed === 0
      ? `no trades observed in the last 24 h across ${all.length} known pool(s)`
      : `observed ${observed} trade(s) over ${minutes} min on ${observedPools} of ${all.length} pool(s)` +
        (sampleShare !== null ? `, about ${Math.round(sampleShare * 100)}% of the trades the providers report for that span` : ', with no provider trade counts to compare against') +
        (venueShare !== null ? `; those pools carry ${Math.round(venueShare * 100)}% of 24 h volume` : '');

  return {
    pools: poolViews.slice(0, 10),
    knownPools: all.length,
    observedPools,
    venueShare: venueShare === null ? null : Math.round(venueShare * 1000) / 1000,
    windowMs,
    observedTrades: observed,
    expectedTrades: expected === null ? null : Math.round(expected),
    sampleShare: sampleShare === null ? null : Math.round(sampleShare * 1000) / 1000,
    representativeness: Math.round(representativeness * 1000) / 1000,
    volumeQuote,
    excludedFromVolume: excluded,
    note,
  };
}

/** The quote currency most trades were priced in; volume is summed in it alone. */
export function dominantQuote(trades: { quoteMint: string | null }[]): string | null {
  const counts = new Map<string, number>();
  for (const t of trades) if (t.quoteMint) counts.set(t.quoteMint, (counts.get(t.quoteMint) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [mint, c] of counts) if (c > n) [best, n] = [mint, c];
  return best;
}
