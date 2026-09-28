/**
 * Persistence for deep intelligence (migration 3).
 *
 * Same rules as the other repositories: every statement for these tables is
 * here, writes that belong together share a transaction, and re-running an
 * analysis replaces its own conclusions rather than stacking duplicates.
 */

import type { DatabaseSync } from 'node:sqlite';
import { transact } from './db.ts';
import type { WalletFeatures } from '../intel/features.ts';
import type { BuyerClassification, BuyerClass } from '../intel/classify.ts';
import type { WalletTrade } from '../intel/wallet-trades.ts';
import type { FundingObservation, FundingVerdict, FundingClass } from '../intel/funding.ts';
import type { WalletEdge } from '../intel/graph.ts';
import type { WalletCluster } from '../intel/cluster.ts';
import type { Attribution } from '../intel/attribution.ts';
import type { SecurityEvent } from '../intel/security.ts';
import type { CreatorProfile } from '../intel/creator.ts';

/** The security_events columns the versioned write reads back. */
interface EventRow {
  id: string;
  mint: string;
  type: string;
  status: string;
  rule_version: string | null;
  reasons: string;
  confidence: number;
  detected_at: number;
  superseded_at: number | null;
}

const json = (value: unknown): string => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
const parse = <T>(text: unknown, fallback: T): T => {
  if (typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

export interface StoredProfile {
  wallet: string;
  analyzedAt: number;
  classification: BuyerClass;
  confidence: number;
  coverage: number;
  features: WalletFeatures;
  signals: BuyerClassification['signals'];
  counterSignals: BuyerClassification['counterSignals'];
  onCurve: boolean | null;
  truncation: string[];
}

export interface StoredFunding extends FundingObservation {
  classification: FundingClass;
  confidence: number;
  reasons: string[];
}

export interface TokenIntelligenceRow {
  mint: string;
  analyzedAt: number;
  activity: unknown;
  wash: unknown;
  attribution: unknown;
  network: unknown;
  wallets: unknown;
  coverage: number;
  truncation: string[];
  /** Rule version per domain the snapshot was produced under; null before Phase 3. */
  ruleVersions?: Record<string, string> | null;
}

export interface StoredSecurityEvent extends SecurityEvent {
  ruleVersion: string | null;
  supersededAt: number | null;
  supersededBy: string | null;
}

export interface IntelStats {
  profiles: number;
  byClass: Record<string, number>;
  edges: number;
  edgesByType: Record<string, number>;
  clusters: number;
  clustersByLevel: Record<string, number>;
  funding: number;
  fundingByClass: Record<string, number>;
  attributions: number;
  attributionByStatus: Record<string, number>;
  creatorProfiles: number;
  creatorsByStatus: Record<string, number>;
  securityByStatus: Record<string, number>;
  tokensAnalyzed: number;
  lastAnalyzedAt: number | null;
}

export class IntelRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  // --- wallets ---------------------------------------------------------------

  /** Writes a wallet's profile, its trades and its funding observation together. */
  saveWalletAnalysis(input: {
    features: WalletFeatures;
    classification: BuyerClassification;
    onCurve: boolean | null;
    trades: WalletTrade[];
    truncation: string[];
    source: string;
    at: number;
  }): void {
    const { features: f, classification: c } = input;
    transact(this.#db, () => {
      this.#db
        .prepare(
          `INSERT INTO wallet_profiles (
             wallet, analyzed_at, window_from, window_to, transactions, history_complete, first_seen_at,
             on_curve, features, classification, confidence, signals, counter_signals, coverage, truncation, source
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(wallet) DO UPDATE SET
             analyzed_at = excluded.analyzed_at, window_from = excluded.window_from, window_to = excluded.window_to,
             transactions = excluded.transactions, history_complete = excluded.history_complete,
             first_seen_at = COALESCE(excluded.first_seen_at, first_seen_at), on_curve = excluded.on_curve,
             features = excluded.features, classification = excluded.classification, confidence = excluded.confidence,
             signals = excluded.signals, counter_signals = excluded.counter_signals, coverage = excluded.coverage,
             truncation = excluded.truncation, source = excluded.source`,
        )
        .run(
          f.wallet,
          input.at,
          f.window.fromMs,
          f.window.toMs,
          f.window.transactions,
          f.window.historyComplete ? 1 : 0,
          f.firstSeenAt.value,
          input.onCurve === null ? null : input.onCurve ? 1 : 0,
          json(f),
          c.classification,
          c.confidence,
          json(c.signals),
          json(c.counterSignals),
          Math.round(c.coverage * 1000) / 1000,
          json(input.truncation),
          input.source,
        );
      const stmt = this.#db.prepare(
        `INSERT OR IGNORE INTO wallet_trades (
           wallet, signature, mint, direction, token_amount, token_decimals, quote_mint, quote_amount,
           quote_decimals, slot, tx_index, block_time, wallet_paid_fee, source, recorded_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const t of input.trades) {
        stmt.run(t.wallet, t.signature, t.mint, t.direction, t.tokenAmount.toString(), t.tokenDecimals, t.quoteMint, t.quoteAmount === null ? null : t.quoteAmount.toString(), t.quoteDecimals, t.slot, t.txIndex, t.blockTimeMs, t.walletPaidFee ? 1 : 0, input.source, input.at);
      }
    });
  }

  profile(wallet: string): StoredProfile | null {
    const row = this.#db.prepare('SELECT * FROM wallet_profiles WHERE wallet = ?').get(wallet) as Record<string, unknown> | undefined;
    return row === undefined ? null : toProfile(row);
  }

  profiles(wallets: string[]): Map<string, StoredProfile> {
    const out = new Map<string, StoredProfile>();
    const stmt = this.#db.prepare('SELECT * FROM wallet_profiles WHERE wallet = ?');
    for (const w of new Set(wallets)) {
      const row = stmt.get(w) as Record<string, unknown> | undefined;
      if (row) out.set(w, toProfile(row));
    }
    return out;
  }

  /** Trades of the given wallets, across every token - the graph's input. */
  tradesOf(wallets: string[]): WalletTrade[] {
    const out: WalletTrade[] = [];
    const stmt = this.#db.prepare('SELECT * FROM wallet_trades WHERE wallet = ?');
    for (const w of new Set(wallets)) {
      for (const r of stmt.all(w) as Record<string, unknown>[]) {
        out.push({
          wallet: String(r.wallet),
          signature: String(r.signature),
          mint: String(r.mint),
          direction: r.direction as 'BUY' | 'SELL',
          tokenAmount: BigInt(String(r.token_amount)),
          tokenDecimals: (r.token_decimals as number | null) ?? null,
          quoteMint: (r.quote_mint as string | null) ?? null,
          quoteAmount: r.quote_amount == null ? null : BigInt(String(r.quote_amount)),
          quoteDecimals: (r.quote_decimals as number | null) ?? null,
          slot: Number(r.slot),
          txIndex: (r.tx_index as number | null) ?? null,
          blockTimeMs: (r.block_time as number | null) ?? null,
          walletPaidFee: r.wallet_paid_fee === 1,
        });
      }
    }
    return out;
  }

  // --- funding -----------------------------------------------------------------

  saveFunding(obs: FundingObservation, verdict: FundingVerdict, source: string, at: number): void {
    this.#db
      .prepare(
        `INSERT INTO funding_edges (
           wallet, funder, signature, lamports, slot, block_time, first_inbound, history_from_start,
           classification, confidence, reasons, source, recorded_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(wallet, funder, signature) DO UPDATE SET
           classification = excluded.classification, confidence = excluded.confidence,
           reasons = excluded.reasons, recorded_at = excluded.recorded_at`,
      )
      .run(obs.wallet, obs.funder, obs.signature, obs.lamports.toString(), obs.slot, obs.blockTimeMs, obs.firstInbound ? 1 : 0, obs.historyFromStart ? 1 : 0, verdict.classification, verdict.confidence, json(verdict.reasons), source, at);
  }

  fundingOf(wallets: string[]): StoredFunding[] {
    const out: StoredFunding[] = [];
    const stmt = this.#db.prepare('SELECT * FROM funding_edges WHERE wallet = ?');
    for (const w of new Set(wallets)) {
      for (const r of stmt.all(w) as Record<string, unknown>[]) out.push(toFunding(r));
    }
    return out;
  }

  /** Every wallet an address funded - for fan-out and for the network search. */
  fundedBy(funder: string): StoredFunding[] {
    return (this.#db.prepare('SELECT * FROM funding_edges WHERE funder = ?').all(funder) as Record<string, unknown>[]).map(toFunding);
  }

  fanOut(funder: string): number {
    return Number((this.#db.prepare('SELECT COUNT(DISTINCT wallet) AS c FROM funding_edges WHERE funder = ?').get(funder) as { c: number }).c);
  }

  addressStats(address: string): { onCurve: boolean | null; recentTxCount: number | null; windowMs: number | null; checkedAt: number } | null {
    const r = this.#db.prepare('SELECT * FROM address_stats WHERE address = ?').get(address) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      onCurve: r.on_curve === null ? null : r.on_curve === 1,
      recentTxCount: (r.recent_tx_count as number | null) ?? null,
      windowMs: (r.window_ms as number | null) ?? null,
      checkedAt: Number(r.checked_at),
    };
  }

  saveAddressStats(address: string, stats: { onCurve: boolean | null; recentTxCount: number | null; windowMs: number | null }, at: number): void {
    this.#db
      .prepare(
        `INSERT INTO address_stats (address, on_curve, recent_tx_count, window_ms, checked_at) VALUES (?,?,?,?,?)
         ON CONFLICT(address) DO UPDATE SET on_curve = excluded.on_curve, recent_tx_count = excluded.recent_tx_count,
           window_ms = excluded.window_ms, checked_at = excluded.checked_at`,
      )
      .run(address, stats.onCurve === null ? null : stats.onCurve ? 1 : 0, stats.recentTxCount, stats.windowMs, at);
  }

  // --- graph ----------------------------------------------------------------------

  /** Upserts edges: a re-derived edge replaces its earlier reading. */
  saveEdges(edges: WalletEdge[], at: number): void {
    if (edges.length === 0) return;
    transact(this.#db, () => {
      const stmt = this.#db.prepare(
        `INSERT INTO wallet_edges (id, type, a, b, directed, confidence, count, first_at, last_at, evidence, detail, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET confidence = excluded.confidence, count = MAX(count, excluded.count),
           first_at = COALESCE(MIN(first_at, excluded.first_at), excluded.first_at, first_at),
           last_at = COALESCE(MAX(last_at, excluded.last_at), excluded.last_at, last_at),
           evidence = excluded.evidence, detail = excluded.detail, updated_at = excluded.updated_at`,
      );
      for (const e of edges) stmt.run(e.id, e.type, e.a, e.b, e.directed ? 1 : 0, e.confidence, e.count, e.firstAt, e.lastAt, json(e.evidence), json(e.detail), at);
    });
  }

  edgesTouching(wallets: string[]): WalletEdge[] {
    const seen = new Map<string, WalletEdge>();
    const stmt = this.#db.prepare('SELECT * FROM wallet_edges WHERE a = ? OR b = ?');
    for (const w of new Set(wallets)) {
      for (const r of stmt.all(w, w) as Record<string, unknown>[]) {
        seen.set(String(r.id), {
          id: String(r.id),
          type: r.type as WalletEdge['type'],
          a: String(r.a),
          b: String(r.b),
          directed: r.directed === 1,
          confidence: Number(r.confidence),
          count: Number(r.count),
          firstAt: (r.first_at as number | null) ?? null,
          lastAt: (r.last_at as number | null) ?? null,
          evidence: parse<string[]>(r.evidence, []),
          detail: parse<WalletEdge['detail']>(r.detail, {}),
        });
      }
    }
    return [...seen.values()];
  }

  /** Replaces the clusters touching `wallets` with a fresh reading. */
  replaceClusters(wallets: string[], clusters: WalletCluster[], at: number): void {
    transact(this.#db, () => {
      const find = this.#db.prepare('SELECT cluster_id FROM cluster_members WHERE wallet = ?');
      const stale = new Set<string>();
      for (const w of new Set([...wallets, ...clusters.flatMap((c) => c.members)])) {
        for (const r of find.all(w) as { cluster_id: string }[]) stale.add(r.cluster_id);
      }
      const drop = this.#db.prepare('DELETE FROM wallet_clusters WHERE id = ?');
      for (const id of stale) drop.run(id);
      const add = this.#db.prepare('INSERT OR REPLACE INTO wallet_clusters (id, level, size, confidence, signals, reasons, updated_at) VALUES (?,?,?,?,?,?,?)');
      const member = this.#db.prepare('INSERT OR IGNORE INTO cluster_members (cluster_id, wallet) VALUES (?,?)');
      for (const c of clusters) {
        add.run(c.id, c.level, c.members.length, c.confidence, json(c.signals), json(c.reasons), at);
        for (const m of c.members) member.run(c.id, m);
      }
    });
  }

  clustersOf(wallets: string[]): WalletCluster[] {
    const ids = new Set<string>();
    const find = this.#db.prepare('SELECT cluster_id FROM cluster_members WHERE wallet = ?');
    for (const w of new Set(wallets)) for (const r of find.all(w) as { cluster_id: string }[]) ids.add(r.cluster_id);
    const out: WalletCluster[] = [];
    for (const id of ids) {
      const r = this.#db.prepare('SELECT * FROM wallet_clusters WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!r) continue;
      const members = (this.#db.prepare('SELECT wallet FROM cluster_members WHERE cluster_id = ? ORDER BY wallet').all(id) as { wallet: string }[]).map((m) => m.wallet);
      out.push({ id, level: r.level as WalletCluster['level'], members, confidence: Number(r.confidence), signals: parse(r.signals, {}), reasons: parse(r.reasons, []) });
    }
    return out;
  }

  // --- attribution, events, creators ------------------------------------------------

  saveAttribution(a: Attribution, at: number): void {
    this.#db
      .prepare(
        `INSERT INTO launch_attributions (
           mint, status, creator, confidence, basis, fee_payer, deployers, mint_authority, mint_authority_role,
           freeze_authority, liquidity_creator, initial_funder, signature, attributed_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(mint) DO UPDATE SET status = excluded.status, creator = excluded.creator, confidence = excluded.confidence,
           basis = excluded.basis, fee_payer = excluded.fee_payer, deployers = excluded.deployers,
           mint_authority = excluded.mint_authority, mint_authority_role = excluded.mint_authority_role,
           freeze_authority = excluded.freeze_authority, liquidity_creator = excluded.liquidity_creator,
           initial_funder = COALESCE(excluded.initial_funder, initial_funder), signature = excluded.signature,
           attributed_at = excluded.attributed_at`,
      )
      .run(a.mint, a.status, a.creator, a.confidence, a.basis, a.feePayer, json(a.deployers), a.mintAuthority, a.mintAuthorityRole, a.freezeAuthority, a.liquidityCreator, a.initialFunder, a.signature, at);
  }

  attribution(mint: string): Attribution | null {
    const r = this.#db.prepare('SELECT * FROM launch_attributions WHERE mint = ?').get(mint) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      mint: String(r.mint),
      status: r.status as Attribution['status'],
      creator: (r.creator as string | null) ?? null,
      confidence: Number(r.confidence),
      basis: String(r.basis),
      feePayer: (r.fee_payer as string | null) ?? null,
      deployers: parse<string[]>(r.deployers, []),
      mintAuthority: (r.mint_authority as string | null) ?? null,
      mintAuthorityRole: (r.mint_authority_role as Attribution['mintAuthorityRole']) ?? null,
      freezeAuthority: (r.freeze_authority as string | null) ?? null,
      liquidityCreator: (r.liquidity_creator as string | null) ?? null,
      initialFunder: (r.initial_funder as string | null) ?? null,
      signature: (r.signature as string | null) ?? null,
      evidence: r.signature ? [String(r.signature)] : [],
    };
  }

  /** Launches attributed to, or paid for by, an address. */
  launchesOf(address: string): { mint: string; blockTimeMs: number | null }[] {
    const rows = this.#db
      .prepare(
        `SELECT la.mint AS mint, tl.block_time AS block_time FROM launch_attributions la
           LEFT JOIN token_launches tl ON tl.mint = la.mint WHERE la.creator = ?
         UNION
         SELECT mint, block_time FROM token_launches WHERE fee_payer = ?`,
      )
      .all(address, address) as { mint: string; block_time: number | null }[];
    const seen = new Map<string, number | null>();
    for (const r of rows) if (!seen.has(r.mint) || seen.get(r.mint) === null) seen.set(r.mint, r.block_time);
    return [...seen.entries()].map(([mint, blockTimeMs]) => ({ mint, blockTimeMs }));
  }

  /**
   * Records one analysis's security findings for a mint under `ruleVersion`.
   *
   * Three cases per event, and a sweep:
   *
   * - **Same rule, re-detected**: the status can only move towards CONFIRMED.
   *   A later, more truncated read can miss a fact the earlier one proved, so
   *   under an unchanged rule a finding never quietly weakens.
   * - **Older rule (or none), re-detected**: the current rule's reading wins,
   *   even when it is weaker - that is the point of versioning. The earlier
   *   reading is copied to `security_event_revisions` first.
   * - **New**: inserted with the current version.
   * - **Sweep**: every event on this mint from an older rule that the current
   *   rule did *not* re-detect is marked superseded. The row stays (and is
   *   copied to the revisions table); it is simply no longer evidence.
   *
   * The sweep only runs when `sweep` is true: the caller asserts the
   * detection ran over this mint's facts, not that it was skipped.
   */
  saveSecurityEvents(events: SecurityEvent[], at: number, options: { mint?: string; ruleVersion?: string; sweep?: boolean } = {}): { reinterpreted: number; superseded: number } {
    const version = options.ruleVersion ?? null;
    const rank: Record<string, number> = { UNKNOWN: 0, SUSPICIOUS: 1, STRONGLY_SUSPECTED: 2, CONFIRMED: 3 };
    const result = { reinterpreted: 0, superseded: 0 };
    transact(this.#db, () => {
      const get = this.#db.prepare('SELECT * FROM security_events WHERE id = ?');
      const put = this.#db.prepare(
        `INSERT OR REPLACE INTO security_events (
           id, mint, type, status, actor, creator_linked, signature, slot, block_time, amount, reasons, evidence, confidence, detected_at,
           rule_version, superseded_at, superseded_by
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)`,
      );
      const archive = this.#db.prepare(
        `INSERT INTO security_event_revisions (event_id, mint, type, status, rule_version, reasons, confidence, detected_at, revised_at, revised_by, change)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      );
      const seen = new Set<string>();
      for (const e of events) {
        seen.add(e.id);
        const prior = get.get(e.id) as EventRow | undefined;
        const priorVersion = prior?.rule_version ?? null;
        if (prior && priorVersion === version && prior.superseded_at == null) {
          if ((rank[prior.status] ?? 0) > (rank[e.status] ?? 0)) continue;
        } else if (prior) {
          archive.run(prior.id, prior.mint, prior.type, prior.status, priorVersion, prior.reasons, prior.confidence, prior.detected_at, at, version ?? 'unversioned', 'REINTERPRETED');
          result.reinterpreted += 1;
        }
        put.run(e.id, e.mint, e.type, e.status, e.actor, e.creatorLinked ? 1 : 0, e.signature, e.slot, e.blockTimeMs, e.amount, json(e.reasons), json(e.evidence), e.confidence, at, version);
      }
      if (options.sweep && options.mint !== undefined && version !== null) {
        const stale = this.#db
          .prepare('SELECT * FROM security_events WHERE mint = ? AND superseded_at IS NULL AND (rule_version IS NULL OR rule_version <> ?)')
          .all(options.mint, version) as unknown as EventRow[];
        const mark = this.#db.prepare('UPDATE security_events SET superseded_at = ?, superseded_by = ? WHERE id = ?');
        for (const row of stale) {
          if (seen.has(row.id)) continue;
          archive.run(row.id, row.mint, row.type, row.status, row.rule_version, row.reasons, row.confidence, row.detected_at, at, version, 'SUPERSEDED');
          mark.run(at, version, row.id);
          result.superseded += 1;
        }
      }
    });
    return result;
  }

  eventsOf(mints: string[]): SecurityEvent[] {
    return this.storedEventsOf(mints).map(({ ruleVersion: _v, supersededAt: _s, supersededBy: _b, ...event }) => event);
  }

  /** Every stored event for these mints, with its rule version and supersession. */
  storedEventsOf(mints: string[]): StoredSecurityEvent[] {
    const out: StoredSecurityEvent[] = [];
    const stmt = this.#db.prepare('SELECT * FROM security_events WHERE mint = ?');
    for (const m of new Set(mints)) {
      for (const r of stmt.all(m) as Record<string, unknown>[]) {
        out.push({
          id: String(r.id),
          mint: String(r.mint),
          type: r.type as SecurityEvent['type'],
          status: r.status as SecurityEvent['status'],
          actor: (r.actor as string | null) ?? null,
          creatorLinked: r.creator_linked === 1,
          signature: String(r.signature),
          slot: Number(r.slot),
          blockTimeMs: (r.block_time as number | null) ?? null,
          amount: (r.amount as string | null) ?? null,
          reasons: parse(r.reasons, []),
          evidence: parse(r.evidence, []),
          confidence: Number(r.confidence),
          ruleVersion: (r.rule_version as string | null) ?? null,
          supersededAt: (r.superseded_at as number | null) ?? null,
          supersededBy: (r.superseded_by as string | null) ?? null,
        });
      }
    }
    return out;
  }

  /** Events that are still evidence: detected under `ruleVersion` and not superseded. */
  activeEventsOf(mints: string[], ruleVersion: string): SecurityEvent[] {
    return this.storedEventsOf(mints)
      .filter((e) => e.ruleVersion === ruleVersion && e.supersededAt === null)
      .map(({ ruleVersion: _v, supersededAt: _s, supersededBy: _b, ...event }) => event);
  }

  /** The audit trail of how a mint's findings were reinterpreted, newest first. */
  eventRevisionsOf(mint: string, limit = 50): { eventId: string; type: string; status: string; ruleVersion: string | null; revisedAt: number; revisedBy: string; change: string }[] {
    return (this.#db.prepare('SELECT * FROM security_event_revisions WHERE mint = ? ORDER BY revised_at DESC LIMIT ?').all(mint, limit) as Record<string, unknown>[]).map((r) => ({
      eventId: String(r.event_id),
      type: String(r.type),
      status: String(r.status),
      ruleVersion: (r.rule_version as string | null) ?? null,
      revisedAt: Number(r.revised_at),
      revisedBy: String(r.revised_by),
      change: String(r.change),
    }));
  }

  saveCreatorProfile(p: CreatorProfile, at: number): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO creator_profiles (
           address, launches, first_launch_at, last_launch_at, confirmed, strongly_suspected, suspicious, status, events, reasons, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(p.address, p.launches, p.firstLaunchAt, p.lastLaunchAt, p.confirmed, p.stronglySuspected, p.suspicious, p.status, json(p.events), json(p.reasons), at);
  }

  creatorProfiles(addresses: string[]): Map<string, CreatorProfile> {
    const out = new Map<string, CreatorProfile>();
    const stmt = this.#db.prepare('SELECT * FROM creator_profiles WHERE address = ?');
    for (const a of new Set(addresses)) {
      const r = stmt.get(a) as Record<string, unknown> | undefined;
      if (!r) continue;
      out.set(a, {
        address: a,
        launches: Number(r.launches),
        firstLaunchAt: (r.first_launch_at as number | null) ?? null,
        lastLaunchAt: (r.last_launch_at as number | null) ?? null,
        confirmed: Number(r.confirmed),
        stronglySuspected: Number(r.strongly_suspected),
        suspicious: Number(r.suspicious),
        status: r.status as CreatorProfile['status'],
        events: parse(r.events, []),
        reasons: parse(r.reasons, []),
      });
    }
    return out;
  }

  /** Every profiled creator with a recorded history - the serial-network search's targets. */
  creatorsWithHistory(): Map<string, CreatorProfile> {
    const addresses = (this.#db.prepare("SELECT address FROM creator_profiles WHERE status IN ('MALICIOUS_HISTORY','SUSPICIOUS')").all() as { address: string }[]).map((r) => r.address);
    return this.creatorProfiles(addresses);
  }

  // --- token intelligence ------------------------------------------------------------

  saveTokenIntelligence(row: TokenIntelligenceRow): void {
    this.#db
      .prepare(
        `INSERT INTO token_intelligence (mint, analyzed_at, activity, wash, attribution, network, wallets, coverage, truncation, rule_versions)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(row.mint, row.analyzedAt, json(row.activity), json(row.wash), json(row.attribution), json(row.network), json(row.wallets), row.coverage, json(row.truncation), row.ruleVersions ? json(row.ruleVersions) : null);
  }

  latestTokenIntelligence(mint: string): TokenIntelligenceRow | null {
    const r = this.#db.prepare('SELECT * FROM token_intelligence WHERE mint = ? ORDER BY analyzed_at DESC LIMIT 1').get(mint) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      mint: String(r.mint),
      analyzedAt: Number(r.analyzed_at),
      activity: parse(r.activity, null),
      wash: parse(r.wash, null),
      attribution: parse(r.attribution, null),
      network: parse(r.network, null),
      wallets: parse(r.wallets, null),
      coverage: Number(r.coverage),
      truncation: parse(r.truncation, []),
      ruleVersions: parse<Record<string, string> | null>(r.rule_versions, null),
    };
  }

  lastAnalyzedAt(mint: string): number | null {
    const r = this.#db.prepare('SELECT MAX(analyzed_at) AS t FROM token_intelligence WHERE mint = ?').get(mint) as { t: number | null };
    return r.t;
  }

  recentTokenIntelligence(limit: number): TokenIntelligenceRow[] {
    const mints = (this.#db.prepare('SELECT mint, MAX(analyzed_at) AS t FROM token_intelligence GROUP BY mint ORDER BY t DESC LIMIT ?').all(limit) as { mint: string }[]).map((r) => r.mint);
    return mints.map((m) => this.latestTokenIntelligence(m)).filter((r): r is TokenIntelligenceRow => r !== null);
  }

  stats(): IntelStats {
    const group = (sql: string): Record<string, number> =>
      Object.fromEntries((this.#db.prepare(sql).all() as { k: string; c: number }[]).map((r) => [r.k, r.c]));
    const one = (sql: string): number => Number((this.#db.prepare(sql).get() as { c: number | null }).c ?? 0);
    return {
      profiles: one('SELECT COUNT(*) AS c FROM wallet_profiles'),
      byClass: group('SELECT classification AS k, COUNT(*) AS c FROM wallet_profiles GROUP BY classification'),
      edges: one('SELECT COUNT(*) AS c FROM wallet_edges'),
      edgesByType: group('SELECT type AS k, COUNT(*) AS c FROM wallet_edges GROUP BY type'),
      clusters: one('SELECT COUNT(*) AS c FROM wallet_clusters'),
      clustersByLevel: group('SELECT level AS k, COUNT(*) AS c FROM wallet_clusters GROUP BY level'),
      funding: one('SELECT COUNT(*) AS c FROM funding_edges'),
      fundingByClass: group('SELECT classification AS k, COUNT(*) AS c FROM funding_edges GROUP BY classification'),
      attributions: one('SELECT COUNT(*) AS c FROM launch_attributions'),
      attributionByStatus: group('SELECT status AS k, COUNT(*) AS c FROM launch_attributions GROUP BY status'),
      creatorProfiles: one('SELECT COUNT(*) AS c FROM creator_profiles'),
      creatorsByStatus: group('SELECT status AS k, COUNT(*) AS c FROM creator_profiles GROUP BY status'),
      securityByStatus: group('SELECT status AS k, COUNT(*) AS c FROM security_events GROUP BY status'),
      tokensAnalyzed: one('SELECT COUNT(DISTINCT mint) AS c FROM token_intelligence'),
      lastAnalyzedAt: (this.#db.prepare('SELECT MAX(analyzed_at) AS c FROM token_intelligence').get() as { c: number | null }).c,
    };
  }
}

function toProfile(r: Record<string, unknown>): StoredProfile {
  return {
    wallet: String(r.wallet),
    analyzedAt: Number(r.analyzed_at),
    classification: r.classification as BuyerClass,
    confidence: Number(r.confidence),
    coverage: Number(r.coverage),
    features: parse<WalletFeatures>(r.features, {} as WalletFeatures),
    signals: parse(r.signals, []),
    counterSignals: parse(r.counter_signals, []),
    onCurve: r.on_curve === null || r.on_curve === undefined ? null : r.on_curve === 1,
    truncation: parse(r.truncation, []),
  };
}

function toFunding(r: Record<string, unknown>): StoredFunding {
  return {
    wallet: String(r.wallet),
    funder: String(r.funder),
    signature: String(r.signature),
    lamports: BigInt(String(r.lamports)),
    slot: Number(r.slot),
    blockTimeMs: (r.block_time as number | null) ?? null,
    firstInbound: r.first_inbound === 1,
    historyFromStart: r.history_from_start === 1,
    classification: r.classification as FundingClass,
    confidence: Number(r.confidence),
    reasons: parse(r.reasons, []),
  };
}
