/**
 * Runs a raw fixture through the whole pipeline without touching the network.
 *
 * Mirrors what `analyze()` does per token, minus the fetching: validation ->
 * evidence resolution -> safety gate -> coverage -> scoring -> eligibility ->
 * lifecycle state. Keeping this in one place means a regression test exercises
 * the real stages rather than a reimplementation of them.
 */

import { normalizePair } from '../src/sources/dexscreener.ts';
import { normalizeToken } from '../src/sources/jupiter.ts';
import { normalizeSummary } from '../src/sources/rugcheck.ts';
import { resolveEvidence } from '../src/core/resolve.ts';
import {
  evaluateGate,
  evaluateMalformedGate,
  evaluateRugcheckGate,
  DEFAULT_GATE_CONFIG,
  type GateConfig,
} from '../src/core/gate.ts';
import {
  buildCoverage,
  evaluateEligibility,
  settleState,
  DEFAULT_ELIGIBILITY,
  type EligibilityConfig,
} from '../src/core/lifecycle.ts';
import { scoreToken } from '../src/core/score.ts';
import type { CoverageReport, Eligibility, Score, TokenEvidence, TokenState, Veto } from '../src/types.ts';
import type { RawFixture } from './fixtures.ts';

export interface PipelineResult {
  evidence: TokenEvidence;
  vetoes: Veto[];
  coverage: CoverageReport;
  score: Score;
  eligibility: Eligibility;
  state: TokenState;
}

export interface PipelineOptions {
  now?: number;
  /** Ages every provider observation by this many ms, to exercise freshness. */
  observedAgeMs?: number;
  priorState?: TokenState | null;
  gate?: GateConfig;
  eligibility?: EligibilityConfig;
}

export function runPipeline(fixture: RawFixture, options: PipelineOptions = {}): PipelineResult {
  const now = options.now ?? Date.now();
  const observedAt = now - (options.observedAgeMs ?? 0);

  const pairs = fixture.dexPairs.map((raw) => normalizePair(raw as never));
  const jupiter = fixture.jupiter === null ? null : normalizeToken(fixture.jupiter as never);
  const rugcheck = fixture.rugcheck === null ? null : normalizeSummary(fixture.rugcheck as never);
  const onchain = fixture.onchain === null ? null : (fixture.onchain as never);

  const evidence = resolveEvidence({
    pairs,
    jupiter,
    rugcheck,
    onchain,
    observedAt: {
      dexscreener: observedAt,
      jupiter: observedAt,
      rugcheck: observedAt,
      onchain: observedAt,
    },
    heliusConfigured: fixture.onchain !== null,
    now,
  });

  const gateConfig = options.gate ?? DEFAULT_GATE_CONFIG;
  const vetoes = [
    ...evaluateGate(evidence, gateConfig),
    ...evaluateRugcheckGate(rugcheck?.risks ?? [], observedAt),
    ...evaluateMalformedGate(evidence.issues, observedAt),
  ];

  const coverage = buildCoverage(evidence);

  const score = scoreToken({
    evidence,
    hasSocials: pairs.some((pair) => pair.socials.length > 0 || pair.websites.length > 0),
    jupiterVerified: jupiter?.isVerified ?? false,
    minLiquidityUsd: gateConfig.minLiquidityUsd,
  });

  const eligibility = evaluateEligibility(vetoes, coverage, options.eligibility ?? DEFAULT_ELIGIBILITY);
  const state = settleState(options.priorState ?? null, eligibility);

  return { evidence, vetoes, coverage, score, eligibility, state };
}

export const hasVeto = (result: PipelineResult, code: string): boolean =>
  result.vetoes.some((veto) => veto.code === code);
