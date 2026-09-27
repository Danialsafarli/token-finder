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

import { countUniverse, currentAgeHours, placementOf, VERDICT_TIER, type Universe, type UniverseCounts } from '../core/ranking.ts';
import { safeHttpUrl } from './security.ts';
import { COVERAGE_WEIGHTS } from '../core/lifecycle.ts';
import {
  changeReason,
  METRIC_GROUP,
  metricLabel,
  signalCounts,
  sourceLabel,
  unknownSignals,
  VERDICT_LABEL,
  VERDICT_TONE,
  verdictReason,
  vetoView,
  type Tone,
  type UnknownSignal,
  type VetoView,
} from './present.ts';
import type { Capability } from '../core/capabilities.ts';
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

  if (eligibility === 'QUALIFIED' && coverage < context.minCoverageQualify + 0.1) {
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
  confidence: number;
  measured: number | null;
  signals: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
  change1h: number | null;
  change24h: number | null;
  ageHours: number | null;
  lastSeenAt: number;
  freshness: 'FRESH' | 'AGING';
  program: 'LEGACY_SPL_TOKEN' | 'TOKEN_2022' | null;
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
  const reason = verdictReason(token, context);
  const counts = signalCounts(token);
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
    confidence: round(evaluation.coverage.confidence, 3) ?? 0,
    measured: counts?.measured ?? null,
    signals: counts?.signals ?? null,
    liquidityUsd: round(token.liquidityUsd, 0),
    volume24h: round(token.volume24h, 0),
    change1h: round(token.priceChange?.h1 ?? null, 1),
    change24h: round(token.priceChange?.h24 ?? null, 1),
    ageHours: round(currentAgeHours(token, context.now), 2),
    lastSeenAt: token.at,
    freshness: placement.freshness ?? 'AGING',
    program: program === 'LEGACY_SPL_TOKEN' || program === 'TOKEN_2022' ? program : null,
  };
}

export type Segment = 'qualified' | 'watch' | 'insufficient' | 'rejected' | 'all';
export type BoardSort = 'verdict' | 'score' | 'liquidity' | 'momentum' | 'newest' | 'seen';

const SEGMENT_ELIGIBILITY: Record<Exclude<Segment, 'all'>, Eligibility> = {
  qualified: 'QUALIFIED',
  watch: 'WATCH',
  insufficient: 'INSUFFICIENT_DATA',
  rejected: 'REJECTED',
};

export interface BoardQuery {
  segment: Segment;
  q: string;
  sort: BoardSort;
  limit: number;
}

export function parseBoardQuery(params: URLSearchParams): BoardQuery {
  const segment = (params.get('segment') ?? 'all').toLowerCase();
  const sort = (params.get('sort') ?? 'verdict').toLowerCase();
  const limit = Number(params.get('limit') ?? 200);
  return {
    segment: (['qualified', 'watch', 'insufficient', 'rejected', 'all'].includes(segment) ? segment : 'all') as Segment,
    q: (params.get('q') ?? '').trim().toLowerCase().slice(0, 64),
    sort: (['verdict', 'score', 'liquidity', 'momentum', 'newest', 'seen'].includes(sort) ? sort : 'verdict') as BoardSort,
    limit: Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.trunc(limit))) : 200,
  };
}

/** Unknown values sort last in every direction, never as zero. */
const SORTERS: Record<BoardSort, (a: BoardRow, b: BoardRow) => number> = {
  verdict: (a, b) => b.score - a.score,
  score: (a, b) => b.score - a.score,
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
  counts: Record<Eligibility, number> & { all: number };
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

  const wanted = query.segment === 'all' ? null : SEGMENT_ELIGIBILITY[query.segment];
  const rows = live
    .filter((token) => (wanted === null || token.evaluation!.eligibility === wanted) && matches(token, query.q))
    .map((token) => boardRow(token, context))
    // A rejected token can never sort above a qualified one, whatever the key.
    .sort((a, b) => VERDICT_TIER[a.verdict] - VERDICT_TIER[b.verdict] || SORTERS[query.sort](a, b));

  history.sort((a, b) => b.lastSeenAt - a.lastSeenAt);

  return {
    generatedAt: context.now,
    window: { liveMinutes: Math.round(context.windowMs / 60_000), freshMinutes: Math.round(freshMs / 60_000) },
    query,
    counts: { ...universe.byEligibility, all: universe.live },
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
  };
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

export function dossier(token: TokenSnapshot, stored: readonly StoredEvidence[], context: DtoContext): Dossier {
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
    },
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

  const top = withVerdict('QUALIFIED').sort((a, b) => b.score.total - a.score.total || byRecency(a, b));
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
    top: `${scoreRank(rank)} score of ${qualified} qualified`,
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
