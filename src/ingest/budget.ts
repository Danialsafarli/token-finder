/**
 * The processing budget: who gets deep data collection, and in what order.
 *
 *   FAST SCREEN  ->  SURVIVORS  ->  DEEP DATA COLLECTION
 *
 * The fast screen is the existing scan: batched market data, the RugCheck
 * gate, coverage and eligibility. It is cheap per token and it already
 * rejects most of what is discovered. Only tokens it lets through - every
 * verdict short of REJECTED and INSUFFICIENT_DATA, evaluated recently enough
 * to be live - are survivors, and only survivors have their pools'
 * transactions collected. Transaction history is the expensive stage (one RPC
 * call per transaction), so spending it on a token the gate already rejected
 * would be spending it on nothing.
 *
 * Within the survivors the budget goes, in order, to:
 *   1. the verdict tier: HIGH_POTENTIAL, QUALIFIED, WATCH, then HIGH_RISK;
 *   2. the pool collected longest ago (never collected counts as oldest), so
 *      every survivor is revisited in turn rather than the top few forever;
 *   3. deeper liquidity, as the tie-break.
 *
 * ## More than one pool
 *
 * A token that trades on several pools is under-observed from one of them.
 * Up to `poolsPerToken` pools are collected per token: the display pair, then
 * other provider-reported pools in order of 24 h volume, each only if it
 * carries at least `minPoolVolumeShare` of the token's volume - a dust pool
 * is not worth a budget that a busy one needs. Pools are deduplicated by
 * address. The cost is explicit: at most tokensPerCycle x poolsPerToken x
 * txPerToken transaction fetches per cycle.
 *
 * Pure: the scheduler decides, the runner fetches. That keeps the boundary
 * between the stages testable without a network.
 */

import { isSurvivor, SURVIVOR_ORDER, type SurvivorTier } from '../core/ranking.ts';
import type { TokenSnapshot } from '../types.ts';

export interface DeepWork {
  mint: string;
  pool: string;
  tier: SurvivorTier;
  /** Venue of this pool, when a provider reported it. */
  dexId: string | null;
  /** 0 for the token's primary pool, 1.. for secondary pools. */
  rank: number;
}

export interface DeepPlan {
  work: DeepWork[];
  /** Why each non-selected token was left out. Counts only. */
  skipped: {
    notSurvivor: number;
    notLive: number;
    noPool: number;
    overBudget: number;
  };
}

export interface PlanInput {
  tokens: TokenSnapshot[];
  /** Last collection time per pool, from the ingestion cursors. */
  lastCollectedAt: (pool: string) => number | null;
  /** Launch pool per mint, for tokens with no market pair yet. */
  launchPool: (mint: string) => string | null;
  tokensPerCycle: number;
  /** A survivor's verdict older than this is not live and is not collected. */
  liveWindowMs: number;
  now: number;
  /** Pools collected per token, at most. Defaults to 1 (the display pair). */
  poolsPerToken?: number;
  /** A secondary pool needs at least this share of the token's 24 h volume. */
  minPoolVolumeShare?: number;
}

/** The pools worth collecting for one token, primary first, deduplicated. */
export function poolsFor(token: TokenSnapshot, launchPool: string | null, limit: number, minShare: number): { address: string; dexId: string | null }[] {
  const out: { address: string; dexId: string | null }[] = [];
  const add = (address: string | null | undefined, dexId: string | null): void => {
    if (!address || out.some((p) => p.address === address)) return;
    out.push({ address, dexId });
  };
  add(token.pair?.pairAddress, token.pair?.dexId ?? null);
  if (out.length === 0) add(launchPool, null);
  const pools = token.pools ?? [];
  const total = pools.reduce((s, p) => s + (p.volume24h ?? 0), 0);
  for (const p of pools) {
    if (out.length >= limit) break;
    if (total <= 0 || (p.volume24h ?? 0) / total < minShare) continue;
    add(p.address, p.dexId);
  }
  return out.slice(0, Math.max(1, limit));
}

export function planDeepCollection(input: PlanInput): DeepPlan {
  const skipped = { notSurvivor: 0, notLive: 0, noPool: 0, overBudget: 0 };
  const candidates: { mint: string; tier: SurvivorTier; lastAt: number; liquidity: number; pools: { address: string; dexId: string | null }[] }[] = [];
  const perToken = Math.max(1, Math.trunc(input.poolsPerToken ?? 1));
  const minShare = input.minPoolVolumeShare ?? 0.2;

  for (const token of input.tokens) {
    const eligibility = token.evaluation?.eligibility;
    if (!isSurvivor(eligibility)) {
      skipped.notSurvivor += 1;
      continue;
    }
    if (input.now - token.at > input.liveWindowMs) {
      skipped.notLive += 1;
      continue;
    }
    const pools = poolsFor(token, input.launchPool(token.mint), perToken, minShare);
    if (pools.length === 0) {
      skipped.noPool += 1;
      continue;
    }
    candidates.push({
      mint: token.mint,
      tier: eligibility,
      lastAt: input.lastCollectedAt(pools[0]!.address) ?? -1,
      liquidity: token.liquidityUsd ?? 0,
      pools,
    });
  }

  candidates.sort(
    (a, b) =>
      SURVIVOR_ORDER[a.tier] - SURVIVOR_ORDER[b.tier] ||
      a.lastAt - b.lastAt ||
      b.liquidity - a.liquidity ||
      a.mint.localeCompare(b.mint),
  );

  const take = Math.max(0, Math.trunc(input.tokensPerCycle));
  skipped.overBudget = Math.max(0, candidates.length - take);
  return {
    work: candidates.slice(0, take).flatMap(({ mint, tier, pools }) => pools.map((p, rank) => ({ mint, pool: p.address, tier, dexId: p.dexId, rank }))),
    skipped,
  };
}
