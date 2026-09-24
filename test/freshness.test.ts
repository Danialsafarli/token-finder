/**
 * Freshness-aware safety resolution.
 *
 * The case this exists for: a stale RugCheck report saying "mint authority
 * still enabled" must not veto a token that a current on-chain read says is
 * revoked - while the disagreement still stays on the record.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, isUsable, type Claim } from '../src/core/evidence.ts';
import { resolveEvidence } from '../src/core/resolve.ts';
import { evaluateGate, evaluateRugcheckGate } from '../src/core/gate.ts';
import { normalizePair } from '../src/sources/dexscreener.ts';
import { normalizeToken } from '../src/sources/jupiter.ts';
import { normalizeSummary } from '../src/sources/rugcheck.ts';
import { fixtureByName, legacyOnchain } from './fixtures.ts';
import type { JupiterInfo, OnChainInfo, RugcheckInfo } from '../src/types.ts';

const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Authority windows: FRESH <= 24h, AGING <= 7d, STALE beyond. */
const FRESH_AT = NOW - 1 * HOUR;
const AGING_AT = NOW - 3 * DAY;
const STALE_AT = NOW - 30 * DAY;

/** `true` = revoked (safe); `false` = live (dangerous). */
const authority = (provider: string, value: boolean, observedAt: number): Claim<boolean> => ({
  provider,
  value,
  observedAt,
});

const resolveAuthority = (claims: Claim<boolean>[]) =>
  resolve<boolean>(claims, {
    metric: 'mintAuthorityRevoked',
    now: NOW,
    resolveConflict: (list) => {
      const dangerous = list.findIndex((claim) => claim.value === false);
      return dangerous === -1 ? 0 : dangerous;
    },
    precedence: ['helius'],
  });

describe('the freshness conflict matrix', () => {
  test('FRESH safe + STALE dangerous -> safe, conflict preserved', () => {
    const out = resolveAuthority([
      authority('helius', true, FRESH_AT),
      authority('rugcheck', false, STALE_AT),
    ]);

    assert.equal(out.value, true, 'the current reading decides');
    assert.equal(isUsable(out), true);
    assert.equal(out.source, 'helius');
    assert.equal(out.overridden.length, 1, 'the stale danger is retained, not discarded');
    assert.equal(out.overridden[0]?.provider, 'rugcheck');
    assert.equal(out.overridden[0]?.freshness, 'STALE');
  });

  test('FRESH dangerous + STALE safe -> dangerous', () => {
    const out = resolveAuthority([
      authority('rugcheck', false, FRESH_AT),
      authority('jupiter', true, STALE_AT),
    ]);

    assert.equal(out.value, false, 'a current danger still governs');
    assert.equal(out.overridden.some((claim) => claim.provider === 'jupiter'), true);
  });

  test('FRESH vs FRESH contradiction -> CONFLICTED, on-chain takes precedence', () => {
    const out = resolveAuthority([
      authority('rugcheck', false, FRESH_AT),
      authority('helius', true, FRESH_AT),
    ]);

    assert.equal(out.state, 'CONFLICTED', 'a live disagreement is a conflict, not a quiet pick');
    assert.equal(out.value, true, 'authority is an on-chain fact; the direct read wins');
    assert.equal(out.source, 'helius');
    assert.equal(out.claims.length, 2, 'both claims are kept');
    assert.ok(out.confidence < 1, 'disagreement costs confidence');
  });

  test('FRESH vs FRESH contradiction without on-chain -> conservative, danger wins', () => {
    const out = resolveAuthority([
      authority('jupiter', true, FRESH_AT),
      authority('rugcheck', false, FRESH_AT),
    ]);

    assert.equal(out.state, 'CONFLICTED');
    assert.equal(out.value, false, 'with no chain read, the dangerous claim still governs');
  });

  test('STALE vs STALE -> STALE, nothing usable', () => {
    const out = resolveAuthority([
      authority('rugcheck', false, STALE_AT),
      authority('jupiter', true, STALE_AT),
    ]);

    assert.equal(out.state, 'STALE');
    assert.equal(out.value, null);
    assert.equal(isUsable(out), false);
    assert.match(out.notes.join(' '), /older than/);
  });

  test('UNKNOWN vs FRESH -> the fresh claim, no conflict', () => {
    const out = resolveAuthority([authority('helius', true, FRESH_AT)]);
    assert.equal(out.state, 'MEASURED');
    assert.equal(out.value, true);
    assert.deepEqual(out.overridden, []);
  });

  test('INVALID vs FRESH -> the fresh claim wins, the rejection is noted', () => {
    const out = resolveAuthority([
      { provider: 'jupiter', value: null, observedAt: FRESH_AT, invalid: 'expected boolean, got string' },
      authority('helius', true, FRESH_AT),
    ]);

    assert.equal(out.state, 'MEASURED');
    assert.equal(out.value, true);
    assert.match(out.notes.join(' '), /rejected/);
  });

  test('INVALID alone is INVALID, never UNKNOWN and never safe', () => {
    const out = resolveAuthority([
      { provider: 'jupiter', value: null, observedAt: FRESH_AT, invalid: 'expected boolean, got string' },
    ]);
    assert.equal(out.state, 'INVALID');
    assert.equal(isUsable(out), false);
  });

  test('AGING evidence still decides, at reduced confidence', () => {
    const fresh = resolveAuthority([authority('helius', true, FRESH_AT)]);
    const aging = resolveAuthority([authority('helius', true, AGING_AT)]);

    assert.equal(aging.state, 'MEASURED');
    assert.equal(aging.freshness, 'AGING');
    assert.ok(aging.confidence < fresh.confidence);
  });

  test('freshness is per claim: one stale source cannot drag a fresh fact to STALE', () => {
    const out = resolveAuthority([
      authority('rugcheck', false, STALE_AT),
      authority('jupiter', true, FRESH_AT),
    ]);
    assert.notEqual(out.state, 'STALE', 'the current claim still stands');
    assert.equal(out.value, true);
  });
});

describe('the stale-danger scenario end to end', () => {
  const healthy = fixtureByName('healthy-established');

  function build(options: {
    rugcheckAt: number;
    onchainAt: number;
    withOnchain: boolean;
  }) {
    const rugcheck: RugcheckInfo = normalizeSummary({
      score: 900,
      score_normalised: 55,
      risks: [
        {
          name: 'Mint Authority still enabled',
          level: 'danger',
          description: 'More tokens can be minted by the owner',
          score: 900,
        },
      ],
    } as never);

    const jupiter: JupiterInfo = normalizeToken({
      ...(healthy.jupiter as object),
      audit: {
        mintAuthorityDisabled: null,
        freezeAuthorityDisabled: null,
        topHoldersPercentage: 18,
        devBalancePercentage: 1,
      },
    } as never);

    const onchain: OnChainInfo | null = options.withOnchain
      ? legacyOnchain()
      : null;

    return resolveEvidence({
      pairs: [normalizePair(healthy.dexPairs[0] as never)],
      jupiter,
      rugcheck,
      onchain,
      observedAt: {
        dexscreener: NOW,
        jupiter: NOW,
        rugcheck: options.rugcheckAt,
        onchain: options.onchainAt,
      },
      heliusConfigured: options.withOnchain,
      now: NOW,
    });
  }

  test('stale RugCheck danger + fresh on-chain revoked -> not vetoed', () => {
    const evidence = build({ rugcheckAt: STALE_AT, onchainAt: FRESH_AT, withOnchain: true });
    const vetoes = evaluateGate(evidence);

    assert.equal(evidence.mintAuthorityRevoked.value, true, 'effective state is revoked');
    assert.equal(
      vetoes.some((veto) => veto.code === 'AUTHORITY_MINT_ACTIVE'),
      false,
      'a week-old report must not veto a token the chain says is safe',
    );
  });

  test('...but the disagreement is still on the record', () => {
    const evidence = build({ rugcheckAt: STALE_AT, onchainAt: FRESH_AT, withOnchain: true });

    assert.equal(evidence.historicalDangerEvidence, true);
    assert.equal(evidence.mintAuthorityRevoked.overridden.length > 0, true);
    assert.equal(evidence.mintAuthorityRevoked.overridden[0]?.value, false);
  });

  test('fresh RugCheck danger + fresh on-chain revoked -> conflict, on-chain governs', () => {
    const evidence = build({ rugcheckAt: FRESH_AT, onchainAt: FRESH_AT, withOnchain: true });

    assert.equal(evidence.mintAuthorityRevoked.state, 'CONFLICTED');
    assert.equal(evidence.mintAuthorityRevoked.value, true);
    assert.ok(evidence.conflicts.includes('mintAuthorityRevoked'));
    assert.equal(
      evaluateGate(evidence).some((veto) => veto.code === 'AUTHORITY_MINT_ACTIVE'),
      false,
    );
  });

  test('keyless mode is unchanged: RugCheck danger with no chain read still vetoes', () => {
    const evidence = build({ rugcheckAt: FRESH_AT, onchainAt: FRESH_AT, withOnchain: false });

    assert.equal(evidence.mintAuthorityRevoked.value, false);
    assert.ok(evaluateGate(evidence).some((veto) => veto.code === 'AUTHORITY_MINT_ACTIVE'));
  });

  test('a stale danger with no fresher source does not veto either', () => {
    // Nothing current says anything, so the fact is STALE and unusable. A veto
    // needs a current assertion, not an old one.
    const evidence = build({ rugcheckAt: STALE_AT, onchainAt: STALE_AT, withOnchain: false });

    assert.equal(evidence.mintAuthorityRevoked.state, 'STALE');
    assert.equal(
      evaluateGate(evidence).some((veto) => veto.code === 'AUTHORITY_MINT_ACTIVE'),
      false,
      'stale evidence cannot assert a current-state condition',
    );
  });
});

describe('veto nature: current-state versus historical', () => {
  test('every current-state veto declares itself as such', () => {
    const evidence = resolveEvidence({
      pairs: [],
      jupiter: normalizeToken({
        ...(fixtureByName('healthy-established').jupiter as object),
        audit: {
          mintAuthorityDisabled: false,
          freezeAuthorityDisabled: false,
          topHoldersPercentage: 95,
          devBalancePercentage: 1,
        },
      } as never),
      rugcheck: null,
      onchain: null,
      observedAt: { dexscreener: NOW, jupiter: NOW, rugcheck: NOW, onchain: NOW },
      heliusConfigured: false,
      now: NOW,
    });

    const vetoes = evaluateGate(evidence);
    assert.ok(vetoes.length >= 2);
    for (const veto of vetoes) {
      assert.equal(veto.nature, 'current-state', `${veto.code} describes the present`);
      assert.equal(veto.recheckable, true, 'the present can change');
    }
  });

  test('a historical veto fires on stale evidence, because history does not expire', () => {
    const vetoes = evaluateRugcheckGate(
      [
        {
          name: 'Creator history of rugged tokens',
          level: 'danger',
          description: 'This creator has rugged before',
        },
      ],
      STALE_AT,
    );

    assert.equal(vetoes.length, 1);
    assert.equal(vetoes[0]?.nature, 'historical');
    assert.equal(vetoes[0]?.recheckable, false);
    assert.equal(vetoes[0]?.at, STALE_AT, 'the age is recorded, not used to dismiss it');
  });

  test('an old authority reading is not treated as a current fact', () => {
    const stale = resolveAuthority([authority('rugcheck', false, STALE_AT)]);
    assert.equal(stale.state, 'STALE');

    const evidence = resolveEvidence({
      pairs: [normalizePair(fixtureByName('healthy-established').dexPairs[0] as never)],
      jupiter: normalizeToken({
        ...(fixtureByName('healthy-established').jupiter as object),
        audit: {
          mintAuthorityDisabled: false,
          freezeAuthorityDisabled: true,
          topHoldersPercentage: 18,
          devBalancePercentage: 1,
        },
      } as never),
      rugcheck: null,
      onchain: null,
      observedAt: { dexscreener: NOW, jupiter: STALE_AT, rugcheck: NOW, onchain: NOW },
      heliusConfigured: false,
      now: NOW,
    });

    assert.equal(evidence.mintAuthorityRevoked.state, 'STALE');
    assert.equal(
      evaluateGate(evidence).some((veto) => veto.code === 'AUTHORITY_MINT_ACTIVE'),
      false,
    );
  });
});
