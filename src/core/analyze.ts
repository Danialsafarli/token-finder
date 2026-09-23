import { config } from '../config.ts';
import * as dexscreener from '../sources/dexscreener.ts';
import * as jupiter from '../sources/jupiter.ts';
import * as rugcheck from '../sources/rugcheck.ts';
import * as helius from '../sources/helius.ts';
import { pool } from '../util/http.ts';
import { log } from '../util/logger.ts';
import { scoreToken } from './score.ts';
import type {
  JupiterInfo,
  PairMetrics,
  TokenCandidate,
  TokenSnapshot,
  Timeframes,
} from '../types.ts';

const EMPTY_FRAMES: Timeframes = { m5: 0, h1: 0, h6: 0, h24: 0 };

export interface AnalyzeOptions {
  /** Skip the liquidity and age filters; used by the single-token CLI command. */
  includeAll?: boolean;
  /** Cap on how many candidates get the slow safety lookups. */
  deepLimit?: number;
}

function launchTime(pairs: PairMetrics[], jup: JupiterInfo | null): number | null {
  const times = pairs
    .map((pair) => pair.pairCreatedAt)
    .filter((value): value is number => value !== null && value > 0);
  if (jup?.firstPoolCreatedAt) times.push(jup.firstPoolCreatedAt);
  return times.length > 0 ? Math.min(...times) : null;
}

/** Liquidity summed across every pair, which is what an exit actually faces. */
function totalLiquidity(pairs: PairMetrics[], jup: JupiterInfo | null): number {
  const fromPairs = pairs.reduce((sum, pair) => sum + pair.liquidityUsd, 0);
  return fromPairs > 0 ? fromPairs : (jup?.liquidityUsd ?? 0);
}

function totalVolume24h(pairs: PairMetrics[]): number {
  return pairs.reduce((sum, pair) => sum + pair.volume.h24, 0);
}

function sumTxns(pairs: PairMetrics[], frame: 'h1' | 'h24'): { buys: number; sells: number } {
  return pairs.reduce(
    (acc, pair) => ({
      buys: acc.buys + pair.txns[frame].buys,
      sells: acc.sells + pair.txns[frame].sells,
    }),
    { buys: 0, sells: 0 },
  );
}

/**
 * Turns candidate mints into fully scored snapshots.
 *
 * Runs in three passes so the expensive sources only see tokens worth the
 * call: batch market data first, cheap filtering second, per-token safety
 * lookups last.
 */
export async function analyze(
  candidates: TokenCandidate[],
  options: AnalyzeOptions = {},
): Promise<TokenSnapshot[]> {
  if (candidates.length === 0) return [];

  const mints = candidates.map((candidate) => candidate.mint);
  const sourcesByMint = new Map(candidates.map((c) => [c.mint, c.sources]));

  const [pairsByMint, jupByMint] = await Promise.all([
    dexscreener.pairsForMints(mints),
    jupiter.infoForMints(mints),
  ]);

  const now = Date.now();

  interface Draft {
    candidate: TokenCandidate;
    pairs: PairMetrics[];
    jup: JupiterInfo | null;
    liquidityUsd: number;
    ageHours: number | null;
    launchedAt: number | null;
  }

  const drafts: Draft[] = [];

  for (const candidate of candidates) {
    const pairs = pairsByMint.get(candidate.mint) ?? [];
    const jup = jupByMint.get(candidate.mint) ?? null;
    if (pairs.length === 0 && jup === null) continue;

    const liquidityUsd = totalLiquidity(pairs, jup);
    const launchedAt = launchTime(pairs, jup);
    const ageHours = launchedAt === null ? null : (now - launchedAt) / 3_600_000;

    if (!options.includeAll) {
      if (liquidityUsd < config.minLiquidityUsd) continue;
      if (ageHours !== null && ageHours > config.maxAgeHours) continue;
    }

    drafts.push({ candidate, pairs, jup, liquidityUsd, ageHours, launchedAt });
  }

  // Safety lookups are the rate-limit bottleneck, so spend them on the
  // deepest pools first rather than on whatever happened to be discovered.
  drafts.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  const deepLimit = options.deepLimit ?? config.maxAnalyzePerScan;
  const deep = drafts.slice(0, deepLimit);

  log.debug(`analyze: ${candidates.length} candidates -> ${drafts.length} viable -> ${deep.length} deep`);

  return pool(deep, 4, async (draft): Promise<TokenSnapshot> => {
    const { candidate, pairs, jup } = draft;

    const [rug, onchain] = await Promise.all([
      rugcheck.summary(candidate.mint),
      helius.onchainInfo(candidate.mint),
    ]);

    const best = dexscreener.bestPair(pairs);
    const volume24h = totalVolume24h(pairs);
    const txns24 = sumTxns(pairs, 'h24');
    const txns1 = sumTxns(pairs, 'h1');
    const hasSocials = pairs.some((pair) => pair.socials.length > 0 || pair.websites.length > 0);

    const score = scoreToken({
      liquidityUsd: draft.liquidityUsd,
      volume24h,
      ageHours: draft.ageHours,
      priceChange: best?.priceChange ?? EMPTY_FRAMES,
      holders: jup?.holderCount ?? null,
      buys24h: txns24.buys,
      sells24h: txns24.sells,
      buys1h: txns1.buys,
      sells1h: txns1.sells,
      jupiter: jup,
      rugcheck: rug,
      onchain,
      hasSocials,
      minLiquidityUsd: config.minLiquidityUsd,
    });

    const buyTotal = txns24.buys + txns24.sells;

    return {
      mint: candidate.mint,
      symbol: candidate.symbol ?? best?.baseSymbol ?? jup?.symbol ?? '?',
      name: candidate.name ?? best?.baseName ?? jup?.name ?? '',
      sources: sourcesByMint.get(candidate.mint) ?? [],
      at: now,
      launchedAt: draft.launchedAt,
      ageHours: draft.ageHours,
      priceUsd: best?.priceUsd ?? jup?.usdPrice ?? null,
      liquidityUsd: draft.liquidityUsd,
      volume24h,
      marketCap: best?.marketCap ?? jup?.mcap ?? null,
      fdv: best?.fdv ?? null,
      holders: jup?.holderCount ?? null,
      priceChange: best?.priceChange ?? EMPTY_FRAMES,
      buyRatio24h: buyTotal > 0 ? txns24.buys / buyTotal : null,
      pair: best,
      jupiter: jup,
      rugcheck: rug,
      onchain,
      score,
    };
  });
}

