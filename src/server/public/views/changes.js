// @ts-check
/**
 * Changes: what moved, across every token.
 *
 * Three streams, kept apart because they mean different things:
 *
 *   Verdict changes    a token moved between Qualified, Watch, Insufficient
 *                      data and Rejected. Rare, and the reason this surface exists.
 *   Market alerts      liquidity drops, sharp price moves, new risk findings -
 *                      real monitor events, not verdicts.
 *   First assessments  a token was assessed for the first time. Common; shown
 *                      last and collapsed so they cannot drown the changes.
 *
 * Every item is a stored row. Nothing is narrated that did not happen.
 */

import { appUrl, html, render } from '../lib/html.js';
import { api } from '../lib/api.js';
import { ago, clock, count, price, usd, when } from '../lib/format.js';
import { onServerEvent } from '../lib/live.js';
import { dossierUrl, emptyState, errorState, skeleton, toneClass, verdictChip } from '../ui/components.js';

/** @param {number} at */
function dayLabel(at) {
  const date = new Date(at);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * @template {{ at: number }} T
 * @param {T[]} items @returns {[string, T[]][]}
 */
function byDay(items) {
  /** @type {Map<string, T[]>} */
  const groups = new Map();
  for (const item of items) {
    const key = dayLabel(item.at);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return [...groups.entries()];
}

/**
 * Within today, relative time reads best ("30m ago"). Under an earlier day's
 * heading, "2h ago" contradicts the heading, so the clock time is shown instead.
 * @param {number} at
 */
function streamTime(at) {
  const today = new Date().toDateString() === new Date(at).toDateString();
  return html`<time datetime="${new Date(at).toISOString()}" title="${when(at)} · ${ago(at)}">${today ? ago(at) : clock(at)}</time>`;
}

/** @param {any} change */
function changeRow(change) {
  return html`<li class="stream-item">
    <a class="stream-item__link" href="${dossierUrl(change.mint, 'history')}" data-link>
      <span class="stream-item__time">${streamTime(change.at)}</span>
      <span class="stream-item__token">${change.symbol ?? change.mint.slice(0, 6)}<span class="stream-item__name">${change.name ?? ''}</span></span>
      <span class="transition">${change.from ? html`${verdictChip(change.from)}<span class="transition__arrow" aria-label="to">→</span>` : ''}${verdictChip(change.to)}</span>
      <span class="stream-item__reason ${toneClass(change.tone)}">${change.reason}</span>
      <span class="stream-item__context">${change.liquidityUsd !== null ? `Liquidity ${usd(change.liquidityUsd)}` : ''}${change.priceUsd !== null ? ` · ${price(change.priceUsd)}` : ''}${change.policyVersion ? html` · <code class="small">${change.policyVersion}</code>` : ''}</span>
      ${change.details?.length ? html`<span class="stream-item__details">${change.details.map((/** @type {string} */ d) => html`<span>${d}</span>`)}</span>` : ''}
    </a>
  </li>`;
}

const EVENT_TONE = /** @type {Record<string, string>} */ ({ critical: 'bad', high: 'bad', medium: 'warn', low: 'neutral', info: 'neutral' });

/** @param {any} event */
function eventRow(event) {
  return html`<li class="stream-item">
    <a class="stream-item__link" href="${dossierUrl(event.mint)}" data-link>
      <span class="stream-item__time">${streamTime(event.at)}</span>
      <span class="stream-item__token">${event.symbol}</span>
      <span class="tag tag--${EVENT_TONE[event.level] ?? 'neutral'}">${event.kindLabel}</span>
      <span class="stream-item__reason">${event.message}</span>
    </a>
  </li>`;
}

/** @param {any} data @param {string} view */
function template(data, view) {
  const views = [
    { id: 'verdicts', label: 'Verdict changes', n: data.changed.length },
    { id: 'alerts', label: 'Market alerts', n: data.events.length },
    { id: 'first', label: 'First assessments', n: data.first.count },
  ];

  let body;
  if (view === 'alerts') {
    body = data.events.length
      ? html`${byDay(data.events).map(([day, items]) => html`<section class="day"><h2 class="section-title">${day}</h2><ol class="stream">${items.map(eventRow)}</ol></section>`)}`
      : emptyState('No market alerts recorded.', 'Alerts are raised when liquidity drops, price moves sharply or a new risk finding appears.');
  } else if (view === 'first') {
    body = data.first.recent.length
      ? html`<p class="muted small">${count(data.first.count)} tokens have been assessed. The ${data.first.recent.length} most recent are listed.</p>
          <ol class="stream">${data.first.recent.map(changeRow)}</ol>`
      : emptyState('No token has been assessed yet.');
  } else {
    body = data.changed.length
      ? html`${byDay(data.changed).map(([day, items]) => html`<section class="day"><h2 class="section-title">${day}</h2><ol class="stream">${items.map(changeRow)}</ol></section>`)}`
      : emptyState(
          'No verdict has changed yet.',
          html`${count(data.first.count)} tokens have been assessed and each has held its first verdict. A change appears here the moment a token moves between Qualified, Watch and Rejected.`,
        );
  }

  return html`<section class="changes-page" aria-labelledby="changes-title">
    <header class="page-head">
      <h1 id="changes-title">Changes</h1>
      <p class="page-head__sub">What Token Finder's conclusions did recently, across every token it tracks.</p>
    </header>
    <nav class="segments" aria-label="Kind of change">
      ${views.map(
        (v) => html`<a class="segment ${view === v.id ? 'is-active' : ''}" href="${appUrl(v.id === 'verdicts' ? '/changes' : `/changes?view=${v.id}`)}" data-link ${view === v.id ? html`aria-current="page"` : ''}>${v.label} <span class="segment__count">${count(v.n)}</span></a>`,
      )}
    </nav>
    <div class="changes-body">${body}</div>
  </section>`;
}

/**
 * @param {HTMLElement} root
 * @param {import('../lib/router.js').Route} route
 */
export function mountChanges(root, route) {
  let view = route.query.get('view') ?? 'verdicts';
  /** @type {any} */
  let data = null;
  let disposed = false;

  const paint = () => data && render(root, template(data, view));
  const load = async () => {
    try {
      data = await api('/api/changes?limit=200');
      if (!disposed) paint();
    } catch (error) {
      if (!disposed && !data) render(root, errorState('Changes could not be loaded.', error instanceof Error ? error.message : String(error)));
    }
  };
  const onClick = (/** @type {MouseEvent} */ event) => {
    if (/** @type {HTMLElement} */ (event.target).closest('[data-action="retry"]')) void load();
  };
  root.addEventListener('click', onClick);
  const off = onServerEvent((kind) => {
    if (kind === 'scan' || kind === 'decision' || kind === 'alert' || kind === 'reconnected') void load();
  });
  const tick = window.setInterval(paint, 30_000);

  render(root, skeleton(8));
  void load();
  document.title = 'Changes — Token Finder';

  return {
    /** @param {import('../lib/router.js').Route} next */
    update(next) {
      view = next.query.get('view') ?? 'verdicts';
      paint();
      return true;
    },
    dispose() {
      disposed = true;
      off();
      clearInterval(tick);
      root.removeEventListener('click', onClick);
    },
  };
}

