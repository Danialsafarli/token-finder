import { log } from './logger.ts';
import { HttpError } from './http-error.ts';
import { classifyFailure, type ProviderFailure } from './failure.ts';

export { HttpError };

/**
 * One queue per host, so a burst of calls to DexScreener cannot spend the
 * RugCheck budget and vice versa. Each host gets a minimum gap between
 * requests plus a cooldown honoured after a 429.
 */
interface HostLimit {
  minGapMs: number;
  last: number;
  chain: Promise<void>;
  cooldownUntil: number;
}

const limits = new Map<string, HostLimit>();

/** 429s received per host since start, including ones a retry recovered from. */
const throttled = new Map<string, number>();

/** How often a host has told us to slow down. A retried 429 still counts. */
export function throttleCount(host: string): number {
  return throttled.get(host) ?? 0;
}

/** Requests per minute we allow ourselves per host, kept under published caps. */
const RPM: Record<string, number> = {
  'api.dexscreener.com': 120,
  'lite-api.jup.ag': 120,
  'api.rugcheck.xyz': 30,
  'public-api.birdeye.so': 50,
  'mainnet.helius-rpc.com': 120,
  // Published limit: 100 requests per 10 s per IP, 40 per 10 s for any one
  // method (solana.com/docs/references/clusters). Measured 2026-09-27, the
  // endpoint enforces less than that for getTransaction: at 2.5/s, 19 of 30
  // calls got 429 with Retry-After: 10; at 1/s, 30 of 30 succeeded. The
  // measured rate is the one that counts.
  'api.mainnet-beta.solana.com': 60,
  'api.typesafe.ai': 60,
};

function limitFor(host: string): HostLimit {
  let limit = limits.get(host);
  if (!limit) {
    const rpm = RPM[host] ?? 60;
    limit = {
      minGapMs: Math.ceil(60_000 / rpm),
      last: 0,
      chain: Promise.resolve(),
      cooldownUntil: 0,
    };
    limits.set(host, limit);
  }
  return limit;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Serialises calls per host and spaces them out. */
function schedule<T>(host: string, task: () => Promise<T>): Promise<T> {
  const limit = limitFor(host);
  const run = limit.chain.then(async () => {
    const now = Date.now();
    const earliest = Math.max(limit.last + limit.minGapMs, limit.cooldownUntil);
    if (earliest > now) await sleep(earliest - now);
    limit.last = Date.now();
  });
  limit.chain = run.catch(() => undefined);
  return run.then(task);
}

export interface FetchOptions {
  headers?: Record<string, string>;
  method?: string;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  /** Treat these statuses as no-data and resolve to null instead of throwing. */
  nullOn?: number[];
}

/**
 * Rate-limited JSON fetch with retry on 429, 5xx and network errors.
 * Resolves to null for statuses listed in nullOn (404 by default).
 */
export async function getJson<T>(url: string, options: FetchOptions = {}): Promise<T | null> {
  const {
    timeoutMs = 12_000,
    retries = 2,
    nullOn = [404],
    method = 'GET',
    body,
    headers = {},
  } = options;
  const host = new URL(url).host;

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await schedule(host, () =>
        fetch(url, {
          method,
          headers: {
            accept: 'application/json',
            'user-agent': 'token-finder/0.1 (local research tool)',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );

      if (response.ok) return (await response.json()) as T;
      if (nullOn.includes(response.status)) return null;

      const text = (await response.text().catch(() => '')).slice(0, 300);

      if (response.status === 429) {
        throttled.set(host, (throttled.get(host) ?? 0) + 1);
        const retryAfter = Number(response.headers.get('retry-after'));
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * (attempt + 1);
        limitFor(host).cooldownUntil = Date.now() + waitMs;
        log.debug(`429 from ${host}, backing off ${waitMs}ms`);
        lastError = new HttpError(429, url, text);
        continue;
      }

      if (response.status >= 500) {
        lastError = new HttpError(response.status, url, text);
        await sleep(500 * (attempt + 1));
        continue;
      }

      throw new HttpError(response.status, url, text);
    } catch (error) {
      lastError = error;
      if (error instanceof HttpError && error.status < 500 && error.status !== 429) throw error;
      if (attempt < retries) await sleep(500 * (attempt + 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Request failed: ${url}`);
}

/**
 * Like getJson but never throws: failures become null and are logged at debug
 * level. Used for optional enrichment so one flaky API cannot abort a scan.
 *
 * Prefer {@link getOutcome} for anything that feeds the evidence model. This
 * returns `null` for both "the provider said there is nothing" and "the
 * provider never answered", and those are not the same fact.
 */
export async function tryGetJson<T>(url: string, options: FetchOptions = {}): Promise<T | null> {
  try {
    return await getJson<T>(url, options);
  } catch (error) {
    log.debug(`soft-fail ${url}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/** A provider answer, or the classified reason there is not one. */
export interface ProviderResult<T> {
  data: T | null;
  failure: ProviderFailure | null;
}

/**
 * Fetches without throwing, keeping *why* it failed.
 *
 * This is the difference between a scan that silently degrades and one that can
 * say "RugCheck timed out for 12 tokens". `tryGetJson` collapses an outage and
 * an empty result into the same `null`, which makes a provider being down look
 * exactly like a token having no data - so the evidence model cannot tell
 * UNAVAILABLE from UNKNOWN, and nobody finds out the provider is down.
 */
export async function getOutcome<T>(
  provider: string,
  url: string,
  options: FetchOptions = {},
): Promise<ProviderResult<T>> {
  try {
    return { data: await getJson<T>(url, options), failure: null };
  } catch (error) {
    const failure = classifyFailure(provider, error);
    log.debug(`${provider} failed (${failure.kind}): ${failure.message}`);
    return { data: null, failure };
  }
}

/** Outcome of one pooled task. Mirrors PromiseSettledResult, with the index. */
export type PoolResult<Out> =
  | { status: 'fulfilled'; index: number; value: Out }
  | { status: 'rejected'; index: number; reason: unknown };

/**
 * Runs tasks with bounded concurrency, preserving input order.
 *
 * **Never rejects.** Each task is caught inside its own runner, so one failing
 * item cannot abort the batch or leave the remaining runners detached - which
 * is what the previous `Promise.all(runners)` did: it rejected on the first
 * failure while the other runners kept consuming the cursor in the background,
 * so a single provider timeout ended a scan *and* left work running against a
 * result nobody was waiting for.
 *
 * Callers decide what a failure means; this only guarantees the batch finishes.
 */
export async function poolSettled<In, Out>(
  items: In[],
  limit: number,
  worker: (item: In, index: number) => Promise<Out>,
): Promise<PoolResult<Out>[]> {
  const results = new Array<PoolResult<Out>>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = {
          status: 'fulfilled',
          index,
          value: await worker(items[index] as In, index),
        };
      } catch (reason) {
        results[index] = { status: 'rejected', index, reason };
      }
    }
  });

  // Safe now: no runner can reject, because every task is caught above.
  await Promise.all(runners);
  return results;
}

/**
 * Bounded-concurrency pool that keeps only the successful results.
 *
 * For callers that treat a failed item as "no data for this item" - the common
 * case for optional enrichment. Failures are handed to `onError` so they can
 * still be recorded rather than vanishing.
 */
export async function pool<In, Out>(
  items: In[],
  limit: number,
  worker: (item: In, index: number) => Promise<Out>,
  onError?: (reason: unknown, item: In, index: number) => void,
): Promise<Out[]> {
  const settled = await poolSettled(items, limit, worker);
  const out: Out[] = [];

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      out.push(result.value);
    } else if (onError) {
      onError(result.reason, items[result.index] as In, result.index);
    }
  }

  return out;
}
