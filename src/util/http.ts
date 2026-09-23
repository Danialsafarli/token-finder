import { log } from './logger.ts';

export class HttpError extends Error {
  status: number;
  url: string;
  body: string;

  constructor(status: number, url: string, body: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

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

/** Requests per minute we allow ourselves per host, kept under published caps. */
const RPM: Record<string, number> = {
  'api.dexscreener.com': 120,
  'lite-api.jup.ag': 120,
  'api.rugcheck.xyz': 30,
  'public-api.birdeye.so': 50,
  'mainnet.helius-rpc.com': 120,
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
 */
export async function tryGetJson<T>(url: string, options: FetchOptions = {}): Promise<T | null> {
  try {
    return await getJson<T>(url, options);
  } catch (error) {
    log.debug(`soft-fail ${url}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/** Runs tasks with bounded concurrency, preserving input order. */
export async function pool<In, Out>(
  items: In[],
  limit: number,
  worker: (item: In, index: number) => Promise<Out>,
): Promise<Out[]> {
  const results = new Array<Out>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as In, index);
    }
  });

  await Promise.all(runners);
  return results;
}
