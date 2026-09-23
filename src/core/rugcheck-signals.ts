/**
 * What kind of claim a RugCheck finding makes about time.
 *
 * This decides whether a finding's penalty should survive its own age. A live
 * mint authority is a statement about *now* and stops being true the moment it
 * is revoked; a creator's history of rugging is a statement about the past and
 * is as true today as when it was recorded. Applying the same freshness rule to
 * both would either forgive real history or punish conditions that have since
 * been fixed.
 *
 * The classification is deliberately conservative. Anything that cannot be
 * defended from RugCheck's own documented semantics is `UNKNOWN_NATURE`, which
 * is kept as visible evidence but is not allowed to move a score - guessing
 * would mean a finding silently penalising a token for a reason nobody could
 * articulate.
 */

export type RiskNature =
  /** Describes the token right now; can stop being true. */
  | 'CURRENT_STATE'
  /** Describes something that happened; cannot un-happen. */
  | 'HISTORICAL'
  /** A property of the token that cannot change once set. */
  | 'PERMANENT'
  /** Not confidently classifiable. Evidence only; never scored. */
  | 'UNKNOWN_NATURE';

interface SignalRule {
  /** Lowercased substring match against the RugCheck risk name. */
  match: string;
  nature: RiskNature;
  /** Why this nature is defensible. Kept in code so the reasoning travels. */
  rationale: string;
}

/**
 * Ordered most specific first; the first match wins.
 *
 * Every entry here is a condition whose mutability is documented by RugCheck or
 * follows directly from how SPL tokens work. Names observed in the live corpus
 * are covered; anything else falls through to UNKNOWN_NATURE by design.
 */
const SIGNAL_RULES: readonly SignalRule[] = [
  // --- historical: an event that occurred -----------------------------------
  {
    match: 'creator history of rugged tokens',
    nature: 'HISTORICAL',
    rationale: 'the creator rugged previous tokens; that past cannot be undone by anything the token does now',
  },
  {
    match: 'rugged',
    nature: 'HISTORICAL',
    rationale: 'the token is reported as already rugged; the event has happened',
  },

  // --- current state: revocable or reversible conditions ---------------------
  {
    match: 'mint authority',
    nature: 'CURRENT_STATE',
    rationale: 'mint authority can be revoked at any time, after which the finding is simply false',
  },
  {
    match: 'freeze authority',
    nature: 'CURRENT_STATE',
    rationale: 'freeze authority can be revoked at any time',
  },
  {
    match: 'lp unlocked',
    nature: 'CURRENT_STATE',
    rationale: 'LP can be locked or burned after launch, which makes the finding stop being true',
  },
  {
    match: 'lp providers',
    nature: 'CURRENT_STATE',
    rationale: 'the number of LP providers changes continuously as people add and remove liquidity',
  },
  {
    match: 'low liquidity',
    nature: 'CURRENT_STATE',
    rationale: 'liquidity changes continuously; a reading from hours ago says nothing about the current pool',
  },
  {
    match: 'mutable metadata',
    nature: 'CURRENT_STATE',
    rationale: 'metadata mutability is an authority that can be renounced',
  },
  {
    match: 'single holder ownership',
    nature: 'CURRENT_STATE',
    rationale: 'holder distribution changes with every transfer',
  },
  {
    match: 'high ownership',
    nature: 'CURRENT_STATE',
    rationale: 'holder distribution changes with every transfer',
  },
  {
    match: 'holder concentration',
    nature: 'CURRENT_STATE',
    rationale: 'concentration is a snapshot of balances and moves with every transfer',
  },

  // --- permanent: set once at mint initialisation, never removable ----------
  {
    match: 'permanent control',
    nature: 'PERMANENT',
    rationale:
      'RugCheck names this condition permanent, and the Token-2022 permanent-delegate extension it describes is fixed at mint initialisation and cannot be revoked afterwards',
  },
  {
    match: 'transfer fee',
    nature: 'CURRENT_STATE',
    rationale: 'the SPL transfer-fee extension carries a config authority that can change or be revoked',
  },
];

export interface RiskClassification {
  nature: RiskNature;
  /** Why this nature was assigned. Empty for UNKNOWN_NATURE. */
  rationale: string;
}

const UNCLASSIFIED: RiskClassification = {
  nature: 'UNKNOWN_NATURE',
  rationale: '',
};

/**
 * Classifies a RugCheck risk by name.
 *
 * Unrecognised names return UNKNOWN_NATURE rather than being assumed
 * current-state or historical. That costs a penalty on findings we do not
 * recognise, which is the intended trade: a score should not move for a reason
 * the system cannot explain, and an unrecognised name is exactly that.
 */
export function classifyRisk(name: string): RiskClassification {
  const needle = name.toLowerCase();
  const rule = SIGNAL_RULES.find((entry) => needle.includes(entry.match));
  return rule === undefined
    ? UNCLASSIFIED
    : { nature: rule.nature, rationale: rule.rationale };
}

/**
 * Whether a finding of this nature should have its penalty suppressed once the
 * observation goes stale.
 *
 * Only CURRENT_STATE decays. HISTORICAL and PERMANENT findings describe things
 * age does not touch. UNKNOWN_NATURE never scores at all, so staleness is moot.
 */
export function decaysWhenStale(nature: RiskNature): boolean {
  return nature === 'CURRENT_STATE';
}

/** Whether a finding of this nature is ever allowed to move a score. */
export function canAffectScore(nature: RiskNature): boolean {
  return nature !== 'UNKNOWN_NATURE';
}

/** Every rule, for documentation and tests. */
export const RUGCHECK_SIGNAL_RULES = SIGNAL_RULES;
