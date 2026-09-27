/**
 * Reads a token launch out of a creation transaction.
 *
 * Only pump.fun is recognised today, and only from facts the node itself
 * parsed - no instruction data is decoded by hand:
 *
 * - the program: pump.fun's program id is among those invoked;
 * - the mint: an `initializeMint`/`initializeMint2` whose mint authority is
 *   pump.fun's mint-authority PDA;
 * - the supply: the `mintTo` amounts for that mint;
 * - the bonding curve: the owner of the token account the supply was minted
 *   into. That is cross-checked against the account the transaction created
 *   for pump.fun's program, and the launch says whether the two agree.
 *
 * The launch records the fee payer, not a "creator". pump.fun's instruction
 * names a creator in data this module does not decode; the fee payer is who
 * paid for the creation, which usually - not always - is the same party. The
 * column is named for what it is.
 */

import { PUMPFUN_MINT_AUTHORITY, PUMPFUN_PROGRAM, type LaunchVenue } from '../chain/programs.ts';
import type { NormalizedTransaction } from './normalize.ts';

export interface LaunchRecord {
  mint: string;
  venue: LaunchVenue;
  signature: string;
  slot: number;
  blockTimeMs: number | null;
  feePayer: string;
  tokenProgram: string;
  decimals: number | null;
  /** Raw supply minted in the creation, as a decimal string. */
  initialSupply: string | null;
  /** The bonding curve holding the supply. */
  pool: string | null;
  /** Whether the curve was confirmed by the account created for pump.fun's program. */
  poolConfirmed: boolean;
  /** The fee payer's own holding at the end of the creation - their initial buy. */
  feePayerInitialBalance: string | null;
  /** Mint authority revoked in the same transaction. */
  mintAuthorityRevoked: boolean;
}

export type LaunchRejection = 'failed' | 'not_pumpfun' | 'no_mint_created';

export function parsePumpfunLaunch(tx: NormalizedTransaction): LaunchRecord | LaunchRejection {
  if (tx.status === 'FAILED') return 'failed';
  if (!tx.programIds.includes(PUMPFUN_PROGRAM)) return 'not_pumpfun';

  const init = tx.mintInits.find((m) => m.mintAuthority === PUMPFUN_MINT_AUTHORITY);
  if (init === undefined) return 'no_mint_created';
  const mint = init.mint;

  const mints = tx.mintTos.filter((m) => m.mint === mint);
  const supply = mints.reduce((sum, m) => sum + m.amount, 0n);

  // The account the supply went into, and who owns it.
  const largest = [...mints].sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0))[0];
  const ownerOf = (account: string): string | null =>
    tx.tokenAccountInits.find((t) => t.account === account)?.owner ??
    tx.tokenBalances.find((b) => b.account === account)?.owner ??
    null;
  const pool = largest === undefined ? null : ownerOf(largest.account);
  const poolConfirmed =
    pool !== null && tx.accountCreations.some((c) => c.account === pool && c.owner === PUMPFUN_PROGRAM);

  const feePayerBalance = tx.tokenBalances
    .filter((b) => b.mint === mint && b.owner === tx.feePayer)
    .reduce((sum, b) => sum + b.post, 0n);

  return {
    mint,
    venue: 'pumpfun',
    signature: tx.signature,
    slot: tx.slot,
    blockTimeMs: tx.blockTimeMs,
    feePayer: tx.feePayer,
    tokenProgram: init.tokenProgram,
    decimals: init.decimals,
    initialSupply: mints.length === 0 ? null : supply.toString(),
    pool,
    poolConfirmed,
    feePayerInitialBalance: feePayerBalance.toString(),
    mintAuthorityRevoked: tx.authorityChanges.some(
      (a) => a.target === mint && a.authorityType === 'mintTokens' && a.newAuthority === null,
    ),
  };
}
