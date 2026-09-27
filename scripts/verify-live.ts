/**
 * Live verification against mainnet. NOT part of the automated suite, which
 * never depends on a public endpoint; run it by hand:
 *
 *   node scripts/verify-live.ts
 *
 * Uses whichever endpoint the backbone would (SOLANA_RPC_URL, then Helius,
 * then the public endpoint) and says which. Checks, on real accounts and
 * transactions:
 *
 * 1. token program identification and Token-2022 extensions, through the
 *    existing safety parser (`parseMint` in sources/helius.ts);
 * 2. the holder path (`getTokenLargestAccounts`) - and that when it cannot be
 *    read, concentration is UNKNOWN (null), never 0;
 * 3. signature history, parsed transactions, pool activity, and transfers.
 *
 * Nothing is written to the database.
 */

import { parseMint } from '../src/sources/helius.ts';
import * as rpc from '../src/sources/solana-rpc.ts';
import { normalizeTransaction } from '../src/ingest/normalize.ts';
import { derivePoolActivity } from '../src/ingest/activity.ts';
import { parsePumpfunLaunch } from '../src/ingest/launch.ts';
import { transferEdges } from '../src/ingest/derive.ts';
import { PUMPFUN_MINT_AUTHORITY } from '../src/chain/programs.ts';

const endpoint = rpc.rpcEndpoint();
let failures = 0;
const check = (ok: boolean, label: string, detail = ''): void => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`);
};

console.log(`endpoint: ${endpoint.label}${endpoint.kind === 'public' ? ' (keyless; Helius-keyed mode is NOT exercised by this run)' : ''}\n`);

// --- 1. mint accounts through the safety parser ----------------------------
console.log('1. token program and extensions (parseMint on live accounts)');
const MINTS: { name: string; mint: string; expectProgram: string; expectVeto?: string }[] = [
  { name: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', expectProgram: 'LEGACY_SPL_TOKEN' },
  { name: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', expectProgram: 'LEGACY_SPL_TOKEN' },
  { name: 'PYUSD', mint: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', expectProgram: 'TOKEN_2022', expectVeto: 'PERMANENT_DELEGATE_ACTIVE' },
];
// A launch from the last few minutes: the kind of mint Token Finder exists for.
const launchPage = await rpc.getSignatures(PUMPFUN_MINT_AUTHORITY, { limit: 5 });
const launchSig = launchPage.data?.find((s) => !s.failed)?.signature;
if (launchSig) {
  const t = normalizeTransaction((await rpc.getParsedTransaction(launchSig)).data);
  const launch = t ? parsePumpfunLaunch(t) : 'failed';
  if (typeof launch !== 'string') MINTS.push({ name: `fresh pump.fun launch ${launch.mint.slice(0, 6)}`, mint: launch.mint, expectProgram: 'TOKEN_2022' });
}

for (const m of MINTS) {
  const account = await rpc.getParsedAccount(m.mint);
  if (account.failure !== null) {
    check(false, m.name, `account read failed: ${account.failure.kind}`);
    continue;
  }
  const info = parseMint(account.data as never, null, true);
  const active = (info.extensions ?? []).filter((e) => e.active === true).map((e) => e.id);
  check(info.tokenProgram === m.expectProgram, `${m.name}: ${info.tokenProgram}`, `extensions ${info.extensions === null ? 'UNKNOWN' : `[${(info.extensions ?? []).map((e) => e.id).join(', ')}]`} complete=${info.extensionsComplete}; active: ${active.join(', ') || 'none'}; mint authority ${info.mintAuthority ?? 'revoked'}`);
  if (m.expectVeto === 'PERMANENT_DELEGATE_ACTIVE') {
    check(active.includes('permanentDelegate'), `${m.name}: permanent delegate read as active`);
  }
  check(info.top10Share === null, `${m.name}: with no holder read, concentration is UNKNOWN (null), not 0`);
}

// --- 2. the holder path --------------------------------------------------------
console.log('\n2. holder balances (getTokenLargestAccounts)');
const largest = await rpc.getLargestAccounts('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
if (largest.failure !== null) {
  console.log(`  --   unavailable on this endpoint: ${largest.failure.kind} (${largest.failure.message})`);
  const account = await rpc.getParsedAccount('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
  const info = parseMint(account.data as never, null, true);
  check(info.top10Share === null && info.largestAccountsCount === null, 'the failure degrades to UNKNOWN concentration, supply still read', `supply ${info.rawSupply}`);
} else {
  const account = await rpc.getParsedAccount('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
  const info = parseMint(account.data as never, largest.data as never, false);
  check(info.top10Share !== null && info.top10Share > 0 && info.top10Share <= 1, 'exact top-10 share from raw balances', String(info.top10Share));
}

// --- 3. history, parsed transactions, activity, transfers ------------------------
console.log('\n3. transaction history and activity');
if (launchSig) {
  const t = normalizeTransaction((await rpc.getParsedTransaction(launchSig)).data);
  const launch = t ? parsePumpfunLaunch(t) : 'failed';
  if (typeof launch !== 'string' && launch.pool) {
    check(launch.poolConfirmed, `launch ${launch.mint.slice(0, 6)}: curve ${launch.pool.slice(0, 6)} confirmed by account creation`);
    const history = await rpc.getSignatures(launch.pool, { limit: 25 });
    check(history.failure === null, `curve history: ${history.data?.length ?? 0} signatures`);
    let swaps = 0;
    let unresolved = 0;
    let edges = 0;
    for (const s of (history.data ?? []).filter((x) => !x.failed).slice(0, 8)) {
      const tx = normalizeTransaction((await rpc.getParsedTransaction(s.signature)).data);
      if (!tx) continue;
      const a = derivePoolActivity(tx, launch.mint, launch.pool);
      if (a.kind === 'SWAP') swaps += 1;
      if (a.kind === 'UNRESOLVED') unresolved += 1;
      edges += transferEdges(tx, launch.mint, new Set([launch.pool])).length;
    }
    check(true, `curve activity read: ${swaps} swaps, ${unresolved} unresolved, ${edges} wallet-to-wallet edges`);
  }
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`} via ${endpoint.label}`);
process.exitCode = failures === 0 ? 0 : 1;
