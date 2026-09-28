/**
 * Public access protection (server/access.ts, server/security.ts): an
 * anonymous visitor cannot spend the provider budget without limit, and the
 * local tool is unchanged.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { AccessGate, type AccessPolicy } from '../src/server/access.ts';
import { hostAllowed, sameOrigin } from '../src/server/security.ts';

const PUBLIC: AccessPolicy = {
  public: true,
  trustProxy: true,
  adminToken: 'operator-secret',
  analyzePerClientPerHour: 2,
  analyzePerHour: 3,
  scanPerClientPerHour: 5,
  scanMinIntervalSec: 300,
  apiReadsPerClientPerMinute: 100,
  maxStreams: 1,
};

const req = (headers: Record<string, string>, ip = '10.0.0.1'): IncomingMessage =>
  ({ headers, socket: { remoteAddress: ip } }) as unknown as IncomingMessage;

test('public exposure bounds the expensive endpoints; the operator and the local tool are unbounded', () => {
  const gate = new AccessGate(PUBLIC);
  const t = 1_800_000_000_000;
  const alice = req({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1' });
  const bob = req({ 'x-forwarded-for': '198.51.100.7' });

  // Per client, then globally.
  assert.equal(gate.analyze(alice, t).ok, true);
  assert.equal(gate.analyze(alice, t + 1).ok, true);
  const third = gate.analyze(alice, t + 2);
  assert.equal(third.ok, false);
  assert.ok((third.retryAfterSec ?? 0) > 3_000, 'retry after the hour window, not immediately');
  assert.equal(gate.analyze(bob, t + 3).ok, true);
  assert.equal(gate.analyze(req({ 'x-forwarded-for': '192.0.2.9' }), t + 4).ok, false, 'the global hourly budget is spent');
  assert.equal(gate.analyze(alice, t + 3_600_001).ok, true, 'the window slides');

  // Manual scans: a global minimum interval, whoever asks.
  assert.equal(gate.scan(alice, t).ok, true);
  const soon = gate.scan(bob, t + 60_000);
  assert.equal(soon.ok, false);
  assert.equal(soon.retryAfterSec, 240);
  assert.equal(gate.scan(bob, t + 301_000).ok, true);

  // Streams.
  const release = gate.openStream(alice);
  assert.ok(release);
  assert.equal(gate.openStream(bob), null);
  release();
  assert.ok(gate.openStream(bob));

  // The operator, with ADMIN_TOKEN - and only the exact token.
  assert.equal(gate.analyze(req({ authorization: 'Bearer operator-secret' }), t + 5).ok, true);
  assert.equal(gate.isAdmin(req({ authorization: 'Bearer operator-secre' })), false);

  // Locally, nothing is limited.
  const local = new AccessGate({ ...PUBLIC, public: false });
  for (let i = 0; i < 20; i++) assert.equal(local.analyze(alice, t + i).ok, true);

  // Behind HTTPS, the Origin must be exactly the public one; the Host must name it.
  const origin = 'https://token-finder.example';
  assert.equal(sameOrigin(req({ origin, host: 'token-finder.example' }), origin).ok, true);
  assert.equal(sameOrigin(req({ origin: 'https://evil.example', host: 'token-finder.example' }), origin).ok, false);
  assert.equal(sameOrigin(req({ origin: 'http://token-finder.example', host: 'token-finder.example' }), origin).ok, false);
  assert.equal(hostAllowed('token-finder.example', 8080, '0.0.0.0', origin), true);
  assert.equal(hostAllowed('evil.example', 8080, '0.0.0.0', origin), false);
  assert.equal(hostAllowed('localhost:5173', 5173, '127.0.0.1'), true, 'the local tool is unchanged');
});
