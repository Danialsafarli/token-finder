/**
 * Measured behavioural features of one wallet.
 *
 * Every feature is a measurement over a stated window of the wallet's own
 * history, with the evidence behind it and a quality flag. A feature that the
 * fetched history cannot support is `null` with quality INSUFFICIENT - never a
 * default that happens to look normal. Nothing here classifies; `classify.ts`
 * reads these.
 *
 * The window is the wallet's most recent transactions as fetched (a bounded
 * page), plus its first transactions on chain when the endpoint can return
 * them oldest-first. `historyComplete` says whether the recent page reached
 * back to the start; when it did not, rates and shares describe the window,
 * not the wallet's life.
 */

import type { NormalizedTransaction } from '../ingest/normalize.ts';
import type { WalletTrade } from './wallet-trades.ts';

export type FeatureQuality = 'MEASURED' | 'PARTIAL' | 'INSUFFICIENT';

export interface Feature<T> {
  value: T | null;
  quality: FeatureQuality;
  /** Short statement of what was counted, e.g. "7 of 12 buys". */
  basis: string;
  /** Up to five signatures that support it. */
  evidence: string[];
}

export interface LaunchTime {
  slot: number | null;
  timeMs: number | null;
  source: 'chain' | 'provider';
}

export interface WalletFeatures {
  wallet: string;
  window: { fromMs: number | null; toMs: number | null; transactions: number; historyComplete: boolean };
  /** When the wallet's first transaction on chain happened (from oldest-first history). */
  firstSeenAt: Feature<number>;
  /** Seconds from the wallet's first transaction to its first trade in the window. */
  ageAtFirstTradeSec: Feature<number>;
  txPerHour: Feature<number>;
  failedShare: Feature<number>;
  trades: Feature<number>;
  buys: Feature<number>;
  sells: Feature<number>;
  tokenDiversity: Feature<number>;
  /** Buys of known launches made within 60 s of the launch. */
  freshLaunchBuys: Feature<number>;
  /** Of the buys whose launch time is known, the share within 60 s. */
  earlyEntryShare: Feature<number>;
  /** Fastest entry into a known launch, seconds. */
  fastestEntrySec: Feature<number>;
  medianEntrySec: Feature<number>;
  launchesEntered: Feature<number>;
  /** Coefficient of variation of the gaps between transactions: low is regular. */
  cadenceCv: Feature<number>;
  medianGapSec: Feature<number>;
  /** Most transactions inside any 10-second span. */
  burst10s: Feature<number>;
  /** Share of priced buys whose size matches another buy within 1%. */
  repeatedSizeShare: Feature<number>;
  /** Buy-then-sell of the same token inside the window. */
  roundTrips: Feature<number>;
  medianHoldSec: Feature<number>;
}

export interface FeatureInput {
  wallet: string;
  /** Recent transactions, any order; failures included when fetched. */
  recent: NormalizedTransaction[];
  recentComplete: boolean;
  /** The wallet's first transactions, oldest first, when available. */
  earliest: NormalizedTransaction[] | null;
  trades: WalletTrade[];
  /** Launch time per mint, when known. */
  launches: ReadonlyMap<string, LaunchTime>;
}

const EARLY_ENTRY_SEC = 60;

function feature<T>(value: T | null, quality: FeatureQuality, basis: string, evidence: string[] = []): Feature<T> {
  return { value, quality, basis, evidence: evidence.slice(0, 5) };
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : (sorted[mid] as number);
};

/** Entry delay in seconds, from slots when both are known (400 ms per slot is not assumed: time is used when present). */
function entrySec(trade: WalletTrade, launch: LaunchTime): number | null {
  if (trade.blockTimeMs !== null && launch.timeMs !== null) return Math.max(0, (trade.blockTimeMs - launch.timeMs) / 1000);
  return null;
}

export function computeFeatures(input: FeatureInput): WalletFeatures {
  const txs = [...input.recent].filter((t) => t.blockTimeMs !== null).sort((a, b) => a.slot - b.slot);
  const times = txs.map((t) => t.blockTimeMs as number);
  const fromMs = times[0] ?? null;
  const toMs = times[times.length - 1] ?? null;
  const spanHours = fromMs !== null && toMs !== null ? Math.max(1 / 60, (toMs - fromMs) / 3_600_000) : null;
  const windowQuality: FeatureQuality = input.recentComplete ? 'MEASURED' : 'PARTIAL';
  const enough = txs.length >= 5;

  // --- first seen on chain -------------------------------------------------
  const first = input.earliest?.find((t) => t.blockTimeMs !== null) ?? null;
  const firstSeenAt = first
    ? feature(first.blockTimeMs, 'MEASURED', 'the wallet\'s first transaction on chain', [first.signature])
    : input.recentComplete && txs[0]
      ? feature(txs[0].blockTimeMs, 'MEASURED', 'the wallet\'s whole history fit in one page', [txs[0].signature])
      : feature<number>(null, 'INSUFFICIENT', 'oldest history not available from this endpoint');

  const trades = [...input.trades].sort((a, b) => a.slot - b.slot);
  const firstTrade = trades[0];
  const ageAtFirstTradeSec =
    firstSeenAt.value !== null && firstTrade?.blockTimeMs != null
      ? feature(Math.max(0, (firstTrade.blockTimeMs - firstSeenAt.value) / 1000), firstSeenAt.quality, 'first trade minus first transaction', [firstTrade.signature])
      : feature<number>(null, 'INSUFFICIENT', 'first transaction or first trade time unknown');

  // --- activity --------------------------------------------------------------
  const txPerHour = enough && spanHours !== null
    ? feature(txs.length / spanHours, windowQuality, `${txs.length} transactions over ${spanHours.toFixed(1)} h`)
    : feature<number>(null, 'INSUFFICIENT', `${txs.length} transactions with a time`);
  const failed = input.recent.filter((t) => t.status === 'FAILED');
  const failedShare = input.recent.length >= 5
    ? feature(failed.length / input.recent.length, windowQuality, `${failed.length} of ${input.recent.length} transactions failed`, failed.map((t) => t.signature))
    : feature<number>(null, 'INSUFFICIENT', `${input.recent.length} transactions`);

  const buys = trades.filter((t) => t.direction === 'BUY');
  const sells = trades.filter((t) => t.direction === 'SELL');
  const tradeQuality: FeatureQuality = trades.length >= 3 ? windowQuality : 'INSUFFICIENT';
  const count = (n: number, what: string): Feature<number> => feature(n, tradeQuality === 'INSUFFICIENT' ? 'PARTIAL' : tradeQuality, what);

  // --- launches ------------------------------------------------------------------
  const delays: { sec: number; sig: string }[] = [];
  const launchesSeen = new Set<string>();
  for (const b of buys) {
    const launch = input.launches.get(b.mint);
    if (!launch) continue;
    const sec = entrySec(b, launch);
    if (sec === null) continue;
    // Only the first buy of each launch is an entry.
    if (launchesSeen.has(b.mint)) continue;
    launchesSeen.add(b.mint);
    delays.push({ sec, sig: b.signature });
  }
  const early = delays.filter((d) => d.sec <= EARLY_ENTRY_SEC);
  const entryQuality: FeatureQuality = delays.length >= 1 ? windowQuality : 'INSUFFICIENT';
  const fastest = delays.length ? delays.reduce((a, b) => (b.sec < a.sec ? b : a)) : null;

  // --- cadence -------------------------------------------------------------------
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(((times[i] as number) - (times[i - 1] as number)) / 1000);
  const meanGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  const sdGap = gaps.length ? Math.sqrt(gaps.reduce((a, g) => a + (g - meanGap) ** 2, 0) / gaps.length) : 0;
  const cadenceCv = gaps.length >= 10 && meanGap > 0
    ? feature(sdGap / meanGap, windowQuality, `${gaps.length} gaps between transactions`)
    : feature<number>(null, 'INSUFFICIENT', `${gaps.length} gaps; 10 needed`);
  let burst = 0;
  for (let i = 0, j = 0; i < times.length; i++) {
    while ((times[i] as number) - (times[j] as number) > 10_000) j++;
    burst = Math.max(burst, i - j + 1);
  }

  // --- order sizes -------------------------------------------------------------
  const sized = buys.filter((b) => b.quoteAmount !== null && b.quoteAmount > 0n);
  let repeated = 0;
  const repeatedSigs: string[] = [];
  for (const b of sized) {
    const amount = Number(b.quoteAmount);
    const twin = sized.some((o) => o !== b && Math.abs(Number(o.quoteAmount) - amount) <= amount * 0.01);
    if (twin) {
      repeated++;
      repeatedSigs.push(b.signature);
    }
  }

  // --- holding -------------------------------------------------------------------
  const holds: number[] = [];
  let roundTrips = 0;
  const openBuys = new Map<string, WalletTrade>();
  for (const t of trades) {
    if (t.direction === 'BUY') {
      if (!openBuys.has(t.mint)) openBuys.set(t.mint, t);
    } else {
      const opened = openBuys.get(t.mint);
      if (opened) {
        roundTrips++;
        if (opened.blockTimeMs !== null && t.blockTimeMs !== null) holds.push((t.blockTimeMs - opened.blockTimeMs) / 1000);
        openBuys.delete(t.mint);
      }
    }
  }

  return {
    wallet: input.wallet,
    window: { fromMs, toMs, transactions: input.recent.length, historyComplete: input.recentComplete },
    firstSeenAt,
    ageAtFirstTradeSec,
    txPerHour,
    failedShare,
    trades: count(trades.length, `${trades.length} trades`),
    buys: count(buys.length, `${buys.length} buys`),
    sells: count(sells.length, `${sells.length} sells`),
    tokenDiversity: count(new Set(trades.map((t) => t.mint)).size, 'distinct tokens traded'),
    freshLaunchBuys: feature(early.length, entryQuality, `${early.length} of ${delays.length} known-launch entries within ${EARLY_ENTRY_SEC} s`, early.map((d) => d.sig)),
    earlyEntryShare: delays.length >= 3
      ? feature(early.length / delays.length, entryQuality, `${early.length} of ${delays.length} entries within ${EARLY_ENTRY_SEC} s`)
      : feature<number>(null, 'INSUFFICIENT', `${delays.length} entries into known launches; 3 needed`),
    fastestEntrySec: fastest ? feature(fastest.sec, entryQuality, 'fastest entry into a known launch', [fastest.sig]) : feature<number>(null, 'INSUFFICIENT', 'no entry into a known launch'),
    medianEntrySec: feature(median(delays.map((d) => d.sec)), entryQuality, `${delays.length} known-launch entries`),
    launchesEntered: feature(delays.length, entryQuality, 'known launches entered'),
    cadenceCv,
    medianGapSec: feature(median(gaps), gaps.length >= 3 ? windowQuality : 'INSUFFICIENT', `${gaps.length} gaps`),
    burst10s: feature(burst, txs.length >= 5 ? windowQuality : 'INSUFFICIENT', 'most transactions in any 10 s'),
    repeatedSizeShare: sized.length >= 5
      ? feature(repeated / sized.length, windowQuality, `${repeated} of ${sized.length} priced buys share a size within 1%`, repeatedSigs)
      : feature<number>(null, 'INSUFFICIENT', `${sized.length} priced buys; 5 needed`),
    roundTrips: count(roundTrips, 'buy-then-sell of the same token'),
    medianHoldSec: holds.length >= 2
      ? feature(median(holds), windowQuality, `${holds.length} buy-to-sell holds`)
      : feature<number>(null, 'INSUFFICIENT', `${holds.length} holds; 2 needed`),
  };
}
