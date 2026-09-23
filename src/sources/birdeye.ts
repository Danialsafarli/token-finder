import { config, hasBirdeye } from '../config.ts';
import { tryGetJson } from '../util/http.ts';
import { toNumber } from '../util/num.ts';

const BASE = 'https://public-api.birdeye.so';

const headers = (): Record<string, string> => ({
  'X-API-KEY': config.birdeyeApiKey ?? '',
  'x-chain': 'solana',
});

interface NewListingResponse {
  data?: {
    items?: { address?: string; symbol?: string; name?: string; liquidityAddedAt?: string }[];
  };
}

interface OverviewResponse {
  data?: {
    address?: string;
    symbol?: string;
    name?: string;
    holder?: number;
    liquidity?: number;
    v24hUSD?: number;
    mc?: number;
    price?: number;
    priceChange24hPercent?: number;
  };
}

export interface BirdeyeOverview {
  holders: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
  marketCap: number | null;
  priceUsd: number | null;
  priceChange24h: number | null;
}

/** Birdeye's new-listing feed. Empty array when no key is configured. */
export async function newListings(limit = 50): Promise<{ mint: string; symbol?: string }[]> {
  if (!hasBirdeye()) return [];

  const data = await tryGetJson<NewListingResponse>(
    `${BASE}/defi/v2/tokens/new_listing?limit=${limit}&meme_platform_enabled=true`,
    { headers: headers(), retries: 1 },
  );

  return (data?.data?.items ?? [])
    .filter((item) => typeof item.address === 'string')
    .map((item) => ({ mint: item.address as string, symbol: item.symbol }));
}

export async function overview(mint: string): Promise<BirdeyeOverview | null> {
  if (!hasBirdeye()) return null;

  const data = await tryGetJson<OverviewResponse>(
    `${BASE}/defi/token_overview?address=${mint}`,
    { headers: headers(), retries: 1 },
  );
  const item = data?.data;
  if (!item) return null;

  return {
    holders: toNumber(item.holder),
    liquidityUsd: toNumber(item.liquidity),
    volume24h: toNumber(item.v24hUSD),
    marketCap: toNumber(item.mc),
    priceUsd: toNumber(item.price),
    priceChange24h: toNumber(item.priceChange24hPercent),
  };
}
