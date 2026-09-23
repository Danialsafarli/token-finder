import { config } from '../config.ts';
import * as dexscreener from '../sources/dexscreener.ts';
import * as jupiter from '../sources/jupiter.ts';
import * as rugcheck from '../sources/rugcheck.ts';
import * as helius from '../sources/helius.ts';
import * as typesafe from '../sources/typesafe.ts';
import { pool } from '../util/http.ts';
import { log } from '../util/logger.ts';
import { hasHelius } from '../config.ts';
import { scoreToken } from './score.ts';
import { resolveEvidence } from './resolve.ts';
import { evaluateGate, evaluateMalformedGate, evaluateRugcheckGate, type GateConfig } from './gate.ts';
import {
  buildCoverage,
  evaluateEligibility,
  settleState,
  type EligibilityConfig,
} from './lifecycle.ts';
import { isUsable } from './evidence.ts';
import type {
  Evaluation,
  JupiterInfo,
  PairMetrics,
  TokenCandidate,
  TokenSnapshot,
  TokenState,
} from '../types.ts';

export interface AnalyzeOptions {
  /** Skip the liquidity and age filters; used by the single-token CLI command. */
  includeAll?: boolean;
  /** Cap on how many candidates get the slow safety lookups. */
  deepLimit?: number;
  /** Prior lifecycle state per mint, so transitions are continuous across scans. */
  priorStates?: Map<string, TokenState>;
}

/**
 * Liquidity summed across every pair, from validated figures only. Null when
 * nothing usable was reported - which is not the same as zero liquidity.
 */
function pairLiquidity(pairs: PairMetrics[]): number | null {
  const usable = pairs
    .map((pair) => pair.liquidityUsd)
    .filter((value): value is number => value !== null);
  return usable.length === 0 ? null : usable.reduce((sum, value) => sum + value, 0);
}

function launchTime(pairs: PairMetrics[], jup: JupiterInfo | null): number | null {
  const times = pairs
    .map((pair) => pair.pairCreatedAt)
    .filter((value): value is number => value !== null && value > 0);
  if (jup?.firstPoolCreatedAt) times.push(jup.firstPoolCreatedAt);
  return times.length > 0 ? Math.min(...times) : null;
}

/**
 * Turns candidate mints into fully scored snapshots.
 *
 * The pipeline, in order:
 *
 *   discovery -> provider validation -> normalization -> cross-provider
 *   evidence -> safety gate -> signals -> coverage/confidence -> scoring ->
 *   ranking eligibility -> lifecycle state
 *
 * Runs in three passes so the expensive sources only see tokens worth the
 * call: batch market data first, cheap filtering second, per-token safety
 * lookups last.
 */
export async function analyze(
  candidates: TokenCandidate[],
  options: AnalyzeOptions = {},
): Promise<TokenSnapshot[]> {
  if (candidates.length === 0) return [];

  const mints = candidates.map((candidate) => candidate.mint);
  const sourcesByMint = new Map(candidates.map((c) => [c.mint, c.sources]));

  const [pairsByMint, jupByMint] = await Promise.all([
    dexscreener.pairsForMints(mints),
    jupiter.infoForMints(mints),
  ]);

  // Observation times for freshness. Batch fetches complete together, so one
  // timestamp per provider is accurate to well inside the freshest window.
  const marketObservedAt = Date.now();
  const now = marketObservedAt;

  interface Draft {
    candidate: TokenCandidate;
    pairs: PairMetrics[];
    jup: JupiterInfo | null;
    liquidityUsd: number | null;
    ageHours: number | null;
    launchedAt: number | null;
  }

  const drafts: Draft[] = [];

  for (const candidate of candidates) {
    const pairs = pairsByMint.get(candidate.mint) ?? [];
    const jup = jupByMint.get(candidate.mint) ?? null;
    if (pairs.length === 0 && jup === null) continue;

    const liquidityUsd = pairLiquidity(pairs) ?? jup?.liquidityUsd ?? null;
    const launchedAt = launchTime(pairs, jup);
    const ageHours = launchedAt === null ? null : (now - launchedAt) / 3_600_000;

    if (!options.includeAll) {
      // Unmeasured liquidity cannot be shown to clear the floor, so it does not
      // clear it. Unknown is not a pass.
      if (liquidityUsd === null || liquidityUsd < config.minLiquidityUsd) continue;
      if (ageHours !== null && ageHours > config.maxAgeHours) continue;
    }

    drafts.push({ candidate, pairs, jup, liquidityUsd, ageHours, launchedAt });
  }

  // Safety lookups are the rate-limit bottleneck, so spend them on the
  // deepest pools first rather than on whatever happened to be discovered.
  drafts.sort((a, b) => (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1));
  const deepLimit = options.deepLimit ?? config.maxAnalyzePerScan;
  const deep = drafts.slice(0, deepLimit);

  log.debug(`analyze: ${candidates.length} candidates -> ${drafts.length} viable -> ${deep.length} deep`);

  const gateConfig: GateConfig = {
    minLiquidityUsd: config.minLiquidityUsd,
    catastrophicConcentrationPct: config.catastrophicConcentrationPct,
  };
  const eligibilityConfig: EligibilityConfig = {
    minCoverageQualify: config.minCoverageQualify,
    minCoverageWatch: config.minCoverageWatch,
  };

  // Screening runs only on this list - candidates that already cleared
  // discovery, liquidity and age.
  typesafe.resetScanBudget();

  return pool(deep, 4, async (draft): Promise<TokenSnapshot> => {
    const { candidate, pairs, jup } = draft;

    const best = dexscreener.bestPair(pairs);
    const symbol = candidate.symbol ?? best?.baseSymbol ?? jup?.symbol ?? null;
    const name = candidate.name ?? best?.baseName ?? jup?.name ?? null;

    const [rug, onchain, impersonation] = await Promise.all([
      rugcheck.summary(candidate.mint),
      helius.onchainInfo(candidate.mint),
      typesafe.screenImpersonation({
        mint: candidate.mint,
        symbol,
        name,
        jupiterVerified: jup?.isVerified ?? false,
      }),
    ]);

    const safetyObservedAt = Date.now();

    // --- cross-provider evidence -------------------------------------------
    const evidence = resolveEvidence({
      pairs,
      jupiter: jup,
      rugcheck: rug,
      onchain,
      observedAt: {
        dexscreener: marketObservedAt,
        jupiter: marketObservedAt,
        rugcheck: safetyObservedAt,
        onchain: safetyObservedAt,
      },
      heliusConfigured: hasHelius(),
      now: safetyObservedAt,
    });

    // --- safety gate --------------------------------------------------------
    const vetoes = [
      ...evaluateGate(evidence, gateConfig),
      ...evaluateRugcheckGate(rug?.risks ?? [], safetyObservedAt),
      ...evaluateMalformedGate(evidence.issues, safetyObservedAt),
    ];

    // --- coverage and confidence -------------------------------------------
    const coverage = buildCoverage(evidence);

    // --- scoring ------------------------------------------------------------
    const hasSocials = pairs.some((pair) => pair.socials.length > 0 || pair.websites.length > 0);
    const score = scoreToken({
      evidence,
      rugcheckRisks: rug?.risks ?? [],
      hasSocials,
      jupiterVerified: jup?.isVerified ?? false,
      impersonation,
      minLiquidityUsd: config.minLiquidityUsd,
    });

    // --- eligibility and lifecycle -----------------------------------------
    const eligibility = evaluateEligibility(vetoes, coverage, eligibilityConfig);
    const previousState = options.priorStates?.get(candidate.mint) ?? null;
    const state = settleState(previousState, eligibility);

    const evaluation: Evaluation = {
      state,
      eligibility,
      stateChangedAt: safetyObservedAt,
      previousState,
      vetoes,
      coverage,
      conflicts: evidence.conflicts,
      issues: evidence.issues,
    };

    const resolvedLiquidity = isUsable(evidence.liquidityUsd)
      ? (evidence.liquidityUsd.value as number)
      : null;
    const resolvedVolume = isUsable(evidence.volume24h) ? (evidence.volume24h.value as number) : null;
    const resolvedChange = isUsable(evidence.priceChange)
      ? (evidence.priceChange.value as { m5: number; h1: number; h6: number; h24: number })
      : null;
    const resolvedHolders = isUsable(evidence.holders) ? (evidence.holders.value as number) : null;
    const resolvedAge = isUsable(evidence.ageHours) ? (evidence.ageHours.value as number) : null;
    const resolvedPressure = isUsable(evidence.buyPressure)
      ? (evidence.buyPressure.value as number)
      : null;

    return {
      mint: candidate.mint,
      symbol: symbol ?? '?',
      name: name ?? '',
      sources: sourcesByMint.get(candidate.mint) ?? [],
      at: now,
      launchedAt: draft.launchedAt,
      ageHours: resolvedAge,
      priceUsd: best?.priceUsd ?? jup?.usdPrice ?? null,
      liquidityUsd: resolvedLiquidity,
      volume24h: resolvedVolume,
      marketCap: best?.marketCap ?? jup?.mcap ?? null,
      fdv: best?.fdv ?? null,
      holders: resolvedHolders,
      priceChange: resolvedChange,
      buyRatio24h: resolvedPressure,
      pair: best,
      jupiter: jup,
      rugcheck: rug,
      onchain,
      impersonation,
      score,
      evaluation,
    };
  });
}
