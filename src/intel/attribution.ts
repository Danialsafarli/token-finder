/**
 * Who launched a token: separate roles, each with its evidence.
 *
 * The fee payer of a creation is not assumed to be its creator. A relayer can
 * pay for someone else's launch; a launchpad's program can hold the mint
 * authority. So the roles are kept apart:
 *
 * | Role | Read from | Nature |
 * |---|---|---|
 * | feePayer | the creation's fee payer | raw |
 * | deployers | the creation's signers, less the new mint's own keypair | raw |
 * | mintAuthority | `initializeMint` | raw; labelled program or wallet by the on-curve test |
 * | freezeAuthority | `initializeMint` | raw |
 * | liquidityCreator | who funded the pool account's creation | raw |
 * | creator | derived from the above | attributed, with a confidence |
 *
 * Attribution rules:
 * - one deployer who also paid the fee and funded the pool: ATTRIBUTED, 0.85;
 * - one deployer, fee paid by another account: ATTRIBUTED to the deployer,
 *   0.6 - the payer is a relayer or a service;
 * - several deployers: AMBIGUOUS, no creator, the candidates listed;
 * - no creation transaction: UNKNOWN.
 */

import { isOnCurve } from '../chain/address.ts';
import type { NormalizedTransaction } from '../ingest/normalize.ts';

export type AttributionStatus = 'ATTRIBUTED' | 'AMBIGUOUS' | 'UNKNOWN';

export interface Attribution {
  mint: string;
  status: AttributionStatus;
  creator: string | null;
  confidence: number;
  basis: string;
  feePayer: string | null;
  deployers: string[];
  mintAuthority: string | null;
  mintAuthorityRole: 'program' | 'wallet' | null;
  freezeAuthority: string | null;
  liquidityCreator: string | null;
  /** Filled later from the funding graph, when the creator's first funder is known. */
  initialFunder: string | null;
  signature: string | null;
  evidence: string[];
}

export function unknownAttribution(mint: string, basis: string): Attribution {
  return {
    mint,
    status: 'UNKNOWN',
    creator: null,
    confidence: 0,
    basis,
    feePayer: null,
    deployers: [],
    mintAuthority: null,
    mintAuthorityRole: null,
    freezeAuthority: null,
    liquidityCreator: null,
    initialFunder: null,
    signature: null,
    evidence: [],
  };
}

/**
 * @param pool the pool or curve the creation set up, when known; its funder
 *   is the liquidity creator.
 */
export function attributeCreation(tx: NormalizedTransaction, mint: string, pool: string | null): Attribution {
  const init = tx.mintInits.find((m) => m.mint === mint);
  if (tx.status !== 'SUCCESS' || init === undefined) {
    return unknownAttribution(mint, 'the transaction did not create this mint');
  }
  const deployers = tx.signers.filter((s) => s !== mint);
  const liquidityCreator = pool === null ? null : (tx.accountCreations.find((c) => c.account === pool)?.funder ?? null);
  const authorityOnCurve = init.mintAuthority === null ? null : isOnCurve(init.mintAuthority);
  const base = {
    mint,
    feePayer: tx.feePayer,
    deployers,
    mintAuthority: init.mintAuthority,
    mintAuthorityRole: authorityOnCurve === null ? null : authorityOnCurve ? ('wallet' as const) : ('program' as const),
    freezeAuthority: init.freezeAuthority,
    liquidityCreator,
    initialFunder: null,
    signature: tx.signature,
    evidence: [tx.signature],
  };

  if (deployers.length === 1) {
    const deployer = deployers[0] as string;
    if (deployer === tx.feePayer && (liquidityCreator === null || liquidityCreator === deployer)) {
      return {
        ...base,
        status: 'ATTRIBUTED',
        creator: deployer,
        confidence: 0.85,
        basis: liquidityCreator === null ? 'the only signer, and it paid for the creation' : 'the only signer: it paid for the creation and funded the pool',
      };
    }
    return {
      ...base,
      status: 'ATTRIBUTED',
      creator: deployer,
      confidence: 0.6,
      basis: 'signed the creation; a different account paid its fee',
    };
  }
  if (deployers.length > 1) {
    return { ...base, status: 'AMBIGUOUS', creator: null, confidence: 0, basis: `${deployers.length} signers; which one is the creator cannot be told from the transaction` };
  }
  return { ...base, status: 'UNKNOWN', creator: null, confidence: 0, basis: 'no signer other than the mint itself' };
}
