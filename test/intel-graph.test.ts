/**
 * Funding, the relationship graph, clusters, wash analysis and activity
 * quality - the rules that decide when wallets are treated as related.
 *
 * The recurring hazard is false association: an exchange, a bridge or a
 * shared launch must never make two strangers one operator. Several cases
 * below exist only to pin that down.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFunding, findInitialFunding, HUB_FAN_OUT, type FundingObservation } from '../src/intel/funding.ts';
import { deriveEdges, type FundingEdgeInput, type GraphInput } from '../src/intel/graph.ts';
import { assessPairs, buildClusters } from '../src/intel/cluster.ts';
import { analyzeWash, type WashTrade } from '../src/intel/wash.ts';
import { activityQuality } from '../src/intel/activity-quality.ts';
import type { WalletTrade } from '../src/intel/wallet-trades.ts';
import type { BuyerClass } from '../src/intel/classify.ts';
import { fund, idle, mintOf, pda, T0, wallet } from './intel-helpers.ts';

const graph = (p: Partial<GraphInput>): GraphInput => ({
  funding: [],
  trades: [],
  transfers: [],
  launches: new Map(),
  creators: new Map(),
  isWallet: () => true,
  ...p,
});

const buy = (w: string, mint: string, slot: number, lamports: bigint, signature = `${w.slice(0, 4)}-${mint.slice(0, 4)}-${slot}`): WalletTrade => ({
  wallet: w,
  signature,
  mint,
  direction: 'BUY',
  tokenAmount: 1000n,
  tokenDecimals: 6,
  quoteMint: 'So11111111111111111111111111111111111111112',
  quoteAmount: lamports,
  quoteDecimals: 9,
  slot,
  txIndex: null,
  blockTimeMs: T0 + slot * 400,
  walletPaidFee: true,
});

const direct = (funder: string, w: string, i: number): FundingEdgeInput => ({ wallet: w, funder, classification: 'DIRECT', confidence: 0.9, signature: `f-${i}`, blockTimeMs: T0 + i });

describe('funding', () => {
  const w = wallet('funded');
  const f = wallet('funder');
  const obs: FundingObservation = { wallet: w, funder: f, lamports: 10n ** 9n, signature: 's', slot: 1, blockTimeMs: T0, firstInbound: true, historyFromStart: true };

  test('the first SOL a wallet received is read from its oldest transactions', () => {
    const found = findInitialFunding(w, [idle(w, T0), fund(f, w, 2, T0 + 1000), fund(wallet('later'), w, 5, T0 + 2000)], true);
    assert.equal(found?.funder, f);
    assert.equal(found?.firstInbound, true);
  });

  test('direct funding: first SOL, from a keypair checked not to be a hub', () => {
    const v = classifyFunding(obs, { address: f, onCurve: true, recentTxCount: 40, recentWindowMs: 24 * 3_600_000, fanOut: 2 });
    assert.equal(v.classification, 'DIRECT');
  });

  test('a funder that was never checked cannot make funding DIRECT', () => {
    assert.equal(classifyFunding(obs, { address: f, onCurve: true, recentTxCount: null, recentWindowMs: null, fanOut: 1 }).classification, 'LIKELY');
    assert.equal(classifyFunding({ ...obs, historyFromStart: false }, { address: f, onCurve: true, recentTxCount: 3, recentWindowMs: 1000, fanOut: 1 }).classification, 'LIKELY');
  });

  test('infrastructure: a program account, a high-volume sender or a wide fan-out is never ownership', () => {
    assert.equal(classifyFunding({ ...obs, funder: pda('bridge') }, { address: pda('bridge'), onCurve: false, recentTxCount: null, recentWindowMs: null, fanOut: 0 }).classification, 'INFRASTRUCTURE');
    assert.equal(classifyFunding(obs, { address: f, onCurve: true, recentTxCount: 1000, recentWindowMs: 2 * 3_600_000, fanOut: 1 }).classification, 'INFRASTRUCTURE');
    assert.equal(classifyFunding(obs, { address: f, onCurve: true, recentTxCount: 12, recentWindowMs: 3_600_000, fanOut: HUB_FAN_OUT }).classification, 'INFRASTRUCTURE');
    assert.equal(classifyFunding(null, null).classification, 'UNKNOWN');
  });

  test('infrastructure false-positive prevention: wallets paid by one exchange are not linked', () => {
    const exchange = wallet('exchange');
    const users = ['u1', 'u2', 'u3', 'u4'].map(wallet);
    const edges = deriveEdges(graph({ funding: users.map((u, i) => ({ ...direct(exchange, u, i), classification: 'INFRASTRUCTURE' as const })) }));
    assert.deepEqual(edges, [], 'no FUNDED and no SHARED_FUNDER edge from infrastructure');
    assert.equal(buildClusters(assessPairs(edges)).clusters.length, 0);
  });
});

describe('relationships and clusters', () => {
  test('a relationship candidate: the same wallets entering several tokens together at the same uncommon size', () => {
    const a = wallet('pair-a');
    const b = wallet('pair-b');
    const trades = [
      buy(a, mintOf('x'), 100, 123_456_789n), buy(b, mintOf('x'), 101, 123_456_000n),
      buy(a, mintOf('y'), 500, 987_654_321n), buy(b, mintOf('y'), 500, 987_650_000n),
    ];
    const pairs = assessPairs(deriveEdges(graph({ trades })));
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0]?.level, 'STRONG_CANDIDATE');
    assert.ok(pairs[0]?.kinds.includes('COORDINATED_ENTRY'));
    assert.ok(pairs[0]?.kinds.includes('REPEATED_ORDER_SIZE'));
  });

  test('unrelated wallets: same token, far apart, different sizes - no edge at all', () => {
    const trades = [buy(wallet('far-a'), mintOf('z'), 100, 100_000_000n), buy(wallet('far-b'), mintOf('z'), 900, 350_000_000n)];
    assert.deepEqual(deriveEdges(graph({ trades })), []);
  });

  test('a crowd entering in the same slots distinguishes nobody', () => {
    const m = mintOf('crowd');
    const trades = Array.from({ length: 12 }, (_, i) => buy(wallet(`crowd-${i}`), m, 100 + (i % 2), BigInt(100_000_000 + i * 7_919_111)));
    assert.equal(deriveEdges(graph({ trades })).filter((e) => e.type === 'COORDINATED_ENTRY').length, 0);
  });

  test('a strong cluster: one direct funder and a token transfer tie wallets together', () => {
    const f = wallet('boss');
    const [a, b, c] = ['s-a', 's-b', 's-c'].map(wallet) as [string, string, string];
    const edges = deriveEdges(graph({
      funding: [direct(f, a, 1), direct(f, b, 2), direct(f, c, 3)],
      transfers: [{ from: a, to: b, signature: 't1', blockTimeMs: T0, asset: 'SOL' }],
    }));
    const pairs = assessPairs(edges);
    const { clusters } = buildClusters(pairs);
    assert.equal(clusters.length, 1);
    assert.deepEqual(clusters[0]?.members, [f, a, b, c].sort());
    const ab = pairs.find((p) => [p.a, p.b].sort().join() === [a, b].sort().join());
    // A transfer is one hard link; a shared funder only corroborates. That is
    // a strong candidate, not yet confirmed.
    assert.equal(ab?.level, 'STRONG_CANDIDATE');
    assert.equal(clusters[0]?.level, 'STRONG_CANDIDATE');
    assert.ok((clusters[0]?.reasons.length ?? 0) > 0, 'a cluster explains itself');
  });

  test('a confirmed relationship needs two independent hard links', () => {
    const f = wallet('c-funder');
    const a = wallet('c-a');
    const edges = deriveEdges(graph({
      funding: [direct(f, a, 1)],
      transfers: [{ from: a, to: f, signature: 'back', blockTimeMs: T0 + 5, asset: 'SOL' }],
    }));
    const [pair] = assessPairs(edges);
    assert.equal(pair?.level, 'CONFIRMED_RELATIONSHIP');
    assert.equal(buildClusters([pair!]).clusters[0]?.level, 'CONFIRMED_RELATIONSHIP');
  });

  test('a weak cluster is never collapsed: shared launches alone link nobody', () => {
    const [a, b, c] = ['w-a', 'w-b', 'w-c'].map(wallet) as [string, string, string];
    const launches = new Map<string, { timeMs: number | null }>();
    const trades: WalletTrade[] = [];
    for (let i = 0; i < 3; i++) {
      const m = mintOf(`weak-${i}`);
      launches.set(m, { timeMs: T0 + i * 1_000_000 });
      // Each enters early, but many slots apart and at different sizes.
      trades.push(buy(a, m, 2_500 * i + 10, BigInt(111_000_000 + i)));
      trades.push(buy(b, m, 2_500 * i + 40, BigInt(222_000_000 + i * 3_000_000)));
      trades.push(buy(c, m, 2_500 * i + 90, BigInt(333_000_000 + i * 5_000_000)));
    }
    const pairs = assessPairs(deriveEdges(graph({ trades, launches })));
    assert.ok(pairs.length > 0 && pairs.every((p) => p.level === 'WEAK_CANDIDATE'));
    const { clusters, weak } = buildClusters(pairs);
    assert.equal(clusters.length, 0);
    assert.equal(weak.length, pairs.length, 'weak pairs are reported, one by one');
  });

  test('transfers through a non-wallet (a pool or program) are not relationships', () => {
    const edges = deriveEdges(graph({
      transfers: [{ from: wallet('t-a'), to: pda('pool'), signature: 't', blockTimeMs: T0, asset: 'SOL' }],
      isWallet: (x) => x !== pda('pool'),
    }));
    assert.deepEqual(edges, []);
  });

  test('every edge keeps its type, direction, evidence, confidence and time', () => {
    const [e] = deriveEdges(graph({ funding: [direct(wallet('e-f'), wallet('e-w'), 7)] }));
    assert.ok(e);
    assert.equal(e.type, 'FUNDED');
    assert.equal(e.directed, true);
    assert.equal(e.a, wallet('e-f'));
    assert.deepEqual(e.evidence, ['f-7']);
    assert.ok(e.confidence > 0 && e.firstAt !== null);
  });
});

describe('wash analysis', () => {
  let slot = 1_000;
  const trade = (trader: string, direction: 'BUY' | 'SELL', tokens: bigint, lamports: bigint, dt = 10): WashTrade => {
    slot += dt;
    return { signature: `w${slot}`, trader, direction, tokenAmount: tokens, quoteAmount: lamports, slot, blockTimeMs: T0 + slot * 400 };
  };

  test('round trips by a few wallets, concentrated - HIGH, with its signals and counter-signals', () => {
    const washers = ['r1', 'r2', 'r3'].map(wallet);
    const trades: WashTrade[] = [];
    for (let i = 0; i < 10; i++) {
      for (const w of washers) {
        trades.push(trade(w, 'BUY', 1_000_000n, 2_000_000_000n, 3));
        trades.push(trade(w, 'SELL', 1_000_000n, 1_990_000_000n, 3));
      }
    }
    trades.push(trade(wallet('r-other1'), 'BUY', 5_000n, 10_000_000n), trade(wallet('r-other2'), 'BUY', 7_000n, 13_000_000n));
    const r = analyzeWash({ trades, unresolved: 0, relatedPairs: new Set(), clusteredWallets: new Set() });
    assert.equal(r.risk, 'HIGH');
    assert.ok(r.familiesTriggered.includes('ROUND_TRIPS') && r.familiesTriggered.includes('CONCENTRATION'));
    assert.ok(r.signals.every((s) => typeof s.text === 'string' && typeof s.threshold === 'number'));
    assert.ok(r.confidence > 0 && r.confidence <= 0.9);
  });

  test('legitimate high volume: many wallets, varied sizes, no round trips - LOW', () => {
    const trades: WashTrade[] = [];
    for (let i = 0; i < 80; i++) {
      trades.push(trade(wallet(`legit-${i % 45}`), i % 3 === 0 ? 'SELL' : 'BUY', BigInt(10_000 + i * 977), BigInt(50_000_000 + i * 13_370_001)));
    }
    const r = analyzeWash({ trades, unresolved: 5, relatedPairs: new Set(), clusteredWallets: new Set() });
    assert.equal(r.risk, 'LOW');
    assert.ok(r.counterSignals.length > 0);
  });

  test('thin or unresolved activity is INSUFFICIENT_DATA, never LOW', () => {
    const few = Array.from({ length: 10 }, (_, i) => trade(wallet(`few-${i}`), 'BUY', 10n, 10n));
    assert.equal(analyzeWash({ trades: few, unresolved: 0, relatedPairs: new Set(), clusteredWallets: new Set() }).risk, 'INSUFFICIENT_DATA');
    const many = Array.from({ length: 40 }, (_, i) => trade(wallet(`unres-${i}`), 'BUY', 10n, 10n));
    assert.equal(analyzeWash({ trades: many, unresolved: 100, relatedPairs: new Set(), clusteredWallets: new Set() }).risk, 'INSUFFICIENT_DATA');
  });
});

describe('activity quality', () => {
  const trades = [
    ...Array.from({ length: 6 }, () => ({ trader: wallet('aq-bot'), quoteAmount: 10n ** 9n })),
    { trader: wallet('aq-human'), quoteAmount: 5n * 10n ** 9n },
    { trader: wallet('aq-sniper'), quoteAmount: 10n ** 8n },
    { trader: wallet('aq-unknown'), quoteAmount: 10n ** 8n },
    { trader: wallet('aq-human-2'), quoteAmount: 3n * 10n ** 8n },
  ];

  test('three views, three denominators: wallets, trades and volume', () => {
    const classes = new Map<string, BuyerClass>([[wallet('aq-bot'), 'AUTOMATED_TRADER'], [wallet('aq-human'), 'LIKELY_ORGANIC'], [wallet('aq-human-2'), 'LIKELY_ORGANIC'], [wallet('aq-sniper'), 'SNIPER']]);
    const q = activityQuality({ trades, classes, clustered: new Set() });
    assert.equal(q.byWallets.total, 5);
    assert.equal(q.byTrades.total, 10);
    assert.equal(q.byVolume.total, 6 * 1e9 + 5e9 + 2e8 + 3e8);
    assert.equal(q.byWallets.counts.unknown, 1, 'unknown stays visible');
    assert.equal(q.byTrades.counts.automated, 6);
    assert.ok(q.byWallets.shares !== null);
  });

  test('weak coverage gives no percentages', () => {
    const q = activityQuality({ trades, classes: new Map([[wallet('aq-sniper'), 'SNIPER']]), clustered: new Set() });
    assert.equal(q.byWallets.shares, null);
    assert.equal(q.byTrades.shares, null);
    assert.equal(q.status, 'INSUFFICIENT_DATA');
  });

  test('four wallets are anecdotes: no shares, however well classified', () => {
    const few = trades.filter((t) => t.trader !== wallet('aq-human-2'));
    const all = new Map<string, BuyerClass>([[wallet('aq-bot'), 'AUTOMATED_TRADER'], [wallet('aq-human'), 'LIKELY_ORGANIC'], [wallet('aq-sniper'), 'SNIPER'], [wallet('aq-unknown'), 'LIKELY_ORGANIC']]);
    const q = activityQuality({ trades: few, classes: all, clustered: new Set() });
    assert.equal(q.byWallets.shares, null);
    assert.equal(q.status, 'INSUFFICIENT_DATA');
    assert.equal(q.byWallets.counts.likely_organic, 2, 'counts are still shown');
  });

  test('clustered wallets are counted as coordinated, whatever their class', () => {
    const q = activityQuality({ trades, classes: new Map([[wallet('aq-human'), 'LIKELY_ORGANIC']]), clustered: new Set([wallet('aq-human')]) });
    assert.equal(q.byWallets.counts.coordinated, 1);
    assert.equal(q.byWallets.counts.likely_organic, 0);
  });
});
