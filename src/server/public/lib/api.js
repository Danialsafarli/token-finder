// @ts-check
/**
 * API client. Every request has a timeout, and every failure is a typed error
 * the views can render - never a silent stale screen.
 */

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {'offline' | 'timeout' | 'http' | 'parse'} kind
   * @param {number} [status]
   */
  constructor(message, kind, status) {
    super(message);
    this.kind = kind;
    this.status = status ?? 0;
  }
}

/**
 * @template T
 * @param {string} path
 * @param {{ timeoutMs?: number, method?: string, signal?: AbortSignal }} [options]
 * @returns {Promise<T>}
 */
export async function api(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 12_000);
  if (options.signal) options.signal.addEventListener('abort', () => controller.abort(), { once: true });

  let response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      signal: controller.signal,
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
  } catch (error) {
    if (options.signal?.aborted) throw new ApiError('cancelled', 'timeout');
    const timedOut = error instanceof DOMException && error.name === 'AbortError';
    throw new ApiError(timedOut ? 'The server did not answer in time.' : 'The Token Finder server cannot be reached.', timedOut ? 'timeout' : 'offline');
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.json()).error ?? '';
    } catch {
      // Body was not JSON; the status is enough.
    }
    throw new ApiError(detail || `Request failed (${response.status}).`, 'http', response.status);
  }
  try {
    return /** @type {T} */ (await response.json());
  } catch {
    throw new ApiError('The server sent a response that could not be read.', 'parse');
  }
}
