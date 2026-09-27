/**
 * Shared harness for the browser suites: the seeded fixture server, raw HTTP
 * (so a Host header can be forged), and the fixture's mints.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findBrowser, freePort } from './browser.mjs';

export const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const FIXTURE = join(ROOT, 'test', 'ui', 'fixture-server.ts');
export const SKIP = findBrowser() ? false : 'no Chromium browser found - set CHROME_PATH to run the browser suite';

export const MINTS = {
  qualified: 'QuaLiFieD1111111111111111111111111111111111',
  watch: 'WaTcH11111111111111111111111111111111111111',
  rejected: 'ReJeCtEd11111111111111111111111111111111111',
  t22: 'ToKeN2z22111111111111111111111111111111111',
  stale: 'StAtE111111111111111111111111111111111111111',
  legacy: 'LeGaCy111111111111111111111111111111111111',
  xss: 'XsSpRoBe1111111111111111111111111111111111',
  long: 'LoNgStRiNg11111111111111111111111111111111',
};

/** Boots the fixture server as its own process; resolves once it answers. */
export async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), 'tf-ui-data-'));
  const port = await freePort();
  const child = spawn(process.execPath, [FIXTURE], {
    cwd: ROOT,
    env: { ...process.env, TOKEN_FINDER_DATA_DIR: dir, PORT: String(port), TYPESAFE_ENABLED: 'false', HELIUS_API_KEY: '', BIRDEYE_API_KEY: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const origin = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/status`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (i === 99) throw new Error(`fixture server did not start:\n${output}`);
  }
  return {
    origin,
    port,
    /**
     * Makes the fixture emit one of the monitor's own bus events, exactly as a
     * real scan would: `scan-start`, `scan` or `scan-failed`.
     * @param {'scan-start' | 'scan' | 'scan-failed'} kind
     */
    emit(kind) {
      child.stdin.write(`${kind}\n`);
    },
    stop() {
      child.kill();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows may hold the database briefly.
      }
    },
  };
}

/** Raw HTTP, so the Host header can be forged (fetch forbids it). */
export function rawRequest(port, { method = 'GET', path = '/', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Everything the hostile fixture tried to set. None may exist. */
export const EXECUTED = `['__sym','__name','__img','__pair','__site','__data','__social','__flag','__src','__event'].filter((k) => window[k] !== undefined)`;

