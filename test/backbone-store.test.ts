/**
 * The data backbone's persistence, with no network.
 *
 * The runner is driven by a fake RPC that serves the recorded mainnet
 * fixtures, against real SQLite databases in temp directories - so migration,
 * deduplication, restart, outage, budget and retention are exercised exactly
 * as they run, minus the public endpoint.
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDatabase } from '../src/persist/db.ts';
import { currentSchemaVersion, migrate, MIGRATIONS, TARGET_SCHEMA_VERSION } from '../src/persist/migrations.ts';
import { applyRetention, DEFAULT_RETENTION } from '../src/persist/retention.ts';
import { ChainRepository } from '../src/persist/chain-repository.ts';
import { Repository } from '../src/persist/repository.ts';
import { normalizeTransaction } from '../src/ingest/normalize.ts';
import { derivePoolActivity } from '../src/ingest/activity.ts';
import type { TokenSnapshot } from '../src/types.ts';
import { cleanupTempDirs, harness, snapshot, tempDir } from './persist-helpers.ts';

after(cleanupTempDirs);

const DIR = join(import.meta.dirname, 'fixtures', 'chain');
const load = (file: string): Record<string, unknown> => JSON.parse(readFileSync(join(DIR, file), 'utf8')) as Record<string, unknown>;
const META = load('pumpfun-trade-meta.json') as { mint: string; curve: string };

/** A survivor whose best pair is the fixture curve. */
function survivor(now: number): TokenSnapshot {
  const s = snapshot({ mint: META.mint, at: now, eligibility: 'QUALIFIED', state: 'QUALIFIED' });
  return { ...s, pair: { ...(s.pair as NonNullable<TokenSnapshot['pair']>), pairAddress: META.curve, dexId: 'pumpfun' } };
}

/** A harness with the survivor's token row present, as the scan would leave it. */
function tracked() {
  const h = harness();
  const now = Date.now();
  const token = survivor(now);
  h.repo.saveTokenSnapshot(token, { scanId: null });
  return { h, chain: new ChainRepository(h.db), token, now };
}

const count = (h: ReturnType<typeof harness>, table: string): number =>
  (h.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

describe('migration 2', () => {
  test('a fresh database reaches the target version with every backbone table', () => {
    const h = harness();
    assert.equal(currentSchemaVersion(h.db), TARGET_SCHEMA_VERSION);
    assert.equal(TARGET_SCHEMA_VERSION, 3);
    for (const table of ['token_discoveries', 'token_launches', 'chain_transactions', 'pool_activity', 'transfer_edges', 'wallets', 'wallet_token_activity', 'chain_events', 'ingest_cursors', 'ingest_gaps']) {
      assert.equal(count(h, table), 0, table);
    }
    h.close();
  });

  test('a v1 database with history migrates forward without touching that history', () => {
    const dir = tempDir();
    const path = join(dir, 'v1.sqlite');
    const opened = openDatabase({ path, migrateSchema: false });
    assert.ok(opened.db);
    const v1 = MIGRATIONS[0];
    assert.ok(v1);
    opened.db.exec('BEGIN');
    for (const statement of v1.statements) opened.db.exec(statement);
    opened.db.exec('PRAGMA user_version = 1');
    opened.db.exec('COMMIT');
    new Repository(opened.db).saveTokenSnapshot(snapshot({ mint: META.mint }), { scanId: null });
    const before = (opened.db.prepare('SELECT COUNT(*) AS c FROM token_snapshots').get() as { c: number }).c;
    assert.deepEqual(migrate(opened.db), [2, 3]);
    assert.deepEqual(migrate(opened.db), [], 'idempotent');
    assert.equal((opened.db.prepare('SELECT COUNT(*) AS c FROM token_snapshots').get() as { c: number }).c, before);
    assert.equal(currentSchemaVersion(opened.db), TARGET_SCHEMA_VERSION);
    opened.db.close();
  });

  test('the schema refuses impossible rows', () => {
    const { h } = tracked();
    assert.throws(() =>
      h.db.prepare(`INSERT INTO pool_activity (signature,pool,mint,slot,kind,fee_payer,confidence,source,recorded_at) VALUES ('s','p',?,1,'GUESS','f',1,'t',1)`).run(META.mint),
    );
    assert.throws(() =>
      h.db.prepare(`INSERT INTO pool_activity (signature,pool,mint,slot,kind,fee_payer,confidence,source,recorded_at) VALUES ('s','p',?,1,'SWAP','f',1.5,'t',1)`).run(META.mint),
    );
    assert.throws(() => h.db.prepare(`INSERT INTO chain_events (id,type,signature,slot,derived,confidence,source,recorded_at) VALUES ('i','WALLET_FUNDED','s',1,0,1,'t',1)`).run());
    h.close();
  });
});


describe('idempotent writes and chain order', () => {
  test('writing the same transaction twice changes nothing, including the arrival counters', () => {
    const { h, chain } = tracked();
    const tx = normalizeTransaction(load('pumpfun-curve-01.json'));
    assert.ok(tx);
    const activity = derivePoolActivity(tx, META.mint, META.curve);
    const input = { tx, txIndex: 3, activity: [activity], edges: [], events: [], wallets: [{ address: activity.trader as string, onCurve: true }], source: 't', commitment: 'finalized' };
    const first = chain.saveIngested(input);
    const second = chain.saveIngested(input);
    assert.deepEqual([first.transactionInserted, first.activityInserted], [true, 1]);
    assert.deepEqual([second.transactionInserted, second.activityInserted], [false, 0]);
    const row = h.db.prepare('SELECT buys, sells FROM wallet_token_activity').get() as { buys: number; sells: number };
    assert.equal(row.buys + row.sells, 1);
    h.close();
  });

  test('out-of-order ingestion still yields true first arrival and chain order', () => {
    const { h, chain } = tracked();
    const a = normalizeTransaction(load('pumpfun-curve-08.json'));
    const b = normalizeTransaction(load('pumpfun-curve-10.json'));
    assert.ok(a !== null && b !== null);
    const [later, earlier] = a.slot > b.slot ? [a, b] : [b, a];
    for (const t of [later, earlier]) {
      const activity = derivePoolActivity(t, META.mint, META.curve);
      chain.saveIngested({ tx: t, txIndex: null, activity: [activity], edges: [], events: [], wallets: [], source: 't', commitment: 'finalized' });
    }
    const arrival = chain.buyerArrivals(META.mint)[0];
    assert.ok(arrival);
    assert.equal(arrival.firstSlot, earlier.slot);
    assert.equal(arrival.firstSignature, earlier.signature);
    assert.equal(arrival.buys + arrival.sells, 2);
    const ordered = chain.activityOf(META.mint);
    assert.equal(ordered[0]?.slot, later.slot, 'newest first by slot');
    h.close();
  });
});

describe('discovery provenance', () => {
  test('first and latest sightings per source, and the chain\'s lead over the feeds', () => {
    const h = harness();
    const chain = new ChainRepository(h.db);
    chain.recordDiscoveries([{ mint: 'M1', source: 'chain:pumpfun' }], 1_000);
    chain.recordDiscoveries([{ mint: 'M1', source: 'jupiter:recent' }], 61_000);
    chain.recordDiscoveries([{ mint: 'M1', source: 'jupiter:recent' }], 121_000);
    const seen = chain.discoveriesOf('M1');
    assert.deepEqual(seen.map((s) => [s.source, s.firstSeenAt, s.timesSeen]), [['chain:pumpfun', 1_000, 1], ['jupiter:recent', 61_000, 2]]);
    assert.deepEqual(chain.chainLead(0), { mints: 1, medianLeadMs: 60_000, medianFeedDelayMs: null });
    h.close();
  });
});

describe('retention', () => {
  test('a launch that became a tracked token outlives the launch window', () => {
    const { h, chain } = tracked();
    chain.saveLaunch({ mint: META.mint, venue: 'pumpfun', signature: 'sig', slot: 1, blockTimeMs: 1_000, feePayer: 'p', tokenProgram: 'x', decimals: 6, initialSupply: '1', pool: META.curve, poolConfirmed: true, feePayerInitialBalance: '0', mintAuthorityRevoked: true }, 't', 1_000);
    applyRetention(h.db, { ...DEFAULT_RETENTION, tokenDays: 100_000, launchDays: 1 }, 10 * 86_400_000);
    assert.ok(chain.launch(META.mint));
    h.close();
  });
});

describe('no secret persistence', () => {
  test('a keyed RPC URL never reaches a row: the source is a label, errors are redacted', () => {
    const dir = tempDir();
    const script = `
      const { rpcEndpoint } = await import('./src/sources/solana-rpc.ts');
      const { openDatabase } = await import('./src/persist/db.ts');
      const { ChainRepository } = await import('./src/persist/chain-repository.ts');
      const { normalizeTransaction } = await import('./src/ingest/normalize.ts');
      const fs = await import('node:fs');
      const label = rpcEndpoint().label;
      const opened = openDatabase({ path: process.env.DB });
      const chain = new ChainRepository(opened.db);
      const tx = normalizeTransaction(JSON.parse(fs.readFileSync('test/fixtures/chain/pumpfun-curve-failed.json', 'utf8')));
      tx.error = 'request to ' + process.env.SOLANA_RPC_URL + ' failed';
      chain.saveIngested({ tx, txIndex: null, activity: [], edges: [], events: [], wallets: [], source: label, commitment: 'finalized' });
      opened.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      opened.db.close();
      console.log(label);
    `;
    const secret = 'SuperSecretRpcKey-1234567890';
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, SOLANA_RPC_URL: `https://rpc.example.invalid/?api-key=${secret}`, DB: join(dir, 'x.sqlite'), TOKEN_FINDER_DATA_DIR: dir },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'solana-rpc:custom');
    const bytes = readFileSync(join(dir, 'x.sqlite'));
    assert.equal(bytes.includes(Buffer.from(secret)), false, 'the key is absent from the database file');
    assert.equal(bytes.includes(Buffer.from('rpc.example.invalid')), false, 'so is the URL');
  });
});
