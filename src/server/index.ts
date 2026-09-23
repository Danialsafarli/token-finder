import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, hasBirdeye, hasHelius, hasTypesafe } from '../config.ts';
import { log } from '../util/logger.ts';
import { store } from '../core/store.ts';
import { bus, isScanning, runScan, startMonitor } from '../core/monitor.ts';
import type { TokenSnapshot } from '../types.ts';

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

type SortKey = 'score' | 'liquidity' | 'volume' | 'age' | 'momentum' | 'holders';

/** Unknown sorts last in every direction rather than masquerading as zero. */
const SORTERS: Record<SortKey, (a: TokenSnapshot, b: TokenSnapshot) => number> = {
  score: (a, b) => b.score.total - a.score.total,
  liquidity: (a, b) => (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1),
  volume: (a, b) => (b.volume24h ?? -1) - (a.volume24h ?? -1),
  age: (a, b) => (a.ageHours ?? Infinity) - (b.ageHours ?? Infinity),
  momentum: (a, b) => (b.priceChange?.h1 ?? -Infinity) - (a.priceChange?.h1 ?? -Infinity),
  holders: (a, b) => (b.holders ?? -1) - (a.holders ?? -1),
};

/**
 * Ranking eligibility filter.
 *
 * A numeric score is not a licence to appear in the ranking. REJECTED and
 * INSUFFICIENT_DATA tokens are held out by default so a vetoed token cannot
 * sit near the top on the strength of whatever the gate did not veto. They
 * remain reachable with `?eligibility=all` for inspection.
 *
 * Legacy snapshots carry no evaluation; they are shown, because hiding data
 * from before the gate existed would silently shrink the board.
 */
const DEFAULT_VISIBLE: readonly string[] = ['QUALIFIED', 'WATCH'];

function listTokens(url: URL): TokenSnapshot[] {
  const sort = (url.searchParams.get('sort') ?? 'score') as SortKey;
  const minScore = Number(url.searchParams.get('minScore') ?? 0);
  const maxAge = Number(url.searchParams.get('maxAgeH') ?? config.maxAgeHours);
  const minLiquidity = Number(url.searchParams.get('minLiquidity') ?? 0);
  const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const hideRisky = url.searchParams.get('hideRisky') === '1';
  const minCoverage = Number(url.searchParams.get('minCoverage') ?? 0);
  const eligibilityParam = (url.searchParams.get('eligibility') ?? '').trim().toUpperCase();
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 500);

  let tokens = store.tokens();

  tokens = tokens.filter((token) => {
    const eligibility = token.evaluation?.eligibility;
    if (eligibility !== undefined) {
      if (eligibilityParam === 'ALL') {
        // no eligibility filtering
      } else if (eligibilityParam.length > 0) {
        if (eligibility !== eligibilityParam) return false;
      } else if (!DEFAULT_VISIBLE.includes(eligibility)) {
        return false;
      }
    }
    if (Number.isFinite(minScore) && token.score.total < minScore) return false;
    if (Number.isFinite(maxAge) && token.ageHours !== null && token.ageHours > maxAge) return false;
    if (Number.isFinite(minCoverage) && token.score.coverage < minCoverage) return false;
    // A liquidity floor cannot be met by a token whose liquidity is unmeasured.
    if (Number.isFinite(minLiquidity) && minLiquidity > 0 && (token.liquidityUsd ?? -1) < minLiquidity)
      return false;
    if (hideRisky && token.score.flags.some((flag) => flag.level === 'critical')) return false;
    if (query) {
      const haystack = `${token.symbol} ${token.name} ${token.mint}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  // Eligibility outranks every sort key, so even with ?eligibility=all a
  // rejected token cannot appear above a qualified one.
  const rank: Record<string, number> = { QUALIFIED: 0, WATCH: 1, INSUFFICIENT_DATA: 2, REJECTED: 3 };
  const tier = (token: TokenSnapshot): number =>
    token.evaluation === null ? 1 : (rank[token.evaluation.eligibility] ?? 1);

  const sorter = SORTERS[sort] ?? SORTERS.score;
  return tokens
    .sort((a, b) => tier(a) - tier(b) || sorter(a, b))
    .slice(0, limit);
}

/**
 * Corpus-wide evidence coverage: how much of the ranking rests on real data,
 * and which components are most often missing. This is the number that tells
 * an operator whether the board is trustworthy today.
 */
function coverageSummary(): {
  tokens: number;
  scored: number;
  legacySnapshots: number;
  meanCoverage: number;
  meanConfidence: number;
  fullyCovered: number;
  belowAlertThreshold: number;
  byState: Record<string, number>;
  byEligibility: Record<string, number>;
  vetoes: Record<string, number>;
  tokensWithConflicts: number;
  unknownByComponent: Record<string, number>;
  explanation: string;
} {
  const tokens = store.tokens();
  const unknownByComponent: Record<string, number> = {};
  let sum = 0;
  let scored = 0;
  let legacy = 0;
  let fullyCovered = 0;
  let belowAlertThreshold = 0;

  for (const token of tokens) {
    // Snapshots written before evidence tracking carry no coverage. They are
    // counted separately rather than folded in as 0, which would understate
    // the corpus until the next scan replaces them.
    if (typeof token.score.coverage !== 'number') {
      legacy++;
      continue;
    }
    scored++;
    sum += token.score.coverage;
    const unknown = token.score.unknown ?? [];
    if (unknown.length === 0) fullyCovered++;
    if (token.score.coverage < config.minCoverageAlert) belowAlertThreshold++;
    for (const key of unknown) {
      unknownByComponent[key] = (unknownByComponent[key] ?? 0) + 1;
    }
  }

  const byState: Record<string, number> = {};
  const byEligibility: Record<string, number> = {};
  const vetoCounts: Record<string, number> = {};
  let conflicted = 0;
  let meanConfidence = 0;
  let confidenceCount = 0;

  for (const token of tokens) {
    const evaluation = token.evaluation;
    if (evaluation === null) continue;
    byState[evaluation.state] = (byState[evaluation.state] ?? 0) + 1;
    byEligibility[evaluation.eligibility] = (byEligibility[evaluation.eligibility] ?? 0) + 1;
    if (evaluation.conflicts.length > 0) conflicted++;
    for (const veto of evaluation.vetoes) {
      vetoCounts[veto.code] = (vetoCounts[veto.code] ?? 0) + 1;
    }
    meanConfidence += evaluation.coverage.confidence;
    confidenceCount++;
  }

  return {
    tokens: tokens.length,
    scored,
    legacySnapshots: legacy,
    meanCoverage: scored > 0 ? Math.round((sum / scored) * 1000) / 1000 : 0,
    meanConfidence: confidenceCount > 0 ? Math.round((meanConfidence / confidenceCount) * 1000) / 1000 : 0,
    fullyCovered,
    belowAlertThreshold,
    byState,
    byEligibility,
    vetoes: vetoCounts,
    tokensWithConflicts: conflicted,
    unknownByComponent,
    explanation:
      'Score, coverage and confidence are three different things and are never multiplied together. Score is how good the token looks; coverage is how much of that rests on real observation (missing evidence scores zero, so 70% coverage caps the score at 70 before penalties); confidence is how much the observations are worth once provider disagreement, staleness and single-provider dependence are accounted for. Unknown is never treated as zero, and never as safe.',
  };
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  // Resolving './<path>' against the public dir keeps traversal attempts
  // inside a path the startsWith check below can reject.
  const requested = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const file = resolve(PUBLIC_DIR, `.${requested}`);

  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}

/** Server-sent events: one connection per open dashboard tab. */
function stream(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(': connected\n\n');

  const send = (type: string, payload: unknown): void => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const onEvent = (payload: unknown): void => send('alert', payload);
  const onScan = (payload: unknown): void => send('scan', payload);

  bus.on('event', onEvent);
  bus.on('scan', onScan);

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);

  res.on('close', () => {
    clearInterval(keepAlive);
    bus.off('event', onEvent);
    bus.off('scan', onScan);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  if (path === '/api/status') {
    sendJson(res, 200, {
      lastScanAt: store.lastScanAt,
      scanCount: store.scanCount,
      scanning: isScanning(),
      tracked: store.tokens().length,
      // Booleans only. No key, or any prefix of one, is ever serialised here.
      sources: {
        helius: hasHelius(),
        birdeye: hasBirdeye(),
        typesafe: { configured: hasTypesafe(), enabled: config.typesafeEnabled },
      },
      coverage: coverageSummary(),
      config: {
        scanIntervalSec: config.scanIntervalSec,
        minLiquidityUsd: config.minLiquidityUsd,
        maxAgeHours: config.maxAgeHours,
        minScoreAlert: config.minScoreAlert,
        minCoverageAlert: config.minCoverageAlert,
      },
    });
    return;
  }

  if (path === '/api/coverage') {
    sendJson(res, 200, coverageSummary());
    return;
  }

  if (path === '/api/tokens') {
    sendJson(res, 200, { tokens: listTokens(url) });
    return;
  }

  if (path.startsWith('/api/tokens/')) {
    const mint = decodeURIComponent(path.slice('/api/tokens/'.length));
    const token = store.token(mint);
    if (!token) {
      sendJson(res, 404, { error: 'not tracked' });
      return;
    }
    sendJson(res, 200, { token, history: store.history(mint) });
    return;
  }

  if (path === '/api/events') {
    sendJson(res, 200, { events: store.events(Number(url.searchParams.get('limit') ?? 100)) });
    return;
  }

  if (path === '/api/scan' && req.method === 'POST') {
    if (isScanning()) {
      sendJson(res, 409, { error: 'scan already running' });
      return;
    }
    runScan().catch((error: unknown) => log.error('manual scan failed:', error));
    sendJson(res, 202, { started: true });
    return;
  }

  if (path === '/api/stream') {
    stream(res);
    return;
  }

  if (path.startsWith('/api/')) {
    sendJson(res, 404, { error: 'unknown endpoint' });
    return;
  }

  await serveStatic(path, res);
}

export function serve(options: { monitor?: boolean } = {}): void {
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      log.error('request failed:', error instanceof Error ? error.message : error);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    });
  });

  server.listen(config.port, () => {
    log.ok(`dashboard on ${log.paint('cyan', `http://localhost:${config.port}`)}`);
    if (!hasHelius() && !hasBirdeye()) {
      log.info('running on keyless sources only - add HELIUS_API_KEY or BIRDEYE_API_KEY for holder and on-chain depth');
    }
  });

  if (options.monitor !== false) {
    log.step(`monitor every ${config.scanIntervalSec}s`);
    startMonitor();
  }
}
