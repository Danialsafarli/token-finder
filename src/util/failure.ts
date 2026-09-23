/**
 * Provider failure taxonomy.
 *
 * A failed request is evidence too - it tells us *why* we do not know something,
 * which decides whether retrying helps, whether the signal is UNAVAILABLE rather
 * than UNKNOWN, and whether an operator should look at a provider or at us.
 *
 * Collapsing every failure into "no data" loses all of that, and worse, makes a
 * provider outage look identical to a token that genuinely has no pair.
 */

import { HttpError } from './http-error.ts';

export type ProviderFailureKind =
  /** The request exceeded its deadline. */
  | 'TIMEOUT'
  /** The provider asked us to slow down (429). */
  | 'RATE_LIMITED'
  /** DNS, connection reset, offline - the request never reached the provider. */
  | 'NETWORK_ERROR'
  /** The provider answered, but the body was not usable JSON. */
  | 'INVALID_RESPONSE'
  /** The provider answered with a server-side failure (5xx), or is not configured. */
  | 'PROVIDER_UNAVAILABLE'
  /** Anything we could not classify. Never assumed retryable. */
  | 'UNKNOWN';

export interface ProviderFailure {
  provider: string;
  kind: ProviderFailureKind;
  /** Short, safe description. Never contains credentials. */
  message: string;
  at: number;
  /**
   * Whether retrying could plausibly succeed. A 429 or a timeout might; a
   * malformed body will produce the same malformed body.
   */
  retryable: boolean;
}

/** Failures worth trying again. Everything else is a waste of the rate budget. */
const RETRYABLE: ReadonlySet<ProviderFailureKind> = new Set([
  'TIMEOUT',
  'RATE_LIMITED',
  'NETWORK_ERROR',
  'PROVIDER_UNAVAILABLE',
]);

/**
 * Maps a thrown value onto the taxonomy.
 *
 * Deliberately conservative: anything unrecognised is UNKNOWN and not retryable,
 * because blindly retrying an error we do not understand is how a scan turns
 * into a rate-limit spiral.
 */
export function classifyFailure(provider: string, error: unknown): ProviderFailure {
  const at = Date.now();
  const kind = kindOf(error);
  return {
    provider,
    kind,
    message: describeError(error),
    at,
    retryable: RETRYABLE.has(kind),
  };
}

function kindOf(error: unknown): ProviderFailureKind {
  if (error instanceof HttpError) {
    if (error.status === 429) return 'RATE_LIMITED';
    if (error.status >= 500) return 'PROVIDER_UNAVAILABLE';
    // 4xx other than 429: the provider understood us and refused. Retrying the
    // same request will be refused the same way.
    return 'INVALID_RESPONSE';
  }

  if (error instanceof Error) {
    const name = error.name;
    const message = error.message.toLowerCase();

    // AbortSignal.timeout() rejects with a TimeoutError; older runtimes use
    // AbortError, and undici surfaces the wording in the message.
    if (name === 'TimeoutError' || name === 'AbortError') return 'TIMEOUT';
    if (message.includes('timeout') || message.includes('aborted')) return 'TIMEOUT';

    if (name === 'SyntaxError' || message.includes('json')) return 'INVALID_RESPONSE';

    // undici wraps connection problems in a TypeError with a cause.
    if (name === 'TypeError' && message.includes('fetch failed')) return 'NETWORK_ERROR';
    if (
      message.includes('econnrefused') ||
      message.includes('econnreset') ||
      message.includes('enotfound') ||
      message.includes('network')
    ) {
      return 'NETWORK_ERROR';
    }
  }

  return 'UNKNOWN';
}

/** Trims an error to something safe to log and store. */
export function describeError(error: unknown): string {
  if (error instanceof HttpError) return `HTTP ${error.status}`;
  if (error instanceof Error) return error.message.slice(0, 200);
  return String(error).slice(0, 200);
}

/** A provider that was never configured, so it cannot answer at all. */
export function notConfigured(provider: string): ProviderFailure {
  return {
    provider,
    kind: 'PROVIDER_UNAVAILABLE',
    message: 'no API key configured',
    at: Date.now(),
    retryable: false,
  };
}
