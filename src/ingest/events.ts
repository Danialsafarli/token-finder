/**
 * The canonical event model.
 *
 * One vocabulary for everything the backbone observes, whichever source it
 * came from. Every event carries the same provenance, and every event has a
 * canonical id derived from what it *is*, so the same fact observed twice -
 * a restart, an overlapping page, a second source - is one row, not two.
 *
 * ## Implemented, and why only these
 *
 * | Type | Evidence | Raw or derived |
 * |---|---|---|
 * | TOKEN_DISCOVERED | a feed or the chain surfaced the mint | raw (a sighting) |
 * | POOL_CREATED | a pump.fun creation: the curve holding the minted supply | derived, confirmed by account creation |
 * | TOKEN_MINT | a parsed `mintTo` | raw |
 * | AUTHORITY_CHANGE | a parsed `setAuthority` | raw |
 * | LIQUIDITY_ADDED / LIQUIDITY_REMOVED | both pool reserves moved the same way | derived |
 * | SWAP | pool reserves moved in opposite directions | derived, stored in `swaps` |
 * | TOKEN_TRANSFER | a parsed token `transfer`/`transferChecked` | raw, stored in `transfer_edges` |
 * | SOL_TRANSFER | a parsed system `transfer` | raw, stored in `transfer_edges` |
 * | HOLDER_SNAPSHOT / MARKET_SNAPSHOT | a scan's provider readings | already stored in `holder_snapshots` / `market_snapshots` |
 *
 * **Not implemented: WALLET_FUNDED.** "Funded" is a claim about the first SOL
 * a wallet ever received, which needs that wallet's own history. The SOL
 * transfers stored here are its raw input; the interpretation belongs to the
 * wallet-graph phase and is not made here.
 *
 * ## Provenance every event carries
 *
 * `source` (which endpoint), `observed_at` (chain time when the chain says so,
 * otherwise when the source reported it), `recorded_at` (when we wrote it),
 * `derived` (0 raw, 1 interpreted) and `confidence` (1 for raw facts).
 */

import { createHash } from 'node:crypto';

export type CanonicalEventType =
  | 'TOKEN_DISCOVERED'
  | 'POOL_CREATED'
  | 'LIQUIDITY_ADDED'
  | 'LIQUIDITY_REMOVED'
  | 'SWAP'
  | 'TOKEN_TRANSFER'
  | 'SOL_TRANSFER'
  | 'TOKEN_MINT'
  | 'AUTHORITY_CHANGE'
  | 'HOLDER_SNAPSHOT'
  | 'MARKET_SNAPSHOT';

/** Event types the model defines but deliberately does not produce yet. */
export const NOT_IMPLEMENTED_EVENTS = ['WALLET_FUNDED'] as const;

/** A low-volume chain event, stored in `chain_events`. */
export interface ChainEvent {
  id: string;
  type: Extract<CanonicalEventType, 'POOL_CREATED' | 'LIQUIDITY_ADDED' | 'LIQUIDITY_REMOVED' | 'TOKEN_MINT' | 'AUTHORITY_CHANGE'>;
  mint: string | null;
  signature: string;
  slot: number;
  observedAt: number | null;
  pool: string | null;
  /** Who acted: the fee payer, the previous authority, the trader. */
  actor: string | null;
  /** Raw amount as a decimal string, when the event has one. */
  amount: string | null;
  /** A few bounded facts; never a provider response. */
  detail: Record<string, string | number | boolean | null>;
  derived: boolean;
  confidence: number;
  source: string;
}

/** A raw movement between two owners, stored in `transfer_edges`. */
export interface TransferEdge {
  id: string;
  signature: string;
  path: string;
  slot: number;
  blockTimeMs: number | null;
  kind: 'TOKEN_TRANSFER' | 'SOL_TRANSFER';
  asset: string;
  from: string;
  to: string;
  amount: string;
}

/**
 * Canonical id: a hash of the fields that make two observations the same fact.
 * Stable across restarts and sources, so an INSERT OR IGNORE deduplicates.
 */
export function canonicalId(type: string, ...parts: (string | number | null)[]): string {
  return createHash('sha256')
    .update([type, ...parts.map((p) => (p === null ? '' : String(p)))].join('|'))
    .digest('hex')
    .slice(0, 32);
}
