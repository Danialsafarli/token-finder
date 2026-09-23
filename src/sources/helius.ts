import { config, hasHelius } from '../config.ts';
import { tryGetJson } from '../util/http.ts';
import { TtlCache } from '../util/cache.ts';
import { ValidationReport, validMint, validNumber } from '../core/validate.ts';
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
          mintAuthority?: unknown;
          freezeAuthority?: unknown;
          decimals?: unknown;
          supply?: unknown;
        };
      };
    };
  };
}

interface LargestAccounts {
  value?: { address?: unknown; amount?: unknown; uiAmount?: unknown }[];
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

    const report = new ValidationReport('helius');

    // An authority is either a base58 address (live) or null (revoked). A
    // non-address value is rejected, not read as "revoked" - that misreading
    // turns an unparseable response into a clean bill of health.
    const mintAuthority =
      info?.mintAuthority === null || info?.mintAuthority === undefined
        ? null
        : validMint(report, 'mintAuthority', info.mintAuthority);
    const freezeAuthority =
      info?.freezeAuthority === null || info?.freezeAuthority === undefined
        ? null
        : validMint(report, 'freezeAuthority', info.freezeAuthority);

    // Whether the response actually asserted an authority field, as opposed to
    // omitting it. `null` from the chain means revoked; absent means unknown.
    const mintAuthorityStated = info !== undefined && 'mintAuthority' in info;
    const freezeAuthorityStated = info !== undefined && 'freezeAuthority' in info;

    const decimals = validNumber(report, 'decimals', info?.decimals, { min: 0, max: 18, integer: true });
    const rawSupply = validNumber(report, 'supply', info?.supply, { min: 0, fromString: true });
    const supply =
      rawSupply !== null && decimals !== null ? rawSupply / 10 ** decimals : rawSupply;

    const holders = (largest?.value ?? [])
      .map((entry, index) => validNumber(report, `largestAccounts[${index}].uiAmount`, entry.uiAmount, { min: 0 }))
      .filter((amount): amount is number => amount !== null)
      .sort((a, b) => b - a);

    const top10 = holders.slice(0, 10).reduce((sum, amount) => sum + amount, 0);
    const usableSupply = supply !== null && supply > 0 ? supply : null;

    const rawTop10Share = usableSupply ? top10 / usableSupply : null;
    // A share above 1 means the supply reading and the balances disagree, so
    // neither can be trusted. Impossible, therefore rejected rather than capped.
    const top10Share =
      rawTop10Share !== null && rawTop10Share > 1.000001
        ? report.reject('top10Share', 'holder balances exceed total supply', rawTop10Share)
        : rawTop10Share;

    return {
      mintAuthority,
      freezeAuthority,
      mintAuthorityStated,
      freezeAuthorityStated,
      decimals,
      supply,
      top10Share,
      largestHolderShare:
        top10Share !== null && usableSupply && holders[0] !== undefined
          ? holders[0] / usableSupply
          : null,
      issues: report.issues,
    };
  });
}
