/**
 * Builders for the deep-intelligence tests.
 *
 * Addresses are derived from labels, so every run sees the same ones: a label
 * is hashed until the 32 bytes land on (a wallet) or off (a program-derived
 * account) the ed25519 curve, as the project's own `isOnCurve` decides. No
 * real mainnet address is hardcoded as a subject of any test.
 */

import { createHash } from 'node:crypto';
import { isOnCurve } from '../src/chain/address.ts';
import { LEGACY_SPL_TOKEN_PROGRAM_ID } from '../src/core/token-program.ts';
import { SYSTEM_PROGRAM, WSOL_MINT } from '../src/chain/programs.ts';
import type { NormalizedTransaction, TokenBalanceDelta } from '../src/ingest/normalize.ts';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

const cache = new Map<string, string>();

function derive(label: string, onCurve: boolean): string {
  const key = `${label}|${onCurve}`;
  const hit = cache.get(key);
  if (hit) return hit;
  for (let i = 0; ; i++) {
    const bytes = createHash('sha256').update(`${label}#${i}`).digest();
    const address = base58(bytes);
    if (address.length >= 32 && isOnCurve(address) === onCurve) {
      cache.set(key, address);
      return address;
    }
  }
}

/** A keypair-shaped address. */
export const wallet = (label: string): string => derive(`wallet:${label}`, true);
/** A program-derived (off-curve) address: a pool, vault or program account. */
export const pda = (label: string): string => derive(`pda:${label}`, false);
/** A mint address (off-curve here, so it can never be mistaken for a trader). */
export const mintOf = (label: string): string => derive(`mint:${label}`, false);

export const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
let sigCounter = 0;
export const sig = (label = 'tx'): string => `${label}-${++sigCounter}`;

export function ntx(p: Partial<NormalizedTransaction> & { slot: number }): NormalizedTransaction {
  const signers = p.signers ?? [p.feePayer ?? wallet('payer')];
  return {
    signature: p.signature ?? sig(),
    slot: p.slot,
    blockTimeMs: p.blockTimeMs === undefined ? T0 + p.slot * 400 : p.blockTimeMs,
    status: p.status ?? 'SUCCESS',
    error: p.error ?? null,
    feePayer: p.feePayer ?? (signers[0] as string),
    signers,
    feeLamports: p.feeLamports === undefined ? 5000n : p.feeLamports,
    version: p.version ?? '0',
    programIds: p.programIds ?? [],
    accountKeys: p.accountKeys ?? [],
    lamportDeltas: p.lamportDeltas ?? new Map(),
    tokenBalances: p.tokenBalances ?? [],
    decimalsByMint: p.decimalsByMint ?? new Map(),
    tokenTransfers: p.tokenTransfers ?? [],
    solTransfers: p.solTransfers ?? [],
    mintInits: p.mintInits ?? [],
    mintTos: p.mintTos ?? [],
    authorityChanges: p.authorityChanges ?? [],
    accountCreations: p.accountCreations ?? [],
    tokenAccountInits: p.tokenAccountInits ?? [],
    freezes: p.freezes ?? [],
    issues: p.issues ?? [],
  };
}

const LAMPORTS = 1_000_000_000n;

/**
 * A swap from the wallet's side: its token balance moves by `tokens`, its SOL
 * by `sol` the other way (plus the fee it paid).
 */
export function swap(o: {
  wallet: string;
  mint: string;
  direction: 'BUY' | 'SELL';
  tokens: bigint;
  sol: number;
  timeMs: number;
  slot?: number;
  signature?: string;
  status?: 'SUCCESS' | 'FAILED';
}): NormalizedTransaction {
  const lamports = BigInt(Math.round(o.sol * Number(LAMPORTS)));
  const fee = 5000n;
  const delta = o.direction === 'BUY' ? o.tokens : -o.tokens;
  const pre = o.direction === 'BUY' ? 0n : o.tokens;
  const balance: TokenBalanceDelta = { account: pda(`ata:${o.wallet}:${o.mint}`), owner: o.wallet, mint: o.mint, decimals: 6, pre, post: pre + delta, delta };
  const failed = o.status === 'FAILED';
  return ntx({
    signature: o.signature ?? sig('swap'),
    slot: o.slot ?? Math.floor((o.timeMs - T0) / 400),
    blockTimeMs: o.timeMs,
    status: o.status ?? 'SUCCESS',
    feePayer: o.wallet,
    signers: [o.wallet],
    lamportDeltas: new Map([[o.wallet, failed ? -fee : (o.direction === 'BUY' ? -lamports : lamports) - fee]]),
    tokenBalances: failed ? [] : [balance],
    decimalsByMint: new Map([[o.mint, 6], [WSOL_MINT, 9]]),
  });
}

/** A transaction that moved nothing the analysis reads: a plain touch of the wallet. */
export function idle(walletAddress: string, timeMs: number, status: 'SUCCESS' | 'FAILED' = 'SUCCESS'): NormalizedTransaction {
  return ntx({ slot: Math.floor((timeMs - T0) / 400), blockTimeMs: timeMs, feePayer: walletAddress, signers: [walletAddress], status });
}

/** A SOL transfer, as the funding reader sees it. */
export function fund(from: string, to: string, sol: number, timeMs: number, signature?: string): NormalizedTransaction {
  const lamports = BigInt(Math.round(sol * Number(LAMPORTS)));
  return ntx({
    signature: signature ?? sig('fund'),
    slot: Math.floor((timeMs - T0) / 400),
    blockTimeMs: timeMs,
    feePayer: from,
    signers: [from],
    solTransfers: [{ path: '0', from, to, lamports }],
    lamportDeltas: new Map([[from, -lamports - 5000n], [to, lamports]]),
  });
}

const BASE_LAMPORTS = 1_000_000_000_000n;

/**
 * Encodes a normalized transaction back into the jsonParsed shape an RPC node
 * returns, so runner tests exercise the real normaliser. Covers what the
 * builders above produce: balances, SOL transfers, account creations, mint
 * initialisation and minting.
 */
export function toRaw(n: NormalizedTransaction): unknown {
  const keys: string[] = [];
  const index = (a: string): number => {
    if (!keys.includes(a)) keys.push(a);
    return keys.indexOf(a);
  };
  index(n.feePayer);
  for (const s of n.signers) index(s);
  for (const a of n.lamportDeltas.keys()) index(a);
  for (const b of n.tokenBalances) index(b.account);
  for (const t of n.solTransfers) (index(t.from), index(t.to));
  for (const k of n.accountKeys) index(k);
  const pre = keys.map(() => BASE_LAMPORTS);
  const post = keys.map((k, i) => (pre[i] as bigint) + (n.lamportDeltas.get(k) ?? 0n));
  const balance = (side: 'pre' | 'post') =>
    n.tokenBalances.map((b) => ({ accountIndex: index(b.account), mint: b.mint, owner: b.owner, uiTokenAmount: { amount: String(side === 'pre' ? b.pre : b.post), decimals: b.decimals ?? 6 } }));
  const tokenProgram = LEGACY_SPL_TOKEN_PROGRAM_ID;
  const instructions = [
    ...n.solTransfers.map((t) => ({ programId: SYSTEM_PROGRAM, program: 'system', parsed: { type: 'transfer', info: { source: t.from, destination: t.to, lamports: Number(t.lamports) } } })),
    ...n.accountCreations.map((c) => ({ programId: SYSTEM_PROGRAM, program: 'system', parsed: { type: 'createAccount', info: { source: c.funder, newAccount: c.account, owner: c.owner, lamports: Number(c.lamports) } } })),
    ...n.mintInits.map((m) => ({ programId: m.tokenProgram, program: 'spl-token', parsed: { type: 'initializeMint2', info: { mint: m.mint, decimals: m.decimals, mintAuthority: m.mintAuthority, freezeAuthority: m.freezeAuthority } } })),
    ...n.mintTos.map((m) => ({ programId: tokenProgram, program: 'spl-token', parsed: { type: 'mintTo', info: { mint: m.mint, account: m.account, amount: String(m.amount), mintAuthority: m.authority } } })),
  ];
  return {
    slot: n.slot,
    blockTime: n.blockTimeMs === null ? null : Math.floor(n.blockTimeMs / 1000),
    version: 0,
    transaction: {
      signatures: [n.signature],
      message: { accountKeys: keys.map((k) => ({ pubkey: k, signer: n.signers.includes(k), writable: true })), instructions },
    },
    meta: {
      err: n.status === 'FAILED' ? { InstructionError: [0, 'Custom'] } : null,
      fee: Number(n.feeLamports ?? 5000n),
      preBalances: pre.map(Number),
      postBalances: post.map(Number),
      preTokenBalances: balance('pre'),
      postTokenBalances: balance('post'),
      innerInstructions: [],
    },
  };
}
