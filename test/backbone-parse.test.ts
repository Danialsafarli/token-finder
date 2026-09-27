/**
 * The data backbone's pure layer, against real mainnet transactions.
 *
 * Every fixture under test/fixtures/chain was fetched from mainnet
 * (`finalized`, jsonParsed, maxSupportedTransactionVersion 1) while this layer
 * was built: a pump.fun creation, fourteen trades on one bonding curve - two of
 * them relayed, so the fee payer is not the trader - a failed trade, and a
 * Raydium CPMM trade of a Token-2022 token with a transfer fee. Synthetic
 * variants are derived from those by editing balances, so the shapes the
 * derivation must refuse are tested against real structure too.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addressBytes, base58Decode, isOnCurve } from '../src/chain/address.ts';
import { PUMPFUN_MINT_AUTHORITY, WSOL_MINT } from '../src/chain/programs.ts';
import { normalizeTransaction, type NormalizedTransaction } from '../src/ingest/normalize.ts';
import { derivePoolActivity } from '../src/ingest/activity.ts';
import { parsePumpfunLaunch } from '../src/ingest/launch.ts';
import { MIN_SOL_EDGE_LAMPORTS, mintEvents, poolCreatedEvent, transferEdges } from '../src/ingest/derive.ts';
import { canonicalId } from '../src/ingest/events.ts';
import { planDeepCollection } from '../src/ingest/budget.ts';
import { parseSignatures } from '../src/sources/solana-rpc.ts';
import { snapshot } from './persist-helpers.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'chain');
const load = (name: string): unknown => JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8'));
const tx = (name: string): NormalizedTransaction => {
  const normalized = normalizeTransaction(load(name));
  assert.ok(normalized, `${name} normalizes`);
  return normalized;
};
const TRADES = readdirSync(DIR)
  .filter((f) => /^pumpfun-curve-\d+\.json$/.test(f))
  .map((f) => f.replace('.json', ''));
const META = load('pumpfun-trade-meta') as { mint: string; curve: string };
const RAYDIUM = load('raydium-cpmm-transfer-fee-meta') as { mint: string; pool: string; vaultAuthority: string };

describe('addresses', () => {
  test('every signer in every real transaction is on the curve - a signer must hold a key', () => {
    let signers = 0;
    for (const name of [...TRADES, 'pumpfun-create', 'pumpfun-curve-failed', 'raydium-cpmm-transfer-fee']) {
      for (const signer of tx(name).signers) {
        signers += 1;
        assert.equal(isOnCurve(signer), true, `${signer} in ${name}`);
      }
    }
    assert.ok(signers >= 17);
  });

  test('program-derived accounts are off the curve', () => {
    assert.equal(isOnCurve(PUMPFUN_MINT_AUTHORITY), false);
    assert.equal(isOnCurve(META.curve), false);
    assert.equal(isOnCurve(RAYDIUM.vaultAuthority), false);
    // Associated token accounts are PDAs of the ATA program.
    const create = tx('pumpfun-create');
    const ata = create.tokenAccountInits.find((a) => a.owner === META.curve || a.owner === create.feePayer);
    assert.ok(ata);
    assert.equal(isOnCurve(ata.account), false);
  });

  test('the all-zero key (the system program id) is a curve point, as in Solana', () => {
    assert.equal(isOnCurve('11111111111111111111111111111111'), true);
  });

  test('non-addresses are not guessed at', () => {
    assert.equal(isOnCurve('not-an-address'), null);
    assert.equal(isOnCurve('0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl'), null);
    assert.equal(addressBytes('1'), null);
    assert.equal(base58Decode('0'), null);
    assert.equal(addressBytes(WSOL_MINT)?.length, 32);
  });
});

describe('transaction normalization', () => {
  test('identity, status and fee are read exactly', () => {
    const t = tx('pumpfun-curve-01');
    assert.match(t.signature, /^[1-9A-HJ-NP-Za-km-z]{64,90}$/);
    assert.ok(t.slot > 400_000_000);
    assert.ok(t.blockTimeMs !== null && t.blockTimeMs > Date.parse('2026-01-01'));
    assert.equal(t.status, 'SUCCESS');
    assert.equal(t.error, null);
    assert.equal(t.feePayer, t.signers[0]);
    assert.equal(typeof t.feeLamports, 'bigint');
    assert.deepEqual(t.issues, []);
  });

  test('balance changes are exact integers and conserve the traded token', () => {
    const t = tx('pumpfun-curve-01');
    const moved = t.tokenBalances.filter((b) => b.mint === META.mint).reduce((sum, b) => sum + b.delta, 0n);
    // A trade moves the token between accounts; it creates none.
    assert.equal(moved, 0n);
    for (const b of t.tokenBalances) assert.equal(typeof b.delta, 'bigint');
  });

  test('a failed transaction says so and carries the error', () => {
    const t = tx('pumpfun-curve-failed');
    assert.equal(t.status, 'FAILED');
    assert.match(t.error ?? '', /InstructionError/);
  });

  test('the creation yields its instruction facts with stable paths', () => {
    const t = tx('pumpfun-create');
    assert.equal(t.mintInits.length, 1);
    assert.equal(t.mintInits[0]?.mintAuthority, PUMPFUN_MINT_AUTHORITY);
    assert.match(t.mintInits[0]?.path ?? '', /^\d+\.\d+$/);
    assert.equal(t.mintTos[0]?.amount, 1_000_000_000_000_000n);
    assert.equal(t.authorityChanges[0]?.authorityType, 'mintTokens');
    assert.equal(t.authorityChanges[0]?.newAuthority, null);
    assert.ok(t.solTransfers.length > 0);
    assert.ok(t.tokenTransfers.length > 0);
  });

  test('not a transaction is null; an impossible field is an issue, not a value', () => {
    assert.equal(normalizeTransaction(null), null);
    assert.equal(normalizeTransaction({ slot: 1 }), null);
    const raw = load('pumpfun-curve-01') as { meta: { postTokenBalances: { uiTokenAmount: { amount: unknown } }[] } };
    const broken = structuredClone(raw);
    (broken.meta.postTokenBalances[0] as { uiTokenAmount: { amount: unknown } }).uiTokenAmount.amount = '-5';
    const t = normalizeTransaction(broken);
    assert.ok(t);
    assert.ok(t.issues.some((i) => /postTokenBalances\[0\]\.amount/.test(i.field)));
  });

  test('signature pages are validated at the boundary', () => {
    const page = parseSignatures([
      { signature: tx('pumpfun-curve-01').signature, slot: 10, blockTime: 1_790_000_000, err: null, transactionIndex: 7 },
      { signature: 'short', slot: 11 },
      { signature: tx('pumpfun-curve-02').signature, slot: 9, blockTime: null, err: { InstructionError: [0, 'x'] } },
    ]);
    assert.equal(page.length, 2);
    assert.equal(page[0]?.transactionIndex, 7);
    assert.equal(page[0]?.blockTimeMs, 1_790_000_000_000);
    assert.equal(page[1]?.failed, true);
    assert.equal(page[1]?.blockTimeMs, null);
  });
});

describe('pool activity', () => {
  test('every real bonding-curve trade resolves to an exact swap, direction from the pool', () => {
    for (const name of TRADES) {
      const t = tx(name);
      const a = derivePoolActivity(t, META.mint, META.curve);
      assert.equal(a.kind, 'SWAP', name);
      assert.equal(a.traderResolution, 'EXACT', name);
      assert.equal(a.confidence, 1, name);
      assert.equal(a.quoteMint, WSOL_MINT, name);
      // The trader mirrors the pool exactly.
      const traderDelta = t.tokenBalances
        .filter((b) => b.mint === META.mint && b.owner === a.trader)
        .reduce((s, b) => s + b.delta, 0n);
      assert.equal(traderDelta, a.direction === 'BUY' ? a.tokenAmount : -(a.tokenAmount as bigint), name);
      assert.ok(a.priceInQuote !== null && a.priceInQuote > 0, name);
    }
  });

  test('relayed trades name the wallet that received the tokens, not the fee payer', () => {
    for (const name of ['pumpfun-curve-08', 'pumpfun-curve-10']) {
      const a = derivePoolActivity(tx(name), META.mint, META.curve);
      assert.notEqual(a.trader, a.feePayer, name);
      assert.equal(a.traderResolution, 'EXACT', name);
    }
    // The same wallet sold and bought back the same amount.
    const sell = derivePoolActivity(tx('pumpfun-curve-08'), META.mint, META.curve);
    const buy = derivePoolActivity(tx('pumpfun-curve-10'), META.mint, META.curve);
    assert.equal(sell.direction, 'SELL');
    assert.equal(buy.direction, 'BUY');
    assert.equal(sell.tokenAmount, buy.tokenAmount);
  });

  test('the SOL side is the reserve change, not the trader\'s polluted lamport delta', () => {
    const t = tx('pumpfun-curve-01');
    const a = derivePoolActivity(t, META.mint, META.curve);
    const traderLamports = t.lamportDeltas.get(a.trader as string) ?? 0n;
    // The seller received rent back from a closed account on top of the trade.
    assert.notEqual(traderLamports, a.quoteAmount);
    assert.equal(a.quoteAmount, -(t.lamportDeltas.get(META.curve) as bigint));
  });

  test('prices across the curve\'s trades are consistent, as a real market is', () => {
    const prices = TRADES.map((n) => derivePoolActivity(tx(n), META.mint, META.curve).priceInQuote as number);
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    assert.ok(hi / lo < 1.1, `${lo}..${hi}`);
  });

  test('a shared-authority pool with a transfer-fee token: inferred pool side, approximate trader', () => {
    const a = derivePoolActivity(tx('raydium-cpmm-transfer-fee'), RAYDIUM.mint, RAYDIUM.pool);
    assert.equal(a.kind, 'SWAP');
    assert.equal(a.direction, 'SELL');
    assert.equal(a.poolSide, RAYDIUM.vaultAuthority);
    assert.equal(a.poolSideInferred, true);
    assert.equal(a.traderResolution, 'APPROXIMATE');
    assert.ok(a.confidence < 0.7);
  });

  test('a failed transaction is FAILED, never a trade', () => {
    const a = derivePoolActivity(tx('pumpfun-curve-failed'), META.mint, META.curve);
    assert.equal(a.kind, 'FAILED');
    assert.equal(a.direction, null);
    assert.equal(a.tokenAmount, null);
  });

  test('a pool that did not move the token is NO_POOL_ACTIVITY', () => {
    const a = derivePoolActivity(tx('pumpfun-curve-01'), 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', META.curve);
    assert.equal(a.kind, 'NO_POOL_ACTIVITY');
  });

  // --- shapes the derivation must refuse, built from real structure --------

  const edited = (edit: (t: NormalizedTransaction) => void): NormalizedTransaction => {
    const t = tx('pumpfun-curve-01');
    const copy: NormalizedTransaction = {
      ...t,
      tokenBalances: t.tokenBalances.map((b) => ({ ...b })),
      lamportDeltas: new Map(t.lamportDeltas),
    };
    edit(copy);
    return copy;
  };

  test('with the pool unknown and three owners moving the token: UNRESOLVED, not chosen', () => {
    const t = edited((c) => {
      const seller = c.tokenBalances.find((b) => b.mint === META.mint && b.delta < 0n);
      assert.ok(seller);
      c.tokenBalances.push({ ...seller, account: 'Extra1111111111111111111111111111111111111', owner: 'Owner111111111111111111111111111111111111111', delta: 5n, pre: 0n, post: 5n });
    });
    const a = derivePoolActivity(t, META.mint, 'NotThePool11111111111111111111111111111111');
    assert.equal(a.kind, 'UNRESOLVED');
    assert.equal(a.reason, 'pool_side_not_found');
    assert.equal(a.confidence, 0);
  });

  test('both reserves rising is LIQUIDITY_ADDED; both falling is LIQUIDITY_REMOVED', () => {
    const added = edited((c) => c.lamportDeltas.set(META.curve, 5_000_000n));
    assert.equal(derivePoolActivity(added, META.mint, META.curve).kind, 'LIQUIDITY_ADDED');
    const removed = edited((c) => {
      for (const b of c.tokenBalances) if (b.owner === META.curve) b.delta = -b.delta;
    });
    const r = derivePoolActivity(removed, META.mint, META.curve);
    assert.equal(r.kind, 'LIQUIDITY_REMOVED');
    assert.equal(r.priceInQuote, null);
  });

  test('a pool side holding a third asset is UNRESOLVED (a shared authority across two pools)', () => {
    const t = edited((c) => {
      c.tokenBalances.push({ account: 'Vault211111111111111111111111111111111111111', owner: META.curve, mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, pre: 10n, post: 3n, delta: -7n });
    });
    const a = derivePoolActivity(t, META.mint, META.curve);
    assert.equal(a.kind, 'UNRESOLVED');
    assert.equal(a.reason, 'pool_side_mixed_assets');
  });

  test('a pool with no counter asset is UNRESOLVED', () => {
    const t = edited((c) => c.lamportDeltas.delete(META.curve));
    assert.equal(derivePoolActivity(t, META.mint, META.curve).reason, 'no_counter_asset');
  });

  test('several counterparties: the trade stands, the trader is AMBIGUOUS and not named', () => {
    const t = edited((c) => {
      const seller = c.tokenBalances.find((b) => b.mint === META.mint && b.delta < 0n);
      assert.ok(seller);
      const half = seller.delta / 2n;
      seller.delta = half;
      c.tokenBalances.push({ ...seller, account: 'Second11111111111111111111111111111111111111', owner: 'SecondOwner111111111111111111111111111111111', delta: half });
    });
    const a = derivePoolActivity(t, META.mint, META.curve);
    assert.equal(a.kind, 'SWAP');
    assert.equal(a.trader, null);
    assert.equal(a.traderResolution, 'AMBIGUOUS');
    assert.ok(a.confidence < 1);
  });
});

describe('launches', () => {
  test('a real pump.fun creation reads as a launch with a confirmed curve', () => {
    const launch = parsePumpfunLaunch(tx('pumpfun-create'));
    assert.ok(typeof launch !== 'string');
    assert.equal(launch.venue, 'pumpfun');
    assert.equal(launch.decimals, 6);
    assert.equal(launch.initialSupply, '1000000000000000');
    assert.ok(launch.pool !== null);
    assert.equal(launch.poolConfirmed, true);
    assert.equal(isOnCurve(launch.pool), false);
    assert.equal(launch.mintAuthorityRevoked, true);
    assert.equal(launch.feePayer, tx('pumpfun-create').feePayer);
    assert.ok(BigInt(launch.feePayerInitialBalance ?? '0') > 0n);
  });

  test('a trade and a failure are not launches, and say why', () => {
    assert.equal(parsePumpfunLaunch(tx('pumpfun-curve-01')), 'no_mint_created');
    assert.equal(parsePumpfunLaunch(tx('pumpfun-curve-failed')), 'failed');
    assert.equal(parsePumpfunLaunch(tx('raydium-cpmm-transfer-fee')), 'not_pumpfun');
  });

  test('the creation\'s events: pool created (derived, confirmed), supply minted and authority revoked (raw)', () => {
    const t = tx('pumpfun-create');
    const launch = parsePumpfunLaunch(t);
    assert.ok(typeof launch !== 'string');
    const created = poolCreatedEvent(launch, 'test');
    assert.ok(created);
    assert.equal(created.derived, true);
    assert.equal(created.confidence, 1);
    const facts = mintEvents(t, launch.mint, 'test');
    assert.deepEqual(facts.map((e) => e.type).sort(), ['AUTHORITY_CHANGE', 'TOKEN_MINT']);
    assert.ok(facts.every((e) => e.derived === false && e.confidence === 1));
  });
});

describe('transfer edges and canonical ids', () => {
  test('the trade leg is never an edge; only wallet-to-wallet movement is kept', () => {
    for (const name of TRADES) {
      const t = tx(name);
      const a = derivePoolActivity(t, META.mint, META.curve);
      const edges = transferEdges(t, META.mint, new Set([META.curve, a.poolSide as string]));
      for (const e of edges) {
        assert.notEqual(e.from, META.curve);
        assert.notEqual(e.to, META.curve);
        if (e.kind === 'SOL_TRANSFER') {
          assert.ok(BigInt(e.amount) >= MIN_SOL_EDGE_LAMPORTS);
          assert.equal(isOnCurve(e.from), true);
          assert.equal(isOnCurve(e.to), true);
        } else {
          assert.equal(e.asset, META.mint);
        }
      }
    }
  });

  test('no edges from a failed transaction', () => {
    assert.deepEqual(transferEdges(tx('pumpfun-curve-failed'), META.mint, new Set()), []);
  });

  test('canonical ids are stable and distinguish what differs', () => {
    assert.equal(canonicalId('SWAP', 'sig', 'pool'), canonicalId('SWAP', 'sig', 'pool'));
    assert.notEqual(canonicalId('SWAP', 'sig', 'pool'), canonicalId('SWAP', 'sig', 'pool2'));
    assert.notEqual(canonicalId('SWAP', 'a|b', null), canonicalId('SWAP', 'a', 'b'));
    assert.match(canonicalId('X'), /^[0-9a-f]{32}$/);
  });
});

describe('the processing budget', () => {
  const now = 1_800_000_000_000;
  const at = (mint: string, eligibility: 'QUALIFIED' | 'WATCH' | 'REJECTED' | 'INSUFFICIENT_DATA', extra: Partial<{ at: number; pool: string | null; liquidity: number }> = {}) => {
    const s = snapshot({ mint, eligibility, state: eligibility === 'REJECTED' ? 'REJECTED' : eligibility === 'WATCH' ? 'WATCH' : 'QUALIFIED', at: extra.at ?? now, liquidityUsd: extra.liquidity ?? 10_000 });
    return { ...s, pair: extra.pool === null ? null : { ...(s.pair as NonNullable<typeof s.pair>), pairAddress: extra.pool ?? `pool-${mint}` } };
  };

  test('only survivors are collected; each exclusion is counted by reason', () => {
    const plan = planDeepCollection({
      tokens: [
        at('a', 'QUALIFIED'),
        at('b', 'WATCH'),
        at('c', 'REJECTED'),
        at('d', 'INSUFFICIENT_DATA'),
        at('e', 'QUALIFIED', { at: now - 3 * 3_600_000 }),
        at('f', 'QUALIFIED', { pool: null }),
      ],
      lastCollectedAt: () => null,
      launchPool: () => null,
      tokensPerCycle: 10,
      liveWindowMs: 90 * 60_000,
      now,
    });
    assert.deepEqual(plan.work.map((w) => w.mint), ['a', 'b']);
    assert.deepEqual(plan.skipped, { notSurvivor: 2, notLive: 1, noPool: 1, overBudget: 0 });
  });

  test('QUALIFIED first, then the pool collected longest ago, then liquidity; the rest wait', () => {
    const last = new Map([['pool-q1', now - 1_000], ['pool-q2', now - 50_000]]);
    const plan = planDeepCollection({
      tokens: [at('w1', 'WATCH'), at('q1', 'QUALIFIED'), at('q2', 'QUALIFIED'), at('q3', 'QUALIFIED', { liquidity: 1 }), at('q4', 'QUALIFIED', { liquidity: 99 })],
      lastCollectedAt: (pool) => last.get(pool) ?? null,
      launchPool: () => null,
      tokensPerCycle: 4,
      liveWindowMs: 90 * 60_000,
      now,
    });
    // Never collected (q4 deeper than q3) before collected long ago (q2) before recently (q1).
    assert.deepEqual(plan.work.map((w) => w.mint), ['q4', 'q3', 'q2', 'q1']);
    assert.equal(plan.skipped.overBudget, 1);
  });

  test('a token with no market pair uses its on-chain launch pool', () => {
    const plan = planDeepCollection({
      tokens: [at('x', 'QUALIFIED', { pool: null })],
      lastCollectedAt: () => null,
      launchPool: (mint) => (mint === 'x' ? 'curve-x' : null),
      tokensPerCycle: 1,
      liveWindowMs: 90 * 60_000,
      now,
    });
    assert.deepEqual(plan.work, [{ mint: 'x', pool: 'curve-x', tier: 'QUALIFIED' }]);
  });
});
