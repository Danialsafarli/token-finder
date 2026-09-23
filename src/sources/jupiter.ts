import { tryGetJson, pool } from '../util/http.ts';
import {
  ValidationReport,
  validBoolean,
  validCount,
  validNumber,
  validPercent,
  validString,
  validTimestampMs,
  validUsd,
} from '../core/validate.ts';
import type { JupiterInfo } from '../types.ts';

const BASE = 'https://lite-api.jup.ag/tokens/v2';

interface RawToken {
  id?: string;
  name?: string;
  symbol?: string;
  decimals?: unknown;
  isVerified?: unknown;
  tags?: unknown;
  organicScore?: unknown;
  organicScoreLabel?: unknown;
  holderCount?: unknown;
  liquidity?: unknown;
  usdPrice?: unknown;
  mcap?: unknown;
  fdv?: unknown;
  firstPool?: { createdAt?: unknown };
  audit?: {
    mintAuthorityDisabled?: unknown;
    freezeAuthorityDisabled?: unknown;
    topHoldersPercentage?: unknown;
    devBalancePercentage?: unknown;
  };
  stats24h?: {
    numBuys?: unknown;
    numSells?: unknown;
    numTraders?: unknown;
    holderChange?: unknown;
  };
}

/**
 * Validates Jupiter's token record at the boundary.
 *
 * The audit booleans get {@link validBoolean}, which refuses anything that is
 * not a real boolean. These are safety fields: a provider sending "false" as a
 * string, or 0, is a provider we have stopped understanding, and guessing there
 * is how a live mint authority silently becomes a revoked one.
 */
export function normalizeToken(raw: RawToken): JupiterInfo {
  const report = new ValidationReport('jupiter');

  return {
    symbol: validString(report, 'symbol', raw.symbol, { maxLength: 40 }),
    name: validString(report, 'name', raw.name, { maxLength: 80 }),
    isVerified: validBoolean(report, 'isVerified', raw.isVerified) === true,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
    organicScore: validNumber(report, 'organicScore', raw.organicScore, { min: 0, max: 100 }),
    organicScoreLabel: validString(report, 'organicScoreLabel', raw.organicScoreLabel, { maxLength: 40 }),
    holderCount: validCount(report, 'holderCount', raw.holderCount),
    liquidityUsd: validUsd(report, 'liquidity', raw.liquidity),
    usdPrice: validUsd(report, 'usdPrice', raw.usdPrice),
    mcap: validUsd(report, 'mcap', raw.mcap) ?? validUsd(report, 'fdv', raw.fdv),
    firstPoolCreatedAt: validTimestampMs(report, 'firstPool.createdAt', raw.firstPool?.createdAt),
    audit: {
      mintAuthorityDisabled: validBoolean(report, 'audit.mintAuthorityDisabled', raw.audit?.mintAuthorityDisabled),
      freezeAuthorityDisabled: validBoolean(report, 'audit.freezeAuthorityDisabled', raw.audit?.freezeAuthorityDisabled),
      topHoldersPercentage: validPercent(report, 'audit.topHoldersPercentage', raw.audit?.topHoldersPercentage),
      devBalancePercentage: validPercent(report, 'audit.devBalancePercentage', raw.audit?.devBalancePercentage),
    },
    stats24h: {
      numBuys: validCount(report, 'stats24h.numBuys', raw.stats24h?.numBuys),
      numSells: validCount(report, 'stats24h.numSells', raw.stats24h?.numSells),
      numTraders: validCount(report, 'stats24h.numTraders', raw.stats24h?.numTraders),
      // Holder count can genuinely fall, so this one is signed.
      holderChange: validNumber(report, 'stats24h.holderChange', raw.stats24h?.holderChange),
    },
    issues: report.issues,
  };
}

/** Mints Jupiter has seen created recently - the primary keyless discovery feed. */
export async function recentTokens(): Promise<{ mint: string; symbol?: string; name?: string }[]> {
  const data = await tryGetJson<RawToken[]>(`${BASE}/recent`);
  if (!Array.isArray(data)) return [];
  return data
    .filter((token) => typeof token.id === 'string')
    .map((token) => ({
      mint: token.id as string,
      symbol: typeof token.symbol === 'string' ? token.symbol : undefined,
      name: typeof token.name === 'string' ? token.name : undefined,
    }));
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
      if (typeof raw.id === 'string') byMint.set(raw.id, normalizeToken(raw));
    }
  });

  return byMint;
}

export async function infoForMint(mint: string): Promise<JupiterInfo | null> {
  const map = await infoForMints([mint]);
  return map.get(mint) ?? null;
}
