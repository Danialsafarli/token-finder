/**
 * Persistence for the data backbone (migration 2).
 *
 * Same rules as `repository.ts`: every statement for these tables lives here,
 * callers speak in domain operations, and a write that loses must not take a
 * committed one with it.
 *
 * ## Idempotency is the design, not a feature
 *
 * The same transaction will be seen more than once - a restart before the
 * cursor moved, an overlapping page, a pool shared by two tracked tokens. Every
 * table has a natural key, every insert is `INSERT OR IGNORE`, and the
 * counters that sit on top (`wallet_token_activity.buys`) only move when the
 * row beneath them was actually inserted. Re-ingesting is therefore free and
 * harmless, which is what makes the collector safe to restart at any point.
 */

import type { DatabaseSync } from 'node:sqlite';
import { transact } from './db.ts';
import { redactSecrets } from '../util/redact.ts';
import type { LaunchRecord } from '../ingest/launch.ts';
import type { PoolActivity } from '../ingest/activity.ts';
import type { ChainEvent, TransferEdge } from '../ingest/events.ts';

export type { TransferEdge };
import type { NormalizedTransaction } from '../ingest/normalize.ts';

/** Everything one fetched transaction contributes, written together. */
export interface IngestedTransaction {
  tx: NormalizedTransaction;
  txIndex: number | null;
  /** Pool readings, one per tracked (pool, mint) the transaction touched. */
  activity: PoolActivity[];
  edges: TransferEdge[];
  events: ChainEvent[];
  /** Addresses newly observed as traders or launch payers, with their on-curve flag. */
  wallets: { address: string; onCurve: boolean | null }[];
  source: string;
  commitment: string;
}

export interface IngestWriteResult {
  transactionInserted: boolean;
  activityInserted: number;
  edgesInserted: number;
  eventsInserted: number;
}

export interface LaunchRow {
  mint: string;
  venue: string;
  signature: string;
  slot: number;
  blockTime: number | null;
  feePayer: string;
  tokenProgram: string;
  pool: string | null;
  poolConfirmed: boolean;
  recordedAt: number;
}

export interface CursorRow {
  key: string;
  signature: string;
  slot: number;
  updatedAt: number;
}

export interface BuyerArrival {
  wallet: string;
  firstObservedAt: number;
  firstSlot: number;
  firstSignature: string;
  buys: number;
  sells: number;
  onCurve: boolean | null;
}

export interface ActivityRow {
  signature: string;
  pool: string;
  slot: number;
  blockTime: number | null;
  kind: string;
  reason: string | null;
  direction: string | null;
  trader: string | null;
  traderResolution: string | null;
  tokenAmount: string | null;
  quoteMint: string | null;
  quoteAmount: string | null;
  priceInQuote: number | null;
  confidence: number;
}

export interface BackboneStats {
  transactions: number;
  transactionsLastHour: number;
  failedLastHour: number;
  activityByKind: Record<string, number>;
  launches: number;
  launchesLastHour: number;
  wallets: number;
  edges: number;
  chainEvents: number;
  discoveries: number;
  gapsLastDay: number;
  skippedLastDay: number;
  latestBlockTime: number | null;
  latestRecordedAt: number | null;
}

const boolInt = (value: boolean): number => (value ? 1 : 0);

export class ChainRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  // --- discovery provenance --------------------------------------------------

  /** Records that each source surfaced each mint at `at`. One transaction per batch. */
  recordDiscoveries(items: { mint: string; source: string }[], at: number): void {
    if (items.length === 0) return;
    transact(this.#db, () => {
      const stmt = this.#db.prepare(
        `INSERT INTO token_discoveries (mint, source, first_seen_at, last_seen_at, times_seen)
         VALUES (?,?,?,?,1)
         ON CONFLICT(mint, source) DO UPDATE SET
           last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
           first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
           times_seen = times_seen + 1`,
      );
      for (const { mint, source } of items) stmt.run(mint, source, at, at);
    });
  }

  /** Every source that surfaced a mint, earliest first. */
  discoveriesOf(mint: string): { source: string; firstSeenAt: number; lastSeenAt: number; timesSeen: number }[] {
    const rows = this.#db
      .prepare(
        `SELECT source, first_seen_at, last_seen_at, times_seen FROM token_discoveries
          WHERE mint = ? ORDER BY first_seen_at`,
      )
      .all(mint) as { source: string; first_seen_at: number; last_seen_at: number; times_seen: number }[];
    return rows.map((r) => ({ source: r.source, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, timesSeen: r.times_seen }));
  }

  /**
   * For mints seen both on-chain and by a feed, two different questions:
   *
   * - `medianLeadMs`: how much earlier Token Finder's chain collection saw
   *   them than its feed scans did - our own pipelines, compared. Negative
   *   when the feeds were first, which depends on cycle pacing and budget.
   * - `medianFeedDelayMs`: how long after the launch's block time a feed first
   *   surfaced the mint - how much earlier the chain *had* it.
   */
  chainLead(since: number): { mints: number; medianLeadMs: number | null; medianFeedDelayMs: number | null } {
    const rows = this.#db
      .prepare(
        `SELECT c.first_seen_at AS chain_at, MIN(f.first_seen_at) AS feed_at, l.block_time AS launched_at
           FROM token_discoveries c
           JOIN token_discoveries f ON f.mint = c.mint AND f.source NOT LIKE 'chain:%'
           LEFT JOIN token_launches l ON l.mint = c.mint
          WHERE c.source LIKE 'chain:%' AND c.first_seen_at >= ?
          GROUP BY c.mint`,
      )
      .all(since) as { chain_at: number; feed_at: number; launched_at: number | null }[];
    const median = (values: number[]): number | null => {
      if (values.length === 0) return null;
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)] ?? null;
    };
    return {
      mints: rows.length,
      medianLeadMs: median(rows.map((r) => r.feed_at - r.chain_at)),
      medianFeedDelayMs: median(rows.filter((r) => r.launched_at !== null).map((r) => r.feed_at - (r.launched_at as number))),
    };
  }

  // --- launches ---------------------------------------------------------------

  /** Stores a launch. Returns false when it was already known. */
  saveLaunch(launch: LaunchRecord, source: string, recordedAt: number = Date.now()): boolean {
    const result = this.#db
      .prepare(
        `INSERT OR IGNORE INTO token_launches (
           mint, venue, signature, slot, block_time, fee_payer, token_program, decimals,
           initial_supply, pool, pool_confirmed, fee_payer_initial_balance,
           mint_authority_revoked, source, recorded_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        launch.mint,
        launch.venue,
        launch.signature,
        launch.slot,
        launch.blockTimeMs,
        launch.feePayer,
        launch.tokenProgram,
        launch.decimals,
        launch.initialSupply,
        launch.pool,
        boolInt(launch.poolConfirmed),
        launch.feePayerInitialBalance,
        boolInt(launch.mintAuthorityRevoked),
        source,
        recordedAt,
      );
    return Number(result.changes) > 0;
  }

  /** Launches whose block time is at or after `since`, newest first. */
  recentLaunches(since: number, limit: number): LaunchRow[] {
    const rows = this.#db
      .prepare(
        `SELECT mint, venue, signature, slot, block_time, fee_payer, token_program, pool, pool_confirmed, recorded_at
           FROM token_launches WHERE block_time >= ? ORDER BY block_time DESC LIMIT ?`,
      )
      .all(since, Math.max(0, Math.trunc(limit))) as Record<string, unknown>[];
    return rows.map(toLaunch);
  }

  launch(mint: string): LaunchRow | null {
    const row = this.#db
      .prepare(
        `SELECT mint, venue, signature, slot, block_time, fee_payer, token_program, pool, pool_confirmed, recorded_at
           FROM token_launches WHERE mint = ?`,
      )
      .get(mint) as Record<string, unknown> | undefined;
    return row === undefined ? null : toLaunch(row);
  }

  /** Every launch a fee payer paid for - the input a creator-history phase reads. */
  launchesByFeePayer(address: string, limit = 100): LaunchRow[] {
    const rows = this.#db
      .prepare(
        `SELECT mint, venue, signature, slot, block_time, fee_payer, token_program, pool, pool_confirmed, recorded_at
           FROM token_launches WHERE fee_payer = ? ORDER BY block_time DESC LIMIT ?`,
      )
      .all(address, limit) as Record<string, unknown>[];
    return rows.map(toLaunch);
  }

  // --- transactions -------------------------------------------------------------

  /** The subset of `signatures` already fetched. */
  knownSignatures(signatures: string[]): Set<string> {
    const known = new Set<string>();
    const stmt = this.#db.prepare('SELECT 1 AS hit FROM chain_transactions WHERE signature = ?');
    for (const signature of signatures) if (stmt.get(signature) !== undefined) known.add(signature);
    return known;
  }

  /**
   * Writes one fetched transaction and everything derived from it in a single
   * transaction: either the ledger row and its readings all land, or none do.
   */
  saveIngested(input: IngestedTransaction, recordedAt: number = Date.now()): IngestWriteResult {
    const { tx } = input;
    const result: IngestWriteResult = { transactionInserted: false, activityInserted: 0, edgesInserted: 0, eventsInserted: 0 };

    transact(this.#db, () => {
      result.transactionInserted =
        Number(
          this.#db
            .prepare(
              `INSERT OR IGNORE INTO chain_transactions (
                 signature, slot, tx_index, block_time, fee_payer, status, error,
                 fee_lamports, version, source, commitment, recorded_at
               ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              tx.signature,
              tx.slot,
              input.txIndex,
              tx.blockTimeMs,
              tx.feePayer,
              tx.status,
              tx.error === null ? null : redactSecrets(tx.error).slice(0, 160),
              tx.feeLamports === null ? null : tx.feeLamports.toString(),
              tx.version,
              input.source,
              input.commitment,
              recordedAt,
            ).changes,
        ) > 0;

      const observed = tx.blockTimeMs ?? recordedAt;

      for (const address of input.wallets) {
        this.#db
          .prepare(
            `INSERT INTO wallets (address, on_curve, first_observed_at, first_signature, last_observed_at)
             VALUES (?,?,?,?,?)
             ON CONFLICT(address) DO UPDATE SET
               first_signature = CASE WHEN excluded.first_observed_at < first_observed_at
                                      THEN excluded.first_signature ELSE first_signature END,
               first_observed_at = MIN(first_observed_at, excluded.first_observed_at),
               last_observed_at = MAX(last_observed_at, excluded.last_observed_at)`,
          )
          .run(
            address.address,
            address.onCurve === null ? null : boolInt(address.onCurve),
            observed,
            tx.signature,
            observed,
          );
      }

      for (const a of input.activity) {
        const inserted =
          Number(
            this.#db
              .prepare(
                `INSERT OR IGNORE INTO pool_activity (
                   signature, pool, mint, slot, tx_index, block_time, kind, reason, direction,
                   trader, trader_resolution, fee_payer, token_amount, token_decimals,
                   quote_mint, quote_amount, quote_decimals, price_in_quote,
                   pool_side_inferred, confidence, source, recorded_at
                 ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              )
              .run(
                tx.signature,
                a.pool,
                a.mint,
                tx.slot,
                input.txIndex,
                tx.blockTimeMs,
                a.kind,
                a.reason,
                a.direction,
                a.trader,
                a.traderResolution,
                a.feePayer,
                a.tokenAmount === null ? null : a.tokenAmount.toString(),
                a.tokenDecimals,
                a.quoteMint,
                a.quoteAmount === null ? null : a.quoteAmount.toString(),
                a.quoteDecimals,
                a.priceInQuote,
                boolInt(a.poolSideInferred),
                a.confidence,
                input.source,
                recordedAt,
              ).changes,
          ) > 0;
        if (!inserted) continue;
        result.activityInserted += 1;

        // The arrival record moves only with a newly inserted trade, so a
        // re-ingested transaction cannot count a buy twice.
        if (a.kind === 'SWAP' && a.trader !== null && a.direction !== null) {
          this.#db
            .prepare(
              `INSERT INTO wallet_token_activity (
                 wallet, mint, first_observed_at, first_signature, first_slot, last_observed_at, buys, sells
               ) VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(wallet, mint) DO UPDATE SET
                 first_signature = CASE WHEN excluded.first_slot < first_slot
                                        THEN excluded.first_signature ELSE first_signature END,
                 first_observed_at = MIN(first_observed_at, excluded.first_observed_at),
                 first_slot = MIN(first_slot, excluded.first_slot),
                 last_observed_at = MAX(last_observed_at, excluded.last_observed_at),
                 buys = buys + excluded.buys,
                 sells = sells + excluded.sells`,
            )
            .run(
              a.trader,
              a.mint,
              observed,
              tx.signature,
              tx.slot,
              observed,
              a.direction === 'BUY' ? 1 : 0,
              a.direction === 'SELL' ? 1 : 0,
            );
        }
      }

      for (const edge of input.edges) {
        result.edgesInserted += Number(
          this.#db
            .prepare(
              `INSERT OR IGNORE INTO transfer_edges (
                 id, signature, path, slot, block_time, kind, asset, from_owner, to_owner, amount, source, recorded_at
               ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              edge.id,
              edge.signature,
              edge.path,
              edge.slot,
              edge.blockTimeMs,
              edge.kind,
              edge.asset,
              edge.from,
              edge.to,
              edge.amount,
              input.source,
              recordedAt,
            ).changes,
        );
      }

      for (const event of input.events) {
        result.eventsInserted += Number(
          this.#db
            .prepare(
              `INSERT OR IGNORE INTO chain_events (
                 id, type, mint, signature, slot, block_time, pool, actor, amount, detail,
                 derived, confidence, source, recorded_at
               ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              event.id,
              event.type,
              event.mint,
              event.signature,
              event.slot,
              event.observedAt,
              event.pool,
              event.actor,
              event.amount,
              JSON.stringify(event.detail).slice(0, 500),
              boolInt(event.derived),
              event.confidence,
              event.source,
              recordedAt,
            ).changes,
        );
      }
    });

    return result;
  }

  // --- cursors and gaps -----------------------------------------------------------

  cursor(key: string): CursorRow | null {
    const row = this.#db.prepare('SELECT key, signature, slot, updated_at FROM ingest_cursors WHERE key = ?').get(key) as
      | { key: string; signature: string; slot: number; updated_at: number }
      | undefined;
    return row === undefined ? null : { key: row.key, signature: row.signature, slot: row.slot, updatedAt: row.updated_at };
  }

  /** Moves a cursor forward. Never backward: an older signature does not replace a newer one. */
  advanceCursor(key: string, signature: string, slot: number, at: number = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO ingest_cursors (key, signature, slot, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET
           signature = CASE WHEN excluded.slot >= slot THEN excluded.signature ELSE signature END,
           slot = MAX(slot, excluded.slot),
           updated_at = excluded.updated_at`,
      )
      .run(key, signature, slot, at);
  }

  recordGap(
    key: string,
    gap: { fromSlot: number | null; toSlot: number | null; skipped: number | null; reason: string },
    at: number = Date.now(),
  ): void {
    this.#db
      .prepare('INSERT INTO ingest_gaps (key, from_slot, to_slot, skipped, reason, recorded_at) VALUES (?,?,?,?,?,?)')
      .run(key, gap.fromSlot, gap.toSlot, gap.skipped, gap.reason, at);
  }

  // --- reads for surfaces and the next phases ----------------------------------------

  /** Wallets in the order they first traded a mint - the input for buyer analysis. */
  buyerArrivals(mint: string, limit = 200): BuyerArrival[] {
    const rows = this.#db
      .prepare(
        `SELECT a.wallet, a.first_observed_at, a.first_slot, a.first_signature, a.buys, a.sells, w.on_curve
           FROM wallet_token_activity a LEFT JOIN wallets w ON w.address = a.wallet
          WHERE a.mint = ? ORDER BY a.first_slot, a.first_observed_at LIMIT ?`,
      )
      .all(mint, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      wallet: String(r.wallet),
      firstObservedAt: Number(r.first_observed_at),
      firstSlot: Number(r.first_slot),
      firstSignature: String(r.first_signature),
      buys: Number(r.buys),
      sells: Number(r.sells),
      onCurve: r.on_curve === null || r.on_curve === undefined ? null : r.on_curve === 1,
    }));
  }

  /** A mint's recorded pool activity, in chain order (slot, then position in block). */
  activityOf(mint: string, limit = 200): ActivityRow[] {
    const rows = this.#db
      .prepare(
        `SELECT signature, pool, slot, block_time, kind, reason, direction, trader, trader_resolution,
                token_amount, quote_mint, quote_amount, price_in_quote, confidence
           FROM pool_activity WHERE mint = ?
          ORDER BY slot DESC, tx_index DESC LIMIT ?`,
      )
      .all(mint, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      signature: String(r.signature),
      pool: String(r.pool),
      slot: Number(r.slot),
      blockTime: r.block_time === null ? null : Number(r.block_time),
      kind: String(r.kind),
      reason: (r.reason as string | null) ?? null,
      direction: (r.direction as string | null) ?? null,
      trader: (r.trader as string | null) ?? null,
      traderResolution: (r.trader_resolution as string | null) ?? null,
      tokenAmount: (r.token_amount as string | null) ?? null,
      quoteMint: (r.quote_mint as string | null) ?? null,
      quoteAmount: (r.quote_amount as string | null) ?? null,
      priceInQuote: r.price_in_quote === null ? null : Number(r.price_in_quote),
      confidence: Number(r.confidence),
    }));
  }

  /** Transfer edges touching a wallet, newest first - the wallet-graph phase's input. */
  edgesOf(address: string, limit = 200): TransferEdge[] {
    const rows = this.#db
      .prepare(
        `SELECT id, signature, path, slot, block_time, kind, asset, from_owner, to_owner, amount FROM transfer_edges
          WHERE from_owner = ? OR to_owner = ? ORDER BY slot DESC LIMIT ?`,
      )
      .all(address, address, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      signature: String(r.signature),
      path: String(r.path),
      slot: Number(r.slot),
      blockTimeMs: r.block_time === null ? null : Number(r.block_time),
      kind: r.kind as TransferEdge['kind'],
      asset: String(r.asset),
      from: String(r.from_owner),
      to: String(r.to_owner),
      amount: String(r.amount),
    }));
  }

  /** Low-volume chain events for a mint, in chain order. */
  eventsOf(mint: string): { type: string; slot: number; blockTime: number | null; actor: string | null; amount: string | null; detail: string | null; derived: boolean }[] {
    const rows = this.#db
      .prepare(
        `SELECT type, slot, block_time, actor, amount, detail, derived FROM chain_events
          WHERE mint = ? ORDER BY slot, type`,
      )
      .all(mint) as Record<string, unknown>[];
    return rows.map((r) => ({
      type: String(r.type),
      slot: Number(r.slot),
      blockTime: r.block_time === null ? null : Number(r.block_time),
      actor: (r.actor as string | null) ?? null,
      amount: (r.amount as string | null) ?? null,
      detail: (r.detail as string | null) ?? null,
      derived: r.derived === 1,
    }));
  }

  /** Counts for the System surface. Cheap: indexed or small. */
  stats(now: number = Date.now()): BackboneStats {
    const one = (sql: string, ...params: (number | string)[]): number =>
      Number((this.#db.prepare(sql).get(...params) as { c: number | null } | undefined)?.c ?? 0);
    const hour = now - 3_600_000;
    const day = now - 86_400_000;
    const kinds = this.#db.prepare('SELECT kind, COUNT(*) AS c FROM pool_activity GROUP BY kind').all() as {
      kind: string;
      c: number;
    }[];
    const latest = this.#db
      .prepare('SELECT MAX(block_time) AS b, MAX(recorded_at) AS r FROM chain_transactions')
      .get() as { b: number | null; r: number | null };
    return {
      transactions: one('SELECT COUNT(*) AS c FROM chain_transactions'),
      transactionsLastHour: one('SELECT COUNT(*) AS c FROM chain_transactions WHERE recorded_at >= ?', hour),
      failedLastHour: one("SELECT COUNT(*) AS c FROM chain_transactions WHERE recorded_at >= ? AND status = 'FAILED'", hour),
      activityByKind: Object.fromEntries(kinds.map((k) => [k.kind, k.c])),
      launches: one('SELECT COUNT(*) AS c FROM token_launches'),
      launchesLastHour: one('SELECT COUNT(*) AS c FROM token_launches WHERE recorded_at >= ?', hour),
      wallets: one('SELECT COUNT(*) AS c FROM wallets'),
      edges: one('SELECT COUNT(*) AS c FROM transfer_edges'),
      chainEvents: one('SELECT COUNT(*) AS c FROM chain_events'),
      discoveries: one('SELECT COUNT(*) AS c FROM token_discoveries'),
      gapsLastDay: one('SELECT COUNT(*) AS c FROM ingest_gaps WHERE recorded_at >= ?', day),
      skippedLastDay: one('SELECT SUM(skipped) AS c FROM ingest_gaps WHERE recorded_at >= ?', day),
      latestBlockTime: latest.b,
      latestRecordedAt: latest.r,
    };
  }
}

function toLaunch(row: Record<string, unknown>): LaunchRow {
  return {
    mint: String(row.mint),
    venue: String(row.venue),
    signature: String(row.signature),
    slot: Number(row.slot),
    blockTime: row.block_time === null ? null : Number(row.block_time),
    feePayer: String(row.fee_payer),
    tokenProgram: String(row.token_program),
    pool: (row.pool as string | null) ?? null,
    poolConfirmed: row.pool_confirmed === 1,
    recordedAt: Number(row.recorded_at),
  };
}
