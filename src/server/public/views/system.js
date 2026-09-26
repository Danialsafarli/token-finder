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
