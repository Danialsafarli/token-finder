/**
 * What the Decision Engine reads for one token, and where from.
 *
 * All of it is local: the latest stored deep-intelligence snapshot, the
 * token's stored security events and those of its creator's and network's
 * launches, and the token's recorded market history. No provider is called
 * here, which is what keeps the decision stage cheap enough to run on every
 * token of every scan - deep analysis itself stays on its own bounded loop.
 */

import { normalizeIntelligence, type RawIntelligence, type StoredEventInput } from './contract.ts';
import { decide, applyDecision, type DecisionConfig } from './engine.ts';
import type { MarketObservation } from './momentum.ts';
import type { IntelligenceBundle } from './types.ts';
import type { PreviousVerdict } from './stability.ts';
import type { StoredSecurityEvent, TokenIntelligenceRow } from '../persist/intel-repository.ts';
import type { HolderPoint, MarketPoint } from '../persist/repository.ts';
import type { TokenSnapshot, TokenState } from '../types.ts';

/** The read-only slice of persistence the decision stage uses. */
export interface DecisionSources {
  intel: {
    latestTokenIntelligence(mint: string): TokenIntelligenceRow | null;
    storedEventsOf(mints: string[]): StoredSecurityEvent[];
    launchesOf(address: string): { mint: string; blockTimeMs: number | null }[];
  } | null;
  marketHistory(mint: string, since: number): MarketPoint[];
  holderHistory(mint: string, since: number): HolderPoint[];
  /** The token's current stored verdict, for stability. Absent: every reading stands on its own. */
  previousDecision?(mint: string): PreviousVerdict | null;
}

/** Sources for a context with no database: nothing analysed, no history. */
export const NO_SOURCES: DecisionSources = {
  intel: null,
  marketHistory: () => [],
  holderHistory: () => [],
};

/** Market history reaches back this far for momentum. */
const HISTORY_MS = 24 * 3_600_000;
/** Network targets re-validated per token, at most. */
const MAX_TARGETS = 8;

const toInput = (e: StoredSecurityEvent): StoredEventInput => ({
  id: e.id,
  mint: e.mint,
  type: e.type,
  status: e.status,
  actor: e.actor,
  creatorLinked: e.creatorLinked,
  signature: e.signature,
  blockTimeMs: e.blockTimeMs,
  confidence: e.confidence,
  reasons: e.reasons,
  ruleVersion: e.ruleVersion,
  supersededAt: e.supersededAt,
});

function launchesAndEvents(sources: DecisionSources, address: string): { launches: string[]; events: StoredEventInput[] } {
  const launches = sources.intel?.launchesOf(address).map((l) => l.mint) ?? [];
  return { launches, events: launches.length ? (sources.intel?.storedEventsOf(launches) ?? []).map(toInput) : [] };
}

export function gatherIntelligence(sources: DecisionSources, token: TokenSnapshot, now: number): IntelligenceBundle {
  const intel = sources.intel;
  const row = intel?.latestTokenIntelligence(token.mint) ?? null;
  const raw: RawIntelligence = {
    snapshot: row
      ? {
          analyzedAt: row.analyzedAt,
          activity: row.activity,
          wash: row.wash,
          attribution: row.attribution,
          network: row.network,
          wallets: row.wallets,
          coverage: row.coverage,
          truncation: row.truncation,
          ruleVersions: row.ruleVersions ?? null,
        }
      : null,
    events: (intel?.storedEventsOf([token.mint]) ?? []).map(toInput),
    creator: null,
    networkTargets: new Map(),
  };
  const attribution = row?.attribution as { creator?: unknown } | null | undefined;
  const creator = typeof attribution?.creator === 'string' ? attribution.creator : null;
  if (intel && creator) raw.creator = { address: creator, ...launchesAndEvents(sources, creator) };
  const findings = ((row?.network as { analysis?: { findings?: { target?: unknown }[] } } | null)?.analysis?.findings ?? []).slice(0, MAX_TARGETS);
  for (const f of findings) {
    if (typeof f.target === 'string' && !raw.networkTargets.has(f.target)) raw.networkTargets.set(f.target, launchesAndEvents(sources, f.target));
  }
  return normalizeIntelligence(raw, token, now);
}

/**
 * The token's recorded market history for momentum.
 *
 * Liquidity is only comparable within one pool: when the display pool changes
 * (a pump.fun curve migrating to PumpSwap, or a different best pair), an
 * earlier pool's liquidity says nothing about this one's. Found in the
 * calibration replay: a $2.5M bonding curve followed by a $10K PumpSwap pool
 * read as a 99.6% collapse. So a point recorded on a different known pool
 * keeps its price and loses its liquidity. A point with no recorded pool is
 * kept as it is: it cannot be told apart.
 * @param pool the current snapshot's pool, when known
 */
export function gatherHistory(sources: DecisionSources, mint: string, now: number, pool: string | null = null): MarketObservation[] {
  const since = now - HISTORY_MS;
  const holders = sources.holderHistory(mint, since);
  const byTime = new Map(holders.map((h) => [h.observedAt, h.holderCount]));
  return sources.marketHistory(mint, since).map((p) => ({
    t: p.observedAt,
    price: p.priceUsd,
    liquidity: pool !== null && p.poolAddress !== null && p.poolAddress !== pool ? null : p.liquidityUsd,
    holders: byTime.get(p.observedAt) ?? null,
  }));
}

export interface Decider {
  (snapshot: TokenSnapshot, previousState: TokenState | null): TokenSnapshot;
  /** Wall time spent deciding, for the scan's performance report. */
  readonly stats: { decisions: number; ms: number };
}

/** A function that runs the full decision stage on one freshly screened snapshot. */
export function makeDecider(sources: DecisionSources, config: DecisionConfig, clock: () => number = Date.now): Decider {
  const stats = { decisions: 0, ms: 0 };
  const fn = ((snapshot: TokenSnapshot, previousState: TokenState | null): TokenSnapshot => {
    const started = performance.now();
    try {
      const now = clock();
      const bundle = gatherIntelligence(sources, snapshot, now);
      const history = gatherHistory(sources, snapshot.mint, now, snapshot.pair?.pairAddress ?? null);
      const previous = sources.previousDecision?.(snapshot.mint) ?? null;
      const decision = decide({ snapshot, bundle, history, now, config, previous });
      return applyDecision(snapshot, decision, previousState);
    } finally {
      stats.decisions += 1;
      stats.ms += performance.now() - started;
    }
  }) as Decider;
  Object.defineProperty(fn, 'stats', { value: stats });
  return fn;
}
