/**
 * Product layer: the live ranking universe, human-facing language, DTOs,
 * capability reporting and the server's security boundary.
 *
 * The engine already has hundreds of tests. These pin the layer that turns its
 * output into something a person reads - where the old dashboard ranked
 * unevaluated tokens, contradicted itself about coverage, and hid keyless mode.
 */

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';

import { FRESHNESS } from '../src/core/evidence.ts';
import {
  countUniverse,
  currentAgeHours,
  DEFAULT_LIVE_WINDOW_MS,
  FRESH_WITHIN_MS,
  liveTokens,
  placementOf,
} from '../src/core/ranking.ts';
import { capabilities, globallyUnavailableMetrics } from '../src/core/capabilities.ts';
import { ledgerFrom, ledgerValue } from '../src/core/ledger.ts';
import { changeReason, unknownSignals, verdictReason, vetoLabelFor } from '../src/server/present.ts';
import {
  boardResponse,
  boardRow,
  dossier,
  iconUrl,
  parseBoardQuery,
  watchpoints,
  type DtoContext,
} from '../src/server/dto.ts';
import { hostAllowed, safeHttpUrl, sameOrigin, CONTENT_SECURITY_POLICY } from '../src/server/security.ts';
import { applyRetention, DEFAULT_RETENTION } from '../src/persist/retention.ts';
import { config } from '../src/config.ts';
import { cleanupTempDirs, harness, snapshot } from './persist-helpers.ts';
import type { LedgerEntry, TokenSnapshot } from '../src/types.ts';

after(cleanupTempDirs);

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;

const KEYLESS_CAPS = capabilities({ helius: false, birdeye: false, typesafeEnabled: false, failingProviders: new Set() });

function context(overrides: Partial<DtoContext> = {}): DtoContext {
  return {
    now: NOW,
    windowMs: DEFAULT_LIVE_WINDOW_MS,
    globallyOff: globallyUnavailableMetrics(KEYLESS_CAPS),
    minCoverageQualify: 0.6,
    minCoverageWatch: 0.35,
    minLiquidityUsd: 3000,
    catastrophicConcentrationPct: 90,
    helius: false,
    ...overrides,
  };
}

/** A snapshot evaluated `minutesAgo` before NOW. */
function live(overrides: Parameters<typeof snapshot>[0] = {}, minutesAgo = 5): TokenSnapshot {
  return snapshot({ at: NOW - minutesAgo * MIN, ...overrides });
}

/** A v1-era snapshot: the `evaluation` key is absent, not null. */
function unevaluated(mint: string, minutesAgo = 5): TokenSnapshot {
  const snap = snapshot({ mint, at: NOW - minutesAgo * MIN }) as unknown as Record<string, unknown>;
  delete snap['evaluation'];
  return snap as unknown as TokenSnapshot;
}

function ledgerEntry(metric: string, state: LedgerEntry['state'], weight = 0.05, value: LedgerEntry['value'] = null): LedgerEntry {
  return {
    metric,
    state,
    value,
    source: state === 'MEASURED' ? 'jupiter' : null,
    observedAt: NOW,
    freshness: 'FRESH',
    confidence: state === 'MEASURED' ? 0.85 : 0,
    weight,
    notes: [],
    claims: [],
    overridden: [],
  };
}

// ---------------------------------------------------------------------------
// The live ranking universe (P0-C, P0-D)
// ---------------------------------------------------------------------------

describe('live ranking universe', () => {
  test('the live window is the engine\'s own market-evidence aging window', () => {
    // Pinned together: if the engine's freshness changes, the Board follows.
    assert.equal(DEFAULT_LIVE_WINDOW_MS, FRESHNESS.liquidityUsd!.agingMs);
    assert.equal(FRESH_WITHIN_MS, FRESHNESS.liquidityUsd!.freshMs);
    assert.equal(config.liveWindowMin * MIN, DEFAULT_LIVE_WINDOW_MS, 'config default must equal the engine window');
  });

  test('an evaluated, recently seen token is live', () => {
    const placement = placementOf(live({}, 10), NOW);
    assert.equal(placement.universe, 'LIVE');
    assert.equal(placement.freshness, 'FRESH');
  });

  test('inside the window but past the fresh window, a token is live and aging', () => {
    assert.equal(placementOf(live({}, 45), NOW).freshness, 'AGING');
  });

  test('past the window, an evaluated token is stale history, not live', () => {
    const placement = placementOf(live({}, 91), NOW);
    assert.equal(placement.universe, 'STALE');
    assert.equal(placement.freshness, null);
    // Its verdict is still known - it is history, not unknown.
    assert.equal(placement.eligibility, 'QUALIFIED');
  });

  test('a legacy snapshot with no evaluation key is never live, however recent', () => {
    const placement = placementOf(unevaluated('Legacy', 1), NOW);
    assert.equal(placement.universe, 'UNEVALUATED');
    assert.equal(placement.eligibility, null);
  });

  test('an evaluation with an unrecognised eligibility is not ranked', () => {
    const snap = live();
    (snap.evaluation as unknown as Record<string, unknown>)['eligibility'] = 'PROBABLY_FINE';
    assert.equal(placementOf(snap, NOW).universe, 'UNEVALUATED');
  });

  test('counts, live list and Board totals all come from the same predicate', () => {
    const tokens = [
      live({ mint: 'Q1' }),
      live({ mint: 'Q2', state: 'REJECTED', eligibility: 'REJECTED' }),
      live({ mint: 'S1' }, 200),
      unevaluated('U1'),
      unevaluated('U2'),
    ];
    const counts = countUniverse(tokens, NOW);
    assert.deepEqual(
      { live: counts.live, stale: counts.stale, unevaluated: counts.unevaluated, total: counts.total },
      { live: 2, stale: 1, unevaluated: 2, total: 5 },
    );
    assert.equal(counts.byEligibility.QUALIFIED, 1);
    assert.equal(counts.byEligibility.REJECTED, 1);
    assert.equal(liveTokens(tokens, NOW).length, counts.live);

    const board = boardResponse(tokens, parseBoardQuery(new URLSearchParams()), context(), KEYLESS_CAPS, FRESH_WITHIN_MS);
    assert.equal(board.total, counts.live);
    assert.equal(board.counts.all, counts.live);
    assert.deepEqual(board.universe, { live: 2, stale: 1, unevaluated: 2, total: 5 });
    assert.deepEqual(board.rows.map((row) => row.mint).sort(), ['Q1', 'Q2']);
  });

  test('a rejected segment returns only rejected tokens - unevaluated ones no longer leak in', () => {
    // The audit found ?eligibility=REJECTED returning 500 rows for 44 rejected
    // tokens, because unevaluated snapshots bypassed the filter.
    const tokens = [
      live({ mint: 'R1', state: 'REJECTED', eligibility: 'REJECTED' }),
      ...Array.from({ length: 30 }, (_, i) => unevaluated(`U${i}`)),
    ];
    const board = boardResponse(tokens, parseBoardQuery(new URLSearchParams('segment=rejected')), context(), KEYLESS_CAPS, FRESH_WITHIN_MS);
    assert.deepEqual(board.rows.map((row) => row.mint), ['R1']);
  });

  test('a rejected token never sorts above a qualified one, whatever the sort key', () => {
    const tokens = [
      live({ mint: 'Q', score: 10, liquidityUsd: 1 }),
      live({ mint: 'R', score: 99, liquidityUsd: 9e9, state: 'REJECTED', eligibility: 'REJECTED' }),
    ];
    for (const sort of ['verdict', 'score', 'liquidity', 'momentum', 'newest', 'seen']) {
      const board = boardResponse(tokens, parseBoardQuery(new URLSearchParams(`sort=${sort}`)), context(), KEYLESS_CAPS, FRESH_WITHIN_MS);
      assert.equal(board.rows[0]!.mint, 'Q', `sort=${sort}`);
    }
  });

  test('search still finds stale and unevaluated tokens, as history', () => {
    const tokens = [live({ mint: 'LiveOne' }), live({ mint: 'OldOne' }, 500), unevaluated('NeverOne')];
    const board = boardResponse(tokens, parseBoardQuery(new URLSearchParams('q=one')), context(), KEYLESS_CAPS, FRESH_WITHIN_MS);
    assert.deepEqual(board.rows.map((row) => row.mint), ['LiveOne']);
    assert.deepEqual(board.history.map((h) => [h.mint, h.universe]).sort(), [
      ['NeverOne', 'UNEVALUATED'],
      ['OldOne', 'STALE'],
    ]);
  });

  test('age is recomputed from launch time, not frozen at snapshot time', () => {
    const snap = live({}, 60);
    snap.ageHours = 1; // what the snapshot recorded
    snap.launchedAt = NOW - 50 * HOUR;
    assert.equal(Math.round(currentAgeHours(snap, NOW)!), 50);
    assert.equal(Math.round(boardRow(snap, context()).ageHours!), 50);
  });

  test('history retention does not decide live visibility (P0-D)', () => {
    // A token last seen three days ago: far outside the live window, well inside
    // history retention. It must be off the Board and still in the database.
    const h = harness();
    const threeDaysAgo = Date.now() - 3 * 24 * HOUR;
    h.repo.saveTokenSnapshot(snapshot({ mint: 'ThreeDaysOld', at: threeDaysAgo }));
    h.db.prepare('UPDATE tokens SET last_seen_at = ? WHERE mint = ?').run(threeDaysAgo, 'ThreeDaysOld');

    applyRetention(h.db, DEFAULT_RETENTION, Date.now());

    const stored = h.repo.latestToken('ThreeDaysOld');
    assert.ok(stored !== null, 'history is kept');
    assert.equal(placementOf(stored!, Date.now()).universe, 'STALE', 'but it is not live');
    assert.equal(h.repo.tokenHistory('ThreeDaysOld').length, 1);
    h.close();
  });
});

// ---------------------------------------------------------------------------
// Human-facing language
// ---------------------------------------------------------------------------

describe('verdict language', () => {
  test('a rejected token leads with its veto, specific where the veto says more', () => {
    const snap = live({ state: 'REJECTED', eligibility: 'REJECTED', vetoCodes: ['LIQUIDITY_TOO_LOW'] });
    assert.equal(verdictReason(snap, context()).text, 'Liquidity below safety floor');
    assert.equal(verdictReason(snap, context()).tone, 'bad');
    assert.equal(
      vetoLabelFor({ code: 'CRITICAL_RUGCHECK', observedValue: 'Creator history of rugged tokens (danger)' }),
      'Creator has rugged tokens before',
    );
  });

  test('several vetoes are counted, not hidden', () => {
    const snap = live({ state: 'REJECTED', eligibility: 'REJECTED', vetoCodes: ['PERMANENT_DELEGATE_ACTIVE', 'UNTRADEABLE'] });
    assert.equal(verdictReason(snap, context()).text, 'Permanent delegate can move holder tokens · +1 more');
  });

  test('watch states the coverage rule it failed', () => {
    const snap = live({ state: 'WATCH', eligibility: 'WATCH' });
    snap.evaluation!.coverage.coverage = 0.52;
    assert.equal(verdictReason(snap, context()).text, 'Coverage 52% · needs 60% to qualify');
  });

  test('keyless mode never claims "fully measured"', () => {
    const snap = live();
    snap.ledger = [ledgerEntry('liquidityUsd', 'MEASURED'), ledgerEntry('mintExtensions', 'UNKNOWN')];
    assert.equal(verdictReason(snap, context()).text, 'No vetoes · all available signals measured');
    // With a key, and genuinely everything measured, it may say so.
    snap.ledger = [ledgerEntry('liquidityUsd', 'MEASURED'), ledgerEntry('mintExtensions', 'MEASURED')];
    assert.equal(verdictReason(snap, context({ globallyOff: new Set() })).text, 'No vetoes · fully measured');
  });

  test('a token-specific gap is named', () => {
    const snap = live();
    snap.ledger = [ledgerEntry('holders', 'UNKNOWN'), ledgerEntry('mintExtensions', 'UNKNOWN')];
    assert.equal(verdictReason(snap, context()).text, 'No vetoes · holder count unknown');
  });

  test('without a ledger, the engine\'s counts are used - never an unchecked "all measured"', () => {
    const snap = live();
    snap.ledger = null;
    snap.evaluation!.coverage.measured = 9;
    snap.evaluation!.coverage.conflicted = 0;
    snap.evaluation!.coverage.eligibleSignals = 13;
    // 13 - 9 - 1 globally-off signal = 3 token-specific gaps.
    assert.equal(verdictReason(snap, context()).text, 'No vetoes · 3 signals unknown');
  });

  test('a risk finding outranks a clean reason', () => {
    const snap = live();
    snap.score.flags = [{ code: 'wash_suspect', level: 'medium', message: 'Volume is 40x liquidity' }];
    assert.equal(verdictReason(snap, context()).text, 'Volume looks inflated relative to liquidity');
  });

  test('unknown signals carry the reason they are unknown', () => {
    const unknowns = unknownSignals(
      [ledgerEntry('mintExtensions', 'UNKNOWN'), ledgerEntry('holders', 'UNAVAILABLE'), ledgerEntry('tokenProgram', 'UNKNOWN', 0)],
      globallyUnavailableMetrics(KEYLESS_CAPS),
    );
    assert.deepEqual(unknowns.map((u) => [u.label, u.reason, u.global]), [
      ['Token-2022 extensions', 'Needs a Helius API key', true],
      ['Holder count', 'Provider could not be reached', false],
    ]);
  });

  test('changes are described by what caused them', () => {
    assert.equal(changeReason({ from: 'QUALIFIED', to: 'REJECTED', vetoCodes: ['LIQUIDITY_TOO_LOW'], coverage: 0.9 }), 'Liquidity below safety floor');
    assert.equal(changeReason({ from: 'REJECTED', to: 'QUALIFIED', vetoCodes: [], coverage: 0.9 }), 'Vetoes no longer apply');
    assert.equal(changeReason({ from: 'WATCH', to: 'QUALIFIED', vetoCodes: [], coverage: 0.64 }), 'Coverage rose to 64%');
    assert.equal(changeReason({ from: null, to: 'QUALIFIED', vetoCodes: [], coverage: 0.9 }), 'First assessment');
  });
});

// ---------------------------------------------------------------------------
// Capabilities (keyless truth)
// ---------------------------------------------------------------------------

describe('capabilities', () => {
  test('keyless mode reports on-chain checks off, with the fix', () => {
    const t22 = KEYLESS_CAPS.find((c) => c.id === 'token-2022')!;
    assert.equal(t22.state, 'OFF');
    assert.equal(t22.enableWith, 'HELIUS_API_KEY');
    assert.match(t22.impact, /cannot be detected/);
    assert.deepEqual([...globallyUnavailableMetrics(KEYLESS_CAPS)].sort(), ['mintExtensions', 'tokenProgram']);
  });

  test('with a key, nothing is globally unavailable', () => {
    const keyed = capabilities({ helius: true, birdeye: true, typesafeEnabled: false, failingProviders: new Set() });
    assert.equal(globallyUnavailableMetrics(keyed).size, 0);
    assert.equal(keyed.find((c) => c.id === 'token-2022')!.state, 'ON');
  });

  test('a provider failing in a recent scan shows as degraded, not as on', () => {
    const caps = capabilities({ helius: true, birdeye: false, typesafeEnabled: false, failingProviders: new Set(['rugcheck', 'helius']) });
    assert.equal(caps.find((c) => c.id === 'safety-reports')!.state, 'DEGRADED');
    assert.equal(caps.find((c) => c.id === 'token-2022')!.state, 'DEGRADED');
  });

  test('impersonation screening is reported disabled, never as a passed check', () => {
    assert.equal(KEYLESS_CAPS.find((c) => c.id === 'impersonation')!.state, 'DISABLED');
  });
});

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

describe('board payload', () => {
  test('200 Board rows fit well under 100 KB and are far smaller than full snapshots', () => {
    const tokens = Array.from({ length: 200 }, (_, i) => {
      const snap = live({ mint: `Mint${String(i).padStart(40, '0')}`, score: 40 + (i % 60) });
      snap.ledger = [ledgerEntry('liquidityUsd', 'MEASURED'), ledgerEntry('mintExtensions', 'UNKNOWN')];
      return snap;
    });
    const board = boardResponse(tokens, parseBoardQuery(new URLSearchParams('limit=200')), context(), KEYLESS_CAPS, FRESH_WITHIN_MS);
    const boardBytes = Buffer.byteLength(JSON.stringify(board));
    const fullBytes = Buffer.byteLength(JSON.stringify({ tokens }));
    assert.equal(board.rows.length, 200);
    assert.ok(boardBytes < 100_000, `board payload ${boardBytes} bytes`);
    assert.ok(fullBytes / boardBytes > 5, `only ${(fullBytes / boardBytes).toFixed(1)}x smaller`);
  });

  test('a Board row carries no raw provider objects', () => {
    const row = boardRow(live(), context()) as unknown as Record<string, unknown>;
    for (const heavy of ['pair', 'jupiter', 'rugcheck', 'onchain', 'evaluation', 'ledger', 'components', 'flags']) {
      assert.equal(heavy in row, false, `${heavy} must not be in a Board row`);
    }
    // The score travels as a number, not as the engine's Score object.
    assert.equal(typeof row['score'], 'number');
  });
});

describe('dossier', () => {
  test('keyless: contract section says it was not inspected, and why', () => {
    // Keyless: nothing read the mint account, so there is no on-chain block.
    const d = dossier(live({ onchain: null }), [], context());
    assert.equal(d.contract.inspected, false);
    assert.match(d.contract.unavailableReason!, /Helius API key/);
  });

  test('the not-measured list names signals and reasons', () => {
    const snap = live();
    snap.ledger = [ledgerEntry('liquidityUsd', 'MEASURED'), ledgerEntry('mintExtensions', 'UNKNOWN'), ledgerEntry('holders', 'STALE')];
    const d = dossier(snap, [], context());
    assert.deepEqual(d.trust.unknowns.map((u) => u.label), ['Token-2022 extensions', 'Holder count']);
    assert.ok(d.verdict.facts.some((f) => f.text.includes('Token-2022 extensions not inspected')));
  });

  test('without a ledger, persisted evidence is used and labelled as such', () => {
    const d = dossier(live(), [
      { snapshotId: 1, observedAt: NOW, metric: 'liquidityUsd', state: 'MEASURED', value: '50000', source: 'dexscreener', freshness: 'FRESH', confidence: 0.9 },
      { snapshotId: 1, observedAt: NOW, metric: 'mintExtensions', state: 'UNKNOWN', value: null, source: null, freshness: 'UNKNOWN', confidence: 0 },
    ], context());
    assert.equal(d.evidence.source, 'stored');
    assert.equal(d.evidence.rows.find((r) => r.metric === 'liquidityUsd')!.value, 50000);
    assert.deepEqual(d.trust.unknowns.map((u) => u.metric), ['mintExtensions']);
  });

  test('watchpoints restate the gate\'s real thresholds', () => {
    const snap = live({ liquidityUsd: 4_100 });
    snap.evaluation!.coverage.coverage = 0.64;
    const points = watchpoints(snap, [], context()).map((w) => w.text);
    assert.ok(points.includes('Liquidity $4.1K — the gate rejects below $3.0K.'), points.join(' | '));
    assert.ok(points.includes('Coverage 64% — falls to Watch below 60%.'), points.join(' | '));
  });

  test('a stale token is marked as history in its Dossier', () => {
    assert.equal(dossier(live({}, 500), [], context()).placement.universe, 'STALE');
    assert.equal(dossier(unevaluated('U'), [], context()).verdict.label, 'Not assessed');
  });
});

describe('ledger', () => {
  test('ledger values are JSON-safe projections of engine values', () => {
    assert.equal(ledgerValue(Number.NaN), null);
    assert.deepEqual(ledgerValue([{ id: 'permanentDelegate', policy: 'HARD_VETO' }]), ['permanentDelegate']);
    assert.deepEqual(ledgerValue({ m5: 1, h1: 2, junk: 'x' }), { m5: 1, h1: 2 });
  });

  test('ledgerFrom copies state, source and claims without deciding anything', () => {
    const evidence = {
      liquidityUsd: {
        value: 1000, state: 'CONFLICTED', source: 'dexscreener', observedAt: NOW, freshness: 'FRESH', confidence: 0.54,
        notes: ['providers disagree'], claims: [{ provider: 'dexscreener', value: 1000, observedAt: NOW, freshness: 'FRESH' }, { provider: 'jupiter', value: 5000, observedAt: NOW, freshness: 'FRESH' }],
        overridden: [],
      },
    } as never;
    const [entry] = ledgerFrom(evidence);
    assert.equal(entry!.metric, 'liquidityUsd');
    assert.equal(entry!.state, 'CONFLICTED');
    assert.equal(entry!.claims.length, 2);
    assert.equal(entry!.weight, 0.18);
  });
});

// ---------------------------------------------------------------------------
// Security boundary
// ---------------------------------------------------------------------------

describe('server security', () => {
  test('loopback Host names at our port are allowed; anything else is refused', () => {
    for (const host of ['localhost:5173', '127.0.0.1:5173', '[::1]:5173']) assert.equal(hostAllowed(host, 5173, '127.0.0.1'), true, host);
    // DNS rebinding: the browser sends the attacker's hostname.
    for (const host of ['attacker.example:5173', 'localhost.attacker.example:5173', 'localhost:9999', 'localhost', '', '127.0.0.1:5173@evil']) {
      assert.equal(hostAllowed(host, 5173, '127.0.0.1'), false, host);
    }
    assert.equal(hostAllowed(undefined, 5173, '127.0.0.1'), false);
  });

  test('an operator who binds a public interface opts out of the Host check', () => {
    assert.equal(hostAllowed('192.168.1.20:5173', 5173, '0.0.0.0'), true);
  });

  test('state-changing requests need a same-origin Origin', () => {
    const req = (headers: Record<string, string>): IncomingMessage => ({ headers }) as unknown as IncomingMessage;
    assert.equal(sameOrigin(req({ host: 'localhost:5173', origin: 'http://localhost:5173' })).ok, true);
    assert.equal(sameOrigin(req({ host: 'localhost:5173' })).ok, false, 'missing Origin');
    assert.equal(sameOrigin(req({ host: 'localhost:5173', origin: 'https://evil.example' })).ok, false);
    assert.equal(sameOrigin(req({ host: 'localhost:5173', origin: 'http://localhost:5174' })).ok, false, 'another local app');
    assert.equal(sameOrigin(req({ host: 'localhost:5173', origin: 'null' })).ok, false);
    assert.equal(
      sameOrigin(req({ host: 'localhost:5173', origin: 'http://localhost:5173', 'sec-fetch-site': 'cross-site' })).ok,
      false,
    );
  });

  test('the CSP forbids inline script, inline style, eval and framing', () => {
    assert.match(CONTENT_SECURITY_POLICY, /script-src 'self'(;|$)/);
    assert.match(CONTENT_SECURITY_POLICY, /style-src 'self'(;|$)/);
    assert.doesNotMatch(CONTENT_SECURITY_POLICY, /unsafe-inline|unsafe-eval/);
    assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/);
    assert.match(CONTENT_SECURITY_POLICY, /object-src 'none'/);
  });

  test('only http(s) links survive, whatever their spelling', () => {
    for (const bad of [
      'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)',
      'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox', 'file:///etc/passwd',
      'https://user:pass@evil.example', '//evil.example', 'not a url', '',
    ]) {
      assert.equal(safeHttpUrl(bad), null, JSON.stringify(bad));
    }
    assert.equal(safeHttpUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
    assert.equal(safeHttpUrl('http://example.com', { httpsOnly: true }), null);
  });

  test('icon URLs are https only, and resized only on the one CDN known to accept it', () => {
    assert.equal(iconUrl('http://cdn.dexscreener.com/x.png'), null);
    assert.equal(iconUrl('https://cdn.dexscreener.com/cms/images/a?width=800&height=800'), 'https://cdn.dexscreener.com/cms/images/a?width=128&height=128');
    assert.equal(iconUrl('https://ipfs.io/ipfs/abc?width=800'), 'https://ipfs.io/ipfs/abc?width=800');
    assert.equal(iconUrl('x" onerror="alert(1)'), null);
  });
});
