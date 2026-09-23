import { config, hasHelius } from '../config.ts';
import { tryGetJson } from '../util/http.ts';
import { TtlCache } from '../util/cache.ts';
import { toNumber } from '../util/num.ts';
import type { OnChainInfo } from '../types.ts';

const cache = new TtlCache<OnChainInfo | null>(10 * 60_000);

const rpcUrl = (): string => `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;

interface RpcResponse<T> {
  result?: T;
  error?: { message?: string };
}

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  const data = await tryGetJson<RpcResponse<T>>(rpcUrl(), {
    method: 'POST',
    body: { jsonrpc: '2.0', id: method, method, params },
    retries: 1,
  });
  return data?.result ?? null;
}

interface MintAccount {
  value?: {
    data?: {
      parsed?: {
        info?: {
          mintAuthority?: string | null;
          freezeAuthority?: string | null;
          decimals?: number;
          supply?: string;
        };
      };
    };
  };
}

interface LargestAccounts {
  value?: { address?: string; amount?: string; uiAmount?: number }[];
}

/**
 * Authority state and holder concentration straight from the chain.
 * Returns null when no Helius key is configured - every caller treats the
 * on-chain block as optional enrichment.
 *
 * Caveat: the largest accounts include AMM pool vaults, so top10Share is an
 * upper bound on genuine holder concentration, not a clean insider metric.
 */
export async function onchainInfo(mint: string): Promise<OnChainInfo | null> {
  if (!hasHelius()) return null;

  return cache.wrap(mint, async () => {
    const [account, largest] = await Promise.all([
      rpc<MintAccount>('getAccountInfo', [mint, { encoding: 'jsonParsed' }]),
      rpc<LargestAccounts>('getTokenLargestAccounts', [mint]),
    ]);

    const info = account?.value?.data?.parsed?.info;
    if (!info && !largest) return null;

    const decimals = toNumber(info?.decimals);
    const rawSupply = toNumber(info?.supply);
    const supply =
      rawSupply !== null && decimals !== null ? rawSupply / 10 ** decimals : rawSupply;

    const holders = (largest?.value ?? [])
      .map((entry) => toNumber(entry.uiAmount) ?? 0)
      .sort((a, b) => b - a);

    const top10 = holders.slice(0, 10).reduce((sum, amount) => sum + amount, 0);
    const usableSupply = supply !== null && supply > 0 ? supply : null;

    return {
      mintAuthority: info?.mintAuthority ?? null,
      freezeAuthority: info?.freezeAuthority ?? null,
      decimals,
      supply,
      top10Share: usableSupply ? top10 / usableSupply : null,
      largestHolderShare: usableSupply && holders[0] !== undefined ? holders[0] / usableSupply : null,
    };
  });
}
