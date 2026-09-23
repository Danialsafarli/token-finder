import { readFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, DATA_DIR } from '../config.ts';
import { log } from '../util/logger.ts';
import type { HistoryPoint, MonitorEvent, TokenSnapshot } from '../types.ts';

const FILE = resolve(DATA_DIR, 'state.json');

interface State {
  version: 1;
  lastScanAt: number | null;
  scanCount: number;
  tokens: Record<string, TokenSnapshot>;
  history: Record<string, HistoryPoint[]>;
  events: MonitorEvent[];
}

function emptyState(): State {
  return { version: 1, lastScanAt: null, scanCount: 0, tokens: {}, history: {}, events: [] };
}

function load(): State {
  if (!existsSync(FILE)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<State>;
    return { ...emptyState(), ...parsed, version: 1 };
  } catch (error) {
    log.warn('state.json is unreadable, starting fresh:', error instanceof Error ? error.message : error);
    return emptyState();
  }
}

let state = load();
let dirty = false;
let flushTimer: NodeJS.Timeout | null = null;

/** Write through a temp file so a crash mid-write cannot truncate the state. */
function flush(): void {
  if (!dirty) return;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), 'utf8');
    renameSync(tmp, FILE);
    dirty = false;
  } catch (error) {
    log.error('failed to persist state:', error instanceof Error ? error.message : error);
  }
}

function markDirty(): void {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, 1500);
  flushTimer.unref?.();
}

export const store = {
  get lastScanAt(): number | null {
    return state.lastScanAt;
  },

  get scanCount(): number {
    return state.scanCount;
  },

  token(mint: string): TokenSnapshot | null {
    return state.tokens[mint] ?? null;
  },

  tokens(): TokenSnapshot[] {
    return Object.values(state.tokens);
  },

  history(mint: string): HistoryPoint[] {
    return state.history[mint] ?? [];
  },

  events(limit = 100): MonitorEvent[] {
    return state.events.slice(0, limit);
  },

  /** Replaces a snapshot and appends one history point. */
  upsert(snapshot: TokenSnapshot): void {
    state.tokens[snapshot.mint] = snapshot;

    const points = state.history[snapshot.mint] ?? [];
    points.push({
      at: snapshot.at,
      priceUsd: snapshot.priceUsd,
      liquidityUsd: snapshot.liquidityUsd,
      volume24h: snapshot.volume24h,
      score: snapshot.score.total,
    });
    state.history[snapshot.mint] = points.slice(-config.historyPoints);

    markDirty();
  },

  addEvent(event: Omit<MonitorEvent, 'id' | 'at'> & { at?: number }): MonitorEvent {
    const full: MonitorEvent = { ...event, id: randomUUID(), at: event.at ?? Date.now() };
    state.events.unshift(full);
    if (state.events.length > config.maxEvents) state.events.length = config.maxEvents;
    markDirty();
    return full;
  },

  finishScan(at: number): void {
    state.lastScanAt = at;
    state.scanCount += 1;
    markDirty();
  },

  /** Drops tokens and history not seen for `maxAgeMs`, keeping state.json small. */
  prune(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const [mint, snapshot] of Object.entries(state.tokens)) {
      if (snapshot.at >= cutoff) continue;
      delete state.tokens[mint];
      delete state.history[mint];
      removed += 1;
    }
    if (removed > 0) markDirty();
    return removed;
  },

  reset(): void {
    state = emptyState();
    markDirty();
    flush();
  },

  save: flush,
};

process.on('exit', flush);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    flush();
    process.exit(0);
  });
}
