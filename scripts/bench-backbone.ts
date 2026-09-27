/**
 * Data backbone benchmark: what ingestion costs on this machine, measured.
 *
 *   node --expose-gc scripts/bench-backbone.ts
 *
 * Uses the recorded mainnet fixtures, cloned with unique signatures, against a
 * real on-disk SQLite database in a temp directory. No network. Each figure is
 * printed with what it measures, so the next bottleneck is found from numbers
 * rather than guessed.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/persist/db.ts';
import { Repository } from '../src/persist/repository.ts';
import { ChainRepository } from '../src/persist/chain-repository.ts';
import { normalizeTransaction } from '../src/ingest/normalize.ts';
import { derivePoolActivity } from '../src/ingest/activity.ts';
import { transferEdges, mintEvents } from '../src/ingest/derive.ts';
import { planDeepCollection } from '../src/ingest/budget.ts';
import { runIngestionCycle, type RpcPort } from '../src/ingest/runner.ts';
import { parseSignatures } from '../src/sources/solana-rpc.ts';
import type { TokenSnapshot } from '../src/types.ts';

const DIR = join(import.meta.dirname, '..', 'test', 'fixtures', 'chain');
const META = JSON.parse(readFileSync(join(DIR, 'pumpfun-trade-meta.json'), 'utf8')) as { mint: string; curve: string };
const TRADES = readdirSync(DIR)
  .filter((f) => /^pumpfun-curve-\d+\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Record<string, unknown>);

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
let counter = 0;
function uniqueSignature(): string {
  let n = ++counter;
  let s = '';
  while (s.length < 88) {
    s += ALPHABET[n % 58];
    n = Math.floor(n / 58) + 7919 * s.length;
  }
  return s;
}

/** A fixture trade with a fresh signature and slot: a distinct transaction to the database. */
function cloneTrade(i: number): Record<string, unknown> {
  const raw = structuredClone(TRADES[i % TRADES.length] as Record<string, unknown>) as {
    slot: number;
    transaction: { signatures: string[] };
  };
  raw.transaction.signatures[0] = uniqueSignature();
  raw.slot = 450_000_000 + i;
  return raw as unknown as Record<string, unknown>;
}

const ms = (start: bigint): number => Number(process.hrtime.bigint() - start) / 1e6;
const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const gc = (): void => (globalThis as { gc?: () => void }).gc?.();

const dir = mkdtempSync(join(tmpdir(), 'tf-bench-'));
const path = join(dir, 'bench.sqlite');
const opened = openDatabase({ path });
if (opened.db === null) throw new Error('db');
const db = opened.db;
const repo = new Repository(db);
const chain = new ChainRepository(db);
const now = Date.now();
const token = ((): TokenSnapshot => {
  // A minimal tracked token so pool_activity's foreign key is satisfied.
  const snap = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'test', 'fixtures', 'chain', 'pumpfun-trade-meta.json'), 'utf8')) as { mint: string };
  return { mint: snap.mint } as TokenSnapshot;
})();
db.prepare(`INSERT INTO tokens (mint, first_seen_at, last_seen_at, payload) VALUES (?,?,?,?)`).run(token.mint, now, now, '{}');
void repo;

const N = Number(process.env.BENCH_N ?? 5000);
console.log(`data backbone benchmark - ${N} transactions, on-disk SQLite (WAL), Node ${process.version}\n`);

// 1. Parse + derive, CPU only.
const clones = Array.from({ length: N }, (_, i) => cloneTrade(i));
let start = process.hrtime.bigint();
const prepared = clones.map((raw) => {
  const tx = normalizeTransaction(raw);
  if (tx === null) throw new Error('fixture did not normalize');
  const activity = derivePoolActivity(tx, META.mint, META.curve);
  const edges = transferEdges(tx, META.mint, new Set([META.curve]));
  return { tx, activity, edges, events: mintEvents(tx, META.mint, 'bench') };
});
const parseMs = ms(start);
console.log(`parse + derive        ${(parseMs / N).toFixed(3)} ms/tx   ${Math.round(N / (parseMs / 1000))} tx/s`);

// 2. Write cost: one short transaction per chain transaction, as the runner does.
start = process.hrtime.bigint();
for (const p of prepared) {
  chain.saveIngested({
    tx: p.tx,
    txIndex: null,
    activity: [p.activity],
    edges: p.edges,
    events: p.events,
    wallets: p.activity.trader === null ? [] : [{ address: p.activity.trader, onCurve: true }],
    source: 'bench',
    commitment: 'finalized',
  });
}
const writeMs = ms(start);
console.log(`write (per tx commit) ${(writeMs / N).toFixed(3)} ms/tx   ${Math.round(N / (writeMs / 1000))} tx/s`);

// 3. Duplicates: the same N again - must insert nothing.
start = process.hrtime.bigint();
let reinserted = 0;
for (const p of prepared) {
  const r = chain.saveIngested({ tx: p.tx, txIndex: null, activity: [p.activity], edges: p.edges, events: p.events, wallets: [], source: 'bench', commitment: 'finalized' });
  reinserted += Number(r.transactionInserted) + r.activityInserted + r.edgesInserted + r.eventsInserted;
}
console.log(`duplicate re-ingest   ${(ms(start) / N).toFixed(3)} ms/tx   rows inserted: ${reinserted}`);

// 4. Dedupe lookup before fetching: knownSignatures over a page of 1000.
const page = prepared.slice(0, 1000).map((p) => p.tx.signature);
start = process.hrtime.bigint();
const known = chain.knownSignatures(page);
console.log(`known-signature check ${ms(start).toFixed(1)} ms for a 1000-signature page (${known.size} known)`);

// 5. Restart: close and reopen, including the migration check.
const rows = (db.prepare('SELECT COUNT(*) AS c FROM pool_activity').get() as { c: number }).c;
db.close();
start = process.hrtime.bigint();
const reopened = openDatabase({ path });
const reopenMs = ms(start);
if (reopened.db === null) throw new Error('reopen');
const chain2 = new ChainRepository(reopened.db);
start = process.hrtime.bigint();
const stats = chain2.stats();
console.log(`restart               reopen ${reopenMs.toFixed(1)} ms · stats query ${ms(start).toFixed(1)} ms · ${rows} activity rows intact: ${stats.activityByKind.SWAP === rows}`);

// 6. Batch planning over a realistic and a large token set.
for (const size of [500, 5000]) {
  const tokens = Array.from({ length: size }, (_, i) => ({
    mint: `mint${i}`,
    at: now,
    liquidityUsd: i,
    pair: { pairAddress: `pool${i}` },
    evaluation: { eligibility: i % 3 === 0 ? 'REJECTED' : i % 3 === 1 ? 'WATCH' : 'QUALIFIED' },
  })) as unknown as TokenSnapshot[];
  start = process.hrtime.bigint();
  planDeepCollection({ tokens, lastCollectedAt: () => null, launchPool: () => null, tokensPerCycle: 6, liveWindowMs: 5_400_000, now });
  console.log(`plan ${String(size).padStart(4)} tokens       ${ms(start).toFixed(2)} ms`);
}

// 7. Memory across repeated full cycles through the runner (fake RPC, fresh signatures each cycle).
const rpcFor = (cycle: number): RpcPort => {
  const batch = Array.from({ length: 30 }, (_, i) => cloneTrade(1_000_000 + cycle * 100 + i));
  const txs = new Map(batch.map((raw) => [(raw as { transaction: { signatures: string[] } }).transaction.signatures[0] as string, raw]));
  const sigs = parseSignatures(
    [...txs.entries()].map(([signature, raw], i) => ({ signature, slot: (raw as { slot: number }).slot, blockTime: 1_790_000_000 + i, err: null })),
  ).reverse();
  return {
    getSignatures: async (_address, { limit }) => ({ data: sigs.slice(0, limit), failure: null }),
    getParsedTransaction: async (signature) => ({ data: txs.get(signature) ?? null, failure: null }),
  };
};
const survivor = {
  mint: META.mint,
  at: Date.now(),
  liquidityUsd: 1,
  pair: { pairAddress: META.curve },
  evaluation: { eligibility: 'QUALIFIED' },
} as unknown as TokenSnapshot;
gc();
const heapBefore = process.memoryUsage().heapUsed;
const cycles = Number(process.env.BENCH_CYCLES ?? 200);
start = process.hrtime.bigint();
for (let c = 0; c < cycles; c++) {
  await runIngestionCycle({
    rpc: rpcFor(c),
    chain: chain2,
    tokens: () => [{ ...survivor, at: Date.now() }],
    source: 'bench',
    commitment: 'finalized',
    settings: { tokensPerCycle: 1, txPerToken: 30, launchDiscovery: false, launchTxPerCycle: 0, liveWindowMs: 5_400_000 },
  });
}
const cycleMs = ms(start);
gc();
const heapAfter = process.memoryUsage().heapUsed;
console.log(`${cycles} cycles x 30 tx     ${(cycleMs / cycles).toFixed(1)} ms/cycle (processing only) · heap ${mb(heapBefore)} -> ${mb(heapAfter)}`);

const size = (reopened.db.prepare("SELECT page_count * page_size AS b FROM pragma_page_count(), pragma_page_size()").get() as { b: number }).b;
const total = (reopened.db.prepare('SELECT COUNT(*) AS c FROM pool_activity').get() as { c: number }).c;
console.log(`storage               ${mb(size)} for ${total} activity rows + ledger, wallets, edges (${(size / total).toFixed(0)} bytes/tx all-in)`);

reopened.db.close();
rmSync(dir, { recursive: true, force: true });
