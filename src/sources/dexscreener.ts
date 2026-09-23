import { getJson, tryGetJson, pool } from '../util/http.ts';
import {
  ValidationReport,
  validCount,
  validPercent,
  validPriceChangePct,
  validString,
  validTimestampMs,
  validUsd,
} from '../core/validate.ts';
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
  // Typed as unknown on purpose: these are the fields a provider is most
  // likely to change shape on, and the validators below are what decides
  // whether any of it is usable.
  priceUsd?: unknown;
  liquidity?: { usd?: unknown };
  fdv?: unknown;
  marketCap?: unknown;
  pairCreatedAt?: unknown;
  volume?: Record<string, unknown>;
  priceChange?: Record<string, unknown>;
  txns?: Record<string, { buys?: unknown; sells?: unknown }>;
  info?: {
    imageUrl?: string;
    websites?: { url?: string }[];
    socials?: { type?: string; url?: string }[];
  };
  boosts?: { active?: unknown };
}

/**
 * Volume frames. A rejected frame stays null rather than becoming 0: a volume
 * we could not validate is not a pool that traded nothing.
 */
function volumeFrames(
  report: ValidationReport,
  source: Record<string, unknown> | undefined,
): Record<TimeframeKey, number | null> {
  const out = {} as Record<TimeframeKey, number | null>;
  for (const key of TIMEFRAMES) out[key] = validUsd(report, `volume.${key}`, source?.[key]);
  return out;
}

function changeFrames(
  report: ValidationReport,
  source: Record<string, unknown> | undefined,
): Record<TimeframeKey, number | null> {
  const out = {} as Record<TimeframeKey, number | null>;
  for (const key of TIMEFRAMES) {
    out[key] = validPriceChangePct(report, `priceChange.${key}`, source?.[key]);
  }
  return out;
}

function txns(report: ValidationReport, source: RawPair['txns']): PairMetrics['txns'] {
  const out = {} as PairMetrics['txns'];
  for (const key of TIMEFRAMES) {
    out[key] = {
      buys: validCount(report, `txns.${key}.buys`, source?.[key]?.buys),
      sells: validCount(report, `txns.${key}.sells`, source?.[key]?.sells),
    };
  }
  return out;
}

/**
 * Validates one pair at the boundary. Every numeric field that reaches scoring
 * is range-checked here; impossible values (negative liquidity, a pool created
 * before Solana existed, a price that is NaN) are rejected rather than coerced.
 */
export function normalizePair(raw: RawPair): PairMetrics {
  const report = new ValidationReport('dexscreener');

  return {
    pairAddress: validString(report, 'pairAddress', raw.pairAddress) ?? '',
    dexId: validString(report, 'dexId', raw.dexId) ?? 'unknown',
    baseSymbol: validString(report, 'baseToken.symbol', raw.baseToken?.symbol, { maxLength: 40 }) ?? '?',
    baseName: validString(report, 'baseToken.name', raw.baseToken?.name, { maxLength: 80 }) ?? '',
    url: validString(report, 'url', raw.url, { maxLength: 300 }) ?? '',
    quoteSymbol: validString(report, 'quoteToken.symbol', raw.quoteToken?.symbol, { maxLength: 40 }) ?? '?',
    priceUsd: validUsd(report, 'priceUsd', raw.priceUsd),
    liquidityUsd: validUsd(report, 'liquidity.usd', raw.liquidity?.usd),
    fdv: validUsd(report, 'fdv', raw.fdv),
    marketCap: validUsd(report, 'marketCap', raw.marketCap),
    pairCreatedAt: validTimestampMs(report, 'pairCreatedAt', raw.pairCreatedAt),
    volume: volumeFrames(report, raw.volume),
    priceChange: changeFrames(report, raw.priceChange),
    txns: txns(report, raw.txns),
    imageUrl: validString(report, 'info.imageUrl', raw.info?.imageUrl, { maxLength: 300 }) ?? undefined,
    websites: (raw.info?.websites ?? [])
      .map((w) => validString(report, 'info.websites[].url', w.url, { maxLength: 300 }))
      .filter((u): u is string => u !== null),
    socials: (raw.info?.socials ?? [])
      .map((s) => ({
        type: validString(report, 'info.socials[].type', s.type, { maxLength: 40 }) ?? 'link',
        url: validString(report, 'info.socials[].url', s.url, { maxLength: 300 }),
      }))
      .filter((s): s is { type: string; url: string } => s.url !== null),
    boosts: validCount(report, 'boosts.active', raw.boosts?.active) ?? 0,
    issues: report.issues,
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

/**
 * Picks the pair with the deepest *validated* liquidity; that is the one price
 * should track. Pairs whose liquidity failed validation cannot win, because an
 * unusable depth reading must not decide which price we believe.
 */
export function bestPair(pairs: PairMetrics[]): PairMetrics | null {
  if (pairs.length === 0) return null;
  return pairs.reduce((best, pair) =>
    (pair.liquidityUsd ?? -1) > (best.liquidityUsd ?? -1) ? pair : best,
  );
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
