// @ts-check
/**
 * System: what this instance can check, and whether it is working.
 *
 * The honest answer to "how much should I trust this Board?" depends on the
 * running configuration as much as on any token. Without a Helius key the
 * Token-2022 checks never run; that belongs in plain sight, not in a log line.
 */

import { html, render } from '../lib/html.js';
import { api } from '../lib/api.js';
import { bytes, count, duration, share, span, when } from '../lib/format.js';
import { onServerEvent } from '../lib/live.js';
import { emptyState, errorState, skeleton, timeAgo } from '../ui/components.js';

const STATE = /** @type {Record<string, { label: string, tone: string }>} */ ({
  ON: { label: 'On', tone: 'good' },
  DEGRADED: { label: 'Degraded', tone: 'warn' },
  OFF: { label: 'Off', tone: 'bad' },
  DISABLED: { label: 'Disabled', tone: 'neutral' },
});

/** @param {any} capability */
function capabilityCard(capability) {
  const state = STATE[capability.state] ?? { label: capability.state, tone: 'neutral' };
  return html`<li class="capability capability--${state.tone}">
    <div class="capability__head">
      <h3 class="capability__label">${capability.label}</h3>
      <span class="tag tag--${state.tone}">${state.label}</span>
    </div>
    <p class="capability__summary">${capability.summary}</p>
    ${capability.impact ? html`<p class="capability__impact">${capability.impact}</p>` : ''}
    ${capability.state === 'OFF' && capability.enableWith ? html`<p class="capability__enable">Enable with <code>${capability.enableWith}</code></p>` : ''}
  </li>`;
}

const HEALTH = /** @type {Record<string, { label: string, tone: string }>} */ ({
  AVAILABLE: { label: 'Collecting', tone: 'good' },
  PARTIAL: { label: 'Partial', tone: 'warn' },
  STALE: { label: 'Stale', tone: 'warn' },
  UNAVAILABLE: { label: 'Not collecting', tone: 'neutral' },
  FAILED: { label: 'Failed', tone: 'bad' },
});

/**
 * On-chain collection: whether it runs, from where, and what it has - with its
 * gaps stated beside its totals.
 * @param {any} ing
 */
function ingestionPanel(ing) {
  if (!ing) return '';
  const health = HEALTH[ing.health.state] ?? { label: ing.health.state, tone: 'neutral' };
  const c = ing.collected;
  const last = ing.lastCycle;
  const kinds = c ? c.activityByKind : {};
  return html`<section class="panel" aria-labelledby="ingest-title">
    <h2 id="ingest-title" class="panel__title">On-chain data collection</h2>
    <p class="small"><span class="tag tag--${health.tone}">${health.label}</span> ${ing.health.reason}</p>
    <dl class="kv">
      <div><dt>Source</dt><dd><code>${ing.source}</code>${ing.keyed ? '' : html` <span class="small muted">public endpoint, rate-limited; set HELIUS_API_KEY or SOLANA_RPC_URL for more</span>`}</dd></div>
      ${last ? html`<div><dt>Last cycle</dt><dd>${timeAgo(last.at)} · ${duration(last.durationMs)} · ${count(last.rpcCalls)} calls${last.rpcFailures ? html` · <span class="tone--warn">${count(last.rpcFailures)} failed</span>` : ''}${ing.throttled ? html` · <span class="small muted">${count(ing.throttled)} throttled since start</span>` : ''}</dd></div>` : ''}
      ${c ? html`
        <div><dt>Launches read on-chain</dt><dd>${count(c.launchesLastHour)} in the last hour · ${count(c.launches)} stored</dd></div>
        <div><dt>Pool transactions</dt><dd>${count(kinds.SWAP ?? 0)} trades · ${count((kinds.LIQUIDITY_ADDED ?? 0) + (kinds.LIQUIDITY_REMOVED ?? 0))} liquidity · <span title="the balances did not settle what happened">${count(kinds.UNRESOLVED ?? 0)} unresolved</span></dd></div>
        <div><dt>Wallets observed</dt><dd>${count(c.wallets)} · ${count(c.edges)} transfer edges</dd></div>
        <div><dt>Gaps</dt><dd>${c.gapsLastDay === 0 ? 'None in the last day' : html`${count(c.gapsLastDay)} in the last day${c.skippedLastDay ? ` · ${count(c.skippedLastDay)} transactions not collected` : ''}`}</dd></div>
        ${c.latestBlockTime ? html`<div><dt>Newest chain data</dt><dd>${timeAgo(c.latestBlockTime)}</dd></div>` : ''}` : ''}
      ${ing.chainLead && ing.chainLead.mints > 0 && ing.chainLead.medianLeadMs !== null ? html`<div><dt>Chain vs. feeds</dt><dd>${count(ing.chainLead.mints)} mints seen by both; ${ing.chainLead.medianLeadMs >= 0 ? `the chain saw them ${duration(ing.chainLead.medianLeadMs)} earlier` : `the feeds saw them ${duration(-ing.chainLead.medianLeadMs)} earlier`} (median)${ing.chainLead.medianFeedDelayMs !== null ? html`<br><span class="small muted">A feed first listed them ${duration(Math.max(0, ing.chainLead.medianFeedDelayMs))} after their launch block (median).</span>` : ''}</dd></div>` : ''}
    </dl>
    <p class="small muted">Collection covers tokens that pass the fast screen, within a per-cycle budget. What the budget leaves out is recorded as a gap, never filled in.</p>
  </section>`;
}

const INTEL_HEALTH = /** @type {Record<string, { label: string, tone: string }>} */ ({
  AVAILABLE: { label: 'Running', tone: 'good' },
  PARTIAL: { label: 'Partial', tone: 'warn' },
  STALE: { label: 'Stale', tone: 'warn' },
  UNAVAILABLE: { label: 'Not running', tone: 'neutral' },
  FAILED: { label: 'Failed', tone: 'bad' },
});

/** @param {Record<string, number> | null | undefined} counts */
function tally(counts) {
  const entries = Object.entries(counts ?? {}).filter(([, n]) => n > 0);
  if (entries.length === 0) return 'None';
  return entries.map(([k, n]) => `${k.toLowerCase().replaceAll('_', ' ')} ${count(n)}`).join(' · ');
}

/**
 * Deep intelligence, as diagnostics only: health, what it has produced and
 * what its budgets cut. It feeds no score and no verdict.
 * @param {any} intel
 */
function intelligencePanel(intel) {
  if (!intel) return '';
  const health = INTEL_HEALTH[intel.health.state] ?? { label: intel.health.state, tone: 'neutral' };
  const p = intel.produced;
  const last = intel.lastCycle;
  const guard = intel.largestAccountsGuard;
  return html`<section class="panel" aria-labelledby="intel-title">
    <h2 id="intel-title" class="panel__title">Deep intelligence (diagnostics)</h2>
    <p class="small"><span class="tag tag--${health.tone}">${health.label}</span> ${intel.health.reason}</p>
    <dl class="kv">
      ${last ? html`<div><dt>Last cycle</dt><dd>${timeAgo(last.at)} · ${duration(last.durationMs)} · ${count(last.tokens)} tokens · ${count(last.requests)} of ${count(last.requestLimit)} requests${last.failures ? html` · <span class="tone--warn">${count(last.failures)} failed</span>` : ''}${last.truncations ? html` · <span class="small muted">${count(last.truncations)} truncations</span>` : ''}</dd></div>` : ''}
      ${p ? html`
        <div><dt>Wallets profiled</dt><dd>${count(p.profiles)}<br><span class="small muted">${tally(p.byClass)}</span></dd></div>
        <div><dt>Funding</dt><dd><span class="small">${tally(p.fundingByClass)}</span></dd></div>
        <div><dt>Relationship graph</dt><dd>${count(p.edges)} edges · ${count(p.clusters)} clusters<br><span class="small muted">${tally(p.clustersByLevel)}</span></dd></div>
        <div><dt>Attribution</dt><dd><span class="small">${tally(p.attributionByStatus)}</span></dd></div>
        <div><dt>Creator history</dt><dd><span class="small">${tally(p.creatorsByStatus)}</span></dd></div>
        <div><dt>Security events</dt><dd><span class="small">${tally(p.securityByStatus)}</span></dd></div>
        <div><dt>Tokens analysed</dt><dd>${count(p.tokensAnalyzed)}${p.lastAnalyzedAt ? html` · last ${timeAgo(p.lastAnalyzedAt)}` : ''}</dd></div>` : ''}
      ${intel.recent.length ? html`<div><dt>Recent</dt><dd><ul class="small plain">${intel.recent.map(
        (/** @type {any} */ t) => html`<li><code>${t.mint.slice(0, 6)}…</code> coverage ${share(t.coverage)} · wash ${String(t.wash).toLowerCase().replaceAll('_', ' ')} · activity ${String(t.activity).toLowerCase().replaceAll('_', ' ')} · network ${String(t.network).toLowerCase().replaceAll('_', ' ')}${t.securityEvents ? ` · ${t.securityEvents} events` : ''}${t.truncated ? ` · ${t.truncated} truncated` : ''}</li>`,
      )}</ul></dd></div>` : ''}
      ${guard ? html`<div><dt>Largest-accounts guard</dt><dd>${guard.breakerOpenUntil ? html`<span class="tag tag--warn">Paused</span> until ${when(guard.breakerOpenUntil)} · ` : ''}${count(guard.calls)} calls · ${count(guard.skipped)} skipped · ${count(guard.overloads)} overloads · ${count(guard.timeouts)} timeouts</dd></div>` : ''}
    </dl>
    <p class="small muted">Diagnostics for engineering only. None of this feeds a score, a ranking or a veto yet, and nothing here is calibrated.</p>
  </section>`;
}

/** @param {{ label: string, count: number }[]} buckets */
function distribution(buckets) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return html`<ul class="bars">
    ${buckets.map(
      (b) => html`<li class="bars__row">
        <span class="bars__label">${b.label}</span>
        <svg class="bars__bar" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><rect x="0" y="0" width="${((b.count / max) * 100).toFixed(1)}" height="10" rx="2"></rect></svg>
        <span class="bars__value">${count(b.count)}</span>
      </li>`,
    )}
  </ul>`;
}

/** @param {any} s */
function template(s) {
  const scan = s.scan;
  const cov = s.coverage;
  const db = s.persistence.database;
  const off = s.capabilities.filter((c) => c.state === 'OFF' && c.metrics.length > 0);

  return html`<section class="system-page" aria-labelledby="system-title">
    <header class="page-head">
      <h1 id="system-title">System</h1>
      <p class="page-head__sub">${off.length
        ? html`<span class="tone--warn">${off.length} safety check${off.length === 1 ? ' is' : 's are'} off in this configuration.</span> Verdicts are reached without ${off.map((c) => c.label.toLowerCase()).join(', ')}.`
        : 'Every safety check is available in this configuration.'}</p>
    </header>

    <section aria-labelledby="cap-title">
      <h2 id="cap-title" class="section-title">What this instance can check</h2>
      <ul class="capabilities">${s.capabilities.map(capabilityCard)}</ul>
    </section>

    <div class="system-grid">
      <section class="panel" aria-labelledby="scan-title">
        <h2 id="scan-title" class="panel__title">Scanning</h2>
        <dl class="kv">
          <div><dt>Status</dt><dd>${scan.scanning ? html`<span class="tag tag--warn">Scanning now</span>` : html`<span class="tag tag--good">Idle</span>`}</dd></div>
          <div><dt>Last scan</dt><dd>${scan.lastScanAt ? html`${timeAgo(scan.lastScanAt)} <span class="small muted">${when(scan.lastScanAt)}</span>` : 'Never'}</dd></div>
          <div><dt>Interval</dt><dd>every ${duration(scan.intervalSec * 1000)}</dd></div>
          <div><dt>Scans recorded</dt><dd>${count(scan.scanCount)}</dd></div>
          ${scan.last ? html`
            <div><dt>Last scan took</dt><dd>${duration(scan.last.durationMs)}</dd></div>
            <div><dt>Analysed</dt><dd>${count(scan.last.analyzed)} of ${count(scan.last.candidates)} candidates · ${count(scan.last.fresh)} new</dd></div>
            <div><dt>Provider failures</dt><dd>${scan.last.providerFailures.length === 0 ? 'None' : scan.last.providerFailures.map((f) => html`<span class="tag tag--warn">${f.provider}: ${f.kind}</span> `)}</dd></div>` : ''}
        </dl>
        ${s.providers.length ? html`<p class="small tone--warn">In the last hour: ${s.providers.map((p) => `${p.provider} failed ${p.count}×`).join(', ')}.</p>` : ''}
      </section>

      <section class="panel" aria-labelledby="universe-title">
        <h2 id="universe-title" class="panel__title">What is on the Board</h2>
        <dl class="kv">
          <div><dt>Live</dt><dd><strong>${count(cov.universe.live)}</strong> <span class="small muted">evaluated within ${span(s.window.liveMinutes)}</span></dd></div>
          <div><dt>History only</dt><dd>${count(cov.universe.stale)} <span class="small muted">evaluated earlier; their verdicts describe the past</span></dd></div>
          <div><dt>Never evaluated</dt><dd>${count(cov.universe.unevaluated)} <span class="small muted">imported market data with no safety assessment</span></dd></div>
        </dl>
        <p class="small muted">A token leaves the live Board ${span(s.window.liveMinutes)} after its last evaluation — the same point at which the engine stops trusting its market evidence. Its history is kept.</p>
      </section>

      <section class="panel" aria-labelledby="cov-title">
        <h2 id="cov-title" class="panel__title">Evidence coverage on the Board</h2>
        ${cov.universe.live === 0
          ? html`<p class="muted">No live tokens.</p>`
          : html`<p class="panel__lede">Average coverage <strong>${share(cov.meanCoverage)}</strong> · average confidence <strong>${share(cov.meanConfidence)}</strong></p>
            ${distribution(cov.distribution)}
            ${cov.unknownSignals.length ? html`<p class="small muted">Most often not measured: ${cov.unknownSignals.slice(0, 4).map((u) => `${u.label} (${u.count})`).join(', ')}.</p>` : ''}
            ${cov.vetoes.length ? html`<p class="small">Live vetoes: ${cov.vetoes.map((v) => `${v.label} (${v.count})`).join(', ')}.</p>` : ''}`}
      </section>

      ${ingestionPanel(s.ingestion)}

      ${intelligencePanel(s.intelligence)}

      <section class="panel" aria-labelledby="db-title">
        <h2 id="db-title" class="panel__title">History database</h2>
        ${s.persistence.healthy
          ? html`<p class="tone--good small">Recording normally.</p>`
          : html`<p class="notice notice--error" role="alert"><strong>History is not being recorded.</strong> ${s.persistence.failure ? `${s.persistence.failure.kind} during ${s.persistence.failure.operation}: ${s.persistence.failure.message}` : ''} Analysis continues; nothing is lost from the live view.</p>`}
        ${db
          ? html`<dl class="kv">
              <div><dt>File</dt><dd><code>${db.file}</code> · ${bytes(db.sizeBytes)}</dd></div>
              <div><dt>Schema</dt><dd>v${db.schemaVersion}${db.schemaCurrent ? '' : html` <span class="tag tag--bad">out of date</span>`}</dd></div>
              <div><dt>Integrity</dt><dd>${db.integrity === 'ok' ? html`<span class="tag tag--good">OK</span>` : html`<span class="tag tag--bad">Failed</span>`}</dd></div>
              <div><dt>History</dt><dd>${db.oldestSnapshotAt ? `${when(db.oldestSnapshotAt)} → ${when(db.newestSnapshotAt)}` : 'Empty'}</dd></div>
              <div><dt>Verdict transitions</dt><dd>${count(db.transitions)} <span class="small muted">never pruned</span></dd></div>
              <div><dt>Stored observations</dt><dd>${count(db.rows.token_snapshots)} verdicts · ${count(db.rows.market_snapshots)} market · ${count(db.rows.evidence_snapshots)} evidence</dd></div>
            </dl>`
          : emptyState('The history database is not open.')}
      </section>
    </div>
  </section>`;
}

/**
 * @param {HTMLElement} root
 */
export function mountSystem(root) {
  let disposed = false;
  /** @type {any} */
  let data = null;
  const load = async () => {
    try {
      data = await api('/api/system');
      if (!disposed) render(root, template(data));
    } catch (error) {
      if (!disposed && !data) render(root, errorState('System status could not be loaded.', error instanceof Error ? error.message : String(error)));
    }
  };
  const onClick = (/** @type {MouseEvent} */ event) => {
    if (/** @type {HTMLElement} */ (event.target).closest('[data-action="retry"]')) void load();
  };
  root.addEventListener('click', onClick);
  const off = onServerEvent((kind) => {
    if (kind === 'scan' || kind === 'scan-start' || kind === 'scan-failed' || kind === 'reconnected') void load();
  });
  render(root, skeleton(8));
  void load();
  document.title = 'System — Token Finder';
  return {
    dispose() {
      disposed = true;
      off();
      root.removeEventListener('click', onClick);
    },
  };
}
