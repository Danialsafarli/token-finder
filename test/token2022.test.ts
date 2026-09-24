/**
 * Token-2022 extension awareness and exact holder math.
 *
 * Two defects motivate this file, and both were *false-safe*: they made a token
 * look better than the chain says it is.
 *
 * 1. Nothing read the mint's owning program or its extensions. A Token-2022
 *    mint can revoke mint and freeze authority - scoring full marks on both
 *    safety inputs - while a permanent delegate retains the power to transfer
 *    or burn from any wallet holding it.
 * 2. `decimals` was bounded to 0-18 though SPL stores it as a `u8`. A mint
 *    outside that range had its decimals rejected, after which supply stayed in
 *    raw base units while holder balances were read in UI units. The resulting
 *    concentration ratio came out near zero: an unmeasurable token read as
 *    perfectly distributed.
 *
 * Every test here therefore checks a *direction* as well as a value. Where a
 * reading is uncertain the assertion is that it did not become safe.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMint } from '../src/sources/helius.ts';
import { evaluateExtensionGate, evaluateMalformedGate } from '../src/core/gate.ts';
import { resolveEvidence } from '../src/core/resolve.ts';
import {
  EXTENSION_RULES,
  LEGACY_SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TRANSFER_FEE_VETO_BPS,
} from '../src/core/token-program.ts';
import { exactRatio } from '../src/util/num.ts';
import type { OnChainInfo, VetoCode } from '../src/types.ts';

const DELEGATE = '4SnSuUtJGKvk2GYpBwmEsWG53zTurVM8yXGsoiZQyMJn';
const HOOK_PROGRAM = 'GFMniFoE5X4F87L9jzjHaW4MTkXyX1AYHNfhFencgamg';

/** Builds a jsonParsed getAccountInfo payload for a mint. */
function mintAccount(options: {
  owner?: string;
  space?: number;
  decimals?: unknown;
  supply?: unknown;
  extensions?: unknown;
  mintAuthority?: unknown;
  freezeAuthority?: unknown;
}): Parameters<typeof parseMint>[0] {
  const info: Record<string, unknown> = {
    mintAuthority: options.mintAuthority ?? null,
    freezeAuthority: options.freezeAuthority ?? null,
    decimals: options.decimals ?? 9,
    supply: options.supply ?? '1000000000000000',
  };
  if (options.extensions !== undefined) info['extensions'] = options.extensions;

  return {
    value: {
      owner: options.owner ?? LEGACY_SPL_TOKEN_PROGRAM_ID,
      space: options.space ?? 82,
      data: { parsed: { info } },
    },
  } as Parameters<typeof parseMint>[0];
}

/** Builds a getTokenLargestAccounts payload from raw base-unit amounts. */
function largestAccounts(...amounts: unknown[]): Parameters<typeof parseMint>[1] {
  return {
    value: amounts.map((amount, index) => ({
      address: `holder${index}`,
      amount,
      uiAmount: null,
    })),
  } as Parameters<typeof parseMint>[1];
}

/** A Token-2022 mint account carrying the given extension entries. */
function t22(extensions: unknown[], overrides: Parameters<typeof mintAccount>[0] = {}) {
  return mintAccount({
    owner: TOKEN_2022_PROGRAM_ID,
    // Any extension makes the account larger than a bare 82-byte mint.
    space: 300,
    extensions,
    ...overrides,
  });
}

/** Runs the extension gate over a parsed mint, as the pipeline would. */
function gateFor(onchain: OnChainInfo, now = Date.now()): VetoCode[] {
  const evidence = resolveEvidence({
    pairs: [],
    jupiter: null,
    rugcheck: null,
    onchain,
    observedAt: { dexscreener: now, jupiter: now, rugcheck: now, onchain: now },
    heliusConfigured: true,
    now,
  });
  return evaluateExtensionGate(evidence).map((veto) => veto.code);
}

// ---------------------------------------------------------------------------
// Token program identity
// ---------------------------------------------------------------------------

describe('token program identity', () => {
  test('a legacy SPL mint is identified from its owner program', () => {
    const parsed = parseMint(mintAccount({}), largestAccounts(), false);
    assert.equal(parsed.tokenProgram, 'LEGACY_SPL_TOKEN');
    assert.equal(parsed.programId, LEGACY_SPL_TOKEN_PROGRAM_ID);
  });

  test('a Token-2022 mint is identified from its owner program', () => {
    const parsed = parseMint(t22([]), largestAccounts(), false);
    assert.equal(parsed.tokenProgram, 'TOKEN_2022');
  });

  test('the program is never inferred from whether extensions were found', () => {
    // A Token-2022 mint with no extensions must still read as TOKEN_2022. If
    // the program were inferred from extension presence it would be
    // indistinguishable from a legacy mint here.
    const parsed = parseMint(
      mintAccount({ owner: TOKEN_2022_PROGRAM_ID, space: 82, extensions: [] }),
      largestAccounts(),
      false,
    );
    assert.equal(parsed.tokenProgram, 'TOKEN_2022');
    assert.deepEqual(parsed.extensions, []);
  });

  test('an unrecognised owner program is UNKNOWN, not assumed legacy', () => {
    const parsed = parseMint(mintAccount({ owner: HOOK_PROGRAM }), largestAccounts(), false);
    assert.equal(parsed.tokenProgram, 'UNKNOWN');
    assert.equal(parsed.extensions, null);
    assert.equal(parsed.extensionsComplete, false);
  });

  test('a malformed owner program is rejected and gates the token', () => {
    const parsed = parseMint(mintAccount({ owner: 'not-an-address!' }), largestAccounts(), false);
    assert.equal(parsed.programId, null);
    assert.ok(parsed.issues.some((issue) => issue.field === 'programId'));
    // The owner decides how every other field is read, so an unreadable one is
    // a structural failure rather than a missing nicety.
    assert.equal(evaluateMalformedGate(parsed.issues, Date.now()).length, 1);
  });

  test('a missing account leaves the program unknown rather than legacy', () => {
    const parsed = parseMint(null, largestAccounts('1'), false);
    assert.equal(parsed.tokenProgram, 'UNKNOWN');
    assert.equal(parsed.extensions, null);
  });
});

// ---------------------------------------------------------------------------
// Extension parsing and completeness
// ---------------------------------------------------------------------------

describe('extension completeness', () => {
  test('a legacy mint reports extensions measured-and-empty, not unknown', () => {
    const parsed = parseMint(mintAccount({}), largestAccounts(), false);
    assert.deepEqual(parsed.extensions, []);
    // Structural: the legacy program has no extension mechanism, so this is a
    // fact about the program rather than a read that came back short.
    assert.equal(parsed.extensionsComplete, true);
  });

  test('a bare Token-2022 mint with no extensions is a complete read', () => {
    const parsed = parseMint(
      mintAccount({ owner: TOKEN_2022_PROGRAM_ID, space: 82, extensions: [] }),
      largestAccounts(),
      false,
    );
    assert.equal(parsed.extensionsComplete, true);
  });

  test('an empty extension list on an extended account is an INCOMPLETE read', () => {
    // Agave before 4.2 returned "extensions": [] when it met a single
    // extension type it did not recognise, hiding every extension on the mint.
    // Account size is the discriminator: 300 bytes cannot be a bare mint.
    const parsed = parseMint(t22([], { space: 300 }), largestAccounts(), false);
    assert.deepEqual(parsed.extensions, []);
    assert.equal(parsed.extensionsComplete, false);
  });

  test('a missing extensions field on an extended account is incomplete', () => {
    const parsed = parseMint(
      mintAccount({ owner: TOKEN_2022_PROGRAM_ID, space: 300 }),
      largestAccounts(),
      false,
    );
    assert.equal(parsed.extensions, null);
    assert.equal(parsed.extensionsComplete, false);
  });

  test('an unparseableExtension marker makes the read incomplete without throwing', () => {
    const parsed = parseMint(
      t22([{ extension: 'unparseableExtension' }, { extension: 'metadataPointer', state: {} }]),
      largestAccounts(),
      false,
    );
    assert.equal(parsed.extensionsComplete, false);
    assert.equal(parsed.extensions?.length, 2);
    assert.equal(parsed.extensions?.[0]?.policy, 'UNKNOWN_POLICY');
  });

  test('an extension name this build does not know is recorded, not skipped', () => {
    const parsed = parseMint(
      t22([{ extension: 'someFutureExtension', state: { authority: DELEGATE } }]),
      largestAccounts(),
      false,
    );
    assert.equal(parsed.extensionsComplete, false);
    assert.equal(parsed.extensions?.[0]?.id, 'someFutureExtension');
    assert.equal(parsed.extensions?.[0]?.policy, 'UNKNOWN_POLICY');
    // Unknown never vetoes - but it also never counts as coverage.
    assert.deepEqual(gateFor(parsed), []);
  });

  test('an incomplete read leaves extension evidence UNKNOWN, not measured empty', () => {
    const partial = parseMint(t22([], { space: 300 }), largestAccounts(), false);
    const now = Date.now();
    const evidence = resolveEvidence({
      pairs: [],
      jupiter: null,
      rugcheck: null,
      onchain: partial,
      observedAt: { dexscreener: now, jupiter: now, rugcheck: now, onchain: now },
      heliusConfigured: true,
      now,
    });
    assert.equal(evidence.mintExtensions.state, 'UNKNOWN');
    assert.equal(evidence.mintExtensionsComplete, false);
  });

  test('a complete read of a legacy mint measures extension evidence', () => {
    const parsed = parseMint(mintAccount({}), largestAccounts(), false);
    const now = Date.now();
    const evidence = resolveEvidence({
      pairs: [],
      jupiter: null,
      rugcheck: null,
      onchain: parsed,
      observedAt: { dexscreener: now, jupiter: now, rugcheck: now, onchain: now },
      heliusConfigured: true,
      now,
    });
    assert.equal(evidence.mintExtensions.state, 'MEASURED');
    assert.deepEqual(evidence.mintExtensions.value, []);
    assert.equal(evidence.tokenProgram.value, 'LEGACY_SPL_TOKEN');
  });
});

// ---------------------------------------------------------------------------
// Permanent delegate - the semantics this whole phase turned on
// ---------------------------------------------------------------------------

describe('permanent delegate', () => {
  test('an armed permanent delegate vetoes even with both authorities revoked', () => {
    const parsed = parseMint(
      t22([{ extension: 'permanentDelegate', state: { delegate: DELEGATE } }], {
        mintAuthority: null,
        freezeAuthority: null,
      }),
      largestAccounts('1'),
      false,
    );
    // This is the exact shape that used to score as a clean token.
    assert.equal(parsed.mintAuthority, null);
    assert.equal(parsed.freezeAuthority, null);
    assert.deepEqual(gateFor(parsed), ['PERMANENT_DELEGATE_ACTIVE']);
  });

  test('a delegate renounced to None does NOT veto', () => {
    // Verified against official sources: the delegate can be set to None, and
    // once it is, nobody can sign as it. Vetoing on the extension's presence
    // would reject issuers who have already given the power up.
    const parsed = parseMint(
      t22([{ extension: 'permanentDelegate', state: { delegate: null } }]),
      largestAccounts('1'),
      false,
    );
    assert.equal(parsed.extensions?.[0]?.active, false);
    assert.deepEqual(gateFor(parsed), []);
  });

  test('a delegate renounced to the zero address does NOT veto', () => {
    const parsed = parseMint(
      t22([
        { extension: 'permanentDelegate', state: { delegate: '11111111111111111111111111111111' } },
      ]),
      largestAccounts('1'),
      false,
    );
    assert.equal(parsed.extensions?.[0]?.active, false);
    assert.deepEqual(gateFor(parsed), []);
  });

  test('the permanent delegate veto is re-checkable, because renouncing is possible', () => {
    const parsed = parseMint(
      t22([{ extension: 'permanentDelegate', state: { delegate: DELEGATE } }]),
      largestAccounts('1'),
      false,
    );
    const now = Date.now();
    const evidence = resolveEvidence({
      pairs: [],
      jupiter: null,
      rugcheck: null,
      onchain: parsed,
      observedAt: { dexscreener: now, jupiter: now, rugcheck: now, onchain: now },
      heliusConfigured: true,
      now,
    });
    const veto = evaluateExtensionGate(evidence)[0];
    assert.equal(veto?.recheckable, true);
    assert.equal(veto?.nature, 'current-state');
  });

  test('an unreadable delegate field is UNKNOWN: no veto, and no clean bill either', () => {
    const parsed = parseMint(
      t22([{ extension: 'permanentDelegate', state: { somethingElse: 1 } }]),
      largestAccounts('1'),
      false,
    );
    assert.equal(parsed.extensions?.[0]?.active, null);
    assert.deepEqual(gateFor(parsed), []);
    // The compensation for not vetoing is that coverage records the gap.
    assert.equal(parsed.extensionsComplete, false);
  });

  test('a stale extension observation cannot assert a present danger', () => {
    const parsed = parseMint(
      t22([{ extension: 'permanentDelegate', state: { delegate: DELEGATE } }]),
      largestAccounts('1'),
      false,
    );
    const now = Date.now();
    // Beyond the 7-day aging window for extension configuration.
    const observed = now - 30 * 24 * 3_600_000;
    const evidence = resolveEvidence({
      pairs: [],
      jupiter: null,
      rugcheck: null,
      onchain: parsed,
      observedAt: { dexscreener: now, jupiter: now, rugcheck: now, onchain: observed },
      heliusConfigured: true,
      now,
    });
    assert.deepEqual(evaluateExtensionGate(evidence), []);
  });
});

// ---------------------------------------------------------------------------
// The rest of the restricted set
// ---------------------------------------------------------------------------

describe('other disqualifying extensions', () => {
  test('a transfer hook with a program set vetoes', () => {
    const parsed = parseMint(
      t22([{ extension: 'transferHook', state: { authority: DELEGATE, programId: HOOK_PROGRAM } }]),
      largestAccounts('1'),
      false,
    );
    assert.deepEqual(gateFor(parsed), ['TRANSFER_HOOK_ACTIVE']);
  });

  test('a transfer hook with no program set does not veto', () => {
    const parsed = parseMint(
      t22([{ extension: 'transferHook', state: { authority: DELEGATE, programId: null } }]),
      largestAccounts('1'),
      false,
    );
    assert.deepEqual(gateFor(parsed), []);
  });

  test('a pausable mint vetoes while a pause authority exists', () => {
    const parsed = parseMint(
      t22([{ extension: 'pausableConfig', state: { authority: DELEGATE, paused: false } }]),
      largestAccounts('1'),
      false,
    );
    assert.deepEqual(gateFor(parsed), ['MINT_PAUSABLE']);
  });

  test('a mint currently paused vetoes', () => {
    const parsed = parseMint(
      t22([{ extension: 'pausableConfig', state: { authority: null, paused: true } }]),
      largestAccounts('1'),
      false,
    );
    assert.deepEqual(gateFor(parsed), ['MINT_PAUSABLE']);
  });

  test('a pausable extension with the authority renounced and unpaused does not veto', () => {
    const parsed = parseMint(
      t22([{ extension: 'pausableConfig', state: { authority: null, paused: false } }]),
      largestAccounts('1'),
      false,
    );
    assert.deepEqual(gateFor(parsed), []);
  });

  test('defaultAccountState frozen vetoes; initialized does not', () => {
    const frozen = parseMint(
      t22([{ extension: 'defaultAccountState', state: { accountState: 'frozen' } }]),
      largestAccounts('1'),
      false,
    );
    assert.deepEqual(gateFor(frozen), ['DEFAULT_ACCOUNT_STATE_FROZEN']);

    const open = parseMint(
      t22([{ extension: 'defaultAccountState', state: { accountState: 'initialized' } }]),
      largestAccounts('1'),
      false,
    );
    assert.deepEqual(gateFor(open), []);
  });

  test('a non-transferable mint vetoes and cannot be re-checked', () => {
    const parsed = parseMint(
      t22([{ extension: 'nonTransferable', state: {} }]),
      largestAccounts('1'),
      false,
    );
    const now = Date.now();
    const evidence = resolveEvidence({
      pairs: [],
      jupiter: null,
      rugcheck: null,
      onchain: parsed,
      observedAt: { dexscreener: now, jupiter: now, rugcheck: now, onchain: now },
      heliusConfigured: true,
      now,
    });
    const veto = evaluateExtensionGate(evidence)[0];
    assert.equal(veto?.code, 'NON_TRANSFERABLE');
    // NonTransferable carries no authority, so nothing can turn it off.
    assert.equal(veto?.recheckable, false);
  });

  test('several armed extensions each produce their own veto', () => {
    const parsed = parseMint(
      t22([
        { extension: 'permanentDelegate', state: { delegate: DELEGATE } },
        { extension: 'transferHook', state: { programId: HOOK_PROGRAM } },
        { extension: 'defaultAccountState', state: { accountState: 'frozen' } },
      ]),
      largestAccounts('1'),
      false,
    );
    assert.deepEqual(gateFor(parsed).sort(), [
      'DEFAULT_ACCOUNT_STATE_FROZEN',
      'PERMANENT_DELEGATE_ACTIVE',
      'TRANSFER_HOOK_ACTIVE',
    ]);
  });
});

describe('transfer fee, the one conditional policy', () => {
  const feeState = (bps: number) => ({
    newerTransferFee: { epoch: 300, transferFeeBasisPoints: bps, maximumFee: '1000' },
    olderTransferFee: { epoch: 299, transferFeeBasisPoints: 0, maximumFee: '1000' },
  });

  test('a modest fee is recorded but does not veto', () => {
    const parsed = parseMint(
      t22([{ extension: 'transferFeeConfig', state: feeState(400) }]),
      largestAccounts('1'),
      false,
    );
    assert.equal(parsed.extensions?.[0]?.magnitude, 400);
    assert.equal(parsed.extensions?.[0]?.detail, '4.00% fee');
    assert.deepEqual(gateFor(parsed), []);
  });

  test('a fee at or above the threshold vetoes', () => {
    const parsed = parseMint(
      t22([{ extension: 'transferFeeConfig', state: feeState(TRANSFER_FEE_VETO_BPS) }]),
      largestAccounts('1'),
      false,
    );
    assert.deepEqual(gateFor(parsed), ['EXTREME_TRANSFER_FEE']);
  });

  test('the higher of the two scheduled fees is the one that counts', () => {
    const parsed = parseMint(
      t22([
        {
          extension: 'transferFeeConfig',
          state: {
            newerTransferFee: { epoch: 300, transferFeeBasisPoints: 100 },
            olderTransferFee: { epoch: 299, transferFeeBasisPoints: 9_000 },
          },
        },
      ]),
      largestAccounts('1'),
      false,
    );
    assert.equal(parsed.extensions?.[0]?.magnitude, 9_000);
    assert.deepEqual(gateFor(parsed), ['EXTREME_TRANSFER_FEE']);
  });

  test('an unreadable fee schedule never clears the threshold', () => {
    const parsed = parseMint(
      t22([{ extension: 'transferFeeConfig', state: { unexpected: true } }]),
      largestAccounts('1'),
      false,
    );
    assert.equal(parsed.extensions?.[0]?.magnitude, null);
    assert.equal(parsed.extensions?.[0]?.active, null);
    // Unknown never vetoes - and never reassures: the read is incomplete.
    assert.deepEqual(gateFor(parsed), []);
    assert.equal(parsed.extensionsComplete, false);
  });
});

describe('extensions with no current risk effect', () => {
  for (const id of [
    'metadataPointer',
    'tokenMetadata',
    'mintCloseAuthority',
    'interestBearingConfig',
    'scaledUiAmountConfig',
    'confidentialTransferMint',
  ]) {
    test(`${id} is recorded but never vetoes`, () => {
      const parsed = parseMint(t22([{ extension: id, state: {} }]), largestAccounts('1'), false);
      assert.equal(parsed.extensions?.length, 1);
      assert.equal(parsed.extensionsComplete, true);
      assert.deepEqual(gateFor(parsed), []);
    });
  }

  test('every registry rule carries a written rationale', () => {
    for (const rule of EXTENSION_RULES) {
      assert.ok(rule.rationale.length > 40, `${rule.id} needs a real rationale`);
      assert.ok(rule.label.length > 0);
    }
  });
});

// ---------------------------------------------------------------------------
// Holder math
// ---------------------------------------------------------------------------

describe('holder math: exact integer arithmetic', () => {
  test('concentration is computed from raw amounts on both sides', () => {
    // 900 of 1000 base units, decimals irrelevant to the ratio.
    const parsed = parseMint(
      mintAccount({ supply: '1000', decimals: 0 }),
      largestAccounts('900'),
      false,
    );
    assert.equal(parsed.top10Share, 0.9);
    assert.equal(parsed.rawTop10, '900');
    assert.equal(parsed.rawSupply, '1000');
  });

  for (const decimals of [0, 6, 9, 18, 30, 255]) {
    test(`decimals ${decimals} is accepted and does not change the ratio`, () => {
      const parsed = parseMint(
        mintAccount({ supply: '1000', decimals }),
        largestAccounts('750'),
        false,
      );
      assert.equal(parsed.decimals, decimals);
      assert.equal(
        parsed.issues.find((issue) => issue.field === 'decimals'),
        undefined,
      );
      // The ratio is raw/raw, so the exponent cannot touch it.
      assert.equal(parsed.top10Share, 0.75);
    });
  }

  test('decimals above the u8 range is rejected as impossible', () => {
    const parsed = parseMint(
      mintAccount({ supply: '1000', decimals: 256 }),
      largestAccounts('750'),
      false,
    );
    assert.equal(parsed.decimals, null);
    assert.ok(parsed.issues.some((issue) => issue.field === 'decimals'));
    // The regression that mattered: rejected decimals must not silently mix
    // units and produce a near-zero, maximally-safe-looking share.
    assert.equal(parsed.top10Share, 0.75);
  });

  test('a u64 supply beyond exact float range keeps full precision', () => {
    // 2^63, well past Number.MAX_SAFE_INTEGER.
    const supply = '9223372036854775808';
    const parsed = parseMint(
      mintAccount({ supply, decimals: 9 }),
      largestAccounts('9223372036854775807'),
      false,
    );
    assert.equal(parsed.rawSupply, supply);
    // One base unit short of the whole supply. Through `number` both operands
    // round to 2^63 and the ratio comes out as exactly 1; the exact integer
    // path keeps them distinct and truncates to nine decimal places instead.
    assert.equal(parsed.top10Share, 0.999999999);
    assert.notEqual(parsed.top10Share, 1);
    assert.equal(9_223_372_036_854_775_807 / 9_223_372_036_854_775_808, 1);
  });

  test('a supply beyond u64 is rejected rather than truncated', () => {
    const parsed = parseMint(
      mintAccount({ supply: '99999999999999999999999' }),
      largestAccounts('1'),
      false,
    );
    assert.equal(parsed.rawSupply, null);
    assert.ok(parsed.issues.some((issue) => issue.field === 'supply'));
    assert.equal(parsed.top10Share, null);
  });

  test('only the ten largest accounts count toward the top-ten share', () => {
    const parsed = parseMint(
      mintAccount({ supply: '1000', decimals: 0 }),
      largestAccounts(...Array.from({ length: 20 }, () => '50')),
      false,
    );
    // Ten of twenty accounts at 50 each = 500 of 1000.
    assert.equal(parsed.top10Share, 0.5);
    assert.equal(parsed.largestAccountsCount, 20);
  });

  test('accounts are ranked by raw amount, not by the order returned', () => {
    const parsed = parseMint(
      mintAccount({ supply: '1000', decimals: 0 }),
      largestAccounts('1', '2', '900'),
      false,
    );
    assert.equal(parsed.largestHolderShare, 0.9);
  });

  test('a zero-balance holder set is a measured zero, not unknown', () => {
    const parsed = parseMint(
      mintAccount({ supply: '1000', decimals: 0 }),
      largestAccounts('0', '0'),
      false,
    );
    assert.equal(parsed.top10Share, 0);
    assert.equal(parsed.largestHolderShare, 0);
  });

  test('no holder accounts at all is a measured zero', () => {
    const parsed = parseMint(mintAccount({ supply: '1000', decimals: 0 }), largestAccounts(), false);
    assert.equal(parsed.top10Share, 0);
    assert.equal(parsed.largestAccountsCount, 0);
  });

  test('a zero supply yields unknown concentration, not a division blow-up', () => {
    const parsed = parseMint(
      mintAccount({ supply: '0', decimals: 0 }),
      largestAccounts('5'),
      false,
    );
    assert.equal(parsed.top10Share, null);
    assert.equal(parsed.largestHolderShare, null);
  });

  test('balances exceeding supply are rejected, not capped', () => {
    const parsed = parseMint(
      mintAccount({ supply: '1000', decimals: 0 }),
      largestAccounts('2000'),
      false,
    );
    assert.equal(parsed.top10Share, null);
    assert.ok(parsed.issues.some((issue) => issue.field === 'top10Share'));
  });
});

describe('holder math: failing toward uncertainty', () => {
  test('a null holder amount withdraws the whole set rather than under-counting', () => {
    // The old code dropped null entries, which understates concentration - and
    // understating concentration is failing toward safety.
    const parsed = parseMint(
      mintAccount({ supply: '1000', decimals: 0 }),
      largestAccounts('500', null, '400'),
      false,
    );
    assert.equal(parsed.top10Share, null);
    assert.equal(parsed.largestAccountsCount, null);
    assert.ok(parsed.issues.some((issue) => issue.field === 'top10Share'));
  });

  test('a malformed holder amount withdraws the whole set', () => {
    const parsed = parseMint(
      mintAccount({ supply: '1000', decimals: 0 }),
      largestAccounts('500', 'not-a-number'),
      false,
    );
    assert.equal(parsed.top10Share, null);
    assert.ok(parsed.issues.some((issue) => issue.field.startsWith('largestAccounts')));
  });

  test('a negative holder amount is impossible and withdraws the set', () => {
    const parsed = parseMint(
      mintAccount({ supply: '1000', decimals: 0 }),
      largestAccounts('-5'),
      false,
    );
    assert.equal(parsed.top10Share, null);
  });

  test('uiAmount is never consulted, so a wrong one cannot change the answer', () => {
    const largest = {
      value: [
        // A uiAmount inconsistent with the raw amount, as ScaledUiAmount or
        // InterestBearing would legitimately produce.
        { address: 'a', amount: '900', uiAmount: 0.000001, uiAmountString: '0.000001' },
      ],
    } as Parameters<typeof parseMint>[1];
    const parsed = parseMint(mintAccount({ supply: '1000', decimals: 0 }), largest, false);
    assert.equal(parsed.top10Share, 0.9);
  });

  test('a failed holder call is unknown concentration, not zero', () => {
    const parsed = parseMint(mintAccount({ supply: '1000', decimals: 0 }), null, true);
    assert.equal(parsed.top10Share, null);
    assert.equal(parsed.largestAccountsCount, null);
    // The mint account still answered, so its own fields survive.
    assert.equal(parsed.rawSupply, '1000');
    assert.equal(parsed.tokenProgram, 'LEGACY_SPL_TOKEN');
  });

  test('a failed mint-account call leaves supply unknown but keeps holders', () => {
    const parsed = parseMint(null, largestAccounts('5', '5'), false);
    assert.equal(parsed.rawSupply, null);
    assert.equal(parsed.top10Share, null);
    assert.equal(parsed.largestAccountsCount, 2);
  });

  test('no NaN or Infinity escapes into any numeric field', () => {
    const cases: OnChainInfo[] = [
      parseMint(mintAccount({ supply: 'abc', decimals: NaN }), largestAccounts('1'), false),
      parseMint(mintAccount({ supply: '0' }), largestAccounts('1'), false),
      parseMint(mintAccount({ supply: Infinity }), largestAccounts(Infinity), false),
      parseMint(mintAccount({ supply: '10', decimals: 1.5 }), largestAccounts('1e3'), false),
    ];
    for (const parsed of cases) {
      for (const value of [
        parsed.top10Share,
        parsed.largestHolderShare,
        parsed.supply,
        parsed.decimals,
      ]) {
        assert.ok(value === null || Number.isFinite(value), `got ${String(value)}`);
      }
    }
  });
});

describe('exactRatio', () => {
  test('returns null rather than Infinity for a zero denominator', () => {
    assert.equal(exactRatio(5n, 0n), null);
  });

  test('never rounds a share above its true value', () => {
    // Integer division truncates downward, so a computed share above 1 always
    // means the inputs genuinely contradict each other.
    assert.equal(exactRatio(1n, 3n), 0.333333333);
    assert.equal(exactRatio(1n, 1n), 1);
    assert.ok((exactRatio(999_999_999_999n, 1_000_000_000_000n) as number) < 1);
  });

  test('is exact for u64-scale inputs', () => {
    assert.equal(exactRatio(18_446_744_073_709_551_615n, 18_446_744_073_709_551_615n), 1);
  });
});

describe('veto audit trail', () => {
  test('a veto from an incomplete read still carries the real observation time', () => {
    // The extension Evidence is UNKNOWN here (the list is partial), so its own
    // `observedAt` is null - but the observation did happen, and the veto has
    // to say when.
    const parsed = parseMint(
      t22([
        { extension: 'permanentDelegate', state: { delegate: DELEGATE } },
        { extension: 'someFutureExtension', state: {} },
      ]),
      largestAccounts('1'),
      false,
    );
    assert.equal(parsed.extensionsComplete, false);

    const now = Date.now();
    const observed = now - 60_000;
    const evidence = resolveEvidence({
      pairs: [],
      jupiter: null,
      rugcheck: null,
      onchain: parsed,
      observedAt: { dexscreener: now, jupiter: now, rugcheck: now, onchain: observed },
      heliusConfigured: true,
      now,
    });

    assert.equal(evidence.mintExtensions.state, 'UNKNOWN');
    assert.equal(evidence.mintExtensions.observedAt, null);

    const veto = evaluateExtensionGate(evidence)[0];
    assert.equal(veto?.code, 'PERMANENT_DELEGATE_ACTIVE');
    assert.equal(veto?.at, observed);
    assert.notEqual(veto?.at, null);
  });

  test('every extension veto carries source, reason and observed value', () => {
    const parsed = parseMint(
      t22([{ extension: 'transferHook', state: { programId: HOOK_PROGRAM } }]),
      largestAccounts('1'),
      false,
    );
    const now = Date.now();
    const evidence = resolveEvidence({
      pairs: [],
      jupiter: null,
      rugcheck: null,
      onchain: parsed,
      observedAt: { dexscreener: now, jupiter: now, rugcheck: now, onchain: now },
      heliusConfigured: true,
      now,
    });
    const veto = evaluateExtensionGate(evidence)[0];
    assert.ok(veto);
    assert.equal(veto.source, 'helius');
    assert.ok(veto.reason.length > 40);
    assert.ok(veto.observedValue.includes(HOOK_PROGRAM));
    assert.equal(typeof veto.recheckable, 'boolean');
  });
});
