/**
 * Restart and scale.
 *
 * Persistence that is only ever observed by the process that wrote it has not
 * been demonstrated. These tests spawn **real separate Node processes** against
 * the same data directory: one writes and exits, another starts cold and reads.
 * Nothing is shared but the files on disk, which is the only thing that
 * actually survives a restart.
 *
 * The scale test exists to show persistence is not the scan bottleneck at this
 * project's size, and to record where the next one will be.
 */

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { cleanupTempDirs, tempDir } from './persist-helpers.ts';

after(cleanupTempDirs);

const REPO_ROOT = resolve(import.meta.dirname, '..');
const STORE_URL = pathToFileURL(join(REPO_ROOT, 'src', 'core', 'store.ts')).href;
const HELPERS_URL = pathToFileURL(join(REPO_ROOT, 'test', 'persist-helpers.ts')).href;

/**
 * Runs `body` in a fresh Node process with its own data directory.
 *
 * Output is whatever the script prints to stdout, so assertions compare what a
 * genuinely separate process observed.
 */
function runInChild(
  dataDir: string,
  body: string,
  timeoutMs = 60_000,
  portOverride?: number,
): string {
  const tag = Math.random().toString(36).slice(2);
  const scriptPath = join(dataDir, `worker-${tag}.ts`);
  // The result goes to a file, not stdout: the store legitimately logs to
  // stdout when it migrates a schema or imports legacy state, and a test must
  // not depend on that staying quiet.
  const resultPath = join(dataDir, `result-${tag}.json`);

  writeFileSync(
    scriptPath,
    `import { writeFileSync as __w } from 'node:fs';\n` +
      `import { store } from ${JSON.stringify(STORE_URL)};\n` +
      `import { snapshot, token2022Onchain } from ${JSON.stringify(HELPERS_URL)};\n` +
      `const out = (v) => __w(${JSON.stringify(resultPath)}, JSON.stringify(v), 'utf8');\n` +
      body,
    'utf8',
  );

  execFileSync(process.execPath, ['--experimental-strip-types', scriptPath], {
    env: {
      ...process.env,
      TOKEN_FINDER_DATA_DIR: dataDir,
      ...(portOverride === undefined ? {} : { PORT: String(portOverride) }),
      // Keep the child off the network and out of the real config.
      TYPESAFE_ENABLED: 'false',
    },
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return readFileSync(resultPath, 'utf8');
}

describe('restart persistence', () => {
  test('state written by one process is read by the next', () => {
    const dir = tempDir();

    const written = runInChild(
      dir,
      `store.beginScan(1700000000000);
       store.upsert(snapshot({ mint: 'RestartA', at: 1700000000000, score: 71 }));
       store.upsert(snapshot({ mint: 'RestartB', at: 1700000000000, score: 42 }));
       store.finishScan(1700000000000);
       store.save();
       out({ tokens: store.tokens().length });`,
    );
    assert.deepEqual(JSON.parse(written), { tokens: 2 });

    // A completely cold process. It shares no memory with the writer.
    const read = runInChild(
      dir,
      `out({
         tokens: store.tokens().length,
         a: store.token('RestartA')?.score.total ?? null,
         b: store.token('RestartB')?.score.total ?? null,
         scans: store.scanCount,
         lastScanAt: store.lastScanAt,
       });`,
    );

    assert.deepEqual(JSON.parse(read), {
      tokens: 2,
      a: 71,
      b: 42,
      scans: 1,
      lastScanAt: 1700000000000,
    });
  });

  test('history accumulates across restarts rather than restarting', () => {
    const dir = tempDir();

    for (const [i, score] of [50, 60, 70].entries()) {
      runInChild(
        dir,
        `store.beginScan(${1700000000000 + i * 3600000});
         store.upsert(snapshot({ mint: 'Hist', at: ${1700000000000 + i * 3600000}, score: ${score} }));
         store.finishScan(${1700000000000 + i * 3600000});
         store.save();
         out({ ok: true });`,
      );
    }

    const read = runInChild(
      dir,
      `const h = store.history('Hist');
       out({ points: h.length, scores: h.map((p) => p.score), scans: store.scanCount });`,
    );
    const result = JSON.parse(read) as { points: number; scores: number[]; scans: number };

    // Three separate processes, three material score moves, three points.
    assert.equal(result.points, 3);
    assert.deepEqual(result.scores, [50, 60, 70]);
    assert.equal(result.scans, 3);
  });

  test('exact u64 values survive a restart without precision loss', () => {
    const dir = tempDir();

    runInChild(
      dir,
      `store.upsert(snapshot({ mint: 'BigRestart', onchain: token2022Onchain(), holders: 9 }));
       store.save();
       out({ ok: true });`,
    );

    const read = runInChild(
      dir,
      `const t = store.token('BigRestart');
       out({
         rawSupply: t?.onchain?.rawSupply ?? null,
         program: t?.onchain?.tokenProgram ?? null,
         decimals: t?.onchain?.decimals ?? null,
       });`,
    );

    assert.deepEqual(JSON.parse(read), {
      rawSupply: '8799438501691764747',
      program: 'TOKEN_2022',
      decimals: 255,
    });
  });

  test('a second process sees a legacy import already done and does not repeat it', () => {
    const dir = tempDir();
    // A legacy state.json in the data directory, as a real upgrade would have.
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        version: 1,
        lastScanAt: 1700000000000,
        scanCount: 3,
        tokens: {
          LegacyRestartMint000000000000000000000: {
            mint: 'LegacyRestartMint000000000000000000000',
            symbol: 'OLD',
            name: 'Old Token',
            sources: [],
            at: 1700000000000,
            launchedAt: null,
            ageHours: null,
            priceUsd: 1,
            liquidityUsd: 1000,
            volume24h: 10,
            marketCap: null,
            fdv: null,
            holders: null,
            priceChange: null,
            buyRatio24h: null,
            pair: null,
            jupiter: null,
            rugcheck: null,
            onchain: null,
            impersonation: null,
            score: { total: 55, base: 55, grade: 'C', penalty: 0, coverage: 1, ceiling: 100, unknown: [], components: [], flags: [] },
          },
        },
        history: { LegacyRestartMint000000000000000000000: [{ at: 1700000000000, priceUsd: 1, liquidityUsd: 1000, volume24h: 10, score: 55 }] },
        events: [],
      }),
      'utf8',
    );

    const first = JSON.parse(
      runInChild(dir, `out({ tokens: store.tokens().length, imported: store.diagnostics()?.legacyImport.completedAt !== null });`),
    ) as { tokens: number; imported: boolean };
    assert.equal(first.tokens, 1, 'legacy token imported on first boot');
    assert.equal(first.imported, true);

    const second = JSON.parse(
      runInChild(dir, `out({ tokens: store.tokens().length, points: store.history('LegacyRestartMint000000000000000000000').length });`),
    ) as { tokens: number; points: number };

    // The import must not run twice and double the history.
    assert.equal(second.tokens, 1);
    assert.equal(second.points, 1);
  });

  test('the legacy state.json is left on disk after import', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, tokens: {}, history: {}, events: [] }), 'utf8');

    const result = JSON.parse(
      runInChild(
        dir,
        `import { existsSync, readdirSync } from 'node:fs';
         out({
           legacyStillThere: existsSync(${JSON.stringify(join(dir, 'state.json'))}),
           files: readdirSync(${JSON.stringify(dir)}).filter((f) => f.startsWith('state') && f.endsWith('.json')).length,
         });`,
      ),
    ) as { legacyStillThere: boolean; files: number };

    assert.equal(result.legacyStillThere, true, 'the importer never deletes the original');
    // The original plus its pre-import backup.
    assert.ok(result.files >= 2, 'a backup was written alongside it');
  });
});

describe('scale', () => {
  test('persisting a 100-token scan is not the bottleneck', () => {
    const dir = tempDir();

    const raw = runInChild(
      dir,
      `const N = 100;
       const snaps = Array.from({ length: N }, (_, i) =>
         snapshot({ mint: 'Stress' + String(i).padStart(6, '0'), at: 1700000000000, score: 40 + (i % 50) }));

       const t0 = performance.now();
       store.beginScan(1700000000000);
       for (const s of snaps) store.upsert(s);
       store.finishScan(1700000000000);
       store.save();
       const writeMs = performance.now() - t0;

       const t1 = performance.now();
       const all = store.tokens();
       const readMs = performance.now() - t1;

       const t2 = performance.now();
       const hist = store.history('Stress000050');
       const histMs = performance.now() - t2;

       out({ tokens: all.length, writeMs, readMs, histMs, points: hist.length });`,
      120_000,
    );

    const result = JSON.parse(raw) as {
      tokens: number;
      writeMs: number;
      readMs: number;
      histMs: number;
      points: number;
    };

    assert.equal(result.tokens, 100);
    assert.equal(result.points, 1);

    // Generous bounds: this asserts "not a bottleneck", not a tuned figure.
    // A scan's own network phase takes tens of seconds; persistence must be
    // nowhere near that. Observed figures are reported in PERSISTENCE.md.
    assert.ok(
      result.writeMs < 10_000,
      `persisting 100 tokens took ${result.writeMs.toFixed(0)}ms, which is too close to scan cost`,
    );
    assert.ok(result.readMs < 1_000, `reading 100 tokens took ${result.readMs.toFixed(0)}ms`);
    assert.ok(result.histMs < 1_000, `a history query took ${result.histMs.toFixed(0)}ms`);

    console.log(
      `      100-token persist: write ${result.writeMs.toFixed(0)}ms, ` +
        `read ${result.readMs.toFixed(0)}ms, history query ${result.histMs.toFixed(1)}ms`,
    );
  });

  test('history queries stay fast as snapshots accumulate', () => {
    const dir = tempDir();

    const raw = runInChild(
      dir,
      `const HOUR = 3600000;
       // 400 stored snapshots for one mint, each a material move so none is
       // suppressed - a far denser history than a real token accumulates.
       for (let i = 0; i < 400; i++) {
         store.upsert(snapshot({ mint: 'Deep', at: 1700000000000 + i * HOUR, score: 20 + (i % 60) }));
       }
       store.save();
       const t0 = performance.now();
       const h = store.history('Deep');
       const ms = performance.now() - t0;
       const stored = store.diagnostics()?.rowCounts['token_snapshots'] ?? 0;
       out({ points: h.length, stored, ms });`,
      120_000,
    );

    const result = JSON.parse(raw) as { points: number; stored: number; ms: number };

    // Every snapshot was a material move, so all 400 are on disk...
    assert.equal(result.stored, 400, 'the full history is retained in the database');
    // ...while the dashboard-facing view stays bounded by HISTORY_POINTS (240).
    // The cap is a chart concern, not a retention one: nothing was discarded.
    assert.equal(result.points, 240);
    assert.ok(result.ms < 1_000, `history query took ${result.ms.toFixed(0)}ms`);
    console.log(
      `      deep history: ${result.stored} stored, ${result.points} returned in ${result.ms.toFixed(1)}ms`,
    );
  });
});

describe('dashboard compatibility', () => {
  test('the API serves a database whose history came from legacy v1 snapshots', () => {
    const dir = tempDir();

    // A v1 snapshot has no `evaluation` key at all. The API guards for it read
    // `=== null`, so `undefined` slipped through to a property access and every
    // data endpoint returned 500 once such a row existed.
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        version: 1,
        lastScanAt: 1700000000000,
        scanCount: 1,
        tokens: {
          LegacyApiMint00000000000000000000000: {
            mint: 'LegacyApiMint00000000000000000000000',
            symbol: 'OLD',
            name: 'Legacy Token',
            sources: [],
            at: 1700000000000,
            launchedAt: null,
            ageHours: 3,
            priceUsd: 1,
            liquidityUsd: 9000,
            volume24h: 100,
            marketCap: null,
            fdv: null,
            holders: null,
            priceChange: null,
            buyRatio24h: null,
            pair: null,
            jupiter: null,
            rugcheck: null,
            onchain: null,
            impersonation: null,
            score: { total: 61, base: 61, grade: 'B', penalty: 0, coverage: 1, ceiling: 100, unknown: [], components: [], flags: [] },
          },
        },
        history: {},
        events: [],
      }),
      'utf8',
    );

    const port = 5200 + Math.floor(Math.random() * 300);
    const raw = runInChild(
      dir,
      `const { serve } = await import(${JSON.stringify(
        pathToFileURL(join(REPO_ROOT, 'src', 'server', 'index.ts')).href,
      )});
       const server = serve({ monitor: false });
       await new Promise((r) => setTimeout(r, 1500));
       const paths = ['/api/status', '/api/tokens?limit=5', '/api/coverage', '/api/events'];
       const codes = {};
       for (const p of paths) codes[p] = (await fetch('http://127.0.0.1:${port}' + p)).status;
       const body = await (await fetch('http://127.0.0.1:${port}/api/tokens?limit=5')).json();
       out({ codes, tokens: Array.isArray(body.tokens) ? body.tokens.length : -1 });
       // Close the listener rather than calling process.exit: exiting with it
       // open trips a libuv teardown assertion on Windows.
       server.close();`,
      60_000,
      port,
    );

    const result = JSON.parse(raw) as { codes: Record<string, number>; tokens: number };
    for (const [path, code] of Object.entries(result.codes)) {
      assert.equal(code, 200, `${path} returned ${code}`);
    }
    assert.equal(result.tokens, 1, 'the legacy token is served, not skipped');
  });
});
