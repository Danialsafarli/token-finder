/**
 * Attribution, security events, creator history and serial networks.
 *
 * The rules under test are about restraint as much as detection: a fee payer
 * is not assumed to be a creator, a price collapse is not an event, a program
 * migrating liquidity is not a drain, and sharing a launch with a bad actor is
 * not being one.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_SPL_TOKEN_PROGRAM_ID } from '../src/core/token-program.ts';
import { attributeCreation } from '../src/intel/attribution.ts';
import { detectSecurityEvents, type SecurityInput } from '../src/intel/security.ts';
import { analyzeNetwork, buildCreatorProfile, type CreatorProfile, type PathEdge } from '../src/intel/creator.ts';
import { mintOf, ntx, pda, T0, wallet } from './intel-helpers.ts';

const TOKEN_PROGRAM = LEGACY_SPL_TOKEN_PROGRAM_ID;

function creationTx(mint: string, signers: string[], feePayer: string, pool: string | null, poolFunder: string | null) {
  return ntx({
    signature: `create-${mint.slice(0, 6)}`,
    slot: 1_000,
    feePayer,
    signers: [...signers, mint],
    mintInits: [{ path: '0', mint, decimals: 6, mintAuthority: pda('launchpad-authority'), freezeAuthority: null, tokenProgram: TOKEN_PROGRAM }],
    accountCreations: pool && poolFunder ? [{ path: '1', account: pool, owner: pda('amm'), lamports: 2_000_000n, funder: poolFunder }] : [],
    mintTos: [{ path: '2', mint, account: 'curve-ata', amount: 1_000_000_000_000_000n, authority: pda('launchpad-authority') }],
  });
}

describe('attribution', () => {
  test('one signer who paid and funded the pool: attributed, and the roles stay separate', () => {
    const m = mintOf('solo');
    const dev = wallet('dev');
    const a = attributeCreation(creationTx(m, [dev], dev, pda('solo-pool'), dev), m, pda('solo-pool'));
    assert.equal(a.status, 'ATTRIBUTED');
    assert.equal(a.creator, dev);
    assert.equal(a.liquidityCreator, dev);
    assert.equal(a.mintAuthorityRole, 'program');
    assert.ok(a.confidence > 0.6 && a.confidence < 1);
  });

  test('the fee payer is never assumed to be the creator', () => {
    const m = mintOf('relayed');
    const dev = wallet('relayed-dev');
    const relayer = wallet('relayer');
    const a = attributeCreation(creationTx(m, [dev], relayer, null, null), m, null);
    assert.equal(a.creator, dev);
    assert.equal(a.feePayer, relayer);
    assert.ok(a.confidence < 0.85, 'a relayed launch is attributed with less confidence');
  });

  test('creator ambiguity: several signers - AMBIGUOUS, with every candidate kept', () => {
    const m = mintOf('multi');
    const a = attributeCreation(creationTx(m, [wallet('m1'), wallet('m2')], wallet('m1'), null, null), m, null);
    assert.equal(a.status, 'AMBIGUOUS');
    assert.equal(a.creator, null);
    assert.equal(a.confidence, 0);
    assert.deepEqual(a.deployers.sort(), [wallet('m1'), wallet('m2')].sort());
  });
});

describe('security events', () => {
  const m = mintOf('sec');
  const dev = wallet('sec-dev');
  const base = (p: Partial<SecurityInput>): SecurityInput => ({
    mint: m,
    launchSignature: 'launch',
    launchSlot: 100,
    initialSupply: 1_000_000n,
    creatorLinked: new Set([dev]),
    mintTos: [],
    authorityChanges: [],
    freezes: [],
    liquidityRemovals: [],
    sells: [],
    ...p,
  });
  const fact = (n: number) => ({ signature: `s${n}`, slot: 100 + n, blockTimeMs: T0 + n * 60_000 });

  test('a price collapse with no action behind it is not an event', () => {
    const sells = Array.from({ length: 30 }, (_, i) => ({ ...fact(i), trader: wallet(`seller-${i}`), tokenAmount: 20_000n }));
    assert.deepEqual(detectSecurityEvents(base({ sells })), []);
  });

  test('confirmed: the creator drained the pool', () => {
    const [e] = detectSecurityEvents(base({ liquidityRemovals: [{ ...fact(1), actor: dev, reserveFraction: 0.97, tokenAmount: 900_000n }] }));
    assert.equal(e?.type, 'LIQUIDITY_DRAIN');
    assert.equal(e?.status, 'CONFIRMED');
    assert.deepEqual(e?.evidence, ['s1']);
  });

  test('a program migrating liquidity is not a drain', () => {
    assert.deepEqual(detectSecurityEvents(base({ liquidityRemovals: [{ ...fact(1), actor: pda('migrator'), reserveFraction: 1, tokenAmount: 900_000n }] })), []);
  });

  test('confirmed: supply minted to the creator after launch and sold', () => {
    const events = detectSecurityEvents(base({
      mintTos: [{ ...fact(2), amount: 500_000n, recipientOwner: dev, authority: dev }],
      sells: [{ ...fact(3), trader: dev, tokenAmount: 400_000n }],
    }));
    assert.equal(events.find((e) => e.type === 'SUPPLY_EXPANSION')?.status, 'CONFIRMED');
  });

  test('confirmed: holders frozen by the freeze authority', () => {
    const freezes = [1, 2, 3].map((i) => ({ ...fact(i), kind: 'FREEZE' as const, owner: wallet(`victim-${i}`), authority: dev }));
    assert.equal(detectSecurityEvents(base({ freezes }))[0]?.status, 'CONFIRMED');
  });

  test('freezing a program-owned account is not freezing a holder', () => {
    const freezes = [1, 2, 3].map((i) => ({ ...fact(i), kind: 'FREEZE' as const, owner: pda(`vault-${i}`), authority: dev }));
    assert.deepEqual(detectSecurityEvents(base({ freezes })), []);
  });

  test('a freeze whose owner was not reported is at most suspicious', () => {
    const [e] = detectSecurityEvents(base({ freezes: [{ ...fact(1), kind: 'FREEZE', owner: null, authority: dev }] }));
    assert.equal(e?.status, 'SUSPICIOUS');
  });

  test('a creator selling is at most strongly suspected, never confirmed', () => {
    const [e] = detectSecurityEvents(base({ sells: [{ ...fact(1), trader: dev, tokenAmount: 400_000n }] }));
    assert.equal(e?.type, 'CREATOR_DUMP');
    assert.equal(e?.status, 'STRONGLY_SUSPECTED');
  });

  test('an unknown supply makes no dump claim at all', () => {
    assert.deepEqual(detectSecurityEvents(base({ initialSupply: null, sells: [{ ...fact(1), trader: dev, tokenAmount: 999_999n }] })), []);
  });
});

describe('creator history', () => {
  const launches = (n: number) => Array.from({ length: n }, (_, i) => ({ mint: mintOf(`hist-${i}`), blockTimeMs: T0 + i * 86_400_000 }));

  test('clean history: several launches, no events - CLEAN, which is not a guarantee', () => {
    const p = buildCreatorProfile(wallet('clean'), launches(3), []);
    assert.equal(p.status, 'CLEAN');
    assert.match(p.reasons[0] ?? '', /no security events recorded/);
  });

  test('one launch is too little to say anything', () => {
    assert.equal(buildCreatorProfile(wallet('new'), launches(1), []).status, 'INSUFFICIENT_HISTORY');
  });

  test('suspicious history: suspected events only', () => {
    const p = buildCreatorProfile(wallet('sus'), launches(2), [{ mint: mintOf('hist-0'), type: 'CREATOR_DUMP', status: 'STRONGLY_SUSPECTED', signature: 'x' }]);
    assert.equal(p.status, 'SUSPICIOUS');
  });

  test('a confirmed event is a malicious history', () => {
    const p = buildCreatorProfile(wallet('bad'), launches(2), [{ mint: mintOf('hist-1'), type: 'LIQUIDITY_DRAIN', status: 'CONFIRMED', signature: 'y' }]);
    assert.equal(p.status, 'MALICIOUS_HISTORY');
    assert.equal(p.confirmed, 1);
  });
});

describe('serial networks', () => {
  const bad = wallet('serial-bad');
  const fresh = wallet('serial-fresh');
  const profile: CreatorProfile = buildCreatorProfile(bad, [{ mint: mintOf('old'), blockTimeMs: T0 }, { mint: mintOf('old2'), blockTimeMs: T0 }], [
    { mint: mintOf('old'), type: 'LIQUIDITY_DRAIN', status: 'CONFIRMED', signature: 'drain' },
  ]);
  const profiles = new Map([[bad, profile]]);

  test('a strong serial network: a brand-new creator funded directly by a confirmed bad actor', () => {
    const edges: PathEdge[] = [{ from: bad, to: fresh, type: 'FUNDED', confidence: 0.9, evidence: 'fund-sig' }];
    const n = analyzeNetwork([fresh], edges, profiles);
    assert.equal(n.level, 'STRONG');
    assert.equal(n.findings[0]?.target, bad);
    assert.equal(n.findings[0]?.path.length, 1, 'the path is shown');
    assert.equal(n.findings[0]?.path[0]?.evidence, 'fund-sig');
    assert.ok(n.confidence > 0.5);
  });

  test('a creator with its own suspected history is described as such, not as a path', () => {
    const own = buildCreatorProfile(fresh, [{ mint: mintOf('own'), blockTimeMs: T0 }], [{ mint: mintOf('own'), type: 'FREEZE_ABUSE', status: 'STRONGLY_SUSPECTED', signature: 'f' }]);
    const n = analyzeNetwork([fresh], [], new Map([[fresh, own]]));
    assert.equal(n.level, 'MODERATE');
    assert.match(n.reasons[0] ?? '', /the creator itself/);
  });

  test('a weak association must not become malicious', () => {
    const edges: PathEdge[] = [{ from: bad, to: fresh, type: 'BEHAVIOURAL', confidence: 0.3, evidence: 'same launch' }];
    const n = analyzeNetwork([fresh], edges, profiles);
    assert.equal(n.level, 'WEAK_ASSOCIATION');
    assert.deepEqual(n.findings, []);
    assert.equal(n.confidence, 0);
    assert.match(n.reasons[0] ?? '', /not a malicious finding/);
  });

  test('a history beyond the search depth is not reached', () => {
    const mid1 = wallet('mid1');
    const mid2 = wallet('mid2');
    const edges: PathEdge[] = [
      { from: bad, to: mid1, type: 'FUNDED', confidence: 0.9, evidence: 'a' },
      { from: mid1, to: mid2, type: 'FUNDED', confidence: 0.9, evidence: 'b' },
      { from: mid2, to: fresh, type: 'FUNDED', confidence: 0.9, evidence: 'c' },
    ];
    assert.equal(analyzeNetwork([fresh], edges, profiles, 2).level, 'NONE');
  });

  test('no attributable creator is INSUFFICIENT_DATA, not NONE', () => {
    assert.equal(analyzeNetwork([], [], profiles).level, 'INSUFFICIENT_DATA');
  });
});
