/**
 * The intelligence contract: Phase 2's stored readings, normalised into the
 * one shape the Decision Engine reads.
 *
 * Deep intelligence runs on its own loop and writes JSON snapshots, events and
 * profiles. Nothing downstream should parse those ad hoc, because each parser
 * would make its own guess about what a missing field means. This module makes
 * that guess once, and always the same way: **absent is UNAVAILABLE, thin is
 * INSUFFICIENT_DATA or PARTIAL, old is STALE, obsolete-rule is SUPERSEDED - and
 * none of them is safe.**
 *
 * ## Re-evaluation at read time
 *
 * A stored finding is only evidence if the rule that produced it is still the
 * rule. Two checks run here, on every read:
 *
 * 1. Each domain's rule version (stamped on the snapshot since Phase 3) must be
 *    in `ACCEPTED_RULES`. A snapshot written before versioning is UNVERSIONED
 *    and is SUPERSEDED as a whole until the token is re-analysed.
 * 2. Security events are split into active (current rule, not superseded by a
 *    later analysis) and superseded (kept for audit). Creator history and
 *    serial-network findings are then *re-counted* from active events only,
 *    so a creator whose "rug" was an escrow fill misread by an old rule is not
 *    a rugger today, even though the old row is still in the database.
 *
 * Pure: the caller supplies the rows (decision/inputs.ts reads them).
 */

import { ruleStatus, type RuleDomain } from './versions.ts';
import type { EvidenceFreshness, TokenSnapshot } from '../types.ts';
import type {
  ActivityBasisView,
  ActivityCategory,
  ActivityValue,
  AttributionValue,
  CoordinationValue,
  CreatorValue,
  DomainIntel,
  HolderValue,
  IntelligenceBundle,
  IntelStatus,
  MarketCoverage,
  NetworkFindingView,
  NetworkValue,
  SecurityEventView,
  SecurityValue,
  WashValue,
} from './types.ts';

/** A security event as stored, with its rule version and supersession. */
export interface StoredEventInput {
  id: string;
  mint: string;
  type: string;
  status: string;
  actor: string | null;
  creatorLinked: boolean;
  signature: string;
  blockTimeMs: number | null;
  confidence: number;
  reasons: string[];
  ruleVersion: string | null;
  supersededAt: number | null;
}

export interface RawIntelligence {
  snapshot: {
    analyzedAt: number;
    activity: unknown;
    wash: unknown;
    attribution: unknown;
    network: unknown;
    wallets: unknown;
    coverage: number;
    truncation: string[];
    ruleVersions: Record<string, string> | null;
  } | null;
  /** Every stored event for this mint, active or not. */
  events: StoredEventInput[];
  /** The attributed creator's recorded launches and every event on them. */
  creator: { address: string; launches: string[]; events: StoredEventInput[] } | null;
  /** Per network-finding target: its launches and every event on them, for re-counting. */
  networkTargets: Map<string, { launches: string[]; events: StoredEventInput[] }>;
}

// --- freshness ---------------------------------------------------------------

/**
 * How long an intelligence reading speaks for the present.
 *
 * Trading behaviour moves in minutes to hours: a wash reading from yesterday
 * says nothing about today's order flow. Attribution, creator history and
 * events describe what happened, which does not decay the same way, but a
 * *search* for them (did we look at enough history?) still ages.
 */
export const INTEL_FRESHNESS = {
  behaviour: { freshMs: 60 * 60_000, agingMs: 6 * 3_600_000 },
  history: { freshMs: 24 * 3_600_000, agingMs: 7 * 24 * 3_600_000 },
} as const;

function freshness(kind: keyof typeof INTEL_FRESHNESS, at: number | null, now: number): EvidenceFreshness {
  if (at === null) return 'UNKNOWN';
  const age = now - at;
  const window = INTEL_FRESHNESS[kind];
  if (age <= window.freshMs) return 'FRESH';
  if (age <= window.agingMs) return 'AGING';
  return 'STALE';
}

/** Whether a domain's reading may move a decision at all. */
export function usableIntel(domain: DomainIntel<unknown>): boolean {
  return (domain.status === 'AVAILABLE' || domain.status === 'PARTIAL') && domain.freshness !== 'STALE' && domain.value !== null;
}

// --- helpers -------------------------------------------------------------------

const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

function empty<V>(domain: string, status: IntelStatus, note: string, extra: Partial<DomainIntel<V>> = {}): DomainIntel<V> {
  return {
    domain,
    status,
    value: null,
    risk: null,
    confidence: 0,
    coverage: 0,
    freshness: 'UNKNOWN',
    observedAt: null,
    evidence: [],
    counterEvidence: [],
    truncation: [],
    ruleVersion: null,
    note,
    ...extra,
  };
}

const CATEGORIES: ActivityCategory[] = ['coordinated', 'sniper', 'automated', 'likely_organic', 'unknown'];

function basisView(raw: unknown): ActivityBasisView {
  const view = obj(raw);
  const countsRaw = obj(view?.counts);
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, num(countsRaw?.[c]) ?? 0])) as Record<ActivityCategory, number>;
  const sharesRaw = obj(view?.shares);
  const shares = sharesRaw ? (Object.fromEntries(CATEGORIES.map((c) => [c, num(sharesRaw[c]) ?? 0])) as Record<ActivityCategory, number>) : null;
  return { counts, shares, total: num(view?.total) ?? 0, classified: num(view?.coverage) ?? 0 };
}

function marketCoverage(raw: unknown): MarketCoverage | null {
  const m = obj(raw);
  if (!m) return null;
  return {
    pools: arr(m.pools).map((p) => {
      const pool = obj(p) ?? {};
      return {
        address: str(pool.address) ?? '',
        dexId: str(pool.dexId) ?? 'unknown',
        quoteSymbol: str(pool.quoteSymbol) ?? '?',
        observedTrades: num(pool.observedTrades) ?? 0,
        reportedTrades24h: num(pool.reportedTrades24h),
        volumeShare: num(pool.volumeShare),
      };
    }),
    knownPools: num(m.knownPools) ?? 0,
    observedPools: num(m.observedPools) ?? 0,
    venueShare: num(m.venueShare),
    windowMs: num(m.windowMs),
    observedTrades: num(m.observedTrades) ?? 0,
    expectedTrades: num(m.expectedTrades),
    sampleShare: num(m.sampleShare),
    representativeness: clamp01(num(m.representativeness) ?? 0),
    volumeQuote: str(m.volumeQuote),
    excludedFromVolume: num(m.excludedFromVolume) ?? 0,
    note: str(m.note) ?? '',
  };
}

/** A domain's status from its rule version, before anything else is considered. */
function versionGate(ruleVersions: Record<string, string> | null, domain: RuleDomain): { ok: boolean; version: string | null; note: string } {
  const version = ruleVersions?.[domain] ?? null;
  const status = ruleStatus(domain, version);
  if (status === 'CURRENT') return { ok: true, version, note: '' };
  return {
    ok: false,
    version,
    note:
      status === 'UNVERSIONED'
        ? 'analysed before rule versioning; kept for audit and not used until the token is re-analysed under current rules'
        : `analysed under ${version}, which current rules supersede; kept for audit and not used`,
  };
}

// --- events ----------------------------------------------------------------------

const EVENT_STATUSES = new Set(['CONFIRMED', 'STRONGLY_SUSPECTED', 'SUSPICIOUS', 'UNKNOWN']);

export function eventView(e: StoredEventInput): SecurityEventView {
  const rs = ruleStatus('security', e.ruleVersion);
  const status = (EVENT_STATUSES.has(e.status) ? e.status : 'UNKNOWN') as SecurityEventView['status'];
  return {
    id: e.id,
    mint: e.mint,
    type: e.type,
    status,
    actor: e.actor,
    creatorLinked: e.creatorLinked,
    signature: e.signature,
    blockTimeMs: e.blockTimeMs,
    confidence: e.confidence,
    reasons: e.reasons,
    ruleVersion: e.ruleVersion,
    ruleStatus: rs,
    supersededAt: e.supersededAt,
    active: rs === 'CURRENT' && e.supersededAt === null && status !== 'UNKNOWN',
  };
}

const EVENT_RISK: Record<string, number> = { CONFIRMED: 0.95, STRONGLY_SUSPECTED: 0.6, SUSPICIOUS: 0.25, UNKNOWN: 0 };

/** Distinct launches (other than `exclude`) with an active event of each strength. */
function launchCounts(events: StoredEventInput[], exclude: string): { confirmed: number; suspected: number; confirmedMints: string[] } {
  const confirmed = new Set<string>();
  const suspected = new Set<string>();
  for (const e of events.map(eventView)) {
    if (!e.active || e.mint === exclude) continue;
    if (e.status === 'CONFIRMED') confirmed.add(e.mint);
    else if (e.status === 'STRONGLY_SUSPECTED') suspected.add(e.mint);
  }
  for (const m of confirmed) suspected.delete(m);
  return { confirmed: confirmed.size, suspected: suspected.size, confirmedMints: [...confirmed] };
}

// --- the bundle ----------------------------------------------------------------------

export function normalizeIntelligence(raw: RawIntelligence, token: TokenSnapshot, now: number): IntelligenceBundle {
  const snap = raw.snapshot;
  const at = snap?.analyzedAt ?? null;
  const versions = snap?.ruleVersions ?? null;
  const truncation = snap?.truncation ?? [];
  const behaviourFresh = freshness('behaviour', at, now);
  const historyFresh = freshness('history', at, now);
  const staleNote = (f: EvidenceFreshness): string => (f === 'STALE' ? 'last analysed too long ago to speak for the present' : '');
  const pick = (prefixes: string[]): string[] => truncation.filter((t) => prefixes.some((p) => t.startsWith(p)));

  const never = (domain: string): DomainIntel<never> =>
    empty(domain, 'UNAVAILABLE', 'not analysed by deep intelligence yet; nothing is known, which is not the same as nothing wrong');

  // --- activity -----------------------------------------------------------------
  let activity: DomainIntel<ActivityValue> = never('activity');
  const rawActivity = obj(snap?.activity);
  if (snap && rawActivity) {
    const gate = versionGate(versions, 'activity');
    const byWallets = basisView(rawActivity.byWallets);
    const byTrades = basisView(rawActivity.byTrades);
    const byVolume = basisView(rawActivity.byVolume);
    const market = marketCoverage(rawActivity.market);
    const representativeness = market?.representativeness ?? 0;
    const walletConf = arr(snap.wallets)
      .map((w) => obj(w))
      .filter((w): w is Record<string, unknown> => w !== null && str(w.classification) !== 'INSUFFICIENT_DATA' && str(w.classification) !== 'UNKNOWN')
      .map((w) => num(w.confidence) ?? 0);
    const rawStatus = str(rawActivity.status);
    const status: IntelStatus = !gate.ok
      ? 'SUPERSEDED'
      : behaviourFresh === 'STALE'
        ? 'STALE'
        : rawStatus === 'MEASURED'
          ? representativeness >= 0.5 ? 'AVAILABLE' : 'PARTIAL'
          : rawStatus === 'PARTIAL'
            ? 'PARTIAL'
            : 'INSUFFICIENT_DATA';
    activity = {
      domain: 'activity',
      status,
      value: { byWallets, byTrades, byVolume, market },
      risk: null,
      confidence: walletConf.length === 0 ? 0 : round3(walletConf.reduce((a, b) => a + b, 0) / walletConf.length),
      coverage: round3(byTrades.classified * representativeness),
      freshness: behaviourFresh,
      observedAt: at,
      evidence: [
        `${byWallets.total} trading wallet(s) and ${byTrades.total} trade(s) collected`,
        ...(market ? [market.note] : ['market coverage was not recorded for this reading']),
      ],
      counterEvidence: [],
      truncation: pick(['POOL_', 'WALLET_BUDGET']),
      ruleVersion: gate.version,
      note: gate.note || staleNote(behaviourFresh) || str(rawActivity.note) || '',
    };
  }

  // --- wash --------------------------------------------------------------------
  let wash: DomainIntel<WashValue> = never('wash');
  const rawWash = obj(snap?.wash);
  if (snap && rawWash) {
    const gate = versionGate(versions, 'wash');
    const risk = (str(rawWash.risk) ?? 'INSUFFICIENT_DATA') as WashValue['risk'];
    const signals = arr(rawWash.signals).map((s) => {
      const signal = obj(s) ?? {};
      return { code: str(signal.code) ?? '', family: str(signal.family) ?? '', text: str(signal.text) ?? '', triggered: signal.triggered === true, value: num(signal.value) };
    });
    const sample = obj(rawWash.sample);
    const representativeness = activity.value?.market?.representativeness ?? 0;
    const status: IntelStatus = !gate.ok
      ? 'SUPERSEDED'
      : behaviourFresh === 'STALE'
        ? 'STALE'
        : risk === 'INSUFFICIENT_DATA'
          ? 'INSUFFICIENT_DATA'
          : (num(rawWash.coverage) ?? 0) * representativeness >= 0.5 ? 'AVAILABLE' : 'PARTIAL';
    wash = {
      domain: 'wash',
      status,
      value: {
        risk,
        families: arr(rawWash.familiesTriggered).map((f) => String(f)),
        roundTripShare: signals.find((s) => s.code === 'ROUND_TRIP_VOLUME')?.value ?? null,
        top3VolumeShare: signals.find((s) => s.code === 'TOP3_VOLUME')?.value ?? null,
        trades: num(sample?.trades) ?? 0,
        wallets: num(sample?.wallets) ?? 0,
        signals: signals.map(({ value: _value, ...rest }) => rest),
      },
      risk: risk === 'HIGH' ? 0.7 : risk === 'ELEVATED' ? 0.4 : risk === 'LOW' ? 0.1 : null,
      confidence: num(rawWash.confidence) ?? 0,
      coverage: round3((num(rawWash.coverage) ?? 0) * representativeness),
      freshness: behaviourFresh,
      observedAt: at,
      evidence: signals.filter((s) => s.triggered).map((s) => s.text),
      counterEvidence: arr(rawWash.counterSignals).map((c) => String(c)),
      truncation: pick(['POOL_']),
      ruleVersion: gate.version,
      note: gate.note || staleNote(behaviourFresh) || str(rawWash.status) || '',
    };
  }

  // --- coordination -----------------------------------------------------------------
  let coordination: DomainIntel<CoordinationValue> = never('coordination');
  const rawNetwork = obj(snap?.network);
  const wallets = arr(snap?.wallets).map((w) => obj(w)).filter((w): w is Record<string, unknown> => w !== null);
  if (snap && rawNetwork) {
    const gate = versionGate(versions, 'cluster');
    const clusters = arr(rawNetwork.clusters).map((c) => obj(c) ?? {});
    const read = wallets.filter((w) => str(w.status) === 'ANALYZED' || str(w.status) === 'REUSED').length;
    const walletCoverage = wallets.length === 0 ? 0 : read / wallets.length;
    const byWallets = activity.value?.byWallets;
    const coordinatedShare = byWallets && byWallets.total > 0 ? byWallets.counts.coordinated / byWallets.total : null;
    const status: IntelStatus = !gate.ok ? 'SUPERSEDED' : behaviourFresh === 'STALE' ? 'STALE' : wallets.length === 0 ? 'INSUFFICIENT_DATA' : walletCoverage >= 0.7 ? 'AVAILABLE' : 'PARTIAL';
    coordination = {
      domain: 'coordination',
      status,
      value: {
        clusters: clusters.length,
        confirmed: clusters.filter((c) => c.level === 'CONFIRMED_RELATIONSHIP').length,
        strong: clusters.filter((c) => c.level === 'STRONG_CANDIDATE').length,
        largest: Math.max(0, ...clusters.map((c) => num(c.size) ?? 0)),
        weakPairs: num(rawNetwork.weakPairs) ?? 0,
        coordinatedWalletShare: coordinatedShare === null ? null : round3(coordinatedShare),
        clusterSummaries: clusters.slice(0, 10).map((c) => ({
          id: str(c.id) ?? '',
          level: str(c.level) ?? '',
          size: num(c.size) ?? 0,
          confidence: num(c.confidence) ?? 0,
          reasons: arr(c.reasons).map(String).slice(0, 4),
        })),
      },
      risk: null,
      confidence: clusters.length === 0 ? round3(0.5 * walletCoverage) : round3(Math.max(...clusters.map((c) => num(c.confidence) ?? 0))),
      coverage: round3(walletCoverage),
      freshness: behaviourFresh,
      observedAt: at,
      evidence: clusters.slice(0, 3).map((c) => `${str(c.level) === 'CONFIRMED_RELATIONSHIP' ? 'confirmed' : 'strong'} cluster of ${num(c.size) ?? 0} wallets`),
      counterEvidence: clusters.length === 0 && read > 0 ? [`${read} analysed wallet(s) formed no strong cluster`] : [],
      truncation: pick(['GRAPH_', 'WALLET_BUDGET', 'FIRST_FUNDING']),
      ruleVersion: gate.version,
      note: gate.note || staleNote(behaviourFresh),
    };
  }

  // --- attribution --------------------------------------------------------------------
  let attribution: DomainIntel<AttributionValue> = never('attribution');
  const rawAttribution = obj(snap?.attribution);
  if (snap && rawAttribution) {
    const gate = versionGate(versions, 'attribution');
    const status = (str(rawAttribution.status) ?? 'UNKNOWN') as AttributionValue['status'];
    const confidence = num(rawAttribution.confidence) ?? 0;
    attribution = {
      domain: 'attribution',
      status: !gate.ok ? 'SUPERSEDED' : status === 'ATTRIBUTED' ? 'AVAILABLE' : status === 'AMBIGUOUS' ? 'PARTIAL' : 'INSUFFICIENT_DATA',
      value: {
        status,
        creator: str(rawAttribution.creator),
        confidence,
        basis: str(rawAttribution.basis) ?? '',
        deployers: arr(rawAttribution.deployers).map(String),
        initialFunder: str(rawAttribution.initialFunder),
      },
      risk: null,
      confidence,
      coverage: status === 'ATTRIBUTED' ? 1 : status === 'AMBIGUOUS' ? 0.5 : 0,
      freshness: historyFresh,
      observedAt: at,
      evidence: str(rawAttribution.signature) ? [String(rawAttribution.signature)] : [],
      counterEvidence: [],
      truncation: [],
      ruleVersion: gate.version,
      note: gate.note || str(rawAttribution.basis) || '',
    };
  }

  // --- security events (this token) --------------------------------------------------
  const views = raw.events.map(eventView);
  const active = views.filter((e) => e.active);
  const superseded = views.filter((e) => !e.active);
  let security: DomainIntel<SecurityValue>;
  {
    const gate = versionGate(versions, 'security');
    const history = truncation.some((t) => t.startsWith('MINT_HISTORY')) ? 'PARTIAL' : snap ? (str(obj(snap.network)?.mintHistory) as SecurityValue['mintHistory'] | null) ?? 'UNKNOWN' : 'NONE';
    const worst = active.reduce((m, e) => Math.max(m, EVENT_RISK[e.status] ?? 0), 0);
    const coverage = !snap || !gate.ok ? 0 : history === 'COMPLETE' ? 1 : history === 'PARTIAL' ? 0.6 : history === 'UNKNOWN' ? 0.5 : 0.2;
    security = {
      domain: 'security',
      // Current-rule events stand on their own proof, so a superseded
      // snapshot does not hide them - but it cannot vouch for their absence.
      status: !snap ? (active.length > 0 ? 'PARTIAL' : 'UNAVAILABLE') : !gate.ok ? (active.length > 0 ? 'PARTIAL' : 'SUPERSEDED') : coverage >= 0.6 ? 'AVAILABLE' : 'PARTIAL',
      value: { active, superseded, mintHistory: history },
      risk: active.length > 0 ? worst : snap && gate.ok ? 0 : null,
      confidence: active.length > 0 ? Math.max(...active.map((e) => e.confidence)) : round3(coverage * 0.8),
      coverage,
      freshness: historyFresh,
      observedAt: at,
      evidence: active.map((e) => `${e.status.toLowerCase().replace('_', ' ')} ${e.type.toLowerCase().replace('_', ' ')}: ${e.reasons[0] ?? ''}`.trim()),
      counterEvidence: snap && gate.ok && active.length === 0 ? [`no machine-verifiable security event in the mint history read (${history.toLowerCase()})`] : [],
      truncation: pick(['MINT_', 'LIQUIDITY_INFERRED']),
      ruleVersion: gate.version,
      note: gate.note || (superseded.length > 0 ? `${superseded.length} finding(s) from obsolete rules kept for audit only` : ''),
    };
  }

  // --- creator history (re-counted from active events) ---------------------------------
  let creator: DomainIntel<CreatorValue> = never('creator');
  if (raw.creator && snap) {
    const gate = versionGate(versions, 'creator');
    const counts = launchCounts(raw.creator.events, token.mint);
    const creatorActive = raw.creator.events.map(eventView).filter((e) => e.active);
    const suspiciousOnly = creatorActive.filter((e) => e.status === 'SUSPICIOUS' && e.mint !== token.mint).length;
    const launches = raw.creator.launches.length;
    const status: CreatorValue['status'] =
      counts.confirmed > 0 ? 'MALICIOUS_HISTORY' : counts.suspected + suspiciousOnly > 0 ? 'SUSPICIOUS' : launches >= 2 ? 'CLEAN' : 'INSUFFICIENT_HISTORY';
    const attributionConfidence = attribution.value?.confidence ?? 0;
    creator = {
      domain: 'creator',
      status: !gate.ok ? 'SUPERSEDED' : historyFresh === 'STALE' ? 'STALE' : status === 'INSUFFICIENT_HISTORY' ? 'INSUFFICIENT_DATA' : 'AVAILABLE',
      value: {
        address: raw.creator.address,
        status,
        launches,
        otherConfirmedLaunches: counts.confirmed,
        otherSuspectedLaunches: counts.suspected,
        confirmedMints: counts.confirmedMints,
        events: creatorActive.slice(0, 12).map((e) => ({ mint: e.mint, type: e.type, status: e.status })),
        reasons: [
          status === 'MALICIOUS_HISTORY'
            ? `${counts.confirmed} other launch(es) with a confirmed malicious event under current rules`
            : status === 'SUSPICIOUS'
              ? `suspected events on other launches, none confirmed`
              : status === 'CLEAN'
                ? `${launches} launches observed, no current-rule event on any: nothing found in what was seen, not a vouch`
                : `${launches} launch observed; too little history to say anything`,
        ],
      },
      risk: null,
      confidence: round3(attributionConfidence),
      coverage: round3((launches >= 2 ? 1 : launches === 1 ? 0.5 : 0) * (attribution.coverage || 0)),
      freshness: historyFresh,
      observedAt: at,
      evidence: creatorActive.filter((e) => e.mint !== token.mint).slice(0, 5).map((e) => `${e.status} ${e.type} on ${e.mint.slice(0, 6)}… (${e.signature.slice(0, 8)}…)`),
      counterEvidence: status === 'CLEAN' ? [`${launches} launches observed without a current-rule event`] : [],
      truncation: [],
      ruleVersion: gate.version,
      note: gate.note || (attribution.status === 'PARTIAL' ? 'attribution is ambiguous; the history is of a candidate, not a proven creator' : ''),
    };
  } else if (snap && attribution.value && attribution.value.status !== 'ATTRIBUTED') {
    creator = empty('creator', 'INSUFFICIENT_DATA', 'no creator could be attributed, so there is no history to read', { observedAt: at, freshness: historyFresh });
  }

  // --- serial network (findings re-validated) -------------------------------------------
  let network: DomainIntel<NetworkValue> = never('network');
  const analysis = obj(rawNetwork?.analysis);
  if (snap && analysis) {
    const gate = versionGate(versions, 'network');
    const analysedLevel = str(analysis.level) ?? 'INSUFFICIENT_DATA';
    const findings: NetworkFindingView[] = [];
    for (const f of arr(analysis.findings)) {
      const finding = obj(f);
      const target = str(finding?.target);
      if (!finding || !target) continue;
      const data = raw.networkTargets.get(target);
      const counts = data ? launchCounts(data.events, token.mint) : { confirmed: 0, suspected: 0, confirmedMints: [] };
      if (counts.confirmed === 0 && counts.suspected === 0) continue; // nothing current behind it
      const path = arr(finding.path).map((p) => {
        const edge = obj(p) ?? {};
        return { from: str(edge.from) ?? '', to: str(edge.to) ?? '', type: str(edge.type) ?? '', confidence: num(edge.confidence) ?? 0, evidence: str(edge.evidence) ?? '' };
      });
      findings.push({ target, hops: path.length, pathConfidence: num(finding.pathConfidence) ?? 0, path, confirmedLaunches: counts.confirmed, suspectedLaunches: counts.suspected, confirmedMints: counts.confirmedMints });
    }
    findings.sort((a, b) => b.confirmedLaunches - a.confirmedLaunches || b.pathConfidence - a.pathConfidence);
    const best = findings[0];
    const weak = arr(analysis.weakAssociations).length;
    const level: NetworkValue['level'] =
      analysedLevel === 'INSUFFICIENT_DATA'
        ? 'INSUFFICIENT_DATA'
        : best && best.confirmedLaunches > 0 && best.pathConfidence >= 0.5
          ? 'STRONG'
          : best
            ? 'MODERATE'
            : weak > 0 || analysedLevel === 'WEAK_ASSOCIATION'
              ? 'WEAK_ASSOCIATION'
              : 'NONE';
    const dropped = arr(analysis.findings).length - findings.length;
    network = {
      domain: 'network',
      status: !gate.ok ? 'SUPERSEDED' : historyFresh === 'STALE' ? 'STALE' : level === 'INSUFFICIENT_DATA' ? 'INSUFFICIENT_DATA' : 'AVAILABLE',
      value: {
        level,
        analysedLevel,
        confidence: best ? round3(best.pathConfidence * (best.confirmedLaunches > 0 ? 0.95 : 0.7)) : 0,
        findings: findings.slice(0, 5),
        weakAssociations: weak,
        reasons: [
          ...arr(analysis.reasons).map(String),
          ...(dropped > 0 ? [`${dropped} finding(s) no longer backed by a current-rule event and not counted`] : []),
        ],
      },
      risk: null,
      confidence: best ? round3(best.pathConfidence) : level === 'NONE' ? 0.5 : 0,
      coverage: level === 'INSUFFICIENT_DATA' ? 0 : truncation.some((t) => t.startsWith('GRAPH_')) ? 0.6 : 1,
      freshness: historyFresh,
      observedAt: at,
      evidence: findings.slice(0, 3).map((f) => `${f.hops}-hop ${f.path.map((p) => p.type.toLowerCase()).join(' → ') || 'self'} link to an address with ${f.confirmedLaunches} confirmed malicious launch(es)`),
      counterEvidence: level === 'NONE' ? ['no address with a current-rule malicious history within the searched hops'] : [],
      truncation: pick(['GRAPH_']),
      ruleVersion: gate.version,
      note: gate.note || staleNote(historyFresh),
    };
  }

  // --- holders (from the scan, not from deep intelligence) ---------------------------------
  const holders = holderIntel(token);

  const deep = [activity, wash, coordination, attribution, creator, network, security];
  const coverage = round3(deep.reduce((sum, d) => sum + (usableIntel(d) || (d === security && d.status === 'PARTIAL') ? d.coverage : 0), 0) / deep.length);

  return { mint: token.mint, analyzedAt: at, activity, wash, coordination, attribution, creator, network, security, holders, coverage, ruleVersions: versions, truncation };
}

/**
 * Holder concentration, raw and role-aware, side by side.
 *
 * The role-aware figure is used only when every large account's owner was
 * resolved: an unreadable owner might be a wallet, and silently leaving it out
 * would understate concentration. When roles are incomplete, coverage falls
 * rather than the figure being guessed.
 */
export function holderIntel(token: TokenSnapshot): DomainIntel<HolderValue> {
  const roles = token.onchain?.holderRoles ?? null;
  const rawShare = roles?.rawTop10Share ?? token.onchain?.top10Share ?? null;
  const walletShare = roles?.walletTop10Share ?? null;
  const ledgerTop = token.ledger?.find((e) => e.metric === 'topHoldersPct');
  const providerTop =
    ledgerTop && (ledgerTop.state === 'MEASURED' || ledgerTop.state === 'CONFLICTED') && typeof ledgerTop.value === 'number' && ledgerTop.freshness !== 'STALE'
      ? ledgerTop.value
      : token.jupiter?.audit.topHoldersPercentage ?? null;
  const roleAware = roles !== null && roles.total > 0 && roles.resolved === roles.total && walletShare !== null;
  const byRolePct = roles ? Object.fromEntries(Object.entries(roles.byRole).map(([k, v]) => [k, Math.round(v * 1000) / 10])) : null;

  if (rawShare === null && providerTop === null) {
    return empty('holders', 'UNAVAILABLE', 'no provider measured holder concentration');
  }
  const coverage = roleAware ? 1 : providerTop !== null ? 0.7 : 0.35;
  const unresolved = roles ? roles.total - roles.resolved : 0;
  return {
    domain: 'holders',
    status: roleAware ? 'AVAILABLE' : 'PARTIAL',
    value: {
      rawTop10Pct: rawShare === null ? null : Math.round(rawShare * 1000) / 10,
      walletTop10Pct: walletShare === null ? null : Math.round(walletShare * 1000) / 10,
      providerTopPct: providerTop === null ? null : Math.round(providerTop * 10) / 10,
      byRolePct,
      resolved: roles?.resolved ?? 0,
      total: roles?.total ?? 0,
      roleAware,
    },
    risk: null,
    confidence: roleAware ? 0.9 : providerTop !== null ? 0.7 : 0.4,
    coverage,
    freshness: 'FRESH',
    observedAt: token.at,
    evidence: [
      ...(rawShare !== null ? [`raw top-10 ${Math.round(rawShare * 100)}% (every account, pools and curves included)`] : []),
      ...(walletShare !== null ? [`wallet-only top-10 ${Math.round(walletShare * 100)}%`] : []),
      ...(providerTop !== null ? [`provider-reported top holders ${Math.round(providerTop)}%`] : []),
    ],
    counterEvidence: [],
    truncation: unresolved > 0 ? [`HOLDER_ROLES: ${unresolved} of ${roles?.total} large account owner(s) unreadable`] : [],
    ruleVersion: 'holder-roles@1',
    note: roleAware
      ? 'every large account labelled by owner; the wallet-only figure is used'
      : roles
        ? 'some large-account owners were unreadable, so the wallet-only figure is withheld and coverage is lower'
        : 'on-chain holder roles were not read; only the provider figure is available',
  };
}
