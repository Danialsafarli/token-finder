/**
 * The processing budget: who gets deep data collection, and in what order.
 *
 *   FAST SCREEN  ->  SURVIVORS  ->  DEEP DATA COLLECTION
 *
 * The fast screen is the existing scan: batched market data, the RugCheck
 * gate, coverage and eligibility. It is cheap per token and it already
 * rejects most of what is discovered. Only tokens it lets through - QUALIFIED
 * or WATCH, evaluated recently enough to be live - are survivors, and only
 * survivors have their pool's transactions collected. Transaction history is
 * the expensive stage (one RPC call per transaction), so spending it on a
 * token the gate already rejected would be spending it on nothing.
 *
 * Within the survivors the budget goes, in order, to:
 *   1. QUALIFIED before WATCH - the Board's main list first;
 *   2. the pool collected longest ago (never collected counts as oldest), so
 *      every survivor is revisited in turn rather than the top few forever;
 *   3. deeper liquidity, as the tie-break.
 *
 * Pure: the scheduler decides, the runner fetches. That keeps the boundary
 * between the stages testable without a network.
 */

import type { TokenSnapshot } from '../types.ts';

export interface DeepWork {
  mint: string;
  pool: string;
  tier: 'QUALIFIED' | 'WATCH';
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
}

export function planDeepCollection(input: PlanInput): DeepPlan {
  const skipped = { notSurvivor: 0, notLive: 0, noPool: 0, overBudget: 0 };
  const candidates: (DeepWork & { lastAt: number; liquidity: number })[] = [];

  for (const token of input.tokens) {
    const eligibility = token.evaluation?.eligibility;
    if (eligibility !== 'QUALIFIED' && eligibility !== 'WATCH') {
      skipped.notSurvivor += 1;
      continue;
    }
    if (input.now - token.at > input.liveWindowMs) {
      skipped.notLive += 1;
      continue;
    }
    const pool = token.pair?.pairAddress ?? input.launchPool(token.mint);
    if (pool === null || pool === undefined || pool === '') {
      skipped.noPool += 1;
      continue;
    }
    candidates.push({
      mint: token.mint,
      pool,
      tier: eligibility,
      lastAt: input.lastCollectedAt(pool) ?? -1,
      liquidity: token.liquidityUsd ?? 0,
    });
  }

  candidates.sort(
    (a, b) =>
      (a.tier === b.tier ? 0 : a.tier === 'QUALIFIED' ? -1 : 1) ||
      a.lastAt - b.lastAt ||
      b.liquidity - a.liquidity ||
      a.mint.localeCompare(b.mint),
  );

  const take = Math.max(0, Math.trunc(input.tokensPerCycle));
  skipped.overBudget = Math.max(0, candidates.length - take);
  return {
    work: candidates.slice(0, take).map(({ mint, pool, tier }) => ({ mint, pool, tier })),
    skipped,
  };
}
