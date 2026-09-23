import { tryGetJson } from '../util/http.ts';
import { TtlCache } from '../util/cache.ts';
import { toNumber } from '../util/num.ts';
import type { RugcheckInfo } from '../types.ts';

const BASE = 'https://api.rugcheck.xyz/v1';

/** Risk facts about a mint barely change minute to minute, so cache hard. */
const cache = new TtlCache<RugcheckInfo | null>(20 * 60_000);

interface RawSummary {
  score?: number;
  score_normalised?: number;
  risks?: { name?: string; level?: string; description?: string; score?: number }[];
}

/**
 * RugCheck's summary report: authority state, LP status, holder concentration
 * and a handful of named risks. Public and unauthenticated, but tightly rate
 * limited, so this is the slowest source in a scan.
 */
export async function summary(mint: string): Promise<RugcheckInfo | null> {
  return cache.wrap(mint, async () => {
    const data = await tryGetJson<RawSummary>(`${BASE}/tokens/${mint}/report/summary`, {
      retries: 1,
      timeoutMs: 10_000,
      nullOn: [400, 404, 422],
    });
    if (!data) return null;

    return {
      score: toNumber(data.score),
      scoreNormalised: toNumber(data.score_normalised),
      risks: (data.risks ?? []).map((risk) => ({
        name: risk.name ?? 'unknown',
        level: (risk.level ?? 'info').toLowerCase(),
        description: risk.description ?? '',
        score: toNumber(risk.score) ?? 0,
      })),
    };
  });
}
