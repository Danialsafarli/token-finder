import { config } from './config.ts';
import { log } from './util/logger.ts';
import { fmtAge, fmtPct, fmtUsd } from './util/num.ts';
import { discover } from './core/discover.ts';
import { analyze } from './core/analyze.ts';
import { runScan, startMonitor } from './core/monitor.ts';
import { formatBytes, store } from './core/store.ts';
import { serve } from './server/index.ts';
import * as dexscreener from './sources/dexscreener.ts';
import type { TokenSnapshot } from './types.ts';

const HELP = `
token-finder - discover, analyze, rank and monitor new Solana tokens

  node src/cli.ts serve            dashboard + background monitor (default)
  node src/cli.ts scan             run one discovery pass and print the top results
  node src/cli.ts rank [n]         print the current ranking from stored state
  node src/cli.ts watch            run the monitor in the terminal, no dashboard
  node src/cli.ts analyze <mint>   deep-dive one token (mint address or symbol)
  node src/cli.ts reset            clear stored tokens, history and events
  node src/cli.ts db               database size, schema version and row counts
  node src/cli.ts typesafe-check   one request to verify TypeSafe credentials

Options come from .env - see .env.example.
`;

function pad(value: string, width: number, right = false): string {
  const text = value.length > width ? `${value.slice(0, width - 1)}…` : value;
  return right ? text.padStart(width) : text.padEnd(width);
}

function printTable(tokens: TokenSnapshot[]): void {
  if (tokens.length === 0) {
    log.warn('nothing to show - run a scan first');
    return;
  }

  const header = [
    pad('#', 3, true),
    pad('SYMBOL', 12),
    pad('SCORE', 6, true),
    pad('GR', 3),
    pad('PRICE', 11, true),
    pad('1H', 8, true),
    pad('LIQ', 9, true),
    pad('VOL24', 9, true),
    pad('HOLDERS', 8, true),
    pad('AGE', 6, true),
    'RISK',
  ].join(' ');

  console.log(log.paint('dim', header));

  tokens.forEach((token, index) => {
    const worst = token.score.flags.find((flag) => flag.level === 'critical' || flag.level === 'high');
    const risk = worst ? worst.code : '-';
    // Null means never measured, so it prints as '-' rather than a green 0.0%.
    const change = token.priceChange === null ? null : token.priceChange.h1;

    console.log(
      [
        pad(String(index + 1), 3, true),
        pad(token.symbol, 12),
        pad(token.score.total.toFixed(1), 6, true),
        pad(token.score.grade, 3),
        pad(fmtUsd(token.priceUsd), 11, true),
        change === null
          ? log.paint('dim', pad('-', 8, true))
          : log.paint(change >= 0 ? 'green' : 'red', pad(fmtPct(change), 8, true)),
        pad(fmtUsd(token.liquidityUsd), 9, true),
        pad(fmtUsd(token.volume24h), 9, true),
        pad(token.holders === null ? '-' : token.holders.toLocaleString('en-US'), 8, true),
        pad(fmtAge(token.ageHours), 6, true),
        worst ? log.paint('yellow', risk) : log.paint('dim', risk),
      ].join(' '),
    );
  });
}

function printDetail(token: TokenSnapshot): void {
  console.log('');
  console.log(
    `${log.paint('cyan', token.symbol)} ${token.name ? log.paint('dim', token.name) : ''}  ${log.paint('dim', token.mint)}`,
  );
  console.log(
    `score ${token.score.total} (${token.score.grade})  base ${token.score.base}  penalty -${token.score.penalty}%`,
  );
  // Snapshots stored before evidence tracking existed have no coverage field.
  if (typeof token.score.coverage === 'number') {
    const unknown = token.score.unknown ?? [];
    console.log(
      `evidence ${Math.round(token.score.coverage * 100)}% covered  ceiling ${token.score.ceiling}${
        unknown.length > 0 ? `  unknown: ${unknown.join(', ')}` : ''
      }`,
    );
  }
  console.log(
    `price ${fmtUsd(token.priceUsd)}  liq ${fmtUsd(token.liquidityUsd)}  vol24 ${fmtUsd(token.volume24h)}  mcap ${fmtUsd(token.marketCap)}  holders ${token.holders ?? '-'}  age ${fmtAge(token.ageHours)}`,
  );

  console.log(`\n${log.paint('dim', 'breakdown')}`);
  for (const component of token.score.components) {
    if (component.value === null) {
      // An unknown component gets no bar at all: an empty bar would read as a
      // measured zero, which is the confusion this whole change removes.
      console.log(
        `  ${pad(component.label, 13)} ${log.paint('dim', '─'.repeat(20))} ${pad('?', 3, true)}  ${log.paint('dim', `unknown - ${component.unknownReason ?? 'no evidence'}`)}`,
      );
      continue;
    }
    const filled = Math.round(component.value * 20);
    const bar = `${'█'.repeat(filled)}${'░'.repeat(20 - filled)}`;
    console.log(
      `  ${pad(component.label, 13)} ${bar} ${pad((component.value * 100).toFixed(0), 3, true)}  ${log.paint('dim', component.detail)}`,
    );
  }

  console.log(`\n${log.paint('dim', 'flags')}`);
  if (token.score.flags.length === 0) console.log('  none');
  for (const flag of token.score.flags) {
    const color = flag.level === 'critical' || flag.level === 'high' ? 'red' : flag.level === 'medium' ? 'yellow' : 'dim';
    console.log(`  ${log.paint(color, `[${flag.level}]`)} ${flag.message}`);
  }

  console.log(`\n${log.paint('dim', 'links')}`);
  console.log(`  https://dexscreener.com/solana/${token.mint}`);
  console.log(`  https://rugcheck.xyz/tokens/${token.mint}`);
  console.log(`  https://jup.ag/swap/SOL-${token.mint}`);
  console.log('');
}

const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function cmdScan(): Promise<void> {
  log.step('discovering…');
  const result = await runScan();
  log.ok(
    `${result.candidates} candidates → ${result.analyzed} analyzed (${result.fresh} new) in ${(result.durationMs / 1000).toFixed(1)}s`,
  );
  console.log('');
  printTable(result.top);

  if (result.events.length > 0) {
    console.log(`\n${log.paint('dim', 'events')}`);
    for (const event of result.events.slice(0, 10)) console.log(`  [${event.level}] ${event.message}`);
  }
}

function cmdRank(limit: number): void {
  const tokens = store
    .tokens()
    .sort((a, b) => b.score.total - a.score.total)
    .slice(0, limit);

  if (store.lastScanAt) {
    log.info(
      log.paint('dim', `from scan #${store.scanCount} at ${new Date(store.lastScanAt).toLocaleString()}`),
    );
  }
  printTable(tokens);
}

async function cmdAnalyze(target: string): Promise<void> {
  let mint = target;

  if (!MINT_PATTERN.test(target)) {
    log.step(`searching for "${target}"…`);
    const matches = await dexscreener.search(target);
    if (matches.length === 0) {
      log.error('no Solana token matched that symbol');
      process.exitCode = 1;
      return;
    }
    mint = matches[0]!.mint;
    log.info(`matched ${matches[0]!.symbol} (${mint})`);
  }

  const result = await analyze([{ mint, sources: ['cli'] }], { includeAll: true, deepLimit: 1 });
  const snapshot = result.snapshots[0];

  for (const failure of [...result.providerFailures, ...result.failures.map((f) => f.failure)]) {
    log.warn(`${failure.provider} unavailable (${failure.kind}): ${failure.message}`);
  }

  if (!snapshot) {
    log.error('no market data found for that mint - it may have no live pool');
    process.exitCode = 1;
    return;
  }

  printDetail(snapshot);
  store.upsert(snapshot);
  store.save();
}

async function cmdWatch(): Promise<void> {
  log.step(`monitoring every ${config.scanIntervalSec}s - Ctrl+C to stop`);
  startMonitor();
}

/**
 * Database health, for an operator who wants to know whether history is
 * actually being collected. Read-only: it reports and never repairs.
 */
function cmdDb(): void {
  const failure = store.persistenceFailure();
  if (failure !== null) {
    log.error(`persistence is DEGRADED: ${failure.kind} during ${failure.operation}`);
    log.error(failure.message);
    log.warn('analysis still runs; history is NOT being recorded');
    process.exitCode = 1;
    return;
  }

  const d = store.diagnostics();
  if (d === null) {
    log.error('no database is open');
    process.exitCode = 1;
    return;
  }

  const when = (ms: number | null): string =>
    ms === null ? '-' : new Date(ms).toISOString();

  log.ok(`database ${d.path}`);
  console.log(`  size            ${formatBytes(d.sizeBytes)}`);
  console.log(
    `  schema          v${d.schemaVersion} of v${d.targetSchemaVersion}` +
      (d.schemaCurrent ? '' : log.paint('yellow', '  (NOT CURRENT)')),
  );
  console.log(`  integrity       ${d.integrity.ok ? 'ok' : log.paint('red', d.integrity.detail)}`);
  console.log(`  oldest snapshot ${when(d.oldestSnapshotAt)}`);
  console.log(`  newest snapshot ${when(d.newestSnapshotAt)}`);
  console.log(`  transitions     ${d.transitionCount} (never pruned)`);
  console.log('  rows');
  for (const [table, count] of Object.entries(d.rowCounts)) {
    console.log(`    ${pad(table, 20)} ${String(count).padStart(9)}`);
  }
  console.log('  legacy import');
  console.log(`    completed     ${d.legacyImport.completedAt ?? 'never'}`);
  console.log(`    source        ${d.legacyImport.source ?? '-'}`);
  console.log(`    counts        ${d.legacyImport.counts ?? '-'}`);
}

async function main(): Promise<void> {
  const [command = 'serve', ...rest] = process.argv.slice(2);

  switch (command) {
    case 'serve':
      serve();
      break;

    case 'scan':
      await cmdScan();
      store.save();
      break;

    case 'rank':
      cmdRank(Number(rest[0] ?? 25));
      break;

    case 'db':
      cmdDb();
      break;

    case 'watch':
      await cmdWatch();
      break;

    case 'analyze': {
      const target = rest[0];
      if (!target) {
        log.error('usage: node src/cli.ts analyze <mint|symbol>');
        process.exitCode = 1;
        break;
      }
      await cmdAnalyze(target);
      break;
    }

    case 'discover': {
      const candidates = await discover();
      log.ok(`${candidates.length} candidate mints`);
      for (const candidate of candidates.slice(0, 40)) {
        console.log(`  ${candidate.mint}  ${log.paint('dim', candidate.sources.join(', '))}`);
      }
      break;
    }

    case 'reset':
      store.reset();
      log.ok('state cleared');
      break;

    case 'typesafe-check': {
      // Proves credentials and connectivity with exactly one request, without
      // running a scan. Never prints the key or any part of it.
      const { verifyConnectivity } = await import('./sources/typesafe.ts');
      log.step(`checking TypeSafe connectivity (model ${config.typesafeModel})…`);
      const result = await verifyConnectivity();
      if (result.ok) log.ok(`TypeSafe reachable - ${result.detail}`);
      else {
        log.error(`TypeSafe check failed - ${result.detail}`);
        process.exitCode = 1;
      }
      break;
    }

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;

    default:
      log.error(`unknown command: ${command}`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
