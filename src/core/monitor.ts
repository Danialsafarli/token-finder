import { EventEmitter } from 'node:events';
import { config } from '../config.ts';
import { log } from '../util/logger.ts';
import { fmtUsd } from '../util/num.ts';
import { discover } from './discover.ts';
import { analyze, type TokenFailure } from './analyze.ts';
import type { ProviderFailure } from '../util/failure.ts';
import { store } from './store.ts';
import { rankKey, VERDICT_TIER } from './ranking.ts';
import { makeDecider } from '../decision/inputs.ts';
import type { MonitorEvent, RiskLevel, TokenSnapshot, TokenState } from '../types.ts';

const TIER = VERDICT_TIER as Record<string, number>;

/** Emits "event" (MonitorEvent) and "scan" (ScanResult); the server relays both over SSE. */
export const bus = new EventEmitter();

/**
 * Where a scan's time and writes went. Measured, never estimated: each figure
 * is wall time around the stage or a count of what it did.
 */
export interface ScanTimings {
  discoverMs: number;
  /** Market fetch, safety providers, evidence, fast gate - and the decision stage inside it. */
  analyzeMs: number;
  /** The decision stage alone: reading stored intelligence and history, deciding. */
  decisionMs: number;
  decisions: number;
  persistMs: number;
  /** Snapshot rows appended (a token whose change was not material writes only its current row). */
  historyRows: number;
  transitions: number;
  rssMb: number;
  rssDeltaMb: number;
}

export interface ScanResult {
  at: number;
  durationMs: number;
  candidates: number;
  analyzed: number;
  fresh: number;
  events: MonitorEvent[];
  /** Tokens whose analysis failed, with the reason. The scan still completed. */
  tokenFailures: TokenFailure[];
  /** Providers that failed batch-wide, with the reason. */
  providerFailures: ProviderFailure[];
  top: TokenSnapshot[];
  timings?: ScanTimings;
}

let scanning = false;

/** The most recent completed scan, for the System surface. Null until one finishes. */
let lastScan: ScanResult | null = null;

export function lastScanResult(): ScanResult | null {
  return lastScan;
}

function emit(
  kind: MonitorEvent['kind'],
  snapshot: TokenSnapshot,
  level: RiskLevel,
  message: string,
  data?: Record<string, unknown>,
): MonitorEvent {
  const event = store.addEvent({
    kind,
    mint: snapshot.mint,
    symbol: snapshot.symbol,
    level,
    message,
    data,
  });
  bus.emit('event', event);
  return event;
}

/**
 * Compares a fresh snapshot against the stored one and raises events for the
 * changes worth waking someone up for.
 */
function diff(next: TokenSnapshot, previous: TokenSnapshot | null): MonitorEvent[] {
  const events: MonitorEvent[] = [];

  if (previous === null) {
    const score = next.score.total;
    const eligibility = next.evaluation?.eligibility;

    // A rejected token is never an alert, however well it scores on whatever
    // the gate did not veto. This is the case a penalty multiplier cannot hold.
    if (eligibility === 'REJECTED') {
      const veto = next.evaluation?.vetoes[0];
      events.push(
        emit('risk_flag', next, 'critical', `${next.symbol} rejected: ${veto?.reason ?? 'failed the safety gate'}`, {
          code: veto?.code ?? 'REJECTED',
          vetoes: next.evaluation?.vetoes.map((v) => v.code) ?? [],
        }),
      );
      return events;
    }

    // Everything new would drown the feed, so only surface the plausible ones.
    // An alert additionally requires enough evidence to stand behind: a score
    // assembled from a third of the inputs is not a finding worth waking on.
    const wellEvidenced = next.score.coverage >= config.minCoverageAlert;
    if (eligibility === 'HIGH_POTENTIAL') {
      events.push(
        emit('discovered', next, 'medium', `New token ${next.symbol} assessed High potential: ${next.decision?.basis ?? ''}.`, {
          rank: next.decision?.rankScore ?? null,
        }),
      );
    } else if (score >= config.minScoreAlert && wellEvidenced && eligibility === 'QUALIFIED') {
      events.push(
        emit('discovered', next, 'medium', `New token ${next.symbol} scored ${score} (${next.score.grade}).`, {
          score,
          coverage: next.score.coverage,
        }),
      );
      // A high score on thin evidence still gets tracked at info level rather
      // than dropped, so it is visible without being alerted on.
    } else if (score >= config.minScoreAlert - 20) {
      events.push(emit('discovered', next, 'info', `Tracking ${next.symbol} at ${score} (${next.score.grade}).`, { score }));
    }
    return events;
  }

  const scoreDelta = next.score.total - previous.score.total;
  if (scoreDelta >= 8) {
    events.push(
      emit('score_up', next, 'info', `${next.symbol} score ${previous.score.total} -> ${next.score.total}.`, {
        delta: scoreDelta,
      }),
    );
  } else if (scoreDelta <= -8) {
    events.push(
      emit('score_down', next, 'medium', `${next.symbol} score ${previous.score.total} -> ${next.score.total}.`, {
        delta: scoreDelta,
      }),
    );
  }

  // A liquidity collapse is the clearest on-chain signature of a rug. Both
  // readings must be measured: a provider dropping out looks identical to a
  // drain if null is read as zero, and would fire a false critical alert.
  if (
    previous.liquidityUsd !== null &&
    next.liquidityUsd !== null &&
    previous.liquidityUsd >= 5_000 &&
    next.liquidityUsd < previous.liquidityUsd * 0.6
  ) {
    const pct = (1 - next.liquidityUsd / previous.liquidityUsd) * 100;
    events.push(
      emit(
        'liquidity_drop',
        next,
        pct >= 80 ? 'critical' : 'high',
        `${next.symbol} liquidity fell ${pct.toFixed(0)}% to ${fmtUsd(next.liquidityUsd)}.`,
        { pct, from: previous.liquidityUsd, to: next.liquidityUsd },
      ),
    );
  }

  if (previous.priceUsd !== null && next.priceUsd !== null && previous.priceUsd > 0) {
    const move = (next.priceUsd / previous.priceUsd - 1) * 100;
    if (Math.abs(move) >= 30) {
      events.push(
        emit('price_spike', next, move > 0 ? 'info' : 'medium', `${next.symbol} price moved ${move.toFixed(0)}% since last scan.`, {
          move,
        }),
      );
    }
  }

  const wasState = previous.evaluation?.state;
  const nowState = next.evaluation?.state;
  if (wasState !== undefined && nowState !== undefined && wasState !== nowState) {
    // Only real verdict changes are announced, each with what decided it.
    const rejected = nowState === 'REJECTED';
    const risky = nowState === 'HIGH_RISK';
    const up = (TIER[nowState] ?? 9) < (TIER[wasState] ?? 9);
    const why = rejected
      ? next.evaluation?.vetoes[0]?.reason ?? 'failed the safety gate'
      : next.decision?.basis ?? '';
    events.push(
      emit(
        rejected || risky ? 'risk_flag' : up ? 'score_up' : 'score_down',
        next,
        rejected ? 'critical' : risky ? 'high' : nowState === 'HIGH_POTENTIAL' ? 'medium' : 'info',
        `${next.symbol} moved ${wasState} -> ${nowState}${why ? `: ${why}` : ''}.`,
        { from: wasState, to: nowState, policy: next.decision?.policyVersion ?? null },
      ),
    );
  }

  const before = new Set(previous.score.flags.map((flag) => flag.code));
  for (const flag of next.score.flags) {
    if (before.has(flag.code)) continue;
    if (flag.level !== 'critical' && flag.level !== 'high') continue;
    events.push(emit('risk_flag', next, flag.level, `${next.symbol}: ${flag.message}`, { code: flag.code }));
  }

  return events;
}

/** One full discover -> analyze -> score -> persist cycle. */
export async function runScan(): Promise<ScanResult> {
  if (scanning) throw new Error('a scan is already running');
  scanning = true;

  const started = Date.now();
  // Opens a scan row so every snapshot written below is attributable to this
  // batch. Degrades to a null scan id when persistence is unavailable.
  store.beginScan(started);
  // Announced immediately, so a watching dashboard shows "scanning" now rather
  // than on its next status poll.
  bus.emit('scan-start', { at: started });
  // Real progress, for anyone watching: which stage the scan is in and, while
  // verdicts are built, how many of how many. Counts, never an estimate.
  const stage = (payload: Record<string, unknown>): void => {
    bus.emit('scan-stage', { ...payload, at: Date.now() });
  };
  let completed = false;
  const rssBefore = process.memoryUsage().rss;
  try {
    stage({ stage: 'discover' });
    // Launches the data backbone read from the chain join the feeds. Reading
    // them is a local query: collection happens in its own loop.
    const chain = store.chain();
    const chainLaunches =
      chain === null || config.chainCandidateMax <= 0
        ? []
        : chain.recentLaunches(started - config.chainCandidateWindowMin * 60_000, config.chainCandidateMax);
    const candidates = await discover({ chainLaunches });
    // Provenance: which source surfaced which mint, first and last. Recorded
    // for every candidate, analysed or not, because "who saw it first" is a
    // question about discovery, not about the verdict.
    try {
      chain?.recordDiscoveries(
        candidates.flatMap((c) => c.sources.map((source) => ({ mint: c.mint, source }))),
        started,
      );
    } catch (error) {
      log.warn(`discovery provenance not recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
    stage({ stage: 'discovered', count: candidates.length });
    const discoverMs = Date.now() - started;

    // Prior lifecycle state per mint, so a token moves QUALIFIED -> SCANNING ->
    // whatever the fresh evidence says, rather than being reborn each scan.
    const priorStates = new Map<string, TokenState>();
    for (const token of store.tokens()) {
      const state = token.evaluation?.state;
      if (state !== undefined) priorStates.set(token.mint, state);
    }

    let evaluated = 0;
    let deep = 0;
    // The decision stage reads stored deep intelligence and market history;
    // it never calls a provider, so it cannot turn a scan into a deep cycle.
    const decider = makeDecider(store.decisionSources(), {
      minCoverageQualify: config.minCoverageQualify,
      minCoverageWatch: config.minCoverageWatch,
    });
    const analyzeStarted = Date.now();
    const analysis = await analyze(candidates, {
      priorStates,
      decide: decider,
      onStage: (name, count) => {
        if (name === 'market') stage({ stage: 'market', count });
        else if (name === 'safety') {
          deep = count ?? 0;
          stage({ stage: 'safety', count: deep });
        } else if (name === 'verdict') {
          evaluated += 1;
          stage({ stage: 'evaluated', done: evaluated, total: deep });
        }
      },
    });
    const { snapshots } = analysis;
    const analyzeMs = Date.now() - analyzeStarted;

    // Failures are reported, never fatal: one token or one provider going down
    // must not end the scan or discard what the others returned.
    for (const failure of analysis.providerFailures) {
      log.warn(`provider ${failure.provider} failed this scan (${failure.kind}): ${failure.message}`);
    }
    for (const failed of analysis.failures) {
      log.warn(`token ${failed.mint} could not be analysed (${failed.failure.kind})`);
    }

    const events: MonitorEvent[] = [];
    let fresh = 0;
    let historyRows = 0;
    let transitions = 0;
    const persistStarted = Date.now();

    for (const snapshot of snapshots) {
      const previous = store.token(snapshot.mint);
      if (previous === null) fresh += 1;
      events.push(...diff(snapshot, previous));
      // The resolved evidence travels with the snapshot so persistence can
      // record why this verdict was reached, not just what it was.
      const written = store.upsert(snapshot, analysis.evidence.get(snapshot.mint) ?? null);
      if (written.stored) historyRows += 1;
      if (written.transition) transitions += 1;
    }

    store.finishScan(started, { analyzed: snapshots.length, fresh });
    store.save();
    const rssAfter = process.memoryUsage().rss;

    const result: ScanResult = {
      at: started,
      durationMs: Date.now() - started,
      candidates: candidates.length,
      analyzed: snapshots.length,
      fresh,
      events,
      tokenFailures: analysis.failures,
      providerFailures: analysis.providerFailures,
      top: [...snapshots]
        .sort((a, b) => (TIER[a.evaluation?.eligibility ?? ''] ?? 9) - (TIER[b.evaluation?.eligibility ?? ''] ?? 9) || rankKey(b) - rankKey(a))
        .slice(0, 10),
      timings: {
        discoverMs,
        analyzeMs,
        decisionMs: Math.round(decider.stats.ms * 10) / 10,
        decisions: decider.stats.decisions,
        persistMs: Date.now() - persistStarted,
        historyRows,
        transitions,
        rssMb: Math.round(rssAfter / 1_048_576),
        rssDeltaMb: Math.round((rssAfter - rssBefore) / 1_048_576),
      },
    };

    lastScan = result;
    completed = true;
    bus.emit('scan', result);
    return result;
  } finally {
    scanning = false;
    // A scan that threw announced its start and must announce its end, or a
    // watching dashboard would show "scanning" until the next status poll.
    if (!completed) bus.emit('scan-failed', { at: started });
  }
}

export const isScanning = (): boolean => scanning;

/**
 * Runs scans forever on the configured interval. Uses a chained timeout rather
 * than setInterval so a slow scan delays the next one instead of stacking.
 */
export function startMonitor(): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await runScan();
      log.ok(
        `scan ${store.scanCount}: ${result.analyzed} tokens (${result.fresh} new) in ${(result.durationMs / 1000).toFixed(1)}s, ${result.events.length} events`,
      );
      // History retention only. Whether a token is on the live Board is
      // decided by core/ranking.ts, never by how long its rows are kept.
      const dropped = store.prune();
      if (dropped > 0) log.debug(`pruned ${dropped} stale tokens`);
    } catch (error) {
      log.error('scan failed:', error instanceof Error ? error.message : error);
    }
    if (!stopped) timer = setTimeout(() => void tick(), config.scanIntervalSec * 1000);
  };

  void tick();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
