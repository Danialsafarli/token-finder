// @ts-check
/**
 * Board: the live ranking.
 *
 * Leads with what only Token Finder knows - the verdict and the reason for it -
 * and puts commodity market data after. Only LIVE tokens appear: evaluated, and
 * evaluated recently enough that their market evidence is still current by the
 * engine's own freshness rules. Everything else is history, and search still
 * finds it.
 */

import { appUrl, html, render } from '../lib/html.js';
import { api } from '../lib/api.js';
import { age, ago, count, pct, span, usd } from '../lib/format.js';
import { navigate, setQuery } from '../lib/router.js';
import { liveState, onServerEvent } from '../lib/live.js';
import { mountOrb } from '../ui/orb.js';
import {
  dossierUrl,
  emptyState,
  errorState,
  scoreRing,
  skeleton,
  timeAgo,
  tokenIcon,
  toneClass,
  verdictChip,
} from '../ui/components.js';

/**
 * @typedef {{
 *   mint: string, symbol: string, name: string, icon: string | null, verified: boolean,
 *   verdict: string, reason: string, tone: string, score: number, coverage: number, confidence: number,
 *   measured: number | null, signals: number | null, liquidityUsd: number | null, volume24h: number | null,
 *   change1h: number | null, change24h: number | null, ageHours: number | null, lastSeenAt: number,
 *   freshness: 'FRESH' | 'AGING', program: string | null
 * }} BoardRow
 * @typedef {{
 *   generatedAt: number, window: { liveMinutes: number, freshMinutes: number },
 *   query: { segment: string, q: string, sort: string, limit: number },
 *   counts: Record<string, number>, universe: { live: number, stale: number, unevaluated: number, total: number },
 *   total: number, rows: BoardRow[],
 *   history: { mint: string, symbol: string, name: string, universe: string, verdict: string | null, lastSeenAt: number }[],
 *   gaps: { label: string, impact: string, enableWith: string | null }[],
 *   rules: { minCoverageQualify: number, minCoverageWatch: number }
 * }} BoardResponse
 */

const SEGMENTS = [
  { id: 'all', label: 'All live', countKey: 'all' },
  { id: 'qualified', label: 'Qualified', countKey: 'QUALIFIED' },
  { id: 'watch', label: 'Watch', countKey: 'WATCH' },
  { id: 'insufficient', label: 'Insufficient data', countKey: 'INSUFFICIENT_DATA' },
  { id: 'rejected', label: 'Rejected', countKey: 'REJECTED' },
];

const SORTS = [
  { id: 'verdict', label: 'Verdict' },
  { id: 'score', label: 'Score' },
  { id: 'liquidity', label: 'Liquidity' },
  { id: 'momentum', label: '1h move' },
  { id: 'newest', label: 'Newest launch' },
  { id: 'seen', label: 'Last evaluated' },
];

/** @param {string} segment @param {{ q: string, sort: string }} query */
function segmentHref(segment, query) {
  const params = new URLSearchParams();
  if (segment !== 'all') params.set('segment', segment);
  if (query.sort && query.sort !== 'verdict') params.set('sort', query.sort);
  if (query.q) params.set('q', query.q);
  const search = params.toString();
  return appUrl(search ? `/discover?${search}` : '/discover');
}

const VERDICT_LABEL = /** @type {Record<string, string>} */ ({
  QUALIFIED: 'Qualified',
  WATCH: 'Watch',
  INSUFFICIENT_DATA: 'Insufficient data',
  REJECTED: 'Rejected',
});

/**
 * Rows arrive sorted verdict-first, so consecutive runs are the groups.
 * @param {BoardRow[]} rows @returns {[string, BoardRow[]][]}
 */
function groups(rows) {
  /** @type {[string, BoardRow[]][]} */
  const out = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && last[0] === row.verdict) last[1].push(row);
    else out.push([row.verdict, [row]]);
  }
  return out;
}

/**
 * A group's size is the engine's count for that verdict, not the rows that
 * happen to be on screen - when the list is truncated the header says so.
 * @param {BoardResponse} data @param {string} verdict @param {number} shown
 */
function groupCount(data, verdict, shown) {
  const total = data.query.q ? shown : data.counts[verdict] ?? shown;
  return total > shown ? `${count(shown)} of ${count(total)}` : count(total);
}

/** The rule that puts a token in this group, from the engine's own thresholds. @param {string} verdict @param {{ minCoverageQualify: number, minCoverageWatch: number }} rules */
function groupRule(verdict, rules) {
  const q = Math.round(rules.minCoverageQualify * 100);
  const w = Math.round(rules.minCoverageWatch * 100);
  switch (verdict) {
    case 'QUALIFIED':
      return `No hard vetoes · at least ${q}% of evidence measured`;
    case 'WATCH':
      return `No hard vetoes · ${w}–${q}% of evidence measured`;
    case 'INSUFFICIENT_DATA':
      return `Under ${w}% of evidence measured`;
    case 'REJECTED':
      return 'Failed at least one hard veto';
    default:
      return '';
  }
}

/** @param {number | null} value */
function move(value) {
  if (value === null) return html`<span class="muted">—</span>`;
  const dir = value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
  return html`<span class="move move--${dir}">${pct(value)}</span>`;
}

/**
 * A row in five columns. The reason - Token Finder's own intelligence, and the
 * most important thing in the row - rides under the symbol rather than taking
 * a column. When a scan evaluated the token is shown once, in the Board's
 * header; a row older than the fresh window keeps a small marker, because
 * that is information, not repetition.
 * @param {BoardRow} row
 */
function rowTemplate(row) {
  const href = dossierUrl(row.mint);
  const aging = row.freshness === 'AGING';
  return html`<tr class="board-row" data-mint="${row.mint}" data-verdict="${row.verdict}">
    <td class="col-token">
      <a class="token-link" href="${href}" data-link data-row-link title="${row.symbol} · ${row.name}">
        ${tokenIcon(row)}
        <span class="token-link__text">
          <span class="sr-only">${VERDICT_LABEL[row.verdict] ?? row.verdict}: </span>
          <span class="token-link__line">
            <span class="token-link__symbol">${row.symbol}</span>${row.verified ? html`<span class="badge badge--verified" title="Verified on Jupiter">Verified</span>` : ''}${row.program === 'TOKEN_2022' ? html`<span class="badge" title="Token-2022 program">T22</span>` : ''}
            <span class="token-link__name">${row.name}</span>
            ${aging ? html`<span class="aging" title="Evaluated ${ago(row.lastSeenAt)}"><span class="sr-only">, evaluated ${ago(row.lastSeenAt)}</span></span>` : ''}
          </span>
          <span class="token-link__reason reason ${toneClass(row.tone)}">${row.reason}</span>
        </span>
      </a>
    </td>
    <td class="col-score">${scoreRing(row.score, row.coverage)}</td>
    <td class="col-num">${usd(row.liquidityUsd)}</td>
    <td class="col-num">${move(row.change1h)}</td>
    <td class="col-num col-age">${age(row.ageHours)}</td>
  </tr>`;
}

/** Mobile representation: a card per token, same information, same order of importance. @param {BoardRow} row */
function cardTemplate(row) {
  return html`<li class="card" data-verdict="${row.verdict}">
    <a class="card__link" href="${dossierUrl(row.mint)}" data-link data-row-link>
      <span class="card__head">
        ${tokenIcon(row, 32)}
        <span class="card__id">
          <span class="card__symbol">${row.symbol}</span>
          <span class="card__name">${row.name}</span>
        </span>
        ${scoreRing(row.score, row.coverage)}
      </span>
      <span class="card__verdict"><span class="sr-only">${VERDICT_LABEL[row.verdict] ?? row.verdict}: </span><span class="reason ${toneClass(row.tone)}">${row.reason}</span></span>
      <span class="card__facts">
        <span><span class="card__k">Liq</span> ${usd(row.liquidityUsd)}</span>
        <span><span class="card__k">1h</span> ${move(row.change1h)}</span>
        <span><span class="card__k">Age</span> ${age(row.ageHours)}</span>
        ${row.freshness === 'AGING' ? html`<span class="card__aging"><span class="aging" aria-hidden="true"></span>evaluated ${ago(row.lastSeenAt)}</span>` : ''}
      </span>
    </a>
  </li>`;
}

/**
 * When the Board's evidence was gathered, stated once. The scan time comes from
 * the live status; if a scan is running now, that is said too.
 * @param {BoardResponse} data
 */
function freshnessLine(data) {
  const status = liveState().status;
  const last = status?.lastScanAt ?? null;
  const aging = data.rows.some((row) => row.freshness === 'AGING');
  return html`<p class="board-head__fresh">
    ${status?.scanning ? html`<span class="board-head__scanning">Scan in progress</span> · ` : ''}${last ? html`Last scan ${ago(last)}` : 'No scan yet'}
    ${aging ? html`<span class="board-head__legend"><span class="aging" aria-hidden="true"></span>evaluated over ${data.window.freshMinutes} min ago</span>` : ''}
  </p>`;
}

/** @param {BoardResponse} data */
function gapBanner(data) {
  if (data.gaps.length === 0) return '';
  const labels = data.gaps.map((gap) => gap.label.toLowerCase()).join(', ');
  const keys = [...new Set(data.gaps.map((gap) => gap.enableWith).filter(Boolean))];
  return html`<aside class="notice notice--warn" aria-label="Capability notice">
    <span class="notice__icon" aria-hidden="true">!</span>
    <div class="notice__body">
      <strong>On-chain checks are off.</strong>
      No verdict below includes ${labels}. ${data.gaps[0]?.impact ?? ''}
      ${keys.length ? html`<span class="notice__fix">Set <code>${keys.join(', ')}</code> · <a href="${appUrl('/system')}" data-link>What this instance checks</a></span>` : html`<a href="${appUrl('/system')}" data-link>What this instance checks</a>`}
    </div>
  </aside>`;
}

/** @param {BoardResponse} data */
function historyMatches(data) {
  if (!data.query.q || data.history.length === 0) return '';
  return html`<section class="history-matches" aria-labelledby="hm-title">
    <h2 id="hm-title" class="section-title">Not on the live Board</h2>
    <p class="muted small">These match your search but were not evaluated in the last ${span(data.window.liveMinutes)}, so their verdicts describe the past.</p>
    <ul class="history-list">
      ${data.history.map(
        (item) => html`<li>
          <a href="${dossierUrl(item.mint)}" data-link class="history-list__link">
            <span class="history-list__symbol">${item.symbol}</span>
            <span class="muted">${item.name}</span>
            <span class="history-list__state">${item.universe === 'UNEVALUATED' ? html`<span class="tag tag--unknown">Never evaluated</span>` : html`${verdictChip(item.verdict)} <span class="muted small">last evaluated ${timeAgo(item.lastSeenAt)}</span>`}</span>
          </a>
        </li>`,
      )}
    </ul>
  </section>`;
}

/**
 * The two regions a Board refresh repaints: the head (title and counts) and the
 * main column (notices, toolbar, table, history matches).
 * @param {BoardResponse} data
 */
function boardTemplate(data) {
  const segment = data.query.segment;
  const rows = data.rows;

  let body;
  if (rows.length === 0) {
    if (data.query.q) {
      body = emptyState(`No live token matches “${data.query.q}”.`, data.history.length ? 'Some tokens outside the live window match — see below.' : 'Try a symbol, a name or a mint address.');
    } else if (data.universe.live === 0) {
      body = emptyState(
        `No token has been evaluated in the last ${span(data.window.liveMinutes)}.`,
        html`The Board only shows verdicts whose market evidence is still current. ${data.universe.stale > 0 ? html`${count(data.universe.stale)} earlier verdicts are in history — search to find one.` : ''} A new scan will repopulate it.`,
      );
    } else {
      const label = SEGMENTS.find((s) => s.id === segment)?.label ?? segment;
      body = emptyState(`No live tokens are ${label.toLowerCase()} right now.`, `${count(data.universe.live)} live tokens in other verdicts.`, html`<a class="btn" href="${appUrl('/discover')}" data-link>Show all live</a>`);
    }
  } else {
    body = html`
      <div class="table-scroll">
        <table class="board" aria-describedby="board-caption">
          <caption id="board-caption" class="sr-only">Live tokens, ${segment} view, ${data.total} rows. Use j and k to move between rows and Enter to open.</caption>
          <thead>
            <tr>
              <th scope="col">Token <span class="th-note">· why</span></th>
              <th scope="col" class="col-score" title="Score in the centre; the ring shows coverage — how much of the evidence was measured">Score</th>
              <th scope="col" class="col-num">Liquidity</th>
              <th scope="col" class="col-num">1h</th>
              <th scope="col" class="col-num col-age">Age</th>
            </tr>
          </thead>
          ${groups(rows).map(
            ([verdict, items]) => html`<tbody class="group group--${verdict.toLowerCase()}">
              <tr class="group-row"><th scope="rowgroup" colspan="5">
                ${verdictChip(verdict)}
                <span class="group-row__count">${groupCount(data, verdict, items.length)}</span>
                <span class="group-row__rule">${groupRule(verdict, data.rules)}</span>
              </th></tr>
              ${items.map(rowTemplate)}
            </tbody>`,
          )}
        </table>
      </div>
      <div class="cards">
        ${groups(rows).map(
          ([verdict, items]) => html`<section class="card-group" aria-label="${VERDICT_LABEL[verdict] ?? verdict}">
            <h2 class="card-group__head">${verdictChip(verdict)}<span class="group-row__count">${groupCount(data, verdict, items.length)}</span><span class="group-row__rule">${groupRule(verdict, data.rules)}</span></h2>
            <ol class="card-list">${items.map(cardTemplate)}</ol>
          </section>`,
        )}
      </div>
      ${data.total > rows.length ? html`<p class="muted small center">Showing ${rows.length} of ${count(data.total)}.</p>` : ''}`;
  }

  const head = html`
          <div class="board-head__title">
            <h1 id="board-title">Live board</h1>
            <p class="board-head__sub">
              <strong>${count(data.universe.live)}</strong> tokens evaluated in the last ${span(data.window.liveMinutes)} ·
              <span class="tone--good">${count(data.counts.QUALIFIED ?? 0)} qualified</span> ·
              <span class="tone--bad">${count(data.counts.REJECTED ?? 0)} rejected</span>
              ${data.counts.WATCH ? html` · <span class="tone--warn">${count(data.counts.WATCH)} watch</span>` : ''}
            </p>
            ${freshnessLine(data)}
          </div>`;

  const main = html`
        ${gapBanner(data)}

        <div class="toolbar" role="search">
          <nav class="segments" aria-label="Filter by verdict">
            ${SEGMENTS.filter((s) => s.id !== 'insufficient' || (data.counts.INSUFFICIENT_DATA ?? 0) > 0).map(
              (s) => html`<a class="segment ${segment === s.id ? 'is-active' : ''}" href="${segmentHref(s.id, data.query)}" data-link data-segment="${s.id}" ${segment === s.id ? html`aria-current="page"` : ''}>
                ${s.label} <span class="segment__count">${count(data.counts[s.countKey] ?? 0)}</span>
              </a>`,
            )}
          </nav>
          <div class="toolbar__controls">
            <label class="search">
              <span class="sr-only">Search tokens</span>
              <svg class="search__icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"></circle><path d="M10.5 10.5 14 14"></path></svg>
              <input id="board-search" type="search" placeholder="Search symbol, name or mint" value="${data.query.q}" autocomplete="off" spellcheck="false" />
              <kbd class="search__hint" aria-hidden="true">/</kbd>
            </label>
            <label class="select">
              <span class="sr-only">Sort</span>
              <select id="board-sort">
                ${SORTS.map((s) => html`<option value="${s.id}" ${s.id === data.query.sort ? html`selected` : ''}>${s.label}</option>`)}
              </select>
            </label>
          </div>
        </div>

        <div class="board-body">${body}</div>
        ${historyMatches(data)}`;

  return { head, main };
}

/**
 * The page skeleton. Rendered once per mount: the Board repaints its head, main
 * and rail slots, and never the Observatory's, so its canvas and animation
 * survive every refresh.
 *
 * The Observatory is the page's hero, on the left on wide screens and first
 * on narrow ones; the Board is the compact panel beside or below it. Recent
 * verdict changes sit in the Observatory's footer, beside its readout.
 */
const shellTemplate = () => html`
  <div class="board-layout">
    <div class="board-hero" data-slot="orb"></div>
    <section class="board-panel" aria-labelledby="board-title">
      <header class="board-head" data-slot="head"></header>
      <div class="board-main" data-slot="main">${skeleton(10)}</div>
    </section>
  </div>`;

/** @param {any[] | null} changes */
const railSection = (changes) => html`
  <h3 id="rail-title" class="section-title">Recent verdict changes</h3>
  ${railTemplate(changes)}
  <a class="rail__more" href="${appUrl('/changes')}" data-link>All changes →</a>`;

/** @param {any[] | null} changes */
function railTemplate(changes) {
  if (changes === null) return skeleton(3);
  if (changes.length === 0) {
    return html`<p class="muted small">No verdict has changed yet. Changes appear here when a token moves between Qualified, Watch and Rejected.</p>`;
  }
  return html`<ol class="rail-list">
    ${changes.slice(0, 4).map(
      (change) => html`<li>
        <a href="${dossierUrl(change.mint, 'history')}" data-link class="rail-item">
          <span class="rail-item__top"><strong>${change.symbol ?? change.mint.slice(0, 6)}</strong>${timeAgo(change.at)}</span>
          <span class="transition">${verdictChip(change.from)}<span class="transition__arrow" aria-label="to">→</span>${verdictChip(change.to)}</span>
          <span class="rail-item__reason">${change.reason}</span>
        </a>
      </li>`,
    )}
  </ol>`;
}

/**
 * @param {HTMLElement} root
 * @param {import('../lib/router.js').Route} route
 */
export function mountBoard(root, route) {
  const query = {
    segment: route.query.get('segment') ?? 'all',
    sort: route.query.get('sort') ?? 'verdict',
    q: route.query.get('q') ?? '',
  };
  /** @type {BoardResponse | null} */
  let data = null;
  /** @type {{ changes: any[] | null }} */
  const rail = { changes: null };
  let disposed = false;
  let focusIndex = -1;

  const load = async () => {
    const params = new URLSearchParams({ segment: query.segment, sort: query.sort, limit: '300' });
    if (query.q) params.set('q', query.q);
    try {
      const next = await api(`/api/board?${params}`);
      if (disposed) return;
      data = /** @type {BoardResponse} */ (next);
      paint();
    } catch (error) {
      if (disposed) return;
      if (data) {
        // Keep the last good data, but the connection banner makes clear it is not live.
        return;
      }
      render(slots.main, errorState('The Board could not be loaded.', error instanceof Error ? error.message : String(error)));
    }
  };

  const loadRail = async () => {
    try {
      const next = await api('/api/changes?limit=4');
      if (disposed) return;
      rail.changes = /** @type {any} */ (next).changed;
      if (data) paint();
    } catch {
      rail.changes = rail.changes ?? [];
    }
  };

  const rowLinks = () => /** @type {HTMLAnchorElement[]} */ ([...root.querySelectorAll('.board [data-row-link]')]);

  const paint = () => {
    if (!data) return;
    const active = document.activeElement;
    const hadSearchFocus = active instanceof HTMLInputElement && active.id === 'board-search';
    const caret = hadSearchFocus ? active.selectionStart : null;
    const { head, main } = boardTemplate(data);
    render(slots.head, head);
    render(slots.main, main);
    render(slots.rail, railSection(rail.changes));
    if (hadSearchFocus) {
      const input = /** @type {HTMLInputElement | null} */ (root.querySelector('#board-search'));
      input?.focus();
      if (input && caret !== null) input.setSelectionRange(caret, caret);
    } else if (focusIndex >= 0) {
      rowLinks()[Math.min(focusIndex, rowLinks().length - 1)]?.focus();
    }
  };

  render(root, shellTemplate());
  const slot = (/** @type {string} */ name) => /** @type {HTMLElement} */ (root.querySelector(`[data-slot="${name}"]`));
  const orb = mountOrb(slot('orb'));
  orb.aside.classList.add('rail');
  orb.aside.setAttribute('aria-labelledby', 'rail-title');
  const slots = { head: slot('head'), main: slot('main'), rail: orb.aside };
  render(slots.rail, railSection(null));

  let debounce = 0;
  const onInput = (/** @type {Event} */ event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    if (target.id === 'board-search') {
      query.q = /** @type {HTMLInputElement} */ (target).value.trim();
      setQuery({ q: query.q || null });
      clearTimeout(debounce);
      debounce = window.setTimeout(load, 200);
    }
  };
  const onChange = (/** @type {Event} */ event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    if (target.id === 'board-sort') {
      query.sort = /** @type {HTMLSelectElement} */ (target).value;
      setQuery({ sort: query.sort === 'verdict' ? null : query.sort });
      void load();
    }
  };
  /** Whole-row click for pointer users; the token cell's link serves keyboard and new-tab use. */
  const onClick = (/** @type {MouseEvent} */ event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    if (target.closest('[data-action="retry"]')) return void load();
    if (target.closest('a, button, input, select, label')) return;
    const row = target.closest('tr.board-row');
    if (!(row instanceof HTMLElement) || event.button !== 0) return;
    if (window.getSelection()?.toString()) return; // user is selecting text
    const link = row.querySelector('[data-row-link]');
    if (link instanceof HTMLAnchorElement) navigate(new URL(link.href).pathname);
  };
  /** j/k move between rows; Enter follows the focused row's link (native). */
  const onKey = (/** @type {KeyboardEvent} */ event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) {
      if (event.key === 'Escape' && target.id === 'board-search' && target.value) {
        target.value = '';
        target.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'j' || event.key === 'k') {
      const links = rowLinks().filter((link) => link.offsetParent !== null);
      if (links.length === 0) return;
      const current = links.indexOf(/** @type {HTMLAnchorElement} */ (document.activeElement));
      const next = event.key === 'j' ? Math.min(links.length - 1, current + 1) : Math.max(0, current <= 0 ? 0 : current - 1);
      focusIndex = next;
      links[next]?.focus();
      links[next]?.closest('tr, li')?.scrollIntoView({ block: 'nearest' });
      event.preventDefault();
    } else if (event.key === '/') {
      const input = /** @type {HTMLInputElement | null} */ (root.querySelector('#board-search'));
      if (input) {
        input.focus();
        input.select();
        event.preventDefault();
      }
    }
  };

  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  root.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);

  let refresh = 0;
  const offServer = onServerEvent((kind) => {
    // The header's freshness line says when a scan is running.
    if (kind === 'scan-start' && data) render(slots.head, boardTemplate(data).head);
    if (kind === 'scan' || kind === 'reconnected') {
      clearTimeout(refresh);
      refresh = window.setTimeout(() => {
        void load();
        void loadRail();
      }, 400);
    }
  });

  // Minute-level ages ("4m ago") should not freeze between scans.
  const tick = window.setInterval(() => {
    if (data && !(document.activeElement instanceof HTMLInputElement)) paint();
  }, 30_000);

  void load();
  void loadRail();

  return {
    /** Segment and sort links update in place: no remount, no skeleton flash. @param {import('../lib/router.js').Route} next */
    update(next) {
      query.segment = next.query.get('segment') ?? 'all';
      query.sort = next.query.get('sort') ?? 'verdict';
      query.q = next.query.get('q') ?? '';
      focusIndex = -1;
      void load();
      return true;
    },
    dispose() {
      disposed = true;
      orb.dispose();
      offServer();
      clearInterval(tick);
      clearTimeout(refresh);
      clearTimeout(debounce);
      root.removeEventListener('input', onInput);
      root.removeEventListener('change', onChange);
      root.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    },
  };
}
