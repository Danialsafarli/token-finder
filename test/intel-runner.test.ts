/**
 * The deep-intelligence cycle end to end, with no network.
 *
 * A fake history port serves synthetic wallet histories, encoded as the
 * jsonParsed transactions an RPC node returns, so the real normaliser, the
 * real repositories and a real SQLite file are all exercised. The world:
 *
 * - a token created by DEV, who later removes almost all pool liquidity;
 * - buyers A and B, funded directly by F (a quiet keypair), A paying B;
 * - buyers C and E, both paid out by X, an exchange-like hub, C depositing
 *   back to it - which must link neither of them to the other;
 * - F funded in turn by G, one hop further back.
 */

import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_SPL_TOKEN_PROGRAM_ID } from '../src/core/token-program.ts';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../src/persist/db.ts';
import { ChainRepository } from '../src/persist/chain-repository.ts';
import { IntelRepository } from '../src/persist/intel-repository.ts';
import { applyRetention, DEFAULT_RETENTION } from '../src/persist/retention.ts';
import { currentSchemaVersion, migrate, MIGRATIONS } from '../src/persist/migrations.ts';
import { analyzeToken, IntelBudget, planIntel, runIntelCycle, type HistoryPort, type IntelDeps, type IntelSettings } from '../src/intel/runner.ts';
import { guardedLargestAccounts, largestAccountsGuardState, resetLargestAccountsGuard } from '../src/sources/helius.ts';
import { WSOL_MINT } from '../src/chain/programs.ts';
import type { NormalizedTransaction } from '../src/ingest/normalize.ts';
import type { PoolActivity } from '../src/ingest/activity.ts';
import type { SignatureInfo } from '../src/sources/solana-rpc.ts';
import type { ProviderFailure } from '../src/util/failure.ts';
import type { TokenSnapshot } from '../src/types.ts';
import { cleanupTempDirs, harness, snapshot, tempDir } from './persist-helpers.ts';
import { fund, idle, mintOf, ntx, pda, swap, toRaw, wallet } from './intel-helpers.ts';

after(cleanupTempDirs);

const MINT = mintOf('runner-token');
const POOL = pda('runner-pool');
const DEV = wallet('runner-dev');
const [A, B, C, E] = ['runner-a', 'runner-b', 'runner-c', 'runner-e'].map(wallet) as [string, string, string, string];
const F = wallet('runner-funder');
const X = wallet('runner-exchange');
const G = wallet('runner-grand');
const TOKEN_PROGRAM = LEGACY_SPL_TOKEN_PROGRAM_ID;

interface World {
  asc: Map<string, NormalizedTransaction[]>;
  desc: Map<string, NormalizedTransaction[]>;
  sigCounts: Map<string, number>;
  buys: NormalizedTransaction[];
  drain: NormalizedTransaction;
  launchAt: number;
}

function buildWorld(now: number): World {
  const launchAt = now - 30 * 60_000;
  const t = (min: number): number => launchAt + min * 60_000;
  const creation = ntx({
    signature: 'creation',
    slot: Math.floor(launchAt / 400),
    blockTimeMs: launchAt,
    feePayer: DEV,
    signers: [DEV, MINT],
    mintInits: [{ path: '0', mint: MINT, decimals: 6, mintAuthority: pda('runner-authority'), freezeAuthority: null, tokenProgram: TOKEN_PROGRAM }],
    mintTos: [{ path: '1', mint: MINT, account: pda('runner-curve-ata'), amount: 1_000_000_000_000_000n, authority: pda('runner-authority') }],
  });
  const buyOf = (w: string, min: number, sol: number): NormalizedTransaction => swap({ wallet: w, mint: MINT, direction: 'BUY', tokens: BigInt(Math.round(sol * 1e12)), sol, timeMs: t(min), signature: `buy-${w.slice(0, 6)}` });
  const buys = [buyOf(A, 1, 1.5), buyOf(B, 2, 0.8), buyOf(C, 3, 2.2), buyOf(E, 5, 0.4)];
  const drain = ntx({ signature: 'drain', slot: Math.floor(t(20) / 400), blockTimeMs: t(20), feePayer: DEV, signers: [DEV] });

  const desc = new Map<string, NormalizedTransaction[]>();
  const asc = new Map<string, NormalizedTransaction[]>();
  const history = (w: string, txs: NormalizedTransaction[]): void => {
    const sorted = [...txs].sort((x, y) => x.slot - y.slot);
    asc.set(w, sorted);
    desc.set(w, [...sorted].reverse());
  };
  history(MINT, [creation, ...buys]);
  history(DEV, [fund(F, DEV, 3, t(-120), 'fund-dev'), creation, drain]);
  history(A, [fund(F, A, 2, t(-60), 'fund-a'), buys[0] as NormalizedTransaction, fund(A, B, 0.3, t(4), 'a-pays-b'), idle(A, t(6))]);
  history(B, [fund(F, B, 1, t(-50), 'fund-b'), fund(A, B, 0.3, t(4), 'a-pays-b'), buys[1] as NormalizedTransaction]);
  history(C, [fund(X, C, 5, t(-40), 'payout-c'), buys[2] as NormalizedTransaction, fund(C, X, 1, t(10), 'deposit-c')]);
  history(E, [fund(X, E, 1, t(-30), 'payout-e'), buys[3] as NormalizedTransaction]);
  history(F, [fund(G, F, 50, t(-600), 'fund-f'), fund(F, DEV, 3, t(-120), 'fund-dev'), fund(F, A, 2, t(-60), 'fund-a'), fund(F, B, 1, t(-50), 'fund-b')]);
  const sigCounts = new Map<string, number>([[F, 4], [X, 1000], [G, 3]]);
  return { asc, desc, sigCounts, buys, drain, launchAt };
}

interface FakePort extends HistoryPort {
  calls: string[];
}

function fakePort(world: World, options: { fail?: boolean; failureMessage?: string } = {}): FakePort {
  const calls: string[] = [];
  const failure = (): ProviderFailure => ({ provider: 'solana-rpc', kind: 'NETWORK_ERROR', message: options.failureMessage ?? 'unreachable', at: Date.now(), retryable: true });
  return {
    calls,
    async history(address, o) {
      calls.push(`history:${o.order}:${address}`);
      if (options.fail) return { data: null, failure: failure() };
      const list = (o.order === 'asc' ? world.asc : world.desc).get(address) ?? [];
      const wanted = o.succeededOnly ? list.filter((x) => x.status === 'SUCCESS') : list;
      return { data: { txs: wanted.slice(0, o.limit).map(toRaw), complete: wanted.length < o.limit, method: 'gtfa' }, failure: null };
    },
    async signatures(address, limit) {
      calls.push(`signatures:${address}`);
      if (options.fail) return { data: null, failure: failure() };
      const n = Math.min(limit, world.sigCounts.get(address) ?? 2);
      const newest = Date.now();
      const sigs: SignatureInfo[] = Array.from({ length: n }, (_, i) => ({ signature: `s-${address.slice(0, 4)}-${i}`, slot: 1_000_000 - i, blockTimeMs: newest - i * 3_000, failed: false, transactionIndex: null }));
      return { data: sigs, failure: null };
    },
    async transaction(signature) {
      calls.push(`transaction:${signature}`);
      return { data: null, failure: options.fail ? failure() : null };
    },
  };
}

const SETTINGS: IntelSettings = {
  tokensPerCycle: 2,
  walletsPerToken: 12,
  txPerWallet: 100,
  ascLimit: 10,
  graphDepth: 2,
  requestsPerCycle: 100,
  cycleMaxMs: 60_000,
  profileTtlMs: 6 * 3_600_000,
  tokenRefreshMs: 30 * 60_000,
  liveWindowMs: 60 * 60_000,
};

function activity(tx: NormalizedTransaction, a: Partial<PoolActivity>): PoolActivity {
  return {
    kind: 'SWAP', reason: null, mint: MINT, pool: POOL, poolSide: POOL, poolSideInferred: false,
    direction: null, trader: null, traderResolution: null, feePayer: tx.feePayer,
    tokenAmount: null, tokenDecimals: 6, quoteMint: WSOL_MINT, quoteAmount: null, quoteDecimals: 9,
    priceInQuote: null, liquidityActor: null, reserveFraction: null, confidence: 1,
    ...a,
  };
}

/** A database holding the survivor and the pool activity the backbone would have collected. */
function setup(now = Date.now()) {
  const h = harness();
  const world = buildWorld(now);
  const token: TokenSnapshot = { ...snapshot({ mint: MINT, at: now, eligibility: 'QUALIFIED', state: 'QUALIFIED' }) };
  h.repo.saveTokenSnapshot(token, { scanId: null });
  const chain = new ChainRepository(h.db);
  for (const tx of world.buys) {
    const trade = tx.tokenBalances[0];
    const trader = tx.feePayer;
    chain.saveIngested({
      tx,
      txIndex: null,
      activity: [activity(tx, { direction: 'BUY', trader, traderResolution: 'EXACT', tokenAmount: trade?.delta ?? null, quoteAmount: -(tx.lamportDeltas.get(trader) ?? 0n) - 5000n })],
      edges: [], events: [], wallets: [{ address: trader, onCurve: true }], source: 'test', commitment: 'finalized',
    });
  }
  chain.saveIngested({
    tx: world.drain,
    txIndex: null,
    activity: [activity(world.drain, { kind: 'LIQUIDITY_REMOVED', liquidityActor: DEV, reserveFraction: 0.96, tokenAmount: 900_000_000_000n })],
    edges: [], events: [], wallets: [], source: 'test', commitment: 'finalized',
  });
  const intel = new IntelRepository(h.db);
  const deps = (port: HistoryPort, settings: Partial<IntelSettings> = {}): IntelDeps => ({
    history: port, chain, intel, tokens: () => [token], source: 'test-rpc', settings: { ...SETTINGS, ...settings },
  });
  return { h, world, chain, intel, deps, token };
}

const count = (db: import('node:sqlite').DatabaseSync, sql: string, ...args: (string | number)[]): number =>
  Number((db.prepare(sql).get(...args) as { c: number }).c);

describe('the intelligence cycle', () => {
  test('one cycle produces every structure, with evidence, and without linking exchange customers', async () => {
    const { h, world, intel, deps } = setup();
    const port = fakePort(world);
    const r = await runIntelCycle(deps(port));
    assert.equal(r.health.state, 'AVAILABLE', r.health.reason);
    const t = r.tokens[0];
    assert.ok(t);
    assert.equal(t.attribution, 'ATTRIBUTED');
    assert.equal(t.wallets.selected, 5, 'four buyers and the creator');
    assert.equal(t.wallets.analyzed, 5);
    assert.ok(t.requests <= SETTINGS.requestsPerCycle);

    // Funding: quiet funder DIRECT, exchange INFRASTRUCTURE.
    const funding = intel.fundingOf([A, C]);
    assert.equal(funding.find((f) => f.wallet === A)?.classification, 'DIRECT');
    assert.equal(funding.find((f) => f.wallet === C)?.classification, 'INFRASTRUCTURE');
    // Graph expansion followed F back to G.
    assert.equal(intel.fundingOf([F])[0]?.funder, G);

    // A and B are clustered; C and E are not linked through X at all.
    const clusters = intel.clustersOf([A, C, E]);
    assert.ok(clusters.some((c) => c.members.includes(A) && c.members.includes(B)));
    assert.ok(!clusters.some((c) => c.members.includes(C) && c.members.includes(E)));
    assert.equal(intel.edgesTouching([X]).length, 0, 'no edge of any kind to the exchange');

    // Attribution, the drain and the creator's history.
    assert.equal(intel.attribution(MINT)?.creator, DEV);
    assert.equal(intel.attribution(MINT)?.initialFunder, F);
    const events = intel.eventsOf([MINT]);
    assert.equal(events.find((e) => e.type === 'LIQUIDITY_DRAIN')?.status, 'CONFIRMED');
    assert.equal(intel.creatorProfiles([DEV]).get(DEV)?.status, 'MALICIOUS_HISTORY');
    assert.equal(t.network, 'STRONG');

    // The snapshot carries coverage and its explanation.
    const snap = intel.latestTokenIntelligence(MINT);
    assert.ok(snap && snap.coverage > 0 && snap.coverage <= 1);
    const wallets = snap.wallets as { wallet: string; classification: string; funding: unknown }[];
    assert.equal(wallets.length, 5);
    assert.ok(wallets.every((w) => typeof w.classification === 'string'));
    assert.ok(count(h.db, 'SELECT COUNT(*) AS c FROM wallet_trades') >= 4);
    h.close();
  });

  test('a token analysed recently is not analysed again; non-survivors never are', () => {
    const now = Date.now();
    const q = snapshot({ mint: mintOf('q'), at: now, eligibility: 'QUALIFIED', state: 'QUALIFIED' });
    const w = snapshot({ mint: mintOf('w'), at: now, eligibility: 'WATCH', state: 'WATCH' });
    const rej = snapshot({ mint: mintOf('r'), at: now, eligibility: 'REJECTED', state: 'REJECTED' });
    const recent = snapshot({ mint: mintOf('recent'), at: now, eligibility: 'QUALIFIED', state: 'QUALIFIED' });
    const plan = planIntel([w, rej, recent, q], (m) => (m === mintOf('recent') ? now - 60_000 : null), SETTINGS, now);
    assert.deepEqual(plan.work.map((x) => x.mint), [mintOf('q'), mintOf('w')], 'QUALIFIED first');
    assert.equal(plan.skipped.notSurvivor, 1);
    assert.equal(plan.skipped.recentlyAnalyzed, 1);
  });

  test('restart durability: everything survives a reopen, and fresh profiles are reused, not re-read', async () => {
    const { h, world, deps } = setup();
    await runIntelCycle(deps(fakePort(world)));
    h.close();

    const reopened = openDatabase({ path: h.path });
    assert.ok(reopened.db);
    const intel = new IntelRepository(reopened.db);
    const chain = new ChainRepository(reopened.db);
    assert.ok(intel.latestTokenIntelligence(MINT));
    assert.equal(intel.profile(A)?.wallet, A);
    assert.equal(intel.attribution(MINT)?.creator, DEV);

    const port = fakePort(world);
    const budget = new IntelBudget(100, Date.now() + 60_000, Date.now);
    const again = await analyzeToken({ mint: MINT, tier: 'QUALIFIED' }, { ...deps(port), chain, intel }, budget, []);
    assert.equal(again.wallets.reused, again.wallets.selected);
    assert.equal(port.calls.filter((c) => c.startsWith('history:desc:') && c !== `history:desc:${MINT}`).length, 0, 'no wallet history re-read');
    reopened.db.close();
  });

  test('graph truncation: a small budget cuts the analysis, says so, and lowers coverage', async () => {
    const full = setup();
    const complete = await runIntelCycle(full.deps(fakePort(full.world)));
    full.h.close();

    const { h, world, deps } = setup();
    const r = await runIntelCycle(deps(fakePort(world), { requestsPerCycle: 5 }));
    const t = r.tokens[0];
    assert.ok(t);
    assert.ok(t.requests <= 5);
    assert.ok(t.wallets.notRead > 0, 'wallets the budget did not reach are counted, not guessed');
    assert.ok(t.truncation.some((x) => x.startsWith('REQUEST_BUDGET')), t.truncation.join('; '));
    assert.equal(r.health.state, 'PARTIAL');
    assert.ok(t.coverage <= (complete.tokens[0]?.coverage ?? 1));
    h.close();
  });

  test('graph depth is bounded: at depth 1 the funder of a funder is not read', async () => {
    const { h, world, intel, deps } = setup();
    const port = fakePort(world);
    const r = await runIntelCycle(deps(port, { graphDepth: 1 }));
    assert.equal(intel.fundingOf([F]).length, 0);
    assert.ok(!port.calls.includes(`history:asc:${F}`));
    assert.ok(r.tokens[0]?.truncation.some((x) => x.startsWith('GRAPH_DEPTH')));
    h.close();
  });

  test('provider outage: nothing thrown, FAILED health, and nothing claimed', async () => {
    const { h, world, intel, deps } = setup();
    const r = await runIntelCycle(deps(fakePort(world, { fail: true })));
    assert.equal(r.health.state, 'FAILED');
    const t = r.tokens[0];
    assert.ok(t);
    assert.equal(t.attribution, 'UNKNOWN');
    assert.equal(t.wallets.analyzed, 0);
    assert.ok(t.wallets.failed > 0);
    assert.ok(t.coverage < 0.5);
    assert.equal(count(h.db, 'SELECT COUNT(*) AS c FROM wallet_profiles'), 0, 'no profile invented');
    assert.ok(intel.latestTokenIntelligence(MINT), 'the thin reading is still recorded, with its coverage');
    h.close();
  });

  test('without a database the cycle reports UNAVAILABLE and does no work', async () => {
    const port = fakePort(buildWorld(Date.now()));
    const r = await runIntelCycle({ history: port, chain: null, intel: null, tokens: () => [], source: 't', settings: SETTINGS });
    assert.equal(r.health.state, 'UNAVAILABLE');
    assert.equal(port.calls.length, 0);
  });
});

describe('intelligence persistence', () => {
  test('migration 3 on a v2 database keeps its history and adds nullable columns', () => {
    const dir = tempDir();
    const opened = openDatabase({ path: join(dir, 'v2.sqlite'), migrateSchema: false });
    assert.ok(opened.db);
    const db = opened.db;
    db.exec('BEGIN');
    for (const m of MIGRATIONS.filter((x) => x.to <= 2)) for (const s of m.statements) db.exec(s);
    db.exec('PRAGMA user_version = 2');
    db.exec('COMMIT');
    const tx = swap({ wallet: A, mint: MINT, direction: 'BUY', tokens: 5n, sol: 0.1, timeMs: Date.now() });
    // v2-era rows, written with the v2 columns only - today's Repository
    // writes v3 columns and so cannot stand in for the old code.
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(
      `INSERT INTO pool_activity (signature,pool,mint,slot,kind,fee_payer,confidence,source,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(tx.signature, POOL, MINT, tx.slot, 'SWAP', A, 1, 'test', 1);
    db.prepare(`INSERT INTO holder_snapshots (mint, observed_at, recorded_at, top_holders_pct, source) VALUES (?,?,?,?,?)`).run(MINT, 1, 1, 42.5, 'jupiter');
    db.exec('PRAGMA foreign_keys = ON');
    assert.deepEqual(migrate(db), [3]);
    assert.deepEqual(migrate(db), [], 'idempotent');
    assert.equal(currentSchemaVersion(db), 3);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM pool_activity'), 1);
    const holders = db.prepare('SELECT top_holders_pct, wallet_top10_pct, role_breakdown FROM holder_snapshots').get() as Record<string, unknown>;
    assert.equal(holders.top_holders_pct, 42.5, 'the raw figure is untouched');
    assert.equal(holders.wallet_top10_pct, null, 'the adjusted one is unmeasured, not zero');
    assert.equal(holders.role_breakdown, null);
    const row = db.prepare('SELECT liquidity_actor, reserve_fraction FROM pool_activity').get() as Record<string, unknown>;
    assert.equal(row.liquidity_actor, null);
    assert.equal(row.reserve_fraction, null);
    assert.throws(() => db.prepare(`INSERT INTO wallet_profiles (wallet,analyzed_at,transactions,history_complete,features,classification,confidence,signals,counter_signals,coverage,source) VALUES ('w',1,1,0,'{}','DEFINITELY_HUMAN',0.5,'[]','[]',0.5,'t')`).run());
    assert.throws(() => db.prepare(`INSERT INTO security_events (id,mint,type,status,creator_linked,signature,slot,reasons,evidence,confidence,detected_at) VALUES ('i','m','PRICE_CRASH','CONFIRMED',0,'s',1,'[]','[]',1,1)`).run());
    db.close();
  });

  test('retention prunes perishable readings but never a confirmed security event', () => {
    const h = harness();
    const intel = new IntelRepository(h.db);
    const old = Date.now() - 400 * 86_400_000;
    const base = { mint: MINT, actor: DEV, creatorLinked: true, slot: 1, blockTimeMs: old, amount: null, reasons: ['r'], evidence: ['s'] };
    intel.saveSecurityEvents([
      { ...base, id: 'confirmed', type: 'LIQUIDITY_DRAIN', status: 'CONFIRMED', signature: 's1', confidence: 0.95 },
      { ...base, id: 'suspicious', type: 'AUTHORITY_REASSIGNED', status: 'SUSPICIOUS', signature: 's2', confidence: 0.5 },
    ], old);
    intel.saveAddressStats(X, { onCurve: true, recentTxCount: 1000, windowMs: 1000 }, old);
    const result = applyRetention(h.db, DEFAULT_RETENTION, Date.now());
    assert.equal(result.failure, null);
    assert.deepEqual(intel.eventsOf([MINT]).map((e) => e.id), ['confirmed']);
    assert.equal(intel.addressStats(X), null);
    h.close();
  });

  test('a security event can escalate on re-detection but never silently downgrade', () => {
    const h = harness();
    const intel = new IntelRepository(h.db);
    const ev = { id: 'e', mint: MINT, type: 'LIQUIDITY_DRAIN' as const, actor: DEV, creatorLinked: true, signature: 's', slot: 1, blockTimeMs: 1, amount: null, reasons: [], evidence: [], confidence: 0.5 };
    intel.saveSecurityEvents([{ ...ev, status: 'CONFIRMED' }], 1);
    intel.saveSecurityEvents([{ ...ev, status: 'SUSPICIOUS' }], 2);
    assert.equal(intel.eventsOf([MINT])[0]?.status, 'CONFIRMED');
    h.close();
  });
});

describe('getTokenLargestAccounts protection', () => {
  beforeEach(() => resetLargestAccountsGuard());
  const failure = (message: string): ProviderFailure => ({ provider: 'helius', kind: 'INVALID_RESPONSE', message, at: 0, retryable: false });

  test('an overload report pauses the method; later calls return at once without calling', async () => {
    let calls = 0;
    const overloaded = async () => {
      calls += 1;
      return { data: null, failure: failure('account index service overloaded') };
    };
    await guardedLargestAccounts('m1', overloaded);
    const r = await guardedLargestAccounts('m2', overloaded);
    assert.equal(calls, 1);
    assert.equal(r.failure?.kind, 'PROVIDER_UNAVAILABLE');
    const state = largestAccountsGuardState();
    assert.ok(state.breakerOpenUntil !== null);
    assert.equal(state.skipped, 1);
  });

  test('too many accounts is remembered per mint only', async () => {
    let calls = 0;
    const call = async () => {
      calls += 1;
      return { data: null, failure: failure('Too many accounts requested') };
    };
    await guardedLargestAccounts('huge', call);
    await guardedLargestAccounts('huge', call);
    assert.equal(calls, 1);
    await guardedLargestAccounts('small', async () => ({ data: { value: [] }, failure: null }));
    assert.equal(largestAccountsGuardState().calls, 2);
  });

  test('at most two calls are in flight; the rest wait instead of piling on', async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return { data: { value: [] }, failure: null };
    };
    await Promise.all(Array.from({ length: 6 }, (_, i) => guardedLargestAccounts(`c${i}`, slow)));
    assert.equal(peak, 2);
    assert.equal(largestAccountsGuardState().inFlight, 0);
  });
});

describe('secret leakage', () => {
  test('a key in the environment or an echoed provider error never reaches the database', () => {
    const dir = tempDir();
    const secret = 'IntelSecretKey-0987654321abcdef';
    const scriptPath = join(dir, 'leak.ts');
    const rootDir = join(import.meta.dirname, '..');
    const root = pathToFileURL(rootDir).href;
    writeFileSync(
      scriptPath,
      `
      import { openDatabase } from '${root}/src/persist/db.ts';
      import { ChainRepository } from '${root}/src/persist/chain-repository.ts';
      import { IntelRepository } from '${root}/src/persist/intel-repository.ts';
      import { Repository } from '${root}/src/persist/repository.ts';
      import { runIntelCycle } from '${root}/src/intel/runner.ts';
      import { rpcEndpoint } from '${root}/src/sources/solana-rpc.ts';
      import { snapshot } from '${root}/test/persist-helpers.ts';
      import { mintOf } from '${root}/test/intel-helpers.ts';
      const opened = openDatabase({ path: process.env.DB });
      const db = opened.db;
      const token = snapshot({ mint: mintOf('leak'), at: Date.now(), eligibility: 'QUALIFIED', state: 'QUALIFIED' });
      new Repository(db).saveTokenSnapshot(token, { scanId: null });
      const echoed = () => ({ data: null, failure: { provider: 'solana-rpc', kind: 'HTTP_ERROR', message: 'request to ' + process.env.SOLANA_RPC_URL + ' failed', at: Date.now(), retryable: false } });
      const report = await runIntelCycle({
        history: { history: async () => echoed(), signatures: async () => echoed(), transaction: async () => echoed() },
        chain: new ChainRepository(db),
        intel: new IntelRepository(db),
        tokens: () => [token],
        source: rpcEndpoint().label,
        settings: { tokensPerCycle: 1, walletsPerToken: 4, txPerWallet: 10, ascLimit: 5, graphDepth: 2, requestsPerCycle: 10, cycleMaxMs: 10000, profileTtlMs: 1, tokenRefreshMs: 1, liveWindowMs: 3600000 },
      });
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();
      console.log(rpcEndpoint().label + ' ' + report.tokens.length);
      `,
    );
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: rootDir,
      env: { ...process.env, HELIUS_API_KEY: secret, SOLANA_RPC_URL: `https://mainnet.helius-rpc.com/?api-key=${secret}`, DB: join(dir, 'leak.sqlite'), TOKEN_FINDER_DATA_DIR: dir },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes(secret), false, 'not printed');
    assert.match(result.stdout.trim(), /^solana-rpc:custom 1$/);
    for (const file of ['leak.sqlite', 'leak.sqlite-wal']) {
      const path = join(dir, file);
      if (!existsSync(path)) continue;
      const bytes = readFileSync(path);
      assert.equal(bytes.includes(Buffer.from(secret)), false, `the key is absent from ${file}`);
      assert.equal(bytes.includes(Buffer.from('helius-rpc.com/?api-key')), false, `so is the keyed URL, in ${file}`);
    }
  });
});
