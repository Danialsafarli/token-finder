import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = resolve(ROOT, 'data');

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

export const config = {
  heliusApiKey: str('HELIUS_API_KEY'),
  birdeyeApiKey: str('BIRDEYE_API_KEY'),
  port: num('PORT', 5173),

  /** How often the monitor re-scans, in seconds. */
  scanIntervalSec: Math.max(30, num('SCAN_INTERVAL_SEC', 120)),
  /** Tokens below this much pooled liquidity are dropped during discovery. */
  minLiquidityUsd: num('MIN_LIQUIDITY_USD', 3000),
  /** Anything older than this is no longer a "new" launch. */
  maxAgeHours: num('MAX_AGE_HOURS', 168),
  /** Monitor raises an alert when a token first crosses this score. */
  minScoreAlert: num('MIN_SCORE_ALERT', 70),

  /** Upper bound on mints fully analyzed per scan; keeps us inside rate limits. */
  maxAnalyzePerScan: num('MAX_ANALYZE_PER_SCAN', 60),
  /** Snapshots retained per token for the sparkline/history view. */
  historyPoints: num('HISTORY_POINTS', 240),
  /** Monitor events retained. */
  maxEvents: num('MAX_EVENTS', 500),
} as const;

export const hasHelius = (): boolean => config.heliusApiKey !== null;
export const hasBirdeye = (): boolean => config.birdeyeApiKey !== null;
