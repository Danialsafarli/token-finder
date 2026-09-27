/**
 * Manipulation and wash-like activity: multi-signal, never one.
 *
 * Each signal belongs to one of four families that fail differently:
 *
 * | Family | Signals |
 * |---|---|
 * | CONCENTRATION | top-3 wallets' share of volume and of trades; wallets per trade |
 * | ROUND_TRIPS | the same wallet buying and selling the same amount within minutes; two related wallets doing it between them |
 * | PATTERN | the same order size recurring across trades |
 * | RELATIONSHIP | trades by wallets in strong clusters; related wallets trading in the same slot |
 *
 * A single family firing is what honest markets look like on a quiet token
 * (three whales, or one market maker). Risk is raised only when independent
 * families agree:
 *
 *   HIGH      round trips AND (relationship OR concentration)
 *   ELEVATED  any two families
 *   LOW       one family or none, and counter-signals present
 *
 * Too few trades, too few wallets or too little of the pool's traffic resolved
 * gives INSUFFICIENT_DATA - no risk figure at all. Nothing here rejects a
 * token; that decision belongs to a later phase.
 */

export type WashRisk = 'LOW' | 'ELEVATED' | 'HIGH' | 'INSUFFICIENT_DATA';
export type WashFamily = 'CONCENTRATION' | 'ROUND_TRIPS' | 'PATTERN' | 'RELATIONSHIP';

export interface WashTrade {
  signature: string;
  trader: string | null;
  direction: 'BUY' | 'SELL';
  tokenAmount: bigint;
  quoteAmount: bigint | null;
  slot: number;
  blockTimeMs: number | null;
}

export interface WashSignal {
  family: WashFamily;
  code: string;
  value: number;
  threshold: number;
  triggered: boolean;
  text: string;
}

export interface WashAnalysis {
  risk: WashRisk;
  confidence: number;
  coverage: number;
  status: string;
  signals: WashSignal[];
  counterSignals: string[];
  familiesTriggered: WashFamily[];
  sample: { trades: number; wallets: number; unresolvedShare: number };
}

export const WASH = {
  minTrades: 30,
  minWallets: 5,
  minResolvedShare: 0.5,
  top3VolumeShare: 0.6,
  top3TradeShare: 0.6,
  tradesPerWallet: 6,
  roundTripShare: 0.2,
  roundTripWindowMs: 10 * 60_000,
  roundTripAmountTolerance: 0.05,
  repeatedSizeShare: 0.4,
  clusterVolumeShare: 0.3,
  syncShare: 0.1,
} as const;

export interface WashInput {
  trades: WashTrade[];
  /** Pool readings that were not resolved to trades (UNRESOLVED), for coverage. */
  unresolved: number;
  /** Related wallet pairs (STRONG_CANDIDATE or better), as "a|b" with a < b. */
  relatedPairs: ReadonlySet<string>;
  /** Wallets in strong clusters. */
  clusteredWallets: ReadonlySet<string>;
}

const related = (pairs: ReadonlySet<string>, a: string, b: string): boolean => pairs.has(a < b ? `${a}|${b}` : `${b}|${a}`);
const pct = (x: number): string => `${Math.round(x * 100)}%`;
const vol = (t: WashTrade): number => (t.quoteAmount === null ? 0 : Number(t.quoteAmount));

export function analyzeWash(input: WashInput): WashAnalysis {
  const trades = input.trades.filter((t) => t.trader !== null);
  const wallets = new Set(trades.map((t) => t.trader as string));
  const total = trades.length + input.unresolved;
  const unresolvedShare = total === 0 ? 0 : input.unresolved / total;
  const sample = { trades: trades.length, wallets: wallets.size, unresolvedShare };
  const coverage = total === 0 ? 0 : trades.length / total;

  if (trades.length < WASH.minTrades || wallets.size < WASH.minWallets || coverage < WASH.minResolvedShare) {
    return {
      risk: 'INSUFFICIENT_DATA',
      confidence: 0,
      coverage,
      status: `${trades.length} resolved trades by ${wallets.size} wallets (${pct(coverage)} of the pool's collected traffic); at least ${WASH.minTrades} trades, ${WASH.minWallets} wallets and ${pct(WASH.minResolvedShare)} resolved are needed`,
      signals: [],
      counterSignals: [],
      familiesTriggered: [],
      sample,
    };
  }

  const signals: WashSignal[] = [];
  const add = (family: WashFamily, code: string, value: number, threshold: number, above: boolean, text: string): void => {
    signals.push({ family, code, value: Math.round(value * 1000) / 1000, threshold, triggered: above ? value >= threshold : value <= threshold, text });
  };

  // --- concentration ------------------------------------------------------
  const volumeBy = new Map<string, number>();
  const countBy = new Map<string, number>();
  for (const t of trades) {
    volumeBy.set(t.trader as string, (volumeBy.get(t.trader as string) ?? 0) + vol(t));
    countBy.set(t.trader as string, (countBy.get(t.trader as string) ?? 0) + 1);
  }
  const totalVolume = [...volumeBy.values()].reduce((a, b) => a + b, 0);
  const top3 = (m: Map<string, number>, sum: number): number => ([...m.values()].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0)) / Math.max(1, sum);
  const top3Volume = top3(volumeBy, totalVolume);
  const top3Trades = top3(countBy, trades.length);
  const perWallet = trades.length / wallets.size;
  add('CONCENTRATION', 'TOP3_VOLUME', top3Volume, WASH.top3VolumeShare, true, `3 wallets made ${pct(top3Volume)} of the volume`);
  add('CONCENTRATION', 'TOP3_TRADES', top3Trades, WASH.top3TradeShare, true, `3 wallets made ${pct(top3Trades)} of the trades`);
  add('CONCENTRATION', 'TRADES_PER_WALLET', perWallet, WASH.tradesPerWallet, true, `${perWallet.toFixed(1)} trades per wallet`);

  // --- round trips ----------------------------------------------------------------
  const sorted = [...trades].sort((a, b) => a.slot - b.slot);
  let sameWalletTrips = 0;
  let relatedTrips = 0;
  let tripVolume = 0;
  const used = new Set<string>();
  const close = (a: bigint, b: bigint): boolean => {
    const x = Number(a);
    const y = Number(b);
    return Math.abs(x - y) <= Math.max(x, y) * WASH.roundTripAmountTolerance;
  };
  for (let i = 0; i < sorted.length; i++) {
    const buy = sorted[i] as WashTrade;
    if (buy.direction !== 'BUY' || used.has(buy.signature)) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const sell = sorted[j] as WashTrade;
      if (buy.blockTimeMs !== null && sell.blockTimeMs !== null && sell.blockTimeMs - buy.blockTimeMs > WASH.roundTripWindowMs) break;
      if (sell.direction !== 'SELL' || used.has(sell.signature) || !close(buy.tokenAmount, sell.tokenAmount)) continue;
      const same = sell.trader === buy.trader;
      const rel = !same && related(input.relatedPairs, buy.trader as string, sell.trader as string);
      if (!same && !rel) continue;
      if (same) sameWalletTrips++;
      else relatedTrips++;
      tripVolume += vol(buy) + vol(sell);
      used.add(buy.signature);
      used.add(sell.signature);
      break;
    }
  }
  const tripShare = totalVolume === 0 ? 0 : tripVolume / totalVolume;
  add('ROUND_TRIPS', 'ROUND_TRIP_VOLUME', tripShare, WASH.roundTripShare, true, `${sameWalletTrips} same-wallet and ${relatedTrips} related-wallet round trips within 10 min: ${pct(tripShare)} of volume`);

  // --- patterns ---------------------------------------------------------------------
  const sizes = new Map<string, number>();
  for (const t of trades) if (t.quoteAmount !== null && t.quoteAmount > 0n) sizes.set(Number(t.quoteAmount).toPrecision(3), (sizes.get(Number(t.quoteAmount).toPrecision(3)) ?? 0) + 1);
  const repeated = [...sizes.values()].filter((n) => n >= 3).reduce((a, b) => a + b, 0);
  const repeatedShare = repeated / trades.length;
  add('PATTERN', 'REPEATED_SIZES', repeatedShare, WASH.repeatedSizeShare, true, `${pct(repeatedShare)} of trades use a size that recurs 3+ times`);

  // --- relationships ----------------------------------------------------------------
  const clusterVolume = trades.filter((t) => input.clusteredWallets.has(t.trader as string)).reduce((a, t) => a + vol(t), 0);
  const clusterShare = totalVolume === 0 ? 0 : clusterVolume / totalVolume;
  add('RELATIONSHIP', 'CLUSTER_VOLUME', clusterShare, WASH.clusterVolumeShare, true, `${pct(clusterShare)} of volume from wallets in strong clusters`);
  const bySlot = new Map<number, WashTrade[]>();
  for (const t of trades) bySlot.set(t.slot, [...(bySlot.get(t.slot) ?? []), t]);
  let syncTrades = 0;
  for (const group of bySlot.values()) {
    if (group.length < 2) continue;
    const hit = group.some((a, i) => group.some((b, j) => j > i && a.trader !== b.trader && related(input.relatedPairs, a.trader as string, b.trader as string)));
    if (hit) syncTrades += group.length;
  }
  const syncShare = syncTrades / trades.length;
  add('RELATIONSHIP', 'SYNCHRONIZED', syncShare, WASH.syncShare, true, `${pct(syncShare)} of trades are related wallets trading in the same slot`);

  // --- verdict ------------------------------------------------------------------------
  const families = [...new Set(signals.filter((s) => s.triggered).map((s) => s.family))];
  const has = (f: WashFamily): boolean => families.includes(f);
  const counter: string[] = [];
  if (wallets.size / trades.length >= 0.5) counter.push(`${wallets.size} distinct wallets across ${trades.length} trades`);
  if (!has('CONCENTRATION')) counter.push('volume is not concentrated in a few wallets');
  if (!has('PATTERN')) counter.push('order sizes vary');
  if (!has('ROUND_TRIPS')) counter.push('no material round-trip trading');

  let risk: WashRisk;
  if (has('ROUND_TRIPS') && (has('RELATIONSHIP') || has('CONCENTRATION'))) risk = 'HIGH';
  else if (families.length >= 2) risk = 'ELEVATED';
  else risk = 'LOW';

  const depth = Math.min(1, trades.length / (WASH.minTrades * 4));
  const confidence = Math.round(Math.max(0.1, Math.min(0.9, (0.4 + 0.1 * families.length + 0.3 * depth) * coverage)) * 100) / 100;
  return {
    risk,
    confidence,
    coverage,
    status: `${trades.length} trades by ${wallets.size} wallets; ${families.length} of 4 families triggered`,
    signals,
    counterSignals: counter,
    familiesTriggered: families,
    sample,
  };
}
