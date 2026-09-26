// @ts-check
/**
 * Number and time formatting.
 *
 * Every formatter returns an em dash for an unknown value. A missing number is
 * never rendered as 0, $0 or 0% - that is exactly the confusion the engine's
 * evidence model exists to prevent, and the UI must not reintroduce it.
 */

export const DASH = '—';

/** @param {unknown} value @returns {value is number} */
const known = (value) => typeof value === 'number' && Number.isFinite(value);

/** Compact dollars: $1.2K, $3.45M. @param {number | null | undefined} value */
export function usd(value) {
  if (!known(value)) return DASH;
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  if (abs === 0) return '$0';
  return `$${value.toFixed(abs >= 1 ? 2 : 4)}`;
}

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';
/** @param {number} n */
const subscript = (n) => String(n).split('').map((d) => SUBSCRIPT[Number(d)] ?? d).join('');

/**
 * Prices, with subscript-zero notation for micro-prices so they can be compared
 * at a glance: 0.0000915 → $0.0₄915.
 *
 * @param {number | null | undefined} value
 */
export function price(value) {
  if (!known(value)) return DASH;
  if (value === 0) return '$0';
  if (value >= 1) return `$${value.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
  const zeros = -Math.floor(Math.log10(value)) - 1;
  if (zeros < 4) return `$${value.toPrecision(3)}`;
  const digits = String(Math.round(value * 10 ** (zeros + 4))).replace(/0+$/, '') || '0';
  return `$0.0${subscript(zeros)}${digits}`;
}

/** Signed percentage, compact above 1,000%. @param {number | null | undefined} value */
export function pct(value, digits = 1) {
  if (!known(value)) return DASH;
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  const abs = Math.abs(value);
  if (abs >= 10_000) return `${sign}${(abs / 1000).toFixed(0)}k%`;
  if (abs >= 1_000) return `${sign}${(abs / 1000).toFixed(1)}k%`;
  return `${sign}${abs.toFixed(abs >= 100 ? 0 : digits)}%`;
}

/** 0-1 share as a whole percentage. @param {number | null | undefined} value */
export function share(value) {
  return known(value) ? `${Math.round(value * 100)}%` : DASH;
}

/** @param {number | null | undefined} value */
export function count(value) {
  return known(value) ? value.toLocaleString('en-US') : DASH;
}

/** Token age from hours. @param {number | null | undefined} hours */
export function age(hours) {
  if (!known(hours)) return DASH;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  return `${(hours / 24).toFixed(hours < 240 ? 1 : 0)}d`;
}

/**
 * A configured span in words: "90 minutes", "6 hours", "3 days".
 * @param {number} minutes
 */
export function span(minutes) {
  if (minutes < 120) return `${minutes} minutes`;
  const hours = minutes / 60;
  if (hours < 48) return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hours`;
  return `${Math.round(hours / 24)} days`;
}

/** Relative time: "just now", "4m ago", "3h ago". @param {number | null | undefined} at */
export function ago(at, now = Date.now()) {
  if (!known(at)) return DASH;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Absolute local time for tooltips and timelines. @param {number | null | undefined} at */
export function when(at) {
  if (!known(at)) return DASH;
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** @param {number | null | undefined} at */
export function clock(at) {
  if (!known(at)) return DASH;
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** @param {number | null | undefined} ms */
export function duration(ms) {
  if (!known(ms)) return DASH;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 90) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds / 60)}m`;
}

/** @param {number | null | undefined} value */
export function bytes(value) {
  if (!known(value)) return DASH;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

/** First and last four characters of an address. @param {string} address */
export function shortAddress(address) {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}
