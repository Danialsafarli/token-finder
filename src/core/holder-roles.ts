/**
 * Who the largest holders are, not just how much they hold.
 *
 * `getTokenLargestAccounts` returns token accounts, and on a new token the
 * largest is usually not a person: it is the bonding curve, the AMM pool's
 * vault, or some program's account. Raw top-10 concentration counts all of
 * them, so on a fresh pump.fun launch it reads ~100% - true, and meaningless
 * as a statement about insiders.
 *
 * This labels each large account by its owner's role, where the evidence is
 * reliable, and computes a second, role-aware figure beside the raw one. It
 * does not replace the raw figure, and nothing in the gate or the score reads
 * this: changing rejection policy is a later, deliberate decision.
 *
 * Roles, and what each rests on:
 *
 * | Role | Evidence |
 * |---|---|
 * | BONDING_CURVE | the owner is the curve a launch record names |
 * | POOL | the owner is a pool address a market provider or collected activity names |
 * | PROGRAM_OWNED | the owner is off the ed25519 curve - a PDA - and is not a known pool |
 * | WALLET | the owner is on the curve: a keypair (a person, a bot, an exchange) |
 * | UNKNOWN | the owner could not be read |
 *
 * WALLET is deliberately not "insider": an exchange's custody wallet is a
 * wallet too. The label says what the account is, not whose.
 */

import { isOnCurve } from '../chain/address.ts';
import { exactRatio } from '../util/num.ts';

export type HolderRole = 'BONDING_CURVE' | 'POOL' | 'PROGRAM_OWNED' | 'WALLET' | 'UNKNOWN';

export interface RoledHolder {
  tokenAccount: string;
  owner: string | null;
  role: HolderRole;
  /** Share of total supply, 0-1. */
  share: number | null;
}

export interface HolderRoles {
  holders: RoledHolder[];
  /** Top-10 share with every account counted - the raw figure, unchanged. */
  rawTop10Share: number | null;
  /** Top-10 share among WALLET-owned accounts only; null when any owner was unreadable. */
  walletTop10Share: number | null;
  /** Share of supply in each non-wallet role, among the accounts returned. */
  byRole: Record<HolderRole, number>;
  /** How many accounts' owners were resolved, of those returned. */
  resolved: number;
  total: number;
}

export interface HolderInput {
  tokenAccount: string;
  amount: bigint;
}

export function classifyHolderRoles(
  holders: HolderInput[],
  owners: Map<string, string | null>,
  rawSupply: bigint | null,
  known: { pools: ReadonlySet<string>; curves: ReadonlySet<string> },
): HolderRoles {
  const roled: (RoledHolder & { amount: bigint })[] = holders.map((h) => {
    const owner = owners.get(h.tokenAccount) ?? null;
    let role: HolderRole;
    if (owner === null) role = 'UNKNOWN';
    else if (known.curves.has(owner)) role = 'BONDING_CURVE';
    else if (known.pools.has(owner)) role = 'POOL';
    else if (isOnCurve(owner) === false) role = 'PROGRAM_OWNED';
    else if (isOnCurve(owner) === true) role = 'WALLET';
    else role = 'UNKNOWN';
    const share = rawSupply !== null && rawSupply > 0n ? exactRatio(h.amount, rawSupply) : null;
    return { tokenAccount: h.tokenAccount, owner, role, share, amount: h.amount };
  });
  roled.sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0));

  const sumShare = (list: typeof roled): number | null => {
    if (rawSupply === null || rawSupply <= 0n) return null;
    return exactRatio(list.reduce((s, h) => s + h.amount, 0n), rawSupply);
  };
  const byRole: Record<HolderRole, number> = { BONDING_CURVE: 0, POOL: 0, PROGRAM_OWNED: 0, WALLET: 0, UNKNOWN: 0 };
  for (const h of roled) if (h.share !== null) byRole[h.role] += h.share;

  return {
    holders: roled.map(({ amount: _amount, ...rest }) => rest),
    rawTop10Share: sumShare(roled.slice(0, 10)),
    // An account whose owner could not be read may be a wallet, so the
    // wallet-only figure is not stated at all rather than stated low.
    walletTop10Share: roled.some((h) => h.role === 'UNKNOWN') ? null : sumShare(roled.filter((h) => h.role === 'WALLET').slice(0, 10)),
    byRole,
    resolved: roled.filter((h) => h.owner !== null).length,
    total: roled.length,
  };
}
