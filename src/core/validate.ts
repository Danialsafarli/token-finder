/**
 * Provider boundary validation.
 *
 * Every external response passes through here before any of it reaches the
 * evidence model. The rule this file exists to enforce: a malformed provider
 * field must never become a number that scores. It becomes `null` plus a
 * recorded issue, and the evidence layer turns that pair into INVALID - which
 * earns nothing and is reported separately from "we never asked".
 *
 * Deliberately not a schema framework. The set of fields Token Finder actually
 * consumes is small and stable, and an explicit validator per field is easier
 * to audit than a schema DSL - you can read exactly what "impossible" means for
 * each one.
 */

/** Solana mainnet genesis, the earliest timestamp any Solana pool can carry. */
const SOLANA_GENESIS_MS = Date.parse('2020-03-16T00:00:00Z');

/** Tolerance for provider clocks running ahead of ours. */
const FUTURE_SKEW_MS = 10 * 60_000;

export interface FieldIssue {
  /** Dotted path of the offending field, e.g. `audit.topHoldersPercentage`. */
  field: string;
  reason: string;
  /** What the provider actually sent, truncated for safe logging. */
  received: string;
}

/** Collects every rejected field for one provider response. */
export class ValidationReport {
  readonly provider: string;
  readonly issues: FieldIssue[] = [];

  constructor(provider: string) {
    this.provider = provider;
  }

  reject(field: string, reason: string, received: unknown): null {
    this.issues.push({ field, reason, received: describe(received) });
    return null;
  }

  get ok(): boolean {
    return this.issues.length === 0;
  }
}

/** Short, safe rendering of an arbitrary provider value for an issue record. */
export function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value.slice(0, 40));
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object') return `object(${Object.keys(value).slice(0, 4).join(',')})`;
  return typeof value;
}

export interface NumberRule {
  /** Inclusive lower bound. A value below this is impossible, not merely odd. */
  min?: number;
  /** Inclusive upper bound. */
  max?: number;
  integer?: boolean;
  /** Accept a numeric string, as DexScreener sends for `priceUsd`. */
  fromString?: boolean;
}

/**
 * Absent (`null`/`undefined`) returns null with no issue - that is UNKNOWN, a
 * legitimate state. Present-but-wrong returns null WITH an issue - that is
 * INVALID. The distinction is the whole point of this module.
 */
export function validNumber(
  report: ValidationReport,
  field: string,
  raw: unknown,
  rule: NumberRule = {},
): number | null {
  if (raw === null || raw === undefined || raw === '') return null;

  let value: number;
  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string' && rule.fromString) {
    value = Number(raw);
    if (!Number.isFinite(value)) {
      return report.reject(field, 'numeric string did not parse to a finite number', raw);
    }
  } else {
    return report.reject(field, `expected number, got ${typeof raw}`, raw);
  }

  // NaN and Infinity survive arithmetic silently and poison every downstream
  // comparison, so they are rejected before anything can branch on them.
  if (Number.isNaN(value)) return report.reject(field, 'NaN', raw);
  if (!Number.isFinite(value)) return report.reject(field, 'Infinity', raw);

  if (rule.integer && !Number.isInteger(value)) {
    return report.reject(field, 'expected an integer', raw);
  }
  if (rule.min !== undefined && value < rule.min) {
    return report.reject(field, `below minimum ${rule.min}`, raw);
  }
  if (rule.max !== undefined && value > rule.max) {
    return report.reject(field, `above maximum ${rule.max}`, raw);
  }

  return value;
}

/**
 * Strict boolean. A provider sending `"true"`, `1` or `"yes"` for an authority
 * flag is a provider we do not understand, and guessing its intent on a safety
 * field is exactly the wrong place to be accommodating.
 */
export function validBoolean(
  report: ValidationReport,
  field: string,
  raw: unknown,
): boolean | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'boolean') return raw;
  return report.reject(field, `expected boolean, got ${typeof raw}`, raw);
}

export function validString(
  report: ValidationReport,
  field: string,
  raw: unknown,
  opts: { maxLength?: number; allowEmpty?: boolean } = {},
): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return report.reject(field, `expected string, got ${typeof raw}`, raw);
  if (!opts.allowEmpty && raw.trim().length === 0) return null;
  const max = opts.maxLength ?? 200;
  return raw.length > max ? raw.slice(0, max) : raw;
}

/** Base58, 32-44 chars - the shape of every Solana address. */
export function validMint(report: ValidationReport, field: string, raw: unknown): string | null {
  const value = validString(report, field, raw, { maxLength: 64 });
  if (value === null) return null;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
    return report.reject(field, 'not a base58 Solana address', raw);
  }
  return value;
}

/**
 * Unix ms timestamp. Rejects times before Solana existed and times meaningfully
 * in the future: both make age arithmetic produce a number that looks valid and
 * is not. A negative age is impossible, so it is rejected at the boundary
 * rather than clamped downstream.
 */
export function validTimestampMs(
  report: ValidationReport,
  field: string,
  raw: unknown,
): number | null {
  if (raw === null || raw === undefined || raw === '') return null;

  let ms: number | null = null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return report.reject(field, 'non-finite timestamp', raw);
    // Providers mix seconds and milliseconds; anything below this threshold
    // cannot be a millisecond timestamp in the Solana era.
    ms = raw > 1e12 ? raw : raw * 1000;
  } else if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) return report.reject(field, 'unparseable date string', raw);
    ms = parsed;
  } else {
    return report.reject(field, `expected timestamp, got ${typeof raw}`, raw);
  }

  if (ms < SOLANA_GENESIS_MS) return report.reject(field, 'before Solana genesis', raw);
  if (ms > Date.now() + FUTURE_SKEW_MS) return report.reject(field, 'in the future', raw);
  return ms;
}

/** A percentage that must sit on 0-100. Used for holder and dev balance shares. */
export function validPercent(
  report: ValidationReport,
  field: string,
  raw: unknown,
): number | null {
  return validNumber(report, field, raw, { min: 0, max: 100 });
}

/** A non-negative USD amount. Negative money is impossible, never "zero-ish". */
export function validUsd(report: ValidationReport, field: string, raw: unknown): number | null {
  return validNumber(report, field, raw, { min: 0, fromString: true });
}

/**
 * A percentage price change. Below -100% is impossible (a token cannot lose
 * more than all of its value); the upper bound catches decimal-point errors
 * while still allowing the genuine four-figure moves new tokens produce.
 */
export function validPriceChangePct(
  report: ValidationReport,
  field: string,
  raw: unknown,
): number | null {
  return validNumber(report, field, raw, { min: -100, max: 1_000_000 });
}

/** A non-negative whole count: trades, holders, traders. */
export function validCount(report: ValidationReport, field: string, raw: unknown): number | null {
  return validNumber(report, field, raw, { min: 0, integer: true });
}

/**
 * Mint decimals.
 *
 * SPL stores this as a `u8` - `InitializeMint2 { decimals: u8 }` - so the
 * domain is 0-255. It is emphatically not the EVM 0-18 convention, and the
 * difference was not academic: bounding it at 18 rejected legal mints, after
 * which supply stayed in raw base units while holder balances were read in UI
 * units, and the resulting concentration ratio came out near zero. A mint that
 * could not be measured therefore read as maximally well distributed.
 */
export function validDecimals(
  report: ValidationReport,
  field: string,
  raw: unknown,
): number | null {
  return validNumber(report, field, raw, { min: 0, max: 255, integer: true });
}

/** The ceiling on any SPL amount: balances and supply are both `u64`. */
const U64_MAX = 18_446_744_073_709_551_615n;

/**
 * A raw token amount or supply, kept as an exact integer.
 *
 * `number` silently loses integers above 2^53, and a token with 9 decimals
 * passes that after a billion whole tokens - which is an ordinary supply for a
 * new launch. Every raw amount therefore travels as a BigInt and is only
 * converted to `number` after being reduced to a bounded ratio.
 *
 * Follows the module rule exactly: absent returns null with no issue (UNKNOWN);
 * present-but-impossible returns null WITH an issue (INVALID).
 */
export function validRawAmount(
  report: ValidationReport,
  field: string,
  raw: unknown,
): bigint | null {
  if (raw === null || raw === undefined || raw === '') return null;

  let text: string;
  if (typeof raw === 'string') {
    text = raw.trim();
  } else if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return report.reject(field, 'non-finite raw amount', raw);
    if (!Number.isInteger(raw)) return report.reject(field, 'raw amount is not an integer', raw);
    // A float this large already lost precision before we saw it, so there is
    // no honest way to recover the intended integer.
    if (!Number.isSafeInteger(raw)) {
      return report.reject(field, 'raw amount exceeds exact integer range as a number', raw);
    }
    text = String(raw);
  } else {
    return report.reject(field, `expected a raw amount, got ${typeof raw}`, raw);
  }

  if (!/^\d+$/.test(text)) {
    return report.reject(field, 'not a non-negative integer string', raw);
  }

  const value = BigInt(text);
  if (value > U64_MAX) return report.reject(field, 'exceeds u64', raw);
  return value;
}
