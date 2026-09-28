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
  // Never under the test runner (node --test marks its processes with
  // NODE_TEST_CONTEXT): the suite must be hermetic, and must not be able to
  // read - or behave differently because of - a developer's local secrets.
  // A test that needs a key sets it explicitly in its own environment.
  if (process.env.NODE_TEST_CONTEXT !== undefined) return;
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

/**
 * Reduces a configured value to a bare filename.
 *
 * Anything containing a path separator, a drive letter or a parent reference
 * is rejected in favour of the default: silently rewriting it to its basename
 * would honour half of what was asked for, which is worse than ignoring it.
 */
function safeFileName(value: string | null, fallback: string): string {
  if (value === null) return fallback;
  // Separators of either flavour, any parent reference, a Windows drive prefix,
  // an embedded NUL, or a bare `.` - none of which is a filename.
  const unsafe = /[\\/]|\.\.|^[A-Za-z]:|\x00|^\.$/;
  return unsafe.test(value) ? fallback : value;
}

/** Exported for the security test; not part of the runtime surface. */
export const safeFileNameForTest = safeFileName;

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
  /**
   * Interface the dashboard listens on. Loopback by default: this is a local
   * tool, and binding every interface put it on the LAN with an
   * unauthenticated scan endpoint. Set HOST=0.0.0.0 to expose it deliberately.
   */
  host: str('HOST') ?? '127.0.0.1',

  // --- public hosting (DEPLOYMENT.md). None of it applies on a loopback bind. ---
  /**
   * The exact origin visitors use, e.g. https://token-finder.fly.dev. When set,
   * the Host header must name it and state-changing requests must come from
   * it. Required when HOST is not loopback behind HTTPS.
   */
  publicOrigin: str('PUBLIC_ORIGIN'),
  /** Behind a reverse proxy: the client is the first X-Forwarded-For address. */
  trustProxy: bool('TRUST_PROXY', false),
  /** Operator bypass for the limits below, sent as a Bearer token. Secret. */
  adminToken: str('ADMIN_TOKEN'),
  analyzePerClientPerHour: Math.max(0, num('ANALYZE_PER_CLIENT_PER_HOUR', 12)),
  analyzePerHour: Math.max(0, num('ANALYZE_PER_HOUR', 120)),
  scanPerClientPerHour: Math.max(0, num('SCAN_PER_CLIENT_PER_HOUR', 3)),
  /** Minimum seconds between two manual scans, from anyone. */
  scanMinIntervalSec: Math.max(0, num('SCAN_MIN_INTERVAL_SEC', 300)),
  apiReadsPerClientPerMinute: Math.max(1, num('API_READS_PER_MINUTE', 300)),
  maxStreams: Math.max(1, num('MAX_STREAMS', 200)),

  /**
   * Solana Risk Radar, the separate deep risk analyser a Dossier hands a mint
   * to. Token Finder links to it; it never embeds or re-scores it.
   */
  riskRadarUrl: str('RISK_RADAR_URL') ?? 'https://solana-risk-radar.vercel.app',
  /**
   * How long after its last evaluation a token stays on the live Board, in
   * minutes. The default is the engine's own market-evidence aging window
   * (FRESHNESS.liquidityUsd.agingMs); a test keeps the two equal. Past it the
   * engine would treat the token's liquidity as stale, so its verdict is
   * history, not a current assessment.
   */
  liveWindowMin: Math.max(5, num('LIVE_WINDOW_MIN', 90)),

  /** TypeSafe (Jev) impersonation screening - optional, off unless switched on. */
  typesafeApiKey: str('TYPESAFE_API_KEY'),
  /** Feature flag. Screening also needs a key; either one missing disables it. */
  typesafeEnabled: bool('TYPESAFE_ENABLED', false) && str('TYPESAFE_API_KEY') !== null,
  typesafeModel: str('TYPESAFE_MODEL') ?? 'jev-latest',
  /** Hard cap on model requests per scan, so screening cost stays bounded. */
  typesafeMaxPerScan: Math.max(0, num('TYPESAFE_MAX_PER_SCAN', 10)),
  typesafeTimeoutMs: Math.max(1000, num('TYPESAFE_TIMEOUT_MS', 8000)),

  // --- persistence -------------------------------------------------------
  // The database lives inside DATA_DIR, which TOKEN_FINDER_DATA_DIR already
  // controls, so tests and smoke runs get an isolated file for free. Only the
  // filename is configurable: allowing an absolute path here would let the
  // database be pointed at a tracked source directory.
  /**
   * Database filename inside DATA_DIR.
   *
   * A path here is rejected in favour of the default, not rewritten to its
   * basename: this is a filename, not a path. Honouring a path would let an
   * environment variable point the database at a tracked source file and have
   * the app overwrite it on first run.
   */
  dbFile: safeFileName(str('TOKEN_FINDER_DB_FILE'), 'token-finder.sqlite'),

  /** Score movement, in points, that makes a new snapshot worth storing. */
  snapshotScoreDelta: Math.max(0, num('SNAPSHOT_SCORE_DELTA', 1)),
  /** Relative move in price, liquidity or volume that is material, 0-1. */
  snapshotRelativeDelta: Math.max(0, num('SNAPSHOT_RELATIVE_DELTA', 0.02)),
  /** Coverage movement that is material, 0-1. */
  snapshotCoverageDelta: Math.max(0, num('SNAPSHOT_COVERAGE_DELTA', 0.05)),
  /** Store an otherwise unchanged token anyway after this many minutes. */
  snapshotHeartbeatMin: Math.max(1, num('SNAPSHOT_HEARTBEAT_MIN', 30)),

  /** Days of non-transition history kept. Transitions are never deleted. */
  retentionHistoryDays: Math.max(1, num('RETENTION_HISTORY_DAYS', 90)),
  /** Days a token may go unseen before it and its history are dropped. */
  retentionTokenDays: Math.max(1, num('RETENTION_TOKEN_DAYS', 180)),
  /** Days of provider-failure diagnostics kept. */
  retentionDiagnosticsDays: Math.max(1, num('RETENTION_DIAGNOSTICS_DAYS', 14)),

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
  // --- data backbone: on-chain ingestion ---------------------------------
  /**
   * A Solana JSON-RPC endpoint to read the chain through, when not Helius.
   * Treated as a secret: a provider URL can carry a key in its query string.
   * Unset, the backbone uses Helius when HELIUS_API_KEY is set and the public
   * mainnet endpoint otherwise.
   */
  solanaRpcUrl: str('SOLANA_RPC_URL'),
  /** Master switch for chain ingestion (launch discovery and swap collection). */
  ingestEnabled: bool('INGEST_ENABLED', true),
  /** Seconds between ingestion cycles. */
  ingestIntervalSec: Math.max(20, num('INGEST_INTERVAL_SEC', 60)),
  /** Surviving tokens whose pool history is collected per cycle. */
  ingestTokensPerCycle: Math.max(0, num('INGEST_TOKENS_PER_CYCLE', 6)),
  /** Transactions fetched per token per cycle. */
  ingestTxPerToken: Math.max(1, num('INGEST_TX_PER_TOKEN', 10)),
  /**
   * Pools collected per survivor token: the display pair, then other pools
   * carrying at least INGEST_MIN_POOL_VOLUME_SHARE of 24 h volume. Each pool
   * gets its own INGEST_TX_PER_TOKEN, so this multiplies collection cost.
   */
  ingestPoolsPerToken: Math.min(4, Math.max(1, num('INGEST_POOLS_PER_TOKEN', 2))),
  ingestMinPoolVolumeShare: Math.min(1, Math.max(0, num('INGEST_MIN_POOL_VOLUME_SHARE', 0.2))),
  /** Whether pump.fun launches are read from the chain. */
  launchDiscoveryEnabled: bool('LAUNCH_DISCOVERY_ENABLED', true),
  /** Launch transactions fetched per cycle; launches beyond it are counted as a gap. */
  launchTxPerCycle: Math.max(0, num('LAUNCH_TX_PER_CYCLE', 60)),
  /** Chain-discovered launches younger than this join discovery's candidates. */
  chainCandidateWindowMin: Math.max(1, num('CHAIN_CANDIDATE_WINDOW_MIN', 30)),
  /** Upper bound on chain-discovered candidates per scan. */
  chainCandidateMax: Math.max(0, num('CHAIN_CANDIDATE_MAX', 150)),
  /** Days a launch that never became a tracked token is kept. */
  retentionLaunchDays: Math.max(1, num('RETENTION_LAUNCH_DAYS', 30)),
  /**
   * Days of chain history kept: pool activity, the fetch ledger, transfer
   * edges, wallets and gaps. Separate from verdict history because it is far
   * larger - measured ~1.1 KB per collected transaction, ~60k transactions a
   * day at the public endpoint's rate, so ~65 MB a day.
   */
  retentionChainDays: Math.max(1, num('RETENTION_CHAIN_DAYS', 30)),

  // --- deep intelligence: bounded actor analysis (DEEP_INTELLIGENCE.md) ---
  /** Master switch for the actor-analysis cycle. */
  intelEnabled: bool('INTEL_ENABLED', true),
  /** Seconds between intelligence cycles. */
  intelIntervalSec: Math.max(60, num('INTEL_INTERVAL_SEC', 300)),
  /** Surviving tokens analysed per cycle. */
  intelTokensPerCycle: Math.max(0, num('INTEL_TOKENS_PER_CYCLE', 2)),
  /** At most this many when measured cost shows the request and time budgets fit more. */
  intelMaxTokensPerCycle: Math.max(0, num('INTEL_MAX_TOKENS_PER_CYCLE', 4)),
  /** Wallets analysed per token: earliest buyers, largest buyers and the creator. */
  intelWalletsPerToken: Math.max(1, num('INTEL_WALLETS_PER_TOKEN', 12)),
  /** Newest transactions read per wallet (one request; at most 100). */
  intelTxPerWallet: Math.min(100, Math.max(10, num('INTEL_TX_PER_WALLET', 100))),
  /** Oldest transactions read per wallet, for its first funding (one request). */
  intelAscLimit: Math.min(100, Math.max(1, num('INTEL_ASC_LIMIT', 10))),
  /** Funding hops followed back from an analysed wallet. */
  intelGraphDepth: Math.min(3, Math.max(1, num('INTEL_GRAPH_DEPTH', 2))),
  /** Hard cap on provider requests per cycle, shared by every stage. */
  intelRequestsPerCycle: Math.max(10, num('INTEL_REQUESTS_PER_CYCLE', 150)),
  /** Hard cap on one cycle's wall time. */
  intelCycleMaxMs: Math.max(5_000, num('INTEL_CYCLE_MAX_MS', 90_000)),
  /** A wallet profile younger than this is reused rather than re-read. */
  intelProfileTtlHours: Math.max(0, num('INTEL_PROFILE_TTL_HOURS', 6)),
  /** A token analysed more recently than this is not re-analysed. */
  intelTokenRefreshMin: Math.max(1, num('INTEL_TOKEN_REFRESH_MIN', 30)),

  /** Snapshots retained per token for the sparkline/history view. */
  historyPoints: num('HISTORY_POINTS', 240),
  /** Monitor events retained. */
  maxEvents: num('MAX_EVENTS', 500),
} as const;

export const hasHelius = (): boolean => config.heliusApiKey !== null;
export const hasBirdeye = (): boolean => config.birdeyeApiKey !== null;
export const hasTypesafe = (): boolean => config.typesafeApiKey !== null;
