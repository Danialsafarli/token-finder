/**
 * What kind of activity a token's trading is, measured three separate ways.
 *
 *   by wallets    - of the wallets that traded, how many of each kind
 *   by trades     - of the trades, how many were made by each kind
 *   by volume     - of the quote volume, how much came from each kind
 *
 * The three are never mixed: a token can be 80% organic by wallet count and
 * 20% by volume, and both facts matter. Categories, in precedence order for a
 * wallet that fits several:
 *
 *   coordinated (in a strong or confirmed cluster)
 *   sniper
 *   automated (automated trader or high-frequency trader)
 *   likely organic
 *   unknown (not analysed, insufficient data, or unclear)
 *
 * Unknown is always reported. When less than {@link MIN_COVERAGE} of a view is
 * classified, that view gives counts only and no shares: a percentage of a
 * fifth of the evidence is not a percentage of the token.
 */

import type { BuyerClass } from './classify.ts';

export const MIN_COVERAGE = 0.3;

export type ActivityCategory = 'coordinated' | 'sniper' | 'automated' | 'likely_organic' | 'unknown';

export interface ActivityView {
  counts: Record<ActivityCategory, number>;
  /** Shares of the total, or null when coverage is below the floor. */
  shares: Record<ActivityCategory, number> | null;
  total: number;
  coverage: number;
}

export interface ActivityQuality {
  status: 'MEASURED' | 'PARTIAL' | 'INSUFFICIENT_DATA';
  byWallets: ActivityView;
  byTrades: ActivityView;
  byVolume: ActivityView;
  note: string;
}

export interface ActivityInput {
  trades: { trader: string | null; quoteAmount: bigint | null }[];
  classes: ReadonlyMap<string, BuyerClass>;
  clustered: ReadonlySet<string>;
}

function categoryOf(wallet: string, input: ActivityInput): ActivityCategory {
  if (input.clustered.has(wallet)) return 'coordinated';
  switch (input.classes.get(wallet)) {
    case 'SNIPER':
      return 'sniper';
    case 'AUTOMATED_TRADER':
    case 'HIGH_FREQUENCY_TRADER':
      return 'automated';
    case 'LIKELY_ORGANIC':
      return 'likely_organic';
    default:
      return 'unknown';
  }
}

function view(weights: Map<string, number>, input: ActivityInput): ActivityView {
  const counts: Record<ActivityCategory, number> = { coordinated: 0, sniper: 0, automated: 0, likely_organic: 0, unknown: 0 };
  let total = 0;
  for (const [wallet, weight] of weights) {
    counts[categoryOf(wallet, input)] += weight;
    total += weight;
  }
  const coverage = total === 0 ? 0 : (total - counts.unknown) / total;
  const shares =
    coverage >= MIN_COVERAGE && total > 0
      ? (Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, Math.round((n / total) * 1000) / 1000])) as Record<ActivityCategory, number>)
      : null;
  return { counts, shares, total, coverage: Math.round(coverage * 1000) / 1000 };
}

export function activityQuality(input: ActivityInput): ActivityQuality {
  const walletWeights = new Map<string, number>();
  const tradeWeights = new Map<string, number>();
  const volumeWeights = new Map<string, number>();
  for (const t of input.trades) {
    if (t.trader === null) continue;
    walletWeights.set(t.trader, 1);
    tradeWeights.set(t.trader, (tradeWeights.get(t.trader) ?? 0) + 1);
    if (t.quoteAmount !== null) volumeWeights.set(t.trader, (volumeWeights.get(t.trader) ?? 0) + Number(t.quoteAmount));
  }
  const byWallets = view(walletWeights, input);
  const byTrades = view(tradeWeights, input);
  const byVolume = view(volumeWeights, input);
  const worst = Math.min(byWallets.coverage, byTrades.coverage, byVolume.coverage);
  const status = byWallets.total === 0 ? 'INSUFFICIENT_DATA' : worst >= 0.7 ? 'MEASURED' : byWallets.shares || byTrades.shares || byVolume.shares ? 'PARTIAL' : 'INSUFFICIENT_DATA';
  return {
    status,
    byWallets,
    byTrades,
    byVolume,
    note:
      status === 'INSUFFICIENT_DATA'
        ? 'too few of the trading wallets were classified to state shares'
        : 'shares are of the trades collected, not of all trading; unknown is shown, not redistributed',
  };
}
