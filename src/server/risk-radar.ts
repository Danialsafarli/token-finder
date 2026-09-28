/**
 * The hand-off to Solana Risk Radar.
 *
 * Two products, kept apart on purpose:
 *
 * - **Token Finder** discovers and ranks: integrity, opportunity, activity
 *   intelligence, and a verdict built from them.
 * - **Solana Risk Radar** (a separate app) runs a deep, deterministic risk
 *   analysis of one token and reports its own risk score.
 *
 * Token Finder links to Risk Radar with the mint in the URL; it does not
 * embed it, call it, or fold its score into any number of its own. The URL
 * carries the address as `address` - the name Risk Radar's own analysis
 * endpoint uses - and `from=token-finder` so Risk Radar can tell where the
 * visitor came from.
 */

import { safeHttpUrl } from './security.ts';

/** A Solana address: base58, 32-44 characters. */
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface RiskRadarLink {
  url: string;
  mint: string;
}

/** The Risk Radar URL for one mint, or null when the mint or the configured base is not safe to link. */
export function riskRadarLink(mint: string, base: string | null): RiskRadarLink | null {
  if (!MINT.test(mint) || base === null) return null;
  const root = safeHttpUrl(base, { httpsOnly: true });
  if (root === null) return null;
  const url = new URL(root);
  url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  url.search = '';
  url.hash = '';
  url.searchParams.set('address', mint);
  url.searchParams.set('from', 'token-finder');
  return { url: url.href, mint };
}
