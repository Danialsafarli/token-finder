import { EventEmitter } from 'node:events';
import { config } from '../config.ts';
import { log } from '../util/logger.ts';
import { fmtUsd } from '../util/num.ts';
import { discover } from './discover.ts';
import { analyze } from './analyze.ts';
import { store } from './store.ts';
import type { MonitorEvent, RiskLevel, TokenSnapshot } from '../types.ts';

/** Emits "event" (MonitorEvent) and "scan" (ScanResult); the server relays both over SSE. */
export const bus = new EventEmitter();

export interface ScanResult {
  at: number;
  durationMs: number;
  candidates: number;
  analyzed: number;
  fresh: number;
  events: MonitorEvent[];
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
    // Everything new would drown the feed, so only surface the plausible ones.
    if (score >= config.minScoreAlert) {
      events.push(
        emit('discovered', next, 'medium', `New token ${next.symbol} scored ${score} (${next.score.grade}).`, {
          score,
        }),
      );
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

  // A liquidity collapse is the clearest on-chain signature of a rug.
  if (previous.liquidityUsd >= 5_000 && next.liquidityUsd < previous.liquidityUsd * 0.6) {
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
    const snapshots = await analyze(candidates);

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
