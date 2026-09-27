// @ts-check
/**
 * History-API router.
 *
 * Path routes (`/t/<mint>/evidence`) rather than hash routes, so a Dossier has a
 * real URL that can be bookmarked, shared and opened in a new tab. The server
 * answers any extension-less path with the app shell.
 *
 * Links are ordinary `<a href>` elements marked `data-link`. A plain left click
 * is handled here; a modified click (Ctrl/Cmd/Shift/middle button) is left to the
 * browser, so "open in new tab" keeps working everywhere.
 */

/** @typedef {{ name: string, params: Record<string, string>, query: URLSearchParams }} Route */

const MINT = '([1-9A-HJ-NP-Za-km-z]{16,64})';

/** @type {{ name: string, pattern: RegExp, keys: string[] }[]} */
const ROUTES = [
  // The landing and an on-demand analysis are one view in different states, so
  // moving between them animates in place rather than remounting.
  { name: 'landing', pattern: /^\/$/, keys: [] },
  { name: 'landing', pattern: new RegExp(`^/analyze/${MINT}/?$`), keys: ['mint'] },
  { name: 'board', pattern: /^\/discover\/?$/, keys: [] },
  { name: 'dossier', pattern: new RegExp(`^/t/${MINT}(?:/([a-z]+))?/?$`), keys: ['mint', 'tab'] },
  { name: 'changes', pattern: /^\/changes\/?$/, keys: [] },
  { name: 'system', pattern: /^\/system\/?$/, keys: [] },
];

/** @param {Location | URL} location @returns {Route} */
export function match(location) {
  for (const route of ROUTES) {
    const hit = route.pattern.exec(location.pathname);
    if (!hit) continue;
    /** @type {Record<string, string>} */
    const params = {};
    route.keys.forEach((key, index) => {
      const value = hit[index + 1];
      if (value !== undefined) params[key] = value;
    });
    return { name: route.name, params, query: new URLSearchParams(location.search) };
  }
  return { name: 'not-found', params: {}, query: new URLSearchParams(location.search) };
}

/** @type {Set<(route: Route) => void>} */
const listeners = new Set();

/** @param {(route: Route) => void} listener */
export function onRoute(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  const route = match(window.location);
  for (const listener of listeners) listener(route);
}

/**
 * @param {string} path
 * @param {{ replace?: boolean }} [options]
 */
export function navigate(path, options = {}) {
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin) return;
  const target = `${url.pathname}${url.search}`;
  if (target === `${window.location.pathname}${window.location.search}`) return;
  if (options.replace) history.replaceState(null, '', target);
  else history.pushState(null, '', target);
  emit();
}

/** Updates the query string without a new history entry or a re-render. */
export function setQuery(/** @type {Record<string, string | null>} */ values) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === '') url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  history.replaceState(null, '', `${url.pathname}${url.search}`);
}

export function currentRoute() {
  return match(window.location);
}

export function startRouter() {
  window.addEventListener('popstate', emit);
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = /** @type {HTMLElement | null} */ (event.target instanceof Element ? event.target.closest('a[data-link]') : null);
    if (!(anchor instanceof HTMLAnchorElement)) return;
    if (anchor.target && anchor.target !== '_self') return;
    const url = new URL(anchor.href);
    if (url.origin !== window.location.origin) return;
    event.preventDefault();
    navigate(`${url.pathname}${url.search}`);
  });
  emit();
}
