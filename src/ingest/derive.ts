/**
 * Transfer edges and chain events from a normalized transaction.
 *
 * Pure, so every rule about what is kept is testable against real fixtures.
 *
 * ## What counts as a relevant transfer edge
 *
 * Kept, because the wallet-graph phase needs them and nothing else records them:
 * - a transfer of the **tracked mint** between two owners, neither of them the
 *   pool - tokens moving wallet to wallet, the shape of distribution to
 *   sybils or of consolidation;
 * - a **SOL** transfer between two keypair (on-curve) accounts of at least
 *   {@link MIN_SOL_EDGE_LAMPORTS} - wallet-to-wallet funding.
 *
 * Not kept, deliberately:
 * - the trade leg between trader and pool, which `pool_activity` already holds
 *   exactly;
 * - SOL moving to or from program-derived accounts (pool reserves, fee vaults,
 *   rent deposits);
 * - SOL below the floor, which on real traffic is fees and tips - thousands a
 *   minute on a busy pool, and noise to a funding graph.
 */

import { isOnCurve } from '../chain/address.ts';
import { canonicalId, type ChainEvent, type TransferEdge } from './events.ts';
import type { NormalizedTransaction } from './normalize.ts';
import type { LaunchRecord } from './launch.ts';

/** 0.01 SOL. Below this a SOL transfer is overwhelmingly a fee or a tip. */
export const MIN_SOL_EDGE_LAMPORTS = 10_000_000n;

/** Memoized on-curve test: the same addresses recur across a cycle. */
const curveCache = new Map<string, boolean | null>();
export function onCurve(address: string): boolean | null {
  let hit = curveCache.get(address);
  if (hit === undefined) {
    hit = isOnCurve(address);
    if (curveCache.size > 50_000) curveCache.clear();
    curveCache.set(address, hit);
  }
  return hit;
}

export function transferEdges(
  tx: NormalizedTransaction,
  mint: string,
  excluded: ReadonlySet<string>,
): TransferEdge[] {
  const edges: TransferEdge[] = [];
  if (tx.status !== 'SUCCESS') return edges;

  for (const t of tx.tokenTransfers) {
    if (t.mint !== mint || t.sourceOwner === null || t.destinationOwner === null) continue;
    if (t.sourceOwner === t.destinationOwner) continue;
    if (excluded.has(t.sourceOwner) || excluded.has(t.destinationOwner)) continue;
    edges.push({
      id: canonicalId('TOKEN_TRANSFER', tx.signature, t.path),
      signature: tx.signature,
      path: t.path,
      slot: tx.slot,
      blockTimeMs: tx.blockTimeMs,
      kind: 'TOKEN_TRANSFER',
      asset: mint,
      from: t.sourceOwner,
      to: t.destinationOwner,
      amount: t.amount.toString(),
    });
  }

  for (const t of tx.solTransfers) {
    if (t.lamports < MIN_SOL_EDGE_LAMPORTS || t.from === t.to) continue;
    if (excluded.has(t.from) || excluded.has(t.to)) continue;
    if (onCurve(t.from) !== true || onCurve(t.to) !== true) continue;
    edges.push({
      id: canonicalId('SOL_TRANSFER', tx.signature, t.path),
      signature: tx.signature,
      path: t.path,
      slot: tx.slot,
      blockTimeMs: tx.blockTimeMs,
      kind: 'SOL_TRANSFER',
      asset: 'SOL',
      from: t.from,
      to: t.to,
      amount: t.lamports.toString(),
    });
  }

  return edges;
}

/**
 * Supply minted and authorities changed for one mint in a transaction. Both
 * are raw facts the node parsed; neither is a judgement.
 */
export function mintEvents(tx: NormalizedTransaction, mint: string, source: string): ChainEvent[] {
  const events: ChainEvent[] = [];
  if (tx.status !== 'SUCCESS') return events;
  for (const m of tx.mintTos) {
    if (m.mint !== mint) continue;
    events.push({
      id: canonicalId('TOKEN_MINT', tx.signature, m.path),
      type: 'TOKEN_MINT',
      mint,
      signature: tx.signature,
      slot: tx.slot,
      observedAt: tx.blockTimeMs,
      pool: null,
      actor: m.authority,
      amount: m.amount.toString(),
      detail: { account: m.account },
      derived: false,
      confidence: 1,
      source,
    });
  }
  for (const a of tx.authorityChanges) {
    if (a.target !== mint) continue;
    events.push({
      id: canonicalId('AUTHORITY_CHANGE', tx.signature, a.path),
      type: 'AUTHORITY_CHANGE',
      mint,
      signature: tx.signature,
      slot: tx.slot,
      observedAt: tx.blockTimeMs,
      pool: null,
      actor: a.previousAuthority,
      amount: null,
      detail: { authorityType: a.authorityType, newAuthority: a.newAuthority, revoked: a.newAuthority === null },
      derived: false,
      confidence: 1,
      source,
    });
  }
  return events;
}

/** The pool a launch created, as an event. Confirmed or not, it says which. */
export function poolCreatedEvent(launch: LaunchRecord, source: string): ChainEvent | null {
  if (launch.pool === null) return null;
  return {
    id: canonicalId('POOL_CREATED', launch.signature, launch.mint, launch.pool),
    type: 'POOL_CREATED',
    mint: launch.mint,
    signature: launch.signature,
    slot: launch.slot,
    observedAt: launch.blockTimeMs,
    pool: launch.pool,
    actor: launch.feePayer,
    amount: launch.initialSupply,
    detail: { venue: launch.venue, confirmed: launch.poolConfirmed },
    derived: true,
    confidence: launch.poolConfirmed ? 1 : 0.7,
    source,
  };
}
