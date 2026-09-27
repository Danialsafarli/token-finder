/**
 * Serves the real dashboard over a seeded, isolated database for the browser
 * tests. Run as its own process with TOKEN_FINDER_DATA_DIR and PORT set; the
 * monitor is off, so nothing here touches the network.
 *
 * Every token is built to exercise one state the product must render honestly.
 */

import { store } from '../../src/core/store.ts';
import { serve } from '../../src/server/index.ts';
import { bus, type ScanResult } from '../../src/core/monitor.ts';
import { fixtureByName } from '../fixtures.ts';
import { snapshot, token2022Onchain } from '../persist-helpers.ts';
import type { LedgerEntry, TokenSnapshot } from '../../src/types.ts';

const now = Date.now();
const MIN = 60_000;

function ledger(overrides: Record<string, LedgerEntry['state']> = {}): LedgerEntry[] {
  const metrics: [string, number][] = [
    ['mintAuthorityRevoked', 0.078], ['freezeAuthorityRevoked', 0.052], ['mintExtensions', 0.052],
    ['topHoldersPct', 0.052], ['rugcheckRisk', 0.052], ['tradable', 0.07], ['liquidityUsd', 0.18],
    ['volume24h', 0.07], ['priceChange', 0.12], ['buyPressure', 0.09], ['holders', 0.13],
    ['organicScore', 0.026], ['ageHours', 0.08], ['tokenProgram', 0],
  ];
  return metrics.map(([metric, weight]) => {
    const state = overrides[metric] ?? (metric === 'mintExtensions' || metric === 'tokenProgram' ? 'UNKNOWN' : 'MEASURED');
    const measured = state === 'MEASURED' || state === 'CONFLICTED';
    return {
      metric,
      state,
      value: measured ? (metric.endsWith('Revoked') ? true : metric === 'tradable' ? true : 42) : null,
      source: measured ? 'jupiter' : null,
      observedAt: now - 5 * MIN,
      freshness: measured ? 'FRESH' : 'UNKNOWN',
      confidence: measured ? 0.85 : 0,
      weight,
      notes: [],
      claims: measured
        ? [
            { provider: 'jupiter', value: 42, observedAt: now - 5 * MIN, freshness: 'FRESH' },
            { provider: 'dexscreener', value: 40, observedAt: now - 5 * MIN, freshness: 'FRESH' },
          ]
        : [],
      overridden: [],
    };
  });
}

function put(snap: TokenSnapshot): void {
  store.upsert(snap);
}

// --- a qualified token with a history of material moves -------------------
for (const [minutesAgo, score, price] of [[80, 60, 0.001], [50, 68, 0.0014], [20, 74, 0.0019], [4, 81, 0.0021]] as const) {
  const snap = snapshot({ mint: 'QuaLiFieD1111111111111111111111111111111111', at: now - minutesAgo * MIN, score, priceUsd: price, liquidityUsd: 90_000 + score * 100 });
  snap.symbol = 'SOLID';
  snap.name = 'Solid Token';
  snap.ledger = ledger();
  snap.onchain = null;
  put(snap);
}

// --- watch -----------------------------------------------------------------
{
  const snap = snapshot({ mint: 'WaTcH11111111111111111111111111111111111111', at: now - 6 * MIN, score: 55, state: 'WATCH', eligibility: 'WATCH' });
  snap.symbol = 'MAYBE';
  snap.name = 'Watch Token';
  snap.evaluation!.coverage.coverage = 0.48;
  snap.ledger = ledger({ holders: 'UNKNOWN', organicScore: 'UNAVAILABLE', rugcheckRisk: 'STALE' });
  snap.onchain = null;
  put(snap);
}

// --- a genuine verdict change: qualified, then rejected --------------------
{
  const before = snapshot({ mint: 'ReJeCtEd11111111111111111111111111111111111', at: now - 40 * MIN, score: 70, liquidityUsd: 9_000 });
  before.symbol = 'FADING';
  before.name = 'Fading Token';
  before.ledger = ledger();
  before.onchain = null;
  put(before);
  const after = snapshot({
    mint: 'ReJeCtEd11111111111111111111111111111111111',
    at: now - 8 * MIN,
    score: 44,
    liquidityUsd: 2_000,
    state: 'REJECTED',
    eligibility: 'REJECTED',
    vetoCodes: ['LIQUIDITY_TOO_LOW'],
  });
  after.symbol = 'FADING';
  after.name = 'Fading Token';
  after.ledger = ledger();
  after.onchain = null;
  put(after);
}

// --- Token-2022 with an armed permanent delegate ---------------------------
{
  const snap = snapshot({
    mint: 'ToKeN2z22111111111111111111111111111111111',
    at: now - 3 * MIN,
    score: 66,
    state: 'REJECTED',
    eligibility: 'REJECTED',
    vetoCodes: ['PERMANENT_DELEGATE_ACTIVE'],
    onchain: token2022Onchain({
      extensions: [
        {
          id: 'permanentDelegate',
          label: 'Permanent delegate',
          policy: 'HARD_VETO',
          active: true,
          rationale: 'A permanent delegate can transfer or burn any amount from any account holding this mint.',
          recheckable: true,
          detail: 'delegate is set',
          magnitude: null,
        },
      ],
      extensionsComplete: true,
    }),
  });
  snap.symbol = 'GRABBY';
  snap.name = 'Delegate Token';
  snap.ledger = ledger({ mintExtensions: 'MEASURED', tokenProgram: 'MEASURED' });
  put(snap);
}

// --- stale: evaluated, but hours ago ---------------------------------------
{
  const snap = snapshot({ mint: 'StAtE111111111111111111111111111111111111111', at: now - 5 * 60 * MIN, score: 77 });
  snap.symbol = 'OLDNEWS';
  snap.name = 'Stale Token';
  snap.onchain = null;
  put(snap);
}

// --- never evaluated: a v1-era import, recent ------------------------------
{
  const snap = snapshot({ mint: 'LeGaCy111111111111111111111111111111111111', at: now - 2 * MIN, score: 90 }) as unknown as Record<string, unknown>;
  delete snap['evaluation'];
  (snap as unknown as TokenSnapshot).symbol = 'GHOSTLY';
  (snap as unknown as TokenSnapshot).name = 'Never Evaluated';
  put(snap as unknown as TokenSnapshot);
}

// --- hostile provider strings ----------------------------------------------
{
  const snap = snapshot({ mint: 'XsSpRoBe1111111111111111111111111111111111', at: now - 2 * MIN, score: 88 });
  snap.symbol = '<img src=x onerror=window.__sym=1>';
  snap.name = '<img src=x onerror=window.__name=1>';
  snap.pair!.imageUrl = 'x" onerror="window.__img=1';
  snap.pair!.url = 'javascript:window.__pair=1';
  snap.pair!.websites = ['javascript:window.__site=1', 'data:text/html,<script>window.__data=1</script>', 'https://legit.example/'];
  snap.pair!.socials = [{ type: '<b>twitter</b>', url: 'JaVaScRiPt:window.__social=1' }];
  snap.score.flags = [{ code: 'rugcheck:x', level: 'high', message: 'RugCheck: <img src=x onerror=window.__flag=1> - desc' }];
  snap.sources = ['<script>window.__src=1</script>'];
  snap.ledger = ledger();
  snap.onchain = null;
  put(snap);
  store.addEvent({
    kind: 'liquidity_drop',
    mint: snap.mint,
    symbol: snap.symbol,
    level: 'high',
    message: `${snap.symbol} liquidity fell <script>window.__event=1</script>`,
  });
}

// --- very long strings ------------------------------------------------------
{
  const snap = snapshot({ mint: 'LoNgStRiNg11111111111111111111111111111111', at: now - 3 * MIN, score: 71 });
  snap.symbol = 'W'.repeat(40);
  snap.name = 'Supercalifragilisticexpialidocious'.repeat(3).slice(0, 80);
  snap.ledger = ledger();
  snap.onchain = null;
  put(snap);
}

store.finishScan(now - 2 * MIN, { analyzed: 7, fresh: 7 });

// --- providers, for on-demand analysis ----------------------------------------
// The Analyze flow runs the real pipeline; only the providers' HTTP answers are
// substituted, and only for these two mints. ANALYZE_MINT answers as the
// 'healthy-established' fixture does; NO_MARKET_MINT has no pool anywhere.
// Each answer takes a moment, as a real provider would, so the stages can be
// observed. Nothing else is reachable: the monitor is off.
export const ANALYZE_MINT = 'AnaLyzeMe11111111111111111111111111111111111';
export const NO_MARKET_MINT = 'NoMarket111111111111111111111111111111111111';
const healthy = fixtureByName('healthy-established');
const rebrand = (value: unknown, mint: string): unknown =>
  JSON.parse(JSON.stringify(value).replaceAll('Mint1111111111111111111111111111111111111', mint).replaceAll('HEALTHY', 'CLARITY').replaceAll('Healthy Token', 'Clarity Protocol'));
const PROVIDER_DELAY_MS = Number(process.env.FIXTURE_PROVIDER_DELAY_MS ?? 700);
const reply = async (body: unknown, status = 200): Promise<Response> => {
  await new Promise((resolve) => setTimeout(resolve, PROVIDER_DELAY_MS));
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  const known = url.includes(ANALYZE_MINT);
  if (url.startsWith('https://api.dexscreener.com/latest/dex/tokens/')) {
    return reply({ pairs: known ? (rebrand(healthy.dexPairs, ANALYZE_MINT) as unknown[]) : [] });
  }
  if (url.startsWith('https://lite-api.jup.ag/tokens/v2/search')) {
    return reply(known && healthy.jupiter ? [rebrand(healthy.jupiter, ANALYZE_MINT)] : []);
  }
  if (url.startsWith('https://api.rugcheck.xyz/v1/tokens/')) {
    return known && healthy.rugcheck ? reply(rebrand(healthy.rugcheck, ANALYZE_MINT)) : reply({ error: 'not found' }, 404);
  }
  return new Response('not reachable from the test fixture', { status: 404 });
}) as typeof fetch;

serve({ monitor: false });

// The tests drive scan state through the monitor's own bus, one event name per
// line on stdin, so the browser receives exactly what a real scan would send
// over SSE. No provider is contacted.
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  for (const line of chunk.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const at = Date.now();
    if (line === 'scan-start') bus.emit('scan-start', { at });
    if (line === 'scan-failed') bus.emit('scan-failed', { at });
    if (line === 'scan') {
      const result: ScanResult = { at, durationMs: 1200, candidates: 7, analyzed: 7, fresh: 0, events: [], tokenFailures: [], providerFailures: [], top: [] };
      bus.emit('scan', result);
    }
  }
});
