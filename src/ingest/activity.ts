/**
 * What a transaction did to one pool, derived from balance changes.
 *
 * ## Why pool-anchored
 *
 * The obvious reading - "the fee payer's balance of the token went up, so the
 * fee payer bought" - is wrong often enough on real Solana traffic to be
 * unusable. The captured fixtures show all three failure modes:
 *
 * - **Relayed and routed trades.** The fee payer is a relayer or a router, and
 *   a different wallet receives the tokens (`pumpfun-curve-08`, `-10`).
 * - **Polluted SOL deltas.** A seller's lamport change includes the rent
 *   refunded when their token account closes, the priority fee and tips, so it
 *   overstates the SOL the trade paid (`pumpfun-curve-01`).
 * - **Multi-hop routes.** A route through an aggregator touches several pools
 *   and intermediate accounts in one transaction.
 *
 * The pool's own balance change has none of those problems: it is exactly what
 * the trade moved in and out of the pool's reserves. So the pool is the anchor.
 *
 *   pool gains the token, loses the other asset   ->  a SELL into the pool
 *   pool loses the token, gains the other asset   ->  a BUY from the pool
 *   pool gains both                               ->  LIQUIDITY_ADDED
 *   pool loses both                               ->  LIQUIDITY_REMOVED
 *
 * The trader is then the one owner whose change in the token mirrors the
 * pool's. Anything the balances do not settle is UNRESOLVED with the reason,
 * never a guess.
 *
 * ## The pool's "other asset"
 *
 * SOL is counted as one asset whether the pool holds it natively (a pump.fun
 * bonding curve holds lamports on its own account) or wrapped in a vault token
 * account (an AMM): the pool's lamport change plus its WSOL change. That makes
 * both designs read the same way, and it is why the pool-side amount excludes
 * the fees a pump.fun trader pays to other accounts - it is the reserve change,
 * which is the trade's price basis.
 *
 * ## Known limits, stated
 *
 * - A pool whose vaults are owned by a program-wide authority (Raydium's AMM
 *   v4, CPMM) is recognised only when exactly two owners moved the token and
 *   the authority's changes involve exactly two assets; a route through two
 *   pools of the same program is UNRESOLVED ('pool_side_mixed_assets').
 * - The creation of a pump.fun curve reads as LIQUIDITY_ADDED whose SOL side
 *   includes the account's rent deposit. Launch records carry the creation
 *   itself; see `launch.ts`.
 */

import { isOnCurve } from '../chain/address.ts';
import { SOL_DECIMALS, WSOL_MINT } from '../chain/programs.ts';
import type { NormalizedTransaction } from './normalize.ts';

export type ActivityKind =
  | 'SWAP'
  | 'LIQUIDITY_ADDED'
  | 'LIQUIDITY_REMOVED'
  /** The pool took part but the balances do not settle what happened. */
  | 'UNRESOLVED'
  /** The transaction did not change the pool's holding of the token. */
  | 'NO_POOL_ACTIVITY'
  /** The transaction failed on-chain: it moved nothing but fees. */
  | 'FAILED';

export type UnresolvedReason =
  | 'pool_side_not_found'
  | 'pool_side_mixed_assets'
  | 'no_counter_asset';

export type TraderResolution =
  /** Exactly one owner mirrors the pool's change, to the base unit. */
  | 'EXACT'
  /** Exactly one owner moved the opposite way, by a different amount (fees, a transfer-fee extension). */
  | 'APPROXIMATE'
  /** Several owners moved the opposite way. */
  | 'AMBIGUOUS'
  /** Nobody outside the pool ended with a net change: a route or an arbitrage through this pool. */
  | 'NET_ZERO';

export interface PoolActivity {
  kind: ActivityKind;
  reason: UnresolvedReason | null;
  mint: string;
  pool: string;
  /** The owner whose balances stand for the pool. Usually `pool` itself. */
  poolSide: string | null;
  poolSideInferred: boolean;
  direction: 'BUY' | 'SELL' | null;
  trader: string | null;
  traderResolution: TraderResolution | null;
  feePayer: string;
  tokenAmount: bigint | null;
  tokenDecimals: number | null;
  /** The other asset's mint; SOL (native or wrapped) is reported as WSOL. */
  quoteMint: string | null;
  quoteAmount: bigint | null;
  quoteDecimals: number | null;
  /** Quote per whole token, from the reserve change. A derived figure. */
  priceInQuote: number | null;
  /** 0-1: how much of this reading rests on inference rather than balances. */
  confidence: number;
}

function add(map: Map<string, bigint>, key: string, value: bigint): void {
  map.set(key, (map.get(key) ?? 0n) + value);
}

/** Net change per asset for one owner; SOL folds native lamports into WSOL. */
function assetDeltasOf(tx: NormalizedTransaction, owner: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const b of tx.tokenBalances) if (b.owner === owner && b.delta !== 0n) add(out, b.mint, b.delta);
  const lamports = tx.lamportDeltas.get(owner);
  if (lamports !== undefined && lamports !== 0n) add(out, WSOL_MINT, lamports);
  for (const [asset, value] of [...out]) if (value === 0n) out.delete(asset);
  return out;
}

function tokenDeltasByOwner(tx: NormalizedTransaction, mint: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const b of tx.tokenBalances) {
    if (b.mint !== mint || b.delta === 0n || b.owner === null) continue;
    add(out, b.owner, b.delta);
  }
  for (const [owner, value] of [...out]) if (value === 0n) out.delete(owner);
  return out;
}

const abs = (value: bigint): bigint => (value < 0n ? -value : value);

function price(quote: bigint, quoteDecimals: number, token: bigint, tokenDecimals: number): number | null {
  if (token === 0n) return null;
  const q = Number(quote) / 10 ** quoteDecimals;
  const t = Number(token) / 10 ** tokenDecimals;
  const value = q / t;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Reads what `tx` did to `pool` for `mint`.
 *
 * `pool` is the account whose history was queried - for a pump.fun curve the
 * curve account, for an AMM the pool (pair) address. When the pool does not
 * itself own the reserves, the pool side is inferred only in the one shape
 * that leaves no doubt; otherwise the reading is UNRESOLVED.
 */
export function derivePoolActivity(tx: NormalizedTransaction, mint: string, pool: string): PoolActivity {
  const base: PoolActivity = {
    kind: 'NO_POOL_ACTIVITY',
    reason: null,
    mint,
    pool,
    poolSide: null,
    poolSideInferred: false,
    direction: null,
    trader: null,
    traderResolution: null,
    feePayer: tx.feePayer,
    tokenAmount: null,
    tokenDecimals: tx.decimalsByMint.get(mint) ?? null,
    quoteMint: null,
    quoteAmount: null,
    quoteDecimals: null,
    priceInQuote: null,
    confidence: 1,
  };

  if (tx.status === 'FAILED') return { ...base, kind: 'FAILED' };

  const byOwner = tokenDeltasByOwner(tx, mint);
  if (byOwner.size === 0) return base;

  // --- the pool side -----------------------------------------------------
  let poolSide: string | null = byOwner.has(pool) ? pool : null;
  let inferred = false;
  if (poolSide === null) {
    // One shape only: exactly two owners moved the token, in opposite
    // directions, and exactly one of them is a program-derived account - the
    // program-wide vault authority of a Raydium-style pool. The amounts need
    // not match: a Token-2022 transfer fee withholds part of what the trader
    // sends (fixture raydium-cpmm-transfer-fee). Anything looser would be
    // choosing a pool, not finding one.
    const moved = [...byOwner.entries()];
    if (moved.length === 2) {
      const [a, b] = moved as [[string, bigint], [string, bigint]];
      const offCurve = moved.filter(([owner]) => isOnCurve(owner) === false);
      if (a[1] > 0n !== b[1] > 0n && offCurve.length === 1) {
        poolSide = (offCurve[0] as [string, bigint])[0];
        inferred = true;
      }
    }
  }
  if (poolSide === null) return { ...base, kind: 'UNRESOLVED', reason: 'pool_side_not_found', confidence: 0 };

  const poolToken = byOwner.get(poolSide) ?? 0n;
  if (poolToken === 0n) return base;

  const counter = [...assetDeltasOf(tx, poolSide)].filter(([asset]) => asset !== mint);
  if (counter.length === 0) {
    return { ...base, kind: 'UNRESOLVED', reason: 'no_counter_asset', poolSide, poolSideInferred: inferred, confidence: 0 };
  }
  if (counter.length > 1) {
    return { ...base, kind: 'UNRESOLVED', reason: 'pool_side_mixed_assets', poolSide, poolSideInferred: inferred, confidence: 0 };
  }

  const [quoteMint, quoteDelta] = counter[0] as [string, bigint];
  const quoteDecimals = quoteMint === WSOL_MINT ? SOL_DECIMALS : (tx.decimalsByMint.get(quoteMint) ?? null);
  const tokenAmount = abs(poolToken);
  const quoteAmount = abs(quoteDelta);
  const tokenDecimals = base.tokenDecimals;
  const common = {
    ...base,
    poolSide,
    poolSideInferred: inferred,
    tokenAmount,
    quoteMint,
    quoteAmount,
    quoteDecimals,
    priceInQuote:
      quoteDecimals === null || tokenDecimals === null ? null : price(quoteAmount, quoteDecimals, tokenAmount, tokenDecimals),
  };

  if ((poolToken > 0n) === (quoteDelta > 0n)) {
    // Both reserves moved the same way: liquidity, not a trade.
    return {
      ...common,
      kind: poolToken > 0n ? 'LIQUIDITY_ADDED' : 'LIQUIDITY_REMOVED',
      priceInQuote: null,
      confidence: inferred ? 0.6 : 0.9,
    };
  }

  // --- a trade: who was on the other side ---------------------------------
  const others = [...byOwner.entries()].filter(([owner]) => owner !== poolSide);
  const mirror = others.filter(([, delta]) => delta === -poolToken);
  const opposite = others.filter(([, delta]) => (delta > 0n) !== (poolToken > 0n));

  let trader: string | null = null;
  let resolution: TraderResolution;
  if (mirror.length === 1) {
    trader = (mirror[0] as [string, bigint])[0];
    resolution = 'EXACT';
  } else if (opposite.length === 1) {
    trader = (opposite[0] as [string, bigint])[0];
    resolution = 'APPROXIMATE';
  } else if (opposite.length === 0) {
    resolution = 'NET_ZERO';
  } else {
    resolution = 'AMBIGUOUS';
  }

  let confidence = inferred ? 0.7 : 1;
  if (resolution === 'APPROXIMATE') confidence *= 0.8;
  if (resolution === 'AMBIGUOUS' || resolution === 'NET_ZERO') confidence *= 0.6;

  return {
    ...common,
    kind: 'SWAP',
    direction: poolToken > 0n ? 'SELL' : 'BUY',
    trader,
    traderResolution: resolution,
    confidence: Math.round(confidence * 100) / 100,
  };
}
