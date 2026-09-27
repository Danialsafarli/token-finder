/**
 * The deep-intelligence cycle: staged, bounded actor analysis for surviving
 * tokens.
 *
 *   FAST SCREEN -> TRANSACTION COLLECTION -> DEEP WALLET ANALYSIS
 *               -> GRAPH EXPANSION -> CREATOR HISTORY
 *
 * 1. **Fast screen.** Only survivors (QUALIFIED or WATCH, evaluated recently)
 *    are analysed, QUALIFIED first, the one analysed longest ago first. The
 *    scan's own gate did the cheap rejecting; nothing here re-decides it.
 * 2. **Transaction collection.** The token's creation transaction (for
 *    attribution) and its mint's recent history (for security facts), plus
 *    the pool activity the backbone already collected.
 * 3. **Deep wallet analysis.** Earliest buyers, largest buyers and the
 *    creator: each wallet's newest transactions (behaviour) and oldest ones
 *    (first funding), read into trades, features and a classification. A
 *    profile younger than its TTL is reused, not re-read.
 * 4. **Graph expansion.** Each funder is checked for being a hub (one
 *    signatures page) and classified; direct and likely funders are followed
 *    back up to `graphDepth` hops. Edges and clusters are derived and stored.
 * 5. **Creator history.** Security events from the facts, the creator's
 *    profile across every launch Token Finder has recorded, and the search
 *    for a serial network around it.
 *
 * ## Budgets and truncation
 *
 * Every provider request draws on one cycle budget (`requestsPerCycle`),
 * split evenly across the tokens still to go, and on one wall-clock deadline
 * (`cycleMaxMs`). When a budget stops a stage, what it cut is written into the
 * token's `truncation` list, and it lowers coverage: a wallet not read is not
 * counted as read, a funder not checked cannot make funding DIRECT, a mint
 * history cut short is marked partial. The pure stages still run on whatever
 * was collected, so a truncated analysis is smaller, never invented.
 *
 * ## Failure isolation
 *
 * Nothing here throws into the server, and nothing here touches scoring,
 * ranking or the gate. A provider outage yields FAILED or PARTIAL health and
 * token snapshots whose coverage says how little was seen.
 */

import { log } from '../util/logger.ts';
import type { ProviderFailure } from '../util/failure.ts';
import type { ProviderResult } from '../util/http.ts';
import type { ChainRepository, ActivityRow } from '../persist/chain-repository.ts';
import type { IntelRepository, StoredFunding } from '../persist/intel-repository.ts';
import type { TokenSnapshot } from '../types.ts';
import type { AddressHistory, SignatureInfo } from '../sources/solana-rpc.ts';
import { isOnCurve } from '../chain/address.ts';
import { normalizeTransaction, type NormalizedTransaction } from '../ingest/normalize.ts';
import { walletTrades, type WalletTrade } from './wallet-trades.ts';
import { computeFeatures, type LaunchTime } from './features.ts';
import { classifyBuyer, type BuyerClass, type BuyerClassification } from './classify.ts';
import { classifyFunding, findInitialFunding, type FunderStats, type FundingObservation, type FundingVerdict } from './funding.ts';
import { deriveEdges, type TransferInput, type WalletEdge } from './graph.ts';
import { assessPairs, buildClusters, type WalletCluster } from './cluster.ts';
import { analyzeWash, type WashAnalysis, type WashTrade } from './wash.ts';
import { activityQuality, type ActivityQuality } from './activity-quality.ts';
import { attributeCreation, unknownAttribution, type Attribution } from './attribution.ts';
import { detectSecurityEvents, type SecurityEvent, type SecurityInput } from './security.ts';
import { analyzeNetwork, buildCreatorProfile, type CreatorProfile, type NetworkAnalysis, type PathEdge } from './creator.ts';

// --- ports -----------------------------------------------------------------------

export interface HistoryPort {
  history(address: string, options: { order: 'asc' | 'desc'; limit: number; succeededOnly?: boolean }): Promise<ProviderResult<AddressHistory>>;
  signatures(address: string, limit: number): Promise<ProviderResult<SignatureInfo[]>>;
  transaction(signature: string): Promise<ProviderResult<unknown>>;
}

export interface IntelSettings {
  tokensPerCycle: number;
  walletsPerToken: number;
  txPerWallet: number;
  ascLimit: number;
  graphDepth: number;
  requestsPerCycle: number;
  cycleMaxMs: number;
  profileTtlMs: number;
  tokenRefreshMs: number;
  liveWindowMs: number;
}

export interface IntelDeps {
  history: HistoryPort;
  chain: ChainRepository | null;
  intel: IntelRepository | null;
  tokens: () => TokenSnapshot[];
  source: string;
  settings: IntelSettings;
  now?: () => number;
}

// --- budget ------------------------------------------------------------------------

/**
 * A request and time budget. `take` is the only way to spend it, so a stage
 * cannot forget to check; each refusal is recorded once per reason.
 */
export class IntelBudget {
  #used = 0;
  readonly #limit: number;
  readonly #deadline: number;
  readonly #now: () => number;
  readonly truncation: string[] = [];

  constructor(limit: number, deadline: number, now: () => number) {
    this.#limit = limit;
    this.#deadline = deadline;
    this.#now = now;
  }

  get used(): number {
    return this.#used;
  }

  get limit(): number {
    return this.#limit;
  }

  timeLeft(): boolean {
    return this.#now() < this.#deadline;
  }

  /** Spends one request, or records why it could not and returns false. */
  take(stage: string): boolean {
    if (!this.timeLeft()) {
      this.note(`TIME_BUDGET: stopped before ${stage}`);
      return false;
    }
    if (this.#used >= this.#limit) {
      this.note(`REQUEST_BUDGET: stopped before ${stage}`);
      return false;
    }
    this.#used += 1;
    return true;
  }

  note(entry: string): void {
    if (!this.truncation.includes(entry)) this.truncation.push(entry);
  }
}

// --- the fast screen ------------------------------------------------------------------

export interface IntelWork {
  mint: string;
  tier: 'QUALIFIED' | 'WATCH';
}

export interface IntelPlan {
  work: IntelWork[];
  skipped: { notSurvivor: number; notLive: number; recentlyAnalyzed: number; overBudget: number };
}

export function planIntel(
  tokens: TokenSnapshot[],
  lastAnalyzedAt: (mint: string) => number | null,
  settings: Pick<IntelSettings, 'tokensPerCycle' | 'tokenRefreshMs' | 'liveWindowMs'>,
  now: number,
): IntelPlan {
  const skipped = { notSurvivor: 0, notLive: 0, recentlyAnalyzed: 0, overBudget: 0 };
  const candidates: (IntelWork & { last: number; liquidity: number })[] = [];
  for (const token of tokens) {
    const eligibility = token.evaluation?.eligibility;
    if (eligibility !== 'QUALIFIED' && eligibility !== 'WATCH') {
      skipped.notSurvivor += 1;
      continue;
    }
    if (now - token.at > settings.liveWindowMs) {
      skipped.notLive += 1;
      continue;
    }
    const last = lastAnalyzedAt(token.mint);
    if (last !== null && now - last < settings.tokenRefreshMs) {
      skipped.recentlyAnalyzed += 1;
      continue;
    }
    candidates.push({ mint: token.mint, tier: eligibility, last: last ?? -1, liquidity: token.liquidityUsd ?? 0 });
  }
  candidates.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === 'QUALIFIED' ? -1 : 1;
    if (a.last !== b.last) return a.last - b.last;
    return b.liquidity - a.liquidity;
  });
  const work = candidates.slice(0, settings.tokensPerCycle).map(({ mint, tier }) => ({ mint, tier }));
  skipped.overBudget = candidates.length - work.length;
  return { work, skipped };
}

// --- reports ---------------------------------------------------------------------------

export type IntelHealthState = 'AVAILABLE' | 'PARTIAL' | 'STALE' | 'UNAVAILABLE' | 'FAILED';

export interface WalletSummary {
  wallet: string;
  roles: ('creator' | 'early' | 'large')[];
  status: 'ANALYZED' | 'REUSED' | 'FAILED' | 'NOT_READ';
  classification: BuyerClass;
  confidence: number;
  coverage: number;
  signals: string[];
  counterSignals: string[];
  funding: { funder: string; classification: string; confidence: number } | null;
  truncation: string[];
}

export interface TokenReport {
  mint: string;
  tier: 'QUALIFIED' | 'WATCH';
  stages: Record<'transactions' | 'wallets' | 'graph' | 'creator', 'DONE' | 'PARTIAL' | 'SKIPPED' | 'FAILED'>;
  wallets: { selected: number; analyzed: number; reused: number; failed: number; notRead: number };
  funders: { probed: number; cached: number; hops: number };
  edges: number;
  clusters: number;
  weakPairs: number;
  wash: WashAnalysis['risk'];
  activity: ActivityQuality['status'];
  attribution: Attribution['status'];
  securityEvents: number;
  network: NetworkAnalysis['level'];
  coverage: number;
  requests: number;
  truncation: string[];
  error: string | null;
}

export interface IntelCycleReport {
  at: number;
  finishedAt: number;
  durationMs: number;
  source: string;
  skipped: IntelPlan['skipped'];
  tokens: TokenReport[];
  budget: { requests: number; limit: number; cycleMaxMs: number };
  failures: ProviderFailure[];
  health: { state: IntelHealthState; reason: string };
}

// --- helpers -------------------------------------------------------------------------------

const WALLET_CONCURRENCY = 2;
const MAX_NETWORK_NODES = 300;
const SIGNATURE_PROBE = 1000;

function normalizeAll(raw: unknown[]): NormalizedTransaction[] {
  const out: NormalizedTransaction[] = [];
  for (const r of raw) {
    const tx = normalizeTransaction(r);
    if (tx !== null) out.push(tx);
  }
  return out;
}

async function inLanes<T>(items: T[], width: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await work(item);
    }
  });
  await Promise.all(lanes);
}

const toBig = (value: string | null): bigint | null => {
  if (value === null) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
};

const pairId = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

// --- one token -------------------------------------------------------------------------------

interface WalletRun {
  wallet: string;
  roles: Set<'creator' | 'early' | 'large'>;
  status: WalletSummary['status'];
  classification: BuyerClassification | null;
  stored: { classification: BuyerClass; confidence: number; coverage: number } | null;
  funding: { obs: FundingObservation; verdict: FundingVerdict } | null;
  transfers: TransferInput[];
  truncation: string[];
}

export async function analyzeToken(
  work: IntelWork,
  deps: IntelDeps & { chain: ChainRepository; intel: IntelRepository },
  budget: IntelBudget,
  failures: ProviderFailure[],
): Promise<TokenReport> {
  const now = deps.now ?? Date.now;
  const at = now();
  const { chain, intel, settings } = deps;
  const mint = work.mint;
  const truncation = budget.truncation;
  const report: TokenReport = {
    mint,
    tier: work.tier,
    stages: { transactions: 'SKIPPED', wallets: 'SKIPPED', graph: 'SKIPPED', creator: 'SKIPPED' },
    wallets: { selected: 0, analyzed: 0, reused: 0, failed: 0, notRead: 0 },
    funders: { probed: 0, cached: 0, hops: 0 },
    edges: 0,
    clusters: 0,
    weakPairs: 0,
    wash: 'INSUFFICIENT_DATA',
    activity: 'INSUFFICIENT_DATA',
    attribution: 'UNKNOWN',
    securityEvents: 0,
    network: 'INSUFFICIENT_DATA',
    coverage: 0,
    requests: 0,
    truncation,
    error: null,
  };
  const fail = (f: ProviderFailure | null): void => {
    if (f) failures.push(f);
  };

  // === stage 2: transaction collection =====================================================
  const activity: ActivityRow[] = chain.activityOf(mint, 1000);
  if (activity.length === 1000) truncation.push('POOL_ACTIVITY: newest 1000 pool readings used');
  const launchRow = chain.launch(mint);
  let creation: NormalizedTransaction | null = null;
  let mintTxs: NormalizedTransaction[] = [];
  let mintHistoryComplete: 'COMPLETE' | 'PARTIAL' | 'NONE' = 'NONE';
  let transactionsStage: TokenReport['stages']['transactions'] = 'DONE';

  if (launchRow !== null && budget.take('creation transaction')) {
    const r = await deps.history.transaction(launchRow.signature);
    fail(r.failure);
    creation = r.data === null ? null : normalizeTransaction(r.data);
  }
  if (budget.take('mint history (oldest)')) {
    const r = await deps.history.history(mint, { order: 'asc', limit: 5, succeededOnly: true });
    fail(r.failure);
    if (r.data?.method === 'unsupported') truncation.push('MINT_ORIGIN: oldest-first history is not available from this endpoint');
    const oldest = normalizeAll(r.data?.txs ?? []);
    mintTxs.push(...oldest);
    creation ??= oldest.find((t) => t.mintInits.some((m) => m.mint === mint)) ?? null;
    if (r.failure) transactionsStage = 'PARTIAL';
  } else transactionsStage = 'PARTIAL';
  if (budget.take('mint history (newest)')) {
    const r = await deps.history.history(mint, { order: 'desc', limit: 100, succeededOnly: true });
    fail(r.failure);
    if (r.data) {
      mintTxs.push(...normalizeAll(r.data.txs));
      mintHistoryComplete = r.data.complete ? 'COMPLETE' : 'PARTIAL';
      if (!r.data.complete) truncation.push('MINT_HISTORY: only the newest 100 transactions of the mint were scanned for security facts');
    } else transactionsStage = 'PARTIAL';
  } else transactionsStage = 'PARTIAL';
  if (creation) mintTxs.push(creation);
  mintTxs = [...new Map(mintTxs.map((t) => [t.signature, t])).values()];
  report.stages.transactions = transactionsStage;

  const pool = launchRow?.pool ?? null;
  let attribution: Attribution = creation
    ? attributeCreation(creation, mint, pool)
    : unknownAttribution(mint, launchRow ? 'the creation transaction could not be read' : 'the creation transaction was not located');
  const launchTime: LaunchTime | null = creation
    ? { slot: creation.slot, timeMs: creation.blockTimeMs, source: 'chain' }
    : launchRow
      ? { slot: launchRow.slot, timeMs: launchRow.blockTime, source: 'chain' }
      : null;

  // === stage 3: wallet selection and deep wallet analysis ==================================
  const runs = new Map<string, WalletRun>();
  const want = (wallet: string | null, role: 'creator' | 'early' | 'large'): void => {
    if (wallet === null || isOnCurve(wallet) !== true) return;
    const run = runs.get(wallet);
    if (run) {
      run.roles.add(role);
      return;
    }
    runs.set(wallet, { wallet, roles: new Set([role]), status: 'NOT_READ', classification: null, stored: null, funding: null, transfers: [], truncation: [] });
  };
  const creatorCandidates = attribution.creator ? [attribution.creator] : attribution.status === 'AMBIGUOUS' ? attribution.deployers.slice(0, 2) : [];
  for (const c of creatorCandidates) want(c, 'creator');

  const swaps = activity.filter((a) => a.kind === 'SWAP' && a.trader !== null);
  const earliest = chain.buyerArrivals(mint, 100).filter((b) => b.buys > 0 && b.onCurve !== false).map((b) => b.wallet);
  if (earliest.length === 0) {
    for (const a of [...swaps].reverse()) if (a.direction === 'BUY') earliest.push(a.trader as string);
  }
  const bought = new Map<string, bigint>();
  for (const a of swaps) {
    if (a.direction !== 'BUY') continue;
    bought.set(a.trader as string, (bought.get(a.trader as string) ?? 0n) + (toBig(a.quoteAmount) ?? 0n));
  }
  const largest = [...bought.entries()].sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0)).map(([w]) => w);
  const slots = Math.max(0, settings.walletsPerToken - runs.size);
  const earlyQuota = Math.ceil(slots / 2);
  for (const w of [...new Set(earliest)].slice(0, earlyQuota)) want(w, 'early');
  for (const w of largest) {
    if (runs.size >= settings.walletsPerToken) break;
    want(w, 'large');
  }
  for (const w of [...new Set(earliest)]) {
    if (runs.size >= settings.walletsPerToken) break;
    want(w, 'early');
  }
  const allTraders = new Set([...earliest, ...bought.keys()]);
  const leftOut = [...allTraders].filter((w) => !runs.has(w)).length;
  if (leftOut > 0) truncation.push(`WALLET_BUDGET: ${leftOut} more trader(s) not analysed (limit ${settings.walletsPerToken} per token)`);
  report.wallets.selected = runs.size;

  const launchCache = new Map<string, LaunchTime>();
  if (launchTime) launchCache.set(mint, launchTime);
  const launchOf = (m: string): LaunchTime | undefined => {
    if (!launchCache.has(m)) {
      const row = chain.launch(m);
      if (row) launchCache.set(m, { slot: row.slot, timeMs: row.blockTime, source: 'chain' });
    }
    return launchCache.get(m);
  };

  const fresh = intel.profiles([...runs.keys()]);
  await inLanes([...runs.values()], WALLET_CONCURRENCY, async (run) => {
    const stored = fresh.get(run.wallet);
    if (stored && at - stored.analyzedAt < settings.profileTtlMs) {
      run.status = 'REUSED';
      run.stored = { classification: stored.classification, confidence: stored.confidence, coverage: stored.coverage };
      const prior = intel.fundingOf([run.wallet])[0];
      if (prior) run.funding = { obs: prior, verdict: { classification: prior.classification, confidence: prior.confidence, reasons: prior.reasons } };
      return;
    }
    if (!budget.take(`history of ${run.wallet.slice(0, 6)}…`)) return;
    const desc = await deps.history.history(run.wallet, { order: 'desc', limit: settings.txPerWallet });
    fail(desc.failure);
    if (desc.data === null) {
      run.status = 'FAILED';
      return;
    }
    const recent = normalizeAll(desc.data.txs);
    if (!desc.data.complete) run.truncation.push(`WINDOW: newest ${recent.length} transactions only`);
    let oldest: NormalizedTransaction[] | null = null;
    let fromStart = false;
    if (desc.data.complete) {
      oldest = [...recent].sort((a, b) => a.slot - b.slot);
      fromStart = true;
    } else if (budget.take(`oldest history of ${run.wallet.slice(0, 6)}…`)) {
      const asc = await deps.history.history(run.wallet, { order: 'asc', limit: settings.ascLimit, succeededOnly: true });
      fail(asc.failure);
      if (asc.data && asc.data.method === 'gtfa') {
        oldest = normalizeAll(asc.data.txs);
        fromStart = true;
      } else if (asc.data?.method === 'unsupported') {
        run.truncation.push('FIRST_FUNDING: oldest-first history not available from this endpoint');
      }
    } else run.truncation.push('FIRST_FUNDING: not read (budget)');

    const trades = new Map<string, WalletTrade>();
    for (const [i, tx] of [...recent, ...(oldest ?? [])].entries()) {
      for (const t of walletTrades(tx, run.wallet, i)) trades.set(`${t.signature}|${t.mint}`, t);
    }
    const tradeList = [...trades.values()];
    const launches = new Map<string, LaunchTime>();
    for (const t of tradeList) {
      const l = launchOf(t.mint);
      if (l) launches.set(t.mint, l);
    }
    const features = computeFeatures({ wallet: run.wallet, recent, recentComplete: desc.data.complete, earliest: oldest, trades: tradeList, launches });

    // Entry into this token, from its own trades or the pool's record of them.
    let entrySec: number | null = null;
    if (launchTime?.timeMs != null) {
      const firstBuy = tradeList.filter((t) => t.mint === mint && t.direction === 'BUY' && t.blockTimeMs !== null).sort((a, b) => a.slot - b.slot)[0];
      const poolBuy = swaps.filter((a) => a.trader === run.wallet && a.direction === 'BUY' && a.blockTime !== null).sort((a, b) => a.slot - b.slot)[0];
      const t = firstBuy?.blockTimeMs ?? poolBuy?.blockTime ?? null;
      if (t !== null) entrySec = Math.max(0, (t - launchTime.timeMs) / 1000);
    }
    const classification = classifyBuyer(features, entrySec);
    run.classification = classification;
    run.status = 'ANALYZED';

    const obs = findInitialFunding(run.wallet, oldest ?? [...recent].sort((a, b) => a.slot - b.slot), fromStart);
    if (obs) run.funding = { obs, verdict: { classification: 'UNKNOWN', confidence: 0, reasons: ['not yet classified'] } };

    for (const tx of recent) {
      if (tx.status !== 'SUCCESS') continue;
      for (const s of tx.solTransfers) {
        if (s.from === run.wallet || s.to === run.wallet) run.transfers.push({ from: s.from, to: s.to, signature: tx.signature, blockTimeMs: tx.blockTimeMs, asset: 'SOL' });
      }
      for (const t of tx.tokenTransfers) {
        if (t.sourceOwner === null || t.destinationOwner === null) continue;
        if (t.sourceOwner === run.wallet || t.destinationOwner === run.wallet) {
          run.transfers.push({ from: t.sourceOwner, to: t.destinationOwner, signature: tx.signature, blockTimeMs: tx.blockTimeMs, asset: t.mint ?? 'token' });
        }
      }
    }
    intel.saveWalletAnalysis({ features, classification, onCurve: true, trades: tradeList, truncation: run.truncation, source: deps.source, at });
  });

  for (const run of runs.values()) {
    if (run.status === 'ANALYZED') report.wallets.analyzed += 1;
    else if (run.status === 'REUSED') report.wallets.reused += 1;
    else if (run.status === 'FAILED') report.wallets.failed += 1;
    else report.wallets.notRead += 1;
  }
  report.stages.wallets = runs.size === 0 ? 'SKIPPED' : report.wallets.analyzed + report.wallets.reused === runs.size ? 'DONE' : report.wallets.analyzed + report.wallets.reused === 0 ? 'FAILED' : 'PARTIAL';

  // === stage 4: graph expansion ======================================================================
  const hubs = new Set<string>();
  const checked = new Set<string>(); // on-curve addresses whose hub probe says "not a hub"
  const statsFor = async (address: string): Promise<FunderStats | null> => {
    const onCurve = isOnCurve(address);
    const fanOut = intel.fanOut(address);
    const cached = intel.addressStats(address);
    let recentTxCount: number | null = null;
    let windowMs: number | null = null;
    if (cached && at - cached.checkedAt < settings.profileTtlMs) {
      recentTxCount = cached.recentTxCount;
      windowMs = cached.windowMs;
      report.funders.cached += 1;
    } else if (onCurve === true && budget.take(`hub check of ${address.slice(0, 6)}…`)) {
      const r = await deps.history.signatures(address, SIGNATURE_PROBE);
      fail(r.failure);
      if (r.data) {
        const times = r.data.map((s) => s.blockTimeMs).filter((t): t is number => t !== null);
        recentTxCount = r.data.length;
        windowMs = times.length >= 2 ? Math.max(...times) - Math.min(...times) : null;
        intel.saveAddressStats(address, { onCurve, recentTxCount, windowMs }, at);
        report.funders.probed += 1;
      }
    } else if (onCurve === false) {
      intel.saveAddressStats(address, { onCurve, recentTxCount: null, windowMs: null }, at);
    }
    return { address, onCurve, recentTxCount, recentWindowMs: windowMs, fanOut };
  };
  const classifyAndSave = async (obs: FundingObservation): Promise<FundingVerdict> => {
    const stats = await statsFor(obs.funder);
    // Fan-out counts this observation too, before it is stored.
    const known = intel.fundedBy(obs.funder).some((f) => f.wallet === obs.wallet);
    const verdict = classifyFunding(obs, stats === null ? null : { ...stats, fanOut: stats.fanOut + (known ? 0 : 1) });
    intel.saveFunding(obs, verdict, deps.source, at);
    if (verdict.classification === 'INFRASTRUCTURE') hubs.add(obs.funder);
    else if (stats?.recentTxCount != null && stats.onCurve === true) checked.add(obs.funder);
    return verdict;
  };

  let frontier: FundingObservation[] = [];
  let graphStage: TokenReport['stages']['graph'] = 'DONE';
  for (const run of runs.values()) {
    if (run.funding && run.status === 'ANALYZED') {
      run.funding.verdict = await classifyAndSave(run.funding.obs);
      if (run.funding.verdict.classification === 'DIRECT' || run.funding.verdict.classification === 'LIKELY') frontier.push(run.funding.obs);
    } else if (run.funding && run.status === 'REUSED' && run.funding.verdict.classification === 'INFRASTRUCTURE') {
      hubs.add(run.funding.obs.funder);
    }
  }
  const followed = new Set<string>(runs.keys());
  for (let depth = 1; depth < settings.graphDepth && frontier.length > 0; depth++) {
    const next: FundingObservation[] = [];
    for (const obs of frontier.slice(0, settings.walletsPerToken)) {
      const funder = obs.funder;
      if (followed.has(funder) || isOnCurve(funder) !== true) continue;
      followed.add(funder);
      const prior = intel.fundingOf([funder])[0];
      // A funder whose own funding was already read is not read again.
      if (prior && prior.classification !== 'UNKNOWN') {
        if (prior.classification === 'DIRECT' || prior.classification === 'LIKELY') next.push(prior);
        continue;
      }
      if (!budget.take(`funding hop ${depth + 1}`)) {
        graphStage = 'PARTIAL';
        truncation.push(`GRAPH_DEPTH: funding chain stopped at hop ${depth}`);
        break;
      }
      const r = await deps.history.history(funder, { order: 'asc', limit: settings.ascLimit, succeededOnly: true });
      fail(r.failure);
      if (!r.data || r.data.method !== 'gtfa') continue;
      const hop = findInitialFunding(funder, normalizeAll(r.data.txs), true);
      if (!hop) continue;
      report.funders.hops += 1;
      const verdict = await classifyAndSave(hop);
      if (verdict.classification === 'DIRECT' || verdict.classification === 'LIKELY') next.push(hop);
    }
    if (frontier.length > settings.walletsPerToken) truncation.push(`GRAPH_WIDTH: ${frontier.length - settings.walletsPerToken} funder(s) at hop ${depth} not followed`);
    frontier = next;
  }
  if (frontier.length > 0 && settings.graphDepth > 0) truncation.push(`GRAPH_DEPTH: stopped at the configured depth of ${settings.graphDepth} hop(s)`);

  // Transfers only between addresses whose nature was checked: an analysed
  // wallet, or a funder probed and found not to be a hub. An exchange hot
  // wallet paying out to two users is not a relationship between them.
  const trusted = new Set<string>([...runs.keys(), ...checked]);
  for (const h of hubs) trusted.delete(h);
  const transfers = [...runs.values()].flatMap((r) => r.transfers).filter((t) => trusted.has(t.from) && trusted.has(t.to));
  const analyzed = [...runs.values()].filter((r) => r.status === 'ANALYZED' || r.status === 'REUSED').map((r) => r.wallet);
  const nodes = [...new Set([...analyzed, ...followed])];
  const funding: StoredFunding[] = intel.fundingOf(nodes);
  const trades = intel.tradesOf(analyzed);
  const launchMap = new Map<string, { timeMs: number | null }>();
  for (const t of trades) {
    const l = launchOf(t.mint);
    if (l) launchMap.set(t.mint, { timeMs: l.timeMs });
  }
  const creators = new Map<string, string[]>();
  if (attribution.creator) creators.set(attribution.creator, [mint, ...intel.launchesOf(attribution.creator).map((l) => l.mint).filter((m) => m !== mint)]);
  const derived: WalletEdge[] = deriveEdges({
    funding: funding.map((f) => ({ wallet: f.wallet, funder: f.funder, classification: f.classification, confidence: f.confidence, signature: f.signature, blockTimeMs: f.blockTimeMs })),
    trades,
    transfers,
    launches: launchMap,
    creators,
    isWallet: (a) => isOnCurve(a) === true && !hubs.has(a),
  });
  intel.saveEdges(derived, at);
  report.edges = derived.length;

  // Clusters from every stored edge around these wallets and their neighbours.
  const around = intel.edgesTouching(nodes);
  const neighbours = [...new Set(around.flatMap((e) => [e.a, e.b]))].slice(0, MAX_NETWORK_NODES);
  const edgeSet = intel.edgesTouching(neighbours);
  const pairs = assessPairs(edgeSet);
  const { clusters, weak } = buildClusters(pairs);
  intel.replaceClusters(nodes, clusters, at);
  report.clusters = clusters.length;
  report.weakPairs = weak.length;
  report.stages.graph = runs.size === 0 ? 'SKIPPED' : graphStage;

  // === activity quality and wash ====================================================================
  const clustered = new Set<string>(clusters.flatMap((c) => c.members));
  const relatedPairs = new Set(pairs.filter((p) => p.level === 'STRONG_CANDIDATE' || p.level === 'CONFIRMED_RELATIONSHIP').map((p) => pairId(p.a, p.b)));
  const washTrades: WashTrade[] = swaps.map((a) => ({
    signature: a.signature,
    trader: a.trader,
    direction: a.direction === 'SELL' ? 'SELL' : 'BUY',
    tokenAmount: toBig(a.tokenAmount) ?? 0n,
    quoteAmount: toBig(a.quoteAmount),
    slot: a.slot,
    blockTimeMs: a.blockTime,
  }));
  const unresolved = activity.filter((a) => a.kind === 'UNRESOLVED').length;
  const wash = analyzeWash({ trades: washTrades, unresolved, relatedPairs, clusteredWallets: clustered });
  report.wash = wash.risk;
  const traders = [...new Set(swaps.map((a) => a.trader as string))];
  const classes = new Map<string, BuyerClass>();
  for (const [w, p] of intel.profiles(traders)) classes.set(w, p.classification);
  const quality = activityQuality({ trades: swaps.map((a) => ({ trader: a.trader, quoteAmount: toBig(a.quoteAmount) })), classes, clustered });
  report.activity = quality.status;

  // === stage 5: security events, creator history, serial networks ==================================
  const creatorRun = attribution.creator ? runs.get(attribution.creator) : undefined;
  if (creatorRun?.funding) attribution = { ...attribution, initialFunder: creatorRun.funding.obs.funder };
  intel.saveAttribution(attribution, at);
  report.attribution = attribution.status;

  const linked = new Set<string>();
  for (const a of [attribution.creator, ...attribution.deployers]) if (a) linked.add(a);
  if (attribution.feePayer && isOnCurve(attribution.feePayer) === true && !hubs.has(attribution.feePayer)) linked.add(attribution.feePayer);
  if (attribution.creator) {
    for (const c of clusters) if (c.members.includes(attribution.creator)) for (const m of c.members) linked.add(m);
    for (const f of intel.fundedBy(attribution.creator)) if (f.classification === 'DIRECT') linked.add(f.wallet);
  }
  const ownerOf = (tx: NormalizedTransaction, account: string): string | null =>
    tx.tokenBalances.find((b) => b.account === account)?.owner ?? tx.tokenAccountInits.find((i) => i.account === account)?.owner ?? null;
  const initialSupply = creation
    ? creation.mintTos.filter((m) => m.mint === mint).reduce<bigint | null>((sum, m) => (sum ?? 0n) + m.amount, null)
    : null;
  const sells = new Map<string, SecurityInput['sells'][number]>();
  for (const a of swaps) {
    if (a.direction !== 'SELL') continue;
    const amount = toBig(a.tokenAmount);
    if (amount !== null) sells.set(`${a.signature}|${a.trader}`, { signature: a.signature, slot: a.slot, blockTimeMs: a.blockTime, trader: a.trader as string, tokenAmount: amount });
  }
  for (const t of trades) {
    if (t.mint !== mint || t.direction !== 'SELL') continue;
    sells.set(`${t.signature}|${t.wallet}`, { signature: t.signature, slot: t.slot, blockTimeMs: t.blockTimeMs, trader: t.wallet, tokenAmount: t.tokenAmount });
  }
  const security: SecurityInput = {
    mint,
    launchSignature: creation?.signature ?? launchRow?.signature ?? null,
    launchSlot: creation?.slot ?? launchRow?.slot ?? null,
    initialSupply,
    creatorLinked: linked,
    mintTos: mintTxs.flatMap((tx) =>
      tx.status !== 'SUCCESS'
        ? []
        : tx.mintTos.filter((m) => m.mint === mint).map((m) => ({ signature: tx.signature, slot: tx.slot, blockTimeMs: tx.blockTimeMs, amount: m.amount, recipientOwner: ownerOf(tx, m.account), authority: m.authority })),
    ),
    authorityChanges: mintTxs.flatMap((tx) =>
      tx.status !== 'SUCCESS'
        ? []
        : tx.authorityChanges.filter((c) => c.target === mint).map((c) => ({ signature: tx.signature, slot: tx.slot, blockTimeMs: tx.blockTimeMs, authorityType: c.authorityType, newAuthority: c.newAuthority, previousAuthority: c.previousAuthority })),
    ),
    freezes: mintTxs.flatMap((tx) =>
      tx.status !== 'SUCCESS'
        ? []
        : tx.freezes.filter((f) => f.mint === mint).map((f) => ({ signature: tx.signature, slot: tx.slot, blockTimeMs: tx.blockTimeMs, kind: f.kind, owner: f.owner, authority: f.authority })),
    ),
    liquidityRemovals: activity
      .filter((a) => a.kind === 'LIQUIDITY_REMOVED')
      .map((a) => ({ signature: a.signature, slot: a.slot, blockTimeMs: a.blockTime, actor: a.liquidityActor, reserveFraction: a.reserveFraction, tokenAmount: toBig(a.tokenAmount) })),
    sells: [...sells.values()],
  };
  const events: SecurityEvent[] = detectSecurityEvents(security);
  intel.saveSecurityEvents(events, at);
  report.securityEvents = events.length;

  const subjects = attribution.creator ? [attribution.creator] : attribution.status === 'AMBIGUOUS' ? attribution.deployers : [];
  const freshProfiles = new Map<string, CreatorProfile>();
  for (const subject of subjects) {
    const launches = intel.launchesOf(subject);
    const recorded = intel.eventsOf(launches.map((l) => l.mint));
    const profile = buildCreatorProfile(
      subject,
      launches,
      recorded.map((e) => ({ mint: e.mint, type: e.type, status: e.status, signature: e.signature })),
    );
    // An ambiguous deployer is profiled for the network search, but its
    // profile is not stored as a creator's: it was never attributed one.
    if (subject === attribution.creator) intel.saveCreatorProfile(profile, at);
    freshProfiles.set(subject, profile);
  }
  const pathEdges = networkEdges(intel, subjects, settings.graphDepth);
  const profiles = new Map([...intel.creatorsWithHistory(), ...freshProfiles]);
  const network = analyzeNetwork(subjects, pathEdges, profiles, settings.graphDepth);
  report.network = network.level;
  report.stages.creator = subjects.length === 0 ? 'SKIPPED' : 'DONE';

  // === the snapshot ===================================================================================
  const walletCoverage = runs.size === 0
    ? 0
    : [...runs.values()].reduce((sum, r) => sum + (r.status === 'ANALYZED' ? (r.truncation.length > 0 ? 0.75 : 1) : r.status === 'REUSED' ? 1 : 0), 0) / runs.size;
  const parts = [
    walletCoverage,
    attribution.status === 'ATTRIBUTED' ? 1 : attribution.status === 'AMBIGUOUS' ? 0.5 : 0,
    quality.byTrades.coverage,
    mintHistoryComplete === 'COMPLETE' ? 1 : mintHistoryComplete === 'PARTIAL' ? 0.5 : 0,
  ];
  report.coverage = Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 1000) / 1000;
  report.requests = budget.used;

  const walletSummaries: WalletSummary[] = [...runs.values()].map((r) => ({
    wallet: r.wallet,
    roles: [...r.roles],
    status: r.status,
    classification: r.classification?.classification ?? r.stored?.classification ?? (r.status === 'FAILED' ? 'UNKNOWN' : 'INSUFFICIENT_DATA'),
    confidence: r.classification?.confidence ?? r.stored?.confidence ?? 0,
    coverage: r.classification?.coverage ?? r.stored?.coverage ?? 0,
    signals: r.classification?.signals.map((s) => s.code) ?? [],
    counterSignals: r.classification?.counterSignals.map((s) => s.code) ?? [],
    funding: r.funding ? { funder: r.funding.obs.funder, classification: r.funding.verdict.classification, confidence: r.funding.verdict.confidence } : null,
    truncation: r.truncation,
  }));
  const clusterSummary = clusters
    .filter((c) => c.members.some((m) => runs.has(m)))
    .map((c: WalletCluster) => ({ id: c.id, level: c.level, size: c.members.length, confidence: c.confidence, reasons: c.reasons, members: c.members.slice(0, 20) }));
  intel.saveTokenIntelligence({
    mint,
    analyzedAt: at,
    activity: quality,
    wash,
    attribution,
    network: {
      analysis: network,
      creator: attribution.creator ? (freshProfiles.get(attribution.creator) ?? null) : null,
      security: events,
      clusters: clusterSummary,
      weakPairs: weak.length,
      stages: report.stages,
    },
    wallets: walletSummaries,
    coverage: report.coverage,
    truncation,
  });
  return report;
}

/** The strong and behavioural links around the subjects, from stored data only. */
function networkEdges(intel: IntelRepository, subjects: string[], depth: number): PathEdge[] {
  const out = new Map<string, PathEdge>();
  let frontier = [...subjects];
  const seen = new Set(subjects);
  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next = new Set<string>();
    const add = (e: PathEdge, key: string): void => {
      if (!out.has(key)) out.set(key, e);
      for (const n of [e.from, e.to]) if (!seen.has(n) && seen.size < MAX_NETWORK_NODES) next.add(n);
    };
    for (const f of [...intel.fundingOf(frontier), ...frontier.flatMap((w) => intel.fundedBy(w))]) {
      if (f.classification !== 'DIRECT' && f.classification !== 'LIKELY') continue;
      add({ from: f.funder, to: f.wallet, type: 'FUNDED', confidence: f.confidence, evidence: f.signature }, `F|${f.funder}|${f.wallet}`);
    }
    for (const e of intel.edgesTouching(frontier)) {
      if (e.type === 'CREATOR_ASSOCIATION' || e.type === 'FUNDED') continue;
      const type = e.type === 'TOKEN_TRANSFER' || e.type === 'SHARED_FUNDER' ? e.type : 'BEHAVIOURAL';
      add({ from: e.a, to: e.b, type, confidence: e.confidence, evidence: e.evidence[0] ?? e.id }, e.id);
    }
    for (const c of intel.clustersOf(frontier)) {
      for (const w of frontier) {
        if (!c.members.includes(w)) continue;
        for (const m of c.members) if (m !== w) add({ from: w, to: m, type: 'CLUSTER', confidence: c.confidence, evidence: c.id }, `C|${c.id}|${pairId(w, m)}`);
      }
    }
    for (const n of next) seen.add(n);
    frontier = [...next];
  }
  return [...out.values()];
}

// --- the cycle -----------------------------------------------------------------------------

export async function runIntelCycle(deps: IntelDeps): Promise<IntelCycleReport> {
  const now = deps.now ?? Date.now;
  const at = now();
  const failures: ProviderFailure[] = [];
  const report: IntelCycleReport = {
    at,
    finishedAt: at,
    durationMs: 0,
    source: deps.source,
    skipped: { notSurvivor: 0, notLive: 0, recentlyAnalyzed: 0, overBudget: 0 },
    tokens: [],
    budget: { requests: 0, limit: deps.settings.requestsPerCycle, cycleMaxMs: deps.settings.cycleMaxMs },
    failures,
    health: { state: 'AVAILABLE', reason: '' },
  };
  const finish = (): IntelCycleReport => {
    report.finishedAt = now();
    report.durationMs = report.finishedAt - at;
    return report;
  };
  if (deps.chain === null || deps.intel === null) {
    report.health = { state: 'UNAVAILABLE', reason: 'the history database is not open, so nothing can be analysed or kept' };
    return finish();
  }
  const { chain, intel } = deps;
  const plan = planIntel(deps.tokens(), (m) => intel.lastAnalyzedAt(m), deps.settings, at);
  report.skipped = plan.skipped;
  const deadline = at + deps.settings.cycleMaxMs;
  let spent = 0;

  for (const [i, work] of plan.work.entries()) {
    const remaining = deps.settings.requestsPerCycle - spent;
    const share = Math.max(0, Math.floor(remaining / (plan.work.length - i)));
    const budget = new IntelBudget(share, deadline, now);
    try {
      report.tokens.push(await analyzeToken(work, { ...deps, chain, intel }, budget, failures));
    } catch (error) {
      // A defect in one token's analysis must not end the cycle or the loop.
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`intelligence: ${work.mint.slice(0, 6)}… failed: ${message}`);
      report.tokens.push({
        mint: work.mint,
        tier: work.tier,
        stages: { transactions: 'FAILED', wallets: 'FAILED', graph: 'FAILED', creator: 'FAILED' },
        wallets: { selected: 0, analyzed: 0, reused: 0, failed: 0, notRead: 0 },
        funders: { probed: 0, cached: 0, hops: 0 },
        edges: 0,
        clusters: 0,
        weakPairs: 0,
        wash: 'INSUFFICIENT_DATA',
        activity: 'INSUFFICIENT_DATA',
        attribution: 'UNKNOWN',
        securityEvents: 0,
        network: 'INSUFFICIENT_DATA',
        coverage: 0,
        requests: budget.used,
        truncation: budget.truncation,
        error: message.slice(0, 200),
      });
    }
    spent += budget.used;
    if (now() >= deadline) {
      const left = plan.work.length - i - 1;
      if (left > 0) report.skipped.overBudget += left;
      break;
    }
  }
  report.budget.requests = spent;

  const truncated = report.tokens.some((t) => t.truncation.some((x) => x.startsWith('TIME_BUDGET') || x.startsWith('REQUEST_BUDGET')));
  if (report.tokens.length === 0) {
    report.health = { state: 'AVAILABLE', reason: plan.skipped.notSurvivor + plan.skipped.recentlyAnalyzed > 0 ? 'nothing due: no survivor needs analysis now' : 'no survivors to analyse' };
  } else if (spent > 0 && failures.length >= spent) {
    report.health = { state: 'FAILED', reason: `every provider request failed (${failures[0]?.kind ?? 'unknown'})` };
  } else if (failures.length > 0 || truncated || report.tokens.some((t) => t.error !== null)) {
    report.health = {
      state: 'PARTIAL',
      reason: [failures.length > 0 ? `${failures.length} of ${spent} requests failed` : '', truncated ? 'a budget cut the analysis short' : '', report.tokens.some((t) => t.error) ? 'a token analysis failed' : '']
        .filter(Boolean)
        .join('; '),
    };
  } else {
    report.health = { state: 'AVAILABLE', reason: `${report.tokens.length} token(s), ${spent} requests` };
  }
  return finish();
}

// --- the loop and its status -----------------------------------------------------------------

export interface IntelStatus {
  enabled: boolean;
  running: boolean;
  source: string;
  intervalSec: number;
  cycles: number;
  lastCycle: IntelCycleReport | null;
  lastSuccessAt: number | null;
  health: { state: IntelHealthState; reason: string };
}

let lastCycle: IntelCycleReport | null = null;
let lastSuccessAt: number | null = null;
let cycles = 0;
let running = false;
let loopConfig = { enabled: false, source: '', intervalSec: 300 };

export function intelStatus(now: number = Date.now()): IntelStatus {
  let health: IntelStatus['health'];
  if (!loopConfig.enabled) health = { state: 'UNAVAILABLE', reason: 'deep intelligence is switched off (INTEL_ENABLED=false) or not started' };
  else if (lastCycle === null) health = { state: 'UNAVAILABLE', reason: 'no intelligence cycle has completed yet' };
  else if (lastSuccessAt !== null && now - lastSuccessAt > 3 * loopConfig.intervalSec * 1000 + lastCycle.durationMs + 60_000) {
    health = { state: 'STALE', reason: `no successful cycle since ${new Date(lastSuccessAt).toISOString()}` };
  } else health = lastCycle.health;
  return { enabled: loopConfig.enabled, running, source: loopConfig.source, intervalSec: loopConfig.intervalSec, cycles, lastCycle, lastSuccessAt, health };
}

function note(report: IntelCycleReport): void {
  lastCycle = report;
  cycles += 1;
  if (report.health.state === 'AVAILABLE' || report.health.state === 'PARTIAL') lastSuccessAt = report.finishedAt;
}

/** Runs cycles forever, each `intervalSec` after the previous one finished. */
export function startIntel(deps: IntelDeps, intervalSec: number, onCycle?: (report: IntelCycleReport) => void): { stop: () => void } {
  loopConfig = { enabled: true, source: deps.source, intervalSec };
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    running = true;
    try {
      const result = await runIntelCycle(deps);
      note(result);
      onCycle?.(result);
    } catch (error) {
      log.error(`intelligence cycle failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalSec * 1000);
  };
  // Later than ingestion's first cycle, so there is pool activity to read.
  timer = setTimeout(() => void tick(), 30_000);
  return {
    stop: () => {
      stopped = true;
      loopConfig = { ...loopConfig, enabled: false };
      if (timer) clearTimeout(timer);
    },
  };
}

/** Records a cycle run outside the loop (the CLI), so status reflects it. */
export function noteIntelCycle(report: IntelCycleReport, source: string, intervalSec: number): void {
  loopConfig = { enabled: true, source, intervalSec };
  note(report);
}
