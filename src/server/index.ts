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
import { bus, isScanning, lastScanResult, redecideAnalysed, runScan, startMonitor, type ScanResult } from '../core/monitor.ts';
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
import { AccessGate, type Allowance } from './access.ts';
import type { MonitorEvent } from '../types.ts';
import { analyzeRequested, MINT_ADDRESS, stageView } from '../core/request.ts';
import { ingestionStatus, startIngestion } from '../ingest/runner.ts';
import { liveIngestDeps } from '../ingest/wiring.ts';
import { intelStatus, startIntel } from '../intel/runner.ts';
import { liveIntelDeps } from '../intel/wiring.ts';
import { largestAccountsGuardState } from '../sources/helius.ts';
import { gatherIntelligence } from '../decision/inputs.ts';
import { DECISION_POLICY_VERSION, MODEL_VERSIONS, RULE_VERSIONS } from '../decision/versions.ts';
import { txCacheStats } from '../sources/solana-rpc.ts';
import { rpcEndpoint, rpcThrottleCount } from '../sources/solana-rpc.ts';

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

/**
 * Public access limits (server/access.ts). All off on a loopback bind.
 */
const gate = new AccessGate({
  public: !isLoopbackBind(config.host),
  trustProxy: config.trustProxy,
  adminToken: config.adminToken,
  analyzePerClientPerHour: config.analyzePerClientPerHour,
  analyzePerHour: config.analyzePerHour,
  scanPerClientPerHour: config.scanPerClientPerHour,
  scanMinIntervalSec: config.scanMinIntervalSec,
  apiReadsPerClientPerMinute: config.apiReadsPerClientPerMinute,
  maxStreams: config.maxStreams,
});

function tooMany(res: ServerResponse, refusal: Allowance): void {
  res.setHeader('retry-after', String(refusal.retryAfterSec ?? 60));
  sendJson(res, 429, { error: refusal.reason ?? 'too many requests', retryAfterSec: refusal.retryAfterSec ?? 60 });
}

const startedAt = Date.now();

/**
 * Readiness: the database is open and healthy, and the monitor has completed a
 * scan recently (or the process has only just started). A host routes traffic
 * and restarts on this; liveness (/healthz) only says the process answers.
 */
function readiness(now = Date.now()): { ready: boolean; reason: string; lastScanAt: number | null } {
  const lastScanAt = store.lastScanAt;
  if (!store.persistenceHealthy()) return { ready: false, reason: 'the database is not open or not writable', lastScanAt };
  const grace = 3 * config.scanIntervalSec * 1000 + 5 * 60_000;
  if (lastScanAt !== null && now - lastScanAt <= grace) return { ready: true, reason: 'scanning', lastScanAt };
  if (now - startedAt <= grace) return { ready: true, reason: 'starting: first scan pending', lastScanAt };
  return { ready: false, reason: 'no scan has completed recently', lastScanAt };
}

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

/**
 * The data backbone, concisely: is collection running and healthy, what it
 * has collected, and where it has holes. Counts and times only - no rows.
 */
function ingestionBody(now: number): unknown {
  const status = ingestionStatus(now);
  const chain = store.chain();
  let stats = null;
  let lead = null;
  try {
    stats = chain?.stats(now) ?? null;
    lead = chain?.chainLead(now - 24 * 3_600_000) ?? null;
  } catch {
    // Diagnostics must never fail the System surface.
  }
  const last = status.lastCycle;
  return {
    enabled: status.enabled,
    source: status.enabled ? status.source : rpcEndpoint().label,
    keyed: rpcEndpoint().kind !== 'public',
    /** 429s from the endpoint since start, including ones a retry recovered from. */
    throttled: rpcThrottleCount(),
    intervalSec: status.intervalSec,
    health: status.health,
    lastSuccessAt: status.lastSuccessAt,
    lastCycle: last
      ? {
          at: last.at,
          durationMs: last.durationMs,
          rpcCalls: last.rpc.calls,
          rpcFailures: last.rpc.failures,
          rateLimited: last.rpc.rateLimited,
          launches: last.launches
            ? { seen: last.launches.signaturesSeen, recorded: last.launches.recorded, skipped: last.launches.skippedOverBudget, fetchFailed: last.launches.fetchFailed }
            : null,
          pools: last.deep.pools.length,
          trades: last.deep.pools.reduce((sum, p) => sum + (p.byKind.SWAP ?? 0), 0),
          unresolved: last.deep.pools.reduce((sum, p) => sum + (p.byKind.UNRESOLVED ?? 0), 0),
          survivorsWaiting: last.deep.skipped.overBudget,
        }
      : null,
    collected: stats,
    chainLead: lead,
  };
}

/**
 * Deep intelligence, as diagnostics: is the cycle healthy, what has it
 * produced, and what did its budgets cut. Counts only - it is not the
 * Activity Integrity or Rug Intelligence surface, and feeds no score.
 */
function intelligenceBody(now: number): unknown {
  const status = intelStatus(now);
  let stats = null;
  let recent: unknown[] = [];
  try {
    const intel = store.intel();
    stats = intel?.stats() ?? null;
    recent = (intel?.recentTokenIntelligence(5) ?? []).map((t) => {
      const wash = t.wash as { risk?: string } | null;
      const activity = t.activity as { status?: string } | null;
      const attribution = t.attribution as { status?: string } | null;
      const network = t.network as { analysis?: { level?: string }; security?: unknown[] } | null;
      return {
        mint: t.mint,
        analyzedAt: t.analyzedAt,
        coverage: t.coverage,
        wash: wash?.risk ?? null,
        activity: activity?.status ?? null,
        attribution: attribution?.status ?? null,
        network: network?.analysis?.level ?? null,
        securityEvents: network?.security?.length ?? 0,
        truncated: t.truncation.length,
      };
    });
  } catch {
    // Diagnostics must never fail the System surface.
  }
  const last = status.lastCycle;
  return {
    enabled: status.enabled,
    intervalSec: status.intervalSec,
    health: status.health,
    lastSuccessAt: status.lastSuccessAt,
    lastCycle: last
      ? {
          at: last.at,
          durationMs: last.durationMs,
          tokens: last.tokens.length,
          requests: last.budget.requests,
          requestLimit: last.budget.limit,
          failures: last.failures.length,
          waiting: last.skipped.overBudget,
          truncations: last.tokens.reduce((sum, t) => sum + t.truncation.length, 0),
        }
      : null,
    produced: stats,
    recent,
    largestAccountsGuard: largestAccountsGuardState(now),
    transactionCache: txCacheStats(),
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
            timings: scan.timings ?? null,
          }
        : null,
    },
    decision: {
      policyVersion: DECISION_POLICY_VERSION,
      models: MODEL_VERSIONS,
      rules: RULE_VERSIONS,
    },
    providers: store.providerFailureSummary(now - 60 * 60_000),
    ingestion: ingestionBody(now),
    intelligence: intelligenceBody(now),
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

// ---------------------------------------------------------------------------
// On-demand analysis
// ---------------------------------------------------------------------------

/** At most this many requested analyses at once: they share rate-limited providers with the monitor. */
const MAX_REQUESTED = 2;
const requested = new Set<string>();

/** Reads a small JSON body, or null if it is too large or not JSON. */
async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * POST /api/analyze {"mint": "..."}: analyses one token on request.
 *
 * The response is a stream of newline-delimited JSON: one `stage` line as each
 * real pipeline stage begins, then one `done` line with the outcome. Stages
 * are reported only as they happen; there is no progress estimate, because the
 * pipeline does not have one.
 */
async function analyzeRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const origin = sameOrigin(req, config.publicOrigin);
  if (!origin.ok) return sendJson(res, 403, { error: `refused: ${origin.reason}` });
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    return sendJson(res, 415, { error: 'expected application/json' });
  }
  const body = await readJson(req, 1024);
  const mint = body && typeof body === 'object' && typeof (body as { mint?: unknown }).mint === 'string' ? (body as { mint: string }).mint.trim() : '';
  if (!MINT_ADDRESS.test(mint)) return sendJson(res, 400, { error: 'not a Solana mint address' });
  if (requested.has(mint)) return sendJson(res, 409, { error: 'this token is already being analysed' });
  if (requested.size >= MAX_REQUESTED) return sendJson(res, 429, { error: 'too many analyses running; try again shortly' });
  const allowed = gate.analyze(req, Date.now());
  if (!allowed.ok) return tooMany(res, allowed);

  requested.add(mint);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
  });
  const line = (payload: unknown): void => {
    if (!res.writableEnded) res.write(`${JSON.stringify(payload)}\n`);
  };
  try {
    line({ type: 'stage', ...stageView('validate'), at: Date.now() });
    const outcome = await analyzeRequested(mint, (stage) => line({ type: 'stage', ...stageView(stage), at: Date.now() }));
    const failures = outcome.providerFailures.map((failure) => ({ provider: failure.provider, kind: failure.kind }));
    if (outcome.ok) {
      line({ type: 'done', ok: true, mint, symbol: outcome.snapshot.symbol, providerFailures: failures, at: Date.now() });
    } else {
      line({ type: 'done', ok: false, mint, code: outcome.code, message: outcome.message, providerFailures: failures, at: Date.now() });
    }
  } catch (error) {
    log.error('requested analysis failed:', error instanceof Error ? error.message : error);
    line({ type: 'done', ok: false, mint, code: 'failed', message: 'The analysis failed unexpectedly. Nothing was recorded.', providerFailures: [], at: Date.now() });
  } finally {
    requested.delete(mint);
    res.end();
  }
}

function stream(res: ServerResponse, release: () => void): void {
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
  const onStage = (payload: unknown): void => send('scan-stage', payload);
  const onScan = (result: ScanResult): void => send('scan', scanSummary(result));
  const onFailed = (payload: unknown): void => send('scan-failed', payload);
  const onDecision = (payload: unknown): void => send('decision', payload);
  const onEvent = (event: MonitorEvent): void => send('alert', eventView(event));

  bus.on('scan-start', onStart);
  bus.on('scan-stage', onStage);
  bus.on('scan', onScan);
  bus.on('scan-failed', onFailed);
  bus.on('decision', onDecision);
  bus.on('event', onEvent);

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20_000);
  res.on('close', () => {
    release();
    clearInterval(keepAlive);
    bus.off('scan-start', onStart);
    bus.off('scan-stage', onStage);
    bus.off('scan', onScan);
    bus.off('scan-failed', onFailed);
    bus.off('decision', onDecision);
    bus.off('event', onEvent);
  });
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Health endpoints answer the hosting platform, whatever Host it sends.
  const early = (req.url ?? '/').split('?')[0];
  if (early === '/healthz') return sendJson(res, 200, { ok: true, uptimeSec: Math.round(process.uptime()) });
  if (early === '/readyz') {
    const ready = readiness();
    return sendJson(res, ready.ready ? 200 : 503, ready);
  }
  // DNS-rebinding defence first: nothing, not even static files, is served to
  // a Host that is not this loopback origin.
  if (!hostAllowed(req.headers.host, config.port, config.host, config.publicOrigin)) {
    send(res, 403, { 'content-type': 'text/plain; charset=utf-8' }, 'Forbidden host');
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path.startsWith('/api/')) {
    const postable = path === '/api/scan' || path === '/api/analyze';
    if (method !== 'GET' && method !== 'HEAD' && !(method === 'POST' && postable)) {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    if (method === 'GET' || method === 'HEAD') {
      const read = gate.read(req, Date.now());
      if (!read.ok) return tooMany(res, read);
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
      // Deep intelligence is read at request time, from stored rows only, so
      // the Dossier shows the same normalised contract the engine decided on.
      const now = Date.now();
      const intel = store.intel();
      const bundle = intel ? gatherIntelligence(store.decisionSources(), token, now) : null;
      const revisions = intel?.eventRevisionsOf(mint) ?? [];
      return sendJson(res, 200, dossier(token, token.ledger ? [] : store.latestEvidence(mint), context, bundle, revisions, config.riskRadarUrl));
    }

    // Diagnostic JSON for one token's deep intelligence. Read-only; not a
    // product surface and not an input to any verdict.
    const intelRoute = /^\/api\/intel\/([^/]+)$/.exec(path);
    if (intelRoute) {
      let mint: string;
      try {
        mint = decodeURIComponent(intelRoute[1]!);
      } catch {
        return sendJson(res, 400, { error: 'bad mint' });
      }
      if (!MINT_PATTERN.test(mint)) return sendJson(res, 400, { error: 'bad mint' });
      const intel = store.intel();
      if (!intel) return sendJson(res, 503, { error: 'history database unavailable' });
      const latest = intel.latestTokenIntelligence(mint);
      if (!latest) return sendJson(res, 404, { error: 'not analysed' });
      return sendJson(res, 200, { ...latest, attributionRecord: intel.attribution(mint), securityEvents: intel.eventsOf([mint]) });
    }

    if (path === '/api/analyze' && method === 'POST') {
      await analyzeRoute(req, res);
      return;
    }

    if (path === '/api/scan' && method === 'POST') {
      const origin = sameOrigin(req, config.publicOrigin);
      if (!origin.ok) return sendJson(res, 403, { error: `refused: ${origin.reason}` });
      if (isScanning()) return sendJson(res, 409, { error: 'scan already running' });
      const allowed = gate.scan(req, Date.now());
      if (!allowed.ok) return tooMany(res, allowed);
      runScan().catch((error: unknown) => log.error('manual scan failed:', error instanceof Error ? error.message : error));
      return sendJson(res, 202, { started: true });
    }

    if (path === '/api/stream') {
      const release = gate.openStream(req);
      if (!release) return sendJson(res, 503, { error: 'too many live connections; the Board still works without one' });
      stream(res, release);
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
    // Chain collection runs beside the scanner, never inside it: its budget,
    // its failures and its pace are its own, and a dead RPC endpoint stops
    // collection, not scanning.
    if (config.ingestEnabled) {
      const endpoint = rpcEndpoint();
      log.step(`chain collection every ${config.ingestIntervalSec}s via ${endpoint.label}`);
      startIngestion(liveIngestDeps(), config.ingestIntervalSec, (cycle) => {
        const launches = cycle.launches ? `${cycle.launches.recorded} launches` : 'launches off';
        const trades = cycle.deep.pools.reduce((sum, p) => sum + (p.byKind.SWAP ?? 0), 0);
        log.debug(`chain cycle ${cycle.health.state}: ${launches}, ${trades} trades from ${cycle.deep.pools.length} pools in ${(cycle.durationMs / 1000).toFixed(1)}s`);
      });
    }
  }

  if (options.monitor !== false && config.intelEnabled) {
    // Actor analysis runs on its own loop and budget, after collection has
    // had a chance to gather pool activity; it never blocks either.
    log.step(`deep intelligence every ${config.intelIntervalSec}s (${config.intelTokensPerCycle} tokens, ${config.intelRequestsPerCycle} requests per cycle)`);
    startIntel(liveIntelDeps(), config.intelIntervalSec, (cycle) => {
      // The verdicts of the tokens just analysed follow their new evidence
      // now, not at their next scan - which a drained token may never get.
      const re = redecideAnalysed(cycle.tokens.filter((t) => t.error === null).map((t) => t.mint), cycle.tokens.filter((t) => t.error === null && t.securityEvents > 0).map((t) => t.mint));
      log.debug(`intel cycle ${cycle.health.state}: ${cycle.tokens.length} tokens, ${cycle.budget.requests} requests in ${(cycle.durationMs / 1000).toFixed(1)}s; re-decided ${re.checked}, ${re.changed.length} changed`);
    });
  }

  // Returned so a caller that started the server can stop it. Tests need this:
  // exiting the process with the listener still open trips a libuv teardown
  // assertion on Windows.
  return server;
}
