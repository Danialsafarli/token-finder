// @ts-check
/**
 * Application shell: routing, the live-connection indicator, and the few
 * behaviours every surface shares.
 */

import { html, render } from './lib/html.js';
import { onRoute, startRouter } from './lib/router.js';
import { liveState, onLive, onServerEvent, startLive } from './lib/live.js';
import { ago, clock } from './lib/format.js';
import { emptyState } from './ui/components.js';
import { mountBoard } from './views/board.js';
import { mountLanding } from './views/landing.js';
import { mountDossier } from './views/dossier.js';
import { mountChanges } from './views/changes.js';
import { mountSystem } from './views/system.js';
import { appUrl } from './lib/html.js';

/** @typedef {{ dispose?: () => void, update?: (route: import('./lib/router.js').Route) => boolean }} ViewHandle */

const main = /** @type {HTMLElement} */ (document.getElementById('main'));
const liveText = /** @type {HTMLElement} */ (document.getElementById('live-text'));
const scanButton = /** @type {HTMLButtonElement} */ (document.getElementById('scan-now'));
const banner = /** @type {HTMLElement} */ (document.getElementById('conn-banner'));

/** @type {{ name: string | null, handle: ViewHandle | null }} */
const current = { name: null, handle: null };
let firstRoute = true;

/** @param {import('./lib/router.js').Route} route @returns {ViewHandle} */
function mount(route) {
  switch (route.name) {
    case 'landing':
      return mountLanding(main, route);
    case 'board':
      document.title = 'Live discovery — Token Finder';
      return mountBoard(main, route);
    case 'dossier':
      return mountDossier(main, route);
    case 'changes':
      return mountChanges(main, route);
    case 'system':
      return mountSystem(main);
    default:
      document.title = 'Not found — Token Finder';
      render(main, emptyState('There is nothing at this address.', 'It may be a mistyped link.', html`<a class="btn" href="${appUrl('/')}" data-link>Go to Token Finder</a>`));
      return {};
  }
}

onRoute((route) => {
  for (const link of document.querySelectorAll('[data-nav]')) {
    const section = route.name === 'board' ? 'discover' : route.name;
    if (link instanceof HTMLElement && link.dataset.nav === section) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }

  if (current.name === route.name && current.handle?.update?.(route)) return;

  current.handle?.dispose?.();
  current.name = route.name;
  window.scrollTo({ top: 0 });
  current.handle = mount(route);

  // Move focus to the new content for keyboard and screen-reader users, but not
  // on first load, where it would steal the browser's own initial focus.
  if (!firstRoute) main.focus({ preventScroll: true });
  firstRoute = false;
});

// --- live indicator ---------------------------------------------------------

function paintLive() {
  const state = liveState();
  const status = state.status;
  document.body.dataset.connection = state.connection;

  let text = 'Connecting…';
  if (state.connection === 'live') {
    if (status?.scanning) text = 'Scanning…';
    else if (status?.lastScanAt) text = `Live · scanned ${ago(status.lastScanAt)}`;
    else text = 'Live · no scan yet';
  } else if (state.connection === 'reconnecting') {
    text = 'Reconnecting…';
  } else if (state.connection === 'offline') {
    text = 'Offline';
  }
  if (liveText.textContent !== text) liveText.textContent = text;
  document.body.dataset.scanning = status?.scanning ? 'true' : 'false';
  scanButton.disabled = state.connection !== 'live' || status?.scanning === true;

  if (state.connection === 'offline' || state.connection === 'reconnecting') {
    const since = state.lastContactAt ? ` Showing what was loaded at ${clock(state.lastContactAt)} — it may be out of date.` : '';
    render(banner, html`<strong>${state.connection === 'offline' ? 'The Token Finder server cannot be reached.' : 'Connection lost. Reconnecting…'}</strong>${since} Retrying automatically.`);
    banner.dataset.kind = 'offline';
    banner.hidden = false;
  } else if (status && !status.persistence.healthy) {
    render(banner, html`<strong>History is not being recorded.</strong> The live Board is unaffected. <a href="${appUrl('/system')}" data-link>Details</a>`);
    banner.dataset.kind = 'degraded';
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

onLive(paintLive);
setInterval(paintLive, 15_000);

onServerEvent((kind) => {
  if (kind === 'scan-failed') {
    liveText.textContent = 'Last scan failed — see System';
  }
});

scanButton.addEventListener('click', async () => {
  scanButton.disabled = true;
  try {
    const response = await fetch('/api/scan', { method: 'POST' });
    if (!response.ok && response.status !== 409) liveText.textContent = 'Scan could not start';
  } catch {
    liveText.textContent = 'Scan could not start';
  }
});

// A token image that fails to load is removed, revealing its monogram. Error
// events do not bubble, so this listens in the capture phase.
document.addEventListener(
  'error',
  (event) => {
    const target = event.target;
    if (target instanceof HTMLImageElement && target.classList.contains('avatar__img')) target.remove();
  },
  true,
);

startLive();
startRouter();
