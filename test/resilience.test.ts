/**
 * Batch robustness.
 *
 * The property under test throughout: **no single item or provider can abort a
 * batch.** A scan of 100 candidates where one times out, one returns garbage
 * and one throws outright must still produce 97 results and three recorded
 * reasons - never 0 results and an exception.
 */
import { test, describe, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { poolSettled, pool, HttpError } from '../src/util/http.ts';
import { classifyFailure, notConfigured } from '../src/util/failure.ts';
import { resolveEvidence } from '../src/core/resolve.ts';
import { buildCoverage } from '../src/core/lifecycle.ts';
import { isUsable } from '../src/core/evidence.ts';
import { normalizePair } from '../src/sources/dexscreener.ts';
import { normalizeToken } from '../src/sources/jupiter.ts';
import { fixtureByName } from './fixtures.ts';
import type { ProviderFailure } from '../src/util/failure.ts';

afterEach(() => {
  mock.restoreAll();
});

const NOW = Date.now();

describe('failure classification', () => {
  test('a 429 is RATE_LIMITED and worth retrying', () => {
    const failure = classifyFailure('rugcheck', new HttpError(429, 'u', 'slow down'));
    assert.equal(failure.kind, 'RATE_LIMITED');
    assert.equal(failure.retryable, true);
  });

  test('a 5xx is PROVIDER_UNAVAILABLE and worth retrying', () => {
    const failure = classifyFailure('jupiter', new HttpError(503, 'u', 'down'));
    assert.equal(failure.kind, 'PROVIDER_UNAVAILABLE');
    assert.equal(failure.retryable, true);
  });

  test('a 4xx that is not 429 is INVALID_RESPONSE and not retried', () => {
    const failure = classifyFailure('jupiter', new HttpError(422, 'u', 'bad'));
    assert.equal(failure.kind, 'INVALID_RESPONSE');
    assert.equal(failure.retryable, false, 'the same request will be refused the same way');
  });

  test('a timeout is TIMEOUT', () => {
    const abort = new Error('The operation was aborted due to timeout');
    abort.name = 'TimeoutError';
    assert.equal(classifyFailure('dexscreener', abort).kind, 'TIMEOUT');
  });

  test('a connection failure is NETWORK_ERROR', () => {
    const network = new TypeError('fetch failed');
    assert.equal(classifyFailure('dexscreener', network).kind, 'NETWORK_ERROR');
    assert.equal(classifyFailure('helius', new Error('ECONNREFUSED 1.2.3.4')).kind, 'NETWORK_ERROR');
  });

  test('a JSON parse failure is INVALID_RESPONSE and not retried', () => {
    const parse = new SyntaxError('Unexpected token < in JSON at position 0');
    const failure = classifyFailure('rugcheck', parse);
    assert.equal(failure.kind, 'INVALID_RESPONSE');
    assert.equal(failure.retryable, false, 'a malformed body will be malformed again');
  });

  test('anything unrecognised is UNKNOWN and never retried', () => {
    const failure = classifyFailure('mystery', { weird: true });
    assert.equal(failure.kind, 'UNKNOWN');
    assert.equal(
      failure.retryable,
      false,
      'retrying an error we cannot classify is how a scan becomes a rate-limit spiral',
    );
  });

  test('an unconfigured provider is PROVIDER_UNAVAILABLE and not retryable', () => {
    const failure = notConfigured('helius');
    assert.equal(failure.kind, 'PROVIDER_UNAVAILABLE');
    assert.equal(failure.retryable, false);
  });

  test('a failure message never carries the underlying URL or credentials', () => {
    const failure = classifyFailure('helius', new HttpError(401, 'https://x/?api-key=SECRET', 'no'));
    assert.equal(failure.message.includes('SECRET'), false);
    assert.equal(failure.message, 'HTTP 401');
  });
});

describe('poolSettled never aborts the batch', () => {
  test('one rejection among 100 leaves 99 fulfilled', async () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const results = await poolSettled(items, 8, async (item) => {
      if (item === 42) throw new Error('boom');
      return item * 2;
    });

    assert.equal(results.length, 100);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 99);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    assert.equal(results[42]?.status, 'rejected');
    assert.equal(results[43]?.status, 'fulfilled', 'work after the failure still ran');
  });

  test('every worker runs even when the first item rejects immediately', async () => {
    let completed = 0;
    const items = Array.from({ length: 120 }, (_, i) => i);
    const results = await poolSettled(items, 4, async (item) => {
      if (item === 0) throw new Error('fail fast');
      completed++;
      return item;
    });

    assert.equal(completed, 119, 'an early failure must not cancel the remaining work');
    assert.equal(results.length, 120);
  });

  test('results stay in input order regardless of completion order', async () => {
    const items = [30, 10, 20, 0];
    const results = await poolSettled(items, 4, async (delay) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return delay;
    });
    assert.deepEqual(
      results.map((r) => (r.status === 'fulfilled' ? r.value : null)),
      [30, 10, 20, 0],
    );
  });

  test('a batch where every item fails still resolves', async () => {
    const results = await poolSettled([1, 2, 3], 2, async () => {
      throw new Error('all down');
    });
    assert.equal(results.length, 3);
    assert.ok(results.every((r) => r.status === 'rejected'));
  });

  test('an empty batch resolves to an empty array', async () => {
    assert.deepEqual(await poolSettled([], 4, async () => 1), []);
  });

  test('pool() keeps successes and hands failures to onError', async () => {
    const seen: unknown[] = [];
    const out = await pool(
      [1, 2, 3, 4],
      2,
      async (item) => {
        if (item % 2 === 0) throw new Error(`even ${item}`);
        return item;
      },
      (reason) => seen.push(reason),
    );

    assert.deepEqual(out, [1, 3]);
    assert.equal(seen.length, 2, 'failures are reported, not silently dropped');
  });

  test('pool() does not reject even with no error handler', async () => {
    const out = await pool([1, 2], 2, async (item) => {
      if (item === 1) throw new Error('nope');
      return item;
    });
    assert.deepEqual(out, [2]);
  });
});

describe('a simulated 100-token scan survives mixed failures', () => {
  /** Stands in for one token's enrichment step. */
  type Outcome = 'ok' | 'timeout' | 'malformed' | 'rate_limited' | 'throws';

  function outcomeFor(index: number): Outcome {
    if (index === 7) return 'timeout';
    if (index === 23) return 'malformed';
    if (index === 51) return 'rate_limited';
    if (index === 88) return 'throws';
    return 'ok';
  }

  test('97 of 100 complete, and each of the 3 failures keeps its reason', async () => {
    const candidates = Array.from({ length: 100 }, (_, i) => i);
    const failures: ProviderFailure[] = [];

    const results = await poolSettled(candidates, 8, async (index) => {
      const outcome = outcomeFor(index);

      // Per-provider isolation inside one token: a failing provider becomes a
      // recorded failure, not an exception that unwinds the token.
      const settled = await Promise.allSettled([
        (async (): Promise<string> => {
          if (outcome === 'timeout') {
            const error = new Error('aborted due to timeout');
            error.name = 'TimeoutError';
            throw error;
          }
          if (outcome === 'rate_limited') throw new HttpError(429, 'u', 'slow');
          if (outcome === 'malformed') throw new SyntaxError('Unexpected token <');
          return 'provider-ok';
        })(),
      ]);

      if (settled[0].status === 'rejected') {
        failures.push(classifyFailure('rugcheck', settled[0].reason));
      }

      // A token-level throw: the analysis itself blew up.
      if (outcome === 'throws') throw new Error('analysis exploded');

      return { index, enriched: settled[0].status === 'fulfilled' };
    });

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.equal(results.length, 100, 'the batch completed');
    assert.equal(fulfilled.length, 99, 'only the token that threw is missing');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]?.index, 88, 'and the failing index is preserved');

    // The three provider failures survived with distinct, correct reasons.
    assert.equal(failures.length, 3);
    const kinds = failures.map((f) => f.kind).sort();
    assert.deepEqual(kinds, ['INVALID_RESPONSE', 'RATE_LIMITED', 'TIMEOUT']);
  });

  test('tokens whose provider failed still produced a result', async () => {
    const candidates = Array.from({ length: 100 }, (_, i) => i);
    const results = await poolSettled(candidates, 8, async (index) => {
      const settled = await Promise.allSettled([
        (async (): Promise<string> => {
          if (outcomeFor(index) !== 'ok' && outcomeFor(index) !== 'throws') {
            throw new Error('provider down');
          }
          return 'ok';
        })(),
      ]);
      if (outcomeFor(index) === 'throws') throw new Error('boom');
      return { index, enriched: settled[0].status === 'fulfilled' };
    });

    const degraded = results.filter(
      (r) => r.status === 'fulfilled' && r.value.enriched === false,
    );
    assert.equal(degraded.length, 3, 'timeout, malformed and rate-limited all still returned');
  });
});

describe('a provider failure does not erase other providers evidence', () => {
  const healthy = fixtureByName('healthy-established');

  function evidenceWith(failures: ProviderFailure[]) {
    return resolveEvidence({
      pairs: [normalizePair(healthy.dexPairs[0] as never)],
      jupiter: normalizeToken(healthy.jupiter as never),
      // RugCheck is the provider we simulate as down.
      rugcheck: null,
      onchain: null,
      observedAt: { dexscreener: NOW, jupiter: NOW, rugcheck: NOW, onchain: NOW },
      heliusConfigured: false,
      failures,
      now: NOW,
    });
  }

  test('DexScreener and Jupiter evidence survives a RugCheck outage', () => {
    const evidence = evidenceWith([
      { provider: 'rugcheck', kind: 'TIMEOUT', message: 'timed out', at: NOW, retryable: true },
    ]);

    assert.ok(isUsable(evidence.liquidityUsd), 'depth still known');
    assert.ok(isUsable(evidence.volume24h), 'volume still known');
    assert.ok(isUsable(evidence.holders), 'holders still known');
    assert.ok(isUsable(evidence.mintAuthorityRevoked), 'Jupiter audit still known');
  });

  test('the failed provider signal is UNAVAILABLE, not UNKNOWN', () => {
    const evidence = evidenceWith([
      { provider: 'rugcheck', kind: 'TIMEOUT', message: 'timed out', at: NOW, retryable: true },
    ]);

    assert.equal(evidence.rugcheckRisk.state, 'UNAVAILABLE');
    assert.equal(isUsable(evidence.rugcheckRisk), false);
    assert.match(evidence.rugcheckRisk.notes.join(' '), /TIMEOUT/);
  });

  test('coverage counts the outage as unavailable, separately from unknown', () => {
    const evidence = evidenceWith([
      { provider: 'rugcheck', kind: 'TIMEOUT', message: 'timed out', at: NOW, retryable: true },
    ]);
    const coverage = buildCoverage(evidence);

    assert.ok(coverage.unavailable >= 1);
    assert.ok(coverage.coverage < 1, 'an outage lowers coverage');
    assert.ok(coverage.measured > 0, 'but most signals survived');
  });

  test('the failure list is carried on the evidence for the audit trail', () => {
    const failures: ProviderFailure[] = [
      { provider: 'rugcheck', kind: 'RATE_LIMITED', message: 'HTTP 429', at: NOW, retryable: true },
    ];
    const evidence = evidenceWith(failures);
    assert.deepEqual(evidence.providerFailures, failures);
  });

  test('no failures means nothing becomes UNAVAILABLE', () => {
    const evidence = evidenceWith([]);
    assert.notEqual(evidence.rugcheckRisk.state, 'UNAVAILABLE');
  });
});

describe('adapters report why they failed instead of returning a bare null', () => {
  // This is the gap a fault-injected live scan exposed: the batch survived a
  // total RugCheck outage, but `tryGetJson` had collapsed every timeout into
  // `null`, so the scan could not tell "provider down" from "nothing to
  // report" and the outage was invisible.

  test('a RugCheck timeout surfaces as TIMEOUT, not as empty data', async () => {
    mock.method(globalThis, 'fetch', async () => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    });

    const { summary } = await import('../src/sources/rugcheck.ts');
    const result = await summary('TimeoutMint11111111111111111111111111111111');

    assert.equal(result.data, null);
    assert.notEqual(result.failure, null, 'the reason must survive');
    assert.equal(result.failure?.kind, 'TIMEOUT');
    assert.equal(result.failure?.provider, 'rugcheck');
  });

  test('a genuine empty answer is not a failure', async () => {
    mock.method(globalThis, 'fetch', async () =>
      Response.json({ score: 0, score_normalised: 0, risks: [] }));

    const { summary } = await import('../src/sources/rugcheck.ts');
    const result = await summary('EmptyMint111111111111111111111111111111111');

    assert.equal(result.failure, null, 'answering "nothing here" is an answer');
    assert.notEqual(result.data, null);
  });

  test('an unconfigured Helius reports PROVIDER_UNAVAILABLE rather than silence', async () => {
    const { onchainInfo } = await import('../src/sources/helius.ts');
    const result = await onchainInfo('AnyMint11111111111111111111111111111111111');

    // No key is configured in the test environment.
    assert.equal(result.data, null);
    assert.equal(result.failure?.kind, 'PROVIDER_UNAVAILABLE');
    assert.equal(result.failure?.retryable, false, 'a missing key will not fix itself on retry');
  });
});
