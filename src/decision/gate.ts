/**
 * Hard Gate v2.
 *
 * The Phase 1 gate (core/gate.ts) still runs first and still decides every
 * veto it always did: live authorities, dangerous Token-2022 powers, no
 * liquidity, catastrophic concentration, malformed data, and RugCheck's two
 * critical findings. This module does two things on top of it:
 *
 * 1. **Explains every veto the same way.** Each gets a family, a confidence, a
 *    freshness and the rule version that produced it, so a rejection reads
 *    "CRITICAL_TRANSFER_RESTRICTION: transfer hook armed, confidence 1.0, fresh,
 *    hard-gate@2" rather than a bare code.
 * 2. **Adds four families from deep intelligence**, each behind conditions
 *    strong enough that a rejection is explainable from the evidence alone:
 *
 * | Code | Fires only when |
 * |---|---|
 * | CONFIRMED_CURRENT_RUG | a current-rule CONFIRMED liquidity drain on this token: a creator-linked wallet removed >= 80% of the reserve, proven by a transaction |
 * | CONFIRMED_MALICIOUS_TOKEN | a current-rule CONFIRMED supply expansion (minted to a linked wallet that sold it) or freeze abuse (>= 3 holder wallets frozen) |
 * | STRONG_SERIAL_RUGGER | the attributed creator (attribution >= 0.6) reaches, over strong links only with path confidence >= 0.6, addresses with confirmed malicious history on >= 2 distinct other launches |
 * | EXTREME_MARKET_MANIPULATION | wash risk HIGH on fresh data, confidence >= 0.6, >= 3 of 4 families including round trips, round trips >= 40% of volume, >= 60 trades, and a sample representative of the market (coverage >= 0.6) |
 *
 * ## What never hard-fails
 *
 * Bots, snipers, high-frequency traders, automation of any degree, one weak
 * wallet relationship, one suspicious or one confirmed prior project,
 * a low-confidence creator association, an ambiguous attribution, and missing
 * or incomplete data. Those are soft risk (decision/integrity.ts) or coverage.
 * A finding from a rule version no longer accepted never fires anything.
 */

import { usableIntel } from './contract.ts';
import { MODEL_VERSIONS, RULE_VERSIONS } from './versions.ts';
import type { EvidenceFreshness, HardFailFamily, Veto, VetoCode } from '../types.ts';
import type { IntelligenceBundle } from './types.ts';

export const GATE_V2 = {
  serialMinLaunches: 2,
  serialMinPathConfidence: 0.6,
  serialMinAttribution: 0.6,
  manipulationMinConfidence: 0.6,
  manipulationMinFamilies: 3,
  manipulationMinRoundTrip: 0.4,
  manipulationMinTrades: 60,
  manipulationMinCoverage: 0.6,
} as const;

/** The family each Phase 1 veto belongs to. */
const LEGACY_FAMILY: Record<string, HardFailFamily> = {
  AUTHORITY_MINT_ACTIVE: 'CRITICAL_TOKEN_AUTHORITY_RISK',
  AUTHORITY_FREEZE_ACTIVE: 'CRITICAL_TOKEN_AUTHORITY_RISK',
  PERMANENT_DELEGATE_ACTIVE: 'CRITICAL_TOKEN_AUTHORITY_RISK',
  MINT_PAUSABLE: 'CRITICAL_TOKEN_AUTHORITY_RISK',
  TRANSFER_HOOK_ACTIVE: 'CRITICAL_TRANSFER_RESTRICTION',
  DEFAULT_ACCOUNT_STATE_FROZEN: 'CRITICAL_TRANSFER_RESTRICTION',
  NON_TRANSFERABLE: 'CRITICAL_TRANSFER_RESTRICTION',
  EXTREME_TRANSFER_FEE: 'CRITICAL_TRANSFER_RESTRICTION',
  UNTRADEABLE: 'CRITICAL_LIQUIDITY_RISK',
  LIQUIDITY_TOO_LOW: 'CRITICAL_LIQUIDITY_RISK',
  CATASTROPHIC_CONCENTRATION: 'CRITICAL_HOLDER_CONCENTRATION',
  MALFORMED_TOKEN: 'DATA_INTEGRITY',
};

const SOURCE_CONFIDENCE: Record<string, number> = { helius: 1, rugcheck: 0.95, dexscreener: 0.9, jupiter: 0.85, derived: 0.9, validation: 0.9 };

/** Freshness of a Phase 1 veto's evidence, from its own timestamp and nature. */
function legacyFreshness(veto: Veto, now: number): EvidenceFreshness {
  if (veto.nature === 'historical') return 'FRESH';
  const age = now - veto.at;
  if (age <= 30 * 60_000) return 'FRESH';
  if (age <= 90 * 60_000) return 'AGING';
  return 'STALE';
}

/** Gives a Phase 1 veto the full Hard Gate v2 description. Does not change whether it fires. */
export function describeLegacyVeto(veto: Veto, now: number): Veto {
  let family = LEGACY_FAMILY[veto.code];
  if (veto.code === 'CRITICAL_RUGCHECK') {
    // Two findings share this code; the observed value says which.
    family = veto.observedValue.toLowerCase().includes('creator history') ? 'STRONG_SERIAL_RUGGER' : 'CONFIRMED_CURRENT_RUG';
  }
  return {
    ...veto,
    family: veto.family ?? family ?? 'DATA_INTEGRITY',
    confidence: veto.confidence ?? SOURCE_CONFIDENCE[veto.source] ?? 0.8,
    freshness: veto.freshness ?? legacyFreshness(veto, now),
    ruleVersion: veto.ruleVersion ?? 'hard-gate@1',
    evidence: veto.evidence ?? [veto.observedValue],
  };
}

function fail(code: VetoCode, family: HardFailFamily, fields: Omit<Veto, 'code' | 'family'>): Veto {
  return { code, family, ...fields };
}

/** Hard fails from deep intelligence. Each needs current-rule evidence meeting {@link GATE_V2}. */
export function intelligenceHardFails(bundle: IntelligenceBundle, now: number): Veto[] {
  const out: Veto[] = [];
  const security = bundle.security.value;

  // --- confirmed events on this token ------------------------------------------
  // A CONFIRMED event is historical: it happened, with a transaction to prove
  // it, and does not stop having happened. So it fires regardless of how long
  // ago the analysis ran - but only if the rule that confirmed it is current.
  for (const event of security?.active ?? []) {
    if (event.status !== 'CONFIRMED' || event.mint !== bundle.mint) continue;
    if (event.type === 'LIQUIDITY_DRAIN') {
      out.push(
        fail('CONFIRMED_CURRENT_RUG', 'CONFIRMED_CURRENT_RUG', {
          nature: 'historical',
          reason: `Liquidity was removed by a creator-linked wallet: ${event.reasons.join('; ')}.`,
          source: 'deep-intelligence',
          observedValue: `${event.type} ${event.status} (${event.signature.slice(0, 10)}…)`,
          at: event.blockTimeMs ?? bundle.analyzedAt ?? now,
          recheckable: false,
          confidence: event.confidence,
          freshness: 'FRESH',
          ruleVersion: event.ruleVersion ?? RULE_VERSIONS.security,
          evidence: [event.signature, ...(event.actor ? [`actor ${event.actor}`] : [])],
        }),
      );
    } else if (event.type === 'SUPPLY_EXPANSION' || event.type === 'FREEZE_ABUSE') {
      out.push(
        fail('CONFIRMED_MALICIOUS_TOKEN', 'CONFIRMED_MALICIOUS_TOKEN', {
          nature: 'historical',
          reason:
            event.type === 'SUPPLY_EXPANSION'
              ? `Supply was minted after launch to a creator-linked wallet and sold: ${event.reasons.join('; ')}.`
              : `The freeze authority froze holders' accounts: ${event.reasons.join('; ')}.`,
          source: 'deep-intelligence',
          observedValue: `${event.type} ${event.status} (${event.signature.slice(0, 10)}…)`,
          at: event.blockTimeMs ?? bundle.analyzedAt ?? now,
          recheckable: false,
          confidence: event.confidence,
          freshness: 'FRESH',
          ruleVersion: event.ruleVersion ?? RULE_VERSIONS.security,
          evidence: [event.signature],
        }),
      );
    }
  }

  // --- serial network ----------------------------------------------------------------
  const network = bundle.network.value;
  const attribution = bundle.attribution.value;
  if (
    bundle.network.status === 'AVAILABLE' &&
    network &&
    attribution?.status === 'ATTRIBUTED' &&
    attribution.confidence >= GATE_V2.serialMinAttribution
  ) {
    const strong = network.findings.filter((f) => f.confirmedLaunches > 0 && f.pathConfidence >= GATE_V2.serialMinPathConfidence);
    // Distinct launches: two linked wallets behind one rug are one rug.
    const mints = new Set(strong.flatMap((f) => f.confirmedMints));
    if (bundle.creator.status === 'AVAILABLE') for (const m of bundle.creator.value?.confirmedMints ?? []) mints.add(m);
    const total = mints.size;
    if (total >= GATE_V2.serialMinLaunches) {
      const best = strong[0];
      out.push(
        fail('STRONG_SERIAL_RUGGER', 'STRONG_SERIAL_RUGGER', {
          nature: 'historical',
          reason: best
            ? `The creator is ${best.hops === 0 ? 'itself' : `${best.hops} strong hop(s) from`} an address with confirmed malicious history on ${total} other launches (path confidence ${best.pathConfidence.toFixed(2)}).`
            : `The creator has confirmed malicious history on ${total} other launches.`,
          source: 'deep-intelligence',
          observedValue: `${total} confirmed malicious launches in the creator's network`,
          at: bundle.analyzedAt ?? now,
          recheckable: false,
          confidence: Math.min(attribution.confidence, best?.pathConfidence ?? attribution.confidence),
          freshness: bundle.network.freshness,
          ruleVersion: bundle.network.ruleVersion ?? RULE_VERSIONS.network,
          evidence: best ? best.path.map((p) => `${p.type} ${p.from.slice(0, 6)}…→${p.to.slice(0, 6)}… (${p.evidence.slice(0, 12)})`).slice(0, 6) : [],
        }),
      );
    }
  }

  // --- extreme manipulation ---------------------------------------------------------
  const wash = bundle.wash.value;
  if (usableIntel(bundle.wash) && wash) {
    const trips = wash.roundTripShare ?? 0;
    if (
      wash.risk === 'HIGH' &&
      bundle.wash.confidence >= GATE_V2.manipulationMinConfidence &&
      wash.families.length >= GATE_V2.manipulationMinFamilies &&
      wash.families.includes('ROUND_TRIPS') &&
      trips >= GATE_V2.manipulationMinRoundTrip &&
      wash.trades >= GATE_V2.manipulationMinTrades &&
      bundle.wash.coverage >= GATE_V2.manipulationMinCoverage
    ) {
      out.push(
        fail('EXTREME_MARKET_MANIPULATION', 'EXTREME_MARKET_MANIPULATION', {
          nature: 'current-state',
          reason: `${Math.round(trips * 100)}% of volume is round trips between the same or related wallets, with ${wash.families.length} of 4 manipulation families agreeing across ${wash.trades} trades.`,
          source: 'deep-intelligence',
          observedValue: `wash risk HIGH, ${wash.families.join(' + ').toLowerCase()}`,
          at: bundle.analyzedAt ?? now,
          recheckable: true,
          confidence: bundle.wash.confidence,
          freshness: bundle.wash.freshness,
          ruleVersion: bundle.wash.ruleVersion ?? RULE_VERSIONS.wash,
          evidence: bundle.wash.evidence.slice(0, 6),
        }),
      );
    }
  }
  return out;
}

export interface GateV2Result {
  hardFails: Veto[];
  families: HardFailFamily[];
  model: string;
}

/** Every hard fail: Phase 1's, described; then deep intelligence's. */
export function hardGateV2(legacy: Veto[], bundle: IntelligenceBundle, now: number): GateV2Result {
  const hardFails = [...legacy.map((v) => describeLegacyVeto(v, now)), ...intelligenceHardFails(bundle, now)];
  return { hardFails, families: [...new Set(hardFails.map((v) => v.family as HardFailFamily))], model: MODEL_VERSIONS.gate };
}
