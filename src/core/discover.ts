import * as dexscreener from '../sources/dexscreener.ts';
import * as jupiter from '../sources/jupiter.ts';
import * as birdeye from '../sources/birdeye.ts';
import { log } from '../util/logger.ts';
import type { TokenCandidate } from '../types.ts';

interface Feed {
  name: string;
  run: () => Promise<{ mint: string; symbol?: string; name?: string }[]>;
}

/**
 * Discovery feeds, cheapest and most reliable first. Each one is optional:
 * a feed that errors or needs a missing key contributes nothing rather than
 * failing the scan.
 */
const FEEDS: Feed[] = [
  {
    name: 'jupiter:recent',
    run: () => jupiter.recentTokens(),
  },
  {
    name: 'jupiter:organic',
    run: async () => (await jupiter.topOrganic('1h')).map((mint) => ({ mint })),
  },
  {
    name: 'dexscreener:profiles',
    run: async () => (await dexscreener.latestProfiles()).map(({ mint }) => ({ mint })),
  },
  {
    name: 'dexscreener:boosts',
    run: async () => (await dexscreener.latestBoosts()).map((mint) => ({ mint })),
  },
  {
    name: 'birdeye:new',
    run: () => birdeye.newListings(50),
  },
];

/**
 * Collects candidate mints from every feed and merges duplicates, keeping
 * track of which feeds surfaced each one. A mint seen by several independent
 * feeds is a stronger signal than one seen by a single feed.
 */
export async function discover(): Promise<TokenCandidate[]> {
  const settled = await Promise.allSettled(
    FEEDS.map(async (feed) => ({ feed: feed.name, items: await feed.run() })),
  );

  const merged = new Map<string, TokenCandidate>();

  for (const [index, result] of settled.entries()) {
    const feedName = FEEDS[index]?.name ?? 'unknown';

    if (result.status === 'rejected') {
      log.warn(`feed ${feedName} failed:`, result.reason instanceof Error ? result.reason.message : result.reason);
      continue;
    }

    const { items } = result.value;
    log.debug(`feed ${feedName}: ${items.length} candidates`);

    for (const item of items) {
      if (!item.mint) continue;
      const existing = merged.get(item.mint);
      if (existing) {
        if (!existing.sources.includes(feedName)) existing.sources.push(feedName);
        existing.symbol ??= item.symbol;
        existing.name ??= item.name;
      } else {
        merged.set(item.mint, {
          mint: item.mint,
          sources: [feedName],
          symbol: item.symbol,
          name: item.name,
        });
      }
    }
  }

  return [...merged.values()];
}
