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
  ACTIVITY_CATEGORIES,
  compositionBar,
  dossierUrl,
  emptyState,
  errorState,
  freshnessTag,
  meter,
  skeleton,
  stateTag,
  timeAgo,
  tokenIcon,
  toneChip,
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

    ${decisionStrip(d)}
    <section class="trust" aria-label="Score, coverage and confidence">
      <div class="trust__metric">
        <p class="trust__label">${d.decision ? 'Market score' : 'Score'}</p>
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

// --- decision -----------------------------------------------------------------

const pct0 = (/** @type {number | null | undefined} */ x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);
const signed = (/** @type {number} */ x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

/**
 * The three separate answers, side by side and never combined: is it safe
 * enough, is it interesting, is the move real - plus how much of it rests on
 * evidence. @param {Dossier} d
 */
function decisionStrip(d) {
  const x = d.decision;
  if (!x) return '';
  const cov = x.coverage;
  return html`<section class="decision-strip" aria-label="Safety, opportunity and momentum">
    <div class="decision-card decision-card--${x.integrity.tone}">
      <p class="decision-card__label">Safety &amp; integrity</p>
      <p class="decision-card__value">${x.integrity.score === null ? '—' : Math.round(x.integrity.score)}<span class="decision-card__unit">/100</span></p>
      <p class="decision-card__state">${toneChip(x.integrity.bandLabel, x.integrity.tone)}${x.integrity.driver ? html` <span class="small muted">driven by ${x.integrity.driver.toLowerCase()}</span>` : ''}</p>
      ${meter(x.integrity.coverage, 'accent')}
      <p class="decision-card__caption">${pct0(x.integrity.coverage)} of integrity evidence checked · confidence ${pct0(x.integrity.confidence)}</p>
    </div>
    <div class="decision-card">
      <p class="decision-card__label">Opportunity</p>
      <p class="decision-card__value">${Math.round(x.opportunity.score)}<span class="decision-card__unit">/100</span></p>
      <p class="decision-card__state">${toneChip(x.opportunity.band === 'STRONG' ? 'Strong' : x.opportunity.band === 'MODERATE' ? 'Moderate' : x.opportunity.band === 'WEAK' ? 'Weak' : 'Not enough evidence', x.opportunity.band === 'STRONG' ? 'good' : x.opportunity.band === 'WEAK' ? 'warn' : 'neutral')}</p>
      ${meter(x.opportunity.coverage, 'accent')}
      <p class="decision-card__caption">${pct0(x.opportunity.coverage)} of opportunity inputs measured</p>
    </div>
    <div class="decision-card decision-card--${x.momentum.tone}">
      <p class="decision-card__label">Momentum</p>
      <p class="decision-card__value decision-card__value--word">${x.momentum.label}</p>
      <p class="decision-card__state small muted">${x.momentum.observations} observation${x.momentum.observations === 1 ? '' : 's'} over ${x.momentum.spanMinutes >= 60 ? `${(x.momentum.spanMinutes / 60).toFixed(1)} h` : `${x.momentum.spanMinutes} min`}</p>
      ${meter(x.momentum.confidence, 'accent')}
      <p class="decision-card__caption">confidence ${pct0(x.momentum.confidence)} · from Token Finder's own observations</p>
    </div>
    <div class="decision-card">
      <p class="decision-card__label">Rank</p>
      <p class="decision-card__value">${x.rank ? Math.round(x.rank.score) : '—'}</p>
      <p class="decision-card__state small muted">${x.rank
        ? `opportunity ${Math.round(x.rank.opportunity)} − ${Math.round(x.rank.integrityPenalty)} integrity risk − ${Math.round(x.rank.uncertaintyPenalty)} unverified`
        : 'rejected tokens are not ranked'}</p>
      ${meter(cov.decision, 'accent')}
      <p class="decision-card__caption">coverage ${pct0(cov.decision)}: market evidence ${pct0(cov.market)}, deep intelligence ${pct0(cov.intelligence)}</p>
    </div>
  </section>`;
}

/** Why: the reasons, split by what they did to the verdict. @param {Dossier} d */
function reasonsPanel(d) {
  const x = d.decision;
  if (!x) return '';
  const list = (/** @type {string[]} */ items, /** @type {string} */ kind, /** @type {string} */ mark) =>
    items.length ? html`<ul class="reasons reasons--${kind}">${items.map((text) => html`<li><span class="reasons__mark" aria-hidden="true">${mark}</span>${text}</li>`)}</ul>` : '';
  return html`<section class="panel" aria-labelledby="why-title">
    <h2 id="why-title" class="panel__title">Why ${verdictChip(d.verdict.eligibility)} <span class="panel__note">${x.basis}</span></h2>
    ${x.hardFails.length
      ? html`<ul class="reasons reasons--risk">${x.hardFails.map((f) => html`<li><span class="reasons__mark" aria-hidden="true">✕</span><strong>${f.familyLabel}</strong> — ${f.reason}</li>`)}</ul>`
      : ''}
    ${list(x.positives, 'positive', '+')}
    ${list(x.risks, 'risk', '−')}
    ${x.blockers.length ? html`<p class="reasons__head small muted">Not higher because</p>${list(x.blockers, 'blocker', '↑')}` : ''}
    <p class="small muted">${x.coverageLine} · decided by ${x.policyVersion} ${timeAgo(x.decidedAt)}</p>
  </section>`;
}

/** Hard fails, each with family, confidence, freshness and rule version. @param {Dossier} d */
function hardFailsPanel(d) {
  const fails = d.decision?.hardFails;
  if (!fails || fails.length === 0) return '';
  return html`<section class="panel panel--bad" aria-labelledby="vetoes-title">
    <h2 id="vetoes-title" class="panel__title">Hard fails</h2>
    <ul class="vetoes">
      ${fails.map(
        (f) => html`<li class="veto">
          <p class="veto__label">${f.label} <span class="tag tag--bad">${f.familyLabel}</span></p>
          <p class="veto__reason">${f.reason}</p>
          <p class="veto__meta">
            ${f.confidence !== null ? html`<span>Confidence ${f.confidence.toFixed(2)}</span>` : ''}
            ${f.freshness ? html`<span>${freshnessTag(f.freshness)}</span>` : ''}
            ${f.ruleVersion ? html`<span><code class="small">${f.ruleVersion}</code></span>` : ''}
            <span class="tag ${f.recheckable ? 'tag--neutral' : 'tag--bad'}">${f.recheckable ? 'Can clear on fresh evidence' : 'Permanent'}</span>
          </p>
          ${f.evidence.length ? html`<details class="evidence-more"><summary>Evidence</summary><ul class="mono-list">${f.evidence.map((e) => html`<li><code>${e}</code></li>`)}</ul></details>` : ''}
        </li>`,
      )}
    </ul>
  </section>`;
}

const BASIS_LABEL = /** @type {Record<string, string>} */ ({ wallets: 'By wallets', trades: 'By trades', volume: 'By volume' });

/** Activity Integrity: what kind of trading this is, on which basis, and how much of the market it saw. @param {Dossier} d */
function activityPanel(d) {
  const a = d.activityIntegrity;
  if (!a) return '';
  const unavailable = a.status === 'UNAVAILABLE';
  const statusNote = a.status === 'SUPERSEDED' ? 'Reading from an obsolete rule — shown for audit, not used' : a.status === 'STALE' ? 'Last reading too old to use' : a.status === 'INSUFFICIENT_DATA' ? 'Too little trading classified to state shares' : '';
  const m = a.market;
  const w = a.wash;
  const ind = a.independence;
  return html`<section class="panel" aria-labelledby="activity-title">
    <h2 id="activity-title" class="panel__title">Activity integrity <span class="panel__note">${unavailable ? 'not analysed yet' : html`coverage ${pct0(a.coverage)} · confidence ${pct0(a.confidence)}${a.analyzedAt ? html` · ${timeAgo(a.analyzedAt)}` : ''}`}</span></h2>
    ${unavailable
      ? html`<p class="muted">Deep intelligence has not analysed this token. Nothing is known about who is trading it — which is not the same as nothing wrong.</p>`
      : html`
        ${statusNote ? html`<p class="small tone--warn">${statusNote}.</p>` : ''}
        <ul class="composition">
          ${a.bases.map((b) => html`<li class="composition__row">
            <span class="composition__label">${BASIS_LABEL[b.basis]}<span class="small muted"> · ${b.basis === 'volume' ? 'one quote currency' : `${b.total} ${b.basis}`}</span></span>
            ${compositionBar(b.shares, BASIS_LABEL[b.basis] ?? b.basis)}
            <span class="composition__note small muted">${b.shares ? `${pct0(b.classified)} classified` : 'counts only — too little classified'}</span>
          </li>`)}
        </ul>
        <p class="legend small" aria-hidden="true">${ACTIVITY_CATEGORIES.map(([key, name]) => html`<span class="legend__item"><span class="legend__swatch legend__swatch--${key}"></span>${name}</span>`)}</p>
        <dl class="kv kv--compact">
          <div><dt>Wash / manipulation</dt><dd>${w ? html`${toneChip(w.risk === 'INSUFFICIENT_DATA' ? 'Not enough trades' : w.risk === 'LOW' ? 'Low' : w.risk === 'ELEVATED' ? 'Elevated' : 'High', w.tone)} <span class="small muted">${w.families.length ? w.families.join(', ').toLowerCase() : ''}${w.coverage ? ` · coverage ${pct0(w.coverage)}` : ''}</span>` : html`<span class="muted">—</span>`}</dd></div>
          <div><dt>Wallet independence</dt><dd>${ind ? html`${ind.clusters === 0 ? 'No strong cluster' : `${ind.clusters} cluster${ind.clusters === 1 ? '' : 's'} (largest ${ind.largest})`}${ind.coordinatedShare !== null ? html` · <span class="small muted">${pct0(ind.coordinatedShare)} of trading wallets coordinated</span>` : ''}${ind.effectiveParticipants !== null ? html` · <span class="small muted">${ind.effectiveParticipants} independent participants</span>` : ''}` : html`<span class="muted">—</span>`}</dd></div>
          <div><dt>Market observed</dt><dd>${m ? html`${m.observedPools} of ${m.knownPools} pool${m.knownPools === 1 ? '' : 's'} · <span class="small muted">${m.sampleShare !== null ? `${pct0(m.sampleShare)} of trades in the window` : 'no provider trade counts'} · representativeness ${pct0(m.representativeness)}</span>` : html`<span class="muted">not recorded</span>`}</dd></div>
        </dl>
        <details class="evidence-more">
          <summary>Evidence</summary>
          ${m ? html`<p class="small">${m.note}${m.volumeQuote && m.excludedFromVolume ? ` · ${m.excludedFromVolume} trade(s) in another quote currency counted, not summed` : ''}</p>
            <ul class="mono-list">${m.pools.map((p) => html`<li><code>${shortAddress(p.address)}</code> ${p.dexId} · ${p.observedTrades} observed${p.volumeShare !== null ? ` · ${pct0(p.volumeShare)} of volume` : ''}</li>`)}</ul>` : ''}
          ${w && w.signals.length ? html`<p class="small muted">Manipulation signals</p><ul class="signals">${w.signals.map((s) => html`<li class="${s.triggered ? 'tone--warn' : 'muted'}">${s.triggered ? '●' : '○'} ${s.text}</li>`)}</ul>` : ''}
          ${w && w.counter.length ? html`<p class="small muted">Counter-evidence</p><ul class="signals">${w.counter.map((c) => html`<li>${c}</li>`)}</ul>` : ''}
          ${a.truncation.length ? html`<p class="small muted">Cut by budget</p><ul class="signals">${a.truncation.map((t) => html`<li>${t}</li>`)}</ul>` : ''}
          <p class="small muted">Percentages are of the trades collected, not of all trading. Unknown is shown, never redistributed. Bots and snipers are behaviours, not accusations.${a.ruleVersion ? html` Rule <code>${a.ruleVersion}</code>.` : ''}</p>
        </details>`}
  </section>`;
}

const EVENT_LABEL = /** @type {Record<string, string>} */ ({
  LIQUIDITY_DRAIN: 'Liquidity drain',
  SUPPLY_EXPANSION: 'Supply minted after launch',
  AUTHORITY_REASSIGNED: 'Authority moved, not revoked',
  FREEZE_ABUSE: 'Holders frozen',
  CREATOR_DUMP: 'Creator-linked selling',
});

/** @param {any} e */
function eventItem(e) {
  const tone = e.status === 'CONFIRMED' ? 'bad' : e.status === 'STRONGLY_SUSPECTED' ? 'warn' : 'neutral';
  return html`<li class="event-item">
    ${toneChip(e.status.replace('_', ' ').toLowerCase(), tone)} <strong>${EVENT_LABEL[e.type] ?? e.type}</strong>
    <span class="small muted">${e.reasons[0] ?? ''}</span>
    <span class="small"><code title="${e.signature}">${shortAddress(e.signature)}</code>${e.ruleVersion ? html` · <code>${e.ruleVersion}</code>` : html` · <span class="muted">unversioned</span>`}</span>
  </li>`;
}

/** Rug Intelligence: this token's own record, its creator, and the network around it. @param {Dossier} d */
function rugPanel(d) {
  const r = d.rugIntelligence;
  if (!r) return '';
  const c = r.creator;
  const n = r.network;
  return html`<section class="panel" aria-labelledby="rug-title">
    <h2 id="rug-title" class="panel__title">Rug intelligence <span class="panel__note">coverage ${pct0(r.coverage)}${r.analyzedAt ? html` · ${timeAgo(r.analyzedAt)}` : ' · not analysed yet'}</span></h2>
    <dl class="kv kv--compact">
      <div><dt>This token</dt><dd>${toneChip(r.tokenStatus.label, r.tokenStatus.tone)} <span class="small muted">${r.tokenStatus.detail}</span></dd></div>
      <div><dt>Creator</dt><dd>${c
        ? html`${toneChip(c.statusLabel, c.tone)} ${c.address ? html`<code class="small" title="${c.address}">${shortAddress(c.address)}</code>` : ''}
          <span class="small muted">${c.launches} launch${c.launches === 1 ? '' : 'es'} observed${c.otherConfirmed ? ` · ${c.otherConfirmed} other confirmed malicious` : ''}${c.otherSuspected ? ` · ${c.otherSuspected} other suspected` : ''}${c.attribution ? ` · attribution ${c.attribution.status.toLowerCase()} (${c.attribution.confidence.toFixed(2)})` : ''}</span>`
        : html`<span class="muted">not attributed</span>`}</dd></div>
      <div><dt>Serial network</dt><dd>${n ? html`${toneChip(n.label, n.tone)}${n.confidence ? html` <span class="small muted">confidence ${n.confidence.toFixed(2)}</span>` : ''}` : html`<span class="muted">not searched</span>`}</dd></div>
    </dl>
    ${r.active.length ? html`<ul class="events">${r.active.map(eventItem)}</ul>` : ''}
    ${n && n.findings.length
      ? html`<div class="paths"><p class="small muted">Relationship path${n.findings.length === 1 ? '' : 's'}</p>${n.findings.map((f) => html`<p class="path">
          ${f.path.length === 0 ? html`<span class="path__node">creator itself</span>` : f.path.map((p, i) => html`${i === 0 ? html`<span class="path__node"><code>${shortAddress(p.from)}</code></span>` : ''}<span class="path__edge">${p.type.toLowerCase().replace('_', ' ')}</span><span class="path__node"><code>${shortAddress(p.to)}</code></span>`)}
          <span class="small muted"> · ${f.confirmedLaunches} confirmed malicious launch${f.confirmedLaunches === 1 ? '' : 'es'} · path confidence ${f.pathConfidence.toFixed(2)}</span></p>`)}</div>`
      : ''}
    ${r.caveats.length ? html`<ul class="caveats">${r.caveats.map((text) => html`<li>${text}</li>`)}</ul>` : ''}
    ${r.superseded.length || r.revisions.length
      ? html`<details class="evidence-more"><summary>Superseded findings (${r.superseded.length}) — audit only</summary>
          <p class="small muted">Made under a rule this build no longer accepts, or no longer supported by the current rule. Kept for audit; they do not affect the verdict.</p>
          <ul class="events">${r.superseded.map(eventItem)}</ul>
          ${r.revisions.length ? html`<ul class="signals">${r.revisions.map((v) => html`<li class="small">${when(v.revisedAt)} · ${EVENT_LABEL[v.type] ?? v.type} ${v.status.toLowerCase()} under <code>${v.ruleVersion ?? 'unversioned'}</code> — ${v.change === 'SUPERSEDED' ? 'superseded' : 'reinterpreted'} by <code>${v.revisedBy}</code></li>`)}</ul>` : ''}
        </details>`
      : ''}
  </section>`;
}

/** Integrity by domain, drill-down. @param {Dossier} d */
function integrityPanel(d) {
  const x = d.decision;
  if (!x) return '';
  return html`<section class="panel" aria-labelledby="integrity-title">
    <h2 id="integrity-title" class="panel__title">Safety &amp; integrity by domain</h2>
    <ul class="domains">
      ${x.integrity.domains.map((dm) => html`<li class="domain">
        <details>
          <summary class="domain__summary">
            <span class="domain__label">${dm.label}</span>
            ${toneChip(dm.bandLabel, dm.tone)}
            <span class="domain__meter">${meter(dm.coverage, 'accent')}</span>
            <span class="small muted">${pct0(dm.coverage)} checked</span>
          </summary>
          <div class="domain__detail">
            ${dm.findings.length ? html`<ul class="reasons reasons--risk">${dm.findings.map((f) => html`<li><span class="reasons__mark" aria-hidden="true">−</span>${f}</li>`)}</ul>` : ''}
            ${dm.clean.length ? html`<ul class="reasons reasons--positive">${dm.clean.map((f) => html`<li><span class="reasons__mark" aria-hidden="true">✓</span>${f}</li>`)}</ul>` : ''}
            ${dm.unknown.length ? html`<p class="small muted">Not checked: ${dm.unknown.join('; ')}</p>` : ''}
            <p class="small muted">Risk ${dm.risk === null ? 'not measured' : dm.risk.toFixed(2)} · confidence ${pct0(dm.confidence)}</p>
          </div>
        </details>
      </li>`)}
    </ul>
    <details class="evidence-more"><summary>Deep intelligence sources</summary>
      <ul class="signals">${x.intelligence.map((i) => html`<li class="small"><strong>${i.key}</strong> ${toneChip(i.status.toLowerCase().replace('_', ' '), i.status === 'AVAILABLE' ? 'good' : i.status === 'PARTIAL' ? 'warn' : 'neutral')} ${pct0(i.coverage)} · ${i.freshness.toLowerCase()}${i.ruleVersion ? html` · <code>${i.ruleVersion}</code>` : ''}${i.note ? html` — <span class="muted">${i.note}</span>` : ''}</li>`)}</ul>
    </details>
  </section>`;
}

/** Market and Momentum v2 together: the move, and whether it is real. @param {Dossier} d */
function momentumBlock(d) {
  const mo = d.decision?.momentum;
  if (!mo) return '';
  return html`<div class="momentum">
    <p class="momentum__head">${toneChip(mo.label, mo.tone)} <span class="small muted">${mo.reasons[0] ?? ''}</span></p>
    ${mo.windows.length ? html`<dl class="stats stats--tight">${mo.windows.map((w) => html`<div><dt>${w.key} (observed)</dt><dd class="move-cell">${signed(w.change)}</dd></div>`)}
      ${mo.persistence !== null ? html`<div><dt>Steps up</dt><dd>${pct0(mo.persistence)}</dd></div>` : ''}
      ${mo.liquidityChange !== null ? html`<div><dt>Liquidity Δ</dt><dd>${signed(mo.liquidityChange)}</dd></div>` : ''}
      ${mo.holderChange !== null ? html`<div><dt>Holders Δ</dt><dd>${mo.holderChange >= 0 ? '+' : ''}${mo.holderChange}</dd></div>` : ''}</dl>` : ''}
    <p class="small muted">Windows are from Token Finder's own stored observations; the 5m–24h figures above are the provider's and are shown for comparison only.</p>
  </div>`;
}

/** Opportunity components, compact. @param {Dossier} d */
function opportunityPanel(d) {
  const o = d.decision?.opportunity;
  if (!o) return '';
  return html`<section class="panel" aria-labelledby="opp-title">
    <h2 id="opp-title" class="panel__title">Opportunity <span class="panel__note">separate from safety — it cannot lift a verdict</span></h2>
    <ul class="components">
      ${o.components.map((c) => html`<li class="component ${c.value === null ? 'component--unknown' : ''}">
        <span class="component__label">${c.label}</span>
        <span class="component__bar">${meter(c.value, 'accent')}</span>
        <span class="component__value">${c.value === null ? 'Unknown' : Math.round(c.value * 100)}</span>
        <span class="component__detail">${c.detail} · weight ${Math.round(c.weight * 100)}%</span>
      </li>`)}
    </ul>
  </section>`;
}

/** Raw and role-aware concentration, side by side. @param {Dossier} d */
function holderRows(d) {
  const h = d.holders;
  if (h.rawTop10Pct === null && h.walletTop10Pct === null) return '';
  return html`<div><dt>Top 10, raw</dt><dd>${h.rawTop10Pct === null ? '—' : `${h.rawTop10Pct}%`} <span class="small muted">every account, pools and curves included</span></dd></div>
    <div><dt>Top 10, wallets only</dt><dd>${h.walletTop10Pct === null
      ? html`<span class="tag tag--unknown">Withheld</span> <span class="small muted">${h.rolesTotal ? `${h.rolesTotal - h.rolesResolved} of ${h.rolesTotal} owners unreadable` : 'roles not read'}</span>`
      : html`${h.walletTop10Pct}% <span class="small muted">role-aware</span>`}</dd></div>
    ${h.byRolePct ? html`<div><dt>Held by programs</dt><dd class="small">${['BONDING_CURVE', 'POOL', 'PROGRAM_OWNED'].filter((k) => (h.byRolePct?.[k] ?? 0) > 0).map((k) => `${k === 'BONDING_CURVE' ? 'curve' : k === 'POOL' ? 'pool' : 'program'} ${h.byRolePct?.[k]}%`).join(' · ') || 'none'}</dd></div>` : ''}`;
}

// --- overview ---------------------------------------------------------------

/** @param {Dossier} d */
function overview(d) {
  const v = d.verdict;
  const m = d.market;
  const s = d.score;

  const vetoes = d.decision
    ? hardFailsPanel(d)
    : v.vetoes.length
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
    ${momentumBlock(d)}
  </section>`;

  const holdersPanel = html`<section class="panel" aria-labelledby="hl-title">
    <h2 id="hl-title" class="panel__title">Holders &amp; liquidity</h2>
    <dl class="kv kv--compact">
      <div><dt>Holders</dt><dd>${count(d.holders.count)}</dd></div>
      <div><dt>Top holders</dt><dd>${d.holders.topHoldersPct === null ? html`<span class="tag tag--unknown">Unknown</span>` : html`${d.holders.topHoldersPct}% <span class="small muted">${providerName(d.holders.topHoldersSource)}</span>`}</dd></div>
      ${holderRows(d)}
      <div><dt>Liquidity</dt><dd>${usd(m.liquidityUsd)}</dd></div>
    </dl>
  </section>`;

  const breakdown = html`<section class="panel panel--quiet" aria-labelledby="score-title">
    <details ${d.decision ? '' : html`open`}>
    <summary><h2 id="score-title" class="panel__title">How the market score was built <span class="panel__note">score@1 · kept beside the decision, not the ranking key</span></h2></summary>
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
    </details>
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

  // The order answers a trader's questions in turn: verdict and why, can the
  // market be trusted, is activity real, who is behind it, is the move real,
  // what is unknown. Everything past the first screen is drill-down.
  return html`<div class="overview-grid">
    <div class="overview-main">${vetoes}${reasonsPanel(d)}${activityPanel(d)}${rugPanel(d)}${integrityPanel(d)}${watch}${breakdown}${findings}</div>
    <div class="overview-side">${market}${holdersPanel}${opportunityPanel(d)}${about}</div>
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
