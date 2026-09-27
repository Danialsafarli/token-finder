/**
 * Solana JSON-RPC for the data backbone.
 *
 * One client, three possible endpoints, chosen once:
 *
 * 1. `SOLANA_RPC_URL`, when set - any provider the operator prefers;
 * 2. Helius, when `HELIUS_API_KEY` is set;
 * 3. the public mainnet endpoint otherwise.
 *
 * The public endpoint is real and keyless, and it serves every method the
 * backbone uses. It is also, in Solana's own words, "not intended for
 * production applications": 100 requests per 10 s per IP, 40 per 10 s for any
 * one method, subject to change without notice (Tier 1: solana.com/docs/
 * references/clusters). Measured, it allows less for `getTransaction` - about
 * one a second (see util/http.ts) - so that is the rate the backbone keeps,
 * and every call reports its failure rather than retrying into a ban. The endpoint
 * in use is always reported, so a reading is never presented as coming from
 * a stronger source than it did.
 *
 * Calls read at `finalized` commitment: this is history, and a finalized slot
 * cannot be rolled back. Transactions are requested with
 * `maxSupportedTransactionVersion: 1`, so a v1 transaction is returned rather
 * than turned into an error (verified live: mainnet accepts it and returns v0
 * transactions unchanged).
 *
 * The existing safety path (`helius.ts`) is unchanged and still Helius-only.
 */

import { config, hasHelius } from '../config.ts';
import { getOutcome, throttleCount, type ProviderResult } from '../util/http.ts';
import { ValidationReport, validMint } from '../core/validate.ts';

export const PUBLIC_MAINNET_RPC = 'https://api.mainnet-beta.solana.com';

export type RpcEndpointKind = 'custom' | 'helius' | 'public';

export interface RpcEndpoint {
  kind: RpcEndpointKind;
  /** Stored as provenance on every row. Never contains a credential. */
  label: string;
}

export function rpcEndpoint(): RpcEndpoint {
  if (config.solanaRpcUrl !== null) return { kind: 'custom', label: 'solana-rpc:custom' };
  if (hasHelius()) return { kind: 'helius', label: 'solana-rpc:helius' };
  return { kind: 'public', label: 'solana-rpc:public' };
}

function rpcUrl(): string {
  if (config.solanaRpcUrl !== null) return config.solanaRpcUrl;
  if (hasHelius()) return `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;
  return PUBLIC_MAINNET_RPC;
}

export const COMMITMENT = 'finalized';

/** 429s this endpoint has returned since start, including retried ones. */
export function rpcThrottleCount(): number {
  try {
    return throttleCount(new URL(rpcUrl()).host);
  } catch {
    return 0;
  }
}

/** Counts calls and failures per method since the process started. */
const counters = new Map<string, { calls: number; failures: number; rateLimited: number }>();

export function rpcCounters(): Record<string, { calls: number; failures: number; rateLimited: number }> {
  return Object.fromEntries(counters);
}

async function call<T>(method: string, params: unknown[]): Promise<ProviderResult<T>> {
  const count = counters.get(method) ?? { calls: 0, failures: 0, rateLimited: 0 };
  counters.set(method, count);
  count.calls += 1;

  const outcome = await getOutcome<{ result?: T; error?: { message?: unknown } }>('solana-rpc', rpcUrl(), {
    method: 'POST',
    body: { jsonrpc: '2.0', id: method, method, params },
    // One retry: the http layer already honours Retry-After on a 429. Beyond
    // that, the budget is better spent on the next cycle than on this call.
    retries: 1,
    timeoutMs: 15_000,
    nullOn: [],
  });

  if (outcome.failure !== null) {
    count.failures += 1;
    if (outcome.failure.kind === 'RATE_LIMITED') count.rateLimited += 1;
    return { data: null, failure: outcome.failure };
  }

  const rpcError = outcome.data?.error;
  if (rpcError !== undefined) {
    count.failures += 1;
    return {
      data: null,
      failure: {
        provider: 'solana-rpc',
        kind: 'INVALID_RESPONSE',
        message: String(rpcError.message ?? 'rpc error').slice(0, 200),
        at: Date.now(),
        retryable: false,
      },
    };
  }

  return { data: outcome.data?.result ?? null, failure: null };
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  blockTimeMs: number | null;
  failed: boolean;
  /** Position within the block, when the node reports it. */
  transactionIndex: number | null;
}

/**
 * Signatures of transactions that loaded `address`, newest first.
 *
 * `until` stops before a known signature (exclusive) - the cursor that makes
 * collection incremental. `limit` is at most 1000.
 */
export async function getSignatures(
  address: string,
  options: { limit: number; until?: string; before?: string },
): Promise<ProviderResult<SignatureInfo[]>> {
  const result = await call<unknown[]>('getSignaturesForAddress', [
    address,
    {
      limit: Math.max(1, Math.min(1000, Math.trunc(options.limit))),
      commitment: COMMITMENT,
      ...(options.until ? { until: options.until } : {}),
      ...(options.before ? { before: options.before } : {}),
    },
  ]);
  if (result.failure !== null) return { data: null, failure: result.failure };
  if (!Array.isArray(result.data)) {
    return {
      data: null,
      failure: { provider: 'solana-rpc', kind: 'INVALID_RESPONSE', message: 'signatures: not an array', at: Date.now(), retryable: false },
    };
  }
  return { data: parseSignatures(result.data), failure: null };
}

/** Pure boundary validation of a `getSignaturesForAddress` result. */
export function parseSignatures(raw: unknown[]): SignatureInfo[] {
  const report = new ValidationReport('solana-rpc');
  const out: SignatureInfo[] = [];
  for (const [i, entry] of raw.entries()) {
    const e = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
    const signature = typeof e.signature === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(e.signature) ? e.signature : null;
    const slot = typeof e.slot === 'number' && Number.isSafeInteger(e.slot) && e.slot >= 0 ? e.slot : null;
    if (signature === null || slot === null) {
      report.reject(`signatures[${i}]`, 'missing signature or slot', entry);
      continue;
    }
    out.push({
      signature,
      slot,
      blockTimeMs: typeof e.blockTime === 'number' && e.blockTime > 0 ? e.blockTime * 1000 : null,
      failed: e.err !== null && e.err !== undefined,
      transactionIndex: typeof e.transactionIndex === 'number' ? e.transactionIndex : null,
    });
  }
  return out;
}

// --- transaction cache ------------------------------------------------------
// A finalized transaction never changes, so a fetched one is kept (bounded,
// oldest evicted first) and a request already in flight is shared rather than
// repeated. Wallet histories overlap heavily - the same swap is in the buyer's
// history, the pool's and the next buyer's - so this is most of the saving.

const TX_CACHE_LIMIT = 4_000;
const txCache = new Map<string, unknown>();
const inFlight = new Map<string, Promise<ProviderResult<unknown>>>();
let txCacheHits = 0;

function remember(signature: string, tx: unknown): void {
  if (txCache.has(signature)) return;
  if (txCache.size >= TX_CACHE_LIMIT) {
    const oldest = txCache.keys().next().value;
    if (oldest !== undefined) txCache.delete(oldest);
  }
  txCache.set(signature, tx);
}

export function txCacheStats(): { size: number; hits: number } {
  return { size: txCache.size, hits: txCacheHits };
}

/** One transaction, jsonParsed. `data` is null when the node does not have it. */
export async function getParsedTransaction(signature: string): Promise<ProviderResult<unknown>> {
  const hit = txCache.get(signature);
  if (hit !== undefined) {
    txCacheHits += 1;
    return { data: hit, failure: null };
  }
  const pending = inFlight.get(signature);
  if (pending !== undefined) return pending;
  const request = call<unknown>('getTransaction', [
    signature,
    { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: COMMITMENT },
  ]).then((result) => {
    if (result.failure === null && result.data !== null) remember(signature, result.data);
    return result;
  });
  inFlight.set(signature, request);
  try {
    return await request;
  } finally {
    inFlight.delete(signature);
  }
}

// --- address history ------------------------------------------------------------

export interface AddressHistory {
  /** Full jsonParsed transactions, in the order asked for. */
  txs: unknown[];
  /** True when the whole history fit in the page: nothing older (asc) or newer (desc) exists beyond it. */
  complete: boolean;
  /** How it was read, which bounds what it can say. */
  method: 'gtfa' | 'signatures+transactions' | 'unsupported';
}

/** Whether the endpoint serves Helius's getTransactionsForAddress. */
export function supportsAddressHistory(): boolean {
  if (rpcEndpoint().kind === 'helius') return true;
  try {
    return config.solanaRpcUrl !== null && new URL(config.solanaRpcUrl).host.endsWith('helius-rpc.com');
  } catch {
    return false;
  }
}

/**
 * An address's transactions, oldest first (`asc`) or newest first (`desc`).
 *
 * With Helius this is one `getTransactionsForAddress` call (Tier 2: Helius
 * docs; verified live 2026-09-27: 100 full transactions in ~120 ms). It is
 * what makes "who first funded this wallet" answerable at all: the oldest
 * transactions come back directly instead of by paging backwards through the
 * whole history.
 *
 * Elsewhere, `desc` falls back to signatures plus one fetch each, and `asc`
 * is reported as unsupported - it is not faked by walking an unbounded
 * history. The caller records the resulting truncation.
 */
export async function addressHistory(
  address: string,
  options: { order: 'asc' | 'desc'; limit: number; succeededOnly?: boolean },
): Promise<ProviderResult<AddressHistory>> {
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit)));
  if (supportsAddressHistory()) {
    const result = await call<{ data?: unknown[]; paginationToken?: string | null }>('getTransactionsForAddress', [
      address,
      {
        transactionDetails: 'full',
        sortOrder: options.order,
        limit,
        encoding: 'jsonParsed',
        maxSupportedTransactionVersion: 1,
        commitment: COMMITMENT,
        ...(options.succeededOnly ? { filters: { status: 'succeeded' } } : {}),
      },
    ]);
    if (result.failure !== null) return { data: null, failure: result.failure };
    const txs = Array.isArray(result.data?.data) ? result.data.data : [];
    for (const tx of txs) {
      const signature = (tx as { transaction?: { signatures?: unknown[] } })?.transaction?.signatures?.[0];
      if (typeof signature === 'string') remember(signature, tx);
    }
    return { data: { txs, complete: txs.length < limit, method: 'gtfa' }, failure: null };
  }
  if (options.order === 'asc') {
    return { data: { txs: [], complete: false, method: 'unsupported' }, failure: null };
  }
  const page = await getSignatures(address, { limit });
  if (page.failure !== null || page.data === null) return { data: null, failure: page.failure };
  const wanted = page.data.filter((s) => !(options.succeededOnly && s.failed));
  const txs: unknown[] = [];
  for (const s of wanted) {
    const tx = await getParsedTransaction(s.signature);
    if (tx.data !== null) txs.push(tx.data);
  }
  return { data: { txs, complete: page.data.length < limit, method: 'signatures+transactions' }, failure: null };
}

/** Up to 100 accounts, jsonParsed, in one call. Null entries are accounts that do not exist. */
export async function getMultipleAccounts(addresses: string[]): Promise<ProviderResult<unknown[]>> {
  if (addresses.length === 0) return { data: [], failure: null };
  const result = await call<{ value?: unknown[] }>('getMultipleAccounts', [
    addresses.slice(0, 100),
    { encoding: 'jsonParsed', commitment: COMMITMENT },
  ]);
  if (result.failure !== null) return { data: null, failure: result.failure };
  return { data: Array.isArray(result.data?.value) ? result.data.value : [], failure: null };
}

/** A mint account, jsonParsed - for live verification of the safety parser. */
export async function getParsedAccount(address: string): Promise<ProviderResult<unknown>> {
  const report = new ValidationReport('solana-rpc');
  if (validMint(report, 'address', address) === null) {
    return { data: null, failure: { provider: 'solana-rpc', kind: 'INVALID_RESPONSE', message: 'not an address', at: Date.now(), retryable: false } };
  }
  return call<unknown>('getAccountInfo', [address, { encoding: 'jsonParsed', commitment: COMMITMENT }]);
}

/** Largest token accounts of a mint - for live verification only. */
export async function getLargestAccounts(mint: string): Promise<ProviderResult<unknown>> {
  return call<unknown>('getTokenLargestAccounts', [mint, { commitment: COMMITMENT }]);
}
