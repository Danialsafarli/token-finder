/**
 * Types for the Decision Engine and the intelligence contract it reads.
 *
 * Kept free of runtime code so it erases cleanly and can be imported by
 * `src/types.ts` without a cycle.
 */

import type { Eligibility, EvidenceFreshness, HardFailFamily, Veto } from '../types.ts';

// ---------------------------------------------------------------------------
// The intelligence contract (Phase 2 -> Decision Engine)
// ---------------------------------------------------------------------------

/**
 * What the decision layer may conclude from one intelligence domain.
 *
 * - AVAILABLE         measured, current rule, enough of it
 * - PARTIAL           measured, but thin or truncated; usable with less weight
 * - INSUFFICIENT_DATA analysed, and there was too little to say anything
 * - UNAVAILABLE       never analysed, or the analysis could not run
 * - STALE             analysed too long ago to speak for the present
 * - SUPERSEDED        produced under a rule version this build no longer
 *                     accepts; kept for audit, never used
 *
 * None of these is "safe". UNKNOWN != SAFE, UNAVAILABLE != ZERO RISK,
 * INSUFFICIENT_DATA != CLEAN.
 */
export type IntelStatus = 'AVAILABLE' | 'PARTIAL' | 'INSUFFICIENT_DATA' | 'UNAVAILABLE' | 'STALE' | 'SUPERSEDED';

export interface DomainIntel<V> {
  domain: string;
  status: IntelStatus;
  /** The domain's reading, or null when there is none to use. */
  value: V | null;
  /** 0-1 where a risk is meaningful; null when not measured. Never 0 for "unknown". */
  risk: number | null;
  /** 0-1: what the reading is worth. */
  confidence: number;
  /** 0-1: how much of what the domain could observe was observed. */
  coverage: number;
  freshness: EvidenceFreshness;
  observedAt: number | null;
  evidence: string[];
  counterEvidence: string[];
  truncation: string[];
  ruleVersion: string | null;
  /** Why the domain has this status, in words. */
  note: string;
}

export type ActivityCategory = 'coordinated' | 'sniper' | 'automated' | 'likely_organic' | 'unknown';
export type ActivityBasis = 'wallets' | 'trades' | 'volume';

export interface ActivityBasisView {
  counts: Record<ActivityCategory, number>;
  /** Null when the classified share is below the floor: counts only, no percentages. */
  shares: Record<ActivityCategory, number> | null;
  total: number;
  /** Share of this basis that was classified (not unknown). */
  classified: number;
}

export interface PoolCoverage {
  address: string;
  dexId: string;
  quoteSymbol: string;
  observedTrades: number;
  reportedTrades24h: number | null;
  volumeShare: number | null;
}

export interface MarketCoverage {
  pools: PoolCoverage[];
  knownPools: number;
  observedPools: number;
  /** Share of 24h volume on pools we have readings from; null when volumes are unknown. */
  venueShare: number | null;
  /** Span of the observed trades, ms. */
  windowMs: number | null;
  observedTrades: number;
  /** Trades the providers' counts imply happened in that span, across every pool. */
  expectedTrades: number | null;
  /** observed / expected, 0-1; null when no provider reported counts. */
  sampleShare: number | null;
  /** 0-1: how far the sample can speak for the whole market. */
  representativeness: number;
  /** Quote currency volume was aggregated in; trades in any other are counted but not summed. */
  volumeQuote: string | null;
  excludedFromVolume: number;
  note: string;
}

export interface ActivityValue {
  byWallets: ActivityBasisView;
  byTrades: ActivityBasisView;
  byVolume: ActivityBasisView;
  market: MarketCoverage | null;
}

export interface WashValue {
  risk: 'LOW' | 'ELEVATED' | 'HIGH' | 'INSUFFICIENT_DATA';
  families: string[];
  roundTripShare: number | null;
  top3VolumeShare: number | null;
  trades: number;
  wallets: number;
  signals: { code: string; family: string; text: string; triggered: boolean }[];
}

export interface CoordinationValue {
  clusters: number;
  confirmed: number;
  strong: number;
  largest: number;
  weakPairs: number;
  /** Share of this token's trading wallets in a cluster with another of them. */
  coordinatedWalletShare: number | null;
  clusterSummaries: { id: string; level: string; size: number; confidence: number; reasons: string[] }[];
}

export interface AttributionValue {
  status: 'ATTRIBUTED' | 'AMBIGUOUS' | 'UNKNOWN';
  creator: string | null;
  confidence: number;
  basis: string;
  deployers: string[];
  initialFunder: string | null;
}

export interface SecurityEventView {
  id: string;
  mint: string;
  type: string;
  status: 'CONFIRMED' | 'STRONGLY_SUSPECTED' | 'SUSPICIOUS' | 'UNKNOWN';
  actor: string | null;
  creatorLinked: boolean;
  signature: string;
  blockTimeMs: number | null;
  confidence: number;
  reasons: string[];
  ruleVersion: string | null;
  ruleStatus: 'CURRENT' | 'SUPERSEDED' | 'UNVERSIONED';
  supersededAt: number | null;
  /** True only for current-rule findings that were not superseded. */
  active: boolean;
}

export interface SecurityValue {
  active: SecurityEventView[];
  /** Kept for audit: findings from obsolete rules, or superseded by a re-analysis. */
  superseded: SecurityEventView[];
  /** Whether the mint's history was read completely, partly, or not at all. */
  mintHistory: 'COMPLETE' | 'PARTIAL' | 'NONE' | 'UNKNOWN';
}

export interface CreatorValue {
  address: string | null;
  status: 'MALICIOUS_HISTORY' | 'SUSPICIOUS' | 'CLEAN' | 'INSUFFICIENT_HISTORY' | 'UNKNOWN';
  launches: number;
  /** Confirmed malicious launches other than this token, current rules only. */
  otherConfirmedLaunches: number;
  otherSuspectedLaunches: number;
  confirmedMints: string[];
  events: { mint: string; type: string; status: string }[];
  reasons: string[];
}

export interface NetworkFindingView {
  target: string;
  hops: number;
  pathConfidence: number;
  path: { from: string; to: string; type: string; confidence: number; evidence: string }[];
  /** Distinct launches with a current-rule CONFIRMED event, re-counted at decision time. */
  confirmedLaunches: number;
  suspectedLaunches: number;
  confirmedMints: string[];
}

export interface NetworkValue {
  level: 'STRONG' | 'MODERATE' | 'WEAK_ASSOCIATION' | 'NONE' | 'INSUFFICIENT_DATA';
  /** The level as analysed, before findings were re-validated against current rules. */
  analysedLevel: string;
  confidence: number;
  findings: NetworkFindingView[];
  weakAssociations: number;
  reasons: string[];
}

export interface HolderValue {
  /** Raw top-10 share, every account counted - curves and pool vaults included. */
  rawTop10Pct: number | null;
  /** Top-10 share among wallet-owned accounts only; null when any owner was unreadable. */
  walletTop10Pct: number | null;
  /** Jupiter's top-holder percentage, the figure the Phase 1 gate reads. */
  providerTopPct: number | null;
  byRolePct: Record<string, number> | null;
  resolved: number;
  total: number;
  /** True when every large account's owner was resolved, so the wallet figure can be used. */
  roleAware: boolean;
}

export interface IntelligenceBundle {
  mint: string;
  analyzedAt: number | null;
  activity: DomainIntel<ActivityValue>;
  wash: DomainIntel<WashValue>;
  coordination: DomainIntel<CoordinationValue>;
  attribution: DomainIntel<AttributionValue>;
  creator: DomainIntel<CreatorValue>;
  network: DomainIntel<NetworkValue>;
  security: DomainIntel<SecurityValue>;
  holders: DomainIntel<HolderValue>;
  /** Mean coverage of the deep domains (holders excluded: it comes from the scan). */
  coverage: number;
  /** Rule versions the snapshot was written under, as stored. */
  ruleVersions: Record<string, string> | null;
  truncation: string[];
}

// ---------------------------------------------------------------------------
// Integrity (safety) assessment
// ---------------------------------------------------------------------------

export type RiskBand = 'CLEAR' | 'LOW' | 'ELEVATED' | 'HIGH' | 'SEVERE' | 'UNKNOWN';

export interface RiskContribution {
  code: string;
  /** Correlated contributions share a family; within a family only the largest counts fully. */
  family: string;
  risk: number;
  confidence: number;
  /** Coverage of the evidence behind this contribution, when narrower than its domain's. */
  coverage?: number;
  text: string;
  evidence: string[];
}

export type IntegrityDomainKey =
  | 'tokenSecurity'
  | 'liquiditySafety'
  | 'holderIntegrity'
  | 'activityIntegrity'
  | 'walletCoordination'
  | 'creatorReputation'
  | 'rugHistory';

export interface IntegrityDomain {
  key: IntegrityDomainKey;
  label: string;
  weight: number;
  /** 0-1, or null when nothing in the domain was measured. */
  risk: number | null;
  band: RiskBand;
  confidence: number;
  coverage: number;
  contributions: RiskContribution[];
  /** What was checked and found clean - shown so "no risk" is never silent about its basis. */
  clean: string[];
  /** What could not be checked. */
  unknown: string[];
}

export interface IntegrityAssessment {
  model: string;
  /** 0-100; unmeasured domains earn nothing, as with every score here. Null with no coverage. */
  score: number | null;
  band: RiskBand;
  /** Coverage-weighted mean domain risk, 0-1. */
  risk: number;
  coverage: number;
  confidence: number;
  domains: IntegrityDomain[];
  /** The domain that decided the band, when one did. */
  driver: IntegrityDomainKey | null;
}

// ---------------------------------------------------------------------------
// Opportunity, momentum
// ---------------------------------------------------------------------------

export type OpportunityBand = 'STRONG' | 'MODERATE' | 'WEAK' | 'UNKNOWN';

export interface OpportunityComponent {
  key: 'participation' | 'capital' | 'liquidity' | 'distribution' | 'momentum' | 'maturity';
  label: string;
  weight: number;
  /** 0-1, or null when not measured. */
  value: number | null;
  coverage: number;
  detail: string;
}

export interface OpportunityAssessment {
  model: string;
  score: number;
  band: OpportunityBand;
  coverage: number;
  components: OpportunityComponent[];
  /** Independent participants: clusters collapse to one, bots count part, unknowns nothing. */
  effectiveParticipants: number | null;
}

export type MomentumState = 'ACCELERATING' | 'SUSTAINED' | 'NEUTRAL' | 'COOLING' | 'DECLINING' | 'UNSTABLE' | 'INSUFFICIENT_HISTORY';

export interface MomentumWindow {
  key: '30m' | '2h' | '6h';
  spanMs: number;
  /** Log return over the window. */
  logReturn: number;
  /** Simple return, for people. */
  change: number;
  observations: number;
}

export interface MomentumAssessment {
  model: string;
  state: MomentumState;
  score: number | null;
  confidence: number;
  observations: number;
  spanMs: number;
  windows: MomentumWindow[];
  persistence: number | null;
  spikiness: number | null;
  liquidityChange: number | null;
  holderChange: number | null;
  /** DexScreener's own frames, shown beside ours, never mixed into them. */
  providerFrames: { m5: number | null; h1: number | null; h6: number | null; h24: number | null } | null;
  reasons: string[];
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface Reason {
  kind: 'positive' | 'risk' | 'blocker' | 'hard_fail' | 'coverage';
  code: string;
  text: string;
  domain?: string;
}

export interface Decision {
  policyVersion: string;
  models: Record<string, string>;
  decidedAt: number;
  verdict: Eligibility;
  /** The fast screen's own verdict, before intelligence, for audit. */
  screen: { eligibility: Eligibility; vetoes: string[] };
  hardFails: Veto[];
  hardFailFamilies: HardFailFamily[];
  integrity: IntegrityAssessment;
  opportunity: OpportunityAssessment;
  momentum: MomentumAssessment;
  intelligence: {
    analyzedAt: number | null;
    coverage: number;
    domains: { key: string; status: IntelStatus; coverage: number; freshness: EvidenceFreshness; ruleVersion: string | null; note: string }[];
  };
  coverage: { market: number; intelligence: number; decision: number };
  confidence: number;
  /** Within-verdict ranking key. Null for REJECTED tokens: they are not ranked. */
  rankScore: number | null;
  rank: { opportunity: number; integrityPenalty: number; uncertaintyPenalty: number } | null;
  reasons: Reason[];
  /** The ladder step that decided the verdict, for "why". */
  basis: string;
}
