/**
 * The decision engine's persistence: verdict transitions, policy versions,
 * restart durability, and rule-versioned security events - on a real,
 * migrated database in a temp directory.
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/persist/db.ts';
import { Repository } from '../src/persist/repository.ts';
import { IntelRepository } from '../src/persist/intel-repository.ts';
import { migrate, MIGRATIONS } from '../src/persist/migrations.ts';
import { gatherHistory, gatherIntelligence, makeDecider, type DecisionSources } from '../src/decision/inputs.ts';
import { RULE_VERSIONS } from '../src/decision/versions.ts';
import { cleanupTempDirs, harness, tempDir } from './persist-helpers.ts';
import { bundle, CONFIG, HOUR, intelRow, MIN, MINT, NOW, run, steadyRise, token } from './decision-helpers.ts';
import type { SecurityEvent } from '../src/intel/security.ts';
import { join } from 'node:path';

after(() => cleanupTempDirs());

function securityEvent(o: Partial<SecurityEvent> & { id: string; type: SecurityEvent['type']; status: SecurityEvent['status'] }): SecurityEvent {
  return {
    mint: MINT,
    actor: 'Actor1111111111111111111111111111111111111',
    creatorLinked: true,
    signature: `sig-${o.id}`,
    slot: 100,
    blockTimeMs: NOW - HOUR,
    amount: null,
    reasons: [`${o.type} (test)`],
    evidence: [],
    confidence: 0.95,
    ...o,
  };
}

function sources(repo: Repository, intel: IntelRepository): DecisionSources {
  return {
    intel,
    marketHistory: (mint, since) => repo.marketHistory(mint, { since }),
    holderHistory: (mint, since) => repo.holderHistory(mint, { since }),
  };
}

describe('verdict transitions and policy versions', () => {
  test('18. a material verdict change is persisted with its reasons, components and policy', () => {
    const h = harness();
    // First assessment: thin coverage, WATCH.
    const first = token({ coverage: 0.5 });
    first.at = NOW - 30 * MIN;
    const watch = run(first, bundle(first)).snapshot;
    assert.equal(watch.evaluation!.eligibility, 'WATCH');
    h.repo.saveTokenSnapshot(watch);
    // Then the evidence fills in: QUALIFIED or better.
    const second = token();
    const better = run(second, bundle(second)).snapshot;
    h.repo.saveTokenSnapshot(better);

    const transitions = h.repo.verdictTransitions({ mint: MINT });
    assert.equal(transitions.length, 2);
    const [latest, initial] = transitions;
    assert.equal(initial!.from, null);
    assert.equal(initial!.to, 'WATCH');
    assert.equal(latest!.from, 'WATCH');
    assert.equal(latest!.to, better.evaluation!.eligibility);
    assert.equal(latest!.policyVersion, 'decision-policy@2');
    assert.ok(latest!.reasons.length > 0);
    assert.ok(latest!.basis.length > 0);
    assert.equal(typeof (latest!.components as { rank: number }).rank, 'number');
    assert.equal(latest!.models.integrity, 'integrity@1');

    // The Changes surface reads the same record.
    const change = h.repo.verdictChanges({ mint: MINT })[0]!;
    assert.equal(change.from, 'WATCH');
    assert.equal(change.policyVersion, 'decision-policy@2');
    assert.equal(change.basis, latest!.basis);

    // An unchanged verdict writes no transition.
    const again = token();
    again.at = NOW + 40 * MIN;
    h.repo.saveTokenSnapshot(run(again, bundle(again)).snapshot);
    assert.equal(h.repo.verdictTransitions({ mint: MINT }).length, 2);
    h.close();
  });

  test('20. every stored snapshot names the policy and carries the model outputs', () => {
    const h = harness();
    const t = token();
    const { snapshot } = run(t, bundle(t));
    h.repo.saveTokenSnapshot(snapshot);
    const row = h.db.prepare('SELECT policy_version, rank_score, integrity_score, integrity_band, opportunity_score, momentum_state, decision_coverage FROM token_snapshots WHERE mint = ?').get(MINT) as Record<string, unknown>;
    assert.equal(row.policy_version, 'decision-policy@2');
    assert.equal(row.rank_score, snapshot.decision!.rankScore);
    assert.equal(row.integrity_band, snapshot.decision!.integrity.band);
    assert.equal(row.momentum_state, snapshot.decision!.momentum.state);
    assert.equal(typeof row.opportunity_score, 'number');
    assert.equal(typeof row.decision_coverage, 'number');
    h.close();
  });

  test('19. transitions, decisions and superseded findings survive a restart', () => {
    const dir = tempDir();
    const path = join(dir, 'token-finder.sqlite');
    {
      const opened = openDatabase({ path });
      const repo = new Repository(opened.db!);
      const intel = new IntelRepository(opened.db!);
      const t = token();
      repo.saveTokenSnapshot(run(t, bundle(t)).snapshot);
      intel.saveSecurityEvents([securityEvent({ id: 'old', type: 'LIQUIDITY_DRAIN', status: 'CONFIRMED' })], NOW - 2 * HOUR);
      intel.saveSecurityEvents([], NOW - HOUR, { mint: MINT, ruleVersion: RULE_VERSIONS.security, sweep: true });
      opened.db!.close();
    }
    const reopened = openDatabase({ path });
    const repo = new Repository(reopened.db!);
    const intel = new IntelRepository(reopened.db!);
    assert.equal(reopened.applied.length, 0, 'no migration re-ran');
    const stored = repo.allTokens()[0]!;
    assert.equal(stored.decision?.policyVersion, 'decision-policy@2');
    assert.equal(repo.verdictTransitions({ mint: MINT }).length, 1);
    const events = intel.storedEventsOf([MINT]);
    assert.equal(events.length, 1);
    assert.notEqual(events[0]!.supersededAt, null);
    assert.equal(intel.eventRevisionsOf(MINT).length, 1);
    reopened.db!.close();
  });
});

describe('rule-versioned security events', () => {
  test('10 (storage). an obsolete-rule finding is superseded, archived, and stops being evidence', () => {
    const h = harness();
    const intel = new IntelRepository(h.db);
    // Written the way Phase 2 wrote it: no rule version.
    intel.saveSecurityEvents([securityEvent({ id: 'drain', type: 'LIQUIDITY_DRAIN', status: 'CONFIRMED' })], NOW - 3 * HOUR);
    assert.equal(intel.storedEventsOf([MINT])[0]!.ruleVersion, null);

    // A re-analysis under the current rule does not re-detect it.
    const result = intel.saveSecurityEvents([], NOW - HOUR, { mint: MINT, ruleVersion: RULE_VERSIONS.security, sweep: true });
    assert.deepEqual(result, { reinterpreted: 0, superseded: 1 });
    const stored = intel.storedEventsOf([MINT]);
    assert.equal(stored.length, 1, 'kept, not deleted');
    assert.equal(stored[0]!.supersededBy, RULE_VERSIONS.security);
    assert.equal(intel.activeEventsOf([MINT], RULE_VERSIONS.security).length, 0);
    const revisions = intel.eventRevisionsOf(MINT);
    assert.equal(revisions[0]!.change, 'SUPERSEDED');
    assert.equal(revisions[0]!.status, 'CONFIRMED');

    // And the decision stage, reading the real database, does not reject on it.
    const t = token();
    intel.saveTokenIntelligence({ mint: MINT, ...intelRow(), analyzedAt: NOW - 10 * MIN });
    const decide = makeDecider(sources(h.repo, intel), CONFIG, () => NOW);
    const decided = decide(t, null);
    assert.equal(decided.decision!.hardFails.length, 0);
    assert.notEqual(decided.evaluation!.eligibility, 'REJECTED');
    h.close();
  });

  test('a newer rule may weaken a finding; the same rule may not', () => {
    const h = harness();
    const intel = new IntelRepository(h.db);
    intel.saveSecurityEvents([securityEvent({ id: 'e1', type: 'FREEZE_ABUSE', status: 'CONFIRMED' })], NOW - 3 * HOUR, { mint: MINT, ruleVersion: 'security-events@0' });
    // Re-detected under the current rule as only suspicious: the current reading wins.
    const r = intel.saveSecurityEvents([securityEvent({ id: 'e1', type: 'FREEZE_ABUSE', status: 'SUSPICIOUS' })], NOW - 2 * HOUR, { mint: MINT, ruleVersion: RULE_VERSIONS.security, sweep: true });
    assert.deepEqual(r, { reinterpreted: 1, superseded: 0 });
    assert.equal(intel.storedEventsOf([MINT])[0]!.status, 'SUSPICIOUS');
    assert.equal(intel.eventRevisionsOf(MINT)[0]!.change, 'REINTERPRETED');
    // Under the same rule a later, weaker read never lowers it.
    intel.saveSecurityEvents([securityEvent({ id: 'e1', type: 'FREEZE_ABUSE', status: 'CONFIRMED' })], NOW - HOUR, { mint: MINT, ruleVersion: RULE_VERSIONS.security, sweep: true });
    intel.saveSecurityEvents([securityEvent({ id: 'e1', type: 'FREEZE_ABUSE', status: 'SUSPICIOUS' })], NOW, { mint: MINT, ruleVersion: RULE_VERSIONS.security, sweep: true });
    assert.equal(intel.storedEventsOf([MINT])[0]!.status, 'CONFIRMED');
    h.close();
  });

  test('a current-rule CONFIRMED drain in the database rejects through the real decision stage', () => {
    const h = harness();
    const intel = new IntelRepository(h.db);
    intel.saveSecurityEvents([securityEvent({ id: 'rug', type: 'LIQUIDITY_DRAIN', status: 'CONFIRMED' })], NOW - HOUR, { mint: MINT, ruleVersion: RULE_VERSIONS.security, sweep: true });
    intel.saveTokenIntelligence({ mint: MINT, ...intelRow(), analyzedAt: NOW - 10 * MIN });
    const decided = makeDecider(sources(h.repo, intel), CONFIG, () => NOW)(token(), 'QUALIFIED');
    assert.equal(decided.evaluation!.eligibility, 'REJECTED');
    assert.equal(decided.evaluation!.state, 'REJECTED');
    assert.equal(decided.evaluation!.previousState, 'QUALIFIED');
    assert.equal(decided.decision!.hardFails[0]!.code, 'CONFIRMED_CURRENT_RUG');
    h.close();
  });

  test('migration 4 on a v3 database leaves existing events unversioned, never trusted as current', () => {
    const dir = tempDir();
    const opened = openDatabase({ path: join(dir, 'v3.sqlite'), migrateSchema: false });
    const db = opened.db!;
    // Build a real v3 database, then write an event the way Phase 2 did.
    db.exec('PRAGMA user_version = 0');
    for (const m of MIGRATIONS.filter((x) => x.to <= 3)) {
      db.exec('BEGIN');
      for (const s of m.statements) db.exec(s);
      db.exec(`PRAGMA user_version = ${m.to}`);
      db.exec('COMMIT');
    }
    db.prepare(
      `INSERT INTO security_events (id, mint, type, status, actor, creator_linked, signature, slot, block_time, amount, reasons, evidence, confidence, detected_at)
       VALUES ('legacy', ?, 'LIQUIDITY_DRAIN', 'CONFIRMED', NULL, 1, 'sig', 1, NULL, NULL, '[]', '[]', 0.95, 1)`,
    ).run(MINT);
    assert.deepEqual(migrate(db), [4]);
    const intel = new IntelRepository(db);
    const [e] = intel.storedEventsOf([MINT]);
    assert.equal(e!.ruleVersion, null);
    assert.equal(intel.activeEventsOf([MINT], RULE_VERSIONS.security).length, 0);
    db.close();
  });
});

describe('decision inputs from the database', () => {
  test('momentum reads the stored market history, and the intelligence contract the stored rows', () => {
    const h = harness();
    const intel = new IntelRepository(h.db);
    const series = steadyRise(150, 15);
    for (const p of series) {
      const s = token();
      s.at = p.t;
      s.priceUsd = p.price;
      h.repo.saveTokenSnapshot(s);
    }
    const src = sources(h.repo, intel);
    const observed = gatherHistory(src, MINT, NOW);
    // Exactly what the snapshot policy chose to store - sub-threshold moves
    // are not rows - and nothing interpolated between them.
    const stored = h.repo.marketHistory(MINT);
    assert.ok(observed.length >= 3 && observed.length <= series.length);
    assert.deepEqual(observed.map((p) => p.price), stored.map((p) => p.priceUsd));
    assert.deepEqual(observed.map((p) => p.t), stored.map((p) => p.observedAt));

    // Nothing analysed yet: every deep domain is UNAVAILABLE.
    const empty = gatherIntelligence(src, token(), NOW);
    assert.equal(empty.activity.status, 'UNAVAILABLE');
    assert.equal(empty.coverage, 0);
    intel.saveTokenIntelligence({ mint: MINT, ...intelRow(), analyzedAt: NOW - 5 * MIN });
    const full = gatherIntelligence(src, token(), NOW);
    assert.equal(full.activity.status, 'AVAILABLE');
    assert.ok(full.coverage > 0.8);
    h.close();
  });
});
