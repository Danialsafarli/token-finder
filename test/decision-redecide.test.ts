/**
 * Re-deciding after deep intelligence - a regression found in live
 * verification.
 *
 * Live, a token's creator removed 100% of its pool (confirmed on-chain:
 * one `Withdraw` took the vault from 892.6T base units to 6,867). Deep
 * intelligence recorded a current-rule CONFIRMED liquidity drain. But the
 * token stayed QUALIFIED on the live Board: the decision only ran at scan
 * time, and a drained token's liquidity falls below the discovery floor, so
 * it was never scanned again. It kept its pre-rug verdict until it aged out
 * of the live window.
 *
 * The decision must follow the evidence: when an intelligence cycle finishes,
 * each analysed token is re-decided from its stored snapshot and the new
 * intelligence - no provider call, no new market observation.
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { IntelRepository } from '../src/persist/intel-repository.ts';
import { linkedMints, redecide, screenOf } from '../src/decision/redecide.ts';
import { RULE_VERSIONS } from '../src/decision/versions.ts';
import { cleanupTempDirs, harness } from './persist-helpers.ts';
import { bundle, CONFIG, HOUR, intelRow, MIN, MINT, NOW, run, token } from './decision-helpers.ts';
import type { TokenSnapshot } from '../src/types.ts';

after(() => cleanupTempDirs());

function world() {
  const h = harness();
  const intel = new IntelRepository(h.db);
  const scanned = token();
  scanned.at = NOW - 20 * MIN;
  const qualified = run(scanned, bundle(scanned)).snapshot;
  assert.equal(qualified.evaluation!.eligibility !== 'REJECTED', true);
  h.repo.saveTokenSnapshot(qualified);
  const tokens = new Map<string, TokenSnapshot>([[MINT, qualified]]);
  const changes: { from: string; to: string }[] = [];
  const deps = {
    current: (mint: string) => tokens.get(mint) ?? null,
    sources: { intel, marketHistory: (m: string, since: number) => h.repo.marketHistory(m, { since }), holderHistory: (m: string, since: number) => h.repo.holderHistory(m, { since }) },
    config: CONFIG,
    now: () => NOW,
    liveWindowMs: 90 * MIN,
    persist: (next: TokenSnapshot, decidedAt: number) => {
      tokens.set(next.mint, next);
      h.repo.saveTokenSnapshot(next, { redecidedAt: decidedAt });
    },
    onChange: (next: TokenSnapshot, previous: TokenSnapshot) => changes.push({ from: previous.evaluation!.eligibility, to: next.evaluation!.eligibility }),
  };
  return { h, intel, tokens, deps, changes, qualified };
}

describe('re-deciding after deep intelligence', () => {
  test('a confirmed drain found after the last scan rejects the token without a new scan', () => {
    const { h, intel, tokens, deps, changes, qualified } = world();
    const before = qualified.evaluation!.eligibility;
    // The intelligence cycle records the drain.
    intel.saveTokenIntelligence({ mint: MINT, ...intelRow(), analyzedAt: NOW - MIN });
    intel.saveSecurityEvents(
      [{ id: 'drain', mint: MINT, type: 'LIQUIDITY_DRAIN', status: 'CONFIRMED', actor: 'Creator11111111111111111111111111111111111', creatorLinked: true, signature: 'drain-sig', slot: 1, blockTimeMs: NOW - 5 * MIN, amount: null, reasons: ['100% of the pool\'s token reserve removed', 'by a creator-linked wallet'], evidence: [], confidence: 0.95 }],
      NOW - MIN,
      { mint: MINT, ruleVersion: RULE_VERSIONS.security, sweep: true },
    );

    const result = redecide([MINT], deps);
    assert.deepEqual(result.changed.map((c) => c.to), ['REJECTED']);
    const now = tokens.get(MINT)!;
    assert.equal(now.evaluation!.eligibility, 'REJECTED');
    assert.equal(now.decision!.hardFails[0]!.code, 'CONFIRMED_CURRENT_RUG');
    // The market observation it rests on is unchanged: no data is invented.
    assert.equal(now.at, qualified.at);
    assert.equal(now.priceUsd, qualified.priceUsd);
    // The change is a real, persisted transition that Changes and the Observatory read.
    assert.deepEqual(changes, [{ from: before, to: 'REJECTED' }]);
    const transitions = h.repo.verdictTransitions({ mint: MINT });
    assert.equal(transitions[0]!.from, before);
    assert.equal(transitions[0]!.to, 'REJECTED');
    assert.equal(transitions[0]!.at, NOW);
    assert.equal(h.repo.verdictChanges({ mint: MINT })[0]!.to, 'REJECTED');
    // No market row was fabricated for the re-decision.
    assert.equal(h.repo.marketHistory(MINT).length, 1);
    h.close();
  });

  test('re-deciding with nothing new changes nothing and writes no transition', () => {
    const { h, intel, deps, changes } = world();
    intel.saveTokenIntelligence({ mint: MINT, ...intelRow(), analyzedAt: NOW - MIN });
    const first = redecide([MINT], deps);
    const second = redecide([MINT], deps);
    assert.equal(second.changed.length, 0);
    assert.ok(first.checked === 1 && second.checked === 1);
    assert.equal(changes.length, first.changed.length);
    assert.equal(h.repo.verdictTransitions({ mint: MINT }).length, 1 + first.changed.length);
    h.close();
  });

  test('a sibling launch not analysed this cycle is re-decided when its creator is confirmed rugging', () => {
    const { h, intel, tokens, deps, changes } = world();
    const SIB = 'SiblingMint111111111111111111111111111111111';
    const OLD = 'EarlierRug111111111111111111111111111111111';
    const CREATOR = 'Creator11111111111111111111111111111111111';
    const attribute = (mint: string) =>
      intel.saveAttribution({ mint, status: 'ATTRIBUTED', creator: CREATOR, confidence: 0.85, basis: 'test', feePayer: CREATOR, deployers: [CREATOR], mintAuthority: null, mintAuthorityRole: null, freezeAuthority: null, liquidityCreator: null, initialFunder: null, signature: `${mint}-creation`, evidence: [] }, NOW - HOUR);
    const drain = (mint: string, at: number) =>
      intel.saveSecurityEvents(
        [{ id: `drain-${mint}`, mint, type: 'LIQUIDITY_DRAIN', status: 'CONFIRMED', actor: CREATOR, creatorLinked: true, signature: `${mint}-drain`, slot: 1, blockTimeMs: at, amount: null, reasons: ['pool reserve removed'], evidence: [], confidence: 0.95 }],
        at,
        { mint, ruleVersion: RULE_VERSIONS.security, sweep: true },
      );
    for (const m of [MINT, SIB, OLD]) attribute(m);
    // The sibling: live, analysed earlier, Qualified - and no longer attractive enough to be analysed again.
    const sib = token();
    sib.mint = SIB;
    sib.at = NOW - 20 * MIN;
    const sibling = run(sib, bundle(sib)).snapshot;
    assert.notEqual(sibling.evaluation!.eligibility, 'REJECTED');
    h.repo.saveTokenSnapshot(sibling);
    tokens.set(SIB, sibling);
    intel.saveTokenIntelligence({ mint: SIB, ...intelRow(), analyzedAt: NOW - 2 * HOUR });
    drain(OLD, NOW - 3 * HOUR); // one confirmed rug: serious, not yet a hard fail

    // This cycle analyses MINT and confirms a second rug by the same creator.
    intel.saveTokenIntelligence({ mint: MINT, ...intelRow(), analyzedAt: NOW - MIN });
    drain(MINT, NOW - 5 * MIN);

    const unlinked = redecide([MINT], deps);
    assert.equal(tokens.get(SIB)!.evaluation!.eligibility, sibling.evaluation!.eligibility, 'without linkage the sibling keeps its stale verdict');
    assert.equal(unlinked.linked, 0);

    const result = redecide([MINT], deps, linkedMints(intel, [MINT]));
    assert.equal(result.linked, 1, 'the sibling was reached through the creator, not analysed');
    assert.equal(tokens.get(SIB)!.evaluation!.eligibility, 'REJECTED');
    assert.equal(tokens.get(SIB)!.decision!.hardFails[0]!.code, 'STRONG_SERIAL_RUGGER');
    assert.ok(changes.some((c) => c.to === 'REJECTED'));
    h.close();
  });

  test('a token no longer live is not re-decided', () => {
    const { h, deps } = world();
    const result = redecide([MINT], { ...deps, now: () => NOW + 3 * HOUR });
    assert.equal(result.checked, 0);
    h.close();
  });

  test('the fast screen is recovered exactly: only Phase 1 vetoes, the screen eligibility', () => {
    const rejected = token({ vetoCodes: ['LIQUIDITY_TOO_LOW'] });
    const decided = run(rejected, bundle(rejected, { events: [] })).snapshot;
    const screen = screenOf(decided);
    assert.deepEqual(screen.evaluation!.vetoes.map((v) => v.code), ['LIQUIDITY_TOO_LOW']);
    assert.equal(screen.evaluation!.eligibility, decided.decision!.screen.eligibility);
  });
});
