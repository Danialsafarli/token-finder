/**
 * Turns a `getTransaction` (jsonParsed) result into facts.
 *
 * This is the transaction boundary, and it follows the project's provider
 * rule: a field that is absent stays unknown, a field that is present but
 * impossible is rejected with a recorded issue, and nothing is coerced into a
 * number that looks measured. Nothing here interprets a transaction as a buy,
 * a launch or anything else - see `swap.ts` and `launch.ts` for that. This file
 * only answers "what did the chain record".
 *
 * ## What comes out
 *
 * - identity: signature, slot, block time, fee payer, signers, status, fee;
 * - **balance deltas**: per token account (owner, mint, raw pre/post) and per
 *   account in lamports, as exact BigInts - the ground truth every derived
 *   amount is checked against;
 * - **instruction facts** from the node's own parsers, outer and inner, each
 *   with a stable path (`2` for the third outer instruction, `2.13` for the
 *   fourteenth instruction it invoked): token transfers, SOL transfers, mint
 *   creations, mints of supply, and authority changes.
 *
 * An instruction the node did not parse (most DEX programs) contributes its
 * program id and nothing else. Its effects are still visible in the balance
 * deltas, which is why derived facts are built from those.
 *
 * Source: Tier 1 - solana.com RPC JSON structures (`preTokenBalances` /
 * `postTokenBalances` carry `accountIndex`, `mint`, `owner`, `programId` and a
 * raw `uiTokenAmount.amount`; `meta.innerInstructions[].index` is the outer
 * instruction that invoked them). Shapes confirmed against the captured
 * mainnet fixtures in test/fixtures/chain.
 */

import { ValidationReport, validDecimals, validMint, validRawAmount, type FieldIssue } from '../core/validate.ts';
import { SYSTEM_PROGRAM } from '../chain/programs.ts';
import { LEGACY_SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../core/token-program.ts';

export type TxStatus = 'SUCCESS' | 'FAILED';

export interface TokenBalanceDelta {
  /** The token account. */
  account: string;
  /** Its owner - a wallet or a program-derived account. Null when not reported. */
  owner: string | null;
  mint: string;
  decimals: number | null;
  pre: bigint;
  post: bigint;
  delta: bigint;
}

export interface TokenTransferFact {
  path: string;
  mint: string | null;
  sourceAccount: string;
  destinationAccount: string;
  sourceOwner: string | null;
  destinationOwner: string | null;
  amount: bigint;
}

export interface SolTransferFact {
  path: string;
  from: string;
  to: string;
  lamports: bigint;
}

export interface MintInitFact {
  path: string;
  mint: string;
  decimals: number | null;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** The token program that created the mint. */
  tokenProgram: string;
}

export interface MintToFact {
  path: string;
  mint: string;
  account: string;
  amount: bigint;
  authority: string | null;
}

export interface AuthorityChangeFact {
  path: string;
  /** The mint or token account whose authority changed. */
  target: string;
  authorityType: string;
  /** Null means revoked. */
  newAuthority: string | null;
  previousAuthority: string | null;
}

export interface AccountCreationFact {
  path: string;
  account: string;
  /** The program that owns the new account. */
  owner: string;
  lamports: bigint;
  funder: string;
}

export interface TokenAccountInitFact {
  path: string;
  account: string;
  mint: string;
  owner: string;
}

export interface NormalizedTransaction {
  signature: string;
  slot: number;
  /** Chain time in unix ms; null when the node did not report one. */
  blockTimeMs: number | null;
  status: TxStatus;
  /** Short rendering of the on-chain error, when the transaction failed. */
  error: string | null;
  feePayer: string;
  signers: string[];
  feeLamports: bigint | null;
  /** Transaction format: 'legacy', 0 or 1. */
  version: string | null;
  /** Every program invoked, outer and inner, in first-seen order. */
  programIds: string[];
  accountKeys: string[];
  /** Non-zero lamport changes per account. */
  lamportDeltas: Map<string, bigint>;
  /** Every token account whose balance was reported, including unchanged ones. */
  tokenBalances: TokenBalanceDelta[];
  decimalsByMint: Map<string, number>;
  tokenTransfers: TokenTransferFact[];
  solTransfers: SolTransferFact[];
  mintInits: MintInitFact[];
  mintTos: MintToFact[];
  authorityChanges: AuthorityChangeFact[];
  accountCreations: AccountCreationFact[];
  tokenAccountInits: TokenAccountInitFact[];
  issues: FieldIssue[];
}

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

interface RawInstruction {
  path: string;
  programId: string | null;
  program: string | null;
  type: string | null;
  info: Json | null;
}

/** Outer instructions, then each one's inner instructions, in execution order. */
function instructionsOf(raw: Json): RawInstruction[] {
  const message = record(record(raw.transaction)?.message);
  const outer = Array.isArray(message?.instructions) ? (message.instructions as unknown[]) : [];
  const innerGroups = Array.isArray(record(raw.meta)?.innerInstructions)
    ? ((record(raw.meta)?.innerInstructions as unknown[]) ?? [])
    : [];

  const innerByIndex = new Map<number, unknown[]>();
  for (const group of innerGroups) {
    const g = record(group);
    if (g === null || typeof g.index !== 'number' || !Array.isArray(g.instructions)) continue;
    innerByIndex.set(g.index, g.instructions as unknown[]);
  }

  const one = (value: unknown, path: string): RawInstruction => {
    const ix = record(value) ?? {};
    const parsed = record(ix.parsed);
    return {
      path,
      programId: text(ix.programId),
      program: text(ix.program),
      type: text(parsed?.type),
      info: record(parsed?.info),
    };
  };

  const out: RawInstruction[] = [];
  outer.forEach((value, i) => {
    out.push(one(value, String(i)));
    (innerByIndex.get(i) ?? []).forEach((inner, j) => out.push(one(inner, `${i}.${j}`)));
  });
  return out;
}

/**
 * Normalizes one transaction. Returns null when the input is not a
 * transaction at all (no signature or slot) - which is different from a
 * transaction with a few unreadable fields, which is returned with issues.
 */
export function normalizeTransaction(raw: unknown): NormalizedTransaction | null {
  const tx = record(raw);
  if (tx === null) return null;
  const report = new ValidationReport('solana-rpc');
  const meta = record(tx.meta);
  const message = record(record(tx.transaction)?.message);
  const signatures = record(tx.transaction)?.signatures;
  const signature = Array.isArray(signatures) ? text(signatures[0]) : null;
  const slot = typeof tx.slot === 'number' && Number.isSafeInteger(tx.slot) && tx.slot >= 0 ? tx.slot : null;
  if (signature === null || slot === null || meta === null || message === null) return null;

  // jsonParsed accountKeys are objects; plain json gives strings. Both are read.
  const rawKeys = Array.isArray(message.accountKeys) ? (message.accountKeys as unknown[]) : [];
  const accountKeys: string[] = [];
  const signers: string[] = [];
  for (const [index, key] of rawKeys.entries()) {
    const k = record(key);
    const address = typeof key === 'string' ? key : text(k?.pubkey);
    const valid = validMint(report, `accountKeys[${index}]`, address);
    accountKeys.push(valid ?? '');
    if (k?.signer === true && valid !== null) signers.push(valid);
  }
  const feePayer = accountKeys[0] ?? '';
  if (feePayer === '') return null;

  const blockTime = tx.blockTime;
  const blockTimeMs =
    typeof blockTime === 'number' && Number.isSafeInteger(blockTime) && blockTime > 0 ? blockTime * 1000 : null;
  if (blockTime !== null && blockTime !== undefined && blockTimeMs === null) {
    report.reject('blockTime', 'not a positive unix time', blockTime);
  }

  const err = meta.err;
  const status: TxStatus = err === null || err === undefined ? 'SUCCESS' : 'FAILED';
  const error = status === 'FAILED' ? JSON.stringify(err).slice(0, 160) : null;
  const feeLamports = validRawAmount(report, 'meta.fee', meta.fee);

  // --- lamports ------------------------------------------------------------
  const lamportDeltas = new Map<string, bigint>();
  const pre = Array.isArray(meta.preBalances) ? (meta.preBalances as unknown[]) : [];
  const post = Array.isArray(meta.postBalances) ? (meta.postBalances as unknown[]) : [];
  for (let i = 0; i < Math.min(pre.length, post.length, accountKeys.length); i++) {
    const before = validRawAmount(report, `preBalances[${i}]`, pre[i]);
    const after = validRawAmount(report, `postBalances[${i}]`, post[i]);
    const address = accountKeys[i];
    if (before === null || after === null || !address) continue;
    if (after !== before) lamportDeltas.set(address, (lamportDeltas.get(address) ?? 0n) + (after - before));
  }

  // --- token balances ------------------------------------------------------
  // Keyed by token account. An account present before and absent after was
  // closed (post 0); present only after was created (pre 0). Either way the
  // node reported its balance, so the change is real.
  const decimalsByMint = new Map<string, number>();
  const balances = new Map<string, TokenBalanceDelta>();
  const readBalances = (list: unknown, side: 'pre' | 'post'): void => {
    if (!Array.isArray(list)) return;
    for (const [i, entry] of (list as unknown[]).entries()) {
      const b = record(entry);
      if (b === null || typeof b.accountIndex !== 'number') continue;
      const account = accountKeys[b.accountIndex];
      const mint = validMint(report, `${side}TokenBalances[${i}].mint`, b.mint);
      if (!account || mint === null) continue;
      const amount = validRawAmount(report, `${side}TokenBalances[${i}].amount`, record(b.uiTokenAmount)?.amount);
      if (amount === null) continue;
      const decimals = validDecimals(report, `${side}TokenBalances[${i}].decimals`, record(b.uiTokenAmount)?.decimals);
      if (decimals !== null) decimalsByMint.set(mint, decimals);
      const owner = b.owner === undefined || b.owner === null ? null : validMint(report, `${side}TokenBalances[${i}].owner`, b.owner);
      const existing = balances.get(account) ?? { account, owner, mint, decimals, pre: 0n, post: 0n, delta: 0n };
      existing.owner ??= owner;
      existing.decimals ??= decimals;
      if (side === 'pre') existing.pre = amount;
      else existing.post = amount;
      balances.set(account, existing);
    }
  };
  readBalances(meta.preTokenBalances, 'pre');
  readBalances(meta.postTokenBalances, 'post');
  const tokenBalances = [...balances.values()].map((b) => ({ ...b, delta: b.post - b.pre }));
  const ownerOfAccount = new Map(tokenBalances.map((b) => [b.account, b.owner]));
  const mintOfAccount = new Map(tokenBalances.map((b) => [b.account, b.mint]));

  // --- instruction facts ---------------------------------------------------
  const programIds: string[] = [];
  const tokenTransfers: TokenTransferFact[] = [];
  const solTransfers: SolTransferFact[] = [];
  const mintInits: MintInitFact[] = [];
  const mintTos: MintToFact[] = [];
  const authorityChanges: AuthorityChangeFact[] = [];
  const accountCreations: AccountCreationFact[] = [];
  const tokenAccountInits: TokenAccountInitFact[] = [];

  const isTokenProgram = (id: string | null): boolean =>
    id === LEGACY_SPL_TOKEN_PROGRAM_ID || id === TOKEN_2022_PROGRAM_ID;

  for (const ix of instructionsOf(tx)) {
    if (ix.programId !== null && !programIds.includes(ix.programId)) programIds.push(ix.programId);
    const info = ix.info;
    if (info === null || ix.type === null) continue;
    const field = (name: string): string => `ix[${ix.path}].${name}`;

    if (isTokenProgram(ix.programId)) {
      if (ix.type === 'transfer' || ix.type === 'transferChecked') {
        const source = validMint(report, field('source'), info.source);
        const destination = validMint(report, field('destination'), info.destination);
        const amount = validRawAmount(
          report,
          field('amount'),
          ix.type === 'transfer' ? info.amount : record(info.tokenAmount)?.amount,
        );
        if (source === null || destination === null || amount === null) continue;
        const mint =
          (info.mint === undefined ? null : validMint(report, field('mint'), info.mint)) ??
          mintOfAccount.get(source) ??
          mintOfAccount.get(destination) ??
          null;
        tokenTransfers.push({
          path: ix.path,
          mint,
          sourceAccount: source,
          destinationAccount: destination,
          sourceOwner: ownerOfAccount.get(source) ?? null,
          destinationOwner: ownerOfAccount.get(destination) ?? null,
          amount,
        });
      } else if (ix.type === 'initializeMint' || ix.type === 'initializeMint2') {
        const mint = validMint(report, field('mint'), info.mint);
        if (mint === null || ix.programId === null) continue;
        mintInits.push({
          path: ix.path,
          mint,
          decimals: validDecimals(report, field('decimals'), info.decimals),
          mintAuthority: info.mintAuthority == null ? null : validMint(report, field('mintAuthority'), info.mintAuthority),
          freezeAuthority: info.freezeAuthority == null ? null : validMint(report, field('freezeAuthority'), info.freezeAuthority),
          tokenProgram: ix.programId,
        });
      } else if (ix.type === 'mintTo' || ix.type === 'mintToChecked') {
        const mint = validMint(report, field('mint'), info.mint);
        const account = validMint(report, field('account'), info.account);
        const amount = validRawAmount(
          report,
          field('amount'),
          ix.type === 'mintTo' ? info.amount : record(info.tokenAmount)?.amount,
        );
        if (mint === null || account === null || amount === null) continue;
        mintTos.push({
          path: ix.path,
          mint,
          account,
          amount,
          authority: info.mintAuthority == null ? null : validMint(report, field('mintAuthority'), info.mintAuthority),
        });
      } else if (ix.type === 'setAuthority') {
        const target = validMint(report, field('target'), info.mint ?? info.account);
        const authorityType = text(info.authorityType);
        if (target === null || authorityType === null) continue;
        authorityChanges.push({
          path: ix.path,
          target,
          authorityType,
          newAuthority: info.newAuthority == null ? null : validMint(report, field('newAuthority'), info.newAuthority),
          previousAuthority: info.authority == null ? null : validMint(report, field('authority'), info.authority),
        });
      } else if (ix.type === 'initializeAccount' || ix.type === 'initializeAccount2' || ix.type === 'initializeAccount3') {
        const account = validMint(report, field('account'), info.account);
        const mint = validMint(report, field('mint'), info.mint);
        const owner = validMint(report, field('owner'), info.owner);
        if (account !== null && mint !== null && owner !== null) {
          tokenAccountInits.push({ path: ix.path, account, mint, owner });
        }
      }
    } else if (ix.programId === SYSTEM_PROGRAM) {
      if (ix.type === 'transfer') {
        const from = validMint(report, field('source'), info.source);
        const to = validMint(report, field('destination'), info.destination);
        const lamports = validRawAmount(report, field('lamports'), info.lamports);
        if (from !== null && to !== null && lamports !== null) {
          solTransfers.push({ path: ix.path, from, to, lamports });
        }
      } else if (ix.type === 'createAccount') {
        const account = validMint(report, field('newAccount'), info.newAccount);
        const owner = validMint(report, field('owner'), info.owner);
        const funder = validMint(report, field('source'), info.source);
        const lamports = validRawAmount(report, field('lamports'), info.lamports);
        if (account !== null && owner !== null && funder !== null && lamports !== null) {
          accountCreations.push({ path: ix.path, account, owner, lamports, funder });
        }
      }
    }
  }

  const version = tx.version === undefined || tx.version === null ? null : String(tx.version);

  return {
    signature,
    slot,
    blockTimeMs,
    status,
    error,
    feePayer,
    signers,
    feeLamports,
    version,
    programIds,
    accountKeys,
    lamportDeltas,
    tokenBalances,
    decimalsByMint,
    tokenTransfers,
    solTransfers,
    mintInits,
    mintTos,
    authorityChanges,
    accountCreations,
    tokenAccountInits,
    issues: report.issues,
  };
}
