import { getJson, tryGetJson, pool } from '../util/http.ts';
import { toNumber, numberOr } from '../util/num.ts';
import type { PairMetrics, TimeframeKey } from '../types.ts';

const BASE = 'https://api.dexscreener.com';
const CHAIN = 'solana';
const TIMEFRAMES: TimeframeKey[] = ['m5', 'h1', 'h6', 'h24'];

interface RawProfile {
  chainId?: string;
  tokenAddress?: string;
  icon?: string;
  description?: string;
  links?: { type?: string; label?: string; url?: string }[];
}

interface RawPair {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  txns?: Record<string, { buys?: number; sells?: number }>;
  info?: {
    imageUrl?: string;
    websites?: { url?: string }[];
    socials?: { type?: string; url?: string }[];
  };
  boosts?: { active?: number };
}

function frames(source: Record<string, number> | undefined): Record<TimeframeKey, number> {
  const out = {} as Record<TimeframeKey, number>;
  for (const key of TIMEFRAMES) out[key] = numberOr(source?.[key], 0);
  return out;
}

function txns(source: RawPair['txns']): PairMetrics['txns'] {
  const out = {} as PairMetrics['txns'];
  for (const key of TIMEFRAMES) {
    out[key] = {
      buys: numberOr(source?.[key]?.buys, 0),
      sells: numberOr(source?.[key]?.sells, 0),
    };
  }
  return out;
}

export function normalizePair(raw: RawPair): PairMetrics {
  return {
    pairAddress: raw.pairAddress ?? '',
    dexId: raw.dexId ?? 'unknown',
    baseSymbol: raw.baseToken?.symbol ?? '?',
    baseName: raw.baseToken?.name ?? '',
    url: raw.url ?? '',
    quoteSymbol: raw.quoteToken?.symbol ?? '?',
    priceUsd: toNumber(raw.priceUsd),
    liquidityUsd: numberOr(raw.liquidity?.usd, 0),
    fdv: toNumber(raw.fdv),
    marketCap: toNumber(raw.marketCap),
    pairCreatedAt: toNumber(raw.pairCreatedAt),
    volume: frames(raw.volume),
    priceChange: frames(raw.priceChange),
    txns: txns(raw.txns),
    imageUrl: raw.info?.imageUrl,
    websites: (raw.info?.websites ?? []).map((w) => w.url).filter((u): u is string => Boolean(u)),
    socials: (raw.info?.socials ?? [])
      .filter((s) => s.url)
      .map((s) => ({ type: s.type ?? 'link', url: s.url as string })),
    boosts: numberOr(raw.boosts?.active, 0),
  };
}

/** Newly created token profiles - DexScreener's closest thing to a new-listing feed. */
export async function latestProfiles(): Promise<{ mint: string; description?: string }[]> {
  const data = await tryGetJson<RawProfile[]>(`${BASE}/token-profiles/latest/v1`);
  if (!Array.isArray(data)) return [];
  return data
    .filter((p) => p.chainId === CHAIN && typeof p.tokenAddress === 'string')
    .map((p) => ({ mint: p.tokenAddress as string, description: p.description }));
}

/** Tokens whose owners just paid for promotion - noisy, but a real liveness signal. */
export async function latestBoosts(): Promise<string[]> {
  const urls = [`${BASE}/token-boosts/latest/v1`, `${BASE}/token-boosts/top/v1`];
  const results = await Promise.all(urls.map((url) => tryGetJson<RawProfile[]>(url)));
  const mints = new Set<string>();
  for (const list of results) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item.chainId === CHAIN && typeof item.tokenAddress === 'string') mints.add(item.tokenAddress);
    }
  }
  return [...mints];
}

/**
 * Every pair for the given mints. DexScreener accepts up to 30 comma-separated
 * addresses per call, so mints are chunked and the chunks pooled.
 */
export async function pairsForMints(mints: string[]): Promise<Map<string, PairMetrics[]>> {
  const chunks: string[][] = [];
  for (let i = 0; i < mints.length; i += 30) chunks.push(mints.slice(i, i + 30));

  const byMint = new Map<string, PairMetrics[]>();

  await pool(chunks, 3, async (chunk) => {
    const data = await tryGetJson<{ pairs?: RawPair[] } | RawPair[]>(
      `${BASE}/latest/dex/tokens/${chunk.join(',')}`,
    );
    const pairs = Array.isArray(data) ? data : (data?.pairs ?? []);
    for (const raw of pairs ?? []) {
      if (raw.chainId !== CHAIN) continue;
      const mint = raw.baseToken?.address;
      if (!mint) continue;
      const list = byMint.get(mint) ?? [];
      list.push(normalizePair(raw));
      byMint.set(mint, list);
    }
  });

  return byMint;
}

/** Picks the pair with the deepest liquidity; that is the one price should track. */
export function bestPair(pairs: PairMetrics[]): PairMetrics | null {
  if (pairs.length === 0) return null;
  return pairs.reduce((best, pair) => (pair.liquidityUsd > best.liquidityUsd ? pair : best));
}

/** Free-text search, used by the CLI analyze command when given a symbol. */
export async function search(query: string): Promise<{ mint: string; symbol: string }[]> {
  const data = await getJson<{ pairs?: RawPair[] }>(
    `${BASE}/latest/dex/search?q=${encodeURIComponent(query)}`,
  );
  const seen = new Map<string, string>();
  for (const raw of data?.pairs ?? []) {
    if (raw.chainId !== CHAIN) continue;
    const mint = raw.baseToken?.address;
    if (mint && !seen.has(mint)) seen.set(mint, raw.baseToken?.symbol ?? '?');
  }
  return [...seen].map(([mint, symbol]) => ({ mint, symbol }));
}
