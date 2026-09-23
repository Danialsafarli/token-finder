import { config, hasHelius } from '../config.ts';
import { getOutcome, type ProviderResult } from '../util/http.ts';
import { TtlCache } from '../util/cache.ts';
import { notConfigured, type ProviderFailure } from '../util/failure.ts';
import { ValidationReport, validMint, validNumber } from '../core/validate.ts';
import type { OnChainInfo } from '../types.ts';

const cache = new TtlCache<OnChainInfo | null>(10 * 60_000);

const rpcUrl = (): string => `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;

interface RpcResponse<T> {
  result?: T;
  error?: { message?: string };
}

async function rpc<T>(method: string, params: unknown[]): Promise<ProviderResult<T>> {
  const outcome = await getOutcome<RpcResponse<T>>('helius', rpcUrl(), {
    method: 'POST',
    body: { jsonrpc: '2.0', id: method, method, params },
    retries: 1,
  });

  if (outcome.failure !== null) return { data: null, failure: outcome.failure };

  // A JSON-RPC error body is a 200 response carrying a refusal, so it has to be
  // recognised here rather than by the HTTP layer.
  const rpcError = outcome.data?.error;
  if (rpcError !== undefined) {
    return {
      data: null,
      failure: {
        provider: 'helius',
        kind: 'INVALID_RESPONSE',
        message: (rpcError.message ?? 'rpc error').slice(0, 200),
        at: Date.now(),
        retryable: false,
      },
    };
  }

  return { data: outcome.data?.result ?? null, failure: null };
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
export async function onchainInfo(mint: string): Promise<ProviderResult<OnChainInfo>> {
  // Not configured is a distinct, permanent condition: there is nothing to
  // retry and nothing wrong, but the signal is UNAVAILABLE, not UNKNOWN.
  if (!hasHelius()) return { data: null, failure: notConfigured('helius') };

  const hit = cache.get(mint);
  if (hit !== undefined) return { data: hit, failure: null };

  const result = await (async (): Promise<ProviderResult<OnChainInfo>> => {
    // The two RPC calls are independent: a failure of one must not discard the
    // other's answer, so neither can reject the pair.
    const [accountResult, largestResult] = await Promise.all([
      rpc<MintAccount>('getAccountInfo', [mint, { encoding: 'jsonParsed' }]),
      rpc<LargestAccounts>('getTokenLargestAccounts', [mint]),
    ]);

    const failure: ProviderFailure | null = accountResult.failure ?? largestResult.failure;
    const account = accountResult.data;
    const largest = largestResult.data;

    const info = account?.value?.data?.parsed?.info;
    if (!info && !largest) return { data: null, failure };

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
      data: {
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
      },
      // A partial answer is still an answer; the failure is reported alongside
      // it so the gap is attributable.
      failure,
    };
  })();

  if (result.data !== null) cache.set(mint, result.data);
  return result;
}
