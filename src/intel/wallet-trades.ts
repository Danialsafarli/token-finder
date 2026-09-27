/**
 * A wallet's trades, read from its own balance changes.
 *
 * Pool activity (Phase 1) reads a trade from the pool's side. A wallet's
 * history has no single pool - it spans every token the wallet touched - so
 * here the reading is from the wallet's side:
 *
 *   the wallet's holding of a token went up, and it paid SOL/USDC/USDT  -> BUY
 *   the wallet's holding of a token went down, and it received one      -> SELL
 *
 * A token that arrives with nothing paid is a transfer, not a buy, and is not
 * a trade. When several tokens moved in one transaction (a route, a batch),
 * the paid amount cannot be split between them, so each trade keeps its
 * direction and token amount and its quote is left unknown.
 *
 * The quote amount is the wallet's net change and therefore approximate: it
 * includes priority fees, tips and account rent. It is good for comparing a
 * wallet's order sizes with each other (the transaction fee itself is added
 * back when the wallet paid it); it is not a price.
 */

import { SOL_DECIMALS, USDC_MINT, USDT_MINT, WSOL_MINT } from '../chain/programs.ts';
import type { NormalizedTransaction } from '../ingest/normalize.ts';

export interface WalletTrade {
  wallet: string;
  signature: string;
  mint: string;
  direction: 'BUY' | 'SELL';
  tokenAmount: bigint;
  tokenDecimals: number | null;
  /** WSOL for SOL, native or wrapped. Null when it could not be attributed. */
  quoteMint: string | null;
  quoteAmount: bigint | null;
  quoteDecimals: number | null;
  slot: number;
  txIndex: number | null;
  blockTimeMs: number | null;
  /** Whether the wallet paid the fee - false for a relayed trade. */
  walletPaidFee: boolean;
}

const QUOTES = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

export function walletTrades(tx: NormalizedTransaction, wallet: string, txIndex: number | null = null): WalletTrade[] {
  if (tx.status !== 'SUCCESS') return [];

  const deltas = new Map<string, bigint>();
  for (const b of tx.tokenBalances) {
    if (b.owner !== wallet || b.delta === 0n) continue;
    deltas.set(b.mint, (deltas.get(b.mint) ?? 0n) + b.delta);
  }
  // SOL: native lamports plus wrapped SOL, with the fee added back - the fee
  // is the cost of the transaction, not part of what was traded.
  let sol = (deltas.get(WSOL_MINT) ?? 0n) + (tx.lamportDeltas.get(wallet) ?? 0n);
  if (tx.feePayer === wallet && tx.feeLamports !== null) sol += tx.feeLamports;
  deltas.delete(WSOL_MINT);
  if (sol !== 0n) deltas.set(WSOL_MINT, sol);

  const tokens = [...deltas.entries()].filter(([mint, delta]) => !QUOTES.has(mint) && delta !== 0n);
  if (tokens.length === 0) return [];

  const trades: WalletTrade[] = [];
  for (const [mint, delta] of tokens) {
    const buying = delta > 0n;
    // The paying side: a quote asset that moved the other way.
    const paid = [...deltas.entries()].filter(([m, d]) => QUOTES.has(m) && d !== 0n && (d > 0n) !== buying);
    if (paid.length === 0) continue; // arrived or left with nothing paid: a transfer
    const quote = tokens.length === 1 && paid.length === 1 ? (paid[0] as [string, bigint]) : null;
    trades.push({
      wallet,
      signature: tx.signature,
      mint,
      direction: buying ? 'BUY' : 'SELL',
      tokenAmount: buying ? delta : -delta,
      tokenDecimals: tx.decimalsByMint.get(mint) ?? null,
      quoteMint: quote === null ? null : quote[0],
      quoteAmount: quote === null ? null : quote[1] < 0n ? -quote[1] : quote[1],
      quoteDecimals: quote === null ? null : quote[0] === WSOL_MINT ? SOL_DECIMALS : (tx.decimalsByMint.get(quote[0]) ?? null),
      slot: tx.slot,
      txIndex,
      blockTimeMs: tx.blockTimeMs,
      walletPaidFee: tx.feePayer === wallet,
    });
  }
  return trades;
}
