/**
 * Machine-verifiable security events.
 *
 * Each event is an on-chain action someone took, with the transaction that
 * proves it. Price is never an input: a token that collapsed, or that its
 * creator abandoned, has no event here unless an action caused it.
 *
 * | Event | The action | Status |
 * |---|---|---|
 * | SUPPLY_EXPANSION | supply minted after the launch | CONFIRMED when minted to a creator-linked wallet that then sold at least half of it within 24 h; STRONGLY_SUSPECTED when minted to a creator-linked wallet; SUSPICIOUS otherwise |
 * | AUTHORITY_REASSIGNED | a mint or freeze authority moved to a new address instead of being revoked | SUSPICIOUS |
 * | FREEZE_ABUSE | the freeze authority froze holders' token accounts | CONFIRMED at three or more distinct holders, STRONGLY_SUSPECTED at one or two |
 * | LIQUIDITY_DRAIN | a wallet removed pool liquidity | CONFIRMED when creator-linked and at least 80% of the reserve; STRONGLY_SUSPECTED when creator-linked and at least 30%; SUSPICIOUS when unlinked and at least 80% |
 * | CREATOR_DUMP | creator-linked wallets sold a large share of supply within an hour | STRONGLY_SUSPECTED at 30% of supply, SUSPICIOUS at 10%; never CONFIRMED - selling is not provably malicious |
 *
 * Liquidity removed by a program-derived account (pump.fun migrating a
 * completed curve to its AMM, for one) is a program action and is not an
 * event. "Creator-linked" means the attributed creator, the creation's
 * signers and fee payer, the creator's strong-cluster members, and wallets
 * the creator funded directly.
 */

import { isOnCurve } from '../chain/address.ts';
import { canonicalId } from '../ingest/events.ts';

export type SecurityEventType = 'SUPPLY_EXPANSION' | 'AUTHORITY_REASSIGNED' | 'FREEZE_ABUSE' | 'LIQUIDITY_DRAIN' | 'CREATOR_DUMP';
export type SecurityStatus = 'CONFIRMED' | 'STRONGLY_SUSPECTED' | 'SUSPICIOUS' | 'UNKNOWN';

export interface SecurityEvent {
  id: string;
  mint: string;
  type: SecurityEventType;
  status: SecurityStatus;
  actor: string | null;
  creatorLinked: boolean;
  signature: string;
  slot: number;
  blockTimeMs: number | null;
  amount: string | null;
  reasons: string[];
  evidence: string[];
  confidence: number;
}

export interface MintFact {
  signature: string;
  slot: number;
  blockTimeMs: number | null;
}

export interface SecurityInput {
  mint: string;
  launchSignature: string | null;
  launchSlot: number | null;
  initialSupply: bigint | null;
  creatorLinked: ReadonlySet<string>;
  mintTos: (MintFact & { amount: bigint; recipientOwner: string | null; authority: string | null })[];
  authorityChanges: (MintFact & { authorityType: string; newAuthority: string | null; previousAuthority: string | null })[];
  freezes: (MintFact & { kind: 'FREEZE' | 'THAW'; owner: string | null; authority: string | null })[];
  liquidityRemovals: (MintFact & { actor: string | null; reserveFraction: number | null; tokenAmount: bigint | null })[];
  sells: (MintFact & { trader: string; tokenAmount: bigint })[];
}

const CONFIDENCE: Record<SecurityStatus, number> = { CONFIRMED: 0.95, STRONGLY_SUSPECTED: 0.75, SUSPICIOUS: 0.5, UNKNOWN: 0 };
const pct = (x: number): string => `${Math.round(x * 100)}%`;

export function detectSecurityEvents(input: SecurityInput): SecurityEvent[] {
  const events: SecurityEvent[] = [];
  const linked = (a: string | null): boolean => a !== null && input.creatorLinked.has(a);
  const after = (f: MintFact): boolean =>
    f.signature !== input.launchSignature && (input.launchSlot === null || f.slot >= input.launchSlot);
  const push = (type: SecurityEventType, status: SecurityStatus, fact: MintFact, actor: string | null, amount: bigint | null, reasons: string[], evidence: string[] = []): void => {
    events.push({
      id: canonicalId('SECURITY', type, input.mint, fact.signature),
      mint: input.mint,
      type,
      status,
      actor,
      creatorLinked: linked(actor),
      signature: fact.signature,
      slot: fact.slot,
      blockTimeMs: fact.blockTimeMs,
      amount: amount === null ? null : amount.toString(),
      reasons,
      evidence: [fact.signature, ...evidence].slice(0, 6),
      confidence: CONFIDENCE[status],
    });
  };

  // --- supply expansion --------------------------------------------------------
  for (const m of input.mintTos) {
    if (!after(m)) continue;
    const toLinked = linked(m.recipientOwner);
    const sold = input.sells
      .filter((s) => linked(s.trader) && s.slot >= m.slot && (s.blockTimeMs === null || m.blockTimeMs === null || s.blockTimeMs - m.blockTimeMs <= 24 * 3_600_000))
      .reduce((sum, s) => sum + s.tokenAmount, 0n);
    const soldHalf = toLinked && sold * 2n >= m.amount;
    const status: SecurityStatus = soldHalf ? 'CONFIRMED' : toLinked ? 'STRONGLY_SUSPECTED' : 'SUSPICIOUS';
    const reasons = [`${m.amount.toString()} base units minted after the launch`];
    if (toLinked) reasons.push('minted to a creator-linked wallet');
    if (soldHalf) reasons.push('creator-linked wallets sold at least half of it within 24 h');
    push('SUPPLY_EXPANSION', status, m, m.authority, m.amount, reasons);
  }

  // --- authority moved, not revoked ---------------------------------------------------
  for (const a of input.authorityChanges) {
    if (!after(a) || a.newAuthority === null) continue;
    push('AUTHORITY_REASSIGNED', 'SUSPICIOUS', a, a.previousAuthority, null, [`${a.authorityType} authority moved to ${a.newAuthority.slice(0, 6)}… instead of being revoked`]);
  }

  // --- freezes of holders ---------------------------------------------------------------
  const frozen = input.freezes.filter((f) => f.kind === 'FREEZE' && !linked(f.owner));
  const holders = new Set(frozen.map((f) => f.owner ?? f.signature));
  if (frozen.length > 0) {
    const first = frozen[0] as (typeof frozen)[number];
    const status: SecurityStatus = holders.size >= 3 ? 'CONFIRMED' : 'STRONGLY_SUSPECTED';
    push('FREEZE_ABUSE', status, first, first.authority, null, [`the freeze authority froze ${holders.size} holder account${holders.size === 1 ? '' : 's'}`], frozen.slice(1).map((f) => f.signature));
  }

  // --- liquidity drains ---------------------------------------------------------------------
  for (const l of input.liquidityRemovals) {
    if (l.actor === null || isOnCurve(l.actor) !== true) continue; // a program's action, e.g. a migration
    const fraction = l.reserveFraction ?? 0;
    const isLinked = linked(l.actor);
    let status: SecurityStatus | null = null;
    if (isLinked && fraction >= 0.8) status = 'CONFIRMED';
    else if (isLinked && fraction >= 0.3) status = 'STRONGLY_SUSPECTED';
    else if (!isLinked && fraction >= 0.8) status = 'SUSPICIOUS';
    if (status === null) continue;
    push('LIQUIDITY_DRAIN', status, l, l.actor, l.tokenAmount, [`${pct(fraction)} of the pool's token reserve removed`, isLinked ? 'by a creator-linked wallet' : 'by a wallet not linked to the creator']);
  }

  // --- creator dumps ---------------------------------------------------------------------
  if (input.initialSupply !== null && input.initialSupply > 0n) {
    const sells = input.sells.filter((s) => linked(s.trader)).sort((a, b) => a.slot - b.slot);
    let best = { amount: 0n, start: 0, end: 0 };
    for (let i = 0; i < sells.length; i++) {
      let sum = 0n;
      for (let j = i; j < sells.length; j++) {
        const a = sells[i] as (typeof sells)[number];
        const b = sells[j] as (typeof sells)[number];
        if (a.blockTimeMs !== null && b.blockTimeMs !== null && b.blockTimeMs - a.blockTimeMs > 3_600_000) break;
        sum += b.tokenAmount;
        if (sum > best.amount) best = { amount: sum, start: i, end: j };
      }
    }
    const share = Number((best.amount * 10_000n) / input.initialSupply) / 10_000;
    if (share >= 0.1) {
      const first = sells[best.start] as (typeof sells)[number];
      const status: SecurityStatus = share >= 0.3 ? 'STRONGLY_SUSPECTED' : 'SUSPICIOUS';
      push('CREATOR_DUMP', status, first, first.trader, best.amount, [`creator-linked wallets sold ${pct(share)} of supply within an hour`], sells.slice(best.start + 1, best.end + 1).map((s) => s.signature));
    }
  }
  return events;
}
