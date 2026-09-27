/**
 * Creator history and serial-network intelligence.
 *
 * ## Creator profile
 *
 * Built from what Token Finder has recorded: every launch attributed to the
 * address (or paid for by it), and every security event on those launches.
 *
 * | Status | When |
 * |---|---|
 * | MALICIOUS_HISTORY | at least one CONFIRMED security event on a launch of theirs |
 * | SUSPICIOUS | STRONGLY_SUSPECTED or SUSPICIOUS events, none confirmed |
 * | CLEAN | two or more launches observed and no events |
 * | INSUFFICIENT_HISTORY | one launch or none observed |
 *
 * A token that failed, crashed or was abandoned is not an event and does not
 * move this status. CLEAN means "nothing found in what we saw", not vouched.
 *
 * ## Serial networks
 *
 * From a token's creator candidates, the graph is searched up to two hops for
 * addresses with a malicious history. Only strong edges carry a path: direct
 * or likely funding, token transfers, shared direct funders and strong or
 * confirmed cluster membership. Behavioural coincidences (entering the same
 * launch, the same buy size) never do - that would be guilt by association -
 * and are reported only as WEAK_ASSOCIATION, which is explicitly not a
 * malicious finding. A brand-new creator wallet does not reset anything: if it
 * was funded directly by an address with a confirmed history, the path shows it.
 */

import type { SecurityStatus } from './security.ts';

export type CreatorStatus = 'MALICIOUS_HISTORY' | 'SUSPICIOUS' | 'CLEAN' | 'INSUFFICIENT_HISTORY';

export interface CreatorEvent {
  mint: string;
  type: string;
  status: SecurityStatus;
  signature: string;
}

export interface CreatorProfile {
  address: string;
  launches: number;
  firstLaunchAt: number | null;
  lastLaunchAt: number | null;
  confirmed: number;
  stronglySuspected: number;
  suspicious: number;
  status: CreatorStatus;
  events: CreatorEvent[];
  reasons: string[];
}

export function buildCreatorProfile(
  address: string,
  launches: { mint: string; blockTimeMs: number | null }[],
  events: CreatorEvent[],
): CreatorProfile {
  const times = launches.map((l) => l.blockTimeMs).filter((t): t is number => t !== null);
  const confirmed = events.filter((e) => e.status === 'CONFIRMED').length;
  const strongly = events.filter((e) => e.status === 'STRONGLY_SUSPECTED').length;
  const suspicious = events.filter((e) => e.status === 'SUSPICIOUS').length;
  let status: CreatorStatus;
  const reasons: string[] = [];
  if (confirmed > 0) {
    status = 'MALICIOUS_HISTORY';
    reasons.push(`${confirmed} confirmed security event${confirmed === 1 ? '' : 's'} across ${new Set(events.filter((e) => e.status === 'CONFIRMED').map((e) => e.mint)).size} launch(es)`);
  } else if (strongly + suspicious > 0) {
    status = 'SUSPICIOUS';
    reasons.push(`${strongly} strongly suspected and ${suspicious} suspicious event(s); none confirmed`);
  } else if (launches.length >= 2) {
    status = 'CLEAN';
    reasons.push(`${launches.length} launches observed, no security events recorded`);
  } else {
    status = 'INSUFFICIENT_HISTORY';
    reasons.push(`${launches.length} launch observed; too little history to say anything`);
  }
  return {
    address,
    launches: launches.length,
    firstLaunchAt: times.length ? Math.min(...times) : null,
    lastLaunchAt: times.length ? Math.max(...times) : null,
    confirmed,
    stronglySuspected: strongly,
    suspicious,
    status,
    events: events.slice(0, 50),
    reasons,
  };
}

// ---------------------------------------------------------------------------

export type PathEdgeType = 'FUNDED' | 'TOKEN_TRANSFER' | 'SHARED_FUNDER' | 'CLUSTER' | 'BEHAVIOURAL';

export interface PathEdge {
  from: string;
  to: string;
  type: PathEdgeType;
  confidence: number;
  evidence: string;
}

export interface NetworkFinding {
  target: string;
  path: PathEdge[];
  pathConfidence: number;
  confirmed: number;
  stronglySuspected: number;
  events: CreatorEvent[];
}

export type NetworkLevel = 'STRONG' | 'MODERATE' | 'WEAK_ASSOCIATION' | 'NONE' | 'INSUFFICIENT_DATA';

export interface NetworkAnalysis {
  level: NetworkLevel;
  confidence: number;
  findings: NetworkFinding[];
  weakAssociations: NetworkFinding[];
  reasons: string[];
}

const STRONG_TYPES: ReadonlySet<PathEdgeType> = new Set(['FUNDED', 'TOKEN_TRANSFER', 'SHARED_FUNDER', 'CLUSTER']);

export function analyzeNetwork(
  subjects: string[],
  edges: PathEdge[],
  profiles: ReadonlyMap<string, CreatorProfile>,
  maxDepth = 2,
): NetworkAnalysis {
  if (subjects.length === 0) {
    return { level: 'INSUFFICIENT_DATA', confidence: 0, findings: [], weakAssociations: [], reasons: ['no creator could be attributed, so there is no one to trace'] };
  }
  const adjacency = new Map<string, PathEdge[]>();
  for (const e of edges) {
    for (const [x, y] of [[e.from, e.to], [e.to, e.from]] as const) {
      const list = adjacency.get(x) ?? [];
      list.push({ ...e, from: x, to: y });
      adjacency.set(x, list);
    }
  }

  const search = (allowed: (t: PathEdgeType) => boolean): NetworkFinding[] => {
    const found = new Map<string, NetworkFinding>();
    const queue: { at: string; path: PathEdge[]; conf: number }[] = subjects.map((s) => ({ at: s, path: [], conf: 1 }));
    const seen = new Map<string, number>(subjects.map((s) => [s, 1]));
    while (queue.length > 0) {
      const { at, path, conf } = queue.shift() as { at: string; path: PathEdge[]; conf: number };
      const profile = profiles.get(at);
      if (profile && (profile.confirmed > 0 || profile.stronglySuspected > 0)) {
        const existing = found.get(at);
        if (!existing || existing.pathConfidence < conf) {
          found.set(at, {
            target: at,
            path,
            pathConfidence: Math.round(conf * 100) / 100,
            confirmed: profile.confirmed,
            stronglySuspected: profile.stronglySuspected,
            events: profile.events.filter((e) => e.status === 'CONFIRMED' || e.status === 'STRONGLY_SUSPECTED').slice(0, 5),
          });
        }
      }
      if (path.length >= maxDepth) continue;
      for (const e of adjacency.get(at) ?? []) {
        if (!allowed(e.type)) continue;
        const next = conf * e.confidence;
        if ((seen.get(e.to) ?? 0) >= next) continue;
        seen.set(e.to, next);
        queue.push({ at: e.to, path: [...path, e], conf: next });
      }
    }
    return [...found.values()].sort((a, b) => b.pathConfidence - a.pathConfidence);
  };

  const strong = search((t) => STRONG_TYPES.has(t));
  const strongTargets = new Set(strong.map((f) => f.target));
  const weak = search(() => true).filter((f) => !strongTargets.has(f.target));

  const best = strong[0];
  let level: NetworkLevel = 'NONE';
  const reasons: string[] = [];
  if (best && best.confirmed > 0 && best.pathConfidence >= 0.5) {
    level = 'STRONG';
    reasons.push(best.path.length === 0 ? 'the creator itself has a confirmed malicious history' : `${best.path.length}-hop link to an address with ${best.confirmed} confirmed malicious event(s)`);
  } else if (best) {
    level = 'MODERATE';
    if (best.path.length === 0) reasons.push(best.confirmed > 0 ? 'the creator itself has a confirmed malicious history' : 'the creator itself has a strongly suspected history; nothing confirmed');
    else reasons.push(best.confirmed > 0 ? `a confirmed malicious history ${best.path.length} hop(s) away, through links too weak to call it strong` : `a strongly suspected history ${best.path.length} hop(s) away through strong links; nothing confirmed`);
  } else if (weak.length > 0) {
    level = 'WEAK_ASSOCIATION';
    reasons.push('reachable only through behavioural coincidence (shared launches or buy sizes); this is not a malicious finding');
  } else {
    reasons.push(`no address with a malicious history within ${maxDepth} strong hops`);
  }
  return {
    level,
    confidence: best ? Math.round(best.pathConfidence * (best.confirmed > 0 ? 0.95 : 0.7) * 100) / 100 : 0,
    findings: strong,
    weakAssociations: weak,
    reasons,
  };
}
