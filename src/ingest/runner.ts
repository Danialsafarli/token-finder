/**
 * The ingestion cycle: on-chain launch discovery, then deep collection for the
 * scan's survivors.
 *
 * ## One cycle
 *
 * 1. **Launches.** Signatures referencing pump.fun's mint-authority PDA since
 *    the last cursor are exactly its creations. Up to `launchTxPerCycle` of
 *    them, newest first, are fetched and read into `token_launches`, a
 *    POOL_CREATED event and the supply/authority facts.
 * 2. **Survivors.** `budget.ts` picks which surviving tokens' pools to
 *    collect. For each, the pool's new signatures since its cursor are
 *    fetched - up to `txPerToken`, newest first - and each transaction is
 *    read into pool activity, transfer edges and chain events.
 *
 * ## What is never lost silently
 *
 * Collection is bounded, so some history is not collected: launches beyond
 * the budget, a busy pool's older trades, history from before a cursor
 * existed, a transaction whose fetch failed. Every one of those is a row in
 * `ingest_gaps` with its reason and, where known, its slot range and count.
 * The cursor then moves past it, so the next cycle continues from the present
 * rather than falling ever further behind a pool it cannot keep up with.
 * History with a stated hole is usable; history with an unstated one is not.
 *
 * ## Failure isolation
 *
 * Nothing here throws into the server. A cycle that fails reports FAILED, a
 * cycle where some calls failed reports PARTIAL, and a collector that has not
 * completed a cycle for three intervals reports STALE. The scanner does not
 * depend on any of this: a dead RPC endpoint stops collection, not scanning.
 */

import { log } from '../util/logger.ts';
import { classifyFailure, type ProviderFailure } from '../util/failure.ts';
import { poolSettled, type ProviderResult } from '../util/http.ts';
import type { ChainRepository } from '../persist/chain-repository.ts';
import type { TokenSnapshot } from '../types.ts';
import type { SignatureInfo } from '../sources/solana-rpc.ts';
import { PUMPFUN_MINT_AUTHORITY } from '../chain/programs.ts';
import { normalizeTransaction } from './normalize.ts';
import { derivePoolActivity, type ActivityKind } from './activity.ts';
import { parsePumpfunLaunch } from './launch.ts';
import { mintEvents, onCurve, poolCreatedEvent, transferEdges } from './derive.ts';
import { planDeepCollection, type DeepPlan } from './budget.ts';

export interface RpcPort {
  getSignatures(address: string, options: { limit: number; until?: string }): Promise<ProviderResult<SignatureInfo[]>>;
  getParsedTransaction(signature: string): Promise<ProviderResult<unknown>>;
}

export interface IngestSettings {
  tokensPerCycle: number;
  txPerToken: number;
  launchDiscovery: boolean;
  launchTxPerCycle: number;
  liveWindowMs: number;
}

export interface IngestDeps {
  rpc: RpcPort;
  chain: ChainRepository | null;
  tokens: () => TokenSnapshot[];
  /** Provenance label for every row, e.g. `solana-rpc:public`. */
  source: string;
  commitment: string;
  settings: IngestSettings;
  now?: () => number;
}

export type IngestHealthState = 'AVAILABLE' | 'PARTIAL' | 'STALE' | 'UNAVAILABLE' | 'FAILED';

export interface IngestHealth {
  state: IngestHealthState;
  reason: string;
}

interface Collected {
  signaturesSeen: number;
  failedSkipped: number;
  alreadyKnown: number;
  fetched: number;
  fetchFailed: number;
  skippedOverBudget: number;
}

export interface LaunchReport extends Collected {
  recorded: number;
  notLaunch: number;
}

export interface PoolReport extends Collected {
  mint: string;
  pool: string;
  tier: 'QUALIFIED' | 'WATCH';
  firstCollection: boolean;
  byKind: Partial<Record<ActivityKind, number>>;
  edges: number;
  events: number;
  error: string | null;
}

export interface CycleReport {
  at: number;
  finishedAt: number;
  durationMs: number;
  source: string;
  launches: LaunchReport | null;
  deep: { skipped: DeepPlan['skipped']; pools: PoolReport[] };
  rpc: { calls: number; failures: number; rateLimited: number };
  failures: ProviderFailure[];
  health: IngestHealth;
}

const LAUNCH_KEY = 'launch:pumpfun';
/**
 * Transactions fetched at once. The http layer still spaces requests to the
 * host's rate limit; concurrency only stops one slow response from idling the
 * budget behind it.
 */
const FETCH_CONCURRENCY = 3;
const poolKey = (pool: string): string => `pool:${pool}`;
const PAGE = 1000;

function emptyCollected(): Collected {
  return { signaturesSeen: 0, failedSkipped: 0, alreadyKnown: 0, fetched: 0, fetchFailed: 0, skippedOverBudget: 0 };
}

/**
 * Splits a newest-first page into what to fetch now and what the budget
 * leaves behind, recording the gaps. Failed transactions are not fetched:
 * they moved nothing, and the budget is better spent on ones that did.
 */
function select(
  chain: ChainRepository,
  key: string,
  page: SignatureInfo[],
  hadCursor: boolean,
  budget: number,
  report: Collected,
  now: number,
): SignatureInfo[] {
  report.signaturesSeen += page.length;
  const succeeded = page.filter((s) => !s.failed);
  report.failedSkipped += page.length - succeeded.length;
  const known = chain.knownSignatures(succeeded.map((s) => s.signature));
  report.alreadyKnown += known.size;
  const fresh = succeeded.filter((s) => !known.has(s.signature));
  const chosen = fresh.slice(0, Math.max(0, budget));
  const left = fresh.slice(chosen.length);
  report.skippedOverBudget += left.length;

  if (left.length > 0) {
    chain.recordGap(
      key,
      {
        fromSlot: left[left.length - 1]?.slot ?? null,
        toSlot: left[0]?.slot ?? null,
        skipped: left.length,
        reason: hadCursor ? 'over_budget' : 'before_collection_began',
      },
      now,
    );
  }
  if (hadCursor && page.length >= PAGE) {
    // A full page means the stretch between the cursor and the oldest
    // signature returned may hold more that was never listed.
    chain.recordGap(key, { fromSlot: null, toSlot: page[page.length - 1]?.slot ?? null, skipped: null, reason: 'page_limit' }, now);
  }
  return chosen;
}

/** Runs one cycle. Never throws. */
export async function runIngestionCycle(deps: IngestDeps): Promise<CycleReport> {
  const now = deps.now ?? Date.now;
  const at = now();
  const rpcStats = { calls: 0, failures: 0, rateLimited: 0 };
  const failures: ProviderFailure[] = [];

  const track = async <T>(call: Promise<ProviderResult<T>>): Promise<ProviderResult<T>> => {
    rpcStats.calls += 1;
    try {
      const result = await call;
      if (result.failure !== null) {
        rpcStats.failures += 1;
        if (result.failure.kind === 'RATE_LIMITED') rpcStats.rateLimited += 1;
        if (failures.length < 20) failures.push(result.failure);
      }
      return result;
    } catch (error) {
      // An adapter is not supposed to throw; if one does, it is a failure of
      // this call, not of the cycle.
      rpcStats.failures += 1;
      const failure = classifyFailure('solana-rpc', error);
      if (failures.length < 20) failures.push(failure);
      return { data: null, failure };
    }
  };

  const report: CycleReport = {
    at,
    finishedAt: at,
    durationMs: 0,
    source: deps.source,
    launches: null,
    deep: { skipped: { notSurvivor: 0, notLive: 0, noPool: 0, overBudget: 0 }, pools: [] },
    rpc: rpcStats,
    failures,
    health: { state: 'AVAILABLE', reason: '' },
  };

  const chain = deps.chain;
  if (chain === null) {
    report.health = { state: 'UNAVAILABLE', reason: 'the history database is not open, so nothing can be collected' };
    return finish(report, now);
  }

  const fetchInto = async (
    signature: string,
    stats: Collected,
  ): Promise<ReturnType<typeof normalizeTransaction>> => {
    const result = await track(deps.rpc.getParsedTransaction(signature));
    if (result.failure !== null || result.data === null) {
      stats.fetchFailed += 1;
      return null;
    }
    const tx = normalizeTransaction(result.data);
    if (tx === null) stats.fetchFailed += 1;
    else stats.fetched += 1;
    return tx;
  };

  // --- 1. launches ---------------------------------------------------------
  if (deps.settings.launchDiscovery) {
    const launches: LaunchReport = { ...emptyCollected(), recorded: 0, notLaunch: 0 };
    report.launches = launches;
    try {
      const cursor = chain.cursor(LAUNCH_KEY);
      const page = await track(
        deps.rpc.getSignatures(PUMPFUN_MINT_AUTHORITY, { limit: PAGE, ...(cursor ? { until: cursor.signature } : {}) }),
      );
      if (page.data !== null && page.data.length > 0) {
        const chosen = select(chain, LAUNCH_KEY, page.data, cursor !== null, deps.settings.launchTxPerCycle, launches, at);
        const missed: SignatureInfo[] = [];
        const fetchedLaunches = await poolSettled(chosen, FETCH_CONCURRENCY, (sig) => fetchInto(sig.signature, launches));
        for (const [i, sig] of chosen.entries()) {
          const settled = fetchedLaunches[i];
          const tx = settled?.status === 'fulfilled' ? settled.value : null;
          if (tx === null) {
            missed.push(sig);
            continue;
          }
          const launch = parsePumpfunLaunch(tx);
          if (typeof launch === 'string') {
            launches.notLaunch += 1;
            chain.saveIngested({ tx, txIndex: sig.transactionIndex, activity: [], edges: [], events: [], wallets: [], source: deps.source, commitment: deps.commitment });
            continue;
          }
          const created = poolCreatedEvent(launch, deps.source);
          chain.saveIngested({
            tx,
            txIndex: sig.transactionIndex,
            activity: [],
            edges: [],
            events: [...(created ? [created] : []), ...mintEvents(tx, launch.mint, deps.source)],
            wallets: [{ address: launch.feePayer, onCurve: onCurve(launch.feePayer) }],
            source: deps.source,
            commitment: deps.commitment,
          });
          if (chain.saveLaunch(launch, deps.source, now())) {
            launches.recorded += 1;
            chain.recordDiscoveries([{ mint: launch.mint, source: 'chain:pumpfun' }], now());
          }
        }
        if (missed.length > 0) {
          chain.recordGap(LAUNCH_KEY, { fromSlot: missed[missed.length - 1]?.slot ?? null, toSlot: missed[0]?.slot ?? null, skipped: missed.length, reason: 'fetch_failed' }, at);
        }
        const newest = page.data[0] as SignatureInfo;
        chain.advanceCursor(LAUNCH_KEY, newest.signature, newest.slot, now());
      }
    } catch (error) {
      failures.push(classifyFailure('ingest', error));
      log.warn(`launch discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // --- 2. survivors ------------------------------------------------------------
  let plan: DeepPlan;
  try {
    plan = planDeepCollection({
      tokens: deps.tokens(),
      lastCollectedAt: (pool) => chain.cursor(poolKey(pool))?.updatedAt ?? null,
      launchPool: (mint) => chain.launch(mint)?.pool ?? null,
      tokensPerCycle: deps.settings.tokensPerCycle,
      liveWindowMs: deps.settings.liveWindowMs,
      now: at,
    });
  } catch (error) {
    failures.push(classifyFailure('ingest', error));
    plan = { work: [], skipped: { notSurvivor: 0, notLive: 0, noPool: 0, overBudget: 0 } };
  }
  report.deep.skipped = plan.skipped;

  for (const work of plan.work) {
    const key = poolKey(work.pool);
    const pool: PoolReport = { ...emptyCollected(), ...work, firstCollection: false, byKind: {}, edges: 0, events: 0, error: null };
    report.deep.pools.push(pool);
    try {
      const cursor = chain.cursor(key);
      pool.firstCollection = cursor === null;
      // With no cursor only the newest few are wanted, so only they are listed.
      const limit = cursor === null ? deps.settings.txPerToken : PAGE;
      const page = await track(deps.rpc.getSignatures(work.pool, { limit, ...(cursor ? { until: cursor.signature } : {}) }));
      if (page.failure !== null || page.data === null) {
        pool.error = page.failure?.kind ?? 'no data';
        continue;
      }
      if (page.data.length === 0) {
        if (cursor !== null) chain.advanceCursor(key, cursor.signature, cursor.slot, now());
        continue;
      }
      if (cursor === null) {
        // Nothing before this moment is being reconstructed. Say so once.
        chain.recordGap(key, { fromSlot: null, toSlot: page.data[page.data.length - 1]?.slot ?? null, skipped: null, reason: 'before_collection_began' }, at);
      }
      const chosen = select(chain, key, page.data, cursor !== null, deps.settings.txPerToken, pool, at);
      const missed: SignatureInfo[] = [];
      const fetchedTxs = await poolSettled(chosen, FETCH_CONCURRENCY, (sig) => fetchInto(sig.signature, pool));
      for (const [i, sig] of chosen.entries()) {
        const settled = fetchedTxs[i];
        const tx = settled?.status === 'fulfilled' ? settled.value : null;
        if (tx === null) {
          missed.push(sig);
          continue;
        }
        const activity = derivePoolActivity(tx, work.mint, work.pool);
        pool.byKind[activity.kind] = (pool.byKind[activity.kind] ?? 0) + 1;
        const excluded = new Set([work.pool, ...(activity.poolSide ? [activity.poolSide] : [])]);
        const edges = transferEdges(tx, work.mint, excluded);
        const events = mintEvents(tx, work.mint, deps.source);
        const written = chain.saveIngested(
          {
            tx,
            txIndex: sig.transactionIndex,
            activity: [activity],
            edges,
            events,
            wallets: activity.trader === null ? [] : [{ address: activity.trader, onCurve: onCurve(activity.trader) }],
            source: deps.source,
            commitment: deps.commitment,
          },
          now(),
        );
        pool.edges += written.edgesInserted;
        pool.events += written.eventsInserted;
      }
      if (missed.length > 0) {
        chain.recordGap(key, { fromSlot: missed[missed.length - 1]?.slot ?? null, toSlot: missed[0]?.slot ?? null, skipped: missed.length, reason: 'fetch_failed' }, at);
      }
      const newest = page.data[0] as SignatureInfo;
      chain.advanceCursor(key, newest.signature, newest.slot, now());
    } catch (error) {
      pool.error = error instanceof Error ? error.message.slice(0, 160) : String(error);
      failures.push(classifyFailure('ingest', error));
    }
  }

  // --- health -------------------------------------------------------------------
  const fetchFailed = (report.launches?.fetchFailed ?? 0) + report.deep.pools.reduce((s, p) => s + p.fetchFailed, 0);
  if (rpcStats.calls > 0 && rpcStats.failures === rpcStats.calls) {
    report.health = { state: 'FAILED', reason: `every RPC call failed (${failures[0]?.kind ?? 'unknown'})` };
  } else if (rpcStats.failures > 0 || fetchFailed > 0 || report.deep.pools.some((p) => p.error !== null)) {
    report.health = {
      state: 'PARTIAL',
      reason: `${rpcStats.failures} of ${rpcStats.calls} RPC calls failed${rpcStats.rateLimited ? `, ${rpcStats.rateLimited} rate-limited` : ''}; what was missed is recorded as gaps`,
    };
  } else {
    report.health = { state: 'AVAILABLE', reason: `${rpcStats.calls} RPC calls, none failed` };
  }
  return finish(report, now);
}

function finish(report: CycleReport, now: () => number): CycleReport {
  report.finishedAt = now();
  report.durationMs = report.finishedAt - report.at;
  return report;
}

// ---------------------------------------------------------------------------
// The loop, and what it reports
// ---------------------------------------------------------------------------

export interface IngestionStatus {
  enabled: boolean;
  running: boolean;
  source: string;
  intervalSec: number;
  cycles: number;
  lastCycle: CycleReport | null;
  lastSuccessAt: number | null;
  health: IngestHealth;
}

let lastCycle: CycleReport | null = null;
let lastSuccessAt: number | null = null;
let cycles = 0;
let running = false;
let loopConfig: { enabled: boolean; source: string; intervalSec: number } = { enabled: false, source: '', intervalSec: 60 };

/** What the collector is doing and whether it is healthy, for the System surface. */
export function ingestionStatus(now: number = Date.now()): IngestionStatus {
  let health: IngestHealth;
  if (!loopConfig.enabled) health = { state: 'UNAVAILABLE', reason: 'on-chain collection is switched off (INGEST_ENABLED=false) or not started' };
  else if (lastCycle === null) health = { state: 'UNAVAILABLE', reason: 'no collection cycle has completed yet' };
  else if (lastSuccessAt !== null && now - lastSuccessAt > 3 * loopConfig.intervalSec * 1000 + lastCycle.durationMs + 60_000) {
    health = { state: 'STALE', reason: `no successful cycle since ${new Date(lastSuccessAt).toISOString()}` };
  } else health = lastCycle.health;
  return {
    enabled: loopConfig.enabled,
    running,
    source: loopConfig.source,
    intervalSec: loopConfig.intervalSec,
    cycles,
    lastCycle,
    lastSuccessAt,
    health,
  };
}

/**
 * Runs cycles forever, each `intervalSec` after the previous one finished, so
 * a slow cycle delays the next rather than overlapping it.
 */
export function startIngestion(deps: IngestDeps, intervalSec: number, onCycle?: (report: CycleReport) => void): { stop: () => void } {
  loopConfig = { enabled: true, source: deps.source, intervalSec };
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    running = true;
    try {
      const result = await runIngestionCycle(deps);
      lastCycle = result;
      cycles += 1;
      if (result.health.state === 'AVAILABLE' || result.health.state === 'PARTIAL') lastSuccessAt = result.finishedAt;
      onCycle?.(result);
    } catch (error) {
      // runIngestionCycle does not throw; this is the backstop that keeps the
      // loop alive if that ever changes.
      log.error(`ingestion cycle failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalSec * 1000);
  };

  // A first cycle shortly after start, so a restart does not wait a full interval.
  timer = setTimeout(() => void tick(), 5_000);
  return {
    stop: () => {
      stopped = true;
      loopConfig = { ...loopConfig, enabled: false };
      if (timer) clearTimeout(timer);
    },
  };
}

/** Records the outcome of a cycle run outside the loop (the CLI), so status reflects it. */
export function noteCycle(report: CycleReport, source: string, intervalSec: number): void {
  lastCycle = report;
  cycles += 1;
  loopConfig = { enabled: true, source, intervalSec };
  if (report.health.state === 'AVAILABLE' || report.health.state === 'PARTIAL') lastSuccessAt = report.finishedAt;
}
