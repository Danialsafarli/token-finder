/**
 * Re-deciding a token when its deep intelligence changes.
 *
 * The decision stage runs at every scan, but a scan only re-evaluates the
 * tokens discovery hands it - and a token whose creator has just drained its
 * pool falls below the liquidity floor and is never handed over again. Found
 * in live verification: a token with a current-rule CONFIRMED liquidity drain
 * stayed QUALIFIED on the Board until it aged out of the live window.
 *
 * So when an intelligence cycle finishes, every token it analysed is decided
 * again: from its stored snapshot (the same market observation, never a new
 * one) and the intelligence just written. No provider is called. A changed
 * verdict is a real transition - persisted, announced, and visible on
 * Changes and in the Observatory - dated when it was decided, not when the
 * market was last read.
 */

import { isLive } from '../core/ranking.ts';
import { makeDecider, type DecisionSources } from './inputs.ts';
import type { DecisionConfig } from './engine.ts';
import type { TokenSnapshot } from '../types.ts';

export interface RedecideDeps {
  current(mint: string): TokenSnapshot | null;
  sources: DecisionSources;
  config: DecisionConfig;
  now(): number;
  liveWindowMs: number;
  /** Stores the re-decided snapshot; `decidedAt` dates any transition it records. */
  persist(next: TokenSnapshot, decidedAt: number): void;
  /** Called only when the verdict actually changed. */
  onChange?(next: TokenSnapshot, previous: TokenSnapshot): void;
}

export interface RedecideResult {
  checked: number;
  changed: { mint: string; from: string; to: string }[];
}

/** The Phase 1 gate's own vetoes: the ones Hard Gate v2 described rather than added. */
const SCREEN_RULE = 'hard-gate@1';

/**
 * The fast screen's evaluation, recovered from a decided snapshot, so the
 * decision can be run again from the same starting point it had at scan time.
 */
export function screenOf(snapshot: TokenSnapshot): TokenSnapshot {
  const evaluation = snapshot.evaluation;
  const decision = snapshot.decision;
  if (!evaluation || !decision) return snapshot;
  return {
    ...snapshot,
    evaluation: {
      ...evaluation,
      eligibility: decision.screen.eligibility,
      vetoes: evaluation.vetoes.filter((v) => v.ruleVersion === undefined || v.ruleVersion === SCREEN_RULE),
    },
  };
}

export function redecide(mints: string[], deps: RedecideDeps): RedecideResult {
  const now = deps.now();
  const decide = makeDecider(deps.sources, deps.config, () => now);
  const result: RedecideResult = { checked: 0, changed: [] };
  for (const mint of new Set(mints)) {
    const previous = deps.current(mint);
    // Only a verdict that is still on the live Board is worth re-stating; a
    // stale one is history and is left as it was recorded.
    if (!previous?.evaluation || !previous.decision || !isLive(previous, now, deps.liveWindowMs)) continue;
    result.checked += 1;
    const decided = decide(screenOf(previous), previous.evaluation.state);
    const from = previous.evaluation.eligibility;
    const to = decided.evaluation!.eligibility;
    // An unchanged verdict keeps its own history: when it last changed, and from what.
    const next: TokenSnapshot =
      from === to
        ? { ...decided, evaluation: { ...decided.evaluation!, state: previous.evaluation.state, previousState: previous.evaluation.previousState, stateChangedAt: previous.evaluation.stateChangedAt } }
        : { ...decided, evaluation: { ...decided.evaluation!, stateChangedAt: now } };
    deps.persist(next, now);
    if (from !== to) {
      result.changed.push({ mint, from, to });
      deps.onChange?.(next, previous);
    }
  }
  return result;
}
