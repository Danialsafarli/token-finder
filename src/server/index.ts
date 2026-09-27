/**
 * The local dashboard server.
 *
 * Zero runtime dependencies: `node:http`, static files, JSON DTOs and one SSE
 * stream. Three layers, in order, for every request:
 *
 *   1. security   Host allowlist (DNS rebinding), security headers, and a
 *                 same-origin check on anything that changes state
 *   2. api        frontend-facing DTOs from ./dto.ts - never raw snapshots
 *   3. static     the buildless frontend, with an SPA fallback so a deep link
 *                 such as /t/<mint>/evidence loads the app
 *
 * The live ranking universe is decided by core/ranking.ts and nowhere else;
 * every count and list below goes through it.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzip } from 'node:zlib';
import { config, hasBirdeye, hasHelius } from '../config.ts';
import { log } from '../util/logger.ts';
import { store } from '../core/store.ts';
import { bus, isScanning, lastScanResult, runScan, startMonitor, type ScanResult } from '../core/monitor.ts';
import { capabilities, globallyUnavailableMetrics, type Capability } from '../core/capabilities.ts';
import { countUniverse, FRESH_WITHIN_MS, liveTokens } from '../core/ranking.ts';
import { vetoLabel, metricLabel } from './present.ts';
import {
  boardResponse,
  changeView,
  dossier,
  eventView,
  historyResponse,
  orbResponse,
  parseBoardQuery,
  type DtoContext,
} from './dto.ts';
import { hostAllowed, isLoopbackBind, sameOrigin, SECURITY_HEADERS } from './security.ts';
import type { MonitorEvent } from '../types.ts';

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{16,64}$/;

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: string | Buffer): void {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

/** JSON below this size is sent as is; compressing it costs more than it saves. */
const COMPRESS_MIN_BYTES = 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', vary: 'accept-encoding' };
  const accepts = String(res.req?.headers['accept-encoding'] ?? '');
  if (json.length < COMPRESS_MIN_BYTES || !/\bgzip\b/.test(accepts)) return send(res, status, headers, json);
  // Asynchronous, so the multi-megabyte compatibility endpoint does not stall
  // the event loop (and the live stream with it) while it compresses.
  gzip(json, (error, compressed) => {
    if (error) return send(res, status, headers, json);
    send(res, status, { ...headers, 'content-encoding': 'gzip' }, compressed);
  });
}

// ---------------------------------------------------------------------------
// Shared context
// ---------------------------------------------------------------------------

/** Providers seen failing in the last scan or in the last 30 minutes of history. */
function failingProviders(now: number): Set<string> {
  const failing = new Set<string>();
  for (const failure of lastScanResult()?.providerFailures ?? []) failing.add(failure.provider);
  for (const summary of store.providerFailureSummary(now - 30 * 60_000)) failing.add(summary.provider);
  return failing;
}

function currentContext(now = Date.now()): { context: DtoContext; caps: Capability[] } {
  const caps = capabilities({
    helius: hasHelius(),
    birdeye: hasBirdeye(),
    typesafeEnabled: config.typesafeEnabled,
    failingProviders: failingProviders(now),
  });
  return {
    caps,
    context: {
      now,
      windowMs: config.liveWindowMin * 60_000,
      globallyOff: globallyUnavailableMetrics(caps),
      minCoverageQualify: config.minCoverageQualify,
      minCoverageWatch: config.minCoverageWatch,
      minLiquidityUsd: config.minLiquidityUsd,
      catastrophicConcentrationPct: config.catastrophicConcentrationPct,
      helius: hasHelius(),
    },
  };
}

function statusBody(now = Date.now()): unknown {
  const { caps } = currentContext(now);
  const universe = countUniverse(store.tokens(), now, config.liveWindowMin * 60_000);
  const failure = store.persistenceFailure();
  return {
    serverTime: now,
    scanning: isScanning(),
    lastScanAt: store.lastScanAt,
    scanCount: store.scanCount,
    scanIntervalSec: config.scanIntervalSec,
    window: { liveMinutes: config.liveWindowMin, freshMinutes: Math.round(FRESH_WITHIN_MS / 60_000) },
    universe: { live: universe.live, stale: universe.stale, unevaluated: universe.unevaluated, total: universe.total },
    counts: universe.byEligibility,
    persistence: { healthy: failure === null, kind: failure?.kind ?? null },
    capabilitiesOff: caps.filter((capability) => capability.state === 'OFF' && capability.metrics.length > 0).length,
    capabilitiesDegraded: caps.filter((capability) => capability.state === 'DEGRADED').length,
  };
}

/**
 * Coverage over the LIVE universe only.
 *
 * Previously this counted "legacy" tokens by whether `score.coverage` existed
 * while the ranking filtered on `evaluation` - two predicates that disagreed by
 * 1,758 tokens. Both now come from core/ranking.ts.
 */
function coverageBody(now = Date.now()): unknown {
  const all = store.tokens();
  const windowMs = config.liveWindowMin * 60_000;
  const universe = countUniverse(all, now, windowMs);
  const live = liveTokens(all, now, windowMs);

  const buckets = [
    { label: 'Under 35%', min: 0, max: 0.35, count: 0 },
    { label: '35–60%', min: 0.35, max: 0.6, count: 0 },
    { label: '60–80%', min: 0.6, max: 0.8, count: 0 },
    { label: '80–100%', min: 0.8, max: 1.0001, count: 0 },
  ];
  const vetoes: Record<string, { label: string; count: number }> = {};
  const unknown: Record<string, { label: string; count: number }> = {};
  let coverageSum = 0;
  let confidenceSum = 0;

  for (const token of live) {
    const report = token.evaluation!.coverage;
    coverageSum += report.coverage;
    confidenceSum += report.confidence;
    const bucket = buckets.find((b) => report.coverage >= b.min && report.coverage < b.max);
    if (bucket) bucket.count++;
    for (const veto of token.evaluation!.vetoes) {
      vetoes[veto.code] ??= { label: vetoLabel(veto.code), count: 0 };
      vetoes[veto.code]!.count++;
    }
    for (const entry of token.ledger ?? []) {
      if (entry.weight > 0 && entry.state !== 'MEASURED' && entry.state !== 'CONFLICTED') {
        unknown[entry.metric] ??= { label: metricLabel(entry.metric), count: 0 };
        unknown[entry.metric]!.count++;
      }
    }
  }

  return {
    universe: { live: universe.live, stale: universe.stale, unevaluated: universe.unevaluated, total: universe.total },
    byEligibility: universe.byEligibility,
    meanCoverage: live.length ? Math.round((coverageSum / live.length) * 1000) / 1000 : null,
    meanConfidence: live.length ? Math.round((confidenceSum / live.length) * 1000) / 1000 : null,
    distribution: buckets.map(({ label, count }) => ({ label, count })),
    vetoes: Object.entries(vetoes)
      .map(([code, value]) => ({ code, ...value }))
      .sort((a, b) => b.count - a.count),
    unknownSignals: Object.entries(unknown)
      .map(([metric, value]) => ({ metric, ...value }))
      .sort((a, b) => b.count - a.count),
    ledgerTokens: live.filter((token) => token.ledger && token.ledger.length > 0).length,
  };
}

function systemBody(now = Date.now()): unknown {
  const { caps } = currentContext(now);
  const diagnostics = store.diagnostics();
  const failure = store.persistenceFailure();
  const scan = lastScanResult();
  return {
    serverTime: now,
    capabilities: caps,
    scan: {
      scanning: isScanning(),
      lastScanAt: store.lastScanAt,
      scanCount: store.scanCount,
      intervalSec: config.scanIntervalSec,
      last: scan
        ? {
            at: scan.at,
            durationMs: scan.durationMs,
            candidates: scan.candidates,
            analyzed: scan.analyzed,
            fresh: scan.fresh,
            tokenFailures: scan.tokenFailures.length,
            providerFailures: scan.providerFailures.map((f) => ({ provider: f.provider, kind: f.kind, message: f.message.slice(0, 160) })),
          }
        : null,
    },
    providers: store.providerFailureSummary(now - 60 * 60_000),
    window: { liveMinutes: config.liveWindowMin, freshMinutes: Math.round(FRESH_WITHIN_MS / 60_000) },
    coverage: coverageBody(now),
    persistence: {
      healthy: failure === null,
      failure: failure ? { kind: failure.kind, operation: failure.operation, message: failure.message.slice(0, 200), at: failure.at } : null,
      database: diagnostics
        ? {
            // The filename only: the absolute path is local detail with no use in a UI.
            file: basename(diagnostics.path),
            sizeBytes: diagnostics.sizeBytes,
            schemaVersion: diagnostics.schemaVersion,
            schemaCurrent: diagnostics.schemaCurrent,
            integrity: diagnostics.integrity.ok ? 'ok' : 'failed',
            rows: diagnostics.rowCounts,
            oldestSnapshotAt: diagnostics.oldestSnapshotAt,
            newestSnapshotAt: diagnostics.newestSnapshotAt,
            transitions: diagnostics.transitionCount,
            legacyImportAt: diagnostics.legacyImport.completedAt,
          }
        : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  let requested: string;
  try {
    requested = decodeURIComponent(pathname);
  } catch {
    send(res, 400, { 'content-type': 'text/plain; charset=utf-8' }, 'Bad request');
    return;
  }

  // Deep links (/t/<mint>, /changes, /system) have no extension: they are app
  // routes, answered with the shell so the router can take over.
  const isRoute = extname(requested) === '';
  const file = isRoute ? resolve(PUBLIC_DIR, 'index.html') : resolve(PUBLIC_DIR, `.${requested}`);

  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) {
    send(res, 403, { 'content-type': 'text/plain; charset=utf-8' }, 'Forbidden');
    return;
  }
  const type = MIME[extname(file)];
  if (!type) {
    send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'Not found');
    return;
  }

  try {
    const body = await readFile(file);
    send(res, 200, { 'content-type': type, 'cache-control': 'no-cache' }, body);
  } catch {
    send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'Not found');
  }
}

// ---------------------------------------------------------------------------
// Live stream
// ---------------------------------------------------------------------------

function scanSummary(result: ScanResult): unknown {
  return {
    at: result.at,
    durationMs: result.durationMs,
    analyzed: result.analyzed,
    fresh: result.fresh,
    providerFailures: result.providerFailures.map((failure) => failure.provider),
  };
}

function stream(res: ServerResponse): void {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const send = (type: string, payload: unknown): void => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  // The client learns the current state on connect, so a reconnect after an
  // outage shows reality immediately rather than after the next poll.
  send('hello', statusBody());

  const onStart = (payload: unknown): void => send('scan-start', payload);
  const onScan = (result: ScanResult): void => send('scan', scanSummary(result));
  const onFailed = (payload: unknown): void => send('scan-failed', payload);
  const onEvent = (event: MonitorEvent): void => send('alert', eventView(event));

  bus.on('scan-start', onStart);
  bus.on('scan', onScan);
  bus.on('scan-failed', onFailed);
  bus.on('event', onEvent);

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000);
  res.on('close', () => {
    clearInterval(keepAlive);
    bus.off('scan-start', onStart);
    bus.off('scan', onScan);
    bus.off('scan-failed', onFailed);
    bus.off('event', onEvent);
  });
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // DNS-rebinding defence first: nothing, not even static files, is served to
  // a Host that is not this loopback origin.
  if (!hostAllowed(req.headers.host, config.port, config.host)) {
    send(res, 403, { 'content-type': 'text/plain; charset=utf-8' }, 'Forbidden host');
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path.startsWith('/api/')) {
    if (method !== 'GET' && method !== 'HEAD' && !(method === 'POST' && path === '/api/scan')) {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    if (path === '/api/status') return sendJson(res, 200, statusBody());
    if (path === '/api/system') return sendJson(res, 200, systemBody());
    if (path === '/api/coverage') return sendJson(res, 200, coverageBody());

    if (path === '/api/board') {
      const { context, caps } = currentContext();
      return sendJson(res, 200, boardResponse(store.tokens(), parseBoardQuery(url.searchParams), context, caps, FRESH_WITHIN_MS));
    }

    if (path === '/api/orb') {
      const now = Date.now();
      const { context } = currentContext(now);
      const last = lastScanResult();
      return sendJson(
        res,
        200,
        orbResponse(store.tokens(), store.verdictChanges({ limit: 600 }), context, {
          scanning: isScanning(),
          lastScanAt: store.lastScanAt,
          count: store.scanCount,
          last: last ? { at: last.at, durationMs: last.durationMs, analyzed: last.analyzed, fresh: last.fresh } : null,
        }),
      );
    }

    if (path === '/api/changes') {
      const limit = Math.max(1, Math.min(300, Number(url.searchParams.get('limit') ?? 120) || 120));
      const views = store.verdictChanges({ limit: 600 }).map(changeView);
      const changed = views.filter((view) => view.kind === 'changed').slice(0, limit);
      const first = views.filter((view) => view.kind === 'first');
      const events = store
        .events(200)
        .filter((event) => event.kind !== 'discovered')
        .slice(0, limit)
        .map(eventView);
      return sendJson(res, 200, { changed, first: { count: first.length, recent: first.slice(0, 40) }, events });
    }

    if (path === '/api/events') {
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? 100) || 100));
      return sendJson(res, 200, { events: store.events(limit).map(eventView) });
    }

    // Compatibility: full snapshots of the LIVE universe, for scripts. The
    // dashboard uses /api/board.
    if (path === '/api/tokens') {
      const now = Date.now();
      return sendJson(res, 200, { tokens: liveTokens(store.tokens(), now, config.liveWindowMin * 60_000) });
    }

    const tokenRoute = /^\/api\/tokens\/([^/]+)(\/history)?$/.exec(path);
    if (tokenRoute) {
      let mint: string;
      try {
        mint = decodeURIComponent(tokenRoute[1]!);
      } catch {
        return sendJson(res, 400, { error: 'bad mint' });
      }
      if (!MINT_PATTERN.test(mint)) return sendJson(res, 400, { error: 'bad mint' });
      const token = store.token(mint);
      if (!token) return sendJson(res, 404, { error: 'not tracked' });

      if (tokenRoute[2]) {
        return sendJson(
          res,
          200,
          historyResponse(
            mint,
            store.verdictChanges({ mint, limit: 200 }),
            store.tokenHistory(mint, { limit: 1000 }),
            store.marketHistory(mint, { limit: 1000 }),
            store.holderHistory(mint, { limit: 500 }),
          ),
        );
      }
      const { context } = currentContext();
      return sendJson(res, 200, dossier(token, token.ledger ? [] : store.latestEvidence(mint), context));
    }

    if (path === '/api/scan' && method === 'POST') {
      const origin = sameOrigin(req);
      if (!origin.ok) return sendJson(res, 403, { error: `refused: ${origin.reason}` });
      if (isScanning()) return sendJson(res, 409, { error: 'scan already running' });
      runScan().catch((error: unknown) => log.error('manual scan failed:', error instanceof Error ? error.message : error));
      return sendJson(res, 202, { started: true });
    }

    if (path === '/api/stream') {
      stream(res);
      return;
    }

    sendJson(res, 404, { error: 'unknown endpoint' });
    return;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    send(res, 405, { 'content-type': 'text/plain; charset=utf-8' }, 'Method not allowed');
    return;
  }
  await serveStatic(path, res);
}

export function serve(options: { monitor?: boolean } = {}): Server {
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    handle(req, res).catch((error: unknown) => {
      log.error('request failed:', error instanceof Error ? error.message : error);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    });
  };
  const server = createServer(handler);

  // `localhost` resolves to ::1 before 127.0.0.1 on many systems. With only the
  // IPv4 loopback bound, every request from a `http://localhost` bookmark waited
  // ~200 ms for the IPv6 attempt to fail. The default therefore binds both
  // loopback addresses - still loopback only, never the LAN.
  if (config.host === '127.0.0.1') {
    const v6 = createServer(handler);
    v6.on('error', () => {
      // No IPv6 loopback on this machine; IPv4 alone still serves everything.
    });
    v6.listen(config.port, '::1');
    server.on('close', () => v6.close());
  }

  server.listen(config.port, config.host, () => {
    const shown = isLoopbackBind(config.host) ? 'localhost' : config.host;
    log.ok(`dashboard on ${log.paint('cyan', `http://${shown}:${config.port}`)}`);
    if (!isLoopbackBind(config.host)) {
      log.warn(`listening on ${config.host} - the dashboard is reachable from other machines`);
    }
    if (!hasHelius() && !hasBirdeye()) {
      log.info('no Helius key: on-chain checks (Token-2022 extensions, authority reads, exact holder math) are off');
    }
  });

  if (options.monitor !== false) {
    log.step(`monitor every ${config.scanIntervalSec}s`);
    startMonitor();
  }

  // Returned so a caller that started the server can stop it. Tests need this:
  // exiting the process with the listener still open trips a libuv teardown
  // assertion on Windows.
  return server;
}
