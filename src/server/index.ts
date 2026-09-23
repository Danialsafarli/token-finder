import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, hasBirdeye, hasHelius } from '../config.ts';
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

const SORTERS: Record<SortKey, (a: TokenSnapshot, b: TokenSnapshot) => number> = {
  score: (a, b) => b.score.total - a.score.total,
  liquidity: (a, b) => b.liquidityUsd - a.liquidityUsd,
  volume: (a, b) => b.volume24h - a.volume24h,
  age: (a, b) => (a.ageHours ?? Infinity) - (b.ageHours ?? Infinity),
  momentum: (a, b) => b.priceChange.h1 - a.priceChange.h1,
  holders: (a, b) => (b.holders ?? 0) - (a.holders ?? 0),
};

function listTokens(url: URL): TokenSnapshot[] {
  const sort = (url.searchParams.get('sort') ?? 'score') as SortKey;
  const minScore = Number(url.searchParams.get('minScore') ?? 0);
  const maxAge = Number(url.searchParams.get('maxAgeH') ?? config.maxAgeHours);
  const minLiquidity = Number(url.searchParams.get('minLiquidity') ?? 0);
  const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const hideRisky = url.searchParams.get('hideRisky') === '1';
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 500);

  let tokens = store.tokens();

  tokens = tokens.filter((token) => {
    if (Number.isFinite(minScore) && token.score.total < minScore) return false;
    if (Number.isFinite(maxAge) && token.ageHours !== null && token.ageHours > maxAge) return false;
    if (Number.isFinite(minLiquidity) && token.liquidityUsd < minLiquidity) return false;
    if (hideRisky && token.score.flags.some((flag) => flag.level === 'critical')) return false;
    if (query) {
      const haystack = `${token.symbol} ${token.name} ${token.mint}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  return tokens.sort(SORTERS[sort] ?? SORTERS.score).slice(0, limit);
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
      sources: { helius: hasHelius(), birdeye: hasBirdeye() },
      config: {
        scanIntervalSec: config.scanIntervalSec,
        minLiquidityUsd: config.minLiquidityUsd,
        maxAgeHours: config.maxAgeHours,
        minScoreAlert: config.minScoreAlert,
      },
    });
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
