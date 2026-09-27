// @ts-check
/**
 * Token Dossier: /t/<mint>[/<tab>]
 *
 * The first screen answers five questions before anything else: what is the
 * verdict, why, how complete is the evidence, what is unknown, and how fresh is
 * it. Everything below is drill-down.
 *
 * Tabs come from a registry. Future phases (Activity, Buyers, Technical) add an
 * entry and a renderer; they are registered here as unavailable and are not
 * shown until they exist, so nothing unbuilt is presented as a feature.
 */

import { appUrl, html, render, safeUrl } from '../lib/html.js';
import { api, ApiError } from '../lib/api.js';
import { age, count, pct, price, share, shortAddress, usd, when } from '../lib/format.js';
import { onServerEvent } from '../lib/live.js';
import { attachTimeline, timeline } from '../ui/charts.js';
import {
  dossierUrl,
  emptyState,
  errorState,
  freshnessTag,
  meter,
  skeleton,
  stateTag,
  timeAgo,
  tokenIcon,
  toneClass,
  verdictChip,
} from '../ui/components.js';

/** @typedef {any} Dossier */

/** @type {{ id: string, label: string, available: boolean }[]} */
export const TABS = [
  { id: 'overview', label: 'Overview', available: true },
  { id: 'evidence', label: 'Evidence', available: true },
  { id: 'history', label: 'History', available: true },
  { id: 'contract', label: 'Contract & holders', available: true },
  // Registered so the structure does not change when they arrive. Not shown.
  { id: 'activity', label: 'Activity', available: false },
  { id: 'buyers', label: 'Buyers', available: false },
  { id: 'technical', label: 'Technical', available: false },
];

// --- value formatting per metric --------------------------------------------

/** @param {string} metric @param {any} value */
function metricValue(metric, value) {
  if (value === null || value === undefined) return '—';
  switch (metric) {
    case 'mintAuthorityRevoked':
    case 'freezeAuthorityRevoked':
      return value === true ? 'Revoked' : value === false ? 'Active' : String(value);
    case 'tradable':
      return value === true ? 'Yes' : value === false ? 'No' : String(value);
    case 'mintExtensions':
      return Array.isArray(value) ? (value.length === 0 ? 'None' : value.join(', ')) : String(value);
    case 'tokenProgram':
      return value === 'TOKEN_2022' ? 'Token-2022' : value === 'LEGACY_SPL_TOKEN' ? 'SPL Token' : String(value);
    case 'topHoldersPct':
      return typeof value === 'number' ? `${value.toFixed(1)}%` : String(value);
    case 'rugcheckRisk':
      return typeof value === 'number' ? `${Math.round(value)} / 100 risk` : String(value);
    case 'liquidityUsd':
    case 'volume24h':
      return typeof value === 'number' ? usd(value) : String(value);
    case 'priceChange':
      if (typeof value === 'object') {
        return ['m5', 'h1', 'h6', 'h24']
          .filter((k) => typeof value[k] === 'number')
          .map((k) => `${k.replace('m', '').replace('h', '')}${k.startsWith('m') ? 'm' : 'h'} ${pct(value[k])}`)
          .join(' · ');
      }
      return String(value);
    case 'buyPressure':
      return typeof value === 'number' ? `${Math.round(value * 100)}% buys` : String(value);
    case 'holders':
      return typeof value === 'number' ? count(value) : String(value);
    case 'organicScore':
      return typeof value === 'number' ? `${Math.round(value)} / 100` : String(value);
    case 'ageHours':
      return typeof value === 'number' ? age(value) : String(value);
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

const PROVIDER = /** @type {Record<string, string>} */ ({
  dexscreener: 'DexScreener',
  jupiter: 'Jupiter',
  rugcheck: 'RugCheck',
  helius: 'Helius (on-chain)',
  birdeye: 'Birdeye',
  derived: 'Derived',
});
/** @param {string | null} provider */
const providerName = (provider) => (provider ? PROVIDER[provider] ?? provider : '—');

// --- header -----------------------------------------------------------------

/** @param {Dossier} d */
function placementBanner(d) {
  if (d.placement.universe === 'STALE') {
    return html`<aside class="notice notice--history" role="note">
      <span class="notice__icon" aria-hidden="true">⏱</span>
      <div class="notice__body"><strong>Not on the live Board.</strong> Last evaluated ${timeAgo(d.placement.lastSeenAt)} (${when(d.placement.lastSeenAt)}). This verdict describes that moment, not now — the market data it rests on is past the engine's freshness window.</div>
    </aside>`;
  }
  if (d.placement.universe === 'UNEVALUATED') {
    return html`<aside class="notice notice--history" role="note">
      <span class="notice__icon" aria-hidden="true">∅</span>
      <div class="notice__body"><strong>Never evaluated.</strong> This token came from the earlier JSON store, which recorded market data but no safety assessment. It has history below, but no verdict to trust.</div>
    </aside>`;
  }
  return '';
}

/** @param {Dossier} d */
function header(d) {
  const t = d.token;
  const v = d.verdict;
  const trust = d.trust;
  const unknowns = trust.unknowns ?? [];
  return html`
    <nav class="crumbs" aria-label="Breadcrumb"><a href="${appUrl('/discover')}" data-link>← Live discovery</a></nav>
    ${placementBanner(d)}
    <header class="dossier-head">
      <div class="identity">
        ${tokenIcon(t, 48)}
        <div class="identity__text">
          <h1 class="identity__symbol">${t.symbol}
            ${t.verified ? html`<span class="badge badge--verified" title="Verified on Jupiter">Verified</span>` : ''}
            ${d.contract.program === 'TOKEN_2022' ? html`<span class="badge">Token-2022</span>` : ''}
          </h1>
          <p class="identity__name">${t.name}</p>
          <p class="identity__mint">
            <code title="${t.mint}">${shortAddress(t.mint)}</code>
            <button type="button" class="link-btn" data-action="copy-mint" data-mint="${t.mint}">Copy address</button>
            <span class="sr-only" aria-live="polite" id="copy-status"></span>
          </p>
        </div>
      </div>

      <section class="verdict-panel verdict-panel--${v.tone}" aria-labelledby="verdict-label">
        <p class="verdict-panel__eyebrow">Token Finder's verdict</p>
        <h2 id="verdict-label" class="verdict-panel__label">${verdictChip(v.eligibility, { size: 'lg' })}</h2>
        <p class="verdict-panel__reason ${toneClass(v.tone)}">${v.reason}</p>
        <ul class="facts">
          ${v.facts.map((fact) => html`<li class="fact fact--${fact.tone}">${fact.text}</li>`)}
          <li class="fact fact--neutral">Assessed ${timeAgo(v.assessedAt)}${d.placement.freshness ? html` ${freshnessTag(d.placement.freshness)}` : ''}</li>
        </ul>
      </section>
    </header>

    <section class="trust" aria-label="Score, coverage and confidence">
      <div class="trust__metric">
        <p class="trust__label">Score</p>
        <p class="trust__value">${trust.score}<span class="trust__unit">/100</span></p>
        <p class="trust__caption">How strong it looks on the evidence measured</p>
      </div>
      <div class="trust__metric">
        <p class="trust__label">Coverage</p>
        <p class="trust__value">${share(trust.coverage)}</p>
        ${meter(trust.coverage, 'accent')}
        <p class="trust__caption">${trust.measured ?? '—'} of ${trust.signals ?? '—'} evidence signals measured</p>
      </div>
      <div class="trust__metric">
        <p class="trust__label">Confidence</p>
        <p class="trust__value">${share(trust.confidence)}</p>
        ${meter(trust.confidence, 'accent')}
        <p class="trust__caption">What that evidence is worth after disagreement, age and single-source reliance</p>
      </div>
      <div class="trust__unknowns">
        <p class="trust__label">Not measured</p>
        ${unknowns.length === 0
          ? html`<p class="trust__none">${d.evidence.source === 'none' ? 'Not recorded for this assessment' : 'Every evidence signal was measured'}</p>`
          : html`<ul class="unknowns">${unknowns.map(
              (u) => html`<li class="unknown ${u.global ? 'unknown--global' : ''}"><span class="unknown__label">${u.label}</span><span class="unknown__reason">${u.reason}</span></li>`,
            )}</ul>`}
      </div>
    </section>`;
}

/** @param {Dossier} d @param {string} active */
function tabsNav(d, active) {
  const counts = /** @type {Record<string, string>} */ ({
    evidence: d.evidence.rows.length ? String(d.evidence.rows.length) : '',
  });
  return html`<nav class="tabs" aria-label="Dossier sections">
    ${TABS.filter((tab) => tab.available).map(
      (tab) => html`<a class="tab ${active === tab.id ? 'is-active' : ''}" href="${dossierUrl(d.token.mint, tab.id === 'overview' ? undefined : tab.id)}" data-link ${active === tab.id ? html`aria-current="page"` : ''}>${tab.label}${counts[tab.id] ? html` <span class="tab__count">${counts[tab.id]}</span>` : ''}</a>`,
    )}
  </nav>`;
}

// --- overview ---------------------------------------------------------------

/** @param {Dossier} d */
function overview(d) {
  const v = d.verdict;
  const m = d.market;
  const s = d.score;

  const vetoes = v.vetoes.length
    ? html`<section class="panel panel--bad" aria-labelledby="vetoes-title">
        <h2 id="vetoes-title" class="panel__title">Hard vetoes</h2>
        <ul class="vetoes">
          ${v.vetoes.map(
            (veto) => html`<li class="veto">
              <p class="veto__label">${veto.label}</p>
              <p class="veto__reason">${veto.reason}</p>
              <p class="veto__meta">
                <span>Source: ${providerName(veto.source)}</span>
                <span>Observed: ${veto.observedValue}</span>
                <span>${timeAgo(veto.at)}</span>
                <span class="tag ${veto.recheckable ? 'tag--neutral' : 'tag--bad'}">${veto.recheckable ? 'Can clear on fresh evidence' : 'Permanent'}</span>
              </p>
            </li>`,
          )}
        </ul>
      </section>`
    : '';

  const watch = v.watchpoints.length
    ? html`<section class="panel" aria-labelledby="watch-title">
        <h2 id="watch-title" class="panel__title">What would change this verdict</h2>
        <ul class="watchpoints">${v.watchpoints.map((w) => html`<li class="watchpoint ${toneClass(w.tone)}">${w.text}</li>`)}</ul>
      </section>`
    : '';

  const change = m.change ?? {};
  const market = html`<section class="panel" aria-labelledby="market-title">
    <h2 id="market-title" class="panel__title">Market <span class="panel__note">as of ${timeAgo(d.placement.lastSeenAt)}</span></h2>
    <dl class="stats">
      <div><dt>Price</dt><dd>${price(m.priceUsd)}</dd></div>
      <div><dt>Liquidity</dt><dd>${usd(m.liquidityUsd)}</dd></div>
      <div><dt>24h volume</dt><dd>${usd(m.volume24h)}</dd></div>
      <div><dt>Market cap</dt><dd>${usd(m.marketCap)}</dd></div>
      <div><dt>FDV</dt><dd>${usd(m.fdv)}</dd></div>
      <div><dt>Buys (24h)</dt><dd>${m.buyRatio24h === null ? '—' : share(m.buyRatio24h)}</dd></div>
      <div><dt>5m</dt><dd class="move-cell">${pct(change.m5 ?? null)}</dd></div>
      <div><dt>1h</dt><dd class="move-cell">${pct(change.h1 ?? null)}</dd></div>
      <div><dt>6h</dt><dd class="move-cell">${pct(change.h6 ?? null)}</dd></div>
      <div><dt>24h</dt><dd class="move-cell">${pct(change.h24 ?? null)}</dd></div>
      <div><dt>Age</dt><dd>${age(d.token.ageHours)}</dd></div>
      <div><dt>Venue</dt><dd>${m.venue ? `${m.venue.dex} · ${m.venue.quote}` : '—'}</dd></div>
    </dl>
  </section>`;

  const breakdown = html`<section class="panel" aria-labelledby="score-title">
    <h2 id="score-title" class="panel__title">How the score was built</h2>
    <p class="panel__lede">${d.trust.penalty > 0
      ? html`Components add up to ${d.trust.base}; risk findings take ${d.trust.penalty}% off, leaving <strong>${d.trust.score}</strong>.`
      : html`Components add up to <strong>${d.trust.score}</strong>, with no risk penalties.`}
      ${d.trust.ceiling < 100
        ? html` Unmeasured inputs earn nothing, so this token could reach at most <strong>${d.trust.ceiling}</strong>.`
        : ' Every scoring input was measured, so nothing capped it.'}</p>
    <ul class="components">
      ${s.components.map(
        (c) => html`<li class="component ${c.value === null ? 'component--unknown' : ''}">
          <span class="component__label">${c.label}</span>
          <span class="component__bar">${meter(c.value, 'accent')}</span>
          <span class="component__value">${c.value === null ? 'Unknown' : Math.round(c.value * 100)}</span>
          <span class="component__detail">${c.value === null ? html`Not measured — ${c.unknownReason ?? 'no evidence'}; earns 0` : c.detail} · weight ${Math.round(c.weight * 100)}%</span>
        </li>`,
      )}
    </ul>
  </section>`;

  const findings = s.findings.length
    ? html`<section class="panel" aria-labelledby="findings-title">
        <h2 id="findings-title" class="panel__title">Findings</h2>
        <ul class="findings">${s.findings.map((f) => html`<li class="finding finding--${f.level}"><span class="tag tag--${f.level === 'critical' || f.level === 'high' ? 'bad' : f.level === 'medium' ? 'warn' : 'neutral'}">${f.level}</span><span>${f.text}</span></li>`)}</ul>
      </section>`
    : '';

  const about = html`<section class="panel" aria-labelledby="about-title">
    <h2 id="about-title" class="panel__title">About</h2>
    <p class="muted small">Discovered via ${d.token.sources.join(' · ') || '—'}</p>
    <ul class="links">
      ${d.token.links.map((link) => {
        const url = safeUrl(link.url);
        return url ? html`<li><a class="ext-link" href="${url}" target="_blank" rel="noopener noreferrer">${link.label}<span class="sr-only"> (opens in a new tab)</span></a></li>` : '';
      })}
    </ul>
  </section>`;

  return html`<div class="overview-grid">
    <div class="overview-main">${vetoes}${watch}${breakdown}${findings}</div>
    <div class="overview-side">${market}${about}</div>
  </div>`;
}

// --- evidence ---------------------------------------------------------------

const GROUPS = ['Safety', 'Market', 'Adoption', 'Contract'];

/** @param {any} row @param {Record<string, string>} reasons */
function evidenceRow(row, reasons) {
  const measured = row.state === 'MEASURED' || row.state === 'CONFLICTED';
  const claims = row.claims ?? [];
  return html`<li class="ev ev--${measured ? 'measured' : 'unmeasured'}">
    <details>
      <summary class="ev__summary">
        <span class="ev__label">${row.label}${row.weight === 0 ? html` <span class="muted small">informational</span>` : ''}</span>
        <span class="ev__value">${measured ? metricValue(row.metric, row.value) : '—'}</span>
        <span class="ev__state">${stateTag(row.state)}</span>
        <span class="ev__source">${providerName(row.source)}</span>
        <span class="ev__age">${row.observedAt ? timeAgo(row.observedAt) : html`<span class="muted">—</span>`}</span>
      </summary>
      <div class="ev__detail">
        ${claims.length
          ? html`<table class="claims">
              <caption class="sr-only">What each provider reported for ${row.label}</caption>
              <thead><tr><th scope="col">Provider</th><th scope="col" class="num">Reported</th><th scope="col">Status</th><th scope="col">Observed</th></tr></thead>
              <tbody>${claims.map((claim) => html`<tr>
                <td>${providerName(claim.provider)}${row.source === claim.provider ? html` <span class="tag tag--good">used</span>` : ''}</td>
                <td class="num">${claim.invalid || claim.unavailable ? '—' : metricValue(row.metric, claim.value)}</td>
                <td>${claim.invalid ? html`<span class="tag tag--bad">Rejected</span> <span class="small muted">${claim.invalid}</span>` : claim.unavailable ? html`<span class="tag tag--unknown">Unreachable</span>` : freshnessTag(claim.freshness)}</td>
                <td>${timeAgo(claim.observedAt)}</td>
              </tr>`)}</tbody>
            </table>`
          : html`<p class="muted small">${!measured ? `Not measured: ${reasons[row.metric] ?? 'no provider reported it'}.` : 'Provider-by-provider claims were not recorded for this assessment.'}</p>`}
        ${row.overridden?.length
          ? html`<p class="small">Set aside: ${row.overridden.map((o) => html`<span class="override">${providerName(o.provider)} said ${metricValue(row.metric, o.value)} (${o.freshness.toLowerCase()})</span>`)}</p>`
          : ''}
        ${row.confidence !== null && measured ? html`<p class="small muted">Worth ${share(row.confidence)} after provider trust${row.freshness === 'AGING' ? ', ageing' : ''}${row.state === 'CONFLICTED' ? ' and disagreement' : ''}.</p>` : ''}
        ${row.notes?.length ? html`<ul class="notes">${row.notes.map((note) => html`<li>${note}</li>`)}</ul>` : ''}
      </div>
    </details>
  </li>`;
}

/** @param {Dossier} d */
function evidence(d) {
  const ev = d.evidence;
  if (ev.source === 'none') {
    return emptyState('No evidence was recorded for this token.', d.placement.universe === 'UNEVALUATED' ? 'It was never evaluated.' : 'Evidence is recorded for every assessment from the next scan on.');
  }
  const intro =
    ev.source === 'stored'
      ? html`<p class="notice notice--quiet">Evidence as of ${timeAgo(ev.asOf)}. This assessment predates per-provider recording, so each signal shows the value that won but not every provider's claim. The next scan records both.</p>`
      : html`<p class="panel__lede">Evidence as of ${timeAgo(ev.asOf)}. Open a signal to see what each provider reported and which reading was used.</p>`;

  /** @type {Record<string, string>} */
  const reasons = Object.fromEntries((d.trust.unknowns ?? []).map((u) => [u.metric, u.reason.toLowerCase()]));
  return html`<div class="evidence">
    ${intro}
    <div class="ev-legend" aria-hidden="true"><span>Signal</span><span>Value</span><span>State</span><span>Source</span><span>Observed</span></div>
    ${GROUPS.map((group) => {
      const rows = ev.rows.filter((row) => row.group === group);
      if (rows.length === 0) return '';
      return html`<section class="ev-group" aria-labelledby="ev-${group}">
        <h2 id="ev-${group}" class="section-title">${group}</h2>
        <ul class="ev-list">${rows.map((row) => evidenceRow(row, reasons))}</ul>
      </section>`;
    })}
  </div>`;
}

// --- contract & holders -----------------------------------------------------

const POLICY = /** @type {Record<string, { label: string, tone: string }>} */ ({
  HARD_VETO: { label: 'Vetoes when armed', tone: 'bad' },
  CONDITIONAL_VETO: { label: 'Vetoes above threshold', tone: 'warn' },
  PENALTY_ONLY: { label: 'Penalty', tone: 'warn' },
  INFORMATIONAL: { label: 'Informational', tone: 'neutral' },
  NO_CURRENT_RISK_EFFECT: { label: 'No current effect', tone: 'neutral' },
  UNKNOWN_POLICY: { label: 'Not recognised', tone: 'unknown' },
});

/** @param {{ state: string, source: string | null }} a @param {boolean} inspected */
function authorityCell(a, inspected) {
  const label = a.state === 'revoked' ? 'Revoked' : a.state === 'active' ? 'Active' : 'Unknown';
  const tone = a.state === 'revoked' ? 'good' : a.state === 'active' ? 'bad' : 'unknown';
  const provenance =
    a.state === 'unknown'
      ? 'No provider reported it'
      : a.source === 'helius'
        ? 'Read from the chain'
        : `Reported by ${providerName(a.source)}${inspected ? '' : ' · not confirmed on-chain'}`;
  return html`<span class="tag tag--${tone}">${label}</span> <span class="small muted">${provenance}</span>`;
}

/** @param {Dossier} d */
function contract(d) {
  const c = d.contract;
  const h = d.holders;
  const notInspected = !c.inspected
    ? html`<aside class="notice notice--warn" role="note">
        <span class="notice__icon" aria-hidden="true">!</span>
        <div class="notice__body"><strong>Token-2022 extensions were not inspected.</strong> ${c.unavailableReason} A permanent delegate, transfer hook or pause authority on this mint would not be detected, and would not veto it.</div>
      </aside>`
    : '';

  const extensions = !c.inspected
    ? ''
    : c.extensions.length === 0
      ? html`<p class="muted">${c.program === 'LEGACY_SPL_TOKEN' ? 'SPL Token mints have no extension mechanism.' : c.extensionsComplete ? 'No extensions on this mint.' : 'The extension list could not be read completely; absence cannot be concluded.'}</p>`
      : html`<ul class="extensions">
          ${c.extensions.map((x) => {
            const policy = POLICY[x.policy] ?? { label: x.policy, tone: 'unknown' };
            const armed = x.active === true ? html`<span class="tag tag--bad">Armed</span>` : x.active === false ? html`<span class="tag tag--good">Disarmed</span>` : html`<span class="tag tag--unknown">Unreadable</span>`;
            return html`<li class="extension">
              <details>
                <summary><span class="extension__label">${x.label}</span>${armed}<span class="tag tag--${policy.tone}">${policy.label}</span>${x.detail ? html`<span class="small muted">${x.detail}</span>` : ''}</summary>
                <p class="small">${x.rationale}</p>
                <p class="small muted">${x.recheckable ? 'Its issuer can change this; it is re-checked on every scan.' : 'Fixed for the life of the mint.'}</p>
              </details>
            </li>`;
          })}
        </ul>
        ${c.extensionsComplete === false ? html`<p class="small tone--warn">Some extensions could not be decoded, so this list may be incomplete.</p>` : ''}`;

  return html`${notInspected}
  <div class="overview-grid">
    <div class="overview-main">
      <section class="panel" aria-labelledby="program-title">
        <h2 id="program-title" class="panel__title">Mint</h2>
        <dl class="kv">
          <div><dt>Token program</dt><dd>${c.program === 'TOKEN_2022' ? 'Token-2022' : c.program === 'LEGACY_SPL_TOKEN' ? 'SPL Token' : html`<span class="tag tag--unknown">Not inspected</span>`}</dd></div>
          <div><dt>Mint authority</dt><dd>${authorityCell(c.mintAuthority, c.inspected)}</dd></div>
          <div><dt>Freeze authority</dt><dd>${authorityCell(c.freezeAuthority, c.inspected)}</dd></div>
          <div><dt>Decimals</dt><dd>${c.decimals ?? html`<span class="muted">${c.inspected ? '—' : 'Needs on-chain read'}</span>`}</dd></div>
          <div><dt>Raw supply</dt><dd>${c.rawSupply ? html`<code class="small">${c.rawSupply}</code>` : html`<span class="muted">${c.inspected ? '—' : 'Needs on-chain read'}</span>`}</dd></div>
        </dl>
      </section>
      <section class="panel" aria-labelledby="ext-title">
        <h2 id="ext-title" class="panel__title">Token-2022 extensions</h2>
        ${c.inspected ? extensions : html`<p class="muted">Not inspected in this configuration.</p>`}
      </section>
    </div>
    <div class="overview-side">
      <section class="panel" aria-labelledby="holders-title">
        <h2 id="holders-title" class="panel__title">Holders</h2>
        <dl class="kv">
          <div><dt>Holders</dt><dd>${count(h.count)}</dd></div>
          <div><dt>Top holders</dt><dd>${h.topHoldersPct === null ? html`<span class="tag tag--unknown">Unknown</span>` : html`${h.topHoldersPct}% <span class="small muted">${providerName(h.topHoldersSource)}</span>`}</dd></div>
          <div><dt>Largest account</dt><dd>${h.largestHolderPct === null ? html`<span class="muted">${c.inspected ? '—' : 'Needs on-chain read'}</span>` : `${h.largestHolderPct}%`}</dd></div>
        </dl>
        ${h.topHoldersSource === 'helius' ? html`<p class="small muted">On-chain figures include pool vault accounts, so they overstate insider concentration.</p>` : ''}
      </section>
    </div>
  </div>`;
}

// --- history ----------------------------------------------------------------

/** @param {any} change */
function changeItem(change) {
  return html`<li class="change change--${change.kind}">
    <span class="change__time" title="${when(change.at)}">${when(change.at)}</span>
    <span class="transition">${change.from ? html`${verdictChip(change.from)}<span class="transition__arrow" aria-label="to">→</span>` : html`<span class="small muted">First assessed</span>`}${verdictChip(change.to)}</span>
    <span class="change__reason">${change.reason}</span>
    <span class="change__context small muted">${change.liquidityUsd !== null ? `Liquidity ${usd(change.liquidityUsd)}` : ''}${change.priceUsd !== null ? ` · ${price(change.priceUsd)}` : ''} · score ${change.score}</span>
  </li>`;
}

/** @param {any} h @param {number} width */
function historyTemplate(h, width) {
  const changes = h.changes ?? [];
  const real = changes.filter((c) => c.kind === 'changed');
  const assessed = h.verdicts.filter((v) => v.eligibility).length;
  if (h.verdicts.length === 0 && h.market.length === 0) {
    return emptyState('No history recorded yet.', 'History accumulates from each stored scan.');
  }
  const t0 = Math.min(...[...h.verdicts, ...h.market].map((p) => p.t));
  return html`<div class="history">
    <section class="panel" aria-labelledby="timeline-title">
      <h2 id="timeline-title" class="panel__title">Verdict over time <span class="panel__note">${count(h.verdicts.length)} stored observations since ${when(t0)}</span></h2>
      <div class="timeline-legend" aria-hidden="true">
        <span class="lg lg--good">Qualified</span><span class="lg lg--warn">Watch</span><span class="lg lg--bad">Rejected</span><span class="lg lg--none">Not assessed</span><span class="lg lg--marker">Verdict change</span><span class="lg lg--gap">Not observed</span>
      </div>
      <div class="timeline-wrap" id="timeline-wrap">${timeline({ verdicts: h.verdicts, market: h.market, changes }, width)}</div>
      <p class="timeline-readout" id="timeline-readout" aria-live="off">Point at the chart to read a moment.</p>
      ${assessed < h.verdicts.length ? html`<p class="small muted">${h.verdicts.length - assessed} earlier observations predate safety assessment; they carry market data only.</p>` : ''}
    </section>
    <section class="panel" aria-labelledby="changes-title">
      <h2 id="changes-title" class="panel__title">Verdict changes <span class="panel__note">${real.length === 0 ? 'none — the verdict has held since first assessment' : `${real.length}`}</span></h2>
      ${changes.length ? html`<ol class="changes">${changes.map(changeItem)}</ol>` : html`<p class="muted">Never assessed.</p>`}
    </section>
  </div>`;
}

/** @param {{ t: number, verdict: any, market: any }} point */
function describePoint(point) {
  if (!Number.isFinite(point.t)) return html`Point at the chart to read a moment.`;
  const v = point.verdict;
  const m = point.market;
  return html`<strong>${when(point.t)}</strong> · ${v?.eligibility ? verdictChip(v.eligibility) : html`<span class="muted">not assessed</span>`}${v ? html` · score ${Math.round(v.score)}` : ''} · price ${price(m?.price ?? null)} · liquidity ${usd(m?.liquidity ?? null)}`;
}

// --- mount ------------------------------------------------------------------

/**
 * @param {HTMLElement} root
 * @param {import('../lib/router.js').Route} route
 */
export function mountDossier(root, route) {
  const mint = route.params.mint ?? '';
  let tab = TABS.some((t) => t.id === route.params.tab && t.available) ? /** @type {string} */ (route.params.tab) : 'overview';
  /** @type {Dossier | null} */
  let data = null;
  /** @type {any} */
  let history = null;
  let disposed = false;
  /** @type {ResizeObserver | null} */
  let resize = null;

  const content = () => root.querySelector('#dossier-tab');

  const paintTab = () => {
    const target = content();
    if (!target || !data) return;
    resize?.disconnect();
    if (tab === 'overview') render(target, overview(data));
    else if (tab === 'evidence') render(target, evidence(data));
    else if (tab === 'contract') render(target, contract(data));
    else if (tab === 'history') {
      if (!history) {
        render(target, skeleton(6));
        void loadHistory();
        return;
      }
      const draw = () => {
        const width = target.clientWidth - 32;
        render(target, historyTemplate(history, width));
        const wrap = /** @type {HTMLElement | null} */ (target.querySelector('#timeline-wrap'));
        const readout = /** @type {HTMLElement | null} */ (target.querySelector('#timeline-readout'));
        if (wrap && readout) attachTimeline(wrap, history, readout, describePoint, render);
      };
      draw();
      let last = target.clientWidth;
      resize = new ResizeObserver(() => {
        if (Math.abs(target.clientWidth - last) > 24) {
          last = target.clientWidth;
          draw();
        }
      });
      resize.observe(target);
    }
  };

  const paint = () => {
    if (!data) return;
    document.title = `${data.token.symbol} · ${data.verdict.label} — Token Finder`;
    render(
      root,
      html`<article class="dossier" aria-labelledby="verdict-label">
        ${header(data)}
        ${tabsNav(data, tab)}
        <div id="dossier-tab" class="dossier-tab" tabindex="-1"></div>
      </article>`,
    );
    paintTab();
  };

  const load = async () => {
    try {
      const next = await api(`/api/tokens/${encodeURIComponent(mint)}`);
      if (disposed) return;
      data = next;
      paint();
    } catch (error) {
      if (disposed) return;
      if (data) return;
      if (error instanceof ApiError && error.status === 404) {
        render(root, emptyState('Token Finder is not tracking this token.', 'It may never have been discovered, or its history has been retired.', html`<a class="btn" href="${appUrl(`/analyze/${encodeURIComponent(mint)}`)}" data-link>Analyze this token</a> <a class="btn btn--quiet" href="${appUrl('/discover')}" data-link>Live discovery</a>`));
        document.title = 'Not tracked — Token Finder';
        return;
      }
      render(root, errorState('This token could not be loaded.', error instanceof Error ? error.message : String(error)));
    }
  };

  const loadHistory = async () => {
    try {
      history = await api(`/api/tokens/${encodeURIComponent(mint)}/history`);
      if (!disposed && tab === 'history') paintTab();
    } catch (error) {
      const target = content();
      if (target && !disposed) render(target, errorState('History could not be loaded.', error instanceof Error ? error.message : String(error)));
    }
  };

  const onClick = async (/** @type {MouseEvent} */ event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    if (target.closest('[data-action="retry"]')) {
      history = null;
      void load();
      return;
    }
    const copy = target.closest('[data-action="copy-mint"]');
    if (copy instanceof HTMLElement) {
      const status = root.querySelector('#copy-status');
      try {
        await navigator.clipboard.writeText(copy.dataset.mint ?? '');
        copy.textContent = 'Copied';
        if (status) status.textContent = 'Address copied';
      } catch {
        copy.textContent = 'Copy failed';
      }
      setTimeout(() => (copy.textContent = 'Copy address'), 1500);
    }
  };
  root.addEventListener('click', onClick);

  const offServer = onServerEvent((kind) => {
    if (kind === 'scan' || kind === 'reconnected') {
      history = null;
      void load();
    }
  });

  render(root, skeleton(10));
  void load();

  return {
    /** Tab changes re-render in place; no refetch. @param {import('../lib/router.js').Route} next */
    update(next) {
      if (next.params.mint !== mint) return false;
      tab = TABS.some((t) => t.id === next.params.tab && t.available) ? /** @type {string} */ (next.params.tab) : 'overview';
      if (data) {
        paint();
        /** @type {HTMLElement | null} */ (root.querySelector('#dossier-tab'))?.focus({ preventScroll: true });
      }
      return true;
    },
    dispose() {
      disposed = true;
      resize?.disconnect();
      offServer();
      root.removeEventListener('click', onClick);
    },
  };
}
