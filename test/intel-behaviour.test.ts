/**
 * Buyer authenticity: wallet features read from transactions, and the
 * multi-signal classification built on them.
 *
 * Each case is a synthetic wallet history built to exercise one behaviour.
 * The point is the rules, not a claim about accuracy on real wallets: that is
 * calibration, and it is not this phase.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFeatures, type LaunchTime } from '../src/intel/features.ts';
import { classifyBuyer } from '../src/intel/classify.ts';
import { walletTrades, type WalletTrade } from '../src/intel/wallet-trades.ts';
import type { NormalizedTransaction } from '../src/ingest/normalize.ts';
import { fund, idle, mintOf, ntx, swap, T0, wallet } from './intel-helpers.ts';

const H = 3_600_000;

function analyse(w: string, recent: NormalizedTransaction[], launches = new Map<string, LaunchTime>(), entrySec: number | null = null) {
  const trades: WalletTrade[] = recent.flatMap((tx, i) => walletTrades(tx, w, i));
  const features = computeFeatures({ wallet: w, recent, recentComplete: false, earliest: null, trades, launches });
  return { features, result: classifyBuyer(features, entrySec) };
}

const codes = (xs: { code: string }[]): string[] => xs.map((x) => x.code);

describe('wallet trades', () => {
  test('a buy is read from the wallet side, with the fee added back', () => {
    const w = wallet('reader');
    const m = mintOf('reader');
    const [t] = walletTrades(swap({ wallet: w, mint: m, direction: 'BUY', tokens: 1_000_000n, sol: 0.5, timeMs: T0 }), w);
    assert.ok(t);
    assert.equal(t.direction, 'BUY');
    assert.equal(t.quoteAmount, 500_000_000n, 'the fee is not part of the price');
    assert.equal(t.walletPaidFee, true);
  });

  test('tokens that arrive with nothing paid are a transfer, not a trade', () => {
    const w = wallet('gifted');
    const m = mintOf('gift');
    const tx = ntx({
      slot: 10,
      feePayer: wallet('sender'),
      signers: [wallet('sender')],
      tokenBalances: [{ account: 'acc', owner: w, mint: m, decimals: 6, pre: 0n, post: 5n, delta: 5n }],
    });
    assert.deepEqual(walletTrades(tx, w), []);
  });

  test('a failed transaction is never a trade', () => {
    const w = wallet('failer');
    assert.deepEqual(walletTrades(swap({ wallet: w, mint: mintOf('f'), direction: 'BUY', tokens: 1n, sol: 0.1, timeMs: T0, status: 'FAILED' }), w), []);
  });
});

describe('buyer classification', () => {
  test('organic: irregular, varied, slow, holding - LIKELY_ORGANIC, and never more certain than 0.7', () => {
    const w = wallet('organic');
    const gapsSec = [60, 36_000, 300, 90_000, 1_200, 7_200, 50_000, 30, 180_000, 600, 20_000];
    const sizes = [0.1, 0.35, 1.2, 0.05, 2.7, 0.6];
    const txs: NormalizedTransaction[] = [];
    let t = T0;
    for (let i = 0; i < 12; i++) {
      txs.push(i < sizes.length ? swap({ wallet: w, mint: mintOf(`organic-${i}`), direction: 'BUY', tokens: 1_000n + BigInt(i), sol: sizes[i] as number, timeMs: t }) : idle(w, t));
      t += (gapsSec[i] ?? 0) * 1000;
    }
    const { result } = analyse(w, txs);
    assert.equal(result.classification, 'LIKELY_ORGANIC');
    assert.ok(result.confidence <= 0.7, 'organic is never claimed with high certainty');
    assert.ok(result.signals.length >= 3);
    assert.ok(codes(result.signals).includes('VARIED_SIZES'));
  });

  test('legitimate automation: a scheduled buyer is AUTOMATED_TRADER, not a sniper and not a finding against it', () => {
    const w = wallet('dca');
    const m = mintOf('dca');
    const txs = Array.from({ length: 20 }, (_, i) => swap({ wallet: w, mint: m, direction: 'BUY', tokens: 10_000n, sol: 0.5, timeMs: T0 + i * H }));
    const { result } = analyse(w, txs);
    assert.equal(result.classification, 'AUTOMATED_TRADER');
    assert.deepEqual(codes(result.signals).sort(), ['REGULAR_CADENCE', 'REPEATED_SIZES']);
    // Automation is a behaviour, not an accusation: nothing sniper- or
    // wash-like is claimed from regularity alone.
    assert.ok(!codes(result.signals).some((c) => c.includes('EARLY') || c === 'LAUNCH_SPECIALIST'));
  });

  test('sniper: repeated entries within seconds of launch, including this token', () => {
    const w = wallet('sniper');
    const launches = new Map<string, LaunchTime>();
    const txs: NormalizedTransaction[] = [];
    for (let i = 0; i < 5; i++) {
      const m = mintOf(`launch-${i}`);
      const launchAt = T0 + i * 20 * 60_000 + 7_777 * i;
      launches.set(m, { slot: null, timeMs: launchAt, source: 'chain' });
      txs.push(swap({ wallet: w, mint: m, direction: 'BUY', tokens: 50_000n, sol: 1 + i * 0.37, timeMs: launchAt + 2_000 + i * 300 }));
      txs.push(swap({ wallet: w, mint: m, direction: 'SELL', tokens: 50_000n, sol: 1.5 + i * 0.41, timeMs: launchAt + 9 * 60_000 + i * 11_000 }));
    }
    const { result } = analyse(w, txs, launches, 2);
    assert.equal(result.classification, 'SNIPER');
    const s = codes(result.signals);
    assert.ok(s.includes('EARLY_ENTRY_THIS_TOKEN'));
    assert.ok(s.includes('REPEATED_EARLY_ENTRY'));
  });

  test('one early entry alone does not make a sniper', () => {
    const w = wallet('lucky');
    const launches = new Map<string, LaunchTime>();
    const txs: NormalizedTransaction[] = [];
    for (let i = 0; i < 5; i++) {
      const m = mintOf(`late-${i}`);
      const launchAt = T0 + i * 3 * H;
      launches.set(m, { slot: null, timeMs: launchAt, source: 'chain' });
      // Only the first is early; the rest are hours after launch.
      txs.push(swap({ wallet: w, mint: m, direction: 'BUY', tokens: 1_000n, sol: 0.2 + i * 0.31, timeMs: launchAt + (i === 0 ? 3_000 : 2 * H) }));
      txs.push(idle(w, launchAt + 2 * H + 17 * 60_000 * (i + 1)));
    }
    const { result } = analyse(w, txs, launches, 3);
    assert.notEqual(result.classification, 'SNIPER');
    assert.ok(codes(result.signals).includes('EARLY_ENTRY_THIS_TOKEN'), 'the signal is reported, not hidden');
  });

  test('high-frequency: many transactions an hour, short round trips, balanced churn', () => {
    const w = wallet('hft');
    const m = mintOf('hft');
    const txs: NormalizedTransaction[] = [];
    let t = T0;
    for (let i = 0; i < 30; i++) {
      txs.push(swap({ wallet: w, mint: m, direction: 'BUY', tokens: 7_000n + BigInt(i * 13), sol: 0.3 + (i % 7) * 0.11, timeMs: t }));
      t += 20_000 + (i % 5) * 7_000;
      txs.push(swap({ wallet: w, mint: m, direction: 'SELL', tokens: 7_000n + BigInt(i * 13), sol: 0.31 + (i % 7) * 0.11, timeMs: t }));
      t += 60_000 + (i % 3) * 23_000;
    }
    const { result } = analyse(w, txs);
    assert.equal(result.classification, 'HIGH_FREQUENCY_TRADER');
    const s = codes(result.signals);
    assert.ok(s.includes('HIGH_RATE') && s.includes('SHORT_HOLDS'));
  });

  test('insufficient data: a thin history is INSUFFICIENT_DATA, with zero confidence', () => {
    const w = wallet('thin');
    const txs = [
      fund(wallet('someone'), w, 1, T0),
      swap({ wallet: w, mint: mintOf('thin'), direction: 'BUY', tokens: 1n, sol: 0.1, timeMs: T0 + 60_000 }),
      idle(w, T0 + 120_000),
    ];
    const { result, features } = analyse(w, txs);
    assert.equal(result.classification, 'INSUFFICIENT_DATA');
    assert.equal(result.confidence, 0);
    assert.equal(features.cadenceCv.quality, 'INSUFFICIENT', 'an unmeasured feature says so');
    assert.equal(features.cadenceCv.value, null, 'and is never zero');
  });

  test('every classification states its coverage, signals and counter-signals', () => {
    const w = wallet('mixed');
    const txs = Array.from({ length: 10 }, (_, i) => swap({ wallet: w, mint: mintOf(`m${i % 3}`), direction: i % 2 ? 'SELL' : 'BUY', tokens: 100n, sol: 0.1 * (i + 1), timeMs: T0 + i * 17 * 60_000 * (1 + (i % 4)) }));
    const { result } = analyse(w, txs);
    assert.ok(result.coverage >= 0 && result.coverage <= 1);
    assert.ok(Array.isArray(result.signals) && Array.isArray(result.counterSignals));
    assert.ok(!('human' in result), 'nothing claims a wallet is definitely human');
  });
});
