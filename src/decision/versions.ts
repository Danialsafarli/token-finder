/**
 * Every version the decision layer stamps, and which rule versions it still
 * accepts as evidence.
 *
 * Three kinds of version live here, and they answer different questions:
 *
 * - **Policy** - which set of decision rules produced a verdict. Persisted on
 *   every stored snapshot and every verdict transition, so a later calibration
 *   phase can compare verdicts produced under different policies instead of
 *   mixing them.
 * - **Models** - which scoring model produced each number (integrity,
 *   opportunity, momentum, rank). A number without its model is not
 *   comparable across releases.
 * - **Rules** - which detection rules produced a stored intelligence finding
 *   (a security event, a wash reading, a network finding). This is what stops
 *   an old false positive from poisoning current decisions: a finding whose
 *   rule version is not in {@link ACCEPTED_RULES} stays in the database for
 *   audit, and is shown as such, but it is not decision evidence.
 *
 * ## Changing a rule
 *
 * When a detection rule changes in a way that can change a conclusion, bump
 * its version in {@link RULE_VERSIONS}. The previous version drops out of
 * {@link ACCEPTED_RULES} automatically (only the current one is listed), so
 * every finding made under the old rule stops counting until the current rule
 * re-detects it. Nothing is deleted. A rule change that provably cannot change
 * a conclusion (a refactor, a log message) does not need a bump.
 *
 * Findings written before versioning existed carry no version at all. They are
 * `UNVERSIONED`, which is treated exactly like superseded: kept, shown, never
 * counted.
 */

export const DECISION_POLICY_VERSION = 'decision-policy@1';

export const MODEL_VERSIONS = {
  gate: 'hard-gate@2',
  integrity: 'integrity@1',
  opportunity: 'opportunity@1',
  momentum: 'momentum@2',
  rank: 'rank@1',
  /** The Phase 1 composite score, still computed and stored beside the new models. */
  legacyScore: 'score@1',
} as const;

/**
 * The current version of each detection rule set in `src/intel/`.
 *
 * `activity` is at 2 because Phase 3 changed what an activity reading means:
 * it now aggregates every known pool, keeps volume to one quote currency, and
 * states how much of the market it saw. A version-1 reading made none of those
 * statements, so it cannot be read as though it had.
 */
export const RULE_VERSIONS = {
  security: 'security-events@1',
  wash: 'wash@2',
  activity: 'activity-quality@2',
  classify: 'buyer-class@1',
  cluster: 'cluster@1',
  attribution: 'attribution@1',
  creator: 'creator-history@1',
  network: 'serial-network@1',
} as const;

export type RuleDomain = keyof typeof RULE_VERSIONS;

/**
 * Rule versions whose findings still count as decision evidence. Only the
 * current version, by construction: a finding made under a rule the project
 * has since changed describes what an old rule thought, not what is true.
 */
export const ACCEPTED_RULES: Record<RuleDomain, readonly string[]> = Object.fromEntries(
  Object.entries(RULE_VERSIONS).map(([domain, version]) => [domain, [version]]),
) as unknown as Record<RuleDomain, readonly string[]>;

export type RuleStatus = 'CURRENT' | 'SUPERSEDED' | 'UNVERSIONED';

export function ruleStatus(domain: RuleDomain, version: string | null | undefined): RuleStatus {
  if (version === null || version === undefined || version === '') return 'UNVERSIONED';
  return ACCEPTED_RULES[domain].includes(version) ? 'CURRENT' : 'SUPERSEDED';
}

/** The rule versions a deep-intelligence snapshot is written under. */
export function currentRuleVersions(): Record<RuleDomain, string> {
  return { ...RULE_VERSIONS };
}
