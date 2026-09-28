/**
 * On-demand analysis of one token that a person asked about.
 *
 * This is the same pipeline the monitor and `cli analyze` run - validation,
 * cross-provider evidence, the safety gate, coverage, scoring, eligibility -
 * applied to one mint with the discovery filters lifted (a person asking about
 * a token has already chosen it). Nothing here decides anything differently.
 *
 * The result is persisted exactly as a scan's would be, so the token's Dossier
 * (`/t/:mint`) and history work for it whether or not discovery ever found it.
 */

import { analyze, type AnalyzeStage } from './analyze.ts';
import { store } from './store.ts';
import { isScanning } from './monitor.ts';
import { config, hasHelius } from '../config.ts';
import { makeDecider } from '../decision/inputs.ts';
import type { ProviderFailure, TokenSnapshot, TokenState } from '../types.ts';

/** A real Solana mint: base58, 32 to 44 characters. */
export const MINT_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** What the person is told about each stage. Stated from configuration, never assumed. */
export interface StageView {
  id: 'validate' | AnalyzeStage;
  label: string;
  detail: string | null;
}

export function stageView(id: StageView['id']): StageView {
  switch (id) {
    case 'validate':
      return { id, label: 'Validating the mint address', detail: null };
    case 'market':
      return { id, label: 'Fetching market data', detail: 'DexScreener and Jupiter' };
    case 'safety':
      return {
        id,
        label: hasHelius() ? 'Checking safety reports and on-chain state' : 'Checking safety reports',
        // The rate-limited safety providers are shared with the monitor; if a
        // scan is running, this request waits its turn, and says so.
        detail: [
          hasHelius() ? 'RugCheck and Helius' : 'RugCheck · on-chain checks are off in this configuration',
          isScanning() ? 'queued behind the running scan' : null,
        ]
          .filter(Boolean)
          .join(' · '),
      };
    case 'evidence':
      return { id, label: 'Resolving evidence across providers', detail: null };
    case 'gate':
      return { id, label: 'Applying safety rules', detail: null };
    case 'verdict':
      return { id, label: 'Building the verdict', detail: 'Coverage, confidence, score and eligibility' };
  }
}

export type RequestedOutcome =
  | { ok: true; snapshot: TokenSnapshot; providerFailures: ProviderFailure[] }
  | { ok: false; code: 'no-market' | 'providers-down'; message: string; providerFailures: ProviderFailure[] };

/**
 * Analyses one mint and records the result. `onStage` hears each real stage as
 * it begins.
 */
export async function analyzeRequested(mint: string, onStage: (stage: AnalyzeStage) => void): Promise<RequestedOutcome> {
  const previous = store.token(mint);
  const priorStates = new Map<string, TokenState>();
  const state = previous?.evaluation?.state;
  if (state !== undefined) priorStates.set(mint, state);

  // Keep how discovery found it, if it did: a request adds provenance, it does
  // not replace it.
  const sources = [...new Set([...(previous?.sources ?? []), 'request'])];

  // The same decision stage the monitor runs: stored intelligence and history
  // for this mint, if Token Finder has any.
  const decide = makeDecider(store.decisionSources(), { minCoverageQualify: config.minCoverageQualify, minCoverageWatch: config.minCoverageWatch });
  const result = await analyze([{ mint, sources }], { includeAll: true, deepLimit: 1, priorStates, onStage, decide });
  const failures = [...result.providerFailures, ...result.failures.map((failure) => failure.failure)];
  const snapshot = result.snapshots[0];

  if (!snapshot) {
    const marketDown = result.providerFailures.filter((f) => f.provider === 'dexscreener' || f.provider === 'jupiter').length === 2;
    return marketDown
      ? {
          ok: false,
          code: 'providers-down',
          message: 'Both market data providers are unreachable right now, so there is no evidence to analyse. Try again shortly.',
          providerFailures: failures,
        }
      : {
          ok: false,
          code: 'no-market',
          message: 'No market data exists for this address. It may not be a token mint, or the token has no trading pool yet.',
          providerFailures: failures,
        };
  }

  store.upsert(snapshot, result.evidence.get(mint) ?? null);
  store.save();
  return { ok: true, snapshot, providerFailures: failures };
}
