/**
 * Who funded a wallet, and whether that says anything about ownership.
 *
 * A wallet's first SOL usually arrives in one of its first transactions. When
 * the endpoint can return a wallet's history oldest-first (Helius
 * getTransactionsForAddress), that first inbound transfer is observable
 * directly; otherwise the funder is at best a LIKELY one from whatever part of
 * the history was seen.
 *
 * ## Classification
 *
 * | Class | Meaning |
 * |---|---|
 * | DIRECT | the wallet's first inbound SOL, from a keypair that is not a hub - a real funding relationship |
 * | LIKELY | an inbound transfer from a keypair, but the wallet's earliest history was not seen |
 * | INFRASTRUCTURE | the funder is a program account, a high-throughput sender, or funds many wallets - an exchange, bridge, relayer or service |
 * | UNKNOWN | no inbound funding was observed |
 *
 * **INFRASTRUCTURE is never evidence of common ownership.** Thousands of
 * unrelated people withdraw from the same exchange hot wallet; treating that
 * as a shared funder would link them all. The same goes for a program-owned
 * account (a bridge, a protocol vault). The edge is kept - it is true that the
 * SOL came from there - but it is labelled so no clustering ever uses it.
 *
 * Hub detection is behavioural, not a hardcoded list: an address with at least
 * {@link HUB_TX_COUNT} transactions inside {@link HUB_WINDOW_MS}, or one that
 * funded at least {@link HUB_FAN_OUT} of the wallets Token Finder has seen.
 */

import type { NormalizedTransaction } from '../ingest/normalize.ts';

export const HUB_TX_COUNT = 1000;
export const HUB_WINDOW_MS = 24 * 3_600_000;
export const HUB_FAN_OUT = 25;

export type FundingClass = 'DIRECT' | 'LIKELY' | 'INFRASTRUCTURE' | 'UNKNOWN';

export interface FundingObservation {
  wallet: string;
  funder: string;
  lamports: bigint;
  signature: string;
  slot: number;
  blockTimeMs: number | null;
  /** The wallet's first inbound SOL of the history seen. */
  firstInbound: boolean;
  /** Whether the history seen starts at the wallet's first transaction on chain. */
  historyFromStart: boolean;
}

export interface FunderStats {
  address: string;
  onCurve: boolean | null;
  /** Transactions seen in the probe window; null when the probe was not made or failed. */
  recentTxCount: number | null;
  recentWindowMs: number | null;
  /** Distinct wallets this address funded among those Token Finder has seen. */
  fanOut: number;
}

export interface FundingVerdict {
  classification: FundingClass;
  confidence: number;
  reasons: string[];
}

/**
 * The first SOL the wallet received in `txs` (oldest first): a system
 * transfer to it, or the creation of its account with lamports.
 */
export function findInitialFunding(
  wallet: string,
  txsOldestFirst: NormalizedTransaction[],
  historyFromStart: boolean,
): FundingObservation | null {
  for (const tx of txsOldestFirst) {
    if (tx.status !== 'SUCCESS') continue;
    const transfer = tx.solTransfers.find((t) => t.to === wallet && t.from !== wallet && t.lamports > 0n);
    const created = tx.accountCreations.find((c) => c.account === wallet && c.funder !== wallet && c.lamports > 0n);
    const hit = transfer
      ? { funder: transfer.from, lamports: transfer.lamports }
      : created
        ? { funder: created.funder, lamports: created.lamports }
        : null;
    if (hit === null) continue;
    return {
      wallet,
      funder: hit.funder,
      lamports: hit.lamports,
      signature: tx.signature,
      slot: tx.slot,
      blockTimeMs: tx.blockTimeMs,
      firstInbound: true,
      historyFromStart,
    };
  }
  return null;
}

export function classifyFunding(obs: FundingObservation | null, stats: FunderStats | null): FundingVerdict {
  if (obs === null) return { classification: 'UNKNOWN', confidence: 0, reasons: ['no inbound SOL observed in the history seen'] };

  if (stats?.onCurve === false) {
    return { classification: 'INFRASTRUCTURE', confidence: 0.85, reasons: ['the funder is a program-derived account (a program, bridge or protocol vault), which no one owns as a wallet'] };
  }
  if (stats?.recentTxCount != null && stats.recentWindowMs != null && stats.recentTxCount >= HUB_TX_COUNT && stats.recentWindowMs <= HUB_WINDOW_MS) {
    return {
      classification: 'INFRASTRUCTURE',
      confidence: 0.8,
      reasons: [`the funder sent ${stats.recentTxCount}+ transactions in ${Math.max(1, Math.round(stats.recentWindowMs / 60_000))} min - an exchange, relayer or service, not a person's wallet`],
    };
  }
  if (stats !== null && stats.fanOut >= HUB_FAN_OUT) {
    return { classification: 'INFRASTRUCTURE', confidence: 0.75, reasons: [`the funder funded ${stats.fanOut} of the wallets Token Finder has seen`] };
  }
  // DIRECT needs both halves: the first funding of a wallet whose start we
  // saw, and a funder we checked is not a hub. Missing either is LIKELY.
  const hubChecked = stats !== null && stats.recentTxCount !== null;
  if (obs.firstInbound && obs.historyFromStart && hubChecked) {
    return { classification: 'DIRECT', confidence: 0.9, reasons: ['the wallet\'s first SOL, from a keypair that is not a high-volume sender'] };
  }
  const reasons = [
    obs.historyFromStart ? 'the wallet\'s first SOL' : 'an inbound transfer; the wallet\'s earliest history was not seen',
    hubChecked ? 'the funder is not a high-volume sender' : 'whether the funder is a hub was not checked',
  ];
  return { classification: 'LIKELY', confidence: 0.55, reasons };
}
