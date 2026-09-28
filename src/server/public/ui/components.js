// @ts-check
/**
 * Shared components. Each returns an `html` fragment; none touches the DOM.
 *
 * Colour is semantic and reserved: green/amber/red/grey mean a verdict or an
 * evidence state, never decoration. Price moves are drawn quieter than verdicts
 * so the eye lands on what only Token Finder knows.
 */

import { appUrl, html, safeUrl } from '../lib/html.js';
import { ago, when } from '../lib/format.js';

/** @typedef {'HIGH_POTENTIAL' | 'QUALIFIED' | 'WATCH' | 'INSUFFICIENT_DATA' | 'HIGH_RISK' | 'REJECTED'} Eligibility */

export const VERDICT = /** @type {Record<string, { label: string, tone: string }>} */ ({
  HIGH_POTENTIAL: { label: 'High potential', tone: 'good' },
  QUALIFIED: { label: 'Qualified', tone: 'good' },
  WATCH: { label: 'Watch', tone: 'warn' },
  INSUFFICIENT_DATA: { label: 'Insufficient data', tone: 'neutral' },
  HIGH_RISK: { label: 'High risk', tone: 'bad' },
  REJECTED: { label: 'Rejected', tone: 'bad' },
});

/** @param {string | null} eligibility @param {{ size?: 'sm' | 'lg' }} [options] */
export function verdictChip(eligibility, options = {}) {
  const verdict = eligibility ? VERDICT[eligibility] : null;
  const label = verdict?.label ?? 'Not assessed';
  const tone = verdict?.tone ?? 'none';
  // High potential and high risk share a colour with Qualified and Rejected;
  // a second mark keeps them apart for anyone who does not read colour.
  const mark = eligibility === 'HIGH_POTENTIAL' ? 'verdict--potential' : eligibility === 'HIGH_RISK' ? 'verdict--risk' : '';
  return html`<span class="verdict verdict--${tone} ${mark} ${options.size === 'lg' ? 'verdict--lg' : ''}"><span class="verdict__dot" aria-hidden="true"></span>${label}</span>`;
}

/** A compact labelled state, coloured by tone. @param {string} label @param {string} tone @param {string} [title] */
export function toneChip(label, tone, title) {
  return html`<span class="chip chip--${tone || 'neutral'}" ${title ? html`title="${title}"` : ''}>${label}</span>`;
}

/** Activity categories in display order, with their labels. */
export const ACTIVITY_CATEGORIES = /** @type {const} */ ([
  ['likely_organic', 'Organic'],
  ['automated', 'Automated'],
  ['sniper', 'Sniper'],
  ['coordinated', 'Coordinated'],
  ['unknown', 'Unknown'],
]);

/**
 * A stacked composition bar: one segment per activity category, unknown always
 * drawn. SVG attributes only, so it is CSP-safe. Null shares draw a hatched
 * track: the composition was not stated, which is not the same as empty.
 * @param {Record<string, number> | null} shares @param {string} label
 */
export function compositionBar(shares, label) {
  if (!shares) {
    return html`<svg class="stack stack--unknown" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${label}: not stated"><rect class="stack__track" x="0" y="0" width="100" height="8" rx="4"></rect></svg>`;
  }
  let x = 0;
  const parts = ACTIVITY_CATEGORIES.map(([key]) => {
    const width = Math.max(0, Math.min(100 - x, (shares[key] ?? 0) * 100));
    const rect = width > 0 ? html`<rect class="stack__seg stack__seg--${key}" x="${x.toFixed(2)}" y="0" width="${width.toFixed(2)}" height="8"></rect>` : '';
    x += width;
    return rect;
  });
  const text = ACTIVITY_CATEGORIES.map(([key, name]) => `${name} ${Math.round((shares[key] ?? 0) * 100)}%`).join(', ');
  return html`<svg class="stack" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${label}: ${text}"><rect class="stack__track" x="0" y="0" width="100" height="8" rx="4"></rect>${parts}</svg>`;
}

/**
 * Score inside a ring whose arc is coverage. Two numbers, one glyph, both
 * spelled out for assistive technology and on hover.
 *
 * @param {number} score @param {number | null} coverage @param {string} [name]
 */
export function scoreRing(score, coverage, name = 'Score') {
  const r = 15;
  const circumference = 2 * Math.PI * r;
  const filled = coverage === null ? 0 : Math.max(0, Math.min(1, coverage)) * circumference;
  const label = `${name} ${score}; ${coverage === null ? 'coverage unknown' : `${Math.round(coverage * 100)}% of evidence measured`}`;
  return html`<span class="ring" role="img" aria-label="${label}" title="${label}">
    <svg viewBox="0 0 36 36" aria-hidden="true">
      <circle class="ring__track" cx="18" cy="18" r="${r}"></circle>
      <circle class="ring__arc" cx="18" cy="18" r="${r}" stroke-dasharray="${filled.toFixed(2)} ${circumference.toFixed(2)}" transform="rotate(-90 18 18)"></circle>
    </svg>
    <span class="ring__value">${score}</span>
  </span>`;
}

const STATE = /** @type {Record<string, { label: string, tone: string }>} */ ({
  MEASURED: { label: 'Measured', tone: 'good' },
  CONFLICTED: { label: 'Conflicted', tone: 'warn' },
  UNKNOWN: { label: 'Unknown', tone: 'unknown' },
  UNAVAILABLE: { label: 'Unavailable', tone: 'unknown' },
  INVALID: { label: 'Rejected value', tone: 'bad' },
  STALE: { label: 'Stale', tone: 'unknown' },
});

/** Evidence state tag. Not-measured states share the hatched treatment. @param {string} state */
export function stateTag(state) {
  const entry = STATE[state] ?? { label: state, tone: 'unknown' };
  return html`<span class="tag tag--${entry.tone}">${entry.label}</span>`;
}

/** @param {string} freshness */
export function freshnessTag(freshness) {
  if (freshness === 'FRESH') return html`<span class="fresh fresh--fresh">Fresh</span>`;
  if (freshness === 'AGING') return html`<span class="fresh fresh--aging">Aging</span>`;
  if (freshness === 'STALE') return html`<span class="fresh fresh--stale">Stale</span>`;
  return html`<span class="fresh fresh--unknown">No timestamp</span>`;
}

/** Token image, or a monogram when there is none or it fails. @param {{ icon: string | null, symbol: string }} token @param {number} [size] */
export function tokenIcon(token, size = 28) {
  const url = safeUrl(token.icon, { httpsOnly: true });
  const letter = (token.symbol || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || '?';
  return html`<span class="avatar avatar--${size}" aria-hidden="true">
    <span class="avatar__letter">${letter}</span>
    ${url ? html`<img class="avatar__img" src="${url}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />` : ''}
  </span>`;
}

/** Relative time with the absolute time available on hover. @param {number | null} at */
export function timeAgo(at) {
  if (at === null || at === undefined) return html`<span class="muted">—</span>`;
  return html`<time datetime="${new Date(at).toISOString()}" title="${when(at)}">${ago(at)}</time>`;
}

/** @param {string} mint @param {string} [tab] */
export const dossierUrl = (mint, tab) => appUrl(tab ? `/t/${encodeURIComponent(mint)}/${tab}` : `/t/${encodeURIComponent(mint)}`);

/** @param {string} tone */
export const toneClass = (tone) => `tone--${tone || 'neutral'}`;

// --- page states -------------------------------------------------------------

/** @param {string} title @param {import('../lib/html.js').SafeHtml | string} [body] @param {import('../lib/html.js').SafeHtml} [action] */
export function emptyState(title, body, action) {
  return html`<div class="state state--empty" role="status">
    <p class="state__title">${title}</p>
    ${body ? html`<p class="state__body">${body}</p>` : ''}
    ${action ?? ''}
  </div>`;
}

/** @param {string} title @param {string} message */
export function errorState(title, message) {
  return html`<div class="state state--error" role="alert">
    <p class="state__title">${title}</p>
    <p class="state__body">${message}</p>
    <button type="button" class="btn" data-action="retry">Try again</button>
  </div>`;
}

/** Static placeholder rows. No shimmer: motion is reserved for meaning. @param {number} [rows] */
export function skeleton(rows = 8) {
  return html`<div class="skeleton" aria-busy="true" aria-label="Loading">
    ${Array.from({ length: rows }, () => html`<div class="skeleton__row"></div>`)}
  </div>`;
}

/** Horizontal meter, CSP-safe (SVG attributes, no inline style). @param {number | null} value 0-1 @param {string} [tone] */
export function meter(value, tone = 'accent') {
  if (value === null || value === undefined) {
    return html`<svg class="meter meter--unknown" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect class="meter__track" x="0" y="0" width="100" height="6" rx="3"></rect></svg>`;
  }
  const width = Math.max(0, Math.min(100, value * 100));
  return html`<svg class="meter meter--${tone}" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true">
    <rect class="meter__track" x="0" y="0" width="100" height="6" rx="3"></rect>
    <rect class="meter__fill" x="0" y="0" width="${width.toFixed(1)}" height="6" rx="3"></rect>
  </svg>`;
}
