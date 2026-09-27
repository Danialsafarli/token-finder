/**
 * Secret redaction for anything that leaves the process.
 *
 * Provider errors carry the URL that failed, and some provider URLs carry the
 * credential in the query string - Helius takes `?api-key=`. That text reaches
 * logs, the failure taxonomy, and now the `provider_failures` table, where it
 * would be written to disk and survive indefinitely.
 *
 * So redaction happens at the point the message is built, not at the point it
 * is displayed. Two layers, because either alone has a gap:
 *
 * 1. **Known values.** Every configured secret is masked wherever it appears,
 *    whatever the surrounding text looks like. This is the strong guarantee.
 * 2. **Secret-shaped query parameters.** Masks `api-key`, `apikey`, `key`,
 *    `token`, `secret`, `password` and `access_token` in any URL, which covers
 *    a provider added later whose key never passes through `config`.
 */

import { config } from '../config.ts';

const REDACTED = '***';

/** Query parameter names whose values are credentials, whoever set them. */
const SECRET_PARAMS = /([?&](?:api[-_]?key|key|token|secret|password|access[-_]?token)=)([^&\s]+)/gi;

/**
 * Secret values known to this process.
 *
 * Read lazily rather than at module load: `config` is a frozen snapshot of the
 * environment, but this module may be imported before a test has finished
 * arranging it. Short values are ignored - masking a two-character "key" would
 * corrupt unrelated text without protecting anything.
 */
function knownSecrets(): string[] {
  return [config.heliusApiKey, config.birdeyeApiKey, config.typesafeApiKey, config.solanaRpcUrl].filter(
    (value): value is string => typeof value === 'string' && value.length >= 8,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Masks every credential this process knows about, plus anything that looks
 * like one in a URL.
 *
 * Safe on arbitrary text: it never throws and never returns undefined, because
 * its callers are error paths that must not fail again.
 */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;

  let out = text;
  for (const secret of knownSecrets()) {
    out = out.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTED);
  }
  return out.replace(SECRET_PARAMS, `$1${REDACTED}`);
}

/** Redacts a URL for safe inclusion in an error message or a stored record. */
export function redactUrl(url: string): string {
  return redactSecrets(url);
}
