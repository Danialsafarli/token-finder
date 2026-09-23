/**
 * Provider boundary validation.
 *
 * The property under test throughout: a malformed provider field must never
 * become a number that scores. It becomes null plus a recorded issue, and the
 * evidence layer turns that into INVALID - which earns nothing and is counted
 * separately from "we never asked".
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ValidationReport,
  validBoolean,
  validCount,
  validMint,
  validNumber,
  validPercent,
  validPriceChangePct,
  validString,
  validTimestampMs,
  validUsd,
} from '../src/core/validate.ts';
import { normalizePair } from '../src/sources/dexscreener.ts';
import { normalizeToken } from '../src/sources/jupiter.ts';
import { normalizeSummary } from '../src/sources/rugcheck.ts';
import { fixtureByName } from './fixtures.ts';

const report = (): ValidationReport => new ValidationReport('test');

describe('numeric validation', () => {
  test('absent is UNKNOWN (null, no issue); present-but-wrong is INVALID (null, issue)', () => {
    const absent = report();
    assert.equal(validNumber(absent, 'x', undefined), null);
    assert.equal(absent.issues.length, 0, 'absence must not be recorded as a rejection');

    const wrong = report();
    assert.equal(validNumber(wrong, 'x', 'abc'), null);
    assert.equal(wrong.issues.length, 1, 'a bad value must be recorded');
  });

  test('NaN and Infinity are rejected, never propagated', () => {
    const r = report();
    assert.equal(validNumber(r, 'nan', Number.NaN), null);
    assert.equal(validNumber(r, 'inf', Number.POSITIVE_INFINITY), null);
    assert.equal(validNumber(r, 'ninf', Number.NEGATIVE_INFINITY), null);
    assert.equal(r.issues.length, 3);
  });

  test('negative money is impossible, not zero-ish', () => {
    const r = report();
    assert.equal(validUsd(r, 'liquidity', -1), null);
    assert.equal(r.issues[0]?.reason, 'below minimum 0');
    assert.equal(validUsd(r, 'liquidity', 0), 0, 'a genuine zero is still valid');
  });

  test('percentages must sit on 0-100', () => {
    const r = report();
    assert.equal(validPercent(r, 'pct', 150), null);
    assert.equal(validPercent(r, 'pct', -3), null);
    assert.equal(validPercent(r, 'pct', 0), 0);
    assert.equal(validPercent(r, 'pct', 100), 100);
    assert.equal(r.issues.length, 2);
  });

  test('a price change below -100% is impossible', () => {
    const r = report();
    assert.equal(validPriceChangePct(r, 'h1', -140), null);
    assert.equal(validPriceChangePct(r, 'h1', -99.9), -99.9);
    assert.equal(validPriceChangePct(r, 'h1', 4_000), 4_000, 'new tokens do move this much');
  });

  test('counts must be non-negative whole numbers', () => {
    const r = report();
    assert.equal(validCount(r, 'buys', -4), null);
    assert.equal(validCount(r, 'buys', 2.5), null);
    assert.equal(validCount(r, 'buys', 0), 0);
  });

  test('numeric strings are accepted only where a provider actually sends them', () => {
    const permissive = report();
    assert.equal(validUsd(permissive, 'priceUsd', '0.0042'), 0.0042);

    const strict = report();
    assert.equal(validNumber(strict, 'holderCount', '4200'), null);
    assert.equal(strict.issues.length, 1, 'a string count is a shape change, not a value');
  });
});

describe('boolean validation on safety fields', () => {
  test('only real booleans are accepted', () => {
    const r = report();
    assert.equal(validBoolean(r, 'a', true), true);
    assert.equal(validBoolean(r, 'b', false), false);
    assert.equal(validBoolean(r, 'c', null), null, 'null is unknown, not an error');
    assert.equal(r.issues.length, 0);
  });

  test('truthy strings and numbers are rejected rather than coerced', () => {
    const r = report();
    assert.equal(validBoolean(r, 'mint', 'true'), null);
    assert.equal(validBoolean(r, 'mint', 1), null);
    assert.equal(validBoolean(r, 'mint', 0), null);
    assert.equal(r.issues.length, 3, 'guessing here turns a live authority into a revoked one');
  });
});

describe('timestamp validation', () => {
  test('impossible times are rejected so age can never be negative', () => {
    const r = report();
    assert.equal(validTimestampMs(r, 'created', Date.now() + 86_400_000), null, 'future');
    assert.equal(validTimestampMs(r, 'created', 946_684_800_000), null, 'before Solana existed');
    assert.equal(r.issues.length, 2);
  });

  test('seconds and milliseconds are both understood', () => {
    const r = report();
    const seconds = Math.floor((Date.now() - 3_600_000) / 1000);
    const asMs = validTimestampMs(r, 'created', seconds);
    assert.ok(asMs !== null && Math.abs(asMs - seconds * 1000) < 2);
    assert.equal(r.issues.length, 0);
  });

  test('ISO strings parse, gibberish does not', () => {
    const r = report();
    assert.ok(validTimestampMs(r, 'created', new Date(Date.now() - 1000).toISOString()) !== null);
    assert.equal(validTimestampMs(r, 'created', 'last tuesday'), null);
  });
});

describe('address and string validation', () => {
  test('an authority must look like a Solana address', () => {
    const r = report();
    assert.equal(validMint(r, 'auth', 'So11111111111111111111111111111111111111112')?.length, 43);
    assert.equal(validMint(r, 'auth', 'not-an-address'), null);
    assert.equal(validMint(r, 'auth', '0x1234'), null);
  });

  test('strings are truncated rather than trusted for length', () => {
    const r = report();
    assert.equal(validString(r, 's', 'x'.repeat(500), { maxLength: 40 })?.length, 40);
    assert.equal(validString(r, 's', 12345), null);
  });
});

describe('DexScreener boundary', () => {
  test('a healthy pair validates with no issues', () => {
    const pair = normalizePair(fixtureByName('healthy-established').dexPairs[0] as never);
    assert.deepEqual(pair.issues, []);
    assert.equal(pair.liquidityUsd, 250_000);
    assert.equal(pair.priceUsd, 0.0042);
  });

  test('malformed fields are rejected individually, leaving the rest usable', () => {
    const pair = normalizePair(fixtureByName('malformed-provider-response').dexPairs[0] as never);

    assert.equal(pair.liquidityUsd, null, 'negative liquidity must not become a number');
    assert.equal(pair.priceUsd, null, 'unparseable price must not become a number');
    assert.equal(pair.pairCreatedAt, null, 'a year-3000 timestamp must not become an age');
    assert.equal(pair.volume.h1, null, 'NaN volume');
    assert.equal(pair.volume.h6, null, 'negative volume');
    assert.equal(pair.volume.h24, null, 'string volume');
    assert.equal(pair.txns.h1.buys, null, 'negative buy count');
    assert.equal(pair.txns.h1.sells, null, 'fractional sell count');

    // Untouched fields still come through.
    assert.equal(pair.volume.m5, 0);
    assert.equal(pair.dexId, 'raydium');

    const fields = pair.issues.map((issue) => issue.field);
    for (const expected of ['liquidity.usd', 'priceUsd', 'pairCreatedAt', 'volume.h1', 'txns.h1.buys']) {
      assert.ok(fields.includes(expected), `expected an issue for ${expected}`);
    }
  });

  test('every rejection records what arrived, for the audit trail', () => {
    const pair = normalizePair(fixtureByName('malformed-provider-response').dexPairs[0] as never);
    for (const issue of pair.issues) {
      assert.ok(issue.reason.length > 0);
      assert.ok(issue.received.length > 0);
    }
  });
});

describe('Jupiter boundary', () => {
  test('a string in a safety boolean is rejected, not coerced to true', () => {
    const jup = normalizeToken(fixtureByName('malformed-provider-response').jupiter as never);
    assert.equal(jup.audit.mintAuthorityDisabled, null);
    assert.equal(jup.audit.freezeAuthorityDisabled, null);
    const fields = jup.issues.map((issue) => issue.field);
    assert.ok(fields.includes('audit.mintAuthorityDisabled'));
    assert.ok(fields.includes('audit.freezeAuthorityDisabled'));
  });

  test('out-of-range percentages and scores are rejected', () => {
    const jup = normalizeToken(fixtureByName('malformed-provider-response').jupiter as never);
    assert.equal(jup.audit.topHoldersPercentage, null, '150% is impossible');
    assert.equal(jup.audit.devBalancePercentage, null, '-3% is impossible');
    assert.equal(jup.organicScore, null, '900 is outside 0-100');
    assert.equal(jup.holderCount, null, '12.5 wallets is impossible');
  });

  test('a healthy record validates cleanly', () => {
    const jup = normalizeToken(fixtureByName('healthy-established').jupiter as never);
    assert.deepEqual(jup.issues, []);
    assert.equal(jup.audit.mintAuthorityDisabled, true);
    assert.equal(jup.holderCount, 4_200);
  });

  test('a missing token record does not invent fields', () => {
    const jup = normalizeToken({} as never);
    assert.equal(jup.holderCount, null);
    assert.equal(jup.audit.mintAuthorityDisabled, null);
    assert.equal(jup.isVerified, false);
    assert.deepEqual(jup.issues, []);
  });
});

describe('RugCheck boundary', () => {
  test('a non-array risks field yields no risks rather than throwing', () => {
    const rug = normalizeSummary(fixtureByName('malformed-provider-response').rugcheck as never);
    assert.deepEqual(rug.risks, []);
    assert.equal(rug.scoreNormalised, null, 'a string score is rejected');
  });

  test('an unrecognised severity is dropped, not downgraded to info', () => {
    const rug = normalizeSummary({
      score: 10,
      score_normalised: 5,
      risks: [{ name: 'Something New', level: 'catastrophic', description: '', score: 1 }],
    } as never);
    assert.equal(rug.risks.length, 0);
    assert.ok(rug.issues.some((issue) => issue.reason === 'unrecognised severity'));
  });

  test('documented severities pass through intact', () => {
    const rug = normalizeSummary({
      score: 900,
      score_normalised: 55,
      risks: [{ name: 'Mint Authority still enabled', level: 'danger', description: 'x', score: 900 }],
    } as never);
    assert.equal(rug.risks.length, 1);
    assert.equal(rug.risks[0]?.level, 'danger');
  });
});
