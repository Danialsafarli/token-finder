/**
 * Buyer authenticity: how a wallet trades, stated with its reasons.
 *
 *   LIKELY_ORGANIC | AUTOMATED_TRADER | SNIPER | HIGH_FREQUENCY_TRADER
 *   UNKNOWN | INSUFFICIENT_DATA
 *
 * ## What these labels do not mean
 *
 * **Automation is not malice.** A sniper, a market maker and an arbitrage bot
 * are automated; none of that is a scam. These labels describe behaviour and
 * carry no verdict about intent - manipulation and malicious events are
 * separate analyses (`wash.ts`, `security.ts`) with their own evidence.
 *
 * **LIKELY_ORGANIC is never "human".** It means the observed behaviour shows
 * none of the automation signals and several of their opposites. Its
 * confidence is capped below certainty for that reason.
 *
 * ## How a label is earned
 *
 * Every label needs at least two independent supporting signals; no single
 * feature decides anything. Each signal names the measurement behind it.
 * Counter-signals (evidence against the label) lower the confidence, as does
 * a history the fetch could not see all of.
 *
 * The thresholds are stated constants, not fitted values: this is an
 * explainable first model, uncalibrated against labelled outcomes (Phase 4).
 */

import type { Feature, WalletFeatures } from './features.ts';

export type BuyerClass =
  | 'LIKELY_ORGANIC'
  | 'AUTOMATED_TRADER'
  | 'SNIPER'
  | 'HIGH_FREQUENCY_TRADER'
  | 'UNKNOWN'
  | 'INSUFFICIENT_DATA';

export interface Signal {
  code: string;
  /** What was measured, in words, with the number. */
  text: string;
}

export interface BuyerClassification {
  classification: BuyerClass;
  confidence: number;
  signals: Signal[];
  counterSignals: Signal[];
  /** 0-1: how much of what the model looks at could be measured. */
  coverage: number;
}

export const THRESHOLDS = {
  minTransactions: 8,
  minTrades: 3,
  sniperEntrySec: 10,
  freshLaunchBuys: 3,
  earlyEntryShare: 0.5,
  launchSpecialist: 5,
  /** A launch specialist's typical entry: entering old launches is ordinary trading. */
  launchSpecialistMedianSec: 300,
  hftTxPerHour: 30,
  hftMinTransactions: 30,
  hftHoldSec: 120,
  hftRoundTrips: 3,
  regularCadenceCv: 0.35,
  repeatedSizeShare: 0.6,
  failedShare: 0.25,
  burst10s: 5,
  diversityPerDay: 15,
  organicCadenceCv: 1,
  organicSizeShare: 0.2,
  organicTxPerHour: 3,
  organicHoldSec: 3600,
} as const;

const v = <T>(f: Feature<T>): T | null => (f.quality === 'INSUFFICIENT' ? null : f.value);
const fmt = (n: number, digits = 1): string => (Number.isInteger(n) ? String(n) : n.toFixed(digits));

/**
 * @param analyzedEntrySec Seconds from the analyzed token's launch to this
 *   wallet's first buy of it, when both are known.
 */
export function classifyBuyer(f: WalletFeatures, analyzedEntrySec: number | null = null): BuyerClassification {
  const measurable = [
    f.txPerHour, f.failedShare, f.cadenceCv, f.burst10s, f.repeatedSizeShare,
    f.earlyEntryShare, f.medianHoldSec, f.tokenDiversity, f.firstSeenAt,
  ];
  const coverage = measurable.filter((m) => m.quality !== 'INSUFFICIENT').length / measurable.length;

  const trades = v(f.trades) ?? 0;
  if (f.window.transactions < THRESHOLDS.minTransactions || trades < THRESHOLDS.minTrades) {
    return {
      classification: 'INSUFFICIENT_DATA',
      confidence: 0,
      signals: [],
      counterSignals: [{ code: 'THIN_HISTORY', text: `${f.window.transactions} transactions and ${trades} trades observed; ${THRESHOLDS.minTransactions} and ${THRESHOLDS.minTrades} are needed` }],
      coverage,
    };
  }

  const sniper: Signal[] = [];
  const hft: Signal[] = [];
  const auto: Signal[] = [];
  const organic: Signal[] = [];

  // --- sniper ---------------------------------------------------------------
  if (analyzedEntrySec !== null && analyzedEntrySec <= THRESHOLDS.sniperEntrySec) {
    sniper.push({ code: 'EARLY_ENTRY_THIS_TOKEN', text: `entered this token ${fmt(analyzedEntrySec)} s after its launch` });
  }
  const fresh = v(f.freshLaunchBuys);
  if (fresh !== null && fresh >= THRESHOLDS.freshLaunchBuys) {
    sniper.push({ code: 'REPEATED_EARLY_ENTRY', text: `entered ${fresh} launches within 60 s of launch in the window` });
  }
  const earlyShare = v(f.earlyEntryShare);
  if (earlyShare !== null && earlyShare >= THRESHOLDS.earlyEntryShare) {
    sniper.push({ code: 'MOSTLY_EARLY', text: `${Math.round(earlyShare * 100)}% of its launch entries were within 60 s` });
  }
  const launches = v(f.launchesEntered);
  const medianEntry = v(f.medianEntrySec);
  if (launches !== null && launches >= THRESHOLDS.launchSpecialist && medianEntry !== null && medianEntry <= THRESHOLDS.launchSpecialistMedianSec) {
    sniper.push({ code: 'LAUNCH_SPECIALIST', text: `entered ${launches} known launches, typically ${fmt(medianEntry)} s after launch` });
  }

  // --- high frequency -----------------------------------------------------------
  const rate = v(f.txPerHour);
  if (rate !== null && rate >= THRESHOLDS.hftTxPerHour && f.window.transactions >= THRESHOLDS.hftMinTransactions) {
    hft.push({ code: 'HIGH_RATE', text: `${fmt(rate)} transactions an hour over ${f.window.transactions} transactions` });
  }
  const hold = v(f.medianHoldSec);
  const trips = v(f.roundTrips) ?? 0;
  if (hold !== null && hold <= THRESHOLDS.hftHoldSec && trips >= THRESHOLDS.hftRoundTrips) {
    hft.push({ code: 'SHORT_HOLDS', text: `median hold ${fmt(hold)} s across ${trips} round trips` });
  }
  const buys = v(f.buys) ?? 0;
  const sells = v(f.sells) ?? 0;
  if (trades >= 20 && buys > 0 && sells / buys >= 0.7 && sells / buys <= 1.5) {
    hft.push({ code: 'BALANCED_CHURN', text: `${buys} buys against ${sells} sells over ${trades} trades` });
  }

  // --- automation -----------------------------------------------------------------
  const cv = v(f.cadenceCv);
  if (cv !== null && cv <= THRESHOLDS.regularCadenceCv) {
    auto.push({ code: 'REGULAR_CADENCE', text: `gaps between transactions vary by only ${Math.round(cv * 100)}% (coefficient of variation)` });
  }
  const sizes = v(f.repeatedSizeShare);
  if (sizes !== null && sizes >= THRESHOLDS.repeatedSizeShare) {
    auto.push({ code: 'REPEATED_SIZES', text: `${Math.round(sizes * 100)}% of priced buys repeat another buy's size within 1%` });
  }
  const failed = v(f.failedShare);
  if (failed !== null && failed >= THRESHOLDS.failedShare && f.window.transactions >= 10) {
    auto.push({ code: 'MANY_FAILURES', text: `${Math.round(failed * 100)}% of its transactions failed` });
  }
  const burst = v(f.burst10s);
  if (burst !== null && burst >= THRESHOLDS.burst10s) {
    auto.push({ code: 'BURSTS', text: `${burst} transactions inside 10 seconds` });
  }
  const diversity = v(f.tokenDiversity);
  const spanH = f.window.fromMs !== null && f.window.toMs !== null ? (f.window.toMs - f.window.fromMs) / 3_600_000 : null;
  if (diversity !== null && spanH !== null && spanH <= 24 && diversity >= THRESHOLDS.diversityPerDay) {
    auto.push({ code: 'MANY_TOKENS', text: `traded ${diversity} different tokens in ${fmt(Math.max(spanH, 0.1))} h` });
  }

  // --- organic -------------------------------------------------------------------
  if (cv !== null && cv >= THRESHOLDS.organicCadenceCv) organic.push({ code: 'IRREGULAR_CADENCE', text: 'irregular timing between transactions' });
  if (sizes !== null && sizes <= THRESHOLDS.organicSizeShare) organic.push({ code: 'VARIED_SIZES', text: 'order sizes vary' });
  if (rate !== null && rate <= THRESHOLDS.organicTxPerHour) organic.push({ code: 'LOW_RATE', text: `${fmt(rate)} transactions an hour` });
  if ((hold !== null && hold >= THRESHOLDS.organicHoldSec) || (buys >= 3 && sells === 0)) {
    organic.push({ code: 'HOLDS', text: hold !== null ? `median hold ${fmt(hold / 3600)} h` : 'bought and has not sold in the window' });
  }
  if (failed !== null && failed <= 0.05) organic.push({ code: 'FEW_FAILURES', text: 'almost no failed transactions' });

  const automationFamily = [...auto, ...hft];
  const history = f.window.historyComplete ? 1 : 0.85;
  const confidenceFor = (support: number, counter: number, cap: number): number => {
    const base = support >= 4 ? 0.85 : support === 3 ? 0.75 : 0.6;
    const value = (base - 0.1 * counter) * history * (0.5 + 0.5 * coverage);
    return Math.round(Math.max(0.05, Math.min(cap, value)) * 100) / 100;
  };

  const strongSniper = sniper.some((s) => s.code === 'EARLY_ENTRY_THIS_TOKEN' || s.code === 'REPEATED_EARLY_ENTRY');
  if (sniper.length >= 2 && strongSniper) {
    return { classification: 'SNIPER', confidence: confidenceFor(sniper.length + auto.length, organic.length, 0.95), signals: [...sniper, ...auto], counterSignals: organic, coverage };
  }
  if (hft.length >= 2) {
    return { classification: 'HIGH_FREQUENCY_TRADER', confidence: confidenceFor(hft.length + auto.length, organic.length, 0.95), signals: [...hft, ...auto], counterSignals: organic, coverage };
  }
  if (automationFamily.length >= 2) {
    return { classification: 'AUTOMATED_TRADER', confidence: confidenceFor(automationFamily.length, organic.length, 0.9), signals: automationFamily, counterSignals: organic, coverage };
  }
  if (organic.length >= 3 && automationFamily.length === 0 && sniper.length === 0) {
    return { classification: 'LIKELY_ORGANIC', confidence: confidenceFor(organic.length, 0, 0.7), signals: organic, counterSignals: [], coverage };
  }
  return {
    classification: 'UNKNOWN',
    confidence: 0,
    signals: [...sniper, ...automationFamily],
    counterSignals: [...organic, { code: 'MIXED', text: 'the signals do not agree on one behaviour' }],
    coverage,
  };
}
