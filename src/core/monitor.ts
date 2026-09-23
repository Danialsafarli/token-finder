import { EventEmitter } from 'node:events';
import { config } from '../config.ts';
import { log } from '../util/logger.ts';
import { fmtUsd } from '../util/num.ts';
import { discover } from './discover.ts';
import { analyze, type TokenFailure } from './analyze.ts';
import type { ProviderFailure } from '../util/failure.ts';
import { store } from './store.ts';
import type { MonitorEvent, RiskLevel, TokenSnapshot, TokenState } from '../types.ts';

/** Emits "event" (MonitorEvent) and "scan" (ScanResult); the server relays both over SSE. */
export const bus = new EventEmitter();

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
}

let scanning = false;

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
    if (score >= config.minScoreAlert && wellEvidenced && eligibility === 'QUALIFIED') {
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
    const rejected = nowState === 'REJECTED';
    events.push(
      emit(
        rejected ? 'risk_flag' : 'score_down',
        next,
        rejected ? 'critical' : 'info',
        `${next.symbol} moved ${wasState} -> ${nowState}${
          rejected ? `: ${next.evaluation?.vetoes[0]?.reason ?? 'failed the safety gate'}` : ''
        }.`,
        { from: wasState, to: nowState },
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
  try {
    const candidates = await discover();

    // Prior lifecycle state per mint, so a token moves QUALIFIED -> SCANNING ->
    // whatever the fresh evidence says, rather than being reborn each scan.
    const priorStates = new Map<string, TokenState>();
    for (const token of store.tokens()) {
      const state = token.evaluation?.state;
      if (state !== undefined) priorStates.set(token.mint, state);
    }

    const analysis = await analyze(candidates, { priorStates });
    const { snapshots } = analysis;

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

    for (const snapshot of snapshots) {
      const previous = store.token(snapshot.mint);
      if (previous === null) fresh += 1;
      events.push(...diff(snapshot, previous));
      store.upsert(snapshot);
    }

    store.finishScan(started);
    store.save();

    const result: ScanResult = {
      at: started,
      durationMs: Date.now() - started,
      candidates: candidates.length,
      analyzed: snapshots.length,
      fresh,
      events,
      tokenFailures: analysis.failures,
      providerFailures: analysis.providerFailures,
      top: [...snapshots].sort((a, b) => b.score.total - a.score.total).slice(0, 10),
    };

    bus.emit('scan', result);
    return result;
  } finally {
    scanning = false;
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
      const dropped = store.prune(config.maxAgeHours * 3_600_000 * 2);
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
