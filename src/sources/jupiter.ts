import { tryGetJson, pool } from '../util/http.ts';
import { toNumber } from '../util/num.ts';
import type { JupiterInfo } from '../types.ts';

const BASE = 'https://lite-api.jup.ag/tokens/v2';

interface RawToken {
  id?: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  isVerified?: boolean;
  tags?: string[];
  organicScore?: number;
  organicScoreLabel?: string;
  holderCount?: number;
  liquidity?: number;
  usdPrice?: number;
  mcap?: number;
  fdv?: number;
  firstPool?: { createdAt?: string | number };
  audit?: {
    mintAuthorityDisabled?: boolean;
    freezeAuthorityDisabled?: boolean;
    topHoldersPercentage?: number;
    devBalancePercentage?: number;
  };
  stats24h?: {
    numBuys?: number;
    numSells?: number;
    numTraders?: number;
    holderChange?: number;
  };
}

function toMillis(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalize(raw: RawToken): JupiterInfo {
  return {
    symbol: raw.symbol ?? null,
    name: raw.name ?? null,
    isVerified: raw.isVerified === true,
    tags: raw.tags ?? [],
    organicScore: toNumber(raw.organicScore),
    organicScoreLabel: raw.organicScoreLabel ?? null,
    holderCount: toNumber(raw.holderCount),
    liquidityUsd: toNumber(raw.liquidity),
    usdPrice: toNumber(raw.usdPrice),
    mcap: toNumber(raw.mcap) ?? toNumber(raw.fdv),
    firstPoolCreatedAt: toMillis(raw.firstPool?.createdAt),
    audit: {
      mintAuthorityDisabled: raw.audit?.mintAuthorityDisabled ?? null,
      freezeAuthorityDisabled: raw.audit?.freezeAuthorityDisabled ?? null,
      topHoldersPercentage: toNumber(raw.audit?.topHoldersPercentage),
      devBalancePercentage: toNumber(raw.audit?.devBalancePercentage),
    },
    stats24h: {
      numBuys: toNumber(raw.stats24h?.numBuys),
      numSells: toNumber(raw.stats24h?.numSells),
      numTraders: toNumber(raw.stats24h?.numTraders),
      holderChange: toNumber(raw.stats24h?.holderChange),
    },
  };
}

/** Mints Jupiter has seen created recently - the primary keyless discovery feed. */
export async function recentTokens(): Promise<{ mint: string; symbol?: string; name?: string }[]> {
  const data = await tryGetJson<RawToken[]>(`${BASE}/recent`);
  if (!Array.isArray(data)) return [];
  return data
    .filter((token) => typeof token.id === 'string')
    .map((token) => ({ mint: token.id as string, symbol: token.symbol, name: token.name }));
}

/** Tokens with the strongest organic (non-wash) activity over an interval. */
export async function topOrganic(interval: '5m' | '1h' | '6h' | '24h' = '1h'): Promise<string[]> {
  const data = await tryGetJson<RawToken[]>(`${BASE}/toporganicscore/${interval}?limit=100`);
  if (!Array.isArray(data)) return [];
  return data.map((token) => token.id).filter((id): id is string => typeof id === 'string');
}

/**
 * Jupiter metadata plus its audit block for a batch of mints. The search
 * endpoint accepts a comma-separated query of up to 100 mints.
 */
export async function infoForMints(mints: string[]): Promise<Map<string, JupiterInfo>> {
  const chunks: string[][] = [];
  for (let i = 0; i < mints.length; i += 100) chunks.push(mints.slice(i, i + 100));

  const byMint = new Map<string, JupiterInfo>();

  await pool(chunks, 2, async (chunk) => {
    const data = await tryGetJson<RawToken[]>(
      `${BASE}/search?query=${encodeURIComponent(chunk.join(','))}`,
    );
    if (!Array.isArray(data)) return;
    for (const raw of data) {
      if (typeof raw.id === 'string') byMint.set(raw.id, normalize(raw));
    }
  });

  return byMint;
}

export async function infoForMint(mint: string): Promise<JupiterInfo | null> {
  const map = await infoForMints([mint]);
  return map.get(mint) ?? null;
}
