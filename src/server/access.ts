/**
 * Public access control: what stops an anonymous visitor from spending
 * Token Finder's provider budget.
 *
 * Locally nothing here applies - the loopback bind, the Host check and the
 * same-origin rule in `security.ts` are the boundary. Once the server is
 * exposed (HOST is not loopback), two endpoints are expensive and must be
 * bounded:
 *
 * - `POST /api/analyze` runs the full pipeline on one token (market, safety
 *   providers, Helius). Bounded per client and globally, per hour.
 * - `POST /api/scan` runs a whole discovery pass. Bounded by a global minimum
 *   interval between manual scans, and per client. The scheduled monitor is
 *   unaffected: it is the product.
 *
 * Plus a cap on concurrent live streams, and a per-client ceiling on API reads
 * so a single client cannot flood the process.
 *
 * Lightweight on purpose: no accounts. The operator can bypass the limits with
 * `ADMIN_TOKEN` (sent as `Authorization: Bearer ...`), compared in constant
 * time. Behind a proxy (`TRUST_PROXY=true`) the client is the first
 * X-Forwarded-For address; otherwise it is the socket's peer.
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export interface AccessPolicy {
  /** False on a loopback bind: every limit below is off. */
  public: boolean;
  trustProxy: boolean;
  adminToken: string | null;
  analyzePerClientPerHour: number;
  analyzePerHour: number;
  scanPerClientPerHour: number;
  /** Minimum seconds between two manual scans, from anyone. */
  scanMinIntervalSec: number;
  apiReadsPerClientPerMinute: number;
  maxStreams: number;
}

export interface Allowance {
  ok: boolean;
  /** Seconds until the request would be allowed; set when refused. */
  retryAfterSec?: number;
  reason?: string;
}

/**
 * A sliding-window counter per key. Memory is bounded: keys whose window has
 * passed are dropped as the map is swept.
 */
export class WindowLimiter {
  readonly #hits = new Map<string, number[]>();
  readonly #limit: number;
  readonly #windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  /** Counts a hit if under the limit. */
  take(key: string, now: number): Allowance {
    if (this.#limit <= 0) return { ok: false, retryAfterSec: Math.ceil(this.#windowMs / 1000), reason: 'disabled' };
    const since = now - this.#windowMs;
    const hits = (this.#hits.get(key) ?? []).filter((t) => t > since);
    if (hits.length >= this.#limit) {
      this.#hits.set(key, hits);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((hits[0]! + this.#windowMs - now) / 1000)) };
    }
    hits.push(now);
    this.#hits.set(key, hits);
    if (this.#hits.size > 10_000) this.#sweep(since);
    return { ok: true };
  }

  #sweep(since: number): void {
    for (const [key, hits] of this.#hits) if (hits.every((t) => t <= since)) this.#hits.delete(key);
  }
}

const HOUR = 3_600_000;

export class AccessGate {
  readonly policy: AccessPolicy;
  readonly #analyzeClient: WindowLimiter;
  readonly #analyzeGlobal: WindowLimiter;
  readonly #scanClient: WindowLimiter;
  readonly #reads: WindowLimiter;
  #lastManualScan = -Infinity;
  #streams = 0;

  constructor(policy: AccessPolicy) {
    this.policy = policy;
    this.#analyzeClient = new WindowLimiter(policy.analyzePerClientPerHour, HOUR);
    this.#analyzeGlobal = new WindowLimiter(policy.analyzePerHour, HOUR);
    this.#scanClient = new WindowLimiter(policy.scanPerClientPerHour, HOUR);
    this.#reads = new WindowLimiter(policy.apiReadsPerClientPerMinute, 60_000);
  }

  /** The requesting client, for per-client limits. */
  client(req: IncomingMessage): string {
    if (this.policy.trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  /** The operator, presenting ADMIN_TOKEN. */
  isAdmin(req: IncomingMessage): boolean {
    const token = this.policy.adminToken;
    const header = req.headers.authorization;
    if (!token || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const given = Buffer.from(header.slice(7));
    const expected = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  #exempt(req: IncomingMessage): boolean {
    return !this.policy.public || this.isAdmin(req);
  }

  analyze(req: IncomingMessage, now: number): Allowance {
    if (this.#exempt(req)) return { ok: true };
    const mine = this.#analyzeClient.take(this.client(req), now);
    if (!mine.ok) return { ...mine, reason: `at most ${this.policy.analyzePerClientPerHour} analyses per hour from one client` };
    const all = this.#analyzeGlobal.take('*', now);
    if (!all.ok) return { ...all, reason: 'the hourly analysis budget is spent' };
    return { ok: true };
  }

  scan(req: IncomingMessage, now: number): Allowance {
    if (this.#exempt(req)) return { ok: true };
    const wait = this.#lastManualScan + this.policy.scanMinIntervalSec * 1000 - now;
    if (wait > 0) return { ok: false, retryAfterSec: Math.ceil(wait / 1000), reason: 'a live scan ran moments ago; the Board already has its results' };
    const mine = this.#scanClient.take(this.client(req), now);
    if (!mine.ok) return { ...mine, reason: `at most ${this.policy.scanPerClientPerHour} manual scans per hour from one client` };
    this.#lastManualScan = now;
    return { ok: true };
  }

  read(req: IncomingMessage, now: number): Allowance {
    if (this.#exempt(req)) return { ok: true };
    const r = this.#reads.take(this.client(req), now);
    return r.ok ? r : { ...r, reason: 'too many requests' };
  }

  /** Opens a stream slot; the returned function releases it. Null when full. */
  openStream(req: IncomingMessage): (() => void) | null {
    if (!this.#exempt(req) && this.#streams >= this.policy.maxStreams) return null;
    this.#streams += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.#streams -= 1;
      }
    };
  }
}
