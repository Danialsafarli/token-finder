// @ts-check
/**
 * Live connection state.
 *
 * The old dashboard kept showing the last rows it had fetched when the server
 * died - with a grey dot as the only hint - so a dead backend looked like a
 * quiet market. Here the connection is an explicit state machine, and every
 * view reads it:
 *
 *   connecting   → first contact not yet made
 *   live         → stream open, status current
 *   reconnecting → stream dropped; the browser is retrying
 *   offline      → nothing has answered for OFFLINE_AFTER_MS; data on screen is
 *                  from `lastContactAt` and is labelled as such
 *
 * Scan progress arrives on the stream the moment a scan starts, not on the next
 * poll.
 */

import { api } from './api.js';

const OFFLINE_AFTER_MS = 8_000;
const HEARTBEAT_MS = 15_000;

/**
 * @typedef {'connecting' | 'live' | 'reconnecting' | 'offline'} Connection
 * @typedef {{
 *   serverTime: number, scanning: boolean, lastScanAt: number | null, scanCount: number,
 *   scanIntervalSec: number, window: { liveMinutes: number, freshMinutes: number },
 *   universe: { live: number, stale: number, unevaluated: number, total: number },
 *   counts: Record<string, number>, persistence: { healthy: boolean, kind: string | null },
 *   capabilitiesOff: number, capabilitiesDegraded: number
 * }} Status
 * @typedef {{ connection: Connection, status: Status | null, lastContactAt: number | null }} LiveState
 */

/** @type {LiveState} */
const state = { connection: 'connecting', status: null, lastContactAt: null };

/** @type {Set<(state: LiveState) => void>} */
const stateListeners = new Set();
/** @type {Set<(kind: string, payload: any) => void>} */
const eventListeners = new Set();

/** @type {ReturnType<typeof setTimeout> | null} */
let offlineTimer = null;
let heartbeatFailures = 0;

function publish() {
  for (const listener of stateListeners) listener(state);
}

/** @param {Connection} connection */
function setConnection(connection) {
  if (state.connection === connection) return;
  state.connection = connection;
  publish();
}

function contact() {
  state.lastContactAt = Date.now();
  heartbeatFailures = 0;
  if (offlineTimer) {
    clearTimeout(offlineTimer);
    offlineTimer = null;
  }
}

function armOfflineTimer() {
  if (offlineTimer) return;
  offlineTimer = setTimeout(() => {
    offlineTimer = null;
    setConnection('offline');
  }, OFFLINE_AFTER_MS);
}

/** @param {Status} status */
function applyStatus(status) {
  state.status = status;
  publish();
}

/** @param {string} kind @param {any} payload */
function dispatch(kind, payload) {
  for (const listener of eventListeners) listener(kind, payload);
}

/** @param {(state: LiveState) => void} listener */
export function onLive(listener) {
  stateListeners.add(listener);
  listener(state);
  return () => stateListeners.delete(listener);
}

/**
 * Server events: 'scan-start', 'scan', 'scan-failed', 'decision', 'alert', 'reconnected'.
 * @param {(kind: string, payload: any) => void} listener
 */
export function onServerEvent(listener) {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

export function liveState() {
  return state;
}

async function heartbeat() {
  try {
    applyStatus(await api('/api/status', { timeoutMs: 6_000 }));
    const wasDown = state.connection === 'offline' || state.connection === 'reconnecting';
    contact();
    if (wasDown) {
      setConnection('live');
      dispatch('reconnected', null);
    } else if (state.connection === 'connecting') {
      setConnection('live');
    }
  } catch {
    heartbeatFailures++;
    if (heartbeatFailures >= 2) setConnection('offline');
  }
}

/** @type {EventSource | null} */
let source = null;

function connectStream() {
  const stream = new EventSource('/api/stream');
  source = stream;

  stream.addEventListener('open', () => {
    const wasDown = state.connection === 'offline' || state.connection === 'reconnecting';
    contact();
    setConnection('live');
    if (wasDown) dispatch('reconnected', null);
  });

  stream.addEventListener('error', () => {
    if (state.connection === 'live' || state.connection === 'connecting') setConnection('reconnecting');
    armOfflineTimer();
  });

  stream.addEventListener('hello', (message) => {
    contact();
    applyStatus(JSON.parse(/** @type {MessageEvent} */ (message).data));
  });

  stream.addEventListener('scan-start', (message) => {
    contact();
    if (state.status) state.status = { ...state.status, scanning: true };
    publish();
    dispatch('scan-start', JSON.parse(/** @type {MessageEvent} */ (message).data));
  });

  // 'decision': verdicts re-decided after deep intelligence, between scans.
  for (const kind of ['scan', 'scan-failed', 'decision']) {
    stream.addEventListener(kind, (message) => {
      contact();
      dispatch(kind, JSON.parse(/** @type {MessageEvent} */ (message).data));
      // The stream carries only a summary; the status (counts, last scan time)
      // is refreshed from the source of truth.
      void heartbeat();
    });
  }

  stream.addEventListener('scan-stage', (message) => {
    contact();
    dispatch('scan-stage', JSON.parse(/** @type {MessageEvent} */ (message).data));
  });

  stream.addEventListener('alert', (message) => {
    contact();
    dispatch('alert', JSON.parse(/** @type {MessageEvent} */ (message).data));
  });
}

/**
 * A stream left open by a page being navigated away from - or held in the
 * back/forward cache - keeps its connection. Browsers allow six per host, so a
 * few reloads would leave every later request queued behind dead streams. The
 * stream is closed when the page is hidden and reopened if it is restored.
 */
function closeStream() {
  source?.close();
  source = null;
}

export function startLive() {
  connectStream();
  void heartbeat();
  setInterval(() => void heartbeat(), HEARTBEAT_MS);
  addEventListener('pagehide', closeStream);
  addEventListener('pageshow', (event) => {
    if (event.persisted && !source) {
      connectStream();
      void heartbeat();
    }
  });
}
