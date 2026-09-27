/**
 * Holder-role awareness: raw and role-adjusted concentration side by side,
 * with the rejection policy untouched.
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyHolderRoles } from '../src/core/holder-roles.ts';
import { cleanupTempDirs, harness, legacyOnchain, snapshot } from './persist-helpers.ts';
import { pda, wallet } from './intel-helpers.ts';

after(cleanupTempDirs);

const SUPPLY = 1_000_000n;
const curve = pda('holders-curve');
const pool = pda('holders-pool');

function sample(unreadable = false) {
  const accounts = ['c', 'p', 'w1', 'w2', 'x'].map((k) => pda(`acct-${k}`));
  const owners = new Map<string, string | null>([
    [accounts[0] as string, curve],
    [accounts[1] as string, pool],
    [accounts[2] as string, wallet('holder-1')],
    [accounts[3] as string, unreadable ? null : wallet('holder-2')],
    [accounts[4] as string, pda('some-program')],
  ]);
  const holders = [800_000n, 100_000n, 50_000n, 30_000n, 20_000n].map((amount, i) => ({ tokenAccount: accounts[i] as string, amount }));
  return classifyHolderRoles(holders, owners, SUPPLY, { pools: new Set([pool]), curves: new Set([curve]) });
}

describe('holder roles', () => {
  test('the raw figure is kept, and the wallet-only figure is computed beside it', () => {
    const r = sample();
    assert.equal(r.rawTop10Share, 1);
    assert.equal(r.walletTop10Share, 0.08);
    assert.deepEqual(r.holders.map((h) => h.role), ['BONDING_CURVE', 'POOL', 'WALLET', 'WALLET', 'PROGRAM_OWNED']);
    assert.equal(r.byRole.BONDING_CURVE, 0.8);
  });

  test('an unreadable owner leaves the wallet-only figure unmeasured, not low', () => {
    const r = sample(true);
    assert.equal(r.walletTop10Share, null);
    assert.equal(r.resolved, 4);
    assert.equal(r.rawTop10Share, 1, 'the raw figure does not depend on owners');
  });

  test('both figures are stored, the raw one unchanged', () => {
    const h = harness();
    const roles = sample();
    const token = snapshot({ mint: pda('holders-mint') });
    const onchain = { ...legacyOnchain(), top10Share: 1, holderRoles: roles };
    h.repo.saveTokenSnapshot({ ...token, jupiter: null, onchain }, { scanId: null });
    const row = h.db.prepare('SELECT top_holders_pct, wallet_top10_pct, role_breakdown FROM holder_snapshots').get() as Record<string, unknown>;
    assert.equal(row.top_holders_pct, 100);
    assert.equal(row.wallet_top10_pct, 8);
    assert.equal(JSON.parse(String(row.role_breakdown)).byRole.POOL, 0.1);
    h.close();
  });

  test('rejection policy is untouched: nothing in scoring, the gate or ranking reads holder roles', () => {
    const core = join(import.meta.dirname, '..', 'src', 'core');
    const readers = readdirSync(core)
      .filter((f) => f.endsWith('.ts') && f !== 'holder-roles.ts')
      .filter((f) => /holderRoles|walletTop10Share/.test(readFileSync(join(core, f), 'utf8')));
    assert.deepEqual(readers, []);
  });
});
