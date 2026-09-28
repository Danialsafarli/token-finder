/**
 * Frontend-facing data shapes.
 *
 * The browser never receives a raw `TokenSnapshot` or a database row. It gets
 * these DTOs, which exist for three reasons:
 *
 * - **Size.** A full snapshot is ~3.7 KB; a Board row needs a tenth of that.
 * - **One source of language.** Verdict labels, reasons and unknown-signal names
 *   are computed server-side by present.ts, so no two surfaces word a fact
 *   differently.
 * - **A narrow trust boundary.** URLs are filtered to http(s) here as well as
 *   in the renderer, and internal fields the UI has no use for never leave the
 *   server.
 *
 * Strings from providers (symbol, name, RugCheck text, event messages) are
 * passed through as data. They are escaped at render time by the frontend's
 * `html` template - the only place HTML is produced.
 */

import { CANDIDATE_VERDICTS, countUniverse, currentAgeHours, placementOf, rankKey, VERDICT_TIER, type Universe, type UniverseCounts } from '../core/ranking.ts';
import { safeHttpUrl } from './security.ts';
import { COVERAGE_WEIGHTS } from '../core/lifecycle.ts';
import {
  BAND_LABEL,
  BAND_TONE,
  changeReason,
  FAMILY_LABEL,
  METRIC_GROUP,
  MOMENTUM_LABEL,
  MOMENTUM_TONE,
  metricLabel,
  signalCounts,
  sourceLabel,
  unknownSignals,
  VERDICT_LABEL,
  VERDICT_TONE,
  verdictReason,
  vetoLabelFor,
  vetoView,
  type Tone,
  type UnknownSignal,
  type VetoView,
} from './present.ts';
import type { Capability } from '../core/capabilities.ts';
import { holderIntel } from '../decision/contract.ts';
import type { Decision, IntelligenceBundle, MarketCoverage, SecurityEventView } from '../decision/types.ts';
import type { StoredEvidence, VerdictChange, VerdictPoint, MarketPoint, HolderPoint } from '../persist/repository.ts';
import type { Eligibility, LedgerClaim, LedgerEntry, LedgerValue, MonitorEvent, TokenSnapshot } from '../types.ts';

export interface DtoContext {
  now: number;
  windowMs: number;
  globallyOff: ReadonlySet<string>;
  minCoverageQualify: number;
  minCoverageWatch: number;
  /** The gate's liquidity floor (config.minLiquidityUsd). */
  minLiquidityUsd: number;
  /** The gate's concentration veto, applied to Jupiter's figure only. */
  catastrophicConcentrationPct: number;
  helius: boolean;
}

/** Plain dollar amount for sentences. */
function dollars(value: number): string {
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${Math.round(value)}`;
}

export interface Watchpoint {
  tone: Tone;
  text: string;
}

/**
 * How close a token is to a different verdict, in the gate's own terms.
 *
 * Every line restates a real rule with its real threshold - the liquidity floor
 * and concentration veto from core/gate.ts, the coverage ladder from
 * core/lifecycle.ts. Nothing here predicts; it measures distance to a line the
 * engine already draws.
 */
export function watchpoints(token: TokenSnapshot, rows: readonly { metric: string; value: LedgerValue; source: string | null; state: string }[], context: DtoContext): Watchpoint[] {
  const evaluation = token.evaluation;
  if (evaluation == null) return [];
  const out: Watchpoint[] = [];
  const eligibility = evaluation.eligibility;
  const coverage = evaluation.coverage.coverage;
  const pctOf = (value: number): string => `${Math.round(value * 100)}%`;

  const liquidity = token.liquidityUsd;
  if (eligibility !== 'REJECTED' && typeof liquidity === 'number' && liquidity > 0 && liquidity < context.minLiquidityUsd * 3) {
    out.push({ tone: 'warn', text: `Liquidity ${dollars(liquidity)} — the gate rejects below ${dollars(context.minLiquidityUsd)}.` });
  }

  if ((eligibility === 'QUALIFIED' || eligibility === 'HIGH_POTENTIAL') && coverage < context.minCoverageQualify + 0.1) {
    out.push({ tone: 'warn', text: `Coverage ${pctOf(coverage)} — falls to Watch below ${pctOf(context.minCoverageQualify)}.` });
  } else if (eligibility === 'WATCH') {
    out.push({ tone: 'warn', text: `Coverage ${pctOf(coverage)} — qualifies at ${pctOf(context.minCoverageQualify)}; insufficient below ${pctOf(context.minCoverageWatch)}.` });
  } else if (eligibility === 'INSUFFICIENT_DATA') {
    out.push({ tone: 'neutral', text: `Coverage ${pctOf(coverage)} — needs ${pctOf(context.minCoverageWatch)} to be watched, ${pctOf(context.minCoverageQualify)} to qualify.` });
  }

  const top = rows.find((row) => row.metric === 'topHoldersPct');
  if (
    eligibility !== 'REJECTED' &&
    top && top.source === 'jupiter' && typeof top.value === 'number' &&
    (top.state === 'MEASURED' || top.state === 'CONFLICTED') &&
    top.value >= context.catastrophicConcentrationPct - 20
  ) {
    out.push({ tone: 'warn', text: `Top holders hold ${top.value.toFixed(0)}% — the gate rejects at ${context.catastrophicConcentrationPct}%.` });
  }

  if (eligibility === 'REJECTED') {
    const permanent = evaluation.vetoes.filter((veto) => !veto.recheckable).length;
    const clearable = evaluation.vetoes.length - permanent;
    if (clearable > 0) out.push({ tone: 'neutral', text: `${clearable} veto${clearable === 1 ? '' : 'es'} can clear if fresh evidence changes.` });
    if (permanent > 0) out.push({ tone: 'bad', text: `${permanent} veto${permanent === 1 ? ' describes' : 'es describe'} history that cannot change.` });
  }

  // The decision engine's own "why not higher": each unmet High-potential
  // condition, stated with its threshold.
  const decision = token.decision;
  if (decision && eligibility === 'QUALIFIED') {
    const blockers = decision.reasons.filter((r) => r.kind === 'blocker').map((r) => r.text);
    if (blockers.length) out.push({ tone: 'neutral', text: `High potential needs: ${blockers.slice(0, 3).join('; ')}.` });
  }
  if (decision && eligibility === 'HIGH_RISK') {
    const driver = decision.integrity.domains.find((d) => d.key === decision.integrity.driver);
    if (driver) out.push({ tone: 'bad', text: `${driver.label} is ${(BAND_LABEL[driver.band] ?? driver.band).toLowerCase()}; the verdict clears when that evidence does.` });
  }
  return out;
}

const round = (value: number | null | undefined, digits = 2): number | null =>
  value === null || value === undefined || !Number.isFinite(value) ? null : Number(value.toFixed(digits));

/** Significant figures for prices: micro-prices keep their precision. */
const sig = (value: number | null | undefined): number | null =>
  value === null || value === undefined || !Number.isFinite(value) ? null : Number(value.toPrecision(6));

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

export interface BoardRow {
  mint: string;
  symbol: string;
  name: string;
  icon: string | null;
  verified: boolean;
  verdict: Eligibility;
  reason: string;
  tone: Tone;
  score: number;
  coverage: number;
  liquidityUsd: number | null;
  change1h: number | null;
  ageHours: number | null;
  lastSeenAt: number;
  freshness: 'FRESH' | 'AGING';
  program: 'LEGACY_SPL_TOKEN' | 'TOKEN_2022' | null;
  /** The within-verdict ranking key; the Phase 1 score for pre-Phase-3 snapshots. */
  rank: number | null;
  /** Coverage the rank rests on: market evidence and deep intelligence together. */
  rankCoverage: number;
  integrity: { band: string; label: string; tone: Tone; coverage: number } | null;
  momentum: { state: string; label: string; tone: Tone } | null;
}

/**
 * Token icon URL, https only, and smaller when the host supports it.
 *
 * DexScreener's CDN serves 800px originals (~36 KB) by default. It accepts only
 * certain sizes - observed: 64, 128, 256 and 800; anything else answers 422 and
 * the icon silently disappears. 128 is sharp at 2x for every icon size the UI
 * draws and about a third of the bytes. This is undocumented behaviour, so the
 * rewrite is confined to that host and to the size values seen to work.
 */
const DEXSCREENER_ICON_SIZE = '128';

export function iconUrl(raw: unknown): string | null {
  const url = safeHttpUrl(raw, { httpsOnly: true });
  if (url === null) return null;
  const parsed = new URL(url);
  if (parsed.hostname === 'cdn.dexscreener.com' && parsed.searchParams.has('width')) {
    parsed.searchParams.set('width', DEXSCREENER_ICON_SIZE);
    parsed.searchParams.set('height', DEXSCREENER_ICON_SIZE);
    return parsed.href;
  }
  return url;
}

export function boardRow(token: TokenSnapshot, context: DtoContext): BoardRow {
  const placement = placementOf(token, context.now, context.windowMs);
  const evaluation = token.evaluation!;
  const decision = token.decision ?? null;
  const reason = verdictReason(token, context);
  const program = token.onchain?.tokenProgram;

  return {
    mint: token.mint,
    symbol: token.symbol,
    name: token.name,
    icon: iconUrl(token.pair?.imageUrl),
    verified: token.jupiter?.isVerified === true,
    verdict: evaluation.eligibility,
    reason: reason.text,
    tone: reason.tone,
    score: Math.round(token.score.total),
    coverage: round(evaluation.coverage.coverage, 3) ?? 0,
    liquidityUsd: round(token.liquidityUsd, 0),
    change1h: round(token.priceChange?.h1 ?? null, 1),
    ageHours: round(currentAgeHours(token, context.now), 2),
    lastSeenAt: token.at,
    freshness: placement.freshness ?? 'AGING',
    program: program === 'LEGACY_SPL_TOKEN' || program === 'TOKEN_2022' ? program : null,
    rank: decision ? (decision.rankScore === null ? null : Math.round(decision.rankScore)) : Math.round(token.score.total),
    rankCoverage: round(decision ? decision.coverage.decision : evaluation.coverage.coverage, 3) ?? 0,
    integrity: decision
      ? { band: decision.integrity.band, label: BAND_LABEL[decision.integrity.band] ?? decision.integrity.band, tone: BAND_TONE[decision.integrity.band] ?? 'neutral', coverage: round(decision.integrity.coverage, 3) ?? 0 }
      : null,
    momentum: decision
      ? { state: decision.momentum.state, label: MOMENTUM_LABEL[decision.momentum.state] ?? decision.momentum.state, tone: MOMENTUM_TONE[decision.momentum.state] ?? 'neutral' }
      : null,
  };
}

/**
 * Board segments. `candidates` - the default - is the ranking a person scans:
 * High potential, Qualified and Watch. High risk, insufficient data and
 * rejected tokens have their own segments and never pollute it.
 */
export type Segment = 'candidates' | 'high-potential' | 'qualified' | 'watch' | 'insufficient' | 'high-risk' | 'rejected' | 'all';
export type BoardSort = 'verdict' | 'score' | 'liquidity' | 'momentum' | 'newest' | 'seen';

const SEGMENTS: readonly Segment[] = ['candidates', 'high-potential', 'qualified', 'watch', 'insufficient', 'high-risk', 'rejected', 'all'];

const SEGMENT_ELIGIBILITY: Record<Exclude<Segment, 'all' | 'candidates'>, Eligibility> = {
  'high-potential': 'HIGH_POTENTIAL',
  qualified: 'QUALIFIED',
  watch: 'WATCH',
  insufficient: 'INSUFFICIENT_DATA',
  'high-risk': 'HIGH_RISK',
  rejected: 'REJECTED',
};

const inSegment = (segment: Segment, verdict: Eligibility): boolean =>
  segment === 'all' ? true : segment === 'candidates' ? CANDIDATE_VERDICTS.has(verdict) : SEGMENT_ELIGIBILITY[segment] === verdict;

export interface BoardQuery {
  segment: Segment;
  q: string;
  sort: BoardSort;
  limit: number;
}

export function parseBoardQuery(params: URLSearchParams): BoardQuery {
  const segment = (params.get('segment') ?? 'candidates').toLowerCase();
  const sort = (params.get('sort') ?? 'verdict').toLowerCase();
  const limit = Number(params.get('limit') ?? 200);
  return {
    segment: ((SEGMENTS as readonly string[]).includes(segment) ? segment : 'candidates') as Segment,
    q: (params.get('q') ?? '').trim().toLowerCase().slice(0, 64),
    sort: (['verdict', 'score', 'liquidity', 'momentum', 'newest', 'seen'].includes(sort) ? sort : 'verdict') as BoardSort,
    limit: Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.trunc(limit))) : 200,
  };
}

/** Unknown values sort last in every direction, never as zero. */
const SORTERS: Record<BoardSort, (a: BoardRow, b: BoardRow) => number> = {
  // Within a verdict, the decision engine's rank; unranked (rejected) last.
  verdict: (a, b) => (b.rank ?? -1) - (a.rank ?? -1) || b.score - a.score,
  score: (a, b) => (b.rank ?? -1) - (a.rank ?? -1) || b.score - a.score,
  liquidity: (a, b) => (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1),
  momentum: (a, b) => (b.change1h ?? -Infinity) - (a.change1h ?? -Infinity),
  newest: (a, b) => (a.ageHours ?? Infinity) - (b.ageHours ?? Infinity),
  seen: (a, b) => b.lastSeenAt - a.lastSeenAt,
};

export interface HistoryMatch {
  mint: string;
  symbol: string;
  name: string;
  universe: Exclude<Universe, 'LIVE'>;
  verdict: Eligibility | null;
  lastSeenAt: number;
}

export interface BoardResponse {
  generatedAt: number;
  window: { liveMinutes: number; freshMinutes: number };
  query: BoardQuery;
  counts: Record<Eligibility, number> & { all: number; candidates: number };
  universe: Omit<UniverseCounts, 'byEligibility'>;
  /** Rows matching segment and search before the limit was applied. */
  total: number;
  rows: BoardRow[];
  /** Non-live tokens matching the search, so history stays findable. */
  history: HistoryMatch[];
  gaps: { label: string; impact: string; enableWith: string | null }[];
  /** The eligibility ladder's thresholds, so the UI can state each group's rule. */
  rules: { minCoverageQualify: number; minCoverageWatch: number };
}

const matches = (token: TokenSnapshot, q: string): boolean =>
  q.length === 0 || `${token.symbol} ${token.name} ${token.mint}`.toLowerCase().includes(q);

export function boardResponse(
  tokens: readonly TokenSnapshot[],
  query: BoardQuery,
  context: DtoContext,
  gaps: readonly Capability[],
  freshMs: number,
): BoardResponse {
  const universe = countUniverse(tokens, context.now, context.windowMs);
  const live: TokenSnapshot[] = [];
  const history: HistoryMatch[] = [];

  for (const token of tokens) {
    const placement = placementOf(token, context.now, context.windowMs);
    if (placement.universe === 'LIVE') {
      live.push(token);
    } else if (query.q && matches(token, query.q) && history.length < 20) {
      history.push({
        mint: token.mint,
        symbol: token.symbol,
        name: token.name,
        universe: placement.universe,
        verdict: placement.eligibility,
        lastSeenAt: token.at,
      });
    }
  }

  // A search looks for a token, not a verdict: from the default candidate
  // view it spans every live verdict, so a rejected token can still be found.
  const segment: Segment = query.q && query.segment === 'candidates' ? 'all' : query.segment;
  const rows = live
    .filter((token) => inSegment(segment, token.evaluation!.eligibility) && matches(token, query.q))
    .map((token) => boardRow(token, context))
    // A rejected token can never sort above a qualified one, whatever the key.
    .sort((a, b) => VERDICT_TIER[a.verdict] - VERDICT_TIER[b.verdict] || SORTERS[query.sort](a, b));

  history.sort((a, b) => b.lastSeenAt - a.lastSeenAt);

  return {
    generatedAt: context.now,
    window: { liveMinutes: Math.round(context.windowMs / 60_000), freshMinutes: Math.round(freshMs / 60_000) },
    query,
    counts: {
      ...universe.byEligibility,
      all: universe.live,
      candidates: universe.byEligibility.HIGH_POTENTIAL + universe.byEligibility.QUALIFIED + universe.byEligibility.WATCH,
    },
    universe: { live: universe.live, stale: universe.stale, unevaluated: universe.unevaluated, total: universe.total },
    total: rows.length,
    rows: rows.slice(0, query.limit),
    history,
    gaps: gaps
      .filter((capability) => capability.state === 'OFF' && capability.metrics.length > 0)
      .map((capability) => ({ label: capability.label, impact: capability.impact, enableWith: capability.enableWith })),
    rules: { minCoverageQualify: context.minCoverageQualify, minCoverageWatch: context.minCoverageWatch },
  };
}

// ---------------------------------------------------------------------------
// Dossier
// ---------------------------------------------------------------------------

export interface EvidenceRow {
  metric: string;
  label: string;
  group: string;
  state: string;
  value: LedgerValue;
  source: string | null;
  observedAt: number | null;
  freshness: string;
  confidence: number | null;
  weight: number;
  notes: string[];
  claims: LedgerClaim[];
  overridden: LedgerClaim[];
}

/** Stored evidence values are text; recover the structure the ledger would carry. */
function parseStoredValue(raw: string | null): LedgerValue {
  if (raw === null) return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(raw)) return Number(raw);
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      return JSON.parse(raw) as LedgerValue;
    } catch {
      return raw;
    }
  }
  return raw;
}

function evidenceRows(
  token: TokenSnapshot,
  stored: readonly StoredEvidence[],
): { source: 'ledger' | 'stored' | 'none'; asOf: number | null; rows: EvidenceRow[] } {
  const decorate = (entry: Omit<EvidenceRow, 'label' | 'group'>): EvidenceRow => ({
    ...entry,
    label: metricLabel(entry.metric),
    group: METRIC_GROUP[entry.metric] ?? 'Other',
  });

  if (token.ledger && token.ledger.length > 0) {
    return {
      source: 'ledger',
      asOf: token.at,
      rows: token.ledger.map((entry: LedgerEntry) =>
        decorate({
          metric: entry.metric,
          state: entry.state,
          value: entry.value,
          source: entry.source,
          observedAt: entry.observedAt,
          freshness: entry.freshness,
          confidence: entry.confidence,
          weight: entry.weight,
          notes: entry.notes,
          claims: entry.claims,
          overridden: entry.overridden,
        }),
      ),
    };
  }

  if (stored.length > 0) {
    const weights = COVERAGE_WEIGHTS as Record<string, number | undefined>;
    return {
      source: 'stored',
      asOf: stored[0]!.observedAt,
      rows: stored.map((row) =>
        decorate({
          metric: row.metric,
          state: row.state,
          value: parseStoredValue(row.value),
          source: row.source,
          observedAt: row.observedAt,
          freshness: row.freshness ?? 'UNKNOWN',
          confidence: row.confidence,
          weight: weights[row.metric] ?? 0,
          notes: [],
          claims: [],
          overridden: [],
        }),
      ),
    };
  }

  return { source: 'none', asOf: null, rows: [] };
}

type AuthorityState = 'revoked' | 'active' | 'unknown';

function authority(rows: readonly EvidenceRow[], metric: string): { state: AuthorityState; source: string | null } {
  const row = rows.find((entry) => entry.metric === metric);
  if (!row || (row.state !== 'MEASURED' && row.state !== 'CONFLICTED')) return { state: 'unknown', source: null };
  if (row.value === true) return { state: 'revoked', source: row.source };
  if (row.value === false) return { state: 'active', source: row.source };
  return { state: 'unknown', source: null };
}

export interface VerdictFact {
  tone: Tone;
  text: string;
}

export interface Dossier {
  token: {
    mint: string;
    symbol: string;
    name: string;
    icon: string | null;
    verified: boolean;
    launchedAt: number | null;
    ageHours: number | null;
    sources: string[];
    links: { label: string; url: string }[];
  };
  placement: { universe: Universe; freshness: 'FRESH' | 'AGING' | null; lastSeenAt: number; ageMs: number };
  verdict: {
    eligibility: Eligibility | null;
    label: string;
    tone: Tone;
    reason: string;
    /** The reason's own tone: a caveat on a Qualified token is amber, not green. */
    reasonTone: Tone;
    facts: VerdictFact[];
    vetoes: VetoView[];
    watchpoints: Watchpoint[];
    assessedAt: number;
  };
  trust: {
    score: number;
    grade: string;
    base: number;
    penalty: number;
    ceiling: number;
    coverage: number | null;
    confidence: number | null;
    measured: number | null;
    signals: number | null;
    conflicted: number;
    unknowns: UnknownSignal[];
    dominantProvider: string | null;
    providerShare: number | null;
  };
  market: {
    priceUsd: number | null;
    liquidityUsd: number | null;
    volume24h: number | null;
    marketCap: number | null;
    fdv: number | null;
    change: { m5: number | null; h1: number | null; h6: number | null; h24: number | null } | null;
    buyRatio24h: number | null;
    venue: { dex: string; quote: string; createdAt: number | null } | null;
  };
  holders: {
    count: number | null;
    topHoldersPct: number | null;
    topHoldersSource: string | null;
    largestHolderPct: number | null;
    largestAccounts: number | null;
    /** Every large account counted - bonding curves and pool vaults included. */
    rawTop10Pct: number | null;
    /** Wallet-owned accounts only; null unless every owner resolved. */
    walletTop10Pct: number | null;
    roleAware: boolean;
    byRolePct: Record<string, number> | null;
    rolesResolved: number;
    rolesTotal: number;
  };
  decision: DecisionView | null;
  activityIntegrity: ActivityIntegrityView | null;
  rugIntelligence: RugIntelligenceView | null;
  contract: {
    inspected: boolean;
    unavailableReason: string | null;
    program: 'LEGACY_SPL_TOKEN' | 'TOKEN_2022' | 'UNKNOWN' | null;
    programId: string | null;
    decimals: number | null;
    rawSupply: string | null;
    mintAuthority: { state: AuthorityState; source: string | null };
    freezeAuthority: { state: AuthorityState; source: string | null };
    extensionsComplete: boolean | null;
    extensions: {
      id: string;
      label: string;
      policy: string;
      active: boolean | null;
      detail: string | null;
      rationale: string;
      recheckable: boolean;
    }[];
  };
  score: {
    components: { key: string; label: string; value: number | null; weight: number; detail: string; unknownReason: string | null }[];
    findings: { level: string; text: string }[];
  };
  evidence: { source: 'ledger' | 'stored' | 'none'; asOf: number | null; rows: EvidenceRow[] };
}

/** Findings for the Dossier: engine text, minus what is shown elsewhere. */
function findings(token: TokenSnapshot): { level: string; text: string }[] {
  return token.score.flags
    .filter((flag) => flag.code !== 'jup_verified' && flag.code !== 'incomplete_evidence')
    .map((flag) => {
      if (flag.code.startsWith('provider_conflict:')) {
        const metric = flag.code.slice('provider_conflict:'.length);
        return { level: flag.level, text: `Providers disagree on ${metricLabel(metric).toLowerCase()}; the more cautious reading was used.` };
      }
      return { level: flag.level, text: flag.message };
    });
}

function links(token: TokenSnapshot): { label: string; url: string }[] {
  const out: { label: string; url: string }[] = [];
  const push = (label: string, raw: unknown): void => {
    const url = safeHttpUrl(raw);
    if (url && !out.some((link) => link.url === url)) out.push({ label: label.slice(0, 24), url });
  };
  const mint = encodeURIComponent(token.mint);
  push('DexScreener', token.pair?.url);
  push('Jupiter', `https://jup.ag/swap/SOL-${mint}`);
  push('RugCheck', `https://rugcheck.xyz/tokens/${mint}`);
  push('Solscan', `https://solscan.io/token/${mint}`);
  for (const site of token.pair?.websites ?? []) push('Website', site);
  for (const social of token.pair?.socials ?? []) {
    const type = typeof social.type === 'string' ? social.type : 'Link';
    push(type.charAt(0).toUpperCase() + type.slice(1), social.url);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Decision, Activity Integrity and Rug Intelligence views
// ---------------------------------------------------------------------------

export interface DecisionView {
  policyVersion: string;
  models: Record<string, string>;
  decidedAt: number;
  basis: string;
  positives: string[];
  risks: string[];
  blockers: string[];
  coverageLine: string;
  coverage: { market: number; intelligence: number; decision: number };
  confidence: number;
  rank: { score: number; opportunity: number; integrityPenalty: number; uncertaintyPenalty: number } | null;
  hardFails: { code: string; label: string; family: string; familyLabel: string; reason: string; confidence: number | null; freshness: string | null; ruleVersion: string | null; recheckable: boolean; evidence: string[] }[];
  integrity: {
    score: number | null;
    band: string;
    bandLabel: string;
    tone: Tone;
    coverage: number;
    confidence: number;
    driver: string | null;
    domains: { key: string; label: string; band: string; bandLabel: string; tone: Tone; risk: number | null; coverage: number; confidence: number; findings: string[]; clean: string[]; unknown: string[] }[];
  };
  opportunity: { score: number; band: string; coverage: number; effectiveParticipants: number | null; components: { key: string; label: string; weight: number; value: number | null; coverage: number; detail: string }[] };
  momentum: {
    state: string;
    label: string;
    tone: Tone;
    confidence: number;
    observations: number;
    spanMinutes: number;
    windows: { key: string; change: number }[];
    persistence: number | null;
    spikiness: number | null;
    liquidityChange: number | null;
    holderChange: number | null;
    reasons: string[];
    providerFrames: { m5: number | null; h1: number | null; h6: number | null; h24: number | null } | null;
  };
  intelligence: { key: string; status: string; coverage: number; freshness: string; ruleVersion: string | null; note: string }[];
}

export function decisionView(decision: Decision): DecisionView {
  const texts = (kind: string): string[] => decision.reasons.filter((r) => r.kind === kind).map((r) => r.text);
  const m = decision.momentum;
  return {
    policyVersion: decision.policyVersion,
    models: decision.models,
    decidedAt: decision.decidedAt,
    basis: decision.basis,
    positives: texts('positive'),
    risks: texts('risk'),
    blockers: texts('blocker'),
    coverageLine: texts('coverage')[0] ?? '',
    coverage: decision.coverage,
    confidence: decision.confidence,
    rank: decision.rank && decision.rankScore !== null ? { score: decision.rankScore, ...decision.rank } : null,
    hardFails: decision.hardFails.map((v) => ({
      code: v.code,
      label: vetoLabelFor(v),
      family: v.family ?? 'DATA_INTEGRITY',
      familyLabel: FAMILY_LABEL[v.family ?? ''] ?? 'Hard fail',
      reason: v.reason,
      confidence: v.confidence ?? null,
      freshness: v.freshness ?? null,
      ruleVersion: v.ruleVersion ?? null,
      recheckable: v.recheckable,
      evidence: (v.evidence ?? []).slice(0, 6),
    })),
    integrity: {
      score: decision.integrity.score,
      band: decision.integrity.band,
      bandLabel: BAND_LABEL[decision.integrity.band] ?? decision.integrity.band,
      tone: BAND_TONE[decision.integrity.band] ?? 'neutral',
      coverage: decision.integrity.coverage,
      confidence: decision.integrity.confidence,
      driver: decision.integrity.domains.find((d) => d.key === decision.integrity.driver)?.label ?? null,
      domains: decision.integrity.domains.map((d) => ({
        key: d.key,
        label: d.label,
        band: d.band,
        bandLabel: BAND_LABEL[d.band] ?? d.band,
        tone: BAND_TONE[d.band] ?? 'neutral',
        risk: d.risk,
        coverage: d.coverage,
        confidence: d.confidence,
        findings: d.contributions.map((c) => c.text).slice(0, 4),
        clean: d.clean.slice(0, 3),
        unknown: d.unknown.slice(0, 3),
      })),
    },
    opportunity: {
      score: decision.opportunity.score,
      band: decision.opportunity.band,
      coverage: decision.opportunity.coverage,
      effectiveParticipants: decision.opportunity.effectiveParticipants,
      components: decision.opportunity.components.map((c) => ({ key: c.key, label: c.label, weight: c.weight, value: c.value, coverage: c.coverage, detail: c.detail })),
    },
    momentum: {
      state: m.state,
      label: MOMENTUM_LABEL[m.state] ?? m.state,
      tone: MOMENTUM_TONE[m.state] ?? 'neutral',
      confidence: m.confidence,
      observations: m.observations,
      spanMinutes: Math.round(m.spanMs / 60_000),
      windows: m.windows.map((w) => ({ key: w.key, change: Math.round(w.change * 1000) / 1000 })),
      persistence: m.persistence,
      spikiness: m.spikiness,
      liquidityChange: m.liquidityChange,
      holderChange: m.holderChange,
      reasons: m.reasons,
      providerFrames: m.providerFrames,
    },
    intelligence: decision.intelligence.domains,
  };
}

export interface ActivityIntegrityView {
  status: string;
  note: string;
  analyzedAt: number | null;
  freshness: string;
  coverage: number;
  confidence: number;
  ruleVersion: string | null;
  bases: { basis: 'wallets' | 'trades' | 'volume'; total: number; classified: number; shares: Record<string, number> | null; counts: Record<string, number> }[];
  wash: { risk: string; tone: Tone; confidence: number; coverage: number; families: string[]; signals: { text: string; triggered: boolean }[]; counter: string[]; status: string; note: string } | null;
  independence: { clusters: number; confirmed: number; strong: number; largest: number; weakPairs: number; coordinatedShare: number | null; effectiveParticipants: number | null } | null;
  market: MarketCoverage | null;
  truncation: string[];
}

const WASH_TONE: Record<string, Tone> = { LOW: 'good', ELEVATED: 'warn', HIGH: 'bad', INSUFFICIENT_DATA: 'neutral' };

export function activityIntegrityView(bundle: IntelligenceBundle, decision: Decision | null): ActivityIntegrityView {
  const a = bundle.activity;
  const w = bundle.wash;
  const c = bundle.coordination;
  const bases = a.value
    ? (['wallets', 'trades', 'volume'] as const).map((basis) => {
        const view = basis === 'wallets' ? a.value!.byWallets : basis === 'trades' ? a.value!.byTrades : a.value!.byVolume;
        return { basis, total: view.total, classified: view.classified, shares: view.shares, counts: view.counts };
      })
    : [];
  return {
    status: a.status,
    note: a.note,
    analyzedAt: a.observedAt,
    freshness: a.freshness,
    coverage: a.coverage,
    confidence: a.confidence,
    ruleVersion: a.ruleVersion,
    bases,
    wash: w.value
      ? {
          risk: w.value.risk,
          tone: WASH_TONE[w.value.risk] ?? 'neutral',
          confidence: w.confidence,
          coverage: w.coverage,
          families: w.value.families,
          signals: w.value.signals.map((s) => ({ text: s.text, triggered: s.triggered })),
          counter: w.counterEvidence,
          status: w.status,
          note: w.note,
        }
      : w.status !== 'UNAVAILABLE'
        ? { risk: 'INSUFFICIENT_DATA', tone: 'neutral', confidence: 0, coverage: 0, families: [], signals: [], counter: [], status: w.status, note: w.note }
        : null,
    independence: c.value
      ? {
          clusters: c.value.clusters,
          confirmed: c.value.confirmed,
          strong: c.value.strong,
          largest: c.value.largest,
          weakPairs: c.value.weakPairs,
          coordinatedShare: c.value.coordinatedWalletShare,
          effectiveParticipants: decision?.opportunity.effectiveParticipants ?? null,
        }
      : null,
    market: a.value?.market ?? null,
    truncation: [...new Set([...a.truncation, ...c.truncation])].slice(0, 8),
  };
}

export interface RugIntelligenceView {
  analyzedAt: number | null;
  status: string;
  coverage: number;
  tokenStatus: { label: string; tone: Tone; detail: string };
  active: SecurityEventView[];
  superseded: SecurityEventView[];
  mintHistory: string;
  creator: {
    address: string | null;
    attribution: { status: string; confidence: number; basis: string } | null;
    status: string;
    statusLabel: string;
    tone: Tone;
    launches: number;
    otherConfirmed: number;
    otherSuspected: number;
    reasons: string[];
    note: string;
  } | null;
  network: {
    level: string;
    label: string;
    tone: Tone;
    confidence: number;
    findings: { target: string; hops: number; pathConfidence: number; confirmedLaunches: number; path: { type: string; from: string; to: string; evidence: string }[] }[];
    weakAssociations: number;
    reasons: string[];
    note: string;
  } | null;
  caveats: string[];
  revisions: { eventId: string; type: string; status: string; ruleVersion: string | null; revisedAt: number; revisedBy: string; change: string }[];
}

const CREATOR_LABEL: Record<string, [string, Tone]> = {
  MALICIOUS_HISTORY: ['Confirmed malicious history', 'bad'],
  SUSPICIOUS: ['Suspected history', 'warn'],
  CLEAN: ['Nothing found in what was seen', 'good'],
  INSUFFICIENT_HISTORY: ['Too little history', 'neutral'],
  UNKNOWN: ['Unknown', 'neutral'],
};
const NETWORK_LABEL: Record<string, [string, Tone]> = {
  STRONG: ['Strong link to confirmed rugs', 'bad'],
  MODERATE: ['Linked to suspected history', 'warn'],
  WEAK_ASSOCIATION: ['Behavioural coincidence only', 'neutral'],
  NONE: ['No malicious network found', 'good'],
  INSUFFICIENT_DATA: ['Not enough to search', 'neutral'],
};

export function rugIntelligenceView(
  bundle: IntelligenceBundle,
  revisions: RugIntelligenceView['revisions'],
): RugIntelligenceView {
  const s = bundle.security;
  const active = s.value?.active ?? [];
  const confirmed = active.filter((e) => e.status === 'CONFIRMED');
  const suspected = active.filter((e) => e.status !== 'CONFIRMED');
  const tokenStatus = confirmed.length
    ? { label: 'Confirmed malicious event', tone: 'bad' as Tone, detail: confirmed[0]!.reasons.join('; ') }
    : suspected.length
      ? { label: 'Suspected events', tone: 'warn' as Tone, detail: `${suspected.length} unconfirmed finding(s)` }
      : s.status === 'AVAILABLE' || s.status === 'PARTIAL'
        ? { label: 'No machine-verifiable event found', tone: 'neutral' as Tone, detail: `in the ${s.value?.mintHistory.toLowerCase() ?? 'unknown'} mint history read` }
        : { label: 'Not analysed', tone: 'neutral' as Tone, detail: s.note };

  const caveats: string[] = [];
  const creatorStatus = bundle.creator.value?.status ?? 'UNKNOWN';
  if (s.value?.mintHistory !== 'COMPLETE') caveats.push('Only part of this token\'s history was read, so an older action could be missing.');
  if (bundle.creator.status !== 'AVAILABLE' || creatorStatus === 'INSUFFICIENT_HISTORY') caveats.push('The creator\'s history is thin or unknown: "no known rugs" here is not a statement of safety.');
  if (bundle.network.truncation.length > 0) caveats.push('The wallet graph was cut short by its budget, so the network search did not see everything.');
  if (bundle.attribution.value?.status === 'AMBIGUOUS') caveats.push('Several wallets signed the launch; the creator could not be told apart.');

  const cr = bundle.creator.value;
  const [crLabel, crTone] = CREATOR_LABEL[creatorStatus] ?? ['Unknown', 'neutral'];
  const n = bundle.network.value;
  const [nLabel, nTone]: [string, Tone] = n ? NETWORK_LABEL[n.level] ?? [n.level, 'neutral'] : ['', 'neutral'];
  const attribution = bundle.attribution.value;
  return {
    analyzedAt: bundle.analyzedAt,
    status: s.status,
    coverage: Math.round(((s.coverage + bundle.creator.coverage + bundle.network.coverage) / 3) * 1000) / 1000,
    tokenStatus,
    active,
    superseded: s.value?.superseded ?? [],
    mintHistory: s.value?.mintHistory ?? 'UNKNOWN',
    creator:
      cr || attribution
        ? {
            address: cr?.address ?? attribution?.creator ?? null,
            attribution: attribution ? { status: attribution.status, confidence: attribution.confidence, basis: attribution.basis } : null,
            status: creatorStatus,
            statusLabel: crLabel,
            tone: crTone,
            launches: cr?.launches ?? 0,
            otherConfirmed: cr?.otherConfirmedLaunches ?? 0,
            otherSuspected: cr?.otherSuspectedLaunches ?? 0,
            reasons: cr?.reasons ?? [],
            note: bundle.creator.note,
          }
        : null,
    network: n
      ? {
          level: n.level,
          label: nLabel,
          tone: nTone,
          confidence: n.confidence,
          findings: n.findings.map((f) => ({ target: f.target, hops: f.hops, pathConfidence: f.pathConfidence, confirmedLaunches: f.confirmedLaunches, path: f.path.map((p) => ({ type: p.type, from: p.from, to: p.to, evidence: p.evidence })) })),
          weakAssociations: n.weakAssociations,
          reasons: n.reasons,
          note: bundle.network.note,
        }
      : null,
    caveats,
    revisions: revisions.slice(0, 12),
  };
}

export function dossier(
  token: TokenSnapshot,
  stored: readonly StoredEvidence[],
  context: DtoContext,
  bundle: IntelligenceBundle | null = null,
  revisions: RugIntelligenceView['revisions'] = [],
): Dossier {
  const placement = placementOf(token, context.now, context.windowMs);
  const evaluation = token.evaluation ?? null;
  const evidence = evidenceRows(token, stored);
  const counts = signalCounts(token);
  const unknowns = unknownSignals(
    evidence.rows.map((row) => ({ metric: row.metric, state: row.state as LedgerEntry['state'], weight: row.weight })),
    context.globallyOff,
  );

  const reason = evaluation ? verdictReason(token, context) : { text: 'Not assessed', tone: 'neutral' as Tone };
  const facts: VerdictFact[] = [];
  if (evaluation) {
    const vetoCount = evaluation.vetoes.length;
    facts.push(
      vetoCount === 0
        ? { tone: 'good', text: 'No hard vetoes' }
        : { tone: 'bad', text: `${vetoCount} hard veto${vetoCount === 1 ? '' : 'es'}` },
    );
    if (counts) {
      facts.push({
        tone: counts.measured === counts.signals ? 'good' : 'neutral',
        text: `${counts.measured} of ${counts.signals} signals measured`,
      });
    }
    const globalGaps = unknowns.filter((signal) => signal.global);
    if (globalGaps.length > 0) {
      facts.push({ tone: 'warn', text: `${globalGaps.map((gap) => gap.label).join(', ')} not inspected` });
    }
    if (evaluation.conflicts.length > 0) {
      facts.push({ tone: 'warn', text: `Providers disagreed on ${evaluation.conflicts.length} signal${evaluation.conflicts.length === 1 ? '' : 's'}` });
    }
  }

  const onchain = token.onchain;
  const inspected = onchain != null && (onchain.tokenProgram === 'LEGACY_SPL_TOKEN' || onchain.tokenProgram === 'TOKEN_2022');
  const topRow = evidence.rows.find((row) => row.metric === 'topHoldersPct');
  const topMeasured = topRow && (topRow.state === 'MEASURED' || topRow.state === 'CONFLICTED') && typeof topRow.value === 'number';
  const holderValue = (bundle?.holders ?? holderIntel(token)).value;

  return {
    token: {
      mint: token.mint,
      symbol: token.symbol,
      name: token.name,
      icon: iconUrl(token.pair?.imageUrl),
      verified: token.jupiter?.isVerified === true,
      launchedAt: token.launchedAt,
      ageHours: round(currentAgeHours(token, context.now), 2),
      sources: token.sources.map(sourceLabel),
      links: links(token),
    },
    placement: {
      universe: placement.universe,
      freshness: placement.freshness,
      lastSeenAt: token.at,
      ageMs: placement.ageMs,
    },
    verdict: {
      eligibility: evaluation?.eligibility ?? null,
      label: evaluation ? VERDICT_LABEL[evaluation.eligibility] : 'Not assessed',
      tone: evaluation ? VERDICT_TONE[evaluation.eligibility] : 'neutral',
      reason: reason.text,
      reasonTone: reason.tone,
      facts,
      vetoes: (evaluation?.vetoes ?? []).map(vetoView),
      watchpoints: watchpoints(token, evidence.rows, context),
      assessedAt: token.at,
    },
    trust: {
      score: Math.round(token.score.total),
      grade: token.score.grade,
      base: Math.round(token.score.base),
      penalty: Math.round(token.score.penalty),
      ceiling: Math.round(token.score.ceiling ?? 100),
      coverage: evaluation ? round(evaluation.coverage.coverage, 3) : null,
      confidence: evaluation ? round(evaluation.coverage.confidence, 3) : null,
      measured: counts?.measured ?? null,
      signals: counts?.signals ?? null,
      conflicted: evaluation?.coverage.conflicted ?? 0,
      unknowns,
      dominantProvider: evaluation?.coverage.dominantProvider ?? null,
      providerShare: evaluation ? round(evaluation.coverage.providerConcentration, 3) : null,
    },
    market: {
      priceUsd: sig(token.priceUsd),
      liquidityUsd: round(token.liquidityUsd, 0),
      volume24h: round(token.volume24h, 0),
      marketCap: round(token.marketCap, 0),
      fdv: round(token.fdv, 0),
      change: token.priceChange
        ? {
            m5: round(token.priceChange.m5, 1),
            h1: round(token.priceChange.h1, 1),
            h6: round(token.priceChange.h6, 1),
            h24: round(token.priceChange.h24, 1),
          }
        : null,
      buyRatio24h: round(token.buyRatio24h, 3),
      venue: token.pair
        ? { dex: token.pair.dexId, quote: token.pair.quoteSymbol, createdAt: token.pair.pairCreatedAt }
        : null,
    },
    holders: {
      count: token.holders,
      topHoldersPct: topMeasured ? round(topRow!.value as number, 1) : null,
      topHoldersSource: topMeasured ? topRow!.source : null,
      largestHolderPct: onchain?.largestHolderShare == null ? null : round(onchain.largestHolderShare * 100, 2),
      largestAccounts: onchain?.largestAccountsCount ?? null,
      rawTop10Pct: holderValue?.rawTop10Pct ?? null,
      walletTop10Pct: holderValue?.walletTop10Pct ?? null,
      roleAware: holderValue?.roleAware ?? false,
      byRolePct: holderValue?.byRolePct ?? null,
      rolesResolved: holderValue?.resolved ?? 0,
      rolesTotal: holderValue?.total ?? 0,
    },
    decision: token.decision ? decisionView(token.decision) : null,
    activityIntegrity: bundle ? activityIntegrityView(bundle, token.decision ?? null) : null,
    rugIntelligence: bundle ? rugIntelligenceView(bundle, revisions) : null,
    contract: {
      inspected,
      unavailableReason: inspected
        ? null
        : context.helius
          ? 'The on-chain read did not complete for this token.'
          : 'On-chain inspection needs a Helius API key. Nothing read this mint account.',
      program: onchain?.tokenProgram ?? null,
      programId: onchain?.programId ?? null,
      decimals: onchain?.decimals ?? null,
      rawSupply: onchain?.rawSupply ?? null,
      mintAuthority: authority(evidence.rows, 'mintAuthorityRevoked'),
      freezeAuthority: authority(evidence.rows, 'freezeAuthorityRevoked'),
      extensionsComplete: inspected ? onchain!.extensionsComplete : null,
      extensions: (onchain?.extensions ?? []).map((extension) => ({
        id: extension.id,
        label: extension.label,
        policy: extension.policy,
        active: extension.active,
        detail: extension.detail,
        rationale: extension.rationale,
        recheckable: extension.recheckable,
      })),
    },
    score: {
      components: token.score.components.map((component) => ({
        key: component.key,
        label: component.label,
        value: component.value === null ? null : round(component.value, 3),
        weight: component.weight,
        detail: component.detail,
        unknownReason: component.unknownReason ?? null,
      })),
      findings: findings(token),
    },
    evidence,
  };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface ChangeView {
  id: number;
  mint: string;
  symbol: string | null;
  name: string | null;
  at: number;
  kind: 'changed' | 'first';
  from: string | null;
  to: string | null;
  fromLabel: string | null;
  toLabel: string | null;
  tone: Tone;
  reason: string;
  score: number;
  coverage: number | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  /** The policy that made this change, when the decision engine did. */
  policyVersion: string | null;
  /** Its strongest reasons, when recorded. */
  details: string[];
}

export function changeView(change: VerdictChange): ChangeView {
  const to = change.to as Eligibility | null;
  const from = change.from as Eligibility | null;
  return {
    id: change.id,
    mint: change.mint,
    symbol: change.symbol,
    name: change.name,
    at: change.observedAt,
    kind: change.from === null ? 'first' : 'changed',
    from: change.from,
    to: change.to,
    fromLabel: from ? VERDICT_LABEL[from] ?? from : null,
    toLabel: to ? VERDICT_LABEL[to] ?? to : null,
    tone: to ? VERDICT_TONE[to] ?? 'neutral' : 'neutral',
    reason: changeReason(change),
    score: Math.round(change.score),
    coverage: round(change.coverage, 3),
    priceUsd: sig(change.priceUsd),
    liquidityUsd: round(change.liquidityUsd, 0),
    policyVersion: change.policyVersion ?? null,
    details: (change.reasons ?? [])
      .filter((r) => r.kind === 'positive' || r.kind === 'risk' || r.kind === 'hard_fail')
      .slice(0, 3)
      .map((r) => `${r.kind === 'positive' ? '+' : '−'} ${r.text}`),
  };
}

export interface HistoryResponse {
  mint: string;
  changes: ChangeView[];
  verdicts: { t: number; score: number; coverage: number | null; eligibility: string | null; transition: boolean }[];
  market: { t: number; price: number | null; liquidity: number | null; volume: number | null }[];
  holders: { t: number; count: number | null; topPct: number | null }[];
}

export function historyResponse(
  mint: string,
  changes: readonly VerdictChange[],
  verdicts: readonly VerdictPoint[],
  market: readonly MarketPoint[],
  holders: readonly HolderPoint[],
): HistoryResponse {
  return {
    mint,
    changes: changes.map(changeView),
    verdicts: verdicts.map((point) => ({
      t: point.observedAt,
      score: Math.round(point.score * 10) / 10,
      coverage: round(point.coverage, 3),
      eligibility: point.eligibility,
      transition: point.isTransition,
    })),
    market: market.map((point) => ({
      t: point.observedAt,
      price: sig(point.priceUsd),
      liquidity: round(point.liquidityUsd, 0),
      volume: round(point.volume24h, 0),
    })),
    holders: holders.map((point) => ({ t: point.observedAt, count: point.holderCount, topPct: round(point.topHoldersPct, 1) })),
  };
}

// ---------------------------------------------------------------------------
// Changes and events
// ---------------------------------------------------------------------------

const EVENT_LABEL: Record<MonitorEvent['kind'], string> = {
  discovered: 'Discovered',
  score_up: 'Score up',
  score_down: 'Score down',
  liquidity_drop: 'Liquidity drop',
  price_spike: 'Price move',
  risk_flag: 'Risk',
  gone: 'Gone',
};

export interface EventView {
  id: string;
  at: number;
  kind: string;
  kindLabel: string;
  level: string;
  mint: string;
  symbol: string;
  message: string;
}

export function eventView(event: MonitorEvent): EventView {
  return {
    id: event.id,
    at: event.at,
    kind: event.kind,
    kindLabel: EVENT_LABEL[event.kind] ?? event.kind,
    level: event.level,
    mint: event.mint,
    symbol: event.symbol,
    message: event.message.slice(0, 280),
  };
}

// ---------------------------------------------------------------------------
// Observatory (the Orb)
// ---------------------------------------------------------------------------

/**
 * Why a token is surfaced in the Observatory. Every role is a fact about the
 * token's current, canonical state - the Orb never invents a reason to show one.
 */
export type OrbRole = 'changed' | 'top' | 'newest' | 'watch' | 'rejected';

export interface OrbToken {
  mint: string;
  symbol: string;
  name: string;
  icon: string | null;
  verdict: Eligibility;
  verdictLabel: string;
  tone: Tone;
  score: number;
  reason: string;
  role: OrbRole;
  /** The role in words: why this token, of all the live ones, is shown. */
  why: string;
  /** When the role's event happened (a change, a first assessment), for "12m ago". */
  whyAt: number | null;
  change: { from: string; to: string; fromLabel: string; toLabel: string; at: number } | null;
  lastSeenAt: number;
  freshness: 'FRESH' | 'AGING';
}

export interface OrbResponse {
  generatedAt: number;
  universe: { live: number; stale: number; unevaluated: number };
  scan: {
    scanning: boolean;
    lastScanAt: number | null;
    count: number;
    last: { at: number; durationMs: number; analyzed: number; fresh: number } | null;
  };
  /** In display priority: a client showing fewer tokens takes a prefix and still gets a mix. */
  tokens: OrbToken[];
}

/** A verdict change older than this is history, not something the Observatory surfaces. */
export const ORB_CHANGE_WINDOW_MS = 6 * 60 * 60_000;
export const ORB_MAX_TOKENS = 8;

/**
 * Picks the few live tokens the Observatory shows, and says why each is shown.
 *
 * Only LIVE tokens are eligible - the same predicate as the Board - so the Orb
 * can never surface a stale verdict as current. Roles, in priority order:
 *
 * - `changed`: the verdict changed within 6 hours, and the current verdict is
 *   still the one it changed to;
 * - `top`: the highest-scoring qualified tokens;
 * - `newest`: the most recent first assessment;
 * - `watch`: the most recently evaluated Watch token;
 * - `rejected`: the most recently evaluated rejected token - the filter at work.
 *
 * Tokens are interleaved (change, top, newest, top, watch, rejected, change,
 * top) so a phone showing three still sees different kinds of fact.
 */
export function orbResponse(
  tokens: Iterable<TokenSnapshot>,
  changes: VerdictChange[],
  context: DtoContext,
  scan: OrbResponse['scan'],
): OrbResponse {
  const all = [...tokens];
  const universe = countUniverse(all, context.now, context.windowMs);
  const live = new Map<string, TokenSnapshot>();
  for (const token of all) {
    if (placementOf(token, context.now, context.windowMs).universe === 'LIVE') live.set(token.mint, token);
  }

  const byRecency = (a: TokenSnapshot, b: TokenSnapshot) => b.at - a.at || a.mint.localeCompare(b.mint);
  const withVerdict = (verdict: Eligibility) => [...live.values()].filter((t) => t.evaluation!.eligibility === verdict);

  const recentChanges = changes
    .filter((c) => c.from !== null && c.to !== null && c.from !== c.to && context.now - c.observedAt <= ORB_CHANGE_WINDOW_MS)
    .filter((c) => live.get(c.mint)?.evaluation?.eligibility === c.to)
    .sort((a, b) => b.observedAt - a.observedAt);
  const firstAssessments = changes
    .filter((c) => c.from === null && live.has(c.mint))
    .sort((a, b) => b.observedAt - a.observedAt);

  // Candidates by the decision engine's rank: High potential before Qualified.
  const top = [...withVerdict('HIGH_POTENTIAL'), ...withVerdict('QUALIFIED')].sort(
    (a, b) => VERDICT_TIER[a.evaluation!.eligibility] - VERDICT_TIER[b.evaluation!.eligibility] || rankKey(b) - rankKey(a) || byRecency(a, b),
  );
  const watch = withVerdict('WATCH').sort(byRecency);
  const rejected = withVerdict('REJECTED').sort(byRecency);

  const picked: OrbToken[] = [];
  const seen = new Set<string>();
  const take = (token: TokenSnapshot | undefined, role: OrbRole, extra: { change?: VerdictChange; at?: number } = {}): void => {
    if (!token || seen.has(token.mint) || picked.length >= ORB_MAX_TOKENS) return;
    seen.add(token.mint);
    const rank = role === 'top' ? top.indexOf(token) + 1 : 0;
    picked.push(orbToken(token, role, context, extra.change ?? null, extra.at ?? null, rank, top.length));
  };
  const nextOf = <T>(list: T[], pick: (item: T) => TokenSnapshot | undefined): TokenSnapshot | undefined => {
    for (const item of list) {
      const token = pick(item);
      if (token && !seen.has(token.mint)) return token;
    }
    return undefined;
  };
  const nextChange = (): VerdictChange | undefined => recentChanges.find((c) => !seen.has(c.mint));
  const nextFirst = (): VerdictChange | undefined => firstAssessments.find((c) => !seen.has(c.mint));

  const pickChange = () => {
    const change = nextChange();
    if (change) take(live.get(change.mint), 'changed', { change, at: change.observedAt });
  };
  const pickTop = () => take(nextOf(top, (t) => t), 'top');
  const pickNewest = () => {
    const first = nextFirst();
    if (first) take(live.get(first.mint), 'newest', { at: first.observedAt });
  };

  pickChange();
  pickTop();
  pickNewest();
  pickTop();
  take(nextOf(watch, (t) => t), 'watch');
  take(nextOf(rejected, (t) => t), 'rejected');
  pickChange();
  pickTop();
  // Fewer facts than slots (a quiet or small universe): fill with the next best
  // qualified tokens rather than padding with anything invented.
  while (picked.length < ORB_MAX_TOKENS && nextOf(top, (t) => t)) pickTop();

  return {
    generatedAt: context.now,
    universe: { live: universe.live, stale: universe.stale, unevaluated: universe.unevaluated },
    scan,
    tokens: picked,
  };
}

/** 1 → "Highest", 2 → "2nd-highest", 11 → "11th-highest". */
function scoreRank(rank: number): string {
  if (rank <= 1) return 'Highest';
  const teen = rank % 100 >= 11 && rank % 100 <= 13;
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[rank % 10] ?? 'th';
  return `${rank}${suffix}-highest`;
}

function orbToken(
  token: TokenSnapshot,
  role: OrbRole,
  context: DtoContext,
  change: VerdictChange | null,
  at: number | null,
  rank: number,
  qualified: number,
): OrbToken {
  const row = boardRow(token, context);
  const verdict = token.evaluation!.eligibility;
  const label = (e: string) => VERDICT_LABEL[e as Eligibility] ?? e;
  const why: Record<OrbRole, string> = {
    changed: change ? `Verdict changed: ${label(change.from!)} → ${label(change.to!)}` : 'Verdict changed',
    top: `${scoreRank(rank)} rank of ${qualified} candidate${qualified === 1 ? '' : 's'}`,
    newest: 'Newest first assessment',
    watch: 'Most recent Watch verdict',
    rejected: 'Most recent rejection',
  };
  return {
    mint: row.mint,
    symbol: row.symbol,
    name: row.name,
    icon: row.icon,
    verdict,
    verdictLabel: VERDICT_LABEL[verdict] ?? verdict,
    tone: row.tone,
    score: row.score,
    reason: row.reason,
    role,
    why: why[role],
    whyAt: at,
    change: change
      ? { from: change.from!, to: change.to!, fromLabel: label(change.from!), toLabel: label(change.to!), at: change.observedAt }
      : null,
    lastSeenAt: row.lastSeenAt,
    freshness: row.freshness,
  };
}
