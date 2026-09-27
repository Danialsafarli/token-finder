/**
 * Conservative wallet clusters.
 *
 * Wallets are grouped only when several kinds of evidence agree. Each pair of
 * wallets is graded from the edges between them:
 *
 * | Level | Requires |
 * |---|---|
 * | CONFIRMED_RELATIONSHIP | a hard link (one funded the other DIRECTly, or a token moved between them) **and** a behavioural or second hard link |
 * | STRONG_CANDIDATE | a hard link alone, or a shared DIRECT funder plus behaviour, or two different behavioural links |
 * | WEAK_CANDIDATE | a single link of a single kind |
 * | UNKNOWN | nothing |
 *
 * Hard links are transfers of value between the two; behavioural links are
 * coordinated entries, repeated order sizes and shared early launches. A
 * shared funder is between the two: it proves nothing about the pair unless
 * something else agrees.
 *
 * **Weak candidates are never merged.** Clusters are connected components over
 * STRONG_CANDIDATE and CONFIRMED_RELATIONSHIP pairs only; weak pairs are
 * reported beside them as candidates, so one coincidence cannot chain two
 * unrelated groups into one "actor".
 */

import { canonicalId } from '../ingest/events.ts';
import type { EdgeType, WalletEdge } from './graph.ts';

export type RelationshipLevel = 'CONFIRMED_RELATIONSHIP' | 'STRONG_CANDIDATE' | 'WEAK_CANDIDATE' | 'UNKNOWN';

export interface PairAssessment {
  a: string;
  b: string;
  level: RelationshipLevel;
  confidence: number;
  reasons: string[];
  /** The kinds of edge between the pair. */
  kinds: EdgeType[];
  edgeIds: string[];
}

export interface WalletCluster {
  id: string;
  level: Exclude<RelationshipLevel, 'WEAK_CANDIDATE' | 'UNKNOWN'>;
  members: string[];
  confidence: number;
  /** Edge kinds behind the cluster, with how many pairs showed each. */
  signals: Partial<Record<EdgeType, number>>;
  reasons: string[];
}

const HARD: ReadonlySet<EdgeType> = new Set(['FUNDED', 'TOKEN_TRANSFER']);
const BEHAVIOURAL: ReadonlySet<EdgeType> = new Set(['COORDINATED_ENTRY', 'REPEATED_ORDER_SIZE', 'SAME_LAUNCH_PARTICIPATION']);

const describe = (e: WalletEdge): string => {
  switch (e.type) {
    case 'FUNDED':
      return `one funded the other (${e.detail.classification ?? 'funding'})`;
    case 'TOKEN_TRANSFER':
      return `tokens moved between them ${e.count}x`;
    case 'SHARED_FUNDER':
      return `same direct funder ${String(e.detail.funder ?? '').slice(0, 6)}…`;
    case 'COORDINATED_ENTRY':
      return `entered the same token within ${e.detail.slotGap ?? 2} slots${e.count > 1 ? ` (${e.count} tokens)` : ''}`;
    case 'REPEATED_ORDER_SIZE':
      return `used the same uncommon buy size ${e.detail.sharedSizes ?? e.count}x`;
    case 'SAME_LAUNCH_PARTICIPATION':
      return `entered ${e.detail.launches ?? 2} of the same launches within 60 s`;
    case 'CREATOR_ASSOCIATION':
      return 'linked to a launch creator';
  }
};

export function assessPairs(edges: WalletEdge[]): PairAssessment[] {
  const byPair = new Map<string, WalletEdge[]>();
  for (const e of edges) {
    if (e.type === 'CREATOR_ASSOCIATION') continue; // a role annotation, not independent evidence
    const [x, y] = e.a < e.b ? [e.a, e.b] : [e.b, e.a];
    const key = `${x}|${y}`;
    const list = byPair.get(key) ?? [];
    list.push(e);
    byPair.set(key, list);
  }

  const out: PairAssessment[] = [];
  for (const [key, list] of byPair) {
    const [a, b] = key.split('|') as [string, string];
    const kinds = new Set(list.map((e) => e.type));
    const hard = [...kinds].filter((k) => HARD.has(k)).length;
    const directFunding = list.some((e) => e.type === 'FUNDED' && e.detail.classification === 'DIRECT');
    const hardStrong = hard > 0 && (directFunding || kinds.has('TOKEN_TRANSFER'));
    const behavioural = [...kinds].filter((k) => BEHAVIOURAL.has(k)).length;
    // Repetition makes one behavioural kind count double: two coordinated
    // entries across different tokens are harder to explain than one.
    const repeatedBehaviour = list.some((e) => BEHAVIOURAL.has(e.type) && e.count >= 2);
    const sharedFunder = kinds.has('SHARED_FUNDER');

    let level: RelationshipLevel;
    if (hardStrong && (behavioural >= 1 || hard >= 2)) level = 'CONFIRMED_RELATIONSHIP';
    else if (hardStrong || (sharedFunder && behavioural >= 1) || behavioural >= 2 || (behavioural === 1 && repeatedBehaviour && sharedFunder)) level = 'STRONG_CANDIDATE';
    else if (kinds.size >= 1) level = 'WEAK_CANDIDATE';
    else level = 'UNKNOWN';

    const confidence = level === 'CONFIRMED_RELATIONSHIP' ? 0.9 : level === 'STRONG_CANDIDATE' ? 0.7 : level === 'WEAK_CANDIDATE' ? 0.3 : 0;
    out.push({ a, b, level, confidence, reasons: list.map(describe), kinds: [...kinds], edgeIds: list.map((e) => e.id) });
  }
  return out;
}

export function buildClusters(pairs: PairAssessment[]): { clusters: WalletCluster[]; weak: PairAssessment[] } {
  const strong = pairs.filter((p) => p.level === 'CONFIRMED_RELATIONSHIP' || p.level === 'STRONG_CANDIDATE');
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root) as string;
    parent.set(x, root);
    return root;
  };
  for (const p of strong) {
    if (!parent.has(p.a)) parent.set(p.a, p.a);
    if (!parent.has(p.b)) parent.set(p.b, p.b);
    const ra = find(p.a);
    const rb = find(p.b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
  const groups = new Map<string, Set<string>>();
  for (const w of parent.keys()) {
    const root = find(w);
    const set = groups.get(root) ?? new Set<string>();
    set.add(w);
    groups.set(root, set);
  }

  const clusters: WalletCluster[] = [];
  for (const members of groups.values()) {
    const inside = strong.filter((p) => members.has(p.a) && members.has(p.b));
    const allConfirmed = inside.every((p) => p.level === 'CONFIRMED_RELATIONSHIP');
    const signals: Partial<Record<EdgeType, number>> = {};
    const reasons = new Set<string>();
    for (const p of inside) {
      for (const r of p.reasons) reasons.add(r);
      for (const kind of p.kinds) signals[kind] = (signals[kind] ?? 0) + 1;
    }
    const sorted = [...members].sort();
    clusters.push({
      id: canonicalId('CLUSTER', ...sorted),
      level: allConfirmed ? 'CONFIRMED_RELATIONSHIP' : 'STRONG_CANDIDATE',
      members: sorted,
      confidence: Math.round((inside.reduce((s, p) => s + p.confidence, 0) / Math.max(1, inside.length)) * 100) / 100,
      signals,
      reasons: [...reasons].slice(0, 8),
    });
  }
  return { clusters, weak: pairs.filter((p) => p.level === 'WEAK_CANDIDATE') };
}
