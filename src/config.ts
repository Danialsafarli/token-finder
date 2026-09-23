import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where runtime state lives. Overridable so a smoke run, an experiment or a
 * test can point at a scratch directory instead of writing into the working
 * copy's `data/`. Nothing in `data/` is tracked by git except `.gitkeep`.
 */
export const DATA_DIR = resolve(
  ROOT,
  process.env.TOKEN_FINDER_DATA_DIR?.trim() || 'data',
);

/**
 * Minimal .env reader so `node src/cli.ts` works without --env-file or a
 * dotenv dependency. Real environment variables always win.
 */
function loadDotEnv(): void {
  const file = resolve(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined && value !== '') process.env[key] = value;
  }
}

loadDotEnv();

function num(key: string, fallback: number): number {
  const parsed = Number(process.env[key]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(key: string): string | null {
  const value = process.env[key]?.trim();
  return value ? value : null;
}

function bool(key: string, fallback: boolean): boolean {
  const value = process.env[key]?.trim().toLowerCase();
  if (value === undefined || value === '') return fallback;
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

/**
 * Secrets live here and only here. This module is imported by server-side code
 * only - nothing under `src/server/public` may read it, and no API response
 * echoes a key back. `/api/status` reports booleans, never values.
 */
export const config = {
  heliusApiKey: str('HELIUS_API_KEY'),
  birdeyeApiKey: str('BIRDEYE_API_KEY'),
  port: num('PORT', 5173),

  /** TypeSafe (Jev) impersonation screening - optional, off unless switched on. */
  typesafeApiKey: str('TYPESAFE_API_KEY'),
  /** Feature flag. Screening also needs a key; either one missing disables it. */
  typesafeEnabled: bool('TYPESAFE_ENABLED', false) && str('TYPESAFE_API_KEY') !== null,
  typesafeModel: str('TYPESAFE_MODEL') ?? 'jev-latest',
  /** Hard cap on model requests per scan, so screening cost stays bounded. */
  typesafeMaxPerScan: Math.max(0, num('TYPESAFE_MAX_PER_SCAN', 10)),
  typesafeTimeoutMs: Math.max(1000, num('TYPESAFE_TIMEOUT_MS', 8000)),

  /** How often the monitor re-scans, in seconds. */
  scanIntervalSec: Math.max(30, num('SCAN_INTERVAL_SEC', 120)),
  /** Tokens below this much pooled liquidity are dropped during discovery. */
  minLiquidityUsd: num('MIN_LIQUIDITY_USD', 3000),
  /** Anything older than this is no longer a "new" launch. */
  maxAgeHours: num('MAX_AGE_HOURS', 168),
  /** Monitor raises an alert when a token first crosses this score. */
  minScoreAlert: num('MIN_SCORE_ALERT', 70),
  /**
   * Evidence coverage a token must also reach before it can raise an alert.
   * A high score built on a third of the inputs is not a finding.
   */
  minCoverageAlert: num('MIN_COVERAGE_ALERT', 0.6),

  /** Coverage at or above which a veto-free token can enter the main ranking. */
  minCoverageQualify: num('MIN_COVERAGE_QUALIFY', 0.6),
  /**
   * Coverage below which the score says more about what we failed to observe
   * than about the token, so it is held out of the ranking entirely.
   */
  minCoverageWatch: num('MIN_COVERAGE_WATCH', 0.35),
  /**
   * Top-holder share that triggers a hard veto rather than a penalty. Sits well
   * above the 60% `concentration` flag because a veto must mean something
   * strictly worse than "heavily concentrated". Not calibrated against outcomes.
   */
  catastrophicConcentrationPct: num('CATASTROPHIC_CONCENTRATION_PCT', 90),

  /** Upper bound on mints fully analyzed per scan; keeps us inside rate limits. */
  maxAnalyzePerScan: num('MAX_ANALYZE_PER_SCAN', 60),
  /** Snapshots retained per token for the sparkline/history view. */
  historyPoints: num('HISTORY_POINTS', 240),
  /** Monitor events retained. */
  maxEvents: num('MAX_EVENTS', 500),
} as const;

export const hasHelius = (): boolean => config.heliusApiKey !== null;
export const hasBirdeye = (): boolean => config.birdeyeApiKey !== null;
export const hasTypesafe = (): boolean => config.typesafeApiKey !== null;
