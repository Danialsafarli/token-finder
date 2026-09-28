import { config } from './config.ts';
import { log } from './util/logger.ts';
import { fmtAge, fmtPct, fmtUsd } from './util/num.ts';
import { discover } from './core/discover.ts';
import { analyze } from './core/analyze.ts';
import { redecideAnalysed, runScan, startMonitor } from './core/monitor.ts';
import { DB_PATH, formatBytes, store } from './core/store.ts';
import { countUniverse, isSurvivor, liveTokens, rankKey, VERDICT_TIER } from './core/ranking.ts';
import { makeDecider } from './decision/inputs.ts';
import { serve } from './server/index.ts';
import * as dexscreener from './sources/dexscreener.ts';
import type { TokenSnapshot } from './types.ts';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { formatCalibration, runCalibration } from './calibration/replay.ts';
import { CalibrationReader } from './persist/calibration-reader.ts';

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
  node src/cli.ts ingest           run one on-chain collection cycle and report it
  node src/cli.ts chain            what the data backbone has collected
  node src/cli.ts activity <mint>  a tracked token's collected trades and buyers
  node src/cli.ts intel-run        run one deep-intelligence cycle and report it
  node src/cli.ts intel <mint> [--run]
                                   a token's stored deep intelligence; --run
                                   analyses it now, within the cycle budgets
  node src/cli.ts calibrate [--db path] [--json out.json]
                                   replay stored verdicts against measured
                                   outcomes (read-only; use a copy of the DB)

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
    pad('VERDICT', 14),
    pad('RANK', 5, true),
    pad('INTEGRITY', 9),
    pad('MOMENTUM', 12),
    pad('SCORE', 6, true),
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
        pad(token.evaluation?.eligibility ?? '-', 14),
        pad(token.decision?.rankScore == null ? '-' : token.decision.rankScore.toFixed(0), 5, true),
        pad(token.decision?.integrity.band ?? '-', 9),
        pad(token.decision?.momentum.state ?? '-', 12),
        pad(token.score.total.toFixed(1), 6, true),
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

  const d = token.decision;
  if (d) {
    console.log(`\n${log.paint('cyan', `verdict ${d.verdict}`)}  ${log.paint('dim', `${d.basis} · ${d.policyVersion}`)}`);
    console.log(
      `rank ${d.rankScore ?? '-'}  integrity ${d.integrity.score ?? '-'} (${d.integrity.band}, coverage ${Math.round(d.integrity.coverage * 100)}%)  opportunity ${d.opportunity.score} (${d.opportunity.band})  momentum ${d.momentum.state}  coverage ${Math.round(d.coverage.decision * 100)}% (market ${Math.round(d.coverage.market * 100)}%, intelligence ${Math.round(d.coverage.intelligence * 100)}%)`,
    );
    for (const reason of d.reasons) {
      const mark = reason.kind === 'positive' ? '+' : reason.kind === 'risk' || reason.kind === 'hard_fail' ? '-' : reason.kind === 'blocker' ? '↑' : '·';
      console.log(`  ${mark} ${reason.text}`);
    }
    console.log(`\n${log.paint('dim', 'intelligence')}`);
    for (const domain of d.intelligence.domains) {
      console.log(`  ${pad(domain.key, 13)} ${pad(domain.status, 17)} coverage ${pad(String(Math.round(domain.coverage * 100)), 3, true)}%  ${log.paint('dim', domain.note.slice(0, 90))}`);
    }
  }

  console.log(`\n${log.paint('dim', 'breakdown (score@1)')}`);
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
  // The same live universe the dashboard ranks: evaluated, and evaluated
  // recently enough that its market evidence is still current.
  const now = Date.now();
  const all = store.tokens();
  const counts = countUniverse(all, now, config.liveWindowMin * 60_000);
  const tokens = liveTokens(all, now, config.liveWindowMin * 60_000)
    .sort(
      (a, b) =>
        VERDICT_TIER[a.evaluation!.eligibility] - VERDICT_TIER[b.evaluation!.eligibility] ||
        rankKey(b) - rankKey(a),
    )
    .slice(0, limit);

  log.info(
    log.paint(
      'dim',
      `${counts.live} live (evaluated within ${config.liveWindowMin}m) · ${counts.stale} stale · ${counts.unevaluated} never evaluated - only live tokens are ranked`,
    ),
  );

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

  const previous = store.token(mint)?.evaluation?.state;
  const decide = makeDecider(store.decisionSources(), { minCoverageQualify: config.minCoverageQualify, minCoverageWatch: config.minCoverageWatch });
  const result = await analyze([{ mint, sources: ['cli'] }], {
    includeAll: true,
    deepLimit: 1,
    decide,
    ...(previous ? { priorStates: new Map([[mint, previous]]) } : {}),
  });
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

async function cmdIngest(): Promise<void> {
  const { runIngestionCycle } = await import('./ingest/runner.ts');
  const { liveIngestDeps } = await import('./ingest/wiring.ts');
  const deps = liveIngestDeps();
  log.step(`one collection cycle via ${deps.source}…`);
  const r = await runIngestionCycle(deps);
  log.ok(`${r.health.state} in ${(r.durationMs / 1000).toFixed(1)}s - ${r.health.reason}`);
  if (r.launches) {
    const l = r.launches;
    console.log(`  launches   ${l.signaturesSeen} seen, ${l.failedSkipped} failed (skipped), ${l.alreadyKnown} known, ${l.fetched} fetched, ${l.recorded} new, ${l.skippedOverBudget} over budget, ${l.fetchFailed} fetch failed`);
  }
  const s = r.deep.skipped;
  console.log(`  survivors  ${r.deep.pools.length} collected · left out: ${s.notSurvivor} not survivors, ${s.notLive} not live, ${s.noPool} no pool, ${s.overBudget} over budget`);
  for (const p of r.deep.pools) {
    const kinds = Object.entries(p.byKind).map(([k, v]) => `${k} ${v}`).join(', ') || 'nothing new';
    console.log(`    ${p.mint.slice(0, 8)} ${p.tier.padEnd(9)} ${p.fetched}/${p.signaturesSeen} fetched · ${kinds}${p.error ? ` · error ${p.error}` : ''}`);
  }
  console.log(`  rpc        ${r.rpc.calls} calls, ${r.rpc.failures} failed, ${r.rpc.rateLimited} rate-limited`);
  store.save();
}

async function cmdIntelRun(): Promise<void> {
  const { runIntelCycle, noteIntelCycle } = await import('./intel/runner.ts');
  const { liveIntelDeps } = await import('./intel/wiring.ts');
  const deps = liveIntelDeps();
  log.step(`one intelligence cycle via ${deps.source}…`);
  const r = await runIntelCycle(deps);
  noteIntelCycle(r, deps.source, config.intelIntervalSec);
  log.ok(`${r.health.state} in ${(r.durationMs / 1000).toFixed(1)}s - ${r.health.reason}`);
  const s = r.skipped;
  console.log(`  tokens     ${r.tokens.length} analysed · left out: ${s.notSurvivor} not survivors, ${s.notLive} not live, ${s.recentlyAnalyzed} analysed recently, ${s.overBudget} over budget`);
  for (const t of r.tokens) printTokenReport(t);
  console.log(`  requests   ${r.budget.requests} of ${r.budget.limit} · ${r.failures.length} failed`);
  const re = redecideAnalysed(r.tokens.filter((t) => t.error === null).map((t) => t.mint), r.tokens.filter((t) => t.error === null && t.securityEvents > 0).map((t) => t.mint));
  console.log(`  decisions  ${re.checked} re-decided · ${re.changed.map((c) => `${c.mint.slice(0, 6)} ${c.from} -> ${c.to}`).join(', ') || 'no verdict changed'}`);
  store.save();
}

function printTokenReport(t: import('./intel/runner.ts').TokenReport): void {
  const w = t.wallets;
  console.log(`    ${t.mint.slice(0, 8)} ${t.tier.padEnd(9)} coverage ${t.coverage} · ${t.requests} requests${t.error ? ` · error ${t.error}` : ''}`);
  console.log(`      wallets ${w.selected} selected: ${w.analyzed} read, ${w.reused} reused, ${w.failed} failed, ${w.notRead} not read · funders ${t.funders.probed} probed, ${t.funders.cached} cached, ${t.funders.hops} hops`);
  console.log(`      graph ${t.edges} edges, ${t.clusters} clusters, ${t.weakPairs} weak pairs · wash ${t.wash} · activity ${t.activity}`);
  console.log(`      attribution ${t.attribution} · security events ${t.securityEvents} · network ${t.network}`);
  for (const x of t.truncation) console.log(`      truncated: ${x}`);
}

async function cmdIntel(mint: string, run: boolean): Promise<void> {
  const intel = store.intel();
  if (intel === null) {
    log.error('the database is not open');
    process.exitCode = 1;
    return;
  }
  if (run) {
    const { analyzeToken, IntelBudget } = await import('./intel/runner.ts');
    const { liveIntelDeps } = await import('./intel/wiring.ts');
    const deps = liveIntelDeps();
    const chain = store.chain();
    if (chain === null) return;
    const current = store.token(mint)?.evaluation?.eligibility;
    const tier = isSurvivor(current) ? current : 'WATCH';
    const budget = new IntelBudget(deps.settings.requestsPerCycle, Date.now() + deps.settings.cycleMaxMs, Date.now);
    const failures: import('./util/failure.ts').ProviderFailure[] = [];
    const started = Date.now();
    const report = await analyzeToken({ mint, tier }, { ...deps, chain, intel }, budget, failures);
    log.ok(`analysed in ${((Date.now() - started) / 1000).toFixed(1)}s · ${failures.length} request(s) failed`);
    printTokenReport(report);
    const re = redecideAnalysed([mint]);
    if (re.changed.length) log.info(`verdict ${re.changed[0]!.from} -> ${re.changed[0]!.to} on the new intelligence`);
    store.save();
  }
  const latest = intel.latestTokenIntelligence(mint);
  if (latest === null) {
    log.warn('no deep intelligence stored for this mint');
    return;
  }
  console.log(JSON.stringify({ ...latest, securityEvents: intel.eventsOf([mint]) }, null, 2));
}

function cmdChain(): void {
  const chain = store.chain();
  if (chain === null) {
    log.error('the database is not open');
    process.exitCode = 1;
    return;
  }
  const s = chain.stats();
  const lead = chain.chainLead(Date.now() - 24 * 3_600_000);
  console.log(`  transactions  ${s.transactions} (${s.transactionsLastHour} in the last hour, ${s.failedLastHour} failed)`);
  console.log(`  pool activity ${Object.entries(s.activityByKind).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  console.log(`  launches      ${s.launches} (${s.launchesLastHour} in the last hour)`);
  console.log(`  wallets       ${s.wallets} · edges ${s.edges} · chain events ${s.chainEvents} · discoveries ${s.discoveries}`);
  console.log(`  gaps          ${s.gapsLastDay} in the last day, ${s.skippedLastDay} transactions not collected`);
  console.log(`  newest block  ${s.latestBlockTime ? new Date(s.latestBlockTime).toISOString() : 'none'}`);
  if (lead.mints > 0 && lead.medianLeadMs !== null) {
    console.log(`  chain lead    ${lead.mints} mints seen by chain and feeds; median ${(lead.medianLeadMs / 1000).toFixed(0)}s (positive: chain first)`);
    if (lead.medianFeedDelayMs !== null) console.log(`  feed delay    a feed first listed them ${(lead.medianFeedDelayMs / 1000).toFixed(0)}s after the launch block (median)`);
  }
}

function cmdActivity(mint: string): void {
  const chain = store.chain();
  if (chain === null) {
    log.error('the database is not open');
    process.exitCode = 1;
    return;
  }
  const rows = chain.activityOf(mint, 25);
  const buyers = chain.buyerArrivals(mint, 15);
  const launch = chain.launch(mint);
  if (launch) console.log(`  launched ${launch.blockTime ? new Date(launch.blockTime).toISOString() : '?'} on ${launch.venue} by fee payer ${launch.feePayer}`);
  for (const d of chain.discoveriesOf(mint)) console.log(`  seen by ${d.source.padEnd(22)} first ${new Date(d.firstSeenAt).toISOString()} (${d.timesSeen}×)`);
  console.log(`  recent pool activity (${rows.length}):`);
  for (const r of rows) {
    console.log(`    slot ${r.slot} ${r.kind.padEnd(16)} ${(r.direction ?? '').padEnd(4)} ${(r.trader ?? '-').slice(0, 8).padEnd(8)} ${r.traderResolution ?? ''} ${r.priceInQuote !== null ? r.priceInQuote.toExponential(3) : ''} ${r.reason ?? ''}`);
  }
  console.log(`  first buyers observed (${buyers.length}):`);
  for (const b of buyers) console.log(`    slot ${b.firstSlot} ${b.wallet} buys ${b.buys} sells ${b.sells}${b.onCurve === false ? ' (program-derived)' : ''}`);
}

/** Read-only calibration replay over a database (default: the configured one). */
function cmdCalibrate(args: string[]): void {
  const at = (flag: string): string | undefined => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const path = at('--db') ?? DB_PATH;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const report = runCalibration(new CalibrationReader(db));
    console.log(formatCalibration(report));
    const out = at('--json');
    if (out) {
      writeFileSync(out, JSON.stringify(report, null, 2));
      log.ok(`report written to ${out}`);
    }
  } finally {
    db.close();
  }
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

    case 'ingest':
      await cmdIngest();
      break;

    case 'chain':
      cmdChain();
      break;

    case 'activity': {
      if (!rest[0]) {
        log.error('usage: node src/cli.ts activity <mint>');
        process.exitCode = 1;
        break;
      }
      cmdActivity(rest[0]);
      break;
    }

    case 'intel-run':
      await cmdIntelRun();
      break;

    case 'intel': {
      const target = rest.find((a) => !a.startsWith('--'));
      if (!target) {
        log.error('usage: node src/cli.ts intel <mint> [--run]');
        process.exitCode = 1;
        break;
      }
      await cmdIntel(target, rest.includes('--run'));
      break;
    }

    case 'calibrate':
      cmdCalibrate(rest);
      break;

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
