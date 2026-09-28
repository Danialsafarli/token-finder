/**
 * The persistence boundary.
 *
 * Every SQL statement in this project lives in this file and its siblings under
 * `src/persist/`. Core logic calls domain operations - `saveTokenSnapshot`,
 * `getTokenHistory`, `recordScan` - and never sees a query. That is the point
 * of the boundary: the schema can change without the scanner knowing, and a
 * reader can find every write to the database in one place.
 *
 * ## What gets stored, and when
 *
 * A scanner running every two minutes would otherwise write ~700 identical rows
 * per token per day, most of them noise. {@link decideSnapshot} answers "is this
 * worth recording" with four rules, in priority order:
 *
 * 1. **First sighting** - always stored.
 * 2. **State transition** - the lifecycle state or eligibility changed. Always
 *    stored, and flagged `is_transition` so retention can never delete it.
 *    `WATCH -> QUALIFIED` is the kind of fact this whole layer exists to keep.
 * 3. **Material change** - score, coverage or a market figure moved more than
 *    the configured threshold.
 * 4. **Heartbeat** - nothing changed, but the last row is old enough that a gap
 *    would be ambiguous. Without this, "no rows for six hours" could mean
 *    "stable" or "not scanned", and those are different facts.
 *
 * Anything else is suppressed. Suppression drops a *duplicate*, never a change.
 */

import type { DatabaseSync } from 'node:sqlite';
import { transact } from './db.ts';
import { classifyDbError, type PersistenceFailure } from './errors.ts';
import { COVERAGE_WEIGHTS } from '../core/lifecycle.ts';
import { redactSecrets } from '../util/redact.ts';
import type { Evidence, TokenEvidence } from '../core/evidence.ts';
import type {
  HistoryPoint,
  MonitorEvent,
  TokenSnapshot,
  TokenState,
  Eligibility,
} from '../types.ts';

/** Tuning for what counts as a change worth recording. */
export interface SnapshotPolicy {
  /** Absolute score movement, in points out of 100, that is material. */
  materialScoreDelta: number;
  /** Relative movement in price, liquidity or volume that is material, 0-1. */
  materialRelativeDelta: number;
  /** Absolute coverage movement that is material, 0-1. */
  materialCoverageDelta: number;
  /** Store an unchanged token anyway once this long has passed, in ms. */
  heartbeatMs: number;
}

export const DEFAULT_SNAPSHOT_POLICY: SnapshotPolicy = {
  // A point of score is the smallest move a reader would act on; below that the
  // difference is provider jitter, not news.
  materialScoreDelta: 1,
  // 2% on a memecoin's liquidity is inside the noise of which pools a provider
  // happened to index this minute.
  materialRelativeDelta: 0.02,
  materialCoverageDelta: 0.05,
  heartbeatMs: 30 * 60_000,
};

export interface SnapshotDecision {
  store: boolean;
  reason: 'first' | 'transition' | 'material-change' | 'heartbeat' | 'duplicate';
  isTransition: boolean;
}

/** The previous stored snapshot's comparable fields. */
export interface PreviousSnapshot {
  observedAt: number;
  score: number;
  coverage: number | null;
  state: string | null;
  eligibility: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
}

function relativeMove(next: number | null, previous: number | null): number {
  if (next === null || previous === null) return 0;
  // A move away from zero is a change of kind, not of degree: liquidity going
  // from nothing to something is always worth a row.
  if (previous === 0) return next === 0 ? 0 : 1;
  return Math.abs(next - previous) / Math.abs(previous);
}

/**
 * Decides whether a snapshot earns a row.
 *
 * Pure and exported so the rule can be tested directly rather than inferred
 * from what ended up in a database.
 */
export function decideSnapshot(
  snapshot: TokenSnapshot,
  previous: PreviousSnapshot | null,
  policy: SnapshotPolicy = DEFAULT_SNAPSHOT_POLICY,
): SnapshotDecision {
  if (previous === null) return { store: true, reason: 'first', isTransition: true };

  // Two rows sharing (mint, observed_at) would make the verdict/market join in
  // historyPoints() produce a cartesian pair, so the same instant is never
  // recorded twice - whatever else changed, it is the same observation.
  if (snapshot.at === previous.observedAt) {
    return { store: false, reason: 'duplicate', isTransition: false };
  }

  const state = snapshot.evaluation?.state ?? null;
  const eligibility = snapshot.evaluation?.eligibility ?? null;

  // A transition is never suppressed and never pruned. Note that a move to or
  // from "not recorded" counts: losing the ability to evaluate a token is
  // itself a change in what we know about it.
  if (state !== previous.state || eligibility !== previous.eligibility) {
    return { store: true, reason: 'transition', isTransition: true };
  }

  const coverage = snapshot.evaluation?.coverage.coverage ?? null;
  const material =
    Math.abs(snapshot.score.total - previous.score) >= policy.materialScoreDelta ||
    (coverage !== null &&
      previous.coverage !== null &&
      Math.abs(coverage - previous.coverage) >= policy.materialCoverageDelta) ||
    relativeMove(snapshot.priceUsd, previous.priceUsd) >= policy.materialRelativeDelta ||
    relativeMove(snapshot.liquidityUsd, previous.liquidityUsd) >= policy.materialRelativeDelta ||
    relativeMove(snapshot.volume24h, previous.volume24h) >= policy.materialRelativeDelta;

  if (material) return { store: true, reason: 'material-change', isTransition: false };

  if (snapshot.at - previous.observedAt >= policy.heartbeatMs) {
    return { store: true, reason: 'heartbeat', isTransition: false };
  }

  return { store: false, reason: 'duplicate', isTransition: false };
}

/** Renders an evidence value as text without inventing a type discriminator. */
function renderEvidenceValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return redactSecrets(text).slice(0, 500);
}

const boolInt = (value: boolean): number => (value ? 1 : 0);

export interface SaveResult {
  decision: SnapshotDecision;
  snapshotId: number | null;
  failure: PersistenceFailure | null;
}

export interface HistoryQuery {
  /** Inclusive lower bound on `observed_at`, unix ms UTC. */
  since?: number;
  /** Inclusive upper bound on `observed_at`, unix ms UTC. */
  until?: number;
  limit?: number;
}

export interface MarketPoint {
  observedAt: number;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
  marketCap: number | null;
  fdv: number | null;
  buyRatio24h: number | null;
  poolAddress: string | null;
  dexId: string | null;
}

export interface HolderPoint {
  observedAt: number;
  holderCount: number | null;
  topHoldersPct: number | null;
  largestHolderPct: number | null;
  rawTop10: string | null;
  rawSupply: string | null;
  source: string | null;
}

export interface VerdictPoint {
  observedAt: number;
  score: number;
  coverage: number | null;
  confidence: number | null;
  state: string | null;
  eligibility: string | null;
  vetoCodes: string[];
  isTransition: boolean;
}

export interface TransitionRow extends VerdictPoint {
  mint: string;
  symbol: string | null;
}

/**
 * A verdict change with what it changed from and the market at that moment.
 *
 * `from` is the eligibility of the previous transition row for the same mint.
 * Every eligibility change is recorded as a transition (see decideSnapshot), so
 * the previous transition is exactly the previous verdict. Null means this was
 * the token's first assessment.
 */
export interface VerdictChange {
  id: number;
  mint: string;
  symbol: string | null;
  name: string | null;
  observedAt: number;
  from: string | null;
  fromAt: number | null;
  to: string | null;
  score: number;
  coverage: number | null;
  confidence: number | null;
  vetoCodes: string[];
  priceUsd: number | null;
  liquidityUsd: number | null;
  /** From the transition record, when the change was made by the decision engine. */
  policyVersion?: string | null;
  basis?: string | null;
  reasons?: { kind: string; code: string; text: string }[];
}

/** A stored verdict transition, as the decision engine recorded it. */
export interface StoredTransition {
  id: number;
  mint: string;
  at: number;
  from: string | null;
  to: string;
  policyVersion: string;
  models: Record<string, string>;
  basis: string;
  reasons: { kind: string; code: string; text: string; domain?: string }[];
  components: Record<string, unknown>;
  hardFails: { code: string; family: string | null; confidence: number | null; ruleVersion: string | null }[];
  recordedAt: number;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toTransition(row: Record<string, unknown>): StoredTransition {
  return {
    id: Number(row['id']),
    mint: String(row['mint']),
    at: Number(row['at']),
    from: (row['from_state'] as string | null) ?? null,
    to: String(row['to_state']),
    policyVersion: String(row['policy_version']),
    models: parseJson(row['models'], {}),
    basis: String(row['basis'] ?? ''),
    reasons: parseJson(row['reasons'], []),
    components: parseJson(row['components'], {}),
    hardFails: parseJson(row['hard_fails'], []),
    recordedAt: Number(row['recorded_at']),
  };
}

export interface StoredEvidence {
  snapshotId: number;
  observedAt: number;
  metric: string;
  state: string;
  value: string | null;
  source: string | null;
  freshness: string | null;
  confidence: number | null;
}

export interface ProviderFailureSummary {
  provider: string;
  count: number;
  lastAt: number;
  lastKind: string;
  lastMessage: string | null;
}

/**
 * Domain operations over one database handle.
 *
 * Constructed with an already-open, already-migrated handle. It does not own
 * the connection's lifecycle, which belongs to whoever opened it.
 */
export class Repository {
  readonly #db: DatabaseSync;
  readonly #policy: SnapshotPolicy;

  constructor(db: DatabaseSync, policy: SnapshotPolicy = DEFAULT_SNAPSHOT_POLICY) {
    this.#db = db;
    this.#policy = policy;
  }

  // --- scans --------------------------------------------------------------

  /** Opens a scan row and returns its id, or null if the write failed. */
  recordScanStart(startedAt: number): number | null {
    try {
      const info = this.#db
        .prepare('INSERT INTO scans (started_at) VALUES (?)')
        .run(startedAt);
      return Number(info.lastInsertRowid);
    } catch {
      return null;
    }
  }

  recordScanFinish(
    scanId: number,
    finishedAt: number,
    stats: { analyzed: number; fresh: number; durationMs: number },
  ): void {
    try {
      this.#db
        .prepare(
          `UPDATE scans SET finished_at = ?, analyzed = ?, fresh = ?, duration_ms = ?
           WHERE id = ?`,
        )
        .run(finishedAt, stats.analyzed, stats.fresh, Math.round(stats.durationMs), scanId);
    } catch {
      // A lost scan-completion row costs a diagnostic, not correctness.
    }
  }

  scanCount(): number {
    try {
      const row = this.#db
        .prepare('SELECT COUNT(*) AS c FROM scans WHERE finished_at IS NOT NULL')
        .get() as { c: number } | undefined;
      return row?.c ?? 0;
    } catch {
      return 0;
    }
  }

  lastScanAt(): number | null {
    try {
      const row = this.#db
        .prepare('SELECT MAX(started_at) AS a FROM scans WHERE finished_at IS NOT NULL')
        .get() as { a: number | null } | undefined;
      return row?.a ?? null;
    } catch {
      return null;
    }
  }

  // --- tokens -------------------------------------------------------------

  latestToken(mint: string): TokenSnapshot | null {
    try {
      const row = this.#db.prepare('SELECT payload FROM tokens WHERE mint = ?').get(mint) as
        | { payload: string }
        | undefined;
      return row === undefined ? null : (JSON.parse(row.payload) as TokenSnapshot);
    } catch {
      return null;
    }
  }

  allTokens(): TokenSnapshot[] {
    try {
      const rows = this.#db
        .prepare('SELECT payload FROM tokens ORDER BY last_seen_at DESC')
        .all() as { payload: string }[];
      const out: TokenSnapshot[] = [];
      for (const row of rows) {
        // One unparseable payload must not cost the whole corpus.
        try {
          out.push(JSON.parse(row.payload) as TokenSnapshot);
        } catch {
          continue;
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  tokenCount(): number {
    try {
      const row = this.#db.prepare('SELECT COUNT(*) AS c FROM tokens').get() as
        | { c: number }
        | undefined;
      return row?.c ?? 0;
    } catch {
      return 0;
    }
  }

  /** The comparable fields of the most recent stored snapshot for a mint. */
  previousSnapshot(mint: string): PreviousSnapshot | null {
    try {
      const row = this.#db
        .prepare(
          `SELECT ts.observed_at, ts.score, ts.coverage, ts.state, ts.eligibility,
                  ms.price_usd, ms.liquidity_usd, ms.volume_24h
             FROM token_snapshots ts
             LEFT JOIN market_snapshots ms
               ON ms.mint = ts.mint AND ms.observed_at = ts.observed_at
            WHERE ts.mint = ?
            ORDER BY ts.observed_at DESC
            LIMIT 1`,
        )
        .get(mint) as Record<string, number | string | null> | undefined;
      if (row === undefined) return null;
      return {
        observedAt: Number(row['observed_at']),
        score: Number(row['score']),
        coverage: row['coverage'] === null ? null : Number(row['coverage']),
        state: (row['state'] as string | null) ?? null,
        eligibility: (row['eligibility'] as string | null) ?? null,
        priceUsd: row['price_usd'] === null ? null : Number(row['price_usd']),
        liquidityUsd: row['liquidity_usd'] === null ? null : Number(row['liquidity_usd']),
        volume24h: row['volume_24h'] === null ? null : Number(row['volume_24h']),
      };
    } catch {
      return null;
    }
  }

  /**
   * Upserts the token's current state and, when the change earns it, appends
   * one row to each historical stream.
   *
   * The whole write is one transaction. A token's verdict, its market reading,
   * its holder distribution and the evidence behind them describe a single
   * moment; half of them landing would be a record of a moment that never
   * existed.
   */
  saveTokenSnapshot(
    snapshot: TokenSnapshot,
    options: { scanId?: number | null; evidence?: TokenEvidence | null } = {},
  ): SaveResult {
    const scanId = options.scanId ?? null;
    const previous = this.previousSnapshot(snapshot.mint);
    const decision = decideSnapshot(snapshot, previous, this.#policy);
    const recordedAt = Date.now();

    try {
      const snapshotId = transact(this.#db, () => {
        this.#upsertTokenRow(snapshot, recordedAt);
        if (!decision.store) return null;
        const id = this.#appendHistory(snapshot, scanId, recordedAt, decision);
        const to = snapshot.evaluation?.eligibility ?? null;
        const from = previous?.eligibility ?? null;
        if (decision.isTransition && to !== null && to !== from && snapshot.decision) {
          this.#recordTransition(snapshot, from, recordedAt);
        }
        return id;
      });
      return { decision, snapshotId, failure: null };
    } catch (error) {
      return {
        decision,
        snapshotId: null,
        failure: classifyDbError('saveTokenSnapshot', error, 'WRITE_FAILED'),
      };
    }
  }

  #upsertTokenRow(snapshot: TokenSnapshot, recordedAt: number): void {
    const onchain = snapshot.onchain;
    this.#db
      .prepare(
        `INSERT INTO tokens (
           mint, symbol, name, first_seen_at, last_seen_at, launched_at,
           token_program, decimals, raw_supply, payload
         ) VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(mint) DO UPDATE SET
           symbol        = excluded.symbol,
           name          = excluded.name,
           last_seen_at  = excluded.last_seen_at,
           launched_at   = COALESCE(excluded.launched_at, tokens.launched_at),
           token_program = COALESCE(excluded.token_program, tokens.token_program),
           decimals      = COALESCE(excluded.decimals, tokens.decimals),
           raw_supply    = COALESCE(excluded.raw_supply, tokens.raw_supply),
           payload       = excluded.payload`,
      )
      .run(
        snapshot.mint,
        // Redacted for the same reason as the payload below. These come from
        // provider metadata today, which cannot carry our credentials - but the
        // guarantee this layer makes is that no column can, not that no column
        // currently does.
        redactSecrets(snapshot.symbol),
        redactSecrets(snapshot.name),
        // `first_seen_at` is only written on insert; the upsert above never
        // touches it, so the earliest sighting survives every later scan.
        recordedAt,
        recordedAt,
        snapshot.launchedAt,
        onchain?.tokenProgram ?? null,
        onchain?.decimals ?? null,
        onchain?.rawSupply ?? null,
        // Redacted as a whole. The snapshot carries provider failure messages,
        // and an undici error embeds the URL it failed on - which for some
        // providers contains the credential. The payload is the widest write
        // this layer makes, so it is the one that most needs the pass.
        redactSecrets(JSON.stringify(snapshot)),
      );
  }

  #appendHistory(
    snapshot: TokenSnapshot,
    scanId: number | null,
    recordedAt: number,
    decision: SnapshotDecision,
  ): number {
    const evaluation = snapshot.evaluation ?? null;
    const observedAt = snapshot.at;

    const d = snapshot.decision ?? null;
    const info = this.#db
      .prepare(
        `INSERT INTO token_snapshots (
           mint, scan_id, observed_at, recorded_at, score, base_score, grade,
           penalty, score_coverage, coverage, confidence, state, eligibility,
           veto_codes, is_transition, policy_version, rank_score, integrity_score,
           integrity_band, opportunity_score, momentum_state, decision_coverage
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        snapshot.mint,
        scanId,
        observedAt,
        recordedAt,
        snapshot.score.total,
        snapshot.score.base,
        snapshot.score.grade,
        snapshot.score.penalty,
        snapshot.score.coverage,
        evaluation?.coverage.coverage ?? null,
        evaluation?.coverage.confidence ?? null,
        evaluation?.state ?? null,
        evaluation?.eligibility ?? null,
        evaluation === null ? null : evaluation.vetoes.map((v) => v.code).join(','),
        boolInt(decision.isTransition),
        d?.policyVersion ?? null,
        d?.rankScore ?? null,
        d?.integrity.score ?? null,
        d?.integrity.band ?? null,
        d?.opportunity.score ?? null,
        d?.momentum.state ?? null,
        d?.coverage.decision ?? null,
      );
    const snapshotId = Number(info.lastInsertRowid);

    const change = snapshot.priceChange;
    this.#db
      .prepare(
        `INSERT INTO market_snapshots (
           mint, scan_id, observed_at, recorded_at, price_usd, liquidity_usd,
           volume_24h, market_cap, fdv, buy_ratio_24h,
           change_m5, change_h1, change_h6, change_h24, pool_address, dex_id
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        snapshot.mint,
        scanId,
        observedAt,
        recordedAt,
        snapshot.priceUsd,
        snapshot.liquidityUsd,
        snapshot.volume24h,
        snapshot.marketCap,
        snapshot.fdv,
        snapshot.buyRatio24h,
        change?.m5 ?? null,
        change?.h1 ?? null,
        change?.h6 ?? null,
        change?.h24 ?? null,
        snapshot.pair?.pairAddress ?? null,
        snapshot.pair?.dexId ?? null,
      );

    // Holder distribution is only recorded when something actually measured it.
    // A row of nulls would be indistinguishable from a measured absence.
    const onchain = snapshot.onchain;
    const topPct =
      snapshot.jupiter?.audit.topHoldersPercentage ??
      (onchain?.top10Share == null ? null : onchain.top10Share * 100);
    if (snapshot.holders !== null || topPct !== null) {
      this.#db
        .prepare(
          `INSERT INTO holder_snapshots (
             mint, scan_id, observed_at, recorded_at, holder_count,
             top_holders_pct, largest_holder_pct, raw_top10, raw_supply, source,
             wallet_top10_pct, role_breakdown
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          snapshot.mint,
          scanId,
          observedAt,
          recordedAt,
          snapshot.holders,
          topPct,
          onchain?.largestHolderShare == null ? null : onchain.largestHolderShare * 100,
          onchain?.rawTop10 ?? null,
          onchain?.rawSupply ?? null,
          snapshot.jupiter?.audit.topHoldersPercentage != null ? 'jupiter' : onchain ? 'helius' : null,
          // Role-adjusted share is kept beside the raw one, never in its place.
          onchain?.holderRoles?.walletTop10Share == null ? null : onchain.holderRoles.walletTop10Share * 100,
          onchain?.holderRoles ? JSON.stringify({ byRole: onchain.holderRoles.byRole, resolved: onchain.holderRoles.resolved, total: onchain.holderRoles.total }) : null,
        );
    }

    if (snapshot.pair !== null) {
      this.#db
        .prepare(
          `INSERT INTO pool_snapshots (
             mint, scan_id, observed_at, recorded_at, pool_address, dex_id,
             quote_symbol, liquidity_usd, price_usd, pair_created_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          snapshot.mint,
          scanId,
          observedAt,
          recordedAt,
          snapshot.pair.pairAddress,
          snapshot.pair.dexId,
          snapshot.pair.quoteSymbol,
          snapshot.pair.liquidityUsd,
          snapshot.pair.priceUsd,
          snapshot.pair.pairCreatedAt,
        );
    }

    for (const failure of evaluation?.providerFailures ?? []) {
      this.#db
        .prepare(
          `INSERT INTO provider_failures (mint, scan_id, at, provider, kind, message, retryable)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          snapshot.mint,
          scanId,
          failure.at,
          failure.provider,
          failure.kind,
          // Redacted and bounded again at the point of writing. The message is
          // already redacted where it is built; this is the layer that matters
          // most, because a row here outlives the process that wrote it.
          redactSecrets(failure.message).slice(0, 300),
          boolInt(failure.retryable),
        );
    }

    return snapshotId;
  }

  /**
   * One verdict transition, with what decided it. Written in the snapshot's
   * transaction, so a transition row never exists without its snapshot.
   */
  #recordTransition(snapshot: TokenSnapshot, from: string | null, recordedAt: number): void {
    const d = snapshot.decision!;
    this.#db
      .prepare(
        `INSERT INTO verdict_transitions (
           mint, at, from_state, to_state, policy_version, models, basis, reasons, components, hard_fails, recorded_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        snapshot.mint,
        snapshot.at,
        from,
        d.verdict,
        d.policyVersion,
        JSON.stringify(d.models),
        redactSecrets(d.basis).slice(0, 300),
        redactSecrets(JSON.stringify(d.reasons.slice(0, 10))),
        JSON.stringify({
          rank: d.rankScore,
          integrity: { score: d.integrity.score, band: d.integrity.band, risk: d.integrity.risk, coverage: d.integrity.coverage },
          opportunity: { score: d.opportunity.score, band: d.opportunity.band, coverage: d.opportunity.coverage },
          momentum: { state: d.momentum.state, confidence: d.momentum.confidence },
          coverage: d.coverage,
          legacyScore: snapshot.score.total,
        }),
        JSON.stringify(d.hardFails.map((v) => ({ code: v.code, family: v.family ?? null, confidence: v.confidence ?? null, ruleVersion: v.ruleVersion ?? null }))),
        recordedAt,
      );
  }

  /** Stored verdict transitions, newest first. */
  verdictTransitions(options: { mint?: string; limit?: number } = {}): StoredTransition[] {
    try {
      const rows = this.#db
        .prepare(
          `SELECT * FROM verdict_transitions ${options.mint !== undefined ? 'WHERE mint = ?' : ''} ORDER BY at DESC LIMIT ?`,
        )
        .all(...(options.mint !== undefined ? [options.mint] : []), options.limit ?? 100) as Record<string, unknown>[];
      return rows.map(toTransition);
    } catch {
      return [];
    }
  }

  /**
   * Records the canonical evidence behind one stored snapshot.
   *
   * Only the coverage-weighted signals plus the token program - a dozen rows,
   * bounded by the schema rather than by what a provider happened to return.
   * This is what answers "what did Token Finder believe at time T, on whose
   * word, and how fresh was it" without archiving raw provider bodies.
   */
  saveEvidence(snapshotId: number, mint: string, observedAt: number, evidence: TokenEvidence): void {
    const metrics = [...Object.keys(COVERAGE_WEIGHTS), 'tokenProgram'];
    try {
      transact(this.#db, () => {
        const stmt = this.#db.prepare(
          `INSERT INTO evidence_snapshots
             (snapshot_id, mint, observed_at, metric, state, value, source, freshness, confidence)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        );
        for (const metric of metrics) {
          const item = (evidence as unknown as Record<string, unknown>)[metric] as
            | Evidence<unknown>
            | undefined;
          if (item === undefined || typeof item !== 'object' || item === null) continue;
          stmt.run(
            snapshotId,
            mint,
            observedAt,
            metric,
            item.state,
            renderEvidenceValue(item.value),
            item.source,
            item.freshness,
            item.confidence,
          );
        }
      });
    } catch {
      // Evidence is diagnostic depth, not the record itself. Losing it must not
      // roll back the snapshot that has already been committed.
    }
  }

  // --- events -------------------------------------------------------------

  saveEvent(event: MonitorEvent): void {
    try {
      this.#db
        .prepare(
          `INSERT OR REPLACE INTO events (id, at, kind, mint, symbol, level, message, data)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          event.id,
          event.at,
          event.kind,
          event.mint,
          redactSecrets(event.symbol),
          event.level,
          // `data` was redacted here from the start and `message` was not,
          // which is exactly the kind of inconsistency that turns into a leak
          // the first time an event quotes a provider error.
          redactSecrets(event.message),
          event.data === undefined ? null : redactSecrets(JSON.stringify(event.data)),
        );
    } catch {
      // A dropped event is a missed notification, not a corrupted history.
    }
  }

  events(limit = 100): MonitorEvent[] {
    try {
      const rows = this.#db
        .prepare('SELECT * FROM events ORDER BY at DESC LIMIT ?')
        .all(limit) as Record<string, unknown>[];
      return rows.map((row) => ({
        id: String(row['id']),
        at: Number(row['at']),
        kind: row['kind'] as MonitorEvent['kind'],
        mint: String(row['mint'] ?? ''),
        symbol: String(row['symbol'] ?? ''),
        level: row['level'] as MonitorEvent['level'],
        message: String(row['message'] ?? ''),
        ...(row['data'] == null
          ? {}
          : { data: JSON.parse(String(row['data'])) as Record<string, unknown> }),
      }));
    } catch {
      return [];
    }
  }

  // --- history queries ----------------------------------------------------

  /**
   * The compatibility shape the existing dashboard chart expects.
   *
   * Joins verdict and market history on `(mint, observed_at)`, which is exact
   * because both rows are written in the same transaction from the same
   * snapshot and therefore share a timestamp by construction.
   */
  historyPoints(mint: string, limit = 500): HistoryPoint[] {
    try {
      const rows = this.#db
        .prepare(
          `SELECT ts.observed_at AS at, ts.score, ms.price_usd, ms.liquidity_usd, ms.volume_24h
             FROM token_snapshots ts
             LEFT JOIN market_snapshots ms
               ON ms.mint = ts.mint AND ms.observed_at = ts.observed_at
            WHERE ts.mint = ?
            ORDER BY ts.observed_at DESC
            LIMIT ?`,
        )
        .all(mint, limit) as Record<string, number | null>[];
      return rows
        .map((row) => ({
          at: Number(row['at']),
          priceUsd: row['price_usd'] === null ? null : Number(row['price_usd']),
          liquidityUsd: row['liquidity_usd'] === null ? null : Number(row['liquidity_usd']),
          volume24h: row['volume_24h'] === null ? null : Number(row['volume_24h']),
          score: Number(row['score']),
        }))
        .reverse();
    } catch {
      return [];
    }
  }

  #range(query: HistoryQuery): { clause: string; params: number[] } {
    const parts: string[] = [];
    const params: number[] = [];
    if (query.since !== undefined) {
      parts.push('AND observed_at >= ?');
      params.push(query.since);
    }
    if (query.until !== undefined) {
      parts.push('AND observed_at <= ?');
      params.push(query.until);
    }
    return { clause: parts.join(' '), params };
  }

  /** Verdict history, oldest first. */
  tokenHistory(mint: string, query: HistoryQuery = {}): VerdictPoint[] {
    const { clause, params } = this.#range(query);
    try {
      const rows = this.#db
        .prepare(
          `SELECT observed_at, score, coverage, confidence, state, eligibility,
                  veto_codes, is_transition
             FROM token_snapshots
            WHERE mint = ? ${clause}
            ORDER BY observed_at ASC
            LIMIT ?`,
        )
        .all(mint, ...params, query.limit ?? 1000) as Record<string, unknown>[];
      return rows.map((row) => ({
        observedAt: Number(row['observed_at']),
        score: Number(row['score']),
        coverage: row['coverage'] == null ? null : Number(row['coverage']),
        confidence: row['confidence'] == null ? null : Number(row['confidence']),
        state: (row['state'] as string | null) ?? null,
        eligibility: (row['eligibility'] as string | null) ?? null,
        vetoCodes: String(row['veto_codes'] ?? '')
          .split(',')
          .filter((code) => code.length > 0),
        isTransition: Number(row['is_transition']) === 1,
      }));
    } catch {
      return [];
    }
  }

  /** Market history, oldest first - the input a future OHLCV pass would fold. */
  marketHistory(mint: string, query: HistoryQuery = {}): MarketPoint[] {
    const { clause, params } = this.#range(query);
    try {
      const rows = this.#db
        .prepare(
          `SELECT observed_at, price_usd, liquidity_usd, volume_24h, market_cap,
                  fdv, buy_ratio_24h, pool_address, dex_id
             FROM market_snapshots
            WHERE mint = ? ${clause}
            ORDER BY observed_at ASC
            LIMIT ?`,
        )
        .all(mint, ...params, query.limit ?? 1000) as Record<string, unknown>[];
      return rows.map((row) => ({
        observedAt: Number(row['observed_at']),
        priceUsd: row['price_usd'] == null ? null : Number(row['price_usd']),
        liquidityUsd: row['liquidity_usd'] == null ? null : Number(row['liquidity_usd']),
        volume24h: row['volume_24h'] == null ? null : Number(row['volume_24h']),
        marketCap: row['market_cap'] == null ? null : Number(row['market_cap']),
        fdv: row['fdv'] == null ? null : Number(row['fdv']),
        buyRatio24h: row['buy_ratio_24h'] == null ? null : Number(row['buy_ratio_24h']),
        poolAddress: (row['pool_address'] as string | null) ?? null,
        dexId: (row['dex_id'] as string | null) ?? null,
      }));
    } catch {
      return [];
    }
  }

  /** Holder history, oldest first. */
  holderHistory(mint: string, query: HistoryQuery = {}): HolderPoint[] {
    const { clause, params } = this.#range(query);
    try {
      const rows = this.#db
        .prepare(
          `SELECT observed_at, holder_count, top_holders_pct, largest_holder_pct,
                  raw_top10, raw_supply, source
             FROM holder_snapshots
            WHERE mint = ? ${clause}
            ORDER BY observed_at ASC
            LIMIT ?`,
        )
        .all(mint, ...params, query.limit ?? 1000) as Record<string, unknown>[];
      return rows.map((row) => ({
        observedAt: Number(row['observed_at']),
        holderCount: row['holder_count'] == null ? null : Number(row['holder_count']),
        topHoldersPct: row['top_holders_pct'] == null ? null : Number(row['top_holders_pct']),
        largestHolderPct:
          row['largest_holder_pct'] == null ? null : Number(row['largest_holder_pct']),
        // Stayed TEXT the whole way; never widened through a float.
        rawTop10: (row['raw_top10'] as string | null) ?? null,
        rawSupply: (row['raw_supply'] as string | null) ?? null,
        source: (row['source'] as string | null) ?? null,
      }));
    } catch {
      return [];
    }
  }

  /** Recent lifecycle changes across every token, newest first. */
  recentTransitions(limit = 50): TransitionRow[] {
    try {
      const rows = this.#db
        .prepare(
          `SELECT ts.mint, t.symbol, ts.observed_at, ts.score, ts.coverage,
                  ts.confidence, ts.state, ts.eligibility, ts.veto_codes, ts.is_transition
             FROM token_snapshots ts
             LEFT JOIN tokens t ON t.mint = ts.mint
            WHERE ts.is_transition = 1
            ORDER BY ts.observed_at DESC
            LIMIT ?`,
        )
        .all(limit) as Record<string, unknown>[];
      return rows.map((row) => ({
        mint: String(row['mint']),
        symbol: (row['symbol'] as string | null) ?? null,
        observedAt: Number(row['observed_at']),
        score: Number(row['score']),
        coverage: row['coverage'] == null ? null : Number(row['coverage']),
        confidence: row['confidence'] == null ? null : Number(row['confidence']),
        state: (row['state'] as string | null) ?? null,
        eligibility: (row['eligibility'] as string | null) ?? null,
        vetoCodes: String(row['veto_codes'] ?? '')
          .split(',')
          .filter((code) => code.length > 0),
        isTransition: true,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Verdict changes, newest first, each with the verdict it replaced.
   *
   * Only rows that carry an eligibility take part: history imported from the
   * pre-evaluation JSON store has none, and treating its NULL as a verdict would
   * invent a "change" that never happened.
   */
  verdictChanges(options: { mint?: string; limit?: number; since?: number } = {}): VerdictChange[] {
    const params: (string | number)[] = [];
    let where = 'ts.is_transition = 1 AND ts.eligibility IS NOT NULL';
    if (options.mint !== undefined) {
      where += ' AND ts.mint = ?';
      params.push(options.mint);
    }
    const outer: string[] = [];
    if (options.since !== undefined) {
      outer.push('observed_at >= ?');
    }
    try {
      const rows = this.#db
        .prepare(
          `SELECT * FROM (
             SELECT ts.id, ts.mint, t.symbol, t.name, ts.observed_at, ts.eligibility,
                    ts.score, ts.coverage, ts.confidence, ts.veto_codes,
                    ms.price_usd, ms.liquidity_usd,
                    vt.policy_version AS vt_policy, vt.basis AS vt_basis, vt.reasons AS vt_reasons,
                    LAG(ts.eligibility) OVER (PARTITION BY ts.mint ORDER BY ts.observed_at) AS prev_eligibility,
                    LAG(ts.observed_at) OVER (PARTITION BY ts.mint ORDER BY ts.observed_at) AS prev_at
               FROM token_snapshots ts
               LEFT JOIN tokens t ON t.mint = ts.mint
               LEFT JOIN market_snapshots ms ON ms.mint = ts.mint AND ms.observed_at = ts.observed_at
               LEFT JOIN verdict_transitions vt ON vt.mint = ts.mint AND vt.at = ts.observed_at
              WHERE ${where}
           )
           ${outer.length ? `WHERE ${outer.join(' AND ')}` : ''}
           ORDER BY observed_at DESC
           LIMIT ?`,
        )
        .all(...params, ...(options.since !== undefined ? [options.since] : []), options.limit ?? 100) as Record<string, unknown>[];
      return rows.map((row) => ({
        id: Number(row['id']),
        mint: String(row['mint']),
        symbol: (row['symbol'] as string | null) ?? null,
        name: (row['name'] as string | null) ?? null,
        observedAt: Number(row['observed_at']),
        from: (row['prev_eligibility'] as string | null) ?? null,
        fromAt: row['prev_at'] == null ? null : Number(row['prev_at']),
        to: (row['eligibility'] as string | null) ?? null,
        score: Number(row['score']),
        coverage: row['coverage'] == null ? null : Number(row['coverage']),
        confidence: row['confidence'] == null ? null : Number(row['confidence']),
        vetoCodes: String(row['veto_codes'] ?? '')
          .split(',')
          .filter((code) => code.length > 0),
        priceUsd: row['price_usd'] == null ? null : Number(row['price_usd']),
        liquidityUsd: row['liquidity_usd'] == null ? null : Number(row['liquidity_usd']),
        policyVersion: (row['vt_policy'] as string | null) ?? null,
        basis: (row['vt_basis'] as string | null) ?? null,
        reasons: parseJson(row['vt_reasons'], []),
      }));
    } catch {
      return [];
    }
  }

  /**
   * The most recent persisted evidence for a mint.
   *
   * The fallback for snapshots written before the ledger existed: it carries the
   * winning value, state, source, freshness and confidence per metric, but not
   * every provider's claim.
   */
  latestEvidence(mint: string): StoredEvidence[] {
    try {
      const rows = this.#db
        .prepare(
          `SELECT snapshot_id, observed_at, metric, state, value, source, freshness, confidence
             FROM evidence_snapshots
            WHERE snapshot_id = (SELECT MAX(snapshot_id) FROM evidence_snapshots WHERE mint = ?)
            ORDER BY metric`,
        )
        .all(mint) as Record<string, unknown>[];
      return rows.map((row) => ({
        snapshotId: Number(row['snapshot_id']),
        observedAt: Number(row['observed_at']),
        metric: String(row['metric']),
        state: String(row['state']),
        value: (row['value'] as string | null) ?? null,
        source: (row['source'] as string | null) ?? null,
        freshness: (row['freshness'] as string | null) ?? null,
        confidence: row['confidence'] == null ? null : Number(row['confidence']),
      }));
    } catch {
      return [];
    }
  }

  /** Provider failures since a point in time, grouped by provider. */
  providerFailureSummary(since: number): ProviderFailureSummary[] {
    try {
      const rows = this.#db
        .prepare(
          `SELECT pf.provider, COUNT(*) AS n, MAX(pf.at) AS last_at,
                  (SELECT kind FROM provider_failures x WHERE x.provider = pf.provider ORDER BY x.at DESC LIMIT 1) AS last_kind,
                  (SELECT message FROM provider_failures x WHERE x.provider = pf.provider ORDER BY x.at DESC LIMIT 1) AS last_message
             FROM provider_failures pf
            WHERE pf.at >= ?
            GROUP BY pf.provider
            ORDER BY n DESC`,
        )
        .all(since) as Record<string, unknown>[];
      return rows.map((row) => ({
        provider: String(row['provider']),
        count: Number(row['n']),
        lastAt: Number(row['last_at']),
        lastKind: String(row['last_kind'] ?? 'UNKNOWN'),
        lastMessage: (row['last_message'] as string | null) ?? null,
      }));
    } catch {
      return [];
    }
  }

  /** Evidence recorded for one stored snapshot. */
  evidenceFor(snapshotId: number): Record<string, unknown>[] {
    try {
      return this.#db
        .prepare(
          `SELECT metric, state, value, source, freshness, confidence
             FROM evidence_snapshots WHERE snapshot_id = ? ORDER BY metric`,
        )
        .all(snapshotId) as Record<string, unknown>[];
    } catch {
      return [];
    }
  }

  // --- metadata -----------------------------------------------------------

  /**
   * Drops every stored row, leaving the schema in place.
   *
   * One transaction: a half-cleared database is worse than either a full one
   * or an empty one, because nothing downstream would know which it was.
   */
  reset(): { ok: boolean; failure: PersistenceFailure | null } {
    try {
      transact(this.#db, () => {
        // Order is for readability; the cascades would handle it anyway.
        for (const table of [
          'evidence_snapshots',
          'token_snapshots',
          'market_snapshots',
          'holder_snapshots',
          'pool_snapshots',
          'provider_failures',
          'events',
          'scans',
          'pool_activity',
          'wallet_token_activity',
          'transfer_edges',
          'chain_events',
          'chain_transactions',
          'wallets',
          'token_launches',
          'token_discoveries',
          'ingest_cursors',
          'ingest_gaps',
          'cluster_members',
          'wallet_clusters',
          'wallet_edges',
          'wallet_trades',
          'wallet_profiles',
          'funding_edges',
          'address_stats',
          'launch_attributions',
          'security_events',
          'creator_profiles',
          'token_intelligence',
          'security_event_revisions',
          'verdict_transitions',
          'tokens',
        ]) {
          this.#db.exec(`DELETE FROM ${table}`);
        }
      });
      return { ok: true, failure: null };
    } catch (error) {
      return { ok: false, failure: classifyDbError('reset', error, 'WRITE_FAILED') };
    }
  }

  /**
   * Folds the WAL back into the main database file.
   *
   * Committed data is already durable without this; it exists so the main file
   * is current for anything reading it out of band, and so the reported size
   * is not dominated by an unchecked WAL.
   */
  checkpoint(): void {
    try {
      this.#db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    } catch {
      // A checkpoint is an optimisation, never a correctness requirement.
    }
  }

  getMeta(key: string): string | null {
    try {
      const row = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    } catch {
      return null;
    }
  }

  setMeta(key: string, value: string): void {
    this.#db
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run(key, value);
  }
}

export type { TokenState, Eligibility };
