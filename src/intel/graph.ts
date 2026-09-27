/**
 * The wallet relationship graph: edges between wallets, each with its evidence.
 *
 * | Edge | Built from | Direction |
 * |---|---|---|
 * | FUNDED | a DIRECT or LIKELY funding observation | funder -> wallet |
 * | SHARED_FUNDER | two wallets DIRECT-funded by the same non-infrastructure funder | none |
 * | TOKEN_TRANSFER | a token transfer between two keypair wallets | sender -> receiver |
 * | COORDINATED_ENTRY | first buys of the same token within {@link ENTRY_WINDOW_SLOTS} slots | none |
 * | REPEATED_ORDER_SIZE | the same uncommon buy size used by both, twice or more | none |
 * | SAME_LAUNCH_PARTICIPATION | both entered two or more of the same launches within 60 s | none |
 * | CREATOR_ASSOCIATION | a funding or transfer link with a launch's attributed creator | creator -> wallet or back |
 *
 * **Crowds are not coordination.** When more than {@link CROWD} wallets enter a
 * token in the same few slots - every sniper of a hot launch - no pairwise
 * COORDINATED_ENTRY edges are drawn for it: being in a crowd distinguishes
 * nobody. Likewise a buy size used by more than {@link CROWD} wallets (0.1 SOL,
 * 1 SOL) is common, not a fingerprint. Infrastructure funding never yields an
 * edge.
 *
 * Every edge keeps up to five evidence ids, its count, first and last time,
 * and a confidence. None of these edges is a conclusion on its own - the
 * clustering in `cluster.ts` decides what combinations mean.
 */

import { canonicalId } from '../ingest/events.ts';
import type { FundingClass } from './funding.ts';
import type { WalletTrade } from './wallet-trades.ts';

export const ENTRY_WINDOW_SLOTS = 2;
export const CROWD = 8;
const EARLY_SEC = 60;

export type EdgeType =
  | 'FUNDED'
  | 'SHARED_FUNDER'
  | 'TOKEN_TRANSFER'
  | 'COORDINATED_ENTRY'
  | 'REPEATED_ORDER_SIZE'
  | 'SAME_LAUNCH_PARTICIPATION'
  | 'CREATOR_ASSOCIATION';

export interface WalletEdge {
  id: string;
  type: EdgeType;
  a: string;
  b: string;
  directed: boolean;
  confidence: number;
  count: number;
  firstAt: number | null;
  lastAt: number | null;
  evidence: string[];
  detail: Record<string, string | number | boolean | null>;
}

export interface FundingEdgeInput {
  wallet: string;
  funder: string;
  classification: FundingClass;
  confidence: number;
  signature: string;
  blockTimeMs: number | null;
}

export interface TransferInput {
  from: string;
  to: string;
  signature: string;
  blockTimeMs: number | null;
  asset: string;
}

export interface GraphInput {
  funding: FundingEdgeInput[];
  trades: WalletTrade[];
  transfers: TransferInput[];
  /** Launch time per mint, for same-launch participation. */
  launches: ReadonlyMap<string, { timeMs: number | null }>;
  /** Attributed creators: wallet -> mints they created. */
  creators: ReadonlyMap<string, string[]>;
  /** Addresses known to be keypairs; transfers involving others are skipped. */
  isWallet: (address: string) => boolean;
}

const pairKey = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

class EdgeSet {
  readonly #edges = new Map<string, WalletEdge>();

  add(type: EdgeType, a: string, b: string, directed: boolean, at: number | null, evidence: string, confidence: number, detail: WalletEdge['detail'] = {}): void {
    if (a === b) return;
    const [x, y] = directed ? [a, b] : pairKey(a, b);
    const id = canonicalId('WALLET_EDGE', type, x, y);
    const existing = this.#edges.get(id);
    if (existing) {
      existing.count += 1;
      existing.confidence = Math.max(existing.confidence, confidence);
      if (at !== null) {
        existing.firstAt = existing.firstAt === null ? at : Math.min(existing.firstAt, at);
        existing.lastAt = existing.lastAt === null ? at : Math.max(existing.lastAt, at);
      }
      if (!existing.evidence.includes(evidence) && existing.evidence.length < 5) existing.evidence.push(evidence);
      Object.assign(existing.detail, detail);
      return;
    }
    this.#edges.set(id, { id, type, a: x, b: y, directed, confidence, count: 1, firstAt: at, lastAt: at, evidence: [evidence], detail: { ...detail } });
  }

  values(): WalletEdge[] {
    return [...this.#edges.values()];
  }
}

export function deriveEdges(input: GraphInput): WalletEdge[] {
  const edges = new EdgeSet();

  // --- funding --------------------------------------------------------------
  const byFunder = new Map<string, FundingEdgeInput[]>();
  for (const f of input.funding) {
    if (f.classification !== 'DIRECT' && f.classification !== 'LIKELY') continue;
    edges.add('FUNDED', f.funder, f.wallet, true, f.blockTimeMs, f.signature, f.confidence, { classification: f.classification });
    if (f.classification === 'DIRECT') {
      const list = byFunder.get(f.funder) ?? [];
      list.push(f);
      byFunder.set(f.funder, list);
    }
  }
  for (const [funder, funded] of byFunder) {
    if (funded.length < 2 || funded.length > CROWD * 3) continue;
    for (let i = 0; i < funded.length; i++) {
      for (let j = i + 1; j < funded.length; j++) {
        const a = funded[i] as FundingEdgeInput;
        const b = funded[j] as FundingEdgeInput;
        edges.add('SHARED_FUNDER', a.wallet, b.wallet, false, a.blockTimeMs, a.signature, 0.7, { funder });
      }
    }
  }

  // --- transfers --------------------------------------------------------------
  for (const t of input.transfers) {
    if (t.from === t.to || !input.isWallet(t.from) || !input.isWallet(t.to)) continue;
    edges.add('TOKEN_TRANSFER', t.from, t.to, true, t.blockTimeMs, t.signature, 0.9, { asset: t.asset });
  }

  // --- first entries ---------------------------------------------------------------
  const firstBuy = new Map<string, WalletTrade>();
  for (const t of input.trades) {
    if (t.direction !== 'BUY') continue;
    const key = `${t.wallet}|${t.mint}`;
    const seen = firstBuy.get(key);
    if (!seen || t.slot < seen.slot) firstBuy.set(key, t);
  }
  const entriesByMint = new Map<string, WalletTrade[]>();
  for (const t of firstBuy.values()) {
    const list = entriesByMint.get(t.mint) ?? [];
    list.push(t);
    entriesByMint.set(t.mint, list);
  }
  for (const [mint, entries] of entriesByMint) {
    entries.sort((a, b) => a.slot - b.slot);
    for (let i = 0; i < entries.length; i++) {
      const window = entries.filter((e) => Math.abs(e.slot - (entries[i] as WalletTrade).slot) <= ENTRY_WINDOW_SLOTS);
      if (window.length > CROWD) continue; // a crowd: nobody in it is distinguished
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i] as WalletTrade;
        const b = entries[j] as WalletTrade;
        if (b.slot - a.slot > ENTRY_WINDOW_SLOTS) break;
        edges.add('COORDINATED_ENTRY', a.wallet, b.wallet, false, a.blockTimeMs, `${a.signature}|${b.signature}`, 0.4, { mint, slotGap: b.slot - a.slot });
      }
    }
  }

  // --- order sizes --------------------------------------------------------------------
  // Three significant figures: close enough to call the same order, coarse
  // enough to absorb the fee and tip noise in a wallet's net SOL change.
  const sizeKey = (t: WalletTrade): string | null => {
    if (t.direction !== 'BUY' || t.quoteAmount === null || t.quoteAmount <= 0n || t.quoteMint === null) return null;
    return `${t.quoteMint}:${Number(t.quoteAmount).toPrecision(3)}`;
  };
  const walletsBySize = new Map<string, Map<string, WalletTrade>>();
  for (const t of input.trades) {
    const key = sizeKey(t);
    if (key === null) continue;
    const m = walletsBySize.get(key) ?? new Map<string, WalletTrade>();
    if (!m.has(t.wallet)) m.set(t.wallet, t);
    walletsBySize.set(key, m);
  }
  const sharedSizes = new Map<string, { count: number; evidence: string; at: number | null }>();
  for (const [size, wallets] of walletsBySize) {
    if (wallets.size < 2 || wallets.size > CROWD) continue; // common sizes are not fingerprints
    const list = [...wallets.values()];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [x, y] = pairKey((list[i] as WalletTrade).wallet, (list[j] as WalletTrade).wallet);
        const key = `${x}|${y}`;
        const s = sharedSizes.get(key) ?? { count: 0, evidence: size, at: (list[i] as WalletTrade).blockTimeMs };
        s.count += 1;
        sharedSizes.set(key, s);
      }
    }
  }
  for (const [key, s] of sharedSizes) {
    if (s.count < 2) continue;
    const [x, y] = key.split('|') as [string, string];
    edges.add('REPEATED_ORDER_SIZE', x, y, false, s.at, s.evidence, 0.5, { sharedSizes: s.count });
  }

  // --- same launches ------------------------------------------------------------------
  const earlyLaunches = new Map<string, Set<string>>();
  for (const t of firstBuy.values()) {
    const launch = input.launches.get(t.mint);
    if (!launch || launch.timeMs === null || t.blockTimeMs === null) continue;
    if ((t.blockTimeMs - launch.timeMs) / 1000 > EARLY_SEC) continue;
    const set = earlyLaunches.get(t.wallet) ?? new Set<string>();
    set.add(t.mint);
    earlyLaunches.set(t.wallet, set);
  }
  const early = [...earlyLaunches.entries()];
  for (let i = 0; i < early.length; i++) {
    for (let j = i + 1; j < early.length; j++) {
      const [wa, ma] = early[i] as [string, Set<string>];
      const [wb, mb] = early[j] as [string, Set<string>];
      const shared = [...ma].filter((m) => mb.has(m));
      if (shared.length < 2) continue;
      edges.add('SAME_LAUNCH_PARTICIPATION', wa, wb, false, null, shared.slice(0, 3).join(','), 0.3, { launches: shared.length });
    }
  }

  // --- creators ---------------------------------------------------------------------
  const all = edges.values();
  for (const [creator, mints] of input.creators) {
    for (const e of all) {
      if (e.type !== 'FUNDED' && e.type !== 'TOKEN_TRANSFER') continue;
      if (e.a !== creator && e.b !== creator) continue;
      edges.add('CREATOR_ASSOCIATION', e.a, e.b, true, e.firstAt, e.evidence[0] ?? e.id, Math.min(0.9, e.confidence), { via: e.type, creator, mints: mints.slice(0, 3).join(',') });
    }
  }
  return edges.values();
}
