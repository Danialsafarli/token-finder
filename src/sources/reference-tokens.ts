/**
 * Established Solana tokens used as *supplied evidence* for impersonation
 * screening.
 *
 * Why this file exists: the model is never asked "is this a real token?" - that
 * would rely on model world-knowledge we cannot verify or date. Instead we hand
 * it a concrete list and ask only whether the candidate's naming mimics
 * something on that list. Everything the judgement rests on is therefore in the
 * request, auditable, and versioned here.
 *
 * VERIFY BEFORE RELYING ON THIS LIST. These mints are a starter set transcribed
 * from common knowledge, not fetched from an authoritative registry. A wrong
 * mint would let the genuine token match its own entry by symbol while failing
 * the mint check, producing a false impersonation flag. Because the flag is
 * advisory and never scored, the blast radius is a misleading badge rather than
 * a ranking error - but the list should still be checked against a registry,
 * and ideally replaced by Jupiter's verified-token feed (see ROADMAP Phase 1).
 */

export interface ReferenceToken {
  symbol: string;
  name: string;
  mint: string;
}

/** Bump when entries change so stored assessments stay traceable to their input. */
export const REFERENCE_LIST_ID = 'starter-2026-09-23';

export const REFERENCE_TOKENS: readonly ReferenceToken[] = [
  { symbol: 'SOL', name: 'Wrapped SOL', mint: 'So11111111111111111111111111111111111111112' },
  { symbol: 'USDC', name: 'USD Coin', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { symbol: 'USDT', name: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' },
  { symbol: 'JUP', name: 'Jupiter', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
  { symbol: 'BONK', name: 'Bonk', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  { symbol: 'JTO', name: 'Jito', mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL' },
  { symbol: 'WIF', name: 'dogwifhat', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
  { symbol: 'RAY', name: 'Raydium', mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' },
  { symbol: 'PYTH', name: 'Pyth Network', mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3' },
  { symbol: 'JITOSOL', name: 'Jito Staked SOL', mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn' },
];

/**
 * Folds the tricks used to make a lookalike ticker: case, separators, and the
 * digit/letter homoglyphs that read identically in a dashboard font.
 */
export function normalizeTicker(value: string): string {
  return value
    .toLowerCase()
    .replace(/[0о]/g, 'o')
    .replace(/[1|lі]/g, 'l')
    .replace(/[3е]/g, 'e')
    .replace(/[5$]/g, 's')
    .replace(/[4]/g, 'a')
    .replace(/[7]/g, 't')
    .replace(/[^a-z]/g, '');
}

/** Standard edit distance, capped work for the short strings we compare. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1);
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(
        (row[j - 1] as number) + 1,
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    prev = row;
  }

  return prev[b.length] as number;
}

/** How close two normalized tickers must be to be worth a model call. */
function isNearMatch(candidate: string, reference: string): boolean {
  if (candidate.length === 0 || reference.length === 0) return false;
  if (candidate === reference) return true;
  // One substitution is enough to fake a 3-4 char ticker; longer names get two.
  const budget = reference.length <= 4 ? 1 : 2;
  if (Math.abs(candidate.length - reference.length) > budget) return false;
  return editDistance(candidate, reference) <= budget;
}

/**
 * Deterministic pre-filter: which reference tokens is this candidate close
 * enough to that a judgement is worth paying for? Exact string work stays in
 * code; the model only arbitrates the genuinely semantic residue.
 *
 * A candidate that IS a reference token (same mint) never matches itself.
 */
export function referenceMatches(
  mint: string,
  symbol: string | null,
  name: string | null,
): ReferenceToken[] {
  // A token that IS one of the references is never an impersonator of another.
  // Without this, USDC and USDT - one edit apart - would screen each other
  // forever and burn a request every scan.
  if (REFERENCE_TOKENS.some((reference) => reference.mint === mint)) return [];

  const candidates = [symbol, name]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map(normalizeTicker)
    .filter((value) => value.length > 0);

  if (candidates.length === 0) return [];

  return REFERENCE_TOKENS.filter((reference) => {
    if (reference.mint === mint) return false;
    const refSymbol = normalizeTicker(reference.symbol);
    const refName = normalizeTicker(reference.name);
    return candidates.some(
      (value) => isNearMatch(value, refSymbol) || isNearMatch(value, refName),
    );
  });
}
