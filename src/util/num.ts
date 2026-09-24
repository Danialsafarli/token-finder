export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * Fixed-point scale for converting an exact integer ratio to a `number`.
 *
 * 1e9 keeps nine decimal places of the share - far finer than any threshold
 * this project compares against (60%, 90%) - while the intermediate
 * `numerator * RATIO_SCALE` stays well inside BigInt's exact range for u64
 * inputs. The conversion to `number` happens exactly once, at the end, on a
 * value already known to be small.
 */
const RATIO_SCALE = 1_000_000_000n;

/**
 * Exact ratio of two raw token amounts, as a `number` in 0-1 (or above 1 when
 * the inputs genuinely disagree - the caller decides what that means).
 *
 * Both sides must be raw base units. Passing a raw numerator and a UI
 * denominator is the unit-mixing bug this signature exists to make awkward:
 * there is no overload that takes a `number`.
 *
 * Returns null for a non-positive denominator rather than Infinity or NaN,
 * neither of which survives a comparison meaningfully.
 */
export function exactRatio(numerator: bigint, denominator: bigint): number | null {
  if (denominator <= 0n) return null;
  if (numerator < 0n) return null;
  return Number((numerator * RATIO_SCALE) / denominator) / Number(RATIO_SCALE);
}

export const clamp01 = (value: number): number => clamp(value, 0, 1);

export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export const numberOr = (value: unknown, fallback: number): number => toNumber(value) ?? fallback;

/**
 * Maps a value onto 0-1 across a logarithmic range. Liquidity and holder
 * counts differ in orders of magnitude, not absolute deltas, so a linear
 * scale would compress everything interesting into the bottom percent.
 */
export function logScore(value: number, low: number, high: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const lo = Math.log10(Math.max(low, 1e-9));
  const hi = Math.log10(Math.max(high, low * 10));
  return clamp01((Math.log10(value) - lo) / (hi - lo));
}

/** Bell curve peaking at ideal; spread controls how fast it falls off. */
export function bandScore(value: number, ideal: number, spread: number): number {
  if (!Number.isFinite(value)) return 0;
  const z = (value - ideal) / spread;
  return clamp01(Math.exp(-0.5 * z * z));
}

export function fmtUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  if (abs >= 1) return `$${value.toFixed(2)}`;
  if (abs === 0) return '$0';
  return `$${value.toPrecision(3)}`;
}

export function fmtAge(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return '-';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export function fmtPct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}
