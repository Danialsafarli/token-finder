/**
 * The local server's security boundary.
 *
 * Token Finder is a local tool, but "local" is not a security boundary on its
 * own. Three concrete threats apply to a dashboard on localhost, and each rule
 * here answers one of them:
 *
 * 1. **LAN exposure.** Binding every interface put the dashboard, and its
 *    unauthenticated scan endpoint, on the local network. The default bind is
 *    loopback (config.host); exposing it is an explicit choice.
 *
 * 2. **DNS rebinding.** A web page on attacker.example can make its hostname
 *    resolve to 127.0.0.1, after which the browser treats requests to this
 *    server as same-origin *to the attacker*. The defence is to refuse any
 *    request whose Host header is not a loopback name at our port - the attacker
 *    cannot make the browser send `Host: localhost`.
 *
 * 3. **Cross-site requests.** Any page the user visits can send a simple POST to
 *    localhost without a preflight. State-changing endpoints require an Origin
 *    header naming this exact origin. Browsers always attach Origin to POST and
 *    scripts cannot forge it.
 *
 * Plus a Content-Security-Policy strict enough to matter: scripts only from
 * this origin, no inline script, no inline style, no `eval`, no framing. With the
 * escape-by-default renderer that is two independent layers against injection.
 */

import type { IncomingMessage } from 'node:http';

const LOOPBACK_NAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackBind(host: string): boolean {
  return LOOPBACK_NAMES.has(host) || host.startsWith('127.');
}

/** Splits a Host header into name and port, understanding bracketed IPv6. */
function splitHost(header: string): { name: string; port: number | null } | null {
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(header.trim().toLowerCase());
  if (!match) return null;
  return { name: match[1]!, port: match[2] === undefined ? null : Number(match[2]) };
}

/**
 * Whether a request's Host header is acceptable.
 *
 * Only enforced when bound to loopback. When an operator binds a public
 * interface on purpose, the set of legitimate hostnames is theirs to know, not
 * ours to guess, so the check steps aside rather than break their setup.
 */
export function hostAllowed(hostHeader: string | undefined, port: number, bindHost: string): boolean {
  if (!isLoopbackBind(bindHost)) return true;
  if (!hostHeader) return false;
  const parsed = splitHost(hostHeader);
  if (!parsed) return false;
  // Browsers omit the port only for 80/443, which a local dev server is not on.
  return LOOPBACK_NAMES.has(parsed.name) && parsed.port === port;
}

export interface OriginDecision {
  ok: boolean;
  reason: string;
}

/**
 * Same-origin check for state-changing requests.
 *
 * The Origin must be `http://<the Host this request was sent to>`. Missing
 * Origin is refused: every browser attaches it to POST, so its absence means a
 * non-browser client, which has no business triggering scans through the
 * dashboard's endpoint.
 */
export function sameOrigin(req: IncomingMessage): OriginDecision {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin) return { ok: false, reason: 'missing Origin header' };
  if (!host) return { ok: false, reason: 'missing Host header' };

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: false, reason: 'malformed Origin header' };
  }
  if (parsed.protocol !== 'http:' || parsed.host !== host.toLowerCase()) {
    return { ok: false, reason: 'cross-origin request' };
  }

  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin') {
    return { ok: false, reason: `Sec-Fetch-Site: ${site}` };
  }
  return { ok: true, reason: 'same origin' };
}

/**
 * Content-Security-Policy.
 *
 * `img-src https:` is the one widening, and it is necessary: token icons are
 * hosted wherever each project put them. Images cannot execute, and the
 * renderer only accepts https URLs for them anyway.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' https:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  // The dashboard's URL never leaves the machine when a user follows a link out.
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

/**
 * An external URL safe to put in an `href`, or null.
 *
 * Parsed, not pattern-matched: `new URL` normalises case, whitespace and
 * encoded schemes (`JaVaScRiPt:`, `java\tscript:`), so the protocol check sees
 * what a browser would. Only http and https survive.
 */
export function safeHttpUrl(raw: unknown, options: { httpsOnly?: boolean } = {}): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  const allowed = options.httpsOnly ? ['https:'] : ['https:', 'http:'];
  if (!allowed.includes(parsed.protocol)) return null;
  // Credentials in a link are either a mistake or a phishing trick.
  if (parsed.username || parsed.password) return null;
  return parsed.href;
}
