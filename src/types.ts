/** Shared domain types. Kept free of runtime code so it erases cleanly. */

import type { FieldIssue } from './core/validate.ts';
import type { Evidence, EvidenceState, TokenEvidence } from './core/evidence.ts';
import type { ProviderFailure, ProviderFailureKind } from './util/failure.ts';
import type { ExtensionPolicy, TokenProgram } from './core/token-program.ts';

export type { FieldIssue, Evidence, EvidenceState, TokenEvidence };
export type { ProviderFailure, ProviderFailureKind };
export type { ExtensionPolicy, TokenProgram };

/**
 * One Token-2022 mint extension as observed on the mint account.
 *
 * `active` is the only field that speaks about danger, and it is deliberately
 * tri-state. `true` means the dangerous condition is live now; `false` means
 * the extension is present but disarmed - a permanent delegate renounced to
 * `None`, a default account state of `initialized`; `null` means the extension
 * was present and its configuration could not be read, which is UNKNOWN and
 * never vetoes.
 */
export interface MintExtension {
  /** jsonParsed extension name exactly as the node reported it. */
  id: string;
  /** Human label, or the raw id when the extension is not recognised. */
  label: string;
  policy: ExtensionPolicy;
  active: boolean | null;
  /** Why this policy, in terms of what a holder stands to lose. */
  rationale: string;
  /** Whether the issuer can clear the dangerous condition. */
  recheckable: boolean;
  /** Audit detail, e.g. "delegate renounced to None" or "4.00% fee". */
  detail: string | null;
  /**
   * The policy-relevant scalar for extensions whose danger is a matter of
   * degree - currently only the transfer fee, in basis points.
   *
   * Null for every other extension, and null when the figure could not be
   * read. A `CONDITIONAL_VETO` with a null magnitude never clears its
   * threshold: an unreadable fee schedule is not a low one.
   */
  magnitude: number | null;
}

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
  /**
   * Base58 owner program of the mint account, null when it was not read.
   * This, and only this, decides {@link OnChainInfo.tokenProgram}: the program
   * is never inferred backwards from whether extensions were found, because a
   * Token-2022 mint with no extensions is indistinguishable from a legacy one
   * by that test.
   */
  programId: string | null;
  tokenProgram: TokenProgram;
  /**
   * Parsed mint extensions.
   *
   * `null` means the mint was never inspected. `[]` means it was inspected and
   * carried none - but only trust that together with
   * {@link OnChainInfo.extensionsComplete}, because an Agave node before 4.2
   * returns an empty array when it meets a single extension type it does not
   * recognise, hiding every other extension on the mint.
   */
  extensions: MintExtension[] | null;
  /**
   * False when the extension list is known to be partial: an
   * `unparseableExtension` marker, or an extension name this build does not
   * recognise. When false, "extension absent" is not a conclusion that can be
   * drawn, and the evidence layer reports UNKNOWN rather than safe.
   */
  extensionsComplete: boolean;
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
  /**
   * Mint decimals. SPL stores this as a `u8`, so the domain is 0-255 - it is
   * not the EVM 0-18 range, and a mint outside that range would previously
   * have been rejected here and then silently mixed raw and UI units.
   */
  decimals: number | null;
  /**
   * Total supply in whole tokens, for display only.
   *
   * Nothing in scoring divides by this. Concentration is computed from raw
   * base units on both sides of the ratio, so no code path can mix a raw
   * numerator with a UI denominator.
   */
  supply: number | null;
  /** Raw (base-unit) total supply as a decimal string; a u64 exceeds `number`. */
  rawSupply: string | null;
  /** Raw base-unit sum of the ten largest accounts, decimal string. */
  rawTop10: string | null;
  /** How many largest-account entries the node returned. */
  largestAccountsCount: number | null;
  /**
   * Share of supply held by the largest accounts, 0-1. Pool accounts included.
   * Computed as an exact integer ratio of raw base units, then converted to a
   * bounded `number` once.
   */
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
  | 'MALFORMED_TOKEN'
  // Token-2022 mint extensions. Each describes a power a third party holds
  // over the holder's position right now, not a market condition.
  | 'PERMANENT_DELEGATE_ACTIVE'
  | 'TRANSFER_HOOK_ACTIVE'
  | 'MINT_PAUSABLE'
  | 'DEFAULT_ACCOUNT_STATE_FROZEN'
  | 'NON_TRANSFERABLE'
  | 'EXTREME_TRANSFER_FEE';

/**
 * What kind of claim a veto is making about time.
 *
 * `current-state` vetoes describe how the token is *right now* - a live mint
 * authority, an empty pool. They require current evidence, because an old
 * reading of a changeable fact is not a fact about the present.
 *
 * `historical` vetoes describe something that happened and cannot un-happen -
 * a creator who has rugged before. Staleness is irrelevant: the event is as
 * true today as when it was recorded.
 */
export type VetoNature = 'current-state' | 'historical';

export interface Veto {
  code: VetoCode;
  /** Whether this describes the present or a permanent historical fact. */
  nature: VetoNature;
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
  /**
   * Providers that could not be reached while analysing this token. Recorded
   * rather than silently folded into "no data", so an outage is visibly
   * different from a token that genuinely has nothing to report.
   */
  providerFailures: ProviderFailure[];
  /**
   * True when a danger assertion was overridden - by staleness, or by a current
   * on-chain read contradicting it. The token is not vetoed for it, but the
   * disagreement is not forgotten either.
   */
  historicalDangerEvidence: boolean;
}

/** A value as the ledger records it: display-ready, JSON-safe, never a class. */
export type LedgerValue = number | boolean | string | string[] | Record<string, number> | null;

export interface LedgerClaim {
  provider: string;
  value: LedgerValue;
  observedAt: number;
  freshness: EvidenceFreshness;
  /** Why this provider's value was rejected at the boundary. */
  invalid?: string;
  /** Why this provider could not be reached. */
  unavailable?: string;
}

export type EvidenceFreshness = 'FRESH' | 'AGING' | 'STALE' | 'UNKNOWN';

/**
 * One metric's resolved evidence, flattened for display and persistence.
 *
 * A projection of `Evidence<T>` - it adds nothing and decides nothing. The
 * engine's resolution is the only authority; this is its receipt.
 */
export interface LedgerEntry {
  metric: string;
  state: EvidenceState;
  value: LedgerValue;
  source: string | null;
  observedAt: number | null;
  freshness: EvidenceFreshness;
  confidence: number;
  /** Share of evidence coverage this signal carries; 0 for informational rows. */
  weight: number;
  notes: string[];
  claims: LedgerClaim[];
  /** Claims that asserted a different value and lost, on staleness or precedence. */
  overridden: LedgerClaim[];
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
  /**
   * The resolved evidence behind this snapshot, one entry per coverage signal
   * plus the token program - what each provider claimed, which claim won, how
   * old it was and how much it was worth.
   *
   * Optional and additive: absent on snapshots written before it existed, in
   * which case the Dossier falls back to the persisted `evidence_snapshots`
   * rows (which carry the winning value but not every provider's claim).
   */
  ledger?: LedgerEntry[] | null;
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
