import { config } from '../config.ts';
import * as dexscreener from '../sources/dexscreener.ts';
import * as jupiter from '../sources/jupiter.ts';
import * as rugcheck from '../sources/rugcheck.ts';
import * as helius from '../sources/helius.ts';
import * as typesafe from '../sources/typesafe.ts';
import { poolSettled } from '../util/http.ts';
import { classifyFailure, type ProviderFailure } from '../util/failure.ts';
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
import { isUsable, type TokenEvidence } from './evidence.ts';
import { ledgerFrom } from './ledger.ts';
import type {
  Evaluation,
  JupiterInfo,
  OnChainInfo,
  PairMetrics,
  RugcheckInfo,
  TokenCandidate,
  TokenSnapshot,
  TokenState,
} from '../types.ts';

/** A token whose analysis failed outright, kept so the scan can report it. */
export interface TokenFailure {
  mint: string;
  symbol: string | null;
  failure: ProviderFailure;
}

export interface AnalyzeResult {
  snapshots: TokenSnapshot[];
  /** Tokens that could not be analysed at all. Never aborts the batch. */
  failures: TokenFailure[];
  /** Batch-level provider failures, e.g. a whole market feed being down. */
  providerFailures: ProviderFailure[];
  /**
   * Resolved evidence per mint, so persistence can record *why* a verdict was
   * reached - which provider supplied each metric, how fresh it was, and
   * whether it was measured, conflicted or merely absent.
   *
   * Additive and optional to consume: `TokenSnapshot` is unchanged, so nothing
   * that ignores this field behaves differently.
   */
  evidence: Map<string, TokenEvidence>;
}

/**
 * The pipeline's real stages, in order. Reported to `onStage` as each begins,
 * so a caller watching one token can say truthfully what is happening now.
 */
export type AnalyzeStage = 'market' | 'safety' | 'evidence' | 'gate' | 'verdict';

export interface AnalyzeOptions {
  /**
   * Called as each stage begins. Instrumentation only: it changes nothing
   * about what is analysed or concluded. For a batch the per-token stages
   * fire once per token. `count` is the number of tokens entering the stage
   * for `market` (candidates) and `safety` (the deep set).
   */
  onStage?: (stage: AnalyzeStage, count?: number) => void;
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
): Promise<AnalyzeResult> {
  if (candidates.length === 0) {
    return { snapshots: [], failures: [], providerFailures: [], evidence: new Map() };
  }

  const mints = candidates.map((candidate) => candidate.mint);
  const sourcesByMint = new Map(candidates.map((c) => [c.mint, c.sources]));
  const providerFailures: ProviderFailure[] = [];

  // The two market feeds are fetched independently. `Promise.all` here meant a
  // single DexScreener timeout threw away a complete, already-fetched Jupiter
  // response and ended the scan; `allSettled` keeps whichever side answered.
  options.onStage?.('market', candidates.length);
  const [pairsSettled, jupSettled] = await Promise.allSettled([
    dexscreener.pairsForMints(mints),
    jupiter.infoForMints(mints),
  ]);

  const pairsByMint =
    pairsSettled.status === 'fulfilled' ? pairsSettled.value : new Map<string, PairMetrics[]>();
  if (pairsSettled.status === 'rejected') {
    const failure = classifyFailure('dexscreener', pairsSettled.reason);
    providerFailures.push(failure);
    log.warn(`dexscreener batch failed (${failure.kind}): ${failure.message}`);
  }

  const jupByMint =
    jupSettled.status === 'fulfilled' ? jupSettled.value : new Map<string, JupiterInfo>();
  if (jupSettled.status === 'rejected') {
    const failure = classifyFailure('jupiter', jupSettled.reason);
    providerFailures.push(failure);
    log.warn(`jupiter batch failed (${failure.kind}): ${failure.message}`);
  }

  if (pairsByMint.size === 0 && jupByMint.size === 0 && providerFailures.length === 2) {
    log.error('both market providers failed; no evidence to analyse this scan');
    return { snapshots: [], failures: [], providerFailures, evidence: new Map() };
  }

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

  /** Populated per token inside the pool below; see AnalyzeResult.evidence. */
  const evidenceByMint = new Map<string, TokenEvidence>();

  if (deep.length > 0) options.onStage?.('safety', deep.length);

  const settled = await poolSettled(deep, 4, async (draft): Promise<TokenSnapshot> => {
    const { candidate, pairs, jup } = draft;

    const best = dexscreener.bestPair(pairs);
    const symbol = candidate.symbol ?? best?.baseSymbol ?? jup?.symbol ?? null;
    const name = candidate.name ?? best?.baseName ?? jup?.name ?? null;

    // Each enrichment provider is isolated from the others. One of them failing
    // must not discard the evidence the other two already returned, so a
    // rejection becomes a recorded failure and an UNAVAILABLE signal rather
    // than an exception that unwinds the whole token.
    const tokenFailures: ProviderFailure[] = [];
    const [rugSettled, onchainSettled, impersonationSettled] = await Promise.allSettled([
      rugcheck.summary(candidate.mint),
      helius.onchainInfo(candidate.mint),
      typesafe.screenImpersonation({
        mint: candidate.mint,
        symbol,
        name,
        jupiterVerified: jup?.isVerified ?? false,
      }),
    ]);

    // Each adapter reports its own failure rather than collapsing it to null,
    // so a provider outage is distinguishable from "this token has no data".
    // The allSettled wrapper is the backstop for an adapter that throws anyway.
    let rug: RugcheckInfo | null = null;
    if (rugSettled.status === 'fulfilled') {
      rug = rugSettled.value.data;
      if (rugSettled.value.failure !== null) tokenFailures.push(rugSettled.value.failure);
    } else {
      tokenFailures.push(classifyFailure('rugcheck', rugSettled.reason));
    }

    let onchain: OnChainInfo | null = null;
    if (onchainSettled.status === 'fulfilled') {
      onchain = onchainSettled.value.data;
      // A missing Helius key reports as PROVIDER_UNAVAILABLE. That is true and
      // useful, but it is the default configuration, not an incident, so it is
      // not recorded as a per-token failure.
      const failure = onchainSettled.value.failure;
      if (failure !== null && failure.message !== 'no API key configured') {
        tokenFailures.push(failure);
      }
    } else {
      tokenFailures.push(classifyFailure('helius', onchainSettled.reason));
    }

    // Screening never throws by contract, but if it ever did, a naming check
    // must not be able to take a token's whole analysis with it.
    const impersonation =
      impersonationSettled.status === 'fulfilled' ? impersonationSettled.value : null;
    if (impersonationSettled.status === 'rejected') {
      tokenFailures.push(classifyFailure('typesafe', impersonationSettled.reason));
    }

    const safetyObservedAt = Date.now();

    // --- cross-provider evidence -------------------------------------------
    options.onStage?.('evidence');
    const evidence: TokenEvidence = resolveEvidence({
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
      failures: [...providerFailures, ...tokenFailures],
      now: safetyObservedAt,
    });
    evidenceByMint.set(candidate.mint, evidence);

    // --- safety gate --------------------------------------------------------
    options.onStage?.('gate');
    const vetoes = [
      ...evaluateGate(evidence, gateConfig),
      ...evaluateRugcheckGate(rug?.risks ?? [], safetyObservedAt),
      ...evaluateMalformedGate(evidence.issues, safetyObservedAt),
    ];

    // --- coverage and confidence -------------------------------------------
    options.onStage?.('verdict');
    const coverage = buildCoverage(evidence);

    // --- scoring ------------------------------------------------------------
    const hasSocials = pairs.some((pair) => pair.socials.length > 0 || pair.websites.length > 0);
    const score = scoreToken({
      evidence,
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
      providerFailures: [...providerFailures, ...tokenFailures],
      historicalDangerEvidence: evidence.historicalDangerEvidence,
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
      // The receipt for this verdict: every metric's winning value, state,
      // source, age and the claims that lost. A projection, not a decision.
      ledger: ledgerFrom(evidence),
    };
  });

  // A token that threw is reported, not fatal. The rest of the batch stands.
  const snapshots: TokenSnapshot[] = [];
  const failures: TokenFailure[] = [];

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      snapshots.push(result.value);
      continue;
    }
    const draft = deep[result.index];
    const failure = classifyFailure('analyze', result.reason);
    failures.push({
      mint: draft?.candidate.mint ?? 'unknown',
      symbol: draft?.candidate.symbol ?? null,
      failure,
    });
    log.warn(
      `analysis failed for ${draft?.candidate.mint ?? 'unknown'} (${failure.kind}): ${failure.message}`,
    );
  }

  return { snapshots, failures, providerFailures, evidence: evidenceByMint };
}
