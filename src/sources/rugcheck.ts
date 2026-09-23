import { getOutcome, type ProviderResult } from '../util/http.ts';
import { TtlCache } from '../util/cache.ts';
import { ValidationReport, validNumber, validString } from '../core/validate.ts';
import type { RugcheckInfo } from '../types.ts';

const BASE = 'https://api.rugcheck.xyz/v1';

/** Risk facts about a mint barely change minute to minute, so cache hard. */
const cache = new TtlCache<RugcheckInfo | null>(20 * 60_000);

interface RawSummary {
  score?: unknown;
  score_normalised?: unknown;
  risks?: unknown;
}

/** RugCheck's documented severity ladder. Anything else is not understood. */
const RISK_LEVELS = new Set(['danger', 'warn', 'info', 'good']);

/**
 * RugCheck's summary report: authority state, LP status, holder concentration
 * and a handful of named risks. Public and unauthenticated, but tightly rate
 * limited, so this is the slowest source in a scan.
 */
export async function summary(mint: string): Promise<ProviderResult<RugcheckInfo>> {
  // A cached answer is a real answer. Failures are deliberately NOT cached, so
  // a transient outage does not lock the token out of safety data for 20
  // minutes - the next scan retries it.
  const hit = cache.get(mint);
  if (hit !== undefined) return { data: hit, failure: null };

  const outcome = await getOutcome<RawSummary>('rugcheck', `${BASE}/tokens/${mint}/report/summary`, {
    retries: 1,
    timeoutMs: 10_000,
    nullOn: [400, 404, 422],
  });

  if (outcome.failure !== null) return { data: null, failure: outcome.failure };

  // `null` here means RugCheck answered and had nothing on this mint, which is
  // a fact worth caching - unlike a failure.
  const info = outcome.data === null ? null : normalizeSummary(outcome.data);
  cache.set(mint, info);
  return { data: info, failure: null };
}

/**
 * Pure boundary validation for a RugCheck summary, split out so the regression
 * corpus can exercise it without a network round trip.
 */
export function normalizeSummary(data: RawSummary): RugcheckInfo {
  {
    const report = new ValidationReport('rugcheck');
    const rawRisks = Array.isArray(data.risks) ? (data.risks as Record<string, unknown>[]) : [];

    const risks = rawRisks.flatMap((risk, index) => {
      const name = validString(report, `risks[${index}].name`, risk.name, { maxLength: 120 });
      if (name === null) return [];

      const rawLevel = validString(report, `risks[${index}].level`, risk.level, { maxLength: 20 });
      const level = rawLevel === null ? 'info' : rawLevel.toLowerCase();
      if (!RISK_LEVELS.has(level)) {
        // An unrecognised severity is not quietly downgraded to info: that
        // would turn an unknown-but-possibly-critical finding into noise.
        report.reject(`risks[${index}].level`, 'unrecognised severity', risk.level);
        return [];
      }

      return [
        {
          name,
          level,
          description:
            validString(report, `risks[${index}].description`, risk.description, { maxLength: 300 }) ?? '',
          score: validNumber(report, `risks[${index}].score`, risk.score, { min: 0 }) ?? 0,
        },
      ];
    });

    return {
      score: validNumber(report, 'score', data.score, { min: 0 }),
      scoreNormalised: validNumber(report, 'score_normalised', data.score_normalised, { min: 0, max: 100 }),
      risks,
      issues: report.issues,
    };
  }
}
