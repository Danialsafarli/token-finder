/**
 * Runtime state, backed by SQLite.
 *
 * The public surface of this module is unchanged from the JSON-file version
 * that preceded it. That is deliberate: the dashboard, the CLI and the monitor
 * all read `store.tokens()`, `store.history(mint)` and friends, and a
 * persistence change is not a reason to refactor them. What changed is
 * underneath.
 *
 * ## Shape
 *
 * ```
 *   monitor / server / cli
 *          |  store.*          <- this module: the only thing they know about
 *          v
 *      Repository             <- domain operations (src/persist/repository.ts)
 *          v
 *      node:sqlite
 * ```
 *
 * No SQL appears outside `src/persist/`.
 *
 * ## Current state is cached; history is not
 *
 * `tokens()` is called on every dashboard request and the corpus runs to a few
 * thousand tokens. Reading and parsing every payload per request would make
 * persistence the bottleneck, so current snapshots are held in a write-through
 * map: SQLite is the source of truth and is what a restart reads, memory is a
 * read cache that is updated on the same call that writes the row. History is
 * never cached - it is queried, because it is large, append-only and read
 * rarely.
 *
 * ## Degradation
 *
 * If the database cannot be opened, the store keeps working in memory and says
 * so once. Analysis stays correct; nothing is persisted; nothing pretends to
 * be. `persistenceFailure()` exposes the reason so a status endpoint can report
 * it rather than showing an empty history that looks like a quiet market.
 *
 * ## state.json
 *
 * Read once, for the one-time import, and never written again. SQLite is the
 * canonical store from that point. The legacy file and its backups are left on
 * disk untouched - see PERSISTENCE.md.
 */

import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { config, DATA_DIR } from '../config.ts';
import { log } from '../util/logger.ts';
import { closeDatabase, openDatabase } from '../persist/db.ts';
import {
  Repository,
  type HistoryQuery,
  type HolderPoint,
  type MarketPoint,
  type ProviderFailureSummary,
  type SnapshotPolicy,
  type StoredEvidence,
  type StoredTransition,
  type VerdictChange,
  type VerdictPoint,
} from '../persist/repository.ts';
import type { DecisionSources } from '../decision/inputs.ts';
import { ChainRepository } from '../persist/chain-repository.ts';
import { IntelRepository } from '../persist/intel-repository.ts';
import { importLegacyState } from '../persist/legacy-import.ts';
import { applyRetention, type RetentionPolicy } from '../persist/retention.ts';
import { diagnose, formatBytes, type DatabaseDiagnostics } from '../persist/diagnostics.ts';
import type { PersistenceFailure } from '../persist/errors.ts';
import type { TokenEvidence } from './evidence.ts';
import type { HistoryPoint, MonitorEvent, TokenSnapshot } from '../types.ts';

const LEGACY_FILE = resolve(DATA_DIR, 'state.json');

export const DB_PATH = resolve(DATA_DIR, config.dbFile);

const SNAPSHOT_POLICY: SnapshotPolicy = {
  materialScoreDelta: config.snapshotScoreDelta,
  materialRelativeDelta: config.snapshotRelativeDelta,
  materialCoverageDelta: config.snapshotCoverageDelta,
  heartbeatMs: config.snapshotHeartbeatMin * 60_000,
};

const RETENTION: RetentionPolicy = {
  historyDays: config.retentionHistoryDays,
  tokenDays: config.retentionTokenDays,
  diagnosticsDays: config.retentionDiagnosticsDays,
  maxEvents: config.maxEvents,
  launchDays: config.retentionLaunchDays,
  chainDays: config.retentionChainDays,
};

interface Runtime {
  db: DatabaseSync | null;
  repo: Repository | null;
  /** The data backbone's tables. Null exactly when `repo` is. */
  chain: ChainRepository | null;
  intel: IntelRepository | null;
  failure: PersistenceFailure | null;
  /** Current snapshots, write-through cache over the `tokens` table. */
  tokens: Map<string, TokenSnapshot>;
  events: MonitorEvent[];
  scanId: number | null;
  /** Mirrors the scans table so a degraded store still counts its own work. */
  scanCount: number;
  lastScanAt: number | null;
}

function boot(dbPath: string = DB_PATH): Runtime {
  const runtime: Runtime = {
    db: null,
    repo: null,
    chain: null,
    intel: null,
    failure: null,
    tokens: new Map(),
    events: [],
    scanId: null,
    scanCount: 0,
    lastScanAt: null,
  };

  const opened = openDatabase({ path: dbPath });
  if (opened.db === null || opened.failure !== null) {
    runtime.failure = opened.failure;
    log.error(
      `persistence unavailable (${opened.failure?.kind ?? 'unknown'}): ${opened.failure?.message ?? ''} - analysis continues, history is NOT being recorded`,
    );
    return runtime;
  }

  runtime.db = opened.db;
  runtime.repo = new Repository(opened.db, SNAPSHOT_POLICY);
  runtime.chain = new ChainRepository(opened.db);
  runtime.intel = new IntelRepository(opened.db);
  if (opened.applied.length > 0) {
    log.ok(`database schema migrated to v${opened.schemaVersion} (applied: ${opened.applied.join(', ')})`);
  }

  const imported = importLegacyState(opened.db, { legacyPath: LEGACY_FILE });
  if (imported.status === 'imported') {
    log.ok(`legacy state imported: ${imported.detail}; original kept at ${LEGACY_FILE}`);
    if (imported.skippedTokens.length > 0) {
      log.warn(`${imported.skippedTokens.length} legacy token(s) could not be imported`);
    }
  } else if (imported.status === 'failed') {
    log.error(`legacy import failed: ${imported.detail}`);
  }

  runtime.tokens = new Map(runtime.repo.allTokens().map((token) => [token.mint, token]));
  runtime.events = runtime.repo.events(config.maxEvents);
  runtime.scanCount = runtime.repo.scanCount();
  runtime.lastScanAt = runtime.repo.lastScanAt();

  return runtime;
}

let runtime = boot();

export const store = {
  get lastScanAt(): number | null {
    return runtime.lastScanAt;
  },

  get scanCount(): number {
    return runtime.scanCount;
  },

  token(mint: string): TokenSnapshot | null {
    return runtime.tokens.get(mint) ?? null;
  },

  tokens(): TokenSnapshot[] {
    return [...runtime.tokens.values()];
  },

  history(mint: string): HistoryPoint[] {
    return runtime.repo?.historyPoints(mint, config.historyPoints) ?? [];
  },

  events(limit = 100): MonitorEvent[] {
    return runtime.events.slice(0, limit);
  },

  /**
   * Opens a scan so every snapshot written during it is attributable.
   *
   * Safe to skip: a snapshot with a null `scan_id` is still valid history, it
   * just cannot be grouped with its batch.
   */
  beginScan(startedAt: number): void {
    runtime.scanId = runtime.repo?.recordScanStart(startedAt) ?? null;
  },

  /**
   * Replaces the current snapshot and, when the change earns a row, appends
   * history.
   *
   * `evidence` is optional and additive: when the caller has the resolved
   * `TokenEvidence` it is recorded alongside the snapshot, so a stored verdict
   * can later be explained by metric, provider, freshness and state.
   */
  upsert(snapshot: TokenSnapshot, evidence?: TokenEvidence | null): { stored: boolean; transition: boolean } {
    runtime.tokens.set(snapshot.mint, snapshot);

    const repo = runtime.repo;
    if (repo === null) return { stored: false, transition: false };

    const result = repo.saveTokenSnapshot(snapshot, { scanId: runtime.scanId });
    if (result.failure !== null) {
      noteFailure(result.failure);
      return { stored: false, transition: false };
    }
    if (result.snapshotId !== null && evidence != null) {
      repo.saveEvidence(result.snapshotId, snapshot.mint, snapshot.at, evidence);
    }
    return { stored: result.snapshotId !== null, transition: result.snapshotId !== null && result.decision.isTransition };
  },

  /**
   * Stores a verdict decided again without a new market observation
   * (decision/redecide.ts). The current snapshot is replaced; history gains a
   * row only if the verdict changed, dated `decidedAt`.
   */
  recordRedecision(snapshot: TokenSnapshot, decidedAt: number): void {
    runtime.tokens.set(snapshot.mint, snapshot);
    const result = runtime.repo?.saveTokenSnapshot(snapshot, { redecidedAt: decidedAt });
    if (result && result.failure !== null) noteFailure(result.failure);
  },

  addEvent(event: Omit<MonitorEvent, 'id' | 'at'> & { at?: number }): MonitorEvent {
    const full: MonitorEvent = { ...event, id: randomUUID(), at: event.at ?? Date.now() };
    runtime.events.unshift(full);
    if (runtime.events.length > config.maxEvents) runtime.events.length = config.maxEvents;
    runtime.repo?.saveEvent(full);
    return full;
  },

  /**
   * Closes the scan opened by {@link beginScan}.
   *
   * `stats` describes what this scan did. Without it the row would record the
   * size of the whole corpus as though it had all been analysed, which is a
   * different and much larger number.
   */
  finishScan(at: number, stats?: { analyzed: number; fresh: number }): void {
    runtime.lastScanAt = at;
    runtime.scanCount += 1;

    const repo = runtime.repo;
    if (repo !== null && runtime.scanId !== null) {
      const finished = Date.now();
      repo.recordScanFinish(runtime.scanId, finished, {
        analyzed: stats?.analyzed ?? 0,
        fresh: stats?.fresh ?? 0,
        durationMs: finished - at,
      });
    }
    runtime.scanId = null;
  },

  /**
   * Applies the HISTORY retention policy from config.
   *
   * This decides how long rows are kept, not what is current. It used to take
   * a max-age argument and fold it into the token-retention window, which
   * quietly made "how long do we keep history" also mean "how long does a token
   * stay on the Board" - and extended the latter from 14 days to 180. Live
   * visibility is now decided only by core/ranking.ts. State transitions are
   * never removed.
   */
  prune(): number {
    const repo = runtime.repo;
    const db = runtime.db;
    if (repo === null || db === null) return 0;

    const result = applyRetention(db, RETENTION);
    if (result.failure !== null) {
      noteFailure(result.failure);
      return 0;
    }

    // Keep the read cache consistent with what the database now holds.
    if (result.tokens > 0) {
      const live = new Set(repo.allTokens().map((token) => token.mint));
      for (const mint of runtime.tokens.keys()) {
        if (!live.has(mint)) runtime.tokens.delete(mint);
      }
    }
    return result.tokens;
  },

  // --- history queries for the product surface -----------------------------
  // Thin pass-throughs: the repository owns the SQL, the store owns the handle.
  // Each degrades to empty when persistence is unavailable, and callers report
  // that through persistenceFailure() rather than inventing history.

  verdictChanges(options: { mint?: string; limit?: number; since?: number } = {}): VerdictChange[] {
    return runtime.repo?.verdictChanges(options) ?? [];
  },

  tokenHistory(mint: string, query: HistoryQuery = {}): VerdictPoint[] {
    return runtime.repo?.tokenHistory(mint, query) ?? [];
  },

  marketHistory(mint: string, query: HistoryQuery = {}): MarketPoint[] {
    return runtime.repo?.marketHistory(mint, query) ?? [];
  },

  holderHistory(mint: string, query: HistoryQuery = {}): HolderPoint[] {
    return runtime.repo?.holderHistory(mint, query) ?? [];
  },

  latestEvidence(mint: string): StoredEvidence[] {
    return runtime.repo?.latestEvidence(mint) ?? [];
  },

  providerFailureSummary(since: number): ProviderFailureSummary[] {
    return runtime.repo?.providerFailureSummary(since) ?? [];
  },

  /**
   * The data backbone's persistence, or null when the database is not open.
   * Callers degrade exactly as for history: collect nothing, claim nothing.
   */
  chain(): ChainRepository | null {
    return runtime.chain;
  },

  /** Deep-intelligence storage, or null when persistence is unavailable. */
  intel(): IntelRepository | null {
    return runtime.intel;
  },

  /**
   * What the decision stage reads: stored intelligence and history. Degrades
   * to nothing-known when persistence is unavailable, never to "all clear".
   */
  decisionSources(): DecisionSources {
    return {
      intel: runtime.intel,
      marketHistory: (mint, since) => runtime.repo?.marketHistory(mint, { since, limit: 400 }) ?? [],
      holderHistory: (mint, since) => runtime.repo?.holderHistory(mint, { since, limit: 400 }) ?? [],
      previousDecision: (mint) => {
        const decision = runtime.tokens.get(mint)?.decision;
        return decision ? { verdict: decision.verdict, decidedAt: decision.decidedAt, hardFails: decision.hardFails, stability: decision.stability ?? null } : null;
      },
    };
  },

  verdictTransitions(options: { mint?: string; limit?: number } = {}): StoredTransition[] {
    return runtime.repo?.verdictTransitions(options) ?? [];
  },

  /** True when history reads and writes are working. */
  persistenceHealthy(): boolean {
    return runtime.repo !== null && runtime.failure === null;
  },

  /** Diagnostics for the CLI and the System surface. */
  diagnostics(): DatabaseDiagnostics | null {
    return runtime.db === null ? null : diagnose(runtime.db, DB_PATH);
  },

  /** Non-null when persistence is degraded. */
  persistenceFailure(): PersistenceFailure | null {
    return runtime.failure;
  },

  /** Drops every stored row. Used by `cli reset`. */
  reset(): void {
    runtime.tokens.clear();
    runtime.events = [];
    runtime.scanCount = 0;
    runtime.lastScanAt = null;
    runtime.scanId = null;

    const result = runtime.repo?.reset();
    if (result?.failure != null) noteFailure(result.failure);
  },

  /**
   * Retained for call-site compatibility.
   *
   * Writes are committed as they happen now, so there is nothing to flush. A
   * WAL checkpoint is taken so the main database file is current for anything
   * reading it out of band.
   */
  save(): void {
    runtime.repo?.checkpoint();
  },

  /** Test seam: reopen against a different path. Not used in production. */
  __reopen(dbPath: string): void {
    closeDatabase(runtime.db);
    runtime = boot(dbPath);
  },

  /** Test seam: close the handle without ending the process. */
  __close(): void {
    closeDatabase(runtime.db);
    runtime.db = null;
    runtime.repo = null;
    runtime.chain = null;
    runtime.intel = null;
  },
};

/** Logs a persistence failure once per kind, so a broken disk is not a log flood. */
const reported = new Set<string>();
function noteFailure(failure: PersistenceFailure): void {
  runtime.failure = failure;
  if (reported.has(failure.kind)) return;
  reported.add(failure.kind);
  log.error(`persistence ${failure.kind} during ${failure.operation}: ${failure.message}`);
}

export { formatBytes };

function closeQuietly(): void {
  closeDatabase(runtime.db);
}

process.on('exit', closeQuietly);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    closeQuietly();
    process.exit(0);
  });
}
