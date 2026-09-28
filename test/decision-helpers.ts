/**
 * Builders for decision-engine tests.
 *
 * Every builder produces data in exactly the shape the real pipeline writes:
 * stored intelligence rows as `intel/runner.ts` saves them, events as
 * `intel-repository.ts` returns them, snapshots as `core/analyze.ts` builds
 * them. The engine is then run for real - nothing below it is mocked.
 */

import { snapshot as baseSnapshot } from './persist-helpers.ts';
import { normalizeIntelligence, type RawIntelligence, type StoredEventInput } from '../src/decision/contract.ts';
import { decide, applyDecision, type DecisionInput } from '../src/decision/engine.ts';
import { currentRuleVersions, RULE_VERSIONS } from '../src/decision/versions.ts';
import type { MarketObservation } from '../src/decision/momentum.ts';
import type { Decision, IntelligenceBundle } from '../src/decision/types.ts';
import type { LedgerEntry, TokenSnapshot } from '../src/types.ts';

export const NOW = 1_800_000_000_000;
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const MINT = 'DecisionMint1111111111111111111111111111111';
export const CREATOR = 'Creator11111111111111111111111111111111111';

export const CONFIG = { minCoverageQualify: 0.6, minCoverageWatch: 0.35 };

// --- snapshots ------------------------------------------------------------------

function entry(metric: string, value: LedgerEntry['value'], state: LedgerEntry['state'] = 'MEASURED', source = 'jupiter'): LedgerEntry {
  const measured = state === 'MEASURED' || state === 'CONFLICTED';
  return {
    metric,
    state,
    value: measured ? value : null,
    source: measured ? source : null,
    observedAt: measured ? NOW - 2 * MIN : null,
    freshness: measured ? 'FRESH' : 'UNKNOWN',
    confidence: measured ? 0.9 : 0,
    weight: 0.05,
    notes: [],
    claims: [],
    overridden: [],
  };
}

export interface TokenOptions {
  coverage?: number;
  liquidityUsd?: number;
  holders?: number;
  vetoCodes?: string[];
  rugcheckRisk?: number;
  /** Ledger states to override, e.g. { rugcheckRisk: 'UNAVAILABLE' }. */
  states?: Record<string, LedgerEntry['state']>;
  holderRoles?: { rawTop10Share: number; walletTop10Share: number | null; byRole: Record<string, number>; resolved: number; total: number } | null;
  providerTopPct?: number | null;
}

/** A screened snapshot: what core/analyze.ts hands the decision stage. */
export function token(o: TokenOptions = {}): TokenSnapshot {
  const snap = baseSnapshot({
    mint: MINT,
    at: NOW,
    liquidityUsd: o.liquidityUsd ?? 120_000,
    holders: o.holders ?? 900,
    ...(o.vetoCodes ? { vetoCodes: o.vetoCodes, state: 'REJECTED' as const, eligibility: 'REJECTED' as const } : {}),
  });
  snap.evaluation!.coverage.coverage = o.coverage ?? 0.9;
  snap.evaluation!.coverage.confidence = 0.85;
  const states = o.states ?? {};
  snap.ledger = [
    entry('mintAuthorityRevoked', true, states.mintAuthorityRevoked, 'helius'),
    entry('freezeAuthorityRevoked', true, states.freezeAuthorityRevoked, 'helius'),
    entry('mintExtensions', [], states.mintExtensions, 'helius'),
    entry('rugcheckRisk', o.rugcheckRisk ?? 12, states.rugcheckRisk, 'rugcheck'),
    entry('liquidityUsd', o.liquidityUsd ?? 120_000, states.liquidityUsd, 'dexscreener'),
    entry('topHoldersPct', o.providerTopPct === undefined ? 22 : o.providerTopPct, o.providerTopPct === null ? 'UNKNOWN' : states.topHoldersPct),
  ];
  snap.score.components = [
    { key: 'liquidity', label: 'Liquidity', value: 0.9, weight: 0.18, detail: '', coverage: 1 },
    { key: 'activity', label: 'Activity', value: 0.8, weight: 0.14, detail: '', coverage: 1 },
    { key: 'age', label: 'Age', value: 0.8, weight: 0.08, detail: '', coverage: 1 },
  ];
  snap.onchain!.holderRoles = o.holderRoles === undefined
    ? { holders: [], rawTop10Share: 0.45, walletTop10Share: 0.2, byRole: { BONDING_CURVE: 0, POOL: 0.25, PROGRAM_OWNED: 0, WALLET: 0.2, UNKNOWN: 0 }, resolved: 10, total: 10 }
    : o.holderRoles === null
      ? null
      : { holders: [], ...o.holderRoles, byRole: { BONDING_CURVE: 0, POOL: 0, PROGRAM_OWNED: 0, WALLET: 0, UNKNOWN: 0, ...o.holderRoles.byRole } };
  return snap;
}

// --- stored intelligence --------------------------------------------------------------

type Shares = Partial<Record<'coordinated' | 'sniper' | 'automated' | 'likely_organic' | 'unknown', number>>;

function view(shares: Shares | null, total: number, classified: number) {
  const full = { coordinated: 0, sniper: 0, automated: 0, likely_organic: 0, unknown: 0, ...(shares ?? {}) };
  return {
    counts: Object.fromEntries(Object.entries(full).map(([k, v]) => [k, Math.round(v * total)])),
    shares: shares ? full : null,
    total,
    coverage: classified,
  };
}

export interface IntelOptions {
  /** Composition by trades and volume; by wallets uses `walletShares` or the same. */
  shares?: Shares | null;
  walletShares?: Shares | null;
  wallets?: number;
  trades?: number;
  classified?: number;
  representativeness?: number;
  market?: Record<string, unknown> | null;
  wash?: { risk: string; confidence?: number; coverage?: number; families?: string[]; roundTrip?: number; trades?: number } | null;
  clusters?: { level: string; size: number; confidence: number }[];
  attribution?: { status: 'ATTRIBUTED' | 'AMBIGUOUS' | 'UNKNOWN'; confidence: number } | null;
  network?: { level: string; findings?: { target: string; pathConfidence: number; hops?: number }[]; weak?: number } | null;
  mintHistory?: 'COMPLETE' | 'PARTIAL' | 'NONE';
  analyzedAt?: number;
  ruleVersions?: Record<string, string> | null;
  truncation?: string[];
}

export function intelRow(o: IntelOptions = {}): NonNullable<RawIntelligence['snapshot']> {
  const wallets = o.wallets ?? 25;
  const trades = o.trades ?? 140;
  const classified = o.classified ?? 0.9;
  const shares = o.shares === undefined ? { likely_organic: 0.8, automated: 0.1, unknown: 0.1 } : o.shares;
  const walletShares = o.walletShares === undefined ? shares : o.walletShares;
  const market =
    o.market !== undefined
      ? o.market
      : {
          pools: [{ address: 'PoolAddr1111111111111111111111111111111111', dexId: 'raydium', quoteSymbol: 'SOL', observedTrades: trades, reportedTrades24h: 400, volumeShare: 1 }],
          knownPools: 1,
          observedPools: 1,
          venueShare: 1,
          windowMs: 90 * MIN,
          observedTrades: trades,
          expectedTrades: trades,
          sampleShare: 1,
          representativeness: o.representativeness ?? 1,
          volumeQuote: 'So11111111111111111111111111111111111111112',
          excludedFromVolume: 0,
          note: 'test market',
        };
  const wash = o.wash === undefined ? { risk: 'LOW', confidence: 0.6, coverage: 0.9, families: [] as string[] } : o.wash;
  const attribution = o.attribution === undefined ? { status: 'ATTRIBUTED' as const, confidence: 0.85 } : o.attribution;
  const network = o.network === undefined ? { level: 'NONE' } : o.network;
  return {
    analyzedAt: o.analyzedAt ?? NOW - 10 * MIN,
    activity: {
      status: shares ? 'MEASURED' : 'INSUFFICIENT_DATA',
      byWallets: view(walletShares, wallets, classified),
      byTrades: view(shares, trades, classified),
      byVolume: view(shares, trades * 1000, classified),
      note: '',
      market,
    },
    wash: wash
      ? {
          risk: wash.risk,
          confidence: wash.confidence ?? 0.6,
          coverage: wash.coverage ?? 0.9,
          status: 'test',
          signals: [
            { family: 'ROUND_TRIPS', code: 'ROUND_TRIP_VOLUME', value: wash.roundTrip ?? 0.02, threshold: 0.2, triggered: (wash.families ?? []).includes('ROUND_TRIPS'), text: `round trips ${Math.round((wash.roundTrip ?? 0.02) * 100)}% of volume` },
            { family: 'CONCENTRATION', code: 'TOP3_VOLUME', value: 0.3, threshold: 0.6, triggered: (wash.families ?? []).includes('CONCENTRATION'), text: '3 wallets made 30% of the volume' },
          ],
          counterSignals: ['order sizes vary'],
          familiesTriggered: wash.families ?? [],
          sample: { trades: wash.trades ?? trades, wallets, unresolvedShare: 0.1 },
        }
      : { risk: 'INSUFFICIENT_DATA', confidence: 0, coverage: 0, status: 'too few', signals: [], counterSignals: [], familiesTriggered: [], sample: { trades: 5, wallets: 2, unresolvedShare: 0 } },
    attribution: attribution
      ? { mint: MINT, status: attribution.status, creator: attribution.status === 'ATTRIBUTED' ? CREATOR : null, confidence: attribution.confidence, basis: 'test attribution', deployers: attribution.status === 'AMBIGUOUS' ? [CREATOR, 'Other11111111111111111111111111111111111111'] : [CREATOR], signature: 'CreationSig' }
      : { mint: MINT, status: 'UNKNOWN', creator: null, confidence: 0, basis: 'not located', deployers: [] },
    network: {
      analysis: network
        ? {
            level: network.level,
            confidence: 0.5,
            findings: (network.findings ?? []).map((f) => ({
              target: f.target,
              path: Array.from({ length: f.hops ?? 1 }, (_, i) => ({ from: i === 0 ? CREATOR : `Hop${i}`, to: i === (f.hops ?? 1) - 1 ? f.target : `Hop${i + 1}`, type: 'FUNDED', confidence: f.pathConfidence, evidence: `sig-${i}` })),
              pathConfidence: f.pathConfidence,
              confirmed: 1,
              stronglySuspected: 0,
              events: [],
            })),
            weakAssociations: Array.from({ length: network.weak ?? 0 }, () => ({})),
            reasons: ['test network'],
          }
        : { level: 'INSUFFICIENT_DATA', confidence: 0, findings: [], weakAssociations: [], reasons: [] },
      creator: null,
      security: [],
      clusters: (o.clusters ?? []).map((c, i) => ({ id: `cluster-${i}`, level: c.level, size: c.size, confidence: c.confidence, reasons: ['test cluster'], members: [] })),
      weakPairs: 0,
      stages: {},
      mintHistory: o.mintHistory ?? 'COMPLETE',
    },
    wallets: Array.from({ length: 12 }, (_, i) => ({ wallet: `W${i}`, roles: ['early'], status: 'ANALYZED', classification: i < 9 ? 'LIKELY_ORGANIC' : 'UNKNOWN', confidence: 0.65, coverage: 0.8, signals: [], counterSignals: [], funding: null, truncation: [] })),
    coverage: 0.9,
    truncation: o.truncation ?? [],
    ruleVersions: o.ruleVersions === undefined ? currentRuleVersions() : o.ruleVersions,
  };
}

let seq = 0;
export function event(o: Partial<StoredEventInput> & { type: string; status: string }): StoredEventInput {
  seq += 1;
  return {
    id: o.id ?? `evt-${seq}`,
    mint: o.mint ?? MINT,
    type: o.type,
    status: o.status,
    actor: o.actor ?? CREATOR,
    creatorLinked: o.creatorLinked ?? true,
    signature: o.signature ?? `Sig${seq}`,
    blockTimeMs: o.blockTimeMs ?? NOW - HOUR,
    confidence: o.confidence ?? (o.status === 'CONFIRMED' ? 0.95 : o.status === 'STRONGLY_SUSPECTED' ? 0.75 : 0.5),
    reasons: o.reasons ?? [`${o.type} for the test`],
    ruleVersion: o.ruleVersion === undefined ? RULE_VERSIONS.security : o.ruleVersion,
    supersededAt: o.supersededAt ?? null,
  };
}

export interface BundleOptions extends IntelOptions {
  analysed?: boolean;
  events?: StoredEventInput[];
  creatorLaunches?: string[];
  creatorEvents?: StoredEventInput[];
  targets?: Record<string, { launches: string[]; events: StoredEventInput[] }>;
}

export function bundle(t: TokenSnapshot, o: BundleOptions = {}): IntelligenceBundle {
  const raw: RawIntelligence = {
    snapshot: o.analysed === false ? null : intelRow(o),
    events: o.events ?? [],
    creator: o.analysed === false || o.attribution === null || o.attribution?.status === 'AMBIGUOUS' ? null : { address: CREATOR, launches: o.creatorLaunches ?? [MINT, 'OtherLaunch1', 'OtherLaunch2'], events: o.creatorEvents ?? [] },
    networkTargets: new Map(Object.entries(o.targets ?? {})),
  };
  return normalizeIntelligence(raw, t, NOW);
}

// --- market history --------------------------------------------------------------------

/** Observations every `stepMin` minutes over `spanMin`, from price(i). */
export function history(spanMin: number, stepMin: number, price: (i: number, n: number) => number, liquidity = 120_000): MarketObservation[] {
  const n = Math.floor(spanMin / stepMin);
  const out: MarketObservation[] = [];
  // The current observation (at NOW) is added by the engine from the snapshot.
  for (let i = 0; i < n; i++) out.push({ t: NOW - (n - i) * stepMin * MIN, price: price(i, n), liquidity, holders: 800 + i * 5 });
  return out;
}

export const steadyRise = (spanMin = 150, step = 15): MarketObservation[] => history(spanMin, step, (i) => 0.4 * Math.pow(1.02, i));

// --- the engine ------------------------------------------------------------------------------

export function run(t: TokenSnapshot, b: IntelligenceBundle, h: MarketObservation[] = steadyRise()): { decision: Decision; snapshot: TokenSnapshot } {
  // The snapshot's own price closes the observed series.
  const last = h.at(-1);
  if (last && last.price !== null) t.priceUsd = last.price * 1.02;
  const input: DecisionInput = { snapshot: t, bundle: b, history: h, now: NOW, config: CONFIG };
  const decision = decide(input);
  return { decision, snapshot: applyDecision(t, decision, null) };
}
