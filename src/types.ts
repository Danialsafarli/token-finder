/** Shared domain types. Kept free of runtime code so it erases cleanly. */

import type { FieldIssue } from './core/validate.ts';
import type { Evidence, EvidenceState, TokenEvidence } from './core/evidence.ts';

export type { FieldIssue, Evidence, EvidenceState, TokenEvidence };

export interface TokenCandidate {
  mint: string;
  /** Where this mint came from, e.g. ["dexscreener:profiles", "jupiter:recent"]. */
  sources: string[];
  symbol?: string;
  name?: string;
}

export interface PairMetrics {
  pairAddress: string;
  dexId: string;
  baseSymbol: string;
  baseName: string;
  url: string;
  quoteSymbol: string;
  priceUsd: number | null;
  /** Null when the provider's figure failed validation - not the same as 0. */
  liquidityUsd: number | null;
  fdv: number | null;
  marketCap: number | null;
  /** Unix ms when the pair was created, null when absent or impossible. */
  pairCreatedAt: number | null;
  volume: NullableTimeframes;
  priceChange: NullableTimeframes;
  txns: Record<TimeframeKey, { buys: number | null; sells: number | null }>;
  imageUrl?: string;
  websites: string[];
  socials: { type: string; url: string }[];
  boosts: number;
  /** Fields this provider sent that were rejected at the boundary. */
  issues: FieldIssue[];
}

export type TimeframeKey = 'm5' | 'h1' | 'h6' | 'h24';
export type Timeframes = Record<TimeframeKey, number>;
export type NullableTimeframes = Record<TimeframeKey, number | null>;

export interface JupiterInfo {
  symbol: string | null;
  name: string | null;
  isVerified: boolean;
  tags: string[];
  organicScore: number | null;
  organicScoreLabel: string | null;
  holderCount: number | null;
  liquidityUsd: number | null;
  usdPrice: number | null;
  mcap: number | null;
  firstPoolCreatedAt: number | null;
  audit: {
    mintAuthorityDisabled: boolean | null;
    freezeAuthorityDisabled: boolean | null;
    topHoldersPercentage: number | null;
    devBalancePercentage: number | null;
  };
  stats24h: {
    numBuys: number | null;
    numSells: number | null;
    numTraders: number | null;
    holderChange: number | null;
  };
  issues: FieldIssue[];
}

export interface RugcheckInfo {
  /** RugCheck's own risk score; lower is safer. */
  score: number | null;
  /** 0-100 normalised risk, lower is safer. */
  scoreNormalised: number | null;
  risks: { name: string; level: string; description: string; score: number }[];
  issues: FieldIssue[];
}

export interface OnChainInfo {
  /** Base58 authority address, or null when the chain reports it revoked. */
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /**
   * Whether the response actually carried the field. `mintAuthority: null` with
   * `mintAuthorityStated: false` means we never learned it, which is not the
   * same as the chain telling us it is revoked.
   */
  mintAuthorityStated: boolean;
  freezeAuthorityStated: boolean;
  decimals: number | null;
  supply: number | null;
  /** Share of supply held by the largest accounts, 0-1. Pool accounts included. */
  top10Share: number | null;
  largestHolderShare: number | null;
  issues: FieldIssue[];
}

export type RiskLevel = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface RiskFlag {
  code: string;
  level: RiskLevel;
  message: string;
}

export interface ScoreComponent {
  key: string;
  label: string;
  /**
   * Normalised 0-1 quality for this dimension, or `null` when no evidence was
   * available. `null` is not `0`: a measured zero means the dimension is
   * genuinely bad, `null` means we do not know. Neither earns points, but only
   * `null` reduces {@link Score.coverage}.
   */
  value: number | null;
  weight: number;
  detail: string;
  /** Why {@link value} is null. Absent when the component is known. */
  unknownReason?: string;
  /**
   * Share of this component's own evidence that was available, 0-1. Scalar
   * components are 1 or 0; `safety` is fractional because it has sub-parts.
   */
  coverage: number;
}

export interface Score {
  /** Final 0-100 ranking score after risk penalties. */
  total: number;
  /** 0-100 before risk penalties were applied. */
  base: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  penalty: number;
  /**
   * Share of total component weight backed by real evidence, 0-1. Unknown
   * evidence earns no points, so a token with low coverage cannot rank highly.
   */
  coverage: number;
  /**
   * Highest total this token could have reached given what is unknown
   * (`100 x coverage`, before penalties). The gap to 100 is missing evidence,
   * not measured weakness.
   */
  ceiling: number;
  /** Component keys with no evidence at all. */
  unknown: string[];
  components: ScoreComponent[];
  flags: RiskFlag[];
}

/**
 * Advisory impersonation screening from TypeSafe's Jev model.
 *
 * This is a judgement about *naming*, not proof of fraud, and never a trading
 * signal. Any failure - missing credentials, HTTP error, timeout, malformed
 * body - must produce `not_assessed`. There is deliberately no `safe` status:
 * absence of an assessment is never evidence of legitimacy.
 */
export interface ImpersonationAssessment {
  status: 'assessed' | 'not_assessed';
  /** Probability the name/symbol impersonates a reference token. Null unless assessed. */
  probability: number | null;
  /** Model identifier as returned by the API, e.g. "jev-1.13.0". */
  model: string | null;
  /** Unix ms when the assessment was made or attempted. */
  at: number;
  /** Why the assessment could not be made. Absent when status is 'assessed'. */
  reason?: ImpersonationSkipReason;
  /** Question key sent to the API, so a stored answer can be traced to its question. */
  questionId: string;
  /** Exactly what evidence was supplied to the model, by reference. */
  evidence: {
    /** Sanitised candidate text actually sent. */
    symbol: string | null;
    name: string | null;
    /** Jupiter's own verification flag, supplied as corroborating evidence. */
    jupiterVerified: boolean;
    /** Version of the in-repo reference list used. */
    referenceListId: string;
    /** Mints of the reference tokens supplied for comparison. */
    referenceMints: string[];
  };
}

export type ImpersonationSkipReason =
  | 'disabled'
  | 'no_credentials'
  | 'no_reference_match'
  | 'budget_exhausted'
  | 'api_error'
  | 'invalid_response';

/**
 * A hard safety veto. Unlike a penalty, this removes a token from the ranking
 * entirely: some conditions are not "score a bit lower", they are "do not show
 * this next to candidates a person might act on".
 */
export type VetoCode =
  | 'AUTHORITY_MINT_ACTIVE'
  | 'AUTHORITY_FREEZE_ACTIVE'
  | 'CRITICAL_RUGCHECK'
  | 'UNTRADEABLE'
  | 'LIQUIDITY_TOO_LOW'
  | 'CATASTROPHIC_CONCENTRATION'
  | 'MALFORMED_TOKEN';

export interface Veto {
  code: VetoCode;
  /** Plain-language reason, safe to show a person with no context. */
  reason: string;
  /** Which provider's evidence triggered this. */
  source: string;
  /** The value observed, rendered for the audit trail. */
  observedValue: string;
  /** Unix ms when the triggering evidence was observed. */
  at: number;
  /**
   * Whether this can clear on fresh evidence. A revocable authority can be
   * revoked later; a creator's history of rugs cannot be undone.
   */
  recheckable: boolean;
}

/** Where a token sits relative to the main ranking. */
export type Eligibility = 'QUALIFIED' | 'WATCH' | 'INSUFFICIENT_DATA' | 'REJECTED';

/** Deterministic token lifecycle. No trading states exist yet, by design. */
export type TokenState =
  | 'DISCOVERED'
  | 'SCANNING'
  | 'INSUFFICIENT_DATA'
  | 'WATCH'
  | 'QUALIFIED'
  | 'REJECTED';

/**
 * Evidence accounting, kept deliberately separate from the score.
 *
 * `score` says how good the token looks. `coverage` says how much of that
 * judgement rests on real observation. `confidence` says how much the
 * observations themselves are worth once conflict, age and single-provider
 * dependence are accounted for. Collapsing the three into one number is what
 * lets a token with almost no data look like a strong candidate.
 */
export interface CoverageReport {
  /** Signals that could in principle have been measured for this token. */
  eligibleSignals: number;
  measured: number;
  unknown: number;
  conflicted: number;
  invalid: number;
  stale: number;
  unavailable: number;
  /** Share of scoring weight backed by usable evidence, 0-1. */
  coverage: number;
  /** 0-1, reduced by conflict, staleness and provider concentration. */
  confidence: number;
  /**
   * Largest share of covered weight supplied by any single provider, 0-1.
   * A token whose entire profile comes from one source is one outage - or one
   * wrong field - away from being a different token.
   */
  providerConcentration: number;
  /** Provider that supplied the most evidence, for the audit trail. */
  dominantProvider: string | null;
}

/**
 * Everything the pipeline concluded about a token, beyond its numeric score.
 * Persisted on the snapshot so a ranking decision can be explained later.
 */
export interface Evaluation {
  state: TokenState;
  eligibility: Eligibility;
  /** Unix ms when the state last changed. */
  stateChangedAt: number;
  /** State this token held before the current one, null on first evaluation. */
  previousState: TokenState | null;
  vetoes: Veto[];
  coverage: CoverageReport;
  /** Metric keys whose providers disagreed. */
  conflicts: string[];
  /** Provider fields rejected at the boundary during this analysis. */
  issues: FieldIssue[];
}

export interface TokenSnapshot {
  mint: string;
  symbol: string;
  name: string;
  sources: string[];
  /** Unix ms of this snapshot. */
  at: number;
  /** Best estimate of launch time (earliest pool), unix ms. */
  launchedAt: number | null;
  ageHours: number | null;
  priceUsd: number | null;
  /** Null when no provider reported liquidity, which is not the same as zero. */
  liquidityUsd: number | null;
  /** Null when no pair reported volume, which is not the same as zero volume. */
  volume24h: number | null;
  marketCap: number | null;
  fdv: number | null;
  holders: number | null;
  /** Null when no DexScreener pair exists, so no price change was ever measured. */
  priceChange: Timeframes | null;
  buyRatio24h: number | null;
  pair: PairMetrics | null;
  jupiter: JupiterInfo | null;
  rugcheck: RugcheckInfo | null;
  onchain: OnChainInfo | null;
  /** Advisory naming check; null when screening never ran for this token. */
  impersonation: ImpersonationAssessment | null;
  score: Score;
  /** Gate, coverage and lifecycle outcome. Null only on legacy snapshots. */
  evaluation: Evaluation | null;
}

export type EventKind =
  | 'discovered'
  | 'score_up'
  | 'score_down'
  | 'liquidity_drop'
  | 'price_spike'
  | 'risk_flag'
  | 'gone';

export interface MonitorEvent {
  id: string;
  at: number;
  kind: EventKind;
  mint: string;
  symbol: string;
  level: RiskLevel;
  message: string;
  data?: Record<string, unknown>;
}

export interface HistoryPoint {
  at: number;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
  score: number;
}
