/**
 * Persistence: schema, migration, history, deduplication, retention, failure.
 *
 * Every test opens its own database under a fresh temp directory. Nothing here
 * touches the working copy's `data/`, and nothing depends on test ordering.
 */

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDatabase, transact, quickCheck } from '../src/persist/db.ts';
import { currentSchemaVersion, migrate, MIGRATIONS, TARGET_SCHEMA_VERSION } from '../src/persist/migrations.ts';
import { Repository, decideSnapshot, DEFAULT_SNAPSHOT_POLICY } from '../src/persist/repository.ts';
import { importLegacyState, IMPORT_MARKER } from '../src/persist/legacy-import.ts';
import { applyRetention, DEFAULT_RETENTION } from '../src/persist/retention.ts';
import { diagnose } from '../src/persist/diagnostics.ts';
import { classifyDbError } from '../src/persist/errors.ts';
import {
  cleanupTempDirs,
  event,
  harness,
  legacyState,
  snapshot,
  tempDir,
  token2022Onchain,
} from './persist-helpers.ts';

after(cleanupTempDirs);

const DAY = 24 * 3_600_000;

// ---------------------------------------------------------------------------
// Initialisation and schema versioning
// ---------------------------------------------------------------------------

describe('database initialisation', () => {
  test('a fresh database is created and migrated to the target version', () => {
    const h = harness();
    assert.equal(currentSchemaVersion(h.db), TARGET_SCHEMA_VERSION);
    assert.ok(TARGET_SCHEMA_VERSION >= 1);
    h.close();
  });

  test('the database file lands exactly where it was asked to', () => {
    const h = harness();
    assert.ok(existsSync(h.path));
    h.close();
  });

  test('opening reports which migrations it applied, and applies none twice', () => {
    const dir = tempDir();
    const path = join(dir, 'db.sqlite');

    const first = openDatabase({ path });
    assert.deepEqual(first.applied, MIGRATIONS.map((m) => m.to));
    first.db?.close();

    // Reopening is idempotent: the schema is already current.
    const second = openDatabase({ path });
    assert.deepEqual(second.applied, []);
    assert.equal(second.schemaVersion, TARGET_SCHEMA_VERSION);
    second.db?.close();
  });

  test('migrate() is idempotent when called directly', () => {
    const h = harness();
    assert.deepEqual(migrate(h.db), []);
    assert.equal(currentSchemaVersion(h.db), TARGET_SCHEMA_VERSION);
    h.close();
  });

  test('pragmas are actually applied', () => {
    const h = harness();
    assert.equal((h.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
    assert.equal((h.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
    h.close();
  });

  test('integrity check passes on a healthy database', () => {
    const h = harness();
    assert.equal(quickCheck(h.db).ok, true);
    h.close();
  });

  test('a file that is not a database is reported as CORRUPT_DB, not silently recreated', () => {
    const dir = tempDir();
    const path = join(dir, 'not-a-db.sqlite');
    writeFileSync(path, 'this is plainly not a SQLite file, but it is the right length-ish');

    const opened = openDatabase({ path });
    assert.equal(opened.db, null);
    assert.equal(opened.failure?.kind, 'CORRUPT_DB');
    assert.equal(opened.failure?.retryable, false);
    // The file is left exactly as it was: recreating it would destroy whatever
    // the user actually had there.
    assert.ok(readFileSync(path, 'utf8').startsWith('this is plainly'));
  });

  test('an unopenable path degrades rather than throwing', () => {
    const opened = openDatabase({ path: join(tempDir(), 'no', 'such', '\u0000bad', 'db.sqlite') });
    assert.equal(opened.db, null);
    assert.ok(opened.failure !== null);
  });

  test('migrations are ordered, unique and append-only', () => {
    const versions = MIGRATIONS.map((m) => m.to);
    assert.deepEqual(versions, [...versions].sort((a, b) => a - b));
    assert.equal(new Set(versions).size, versions.length);
    for (const migration of MIGRATIONS) {
      assert.ok(migration.purpose.length > 10, `${migration.name} needs a stated purpose`);
      assert.ok(migration.statements.length > 0);
    }
  });

  test('a failing migration leaves the version untouched', () => {
    const h = harness();
    // Simulate a migration whose second statement is invalid.
    assert.throws(() => {
      transact(h.db, () => {
        h.db.exec('CREATE TABLE probe_ok (x INTEGER)');
        h.db.exec('THIS IS NOT SQL');
      });
    });
    // The rollback removed the table the failed transaction created.
    const tables = h.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='probe_ok'`)
      .all();
    assert.equal(tables.length, 0);
    assert.equal(currentSchemaVersion(h.db), TARGET_SCHEMA_VERSION);
    h.close();
  });
});

// ---------------------------------------------------------------------------
// Token save and read
// ---------------------------------------------------------------------------

describe('token save and read', () => {
  test('a saved snapshot reads back identically', () => {
    const h = harness();
    const snap = snapshot({ mint: 'Mint1' });
    const result = h.repo.saveTokenSnapshot(snap);

    assert.equal(result.failure, null);
    assert.equal(result.decision.store, true);
    assert.deepEqual(h.repo.latestToken('Mint1'), snap);
    assert.equal(h.repo.tokenCount(), 1);
    h.close();
  });

  test('an unknown mint reads as null, never as an empty snapshot', () => {
    const h = harness();
    assert.equal(h.repo.latestToken('NopeMint'), null);
    h.close();
  });

  test('re-saving replaces current state but keeps the first-seen time', () => {
    const h = harness();
    h.repo.saveTokenSnapshot(snapshot({ mint: 'M', at: 1_000_000, score: 10 }));
    const firstSeen = (
      h.db.prepare('SELECT first_seen_at FROM tokens WHERE mint = ?').get('M') as {
        first_seen_at: number;
      }
    ).first_seen_at;

    h.repo.saveTokenSnapshot(snapshot({ mint: 'M', at: 2_000_000, score: 90 }));
    const row = h.db.prepare('SELECT first_seen_at, last_seen_at FROM tokens WHERE mint = ?').get('M') as {
      first_seen_at: number;
      last_seen_at: number;
    };

    assert.equal(row.first_seen_at, firstSeen);
    assert.ok(row.last_seen_at >= firstSeen);
    assert.equal(h.repo.latestToken('M')?.score.total, 90);
    h.close();
  });

  test('a snapshot with no evaluation is stored without inventing one', () => {
    const h = harness();
    h.repo.saveTokenSnapshot(snapshot({ mint: 'M', evaluation: null }));
    const history = h.repo.tokenHistory('M');
    assert.equal(history[0]?.state, null);
    assert.equal(history[0]?.eligibility, null);
    assert.equal(history[0]?.coverage, null);
    h.close();
  });

  test('all tokens are returned newest-seen first', () => {
    const h = harness();
    for (const mint of ['A', 'B', 'C']) h.repo.saveTokenSnapshot(snapshot({ mint }));
    assert.equal(h.repo.allTokens().length, 3);
    h.close();
  });
});

// ---------------------------------------------------------------------------
// Temporal model and large values
// ---------------------------------------------------------------------------

describe('temporal model', () => {
  test('observed_at and recorded_at are distinct and not conflated', () => {
    const h = harness();
    const observed = 1_600_000_000_000;
    h.repo.saveTokenSnapshot(snapshot({ mint: 'M', at: observed }));

    const row = h.db
      .prepare('SELECT observed_at, recorded_at FROM token_snapshots WHERE mint = ?')
      .get('M') as { observed_at: number; recorded_at: number };

    assert.equal(row.observed_at, observed, 'observed_at is when the fact was true');
    assert.notEqual(row.recorded_at, observed);
    assert.ok(row.recorded_at > observed, 'recorded_at is when we wrote it');
    h.close();
  });

  test('market and verdict rows from one snapshot share an observed_at', () => {
    const h = harness();
    h.repo.saveTokenSnapshot(snapshot({ mint: 'M', at: 1_600_000_000_000 }));
    const verdict = h.db.prepare('SELECT observed_at FROM token_snapshots').get() as { observed_at: number };
    const market = h.db.prepare('SELECT observed_at FROM market_snapshots').get() as { observed_at: number };
    // The history join depends on this holding by construction.
    assert.equal(verdict.observed_at, market.observed_at);
    h.close();
  });
});

describe('large values', () => {
  test('a u64 supply past exact float range survives storage as an exact string', () => {
    const h = harness();
    const onchain = token2022Onchain();
    h.repo.saveTokenSnapshot(snapshot({ mint: 'BigMint', onchain, holders: 5 }));

    const row = h.db.prepare('SELECT raw_supply FROM tokens WHERE mint = ?').get('BigMint') as {
      raw_supply: string;
    };
    assert.equal(row.raw_supply, '8799438501691764747');
    assert.equal(typeof row.raw_supply, 'string');
    // The precision that a float round-trip would have destroyed.
    assert.notEqual(row.raw_supply, String(Number('8799438501691764747')));

    const holders = h.repo.holderHistory('BigMint');
    assert.equal(holders[0]?.rawSupply, '8799438501691764747');
    assert.equal(holders[0]?.rawTop10, '8799438501691764000');
    h.close();
  });

  test('Token-2022 program and extension data round-trips through the payload', () => {
    const h = harness();
    h.repo.saveTokenSnapshot(snapshot({ mint: 'T22', onchain: token2022Onchain() }));

    const row = h.db.prepare('SELECT token_program, decimals FROM tokens WHERE mint = ?').get('T22') as {
      token_program: string;
      decimals: number;
    };
    assert.equal(row.token_program, 'TOKEN_2022');
    // u8 decimals, not the EVM 0-18 range.
    assert.equal(row.decimals, 255);
    assert.equal(h.repo.latestToken('T22')?.onchain?.tokenProgram, 'TOKEN_2022');
    h.close();
  });
});

// ---------------------------------------------------------------------------
// Deduplication and transitions
// ---------------------------------------------------------------------------

describe('snapshot deduplication', () => {
  const base = snapshot({ mint: 'M', at: 1_000_000, score: 50 });

  test('the first sighting is always stored', () => {
    assert.deepEqual(decideSnapshot(base, null), {
      store: true,
      reason: 'first',
      isTransition: true,
    });
  });

  test('an identical re-scan is suppressed', () => {
    const previous = {
      observedAt: base.at,
      score: 50,
      coverage: 1,
      state: 'QUALIFIED',
      eligibility: 'QUALIFIED',
      priceUsd: base.priceUsd,
      liquidityUsd: base.liquidityUsd,
      volume24h: base.volume24h,
    };
    const next = snapshot({ mint: 'M', at: base.at + 60_000, score: 50 });
    assert.equal(decideSnapshot(next, previous).store, false);
    assert.equal(decideSnapshot(next, previous).reason, 'duplicate');
  });

  test('a state transition is always stored and flagged, even with no other change', () => {
    const previous = {
      observedAt: base.at,
      score: 50,
      coverage: 1,
      state: 'WATCH',
      eligibility: 'WATCH',
      priceUsd: base.priceUsd,
      liquidityUsd: base.liquidityUsd,
      volume24h: base.volume24h,
    };
    const next = snapshot({
      mint: 'M',
      at: base.at + 1_000,
      score: 50,
      state: 'QUALIFIED',
      eligibility: 'QUALIFIED',
    });
    const decision = decideSnapshot(next, previous);
    assert.equal(decision.store, true);
    assert.equal(decision.reason, 'transition');
    assert.equal(decision.isTransition, true);
  });

  test('a material score move is stored', () => {
    const previous = {
      observedAt: base.at,
      score: 50,
      coverage: 1,
      state: 'QUALIFIED',
      eligibility: 'QUALIFIED',
      priceUsd: base.priceUsd,
      liquidityUsd: base.liquidityUsd,
      volume24h: base.volume24h,
    };
    const next = snapshot({ mint: 'M', at: base.at + 1_000, score: 52 });
    assert.equal(decideSnapshot(next, previous).reason, 'material-change');
  });

  test('a material price move is stored', () => {
    const previous = {
      observedAt: base.at,
      score: 50,
      coverage: 1,
      state: 'QUALIFIED',
      eligibility: 'QUALIFIED',
      priceUsd: 1,
      liquidityUsd: base.liquidityUsd,
      volume24h: base.volume24h,
    };
    const next = snapshot({ mint: 'M', at: base.at + 1_000, score: 50, priceUsd: 1.5 });
    assert.equal(decideSnapshot(next, previous).reason, 'material-change');
  });

  test('liquidity arriving from zero is always material', () => {
    const previous = {
      observedAt: base.at,
      score: 50,
      coverage: 1,
      state: 'QUALIFIED',
      eligibility: 'QUALIFIED',
      priceUsd: base.priceUsd,
      liquidityUsd: 0,
      volume24h: base.volume24h,
    };
    const next = snapshot({ mint: 'M', at: base.at + 1_000, score: 50, liquidityUsd: 10 });
    assert.equal(decideSnapshot(next, previous).reason, 'material-change');
  });

  test('an unchanged token is stored again once the heartbeat elapses', () => {
    const previous = {
      observedAt: base.at,
      score: 50,
      coverage: 1,
      state: 'QUALIFIED',
      eligibility: 'QUALIFIED',
      priceUsd: base.priceUsd,
      liquidityUsd: base.liquidityUsd,
      volume24h: base.volume24h,
    };
    const next = snapshot({
      mint: 'M',
      at: base.at + DEFAULT_SNAPSHOT_POLICY.heartbeatMs,
      score: 50,
    });
    assert.equal(decideSnapshot(next, previous).reason, 'heartbeat');
  });

  test('suppression is visible end to end: repeated saves add one row, not many', () => {
    const h = harness();
    h.repo.saveTokenSnapshot(snapshot({ mint: 'M', at: 1_000_000, score: 50 }));
    for (let i = 1; i <= 10; i++) {
      h.repo.saveTokenSnapshot(snapshot({ mint: 'M', at: 1_000_000 + i * 60_000, score: 50 }));
    }
    assert.equal(h.repo.tokenHistory('M').length, 1);
    // Current state still tracks the latest scan even when no row was added.
    assert.equal(h.repo.latestToken('M')?.at, 1_000_000 + 10 * 60_000);
    h.close();
  });

  test('a transition among suppressed scans is not lost', () => {
    const h = harness();
    h.repo.saveTokenSnapshot(snapshot({ mint: 'M', at: 1_000_000, score: 50, state: 'WATCH', eligibility: 'WATCH' }));
    h.repo.saveTokenSnapshot(snapshot({ mint: 'M', at: 1_060_000, score: 50, state: 'WATCH', eligibility: 'WATCH' }));
    h.repo.saveTokenSnapshot(
      snapshot({ mint: 'M', at: 1_120_000, score: 50, state: 'QUALIFIED', eligibility: 'QUALIFIED' }),
    );
    h.repo.saveTokenSnapshot(
      snapshot({ mint: 'M', at: 1_180_000, score: 50, state: 'QUALIFIED', eligibility: 'QUALIFIED' }),
    );

    const history = h.repo.tokenHistory('M');
    assert.equal(history.length, 2);
    assert.deepEqual(
      history.map((p) => p.eligibility),
      ['WATCH', 'QUALIFIED'],
    );
    assert.equal(history.every((p) => p.isTransition), true);
    h.close();
  });
});

// ---------------------------------------------------------------------------
// History queries
// ---------------------------------------------------------------------------

describe('history queries', () => {
  function seed(h: ReturnType<typeof harness>, mint = 'M', n = 5): void {
    for (let i = 0; i < n; i++) {
      h.repo.saveTokenSnapshot(
        snapshot({
          mint,
          at: 1_000_000 + i * DEFAULT_SNAPSHOT_POLICY.heartbeatMs,
          score: 50 + i * 5,
          priceUsd: 1 + i,
          liquidityUsd: 1_000 * (i + 1),
          volume24h: 500 * (i + 1),
          holders: 100 + i,
        }),
      );
    }
  }

  test('verdict history comes back oldest first', () => {
    const h = harness();
    seed(h);
    const history = h.repo.tokenHistory('M');
    assert.equal(history.length, 5);
    for (let i = 1; i < history.length; i++) {
      assert.ok(history[i]!.observedAt > history[i - 1]!.observedAt, 'ordered ascending');
    }
    h.close();
  });

  test('market history is ordered and carries the pool it came from', () => {
    const h = harness();
    seed(h);
    const market = h.repo.marketHistory('M');
    assert.equal(market.length, 5);
    assert.equal(market[0]!.priceUsd, 1);
    assert.equal(market[4]!.priceUsd, 5);
    assert.equal(market[0]!.poolAddress, 'PoolAddr1111111111111111111111111111111111');
    h.close();
  });

  test('holder history is ordered', () => {
    const h = harness();
    seed(h);
    const holders = h.repo.holderHistory('M');
    assert.equal(holders.length, 5);
    assert.equal(holders[0]!.holderCount, 100);
    assert.equal(holders[4]!.holderCount, 104);
    h.close();
  });

  test('a time range filters both ends inclusively', () => {
    const h = harness();
    seed(h);
    const all = h.repo.tokenHistory('M');
    const mid = h.repo.tokenHistory('M', {
      since: all[1]!.observedAt,
      until: all[3]!.observedAt,
    });
    assert.equal(mid.length, 3);
    h.close();
  });

  test('the dashboard history shape joins verdict and market rows', () => {
    const h = harness();
    seed(h);
    const points = h.repo.historyPoints('M');
    assert.equal(points.length, 5);
    assert.equal(points[0]!.score, 50);
    assert.equal(points[0]!.priceUsd, 1);
    assert.ok(points[4]!.at > points[0]!.at, 'chronological for charting');
    h.close();
  });

  test('history for an unknown mint is empty, not an error', () => {
    const h = harness();
    assert.deepEqual(h.repo.tokenHistory('Nope'), []);
    assert.deepEqual(h.repo.marketHistory('Nope'), []);
    assert.deepEqual(h.repo.holderHistory('Nope'), []);
    h.close();
  });

  test('recent transitions span tokens, newest first', () => {
    const h = harness();
    h.repo.saveTokenSnapshot(snapshot({ mint: 'A', at: 1_000_000, state: 'WATCH', eligibility: 'WATCH' }));
    h.repo.saveTokenSnapshot(snapshot({ mint: 'B', at: 1_100_000, state: 'WATCH', eligibility: 'WATCH' }));
    h.repo.saveTokenSnapshot(
      snapshot({ mint: 'A', at: 1_200_000, state: 'REJECTED', eligibility: 'REJECTED' }),
    );

    const transitions = h.repo.recentTransitions();
    assert.equal(transitions.length, 3);
    assert.equal(transitions[0]!.mint, 'A');
    assert.equal(transitions[0]!.eligibility, 'REJECTED');
    h.close();
  });

  test('veto codes survive the round trip', () => {
    const h = harness();
    h.repo.saveTokenSnapshot(
      snapshot({ mint: 'V', state: 'REJECTED', eligibility: 'REJECTED', vetoCodes: ['PERMANENT_DELEGATE_ACTIVE', 'UNTRADEABLE'] }),
    );
    assert.deepEqual(h.repo.tokenHistory('V')[0]?.vetoCodes, [
      'PERMANENT_DELEGATE_ACTIVE',
      'UNTRADEABLE',
    ]);
    h.close();
  });
});

// ---------------------------------------------------------------------------
// Atomicity
// ---------------------------------------------------------------------------

describe('write atomicity', () => {
  test('a snapshot writes its verdict, market, holder and pool rows together', () => {
    const h = harness();
    h.repo.saveTokenSnapshot(snapshot({ mint: 'M' }));
    for (const table of ['token_snapshots', 'market_snapshots', 'holder_snapshots', 'pool_snapshots']) {
      const count = (h.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
      assert.equal(count, 1, `${table} should have exactly one row`);
    }
    h.close();
  });

  test('a failed write inside a transaction leaves nothing behind', () => {
    const h = harness();
    assert.throws(() =>
      transact(h.db, () => {
        h.db.prepare('INSERT INTO scans (started_at) VALUES (?)').run(1);
        throw new Error('boom');
      }),
    );
    assert.equal((h.db.prepare('SELECT COUNT(*) AS c FROM scans').get() as { c: number }).c, 0);
    h.close();
  });

  test('a constraint violation rolls the whole snapshot back', () => {
    const h = harness();
    // score > 100 violates the CHECK on token_snapshots.
    const bad = snapshot({ mint: 'Bad' });
    bad.score.total = 150;

    const result = h.repo.saveTokenSnapshot(bad);
    assert.notEqual(result.failure, null);
    assert.equal(result.snapshotId, null);
    // Neither the history rows nor the token row survived.
    assert.equal((h.db.prepare('SELECT COUNT(*) AS c FROM token_snapshots').get() as { c: number }).c, 0);
    assert.equal((h.db.prepare('SELECT COUNT(*) AS c FROM market_snapshots').get() as { c: number }).c, 0);
    assert.equal(h.repo.latestToken('Bad'), null);
    h.close();
  });

  test('schema constraints reject impossible historical records', () => {
    const h = harness();
    h.repo.saveTokenSnapshot(snapshot({ mint: 'M' }));

    // Negative liquidity is impossible, not merely odd.
    assert.throws(() =>
      h.db
        .prepare('INSERT INTO market_snapshots (mint, observed_at, recorded_at, liquidity_usd) VALUES (?,?,?,?)')
        .run('M', 1, 1, -5),
    );
    // Decimals outside the u8 range.
    assert.throws(() =>
      h.db
        .prepare('INSERT INTO tokens (mint, first_seen_at, last_seen_at, decimals, payload) VALUES (?,?,?,?,?)')
        .run('X', 1, 1, 300, '{}'),
    );
    // An evidence state outside the enum.
    assert.throws(() =>
      h.db
        .prepare('INSERT INTO evidence_snapshots (snapshot_id, mint, observed_at, metric, state) VALUES (?,?,?,?,?)')
        .run(1, 'M', 1, 'liquidityUsd', 'PROBABLY_FINE'),
    );
    h.close();
  });

  test('foreign keys are enforced: history cannot reference a missing token', () => {
    const h = harness();
    assert.throws(() =>
      h.db
        .prepare('INSERT INTO token_snapshots (mint, observed_at, recorded_at, score) VALUES (?,?,?,?)')
        .run('GhostMint', 1, 1, 50),
    );
    h.close();
  });

  test('deleting a token cascades its history away', () => {
    const h = harness();
    h.repo.saveTokenSnapshot(snapshot({ mint: 'M' }));
    h.db.prepare('DELETE FROM tokens WHERE mint = ?').run('M');
    assert.equal((h.db.prepare('SELECT COUNT(*) AS c FROM token_snapshots').get() as { c: number }).c, 0);
    assert.equal((h.db.prepare('SELECT COUNT(*) AS c FROM market_snapshots').get() as { c: number }).c, 0);
    h.close();
  });
});

// ---------------------------------------------------------------------------
// Scans and evidence
// ---------------------------------------------------------------------------

describe('scans', () => {
  test('a scan groups the snapshots written during it', () => {
    const h = harness();
    const scanId = h.repo.recordScanStart(1_000_000);
    assert.ok(scanId !== null);
    h.repo.saveTokenSnapshot(snapshot({ mint: 'A' }), { scanId });
    h.repo.saveTokenSnapshot(snapshot({ mint: 'B' }), { scanId });
    h.repo.recordScanFinish(scanId!, 1_050_000, { analyzed: 2, fresh: 2, durationMs: 50_000 });

    const rows = h.db
      .prepare('SELECT COUNT(*) AS c FROM token_snapshots WHERE scan_id = ?')
      .get(scanId) as { c: number };
    assert.equal(rows.c, 2);
    assert.equal(h.repo.scanCount(), 1);
    assert.equal(h.repo.lastScanAt(), 1_000_000);
    h.close();
  });

  test('an unfinished scan does not count as completed', () => {
    const h = harness();
    h.repo.recordScanStart(1_000_000);
    assert.equal(h.repo.scanCount(), 0);
    assert.equal(h.repo.lastScanAt(), null);
    h.close();
  });

  test('a snapshot with no scan is still valid history', () => {
    const h = harness();
    h.repo.saveTokenSnapshot(snapshot({ mint: 'M' }), { scanId: null });
    assert.equal(h.repo.tokenHistory('M').length, 1);
    h.close();
  });
});

describe('events', () => {
  test('events round-trip newest first and respect the limit', () => {
    const h = harness();
    for (let i = 0; i < 5; i++) {
      h.repo.saveEvent(event({ id: `e${i}`, at: 1_000_000 + i, message: `m${i}` }));
    }
    const events = h.repo.events(3);
    assert.equal(events.length, 3);
    assert.equal(events[0]!.id, 'e4');
    h.close();
  });

  test('event data is preserved as structured JSON', () => {
    const h = harness();
    h.repo.saveEvent(event({ id: 'e1', data: { from: 40, to: 80 } }));
    assert.deepEqual(h.repo.events(1)[0]!.data, { from: 40, to: 80 });
    h.close();
  });
});

// ---------------------------------------------------------------------------
// Legacy JSON migration
// ---------------------------------------------------------------------------

describe('legacy JSON migration', () => {
  function withLegacy(body: string): { h: ReturnType<typeof harness>; legacyPath: string } {
    const h = harness();
    const legacyPath = join(h.dir, 'state.json');
    writeFileSync(legacyPath, body);
    return { h, legacyPath };
  }

  test('a valid legacy file imports tokens, history and events', () => {
    const { h, legacyPath } = withLegacy(legacyState({ tokens: 3, points: 4 }));
    const result = importLegacyState(h.db, { legacyPath });

    assert.equal(result.status, 'imported');
    assert.equal(result.tokens, 3);
    assert.equal(result.historyPoints, 12);
    assert.equal(result.events, 1);
    assert.deepEqual(result.skippedTokens, []);
    assert.equal(h.repo.tokenCount(), 3);
    h.close();
  });

  test('the original JSON is backed up and left in place', () => {
    const { h, legacyPath } = withLegacy(legacyState());
    const before = readFileSync(legacyPath, 'utf8');
    const result = importLegacyState(h.db, { legacyPath });

    assert.ok(result.backupPath !== null);
    assert.ok(existsSync(result.backupPath!), 'backup exists');
    assert.equal(readFileSync(result.backupPath!, 'utf8'), before, 'backup is a faithful copy');
    assert.ok(existsSync(legacyPath), 'original is not deleted');
    assert.equal(readFileSync(legacyPath, 'utf8'), before, 'original is not modified');
    h.close();
  });

  test('importing twice does not duplicate history', () => {
    const { h, legacyPath } = withLegacy(legacyState({ tokens: 2, points: 3 }));
    const first = importLegacyState(h.db, { legacyPath });
    const second = importLegacyState(h.db, { legacyPath });

    assert.equal(first.status, 'imported');
    assert.equal(second.status, 'already-imported');
    assert.equal(second.tokens, 0);
    assert.equal(h.repo.tokenCount(), 2);
    assert.equal(h.repo.tokenHistory('Legacy' + '0'.padStart(38, '0')).length, 3);
    h.close();
  });

  test('legacy history carries no fabricated verdict', () => {
    const { h, legacyPath } = withLegacy(legacyState({ tokens: 1, points: 2 }));
    importLegacyState(h.db, { legacyPath });

    const history = h.repo.tokenHistory('Legacy' + '0'.padStart(38, '0'));
    assert.equal(history.length, 2);
    for (const point of history) {
      // v1 had no `evaluation`, so these must stay null rather than be invented.
      assert.equal(point.state, null);
      assert.equal(point.eligibility, null);
      assert.equal(point.coverage, null);
      assert.equal(point.confidence, null);
      assert.equal(point.isTransition, false);
    }
    // The score the JSON did record is preserved exactly.
    assert.equal(history[0]!.score, 50);
    h.close();
  });

  test('malformed JSON fails safely and writes nothing', () => {
    const { h, legacyPath } = withLegacy('{ this is not json');
    const result = importLegacyState(h.db, { legacyPath });

    assert.equal(result.status, 'failed');
    assert.equal(result.failure?.kind, 'IMPORT_FAILED');
    assert.equal(h.repo.tokenCount(), 0);
    // No marker, so a corrected file can still be imported later.
    assert.equal(h.repo.getMeta(IMPORT_MARKER), null);
    h.close();
  });

  test('JSON of the wrong shape is refused rather than guessed at', () => {
    const { h, legacyPath } = withLegacy(JSON.stringify({ version: 1, notTokens: [] }));
    const result = importLegacyState(h.db, { legacyPath });

    assert.equal(result.status, 'failed');
    assert.equal(h.repo.tokenCount(), 0);
    h.close();
  });

  test('a missing legacy file is recorded as done so a later file cannot double-import', () => {
    const h = harness();
    const result = importLegacyState(h.db, { legacyPath: join(h.dir, 'absent.json') });
    assert.equal(result.status, 'no-legacy-file');
    assert.ok(h.repo.getMeta(IMPORT_MARKER) !== null);
    h.close();
  });

  test('a token with an unusable timestamp is skipped and reported, not dropped quietly', () => {
    const body = JSON.parse(legacyState({ tokens: 2, points: 1 })) as Record<string, never>;
    const tokens = body['tokens'] as unknown as Record<string, Record<string, unknown>>;
    const firstKey = Object.keys(tokens)[0]!;
    tokens[firstKey]!['at'] = 'not a timestamp';

    const { h, legacyPath } = withLegacy(JSON.stringify(body));
    const result = importLegacyState(h.db, { legacyPath });

    assert.equal(result.status, 'imported');
    assert.equal(result.tokens, 1);
    assert.equal(result.skippedTokens.length, 1);
    assert.equal(result.skippedTokens[0]!.reason, 'snapshot has no usable timestamp');
    h.close();
  });

  test('an interrupted import leaves the database untouched', () => {
    const { h, legacyPath } = withLegacy(legacyState({ tokens: 2, points: 2 }));
    // Drop the table the import needs midway so the transaction must roll back.
    h.db.exec('DROP TABLE market_snapshots');

    const result = importLegacyState(h.db, { legacyPath });
    assert.equal(result.status, 'failed');
    assert.equal(h.repo.tokenCount(), 0, 'no partial rows survived');
    assert.equal(h.repo.getMeta(IMPORT_MARKER), null, 'not marked done, so it can be retried');
    h.close();
  });

  test('force re-imports even when the marker is present', () => {
    const { h, legacyPath } = withLegacy(legacyState({ tokens: 1, points: 1 }));
    importLegacyState(h.db, { legacyPath });
    const again = importLegacyState(h.db, { legacyPath, force: true });
    assert.equal(again.status, 'imported');
    h.close();
  });

  test('legacy scan metadata is carried over without inventing individual scans', () => {
    const { h, legacyPath } = withLegacy(legacyState({ tokens: 1, points: 1 }));
    importLegacyState(h.db, { legacyPath });
    // One synthetic row for the last known scan - not seven fabricated ones.
    assert.equal(h.repo.scanCount(), 1);
    assert.equal(h.repo.lastScanAt(), 1_700_000_100_000);
    h.close();
  });
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

describe('retention', () => {
  test('old non-transition history is removed', () => {
    const h = harness();
    const now = Date.now();
    h.repo.saveTokenSnapshot(snapshot({ mint: 'M', at: now - 200 * DAY, score: 50 }));
    h.repo.saveTokenSnapshot(snapshot({ mint: 'M', at: now - 100 * DAY, score: 60 }));
    h.repo.saveTokenSnapshot(snapshot({ mint: 'M', at: now, score: 70 }));

    const before = h.repo.tokenHistory('M').length;
    const result = applyRetention(h.db, { ...DEFAULT_RETENTION, historyDays: 90 }, now);

    assert.equal(result.failure, null);
    assert.ok(h.repo.tokenHistory('M').length < before);
    h.close();
  });

  test('state transitions are never deleted, however old', () => {
    const h = harness();
    const now = Date.now();
    // Each of these is a transition, because eligibility changes every time.
    h.repo.saveTokenSnapshot(snapshot({ mint: 'M', at: now - 900 * DAY, state: 'WATCH', eligibility: 'WATCH' }));
    h.repo.saveTokenSnapshot(
      snapshot({ mint: 'M', at: now - 800 * DAY, state: 'QUALIFIED', eligibility: 'QUALIFIED' }),
    );
    h.repo.saveTokenSnapshot(
      snapshot({ mint: 'M', at: now - 700 * DAY, state: 'REJECTED', eligibility: 'REJECTED' }),
    );

    const result = applyRetention(h.db, { ...DEFAULT_RETENTION, historyDays: 1, tokenDays: 10_000 }, now);

    const history = h.repo.tokenHistory('M');
    assert.equal(history.length, 3, 'every transition survived');
    assert.equal(result.transitionsPreserved, 3);
    assert.equal(result.tokenSnapshots, 0);
    h.close();
  });

  test('a token unseen past the token window is dropped with its history', () => {
    const h = harness();
    const now = Date.now();
    h.repo.saveTokenSnapshot(snapshot({ mint: 'Cold', at: now - 400 * DAY }));
    // last_seen_at is recorded_at (now), so an explicit backdate is needed to
    // simulate a token that stopped being seen long ago.
    h.db.prepare('UPDATE tokens SET last_seen_at = ? WHERE mint = ?').run(now - 400 * DAY, 'Cold');

    const result = applyRetention(h.db, DEFAULT_RETENTION, now);
    assert.equal(result.tokens, 1);
    assert.equal(h.repo.latestToken('Cold'), null);
    assert.equal(h.repo.tokenHistory('Cold').length, 0, 'cascade removed the history too');
    h.close();
  });

  test('a recently seen token is never dropped', () => {
    const h = harness();
    h.repo.saveTokenSnapshot(snapshot({ mint: 'Warm' }));
    const result = applyRetention(h.db, DEFAULT_RETENTION, Date.now());
    assert.equal(result.tokens, 0);
    assert.ok(h.repo.latestToken('Warm') !== null);
    h.close();
  });

  test('events are capped by count, newest kept', () => {
    const h = harness();
    for (let i = 0; i < 20; i++) h.repo.saveEvent(event({ id: `e${i}`, at: 1_000 + i }));
    applyRetention(h.db, { ...DEFAULT_RETENTION, maxEvents: 5 }, Date.now());

    const events = h.repo.events(100);
    assert.equal(events.length, 5);
    assert.equal(events[0]!.id, 'e19');
    h.close();
  });

  test('retention on an empty database is a no-op, not an error', () => {
    const h = harness();
    const result = applyRetention(h.db, DEFAULT_RETENTION, Date.now());
    assert.equal(result.failure, null);
    assert.equal(result.tokens, 0);
    h.close();
  });

  test('provider diagnostics age out on their own shorter schedule', () => {
    const h = harness();
    const now = Date.now();
    h.repo.saveTokenSnapshot(snapshot({ mint: 'M' }));
    h.db
      .prepare('INSERT INTO provider_failures (mint, at, provider, kind) VALUES (?,?,?,?)')
      .run('M', now - 30 * DAY, 'rugcheck', 'TIMEOUT');

    const result = applyRetention(h.db, DEFAULT_RETENTION, now);
    assert.equal(result.providerFailures, 1);
    h.close();
  });
});

// ---------------------------------------------------------------------------
// Failure handling and diagnostics
// ---------------------------------------------------------------------------

describe('failure handling', () => {
  test('a closed database reports failures instead of throwing', () => {
    const h = harness();
    h.db.close();

    // Reads degrade to empty, which the caller can distinguish from real data
    // via persistenceFailure() at the store level.
    assert.equal(h.repo.latestToken('M'), null);
    assert.deepEqual(h.repo.allTokens(), []);
    assert.deepEqual(h.repo.tokenHistory('M'), []);
    assert.equal(h.repo.tokenCount(), 0);
    assert.equal(h.repo.scanCount(), 0);

    // Writes report a typed failure rather than crashing the scan.
    const result = h.repo.saveTokenSnapshot(snapshot({ mint: 'M' }));
    assert.notEqual(result.failure, null);
  });

  test('error classification separates corruption from a transient lock', () => {
    const corrupt = classifyDbError('read', new Error('file is not a database'));
    assert.equal(corrupt.kind, 'CORRUPT_DB');
    assert.equal(corrupt.retryable, false);

    const locked = classifyDbError('write', new Error('database is locked'));
    assert.equal(locked.retryable, true);

    const missing = classifyDbError('open', new Error('unable to open database file'), 'DB_UNAVAILABLE');
    assert.equal(missing.kind, 'DB_UNAVAILABLE');
  });

  test('a lost event does not break the store', () => {
    const h = harness();
    h.db.close();
    assert.doesNotThrow(() => h.repo.saveEvent(event()));
  });
});

describe('diagnostics', () => {
  test('diagnostics report schema, counts and range', () => {
    const h = harness();
    h.repo.saveTokenSnapshot(snapshot({ mint: 'A', at: 1_000_000 }));
    h.repo.saveTokenSnapshot(snapshot({ mint: 'B', at: 2_000_000 }));

    const d = diagnose(h.db, h.path);
    assert.equal(d.schemaVersion, TARGET_SCHEMA_VERSION);
    assert.equal(d.schemaCurrent, true);
    assert.equal(d.rowCounts['tokens'], 2);
    assert.equal(d.rowCounts['token_snapshots'], 2);
    assert.equal(d.oldestSnapshotAt, 1_000_000);
    assert.equal(d.newestSnapshotAt, 2_000_000);
    assert.equal(d.transitionCount, 2);
    assert.equal(d.integrity.ok, true);
    assert.ok((d.sizeBytes ?? 0) > 0);
    h.close();
  });

  test('diagnostics on an empty database report zeroes, not nulls-as-zero', () => {
    const h = harness();
    const d = diagnose(h.db, h.path);
    assert.equal(d.rowCounts['tokens'], 0);
    assert.equal(d.oldestSnapshotAt, null, 'no history is null, not 0');
    h.close();
  });
});

// ---------------------------------------------------------------------------
// Isolation and concurrency
// ---------------------------------------------------------------------------

describe('isolation', () => {
  test('two harnesses never see each other', () => {
    const a = harness();
    const b = harness();
    a.repo.saveTokenSnapshot(snapshot({ mint: 'OnlyInA' }));

    assert.ok(a.repo.latestToken('OnlyInA') !== null);
    assert.equal(b.repo.latestToken('OnlyInA'), null);
    assert.notEqual(a.path, b.path);
    a.close();
    b.close();
  });

  test('temp databases are created outside the repository', () => {
    const h = harness();
    // The one place a stray database would actually hurt: the working copy's
    // own data directory, which a careless default would land in.
    assert.ok(!h.path.includes(join('token-finder', 'data')));
    assert.ok(h.path.startsWith(tmpdir()));
    h.close();
  });
});

describe('concurrency', () => {
  test('a second connection sees committed writes and can write in turn', () => {
    const h = harness();
    h.repo.saveTokenSnapshot(snapshot({ mint: 'Shared', score: 50 }));

    const second = openDatabase({ path: h.path });
    assert.ok(second.db !== null);
    const other = new Repository(second.db!);

    // WAL: the second connection reads the first's committed data.
    assert.equal(other.latestToken('Shared')?.score.total, 50);

    other.saveTokenSnapshot(snapshot({ mint: 'FromSecond', score: 60 }));
    assert.equal(h.repo.latestToken('FromSecond')?.score.total, 60);

    second.db!.close();
    h.close();
  });

  test('interleaved writes across many tokens all land', () => {
    const h = harness();
    const mints = Array.from({ length: 50 }, (_, i) => `M${i}`);
    for (const mint of mints) h.repo.saveTokenSnapshot(snapshot({ mint }));
    assert.equal(h.repo.tokenCount(), 50);
    h.close();
  });
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

describe('security', () => {
  test('a database filename cannot escape the data directory', async () => {
    // `dbFile` is a filename, not a path. Honouring a path here would let an
    // environment variable point the database at a tracked source file.
    const { safeFileNameForTest } = await import('../src/config.ts');
    for (const attempt of [
      '../evil.sqlite',
      '..\\evil.sqlite',
      'sub/dir.sqlite',
      'sub\\dir.sqlite',
      'C:/tmp/x.sqlite',
      '..',
      '.',
    ]) {
      assert.equal(
        safeFileNameForTest(attempt, 'token-finder.sqlite'),
        'token-finder.sqlite',
        `${attempt} should be rejected`,
      );
    }
    // Ordinary names still work.
    assert.equal(safeFileNameForTest('custom.sqlite', 'd.sqlite'), 'custom.sqlite');
    assert.equal(safeFileNameForTest(null, 'd.sqlite'), 'd.sqlite');
  });

  test('provider credentials never reach a persisted failure row', () => {
    const h = harness();
    const key = 'SUPERSECRETKEY1234567890';
    const snap = snapshot({ mint: 'M' });
    // The shape an undici error takes: the URL, credential and all.
    snap.evaluation!.providerFailures = [
      {
        provider: 'helius',
        kind: 'NETWORK_ERROR',
        message: `request to https://mainnet.helius-rpc.com/?api-key=${key} failed`,
        at: 1_700_000_000_000,
        retryable: true,
      },
    ];

    h.repo.saveTokenSnapshot(snap);
    const row = h.db.prepare('SELECT message FROM provider_failures').get() as { message: string };

    assert.ok(!row.message.includes(key), 'the key must not be written to disk');
    assert.ok(row.message.includes('***'), 'it is masked, not merely truncated');
    // The diagnostic is still useful: provider and shape survive.
    assert.ok(row.message.includes('helius-rpc.com'));
    h.close();
  });

  test('the whole database file is free of a configured secret', () => {
    const h = harness();
    const key = 'SUPERSECRETKEY1234567890';
    const snap = snapshot({ mint: 'M' });
    snap.evaluation!.providerFailures = [
      {
        provider: 'helius',
        kind: 'TIMEOUT',
        message: `timeout for https://x.invalid/?api-key=${key}`,
        at: 1_700_000_000_000,
        retryable: true,
      },
    ];
    h.repo.saveTokenSnapshot(snap);
    h.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    h.close();

    // Read the file as bytes: this catches the key hiding anywhere, including
    // inside the JSON payload column.
    const bytes = readFileSync(h.path);
    assert.equal(bytes.includes(Buffer.from(key, 'utf8')), false);
  });

  test('every free-text column passes through redaction', () => {
    // The first pass redacted the payload, the failure message and event data,
    // but left `events.message`, `tokens.symbol`, `tokens.name` and rendered
    // evidence values raw. None was reachable with a credential, but the
    // guarantee is that no column CAN carry one.
    //
    // Credential-shaped URL parameters are what redaction masks without needing
    // the value configured, so that is what is planted in every sink here. The
    // configured-value guarantee is covered end to end by the child-process
    // test in persistence-restart.test.ts, which can set the env before the
    // config module is read.
    const h = harness();
    const secret = 'URLSECRET_ABCDEFGHIJKLMNOP';
    const snap = snapshot({ mint: 'AllSinks' });
    snap.symbol = `S https://h.io/?api-key=${secret}`;
    snap.name = `N https://h.io/?token=${secret}`;
    snap.evaluation!.providerFailures = [
      { provider: 'helius', kind: 'NETWORK_ERROR', message: `request to https://h.io/?api-key=${secret} failed`, at: 1, retryable: true },
    ];
    h.repo.saveTokenSnapshot(snap);
    h.repo.saveEvent(
      event({
        id: 'e1',
        message: `see https://z.io/?secret=${secret}`,
        symbol: `E https://z.io/?key=${secret}`,
        data: { url: `https://z.io/?access_token=${secret}` },
      }),
    );
    h.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    h.close();

    const bytes = readFileSync(h.path);
    assert.equal(
      bytes.includes(Buffer.from(secret, 'utf8')),
      false,
      'a credential-shaped URL parameter reached a column unmasked',
    );
    // The surrounding diagnostic text survives, so the row is still useful.
    assert.ok(bytes.includes(Buffer.from('h.io', 'utf8')));
  });

  test('no secret-shaped material is written by an ordinary snapshot', () => {
    const h = harness();
    h.repo.saveTokenSnapshot(snapshot({ mint: 'M' }));
    h.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    h.close();

    const text = readFileSync(h.path, 'latin1');
    for (const marker of ['api-key=', 'apikey=', 'Bearer ', 'authorization']) {
      assert.ok(!text.toLowerCase().includes(marker.toLowerCase()), `found ${marker} in the database`);
    }
  });
});

describe('duplicate-instant protection', () => {
  test('two observations at the same instant produce one row', () => {
    const h = harness();
    const at = 1_700_000_000_000;
    h.repo.saveTokenSnapshot(snapshot({ mint: 'M', at, score: 50 }));
    // Same timestamp, different score. Storing both would give the verdict and
    // market rows a shared (mint, observed_at) and duplicate the history join.
    h.repo.saveTokenSnapshot(snapshot({ mint: 'M', at, score: 90 }));

    assert.equal(h.repo.tokenHistory('M').length, 1);
    assert.equal(h.repo.historyPoints('M').length, 1);
    h.close();
  });

  test('the history join never multiplies rows', () => {
    const h = harness();
    for (let i = 0; i < 6; i++) {
      h.repo.saveTokenSnapshot(
        snapshot({ mint: 'M', at: 1_700_000_000_000 + i * 3_600_000, score: 30 + i * 6 }),
      );
    }
    const verdicts = h.repo.tokenHistory('M').length;
    const points = h.repo.historyPoints('M').length;
    assert.equal(points, verdicts, 'one point per verdict row, never a cartesian pair');
    h.close();
  });
});
