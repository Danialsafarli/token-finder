/**
 * The hard safety gate.
 *
 * Runs before ranking. Some conditions are not "score a bit lower" - they mean
 * the token should not sit in a list a person scans for candidates. A penalty
 * multiplier cannot express that, because a strong enough token can absorb one
 * and stay near the top.
 *
 * ## Design rules
 *
 * - **Never veto on UNKNOWN.** Absence of evidence is not evidence of danger
 *   any more than it is evidence of safety. A veto requires a provider to have
 *   actually asserted the dangerous condition.
 * - **Never veto a current-state condition on stale evidence.** `isCurrent()`
 *   below requires FRESH or AGING. An old reading of a changeable fact - an
 *   authority that may since have been revoked, liquidity that may since have
 *   been added - is not a fact about the present. Historical vetoes are exempt
 *   by construction: a creator's rug history does not expire.
 * - **Every veto declares its nature**, so a reader can tell "this is true now"
 *   from "this happened once and always will have".
 * - **Re-checkability is separate from nature.** A current-state veto is
 *   re-checkable because the world can change; a historical one is not,
 *   because the past cannot.
 * - **CONFLICTED counts as asserted.** Resolution already took the conservative
 *   reading, so a disputed authority still fires. A contested claim of safety
 *   is not a claim of safety.
 * - **Every veto carries its evidence.** Code, reason, source, observed value,
 *   timestamp, and whether it can clear. A ranking decision a person cannot
 *   audit is not a safety feature.
 * - **Thresholds reuse existing documented config where one exists.** Two are
 *   new: the catastrophic-concentration bar, justified below, and
 *   `TRANSFER_FEE_VETO_BPS`, justified where it is defined. Neither is
 *   calibrated against outcome data, and both say so.
 */

import {
  isCurrentEnough,
  isEvidenceScorable,
  isUsable,
  type Evidence,
  type TokenEvidence,
} from './evidence.ts';
import { TRANSFER_FEE_VETO_BPS } from './token-program.ts';
import type { Veto, VetoCode } from '../types.ts';

export interface GateConfig {
  /** Liquidity below which an exit is not realistically possible. */
  minLiquidityUsd: number;
  /**
   * Holder concentration that makes the token one wallet's decision.
   *
   * The existing `concentration` risk flag fires at 60% and is a penalty. A
   * veto has to mean something strictly worse than "heavily concentrated", so
   * this sits well above it: at 90% the float is small enough that any exit
   * competes with a single holder who can end the market. Operator-tunable,
   * and explicitly not calibrated against outcome data.
   */
  catastrophicConcentrationPct: number;
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  minLiquidityUsd: 3_000,
  catastrophicConcentrationPct: 90,
};

/**
 * RugCheck findings severe enough to remove a token from the ranking.
 *
 * Deliberately short. Most `danger` findings (low liquidity, unlocked LP) are
 * already expressed as penalties and as scoring inputs; promoting all of them
 * to vetoes would empty the board. These are the ones that describe an actor
 * or a construction rather than a market condition.
 */
const CRITICAL_RUGCHECK_RISKS: { match: string; recheckable: boolean; why: string }[] = [
  {
    match: 'creator history of rugged tokens',
    recheckable: false,
    why: 'the creator has previously rugged tokens; this history cannot be undone',
  },
  {
    match: 'rugged',
    recheckable: false,
    why: 'RugCheck reports this token as already rugged',
  },
];

/**
 * Whether evidence is current enough to justify a claim about the present.
 *
 * Delegates to the shared {@link isEvidenceScorable} rather than keeping its
 * own copy of the rule. The gate having a private freshness check while the
 * penalty loop had none is exactly how the two layers drifted apart: stale
 * evidence stopped vetoing but kept on penalising.
 */
function isCurrent(evidence: Evidence<unknown>): boolean {
  return isEvidenceScorable(evidence);
}

/** Renders an observed value for the audit trail without trusting its type. */
function show(value: unknown): string {
  if (value === null || value === undefined) return 'unknown';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value).slice(0, 120);
}

/**
 * Which veto code each disqualifying extension raises.
 *
 * An extension with no entry here cannot veto, whatever its policy. That is
 * deliberate: the mapping is the list of powers this build claims to
 * understand well enough to reject a token over, and it is shorter than the
 * list of extensions it can parse.
 */
const EXTENSION_VETO_CODES: Record<string, VetoCode> = {
  permanentdelegate: 'PERMANENT_DELEGATE_ACTIVE',
  transferhook: 'TRANSFER_HOOK_ACTIVE',
  pausableconfig: 'MINT_PAUSABLE',
  defaultaccountstate: 'DEFAULT_ACCOUNT_STATE_FROZEN',
  nontransferable: 'NON_TRANSFERABLE',
  transferfeeconfig: 'EXTREME_TRANSFER_FEE',
};

/**
 * Vetoes arising from Token-2022 mint extensions.
 *
 * Reads {@link TokenEvidence.observedExtensions} rather than the
 * coverage-bearing `mintExtensions` Evidence, for the same reason the RugCheck
 * gate reads the raw finding list: an extension we positively observed is a
 * fact about this mint whether or not we managed to enumerate the rest. Not
 * knowing if there are others is no reason to ignore the one in hand.
 *
 * The three rules the rest of the gate lives by all hold here:
 *
 * - **UNKNOWN never vetoes.** `active === null` means the extension was present
 *   and its configuration could not be read. That earns no veto, and no
 *   reassurance either - it is recorded and it lowers coverage.
 * - **Disarmed is not dangerous.** A permanent delegate renounced to `None`
 *   (`active === false`) fires nothing. Vetoing on the extension's mere
 *   presence would reject mints whose issuer has already given the power up,
 *   which is the opposite of what the policy should encourage.
 * - **Stale evidence cannot assert a current fact.** Every extension veto is
 *   current-state - each describes a power somebody holds *now* - so all of
 *   them require a current observation.
 */
export function evaluateExtensionGate(evidence: TokenEvidence): Veto[] {
  // Which extensions exist is fixed at mint initialisation, but whether they
  // are armed is not, so an old reading cannot speak for the present.
  if (!isCurrentEnough(evidence.mintExtensionsFreshness)) return [];

  const vetoes: Veto[] = [];
  // Not `mintExtensions.observedAt`: that is null on an incomplete read, and
  // an incomplete read is exactly the case where a veto can still fire.
  const at = evidence.mintExtensionsObservedAt ?? Date.now();

  for (const extension of evidence.observedExtensions) {
    // Present but disarmed, or present and unreadable. Neither is a veto.
    if (extension.active !== true) continue;

    const code = EXTENSION_VETO_CODES[extension.id.toLowerCase()];
    if (code === undefined) continue;

    // The one conditional policy: a transfer fee is a cost until it is large
    // enough to be a trap. An unreadable fee schedule cannot clear the bar,
    // because we do not know what it says.
    if (extension.policy === 'CONDITIONAL_VETO') {
      const bps = extension.magnitude;
      if (bps === null || bps < TRANSFER_FEE_VETO_BPS) continue;
    } else if (extension.policy !== 'HARD_VETO') {
      continue;
    }

    vetoes.push({
      code,
      nature: 'current-state',
      reason: `${extension.label}: ${extension.rationale}`,
      source: evidence.mintExtensions.source ?? 'helius',
      observedValue: extension.detail ?? `${extension.label} active`,
      at,
      recheckable: extension.recheckable,
    });
  }

  return vetoes;
}

/**
 * Evaluates every veto rule against resolved evidence.
 *
 * Returns all vetoes that fire, not just the first: an operator looking at a
 * rejected token should see every reason it was rejected, since fixing one
 * would not make it eligible.
 */
export function evaluateGate(
  evidence: TokenEvidence,
  config: GateConfig = DEFAULT_GATE_CONFIG,
): Veto[] {
  const vetoes: Veto[] = [...evaluateExtensionGate(evidence)];

  // --- authorities ---------------------------------------------------------
  // `false` means the authority is still live. UNKNOWN never reaches here
  // because isUsable() requires MEASURED or CONFLICTED.
  const mint = evidence.mintAuthorityRevoked;
  if (isCurrent(mint) && mint.value === false) {
    vetoes.push({
      code: 'AUTHORITY_MINT_ACTIVE',
      nature: 'current-state',
      reason:
        'Mint authority is still live - the supply can be inflated at will, so any position can be diluted to nothing.',
      source: mint.source ?? 'unknown',
      observedValue: mint.state === 'CONFLICTED' ? 'live (disputed between providers)' : 'live',
      at: mint.observedAt ?? Date.now(),
      // An authority can be revoked after launch, so this can clear.
      recheckable: true,
    });
  }

  const freeze = evidence.freezeAuthorityRevoked;
  if (isCurrent(freeze) && freeze.value === false) {
    vetoes.push({
      code: 'AUTHORITY_FREEZE_ACTIVE',
      nature: 'current-state',
      reason:
        'Freeze authority is still live - holder accounts can be frozen, which can make selling impossible.',
      source: freeze.source ?? 'unknown',
      observedValue: freeze.state === 'CONFLICTED' ? 'live (disputed between providers)' : 'live',
      at: freeze.observedAt ?? Date.now(),
      recheckable: true,
    });
  }

  // --- tradability ---------------------------------------------------------
  const tradable = evidence.tradable;
  if (isCurrent(tradable) && tradable.value === false) {
    vetoes.push({
      code: 'UNTRADEABLE',
      nature: 'current-state',
      reason: 'No venue reports any usable liquidity, so there is nothing to trade against.',
      source: tradable.source ?? 'derived',
      observedValue: '0 liquidity across every known pair',
      at: tradable.observedAt ?? Date.now(),
      recheckable: true,
    });
  }

  // --- liquidity floor -----------------------------------------------------
  const liquidity = evidence.liquidityUsd;
  if (isCurrent(liquidity) && (liquidity.value as number) > 0 && (liquidity.value as number) < config.minLiquidityUsd) {
    vetoes.push({
      code: 'LIQUIDITY_TOO_LOW',
      nature: 'current-state',
      reason: `Only ${show(liquidity.value)} USD of pooled liquidity - below the ${config.minLiquidityUsd} USD floor, an exit would move the price against itself.`,
      source: liquidity.source ?? 'unknown',
      observedValue: show(liquidity.value),
      at: liquidity.observedAt ?? Date.now(),
      recheckable: true,
    });
  }

  // --- concentration -------------------------------------------------------
  // Only Jupiter's holder percentage can trigger this. Helius top10Share
  // includes AMM pool vaults, so vetoing on it would reject healthy tokens
  // whose liquidity simply sits in a pool account.
  const concentration = evidence.topHoldersPct;
  if (
    isCurrent(concentration) &&
    concentration.source === 'jupiter' &&
    (concentration.value as number) >= config.catastrophicConcentrationPct
  ) {
    vetoes.push({
      code: 'CATASTROPHIC_CONCENTRATION',
      nature: 'current-state',
      reason: `Top holders control ${show(concentration.value)}% of supply - the float is small enough that a single holder can end the market.`,
      source: concentration.source ?? 'unknown',
      observedValue: `${show(concentration.value)}%`,
      at: concentration.observedAt ?? Date.now(),
      recheckable: true,
    });
  }

  return vetoes;
}

/**
 * RugCheck vetoes are evaluated from the raw risk list rather than resolved
 * evidence, because the finding is a named condition, not a value.
 */
export function evaluateRugcheckGate(
  risks: { name: string; level: string; description: string }[],
  observedAt: number,
): Veto[] {
  const vetoes: Veto[] = [];

  for (const risk of risks) {
    if (risk.level !== 'danger') continue;
    const name = risk.name.toLowerCase();
    const critical = CRITICAL_RUGCHECK_RISKS.find((entry) => name.includes(entry.match));
    if (!critical) continue;

    vetoes.push({
      code: 'CRITICAL_RUGCHECK',
      // Historical by construction: these findings describe an event, and an
      // event does not stop having happened because the report aged.
      nature: 'historical',
      reason: `RugCheck: ${risk.name} - ${critical.why}.`,
      source: 'rugcheck',
      observedValue: `${risk.name} (danger)`,
      at: observedAt,
      recheckable: critical.recheckable,
    });
  }

  return vetoes;
}

/**
 * A token whose critical fields were structurally impossible.
 *
 * Only fields that would corrupt a safety decision count here. A rejected
 * `imageUrl` is a cosmetic problem; a supply that cannot be reconciled with
 * holder balances means we do not know what this token is.
 */
const CRITICAL_FIELDS = [
  'liquidity.usd',
  'liquidity',
  'supply',
  'decimals',
  'top10Share',
  'mintAuthority',
  'freezeAuthority',
  // The program that owns the mint decides how every other on-chain field is
  // to be read. An unparseable owner means we do not know which token model
  // applies, which is not a condition to score through.
  'programId',
  'audit.mintAuthorityDisabled',
  'audit.freezeAuthorityDisabled',
];

export function evaluateMalformedGate(
  issues: { field: string; reason: string }[],
  observedAt: number,
): Veto[] {
  const critical = issues.filter((issue) => CRITICAL_FIELDS.includes(issue.field));
  if (critical.length === 0) return [];

  return [
    {
      code: 'MALFORMED_TOKEN',
      nature: 'current-state',
      reason: `Structural provider data failed validation (${critical
        .map((issue) => `${issue.field}: ${issue.reason}`)
        .slice(0, 3)
        .join('; ')}) - the token cannot be assessed safely.`,
      source: 'validation',
      observedValue: critical.map((issue) => issue.field).join(', '),
      at: observedAt,
      // A provider can start returning sane data again.
      recheckable: true,
    },
  ];
}
