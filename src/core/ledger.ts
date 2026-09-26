/**
 * The evidence ledger: a receipt for every metric the engine resolved.
 *
 * `TokenEvidence` is the engine's working model - generic, typed, carrying
 * class-like values such as `MintExtension[]`. The ledger is its projection for
 * people: one flat entry per signal with the winning value, the evidence state,
 * where it came from, how old it was, how much it was worth, and every claim
 * each provider made - including the ones that lost.
 *
 * This module decides nothing. It copies what `resolve()` already concluded.
 * If the ledger and the engine ever disagree, the engine is right and this file
 * has a bug.
 */

import { COVERAGE_WEIGHTS } from './lifecycle.ts';
import type { Claim, Evidence, TokenEvidence } from './evidence.ts';
import type { LedgerClaim, LedgerEntry, LedgerValue, MintExtension } from '../types.ts';

/**
 * Signals recorded, in display order. The coverage-bearing signals, grouped by
 * what they are about, then the token program, which is informational.
 */
export const LEDGER_METRICS = [
  // Safety
  'mintAuthorityRevoked',
  'freezeAuthorityRevoked',
  'mintExtensions',
  'topHoldersPct',
  'rugcheckRisk',
  // Market
  'tradable',
  'liquidityUsd',
  'volume24h',
  'priceChange',
  'buyPressure',
  // Adoption
  'holders',
  'organicScore',
  'ageHours',
  // Informational - not coverage-weighted
  'tokenProgram',
] as const;

export type LedgerMetric = (typeof LEDGER_METRICS)[number];

function isExtensionList(value: unknown): value is MintExtension[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'object' && item !== null && 'policy' in item)
  );
}

/** Reduces an engine value to something JSON-safe and display-ready. */
export function ledgerValue(value: unknown): LedgerValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  // Extension detail lives on `onchain.extensions`; the ledger records which
  // extensions were present, which is what the evidence claim was about.
  if (isExtensionList(value)) return value.map((extension) => extension.id);
  if (typeof value === 'object') {
    const out: Record<string, number> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === 'number' && Number.isFinite(item)) out[key] = item;
    }
    return out;
  }
  return null;
}

function ledgerClaim(claim: Claim<unknown>): LedgerClaim {
  const out: LedgerClaim = {
    provider: claim.provider,
    value: ledgerValue(claim.value),
    observedAt: claim.observedAt,
    freshness: claim.freshness ?? 'UNKNOWN',
  };
  if (claim.invalid !== undefined) out.invalid = claim.invalid;
  if (claim.unavailable !== undefined) out.unavailable = claim.unavailable;
  return out;
}

/** Builds the ledger from resolved evidence. Pure. */
export function ledgerFrom(evidence: TokenEvidence): LedgerEntry[] {
  const record = evidence as unknown as Record<string, unknown>;
  const entries: LedgerEntry[] = [];

  for (const metric of LEDGER_METRICS) {
    const item = record[metric] as Evidence<unknown> | undefined;
    if (item === undefined || item === null || typeof item !== 'object' || !('state' in item)) continue;

    entries.push({
      metric,
      state: item.state,
      value: ledgerValue(item.value),
      source: item.source,
      observedAt: item.observedAt,
      freshness: item.freshness,
      confidence: item.confidence,
      weight: (COVERAGE_WEIGHTS as Record<string, number | undefined>)[metric] ?? 0,
      notes: item.notes.slice(0, 6),
      claims: item.claims.map(ledgerClaim),
      overridden: item.overridden.map(ledgerClaim),
    });
  }

  return entries;
}
