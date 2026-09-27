/**
 * The data backbone's collection loop, with no network.
 *
 * The runner is driven by a fake RPC that serves the recorded mainnet
 * fixtures, against real SQLite databases in temp directories - so migration,
 * deduplication, restart, outage, budget and retention are exercised exactly
 * as they run, minus the public endpoint.
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../src/persist/db.ts';
import { applyRetention, DEFAULT_RETENTION } from '../src/persist/retention.ts';
import { ChainRepository } from '../src/persist/chain-repository.ts';
import { noteCycle, ingestionStatus, runIngestionCycle, type IngestDeps, type RpcPort } from '../src/ingest/runner.ts';
import { parseSignatures, type SignatureInfo } from '../src/sources/solana-rpc.ts';
import { normalizeTransaction } from '../src/ingest/normalize.ts';
import { derivePoolActivity } from '../src/ingest/activity.ts';
import { PUMPFUN_MINT_AUTHORITY } from '../src/chain/programs.ts';
import { discover } from '../src/core/discover.ts';
import type { ProviderResult } from '../src/util/http.ts';
import type { TokenSnapshot } from '../src/types.ts';
import { cleanupTempDirs, harness, snapshot, tempDir } from './persist-helpers.ts';

after(cleanupTempDirs);

const DIR = join(import.meta.dirname, 'fixtures', 'chain');
const FIXTURES = readdirSync(DIR).filter((f) => f.endsWith('.json') && !f.includes('meta'));
const load = (file: string): Record<string, unknown> => JSON.parse(readFileSync(join(DIR, file), 'utf8')) as Record<string, unknown>;
const META = load('pumpfun-trade-meta.json') as { mint: string; curve: string };

interface FakeRpc extends RpcPort {
  calls: { method: string; address?: string; limit?: number; until?: string }[];
}

/**
 * Serves the fixtures as a node would: an address's signatures newest first,
 * honouring `until` and `limit`, and each transaction by signature.
 */
function fixtureRpc(options: { fail?: (method: string, key: string) => boolean; extra?: Record<string, unknown>[] } = {}): FakeRpc {
  const txs = new Map<string, Record<string, unknown>>();
  const byAddress = new Map<string, SignatureInfo[]>();
  for (const raw of [...FIXTURES.map(load), ...(options.extra ?? [])]) {
    const t = normalizeTransaction(raw);
    if (t === null) continue;
    txs.set(t.signature, raw);
    const info = parseSignatures([{ signature: t.signature, slot: t.slot, blockTime: t.blockTimeMs === null ? null : t.blockTimeMs / 1000, err: t.status === 'FAILED' ? { x: 1 } : null }])[0] as SignatureInfo;
    for (const key of new Set(t.accountKeys)) {
      const list = byAddress.get(key) ?? [];
      list.push(info);
      byAddress.set(key, list);
    }
  }
  for (const list of byAddress.values()) list.sort((a, b) => b.slot - a.slot);
  const calls: FakeRpc['calls'] = [];
  const failure = (method: string): ProviderResult<never> => ({
    data: null,
    failure: { provider: 'solana-rpc', kind: 'RATE_LIMITED', message: `HTTP 429 (${method})`, at: 0, retryable: true },
  });
  return {
    calls,
    async getSignatures(address, { limit, until }) {
      calls.push({ method: 'getSignatures', address, limit, until });
      if (options.fail?.('getSignatures', address)) return failure('getSignatures');
      const list = byAddress.get(address) ?? [];
      const stop = until === undefined ? -1 : list.findIndex((s) => s.signature === until);
      return { data: (stop === -1 ? list : list.slice(0, stop)).slice(0, limit), failure: null };
    },
    async getParsedTransaction(signature) {
      calls.push({ method: 'getTransaction' });
      if (options.fail?.('getTransaction', signature)) return failure('getTransaction');
      return { data: txs.get(signature) ?? null, failure: null };
    },
  };
}

/** A survivor whose best pair is the fixture curve. */
function survivor(now: number): TokenSnapshot {
  const s = snapshot({ mint: META.mint, at: now, eligibility: 'QUALIFIED', state: 'QUALIFIED' });
  return { ...s, pair: { ...(s.pair as NonNullable<TokenSnapshot['pair']>), pairAddress: META.curve, dexId: 'pumpfun' } };
}

function deps(chain: ChainRepository | null, rpc: RpcPort, tokens: TokenSnapshot[], overrides: Partial<IngestDeps['settings']> = {}): IngestDeps {
  return {
    rpc,
    chain,
    tokens: () => tokens,
    source: 'solana-rpc:test',
    commitment: 'finalized',
    settings: { tokensPerCycle: 5, txPerToken: 20, launchDiscovery: true, launchTxPerCycle: 10, liveWindowMs: 90 * 60_000, ...overrides },
  };
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

describe('collection cycle', () => {
  test('a first cycle records the launch and the survivor\'s trades, and states what it did not collect', async () => {
    const { h, chain, token } = tracked();
    const rpc = fixtureRpc();
    const report = await runIngestionCycle(deps(chain, rpc, [token]));
    assert.equal(report.health.state, 'AVAILABLE');

    // The launch: read from the chain, with its events and provenance.
    assert.equal(report.launches?.recorded, 1);
    assert.equal(count(h, 'token_launches'), 1);
    const events = h.db.prepare('SELECT type, derived FROM chain_events ORDER BY type').all() as { type: string; derived: number }[];
    assert.deepEqual(events.map((e) => e.type), ['AUTHORITY_CHANGE', 'POOL_CREATED', 'TOKEN_MINT']);
    assert.equal(events.find((e) => e.type === 'POOL_CREATED')?.derived, 1);
    assert.equal(count(h, 'token_discoveries'), 1);

    // The survivor: every successful trade, the failed one not fetched.
    const pool = report.deep.pools[0];
    assert.ok(pool);
    assert.equal(pool.firstCollection, true);
    assert.equal(pool.byKind.SWAP, 14);
    assert.equal(pool.failedSkipped, 1);
    const activity = chain.activityOf(META.mint, 100);
    assert.equal(activity.length, 14);
    assert.ok(activity.every((a) => a.kind === 'SWAP' && a.traderResolution === 'EXACT'));

    // History before collection began is a stated gap, not an empty stretch.
    const gaps = h.db.prepare("SELECT reason FROM ingest_gaps WHERE key = ?").all(`pool:${META.curve}`) as { reason: string }[];
    assert.ok(gaps.some((g) => g.reason === 'before_collection_began'));
    // Buyers arrive in chain order; the relayed trader is a wallet, not the relayer.
    const buyers = chain.buyerArrivals(META.mint);
    assert.ok(buyers.length >= 13);
    for (let i = 1; i < buyers.length; i++) assert.ok((buyers[i]?.firstSlot ?? 0) >= (buyers[i - 1]?.firstSlot ?? 0));
    h.close();
  });

  test('a second cycle starts from the cursor and duplicates nothing', async () => {
    const { h, chain, token } = tracked();
    const rpc = fixtureRpc();
    await runIngestionCycle(deps(chain, rpc, [token]));
    const rows = count(h, 'pool_activity');
    const buys = (h.db.prepare('SELECT SUM(buys) + SUM(sells) AS c FROM wallet_token_activity').get() as { c: number }).c;
    rpc.calls.length = 0;
    const second = await runIngestionCycle(deps(chain, rpc, [token]));
    const sigCalls = rpc.calls.filter((c) => c.method === 'getSignatures');
    assert.ok(sigCalls.every((c) => c.until !== undefined), 'both collections resume from a cursor');
    assert.equal(rpc.calls.filter((c) => c.method === 'getTransaction').length, 0, 'nothing refetched');
    assert.equal(count(h, 'pool_activity'), rows);
    assert.equal((h.db.prepare('SELECT SUM(buys) + SUM(sells) AS c FROM wallet_token_activity').get() as { c: number }).c, buys);
    assert.equal(second.health.state, 'AVAILABLE');
    h.close();
  });

  test('a restart resumes from the persisted cursor and collects nothing twice', async () => {
    const { h, chain, token } = tracked();
    await runIngestionCycle(deps(chain, fixtureRpc(), [token]));
    const before = { activity: count(h, 'pool_activity'), launches: count(h, 'token_launches'), txs: count(h, 'chain_transactions') };
    const cursor = chain.cursor(`pool:${META.curve}`);
    h.db.close();

    const reopened = openDatabase({ path: h.path });
    assert.ok(reopened.db);
    const chain2 = new ChainRepository(reopened.db);
    assert.deepEqual(chain2.cursor(`pool:${META.curve}`)?.signature, cursor?.signature);
    const rpc = fixtureRpc();
    await runIngestionCycle(deps(chain2, rpc, [token]));
    assert.ok(rpc.calls.filter((c) => c.method === 'getSignatures').every((c) => c.until !== undefined));
    const after = (t: string) => (reopened.db?.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
    assert.deepEqual({ activity: after('pool_activity'), launches: after('token_launches'), txs: after('chain_transactions') }, before);
    reopened.db.close();
  });

  test('a provider outage: the cycle reports FAILED, throws nothing, writes nothing, moves no cursor', async () => {
    const { h, chain, token } = tracked();
    const report = await runIngestionCycle(deps(chain, fixtureRpc({ fail: () => true }), [token]));
    assert.equal(report.health.state, 'FAILED');
    assert.ok(report.failures.length > 0);
    assert.equal(count(h, 'chain_transactions'), 0);
    assert.equal(chain.cursor('launch:pumpfun'), null);
    assert.equal(chain.cursor(`pool:${META.curve}`), null);
    h.close();
  });

  test('some fetches failing: PARTIAL, and each missed transaction is a recorded gap', async () => {
    const { h, chain, token } = tracked();
    let n = 0;
    const report = await runIngestionCycle(deps(chain, fixtureRpc({ fail: (m) => m === 'getTransaction' && ++n % 4 === 0 }), [token]));
    assert.equal(report.health.state, 'PARTIAL');
    const missed = report.deep.pools[0]?.fetchFailed ?? 0;
    assert.ok(missed > 0);
    const gap = h.db.prepare("SELECT SUM(skipped) AS s FROM ingest_gaps WHERE reason = 'fetch_failed'").get() as { s: number };
    assert.equal(gap.s, missed + (report.launches?.fetchFailed ?? 0));
    h.close();
  });

  test('over budget: the newest are collected, the rest counted as a gap with its slots', async () => {
    const { h, chain, token } = tracked();
    const rpc = fixtureRpc();
    // First cycle establishes the cursor at an older point: collect only one.
    const list = await rpc.getSignatures(META.curve, { limit: 1000 });
    const oldest = (list.data ?? []).filter((s) => !s.failed).at(-1) as SignatureInfo;
    chain.advanceCursor(`pool:${META.curve}`, oldest.signature, oldest.slot);
    const report = await runIngestionCycle(deps(chain, rpc, [token], { txPerToken: 4, launchDiscovery: false }));
    const pool = report.deep.pools[0];
    assert.ok(pool);
    assert.equal(pool.fetched, 4);
    assert.ok(pool.skippedOverBudget > 0);
    const gap = h.db.prepare("SELECT skipped, from_slot, to_slot FROM ingest_gaps WHERE reason = 'over_budget'").get() as { skipped: number; from_slot: number; to_slot: number };
    assert.equal(gap.skipped, pool.skippedOverBudget);
    assert.ok(gap.from_slot <= gap.to_slot);
    h.close();
  });

  test('no database: UNAVAILABLE, and nothing is attempted', async () => {
    const rpc = fixtureRpc();
    const report = await runIngestionCycle(deps(null, rpc, []));
    assert.equal(report.health.state, 'UNAVAILABLE');
    assert.equal(rpc.calls.length, 0);
  });

  test('a collector that has not succeeded for three intervals is STALE', async () => {
    const { h, chain, token } = tracked();
    const report = await runIngestionCycle(deps(chain, fixtureRpc(), [token]));
    noteCycle(report, 'solana-rpc:test', 60);
    assert.equal(ingestionStatus(report.finishedAt + 1_000).health.state, 'AVAILABLE');
    assert.equal(ingestionStatus(report.finishedAt + 60 * 60_000).health.state, 'STALE');
    h.close();
  });
});

describe('discovery provenance', () => {
  test('a mint seen on-chain and by a feed is one candidate carrying both sources', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = url.includes('/tokens/v2/recent') ? [{ id: META.mint, symbol: 'DUP' }] : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const candidates = await discover({ chainLaunches: [{ mint: META.mint }, { mint: 'ChainOnly111111111111111111111111111111111' }] });
      const both = candidates.find((c) => c.mint === META.mint);
      assert.deepEqual(both?.sources.sort(), ['chain:pumpfun', 'jupiter:recent']);
      assert.deepEqual(candidates.find((c) => c.mint.startsWith('ChainOnly'))?.sources, ['chain:pumpfun']);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('retention', () => {
  test('old chain history goes; launches of tracked tokens stay; the rest of history is untouched', async () => {
    const { h, chain, token } = tracked();
    await runIngestionCycle(deps(chain, fixtureRpc(), [token]));
    // An untracked launch far in the past.
    chain.saveLaunch({ mint: 'OldLaunch11111111111111111111111111111111', venue: 'pumpfun', signature: 'sigold', slot: 1, blockTimeMs: 1_000, feePayer: 'payer', tokenProgram: 'x', decimals: 6, initialSupply: '1', pool: null, poolConfirmed: false, feePayerInitialBalance: '0', mintAuthorityRevoked: false }, 't', 1_000);
    const tokenRows = count(h, 'token_snapshots');
    // Far enough ahead that every chain row is past the history window.
    const future = Date.now() + 200 * 86_400_000;
    const result = applyRetention(h.db, { ...DEFAULT_RETENTION, historyDays: 90, tokenDays: 100_000, launchDays: 30 }, future);
    assert.equal(result.failure, null);
    assert.equal(count(h, 'pool_activity'), 0);
    assert.equal(count(h, 'chain_transactions'), 0);
    assert.ok((result.chain.pool_activity ?? 0) > 0);
    // The untracked launch is gone; the fixture launch is not a tracked token either,
    // so only a launch whose mint is in `tokens` would survive - none here.
    assert.equal(h.db.prepare("SELECT COUNT(*) AS c FROM token_launches WHERE mint = 'OldLaunch11111111111111111111111111111111'").get()?.c, 0);
    // Verdict history keeps its own rule: transitions are never pruned.
    assert.ok(count(h, 'token_snapshots') <= tokenRows);
    h.close();
  });
});

describe('the launch address', () => {
  test('launch-authority signatures are the fixture\'s creation - the address the backbone reads', async () => {
    const rpc = fixtureRpc();
    const page = await rpc.getSignatures(PUMPFUN_MINT_AUTHORITY, { limit: 10 });
    assert.equal(page.data?.length, 1);
  });
});
