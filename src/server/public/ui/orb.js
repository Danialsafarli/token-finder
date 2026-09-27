// @ts-check
/**
 * The Observatory: Token Finder's signature instrument.
 *
 * A slowly turning network sphere stands for the part of Solana Token Finder
 * watches. Around it sit the few live tokens that matter right now, each
 * tethered to the network, each surfaced for a stated reason. The Observatory
 * shows what the engine is doing and nothing else:
 *
 *   idle      the network turns and breathes. Ambient pulses are decoration
 *             and look like it: faint, neutral, never attached to a token.
 *   scanning  only while a real scan runs (the `scan-start` event, or the
 *             status saying so). A sweep crosses the network; there is no
 *             progress bar, because the engine does not report progress.
 *   focus     hovering or keyboard-focusing a token quiets everything else,
 *             lights that token's neighbourhood, and shows its verdict, score,
 *             reason and why it was surfaced. Clicking opens its Dossier.
 *   offline   the server cannot be reached. The network stops turning: an
 *             instrument that is not observing must not look as if it were.
 *
 * Every token, verdict, score, reason and change shown here comes from
 * `/api/orb`, which reads the same live universe as the Board. When a scan
 * completes, tokens that are new to the selection emerge from the network,
 * tokens whose verdict changed pulse once, and tokens the scan re-evaluated
 * glint - each only when the data says so.
 *
 * Rendering: Canvas 2D for the network (a hundred-odd nodes, a few hundred
 * edges, batched into a handful of paths per frame) and real `<a>` elements for
 * the tokens, so they are focusable, readable by screen readers, and hit-tested
 * like any link. No dependency; see docs/adr/0002-intelligence-orb.md.
 *
 * Cost control: one animation loop per mount, running only while the page is
 * visible, the Observatory is on screen, and motion is allowed. Under
 * `prefers-reduced-motion` nothing loops; the scene is drawn once per change.
 */

import { api } from '../lib/api.js';
import { html, render } from '../lib/html.js';
import { ago, count } from '../lib/format.js';
import { liveState, onLive, onServerEvent } from '../lib/live.js';
import { dossierUrl, tokenIcon, verdictChip, toneClass } from './components.js';

/**
 * @typedef {{
 *   mint: string, symbol: string, name: string, icon: string | null,
 *   verdict: string, verdictLabel: string, tone: string, score: number, reason: string,
 *   role: 'changed' | 'top' | 'newest' | 'watch' | 'rejected' | 'subject', why: string, whyAt: number | null,
 *   change: { from: string, to: string, fromLabel: string, toLabel: string, at: number } | null,
 *   lastSeenAt: number, freshness: 'FRESH' | 'AGING'
 * }} OrbToken
 * @typedef {{
 *   generatedAt: number,
 *   universe: { live: number, stale: number, unevaluated: number },
 *   scan: { scanning: boolean, lastScanAt: number | null, count: number,
 *           last: { at: number, durationMs: number, analyzed: number, fresh: number } | null },
 *   tokens: OrbToken[]
 * }} OrbResponse
 * @typedef {{ x: number, y: number, z: number, hub: boolean, inner: boolean, shell: number, freq: number, phase: number, size: number, density: number }} Node
 * @typedef {{ a: number, b: number, w: number, target: number }} Edge
 * @typedef {{ points: { x: number, y: number, z: number }[] }} Route
 * @typedef {{ nodes: Node[], edges: Edge[], adjacency: number[][], near: number[][], routes: Route[] }} Network
 * @typedef {{ nodes: number[], start: number, hop: number, strength: number }} Signal
 * @typedef {{ route: number, start: number, duration: number, reverse: boolean }} Courier
 * @typedef {'sphere' | 'horizon'} Composition
 */

const TAU = Math.PI * 2;
/** Refetch even without a scan: tokens age out of the live window on their own. */
const REFRESH_MS = 120_000;
/** Scene time used for the still frame under reduced motion: a balanced angle. */
const STILL_T = 23;
/** Camera distance in sphere radii: enough perspective for depth, not enough to distort. */
const PERSPECTIVE = 3.6;

let instances = 0;
const publishInstances = () => {
  document.documentElement.dataset.orbInstances = String(instances);
};

// --- small maths -------------------------------------------------------------

/** Deterministic PRNG, so the network looks the same on every visit. @param {number} seed */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (/** @type {number} */ v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
const easeOutCubic = (/** @type {number} */ k) => 1 - (1 - k) ** 3;
const easeInOutSine = (/** @type {number} */ k) => -(Math.cos(Math.PI * k) - 1) / 2;
/** Frame-rate independent approach of `value` to `target`. @param {number} value @param {number} target @param {number} rate per second @param {number} dt seconds */
const approach = (value, target, rate, dt) => value + (target - value) * (1 - Math.exp(-rate * dt));

/** @param {() => number} rand */
function randomUnit(rand) {
  const z = rand() * 2 - 1;
  const a = rand() * TAU;
  const r = Math.sqrt(1 - z * z);
  return { x: r * Math.cos(a), y: z, z: r * Math.sin(a) };
}

/**
 * The network, built once per composition and size, never per frame.
 *
 * - A Fibonacci surface pulled toward a few hubs, so it has dense, bright
 *   regions and quiet ones. Dense regions are richly linked, quiet ones
 *   sparsely: topology, not mesh.
 * - Two inner shells - a middle shell and a small core - so the sphere has a
 *   front, a middle and a back rather than being a hollow wireframe.
 * - Backbone arcs between hubs, lifted off the surface by varying heights:
 *   the long-range paths a network has and a globe does not.
 *
 * `cap` builds only the northern cap, densely: the horizon composition looks
 * at the pole, so the cap turns in place and never leaves the view.
 * @param {number} count surface nodes @param {number} seed @param {boolean} cap @returns {Network}
 */
function buildNetwork(count, seed, cap) {
  const rand = prng(seed);
  /** @type {Node[]} */
  const nodes = [];
  const minY = cap ? 0.12 : -1;
  const hubCount = cap ? 6 : Math.round(clamp(count / 24, 7, 11));
  const hubs = Array.from({ length: hubCount }, () => {
    const u = randomUnit(rand);
    return cap ? { x: u.x, y: minY + (1 - minY) * (0.35 + 0.6 * Math.abs(u.y)), z: u.z } : u;
  }).map((h) => {
    const n = Math.hypot(h.x, h.y, h.z);
    return { x: h.x / n, y: h.y / n, z: h.z / n };
  });
  const golden = Math.PI * (3 - Math.sqrt(5));
  /** @param {{x:number,y:number,z:number}} p @param {boolean} hub @param {number} shell 0 surface, 1 middle, 2 core @param {number} density */
  const node = (p, hub, shell, density) => ({
    ...p,
    hub,
    inner: shell > 0,
    shell,
    density,
    freq: 0.3 + rand() * 0.55,
    phase: rand() * TAU,
    size: hub ? 2.1 : shell === 2 ? 0.8 : shell === 1 ? 0.85 : 0.62 + density * 0.7 + rand() * 0.32,
  });

  for (let i = 0; i < count; i++) {
    const y = 1 - ((i + 0.5) / count) * (1 - minY);
    const r = Math.sqrt(1 - y * y);
    const theta = golden * i + (rand() - 0.5) * 0.55;
    let p = { x: Math.cos(theta) * r, y, z: Math.sin(theta) * r };
    let best = hubs[0];
    let bestDot = -2;
    for (const h of hubs) {
      const d = p.x * h.x + p.y * h.y + p.z * h.z;
      if (d > bestDot) (bestDot = d), (best = h);
    }
    if (bestDot > 0.78) {
      const k = 0.4 * ((bestDot - 0.78) / 0.22);
      const q = { x: p.x + (best.x - p.x) * k, y: p.y + (best.y - p.y) * k, z: p.z + (best.z - p.z) * k };
      const n = Math.hypot(q.x, q.y, q.z);
      p = { x: q.x / n, y: q.y / n, z: q.z / n };
    }
    nodes.push(node(p, false, 0, clamp((bestDot - 0.55) / 0.45)));
  }
  for (const h of hubs) nodes.push(node(h, true, 0, 1));
  if (!cap) {
    const shells = [
      { shell: 1, share: 0.14, from: 0.72, to: 0.84 },
      { shell: 2, share: 0.07, from: 0.34, to: 0.5 },
    ];
    for (const { shell, share, from, to } of shells) {
      for (let i = 0; i < Math.round(count * share); i++) {
        const u = randomUnit(rand);
        const r = from + rand() * (to - from);
        nodes.push(node({ x: u.x * r, y: u.y * r, z: u.z * r }, false, shell, 0));
      }
    }
  }

  // Nearest neighbours by distance.
  const near = nodes.map((a, i) =>
    nodes
      .map((b, j) => ({ j, d: i === j ? Infinity : (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2 }))
      .sort((p, q) => p.d - q.d)
      .slice(0, 10)
      .map((entry) => entry.j),
  );

  /** @type {Edge[]} */
  const edges = [];
  const keys = new Set();
  const link = (/** @type {number} */ a, /** @type {number} */ b) => {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (a === b || keys.has(key)) return;
    keys.add(key);
    edges.push({ a, b, w: 1, target: 1 });
  };
  nodes.forEach((n, i) => {
    const k = n.hub ? 6 : n.inner ? 2 : n.density > 0.45 ? 4 : 3;
    for (const j of near[i].slice(0, k)) link(i, j);
  });

  // Backbones: arcs between hub pairs at varied heights above the surface.
  /** @type {Route[]} */
  const routes = [];
  const hubIndex = nodes.map((n, i) => (n.hub ? i : -1)).filter((i) => i >= 0);
  const pairs = [];
  for (let a = 0; a < hubIndex.length; a++) {
    for (let b = a + 1; b < hubIndex.length; b++) {
      const from = nodes[hubIndex[a]];
      const to = nodes[hubIndex[b]];
      const omega = Math.acos(clamp(from.x * to.x + from.y * to.y + from.z * to.z, -1, 1));
      if (omega > 0.5 && omega < 2.2) pairs.push({ from, to, omega, order: rand() });
    }
  }
  pairs.sort((p, q) => p.order - q.order);
  for (const { from, to, omega } of pairs.slice(0, cap ? 7 : 16)) {
    const height = 0.04 + rand() * 0.1;
    const points = [];
    for (let k = 0; k <= 28; k++) {
      const f = k / 28;
      const s1 = Math.sin((1 - f) * omega) / Math.sin(omega);
      const s2 = Math.sin(f * omega) / Math.sin(omega);
      const lift = 1 + height * Math.sin(Math.PI * f);
      points.push({ x: (from.x * s1 + to.x * s2) * lift, y: (from.y * s1 + to.y * s2) * lift, z: (from.z * s1 + to.z * s2) * lift });
    }
    routes.push({ points });
  }

  return { nodes, edges, adjacency: adjacencyOf(nodes.length, edges), near, routes };
}

/** @param {number} count @param {Edge[]} edges */
function adjacencyOf(count, edges) {
  /** @type {number[][]} */
  const adjacency = Array.from({ length: count }, () => []);
  edges.forEach((edge) => {
    adjacency[edge.a].push(edge.b);
    adjacency[edge.b].push(edge.a);
  });
  return adjacency;
}

/** Breadth-first distances from `start`, up to `depth` hops. @param {number[][]} adjacency @param {number} start @param {number} depth */
function neighbourhood(adjacency, start, depth) {
  /** @type {Map<number, number>} */
  const distance = new Map([[start, 0]]);
  let frontier = [start];
  for (let d = 1; d <= depth; d++) {
    /** @type {number[]} */
    const next = [];
    for (const n of frontier) {
      for (const m of adjacency[n]) {
        if (!distance.has(m)) {
          distance.set(m, d);
          next.push(m);
        }
      }
    }
    frontier = next;
  }
  return distance;
}

/**
 * Shortest route from `start` to the nearest hub, by breadth-first search.
 * @param {Network} network @param {number} start @returns {number[] | null}
 */
function pathToHub(network, start) {
  /** @type {Map<number, number>} */
  const parent = new Map([[start, -1]]);
  const queue = [start];
  while (queue.length > 0) {
    const n = /** @type {number} */ (queue.shift());
    if (network.nodes[n].hub && n !== start) {
      const path = [n];
      let p = /** @type {number} */ (parent.get(n));
      while (p !== -1) {
        path.unshift(p);
        p = /** @type {number} */ (parent.get(p));
      }
      return path;
    }
    for (const m of network.adjacency[n]) {
      if (!parent.has(m)) {
        parent.set(m, n);
        queue.push(m);
      }
    }
  }
  return null;
}

/**
 * Shortest route between two nodes, by breadth-first search, no longer than
 * `limit` hops.
 * @param {Network} network @param {number} from @param {number} to @param {number} limit @returns {number[] | null}
 */
function pathBetween(network, from, to, limit) {
  /** @type {Map<number, number>} */
  const parent = new Map([[from, -1]]);
  let frontier = [from];
  for (let depth = 0; depth < limit && frontier.length > 0; depth++) {
    /** @type {number[]} */
    const next = [];
    for (const n of frontier) {
      for (const m of network.adjacency[n]) {
        if (parent.has(m)) continue;
        parent.set(m, n);
        if (m === to) {
          const path = [m];
          let p = n;
          while (p !== -1) {
            path.unshift(p);
            p = /** @type {number} */ (parent.get(p));
          }
          return path;
        }
        next.push(m);
      }
    }
    frontier = next;
  }
  return null;
}

// --- templates ---------------------------------------------------------------

const shell = () => html`
  <section class="orb" aria-labelledby="orb-title" data-state="idle">
    <header class="orb__head">
      <div class="orb__title">
        <p class="orb__eyebrow">Live token intelligence · Solana</p>
        <h2 class="orb__name" id="orb-title">Observatory</h2>
        <p class="orb__sub">The live tokens that matter right now, each surfaced for a stated reason.</p>
      </div>
      <p class="orb__status" role="status"><span class="orb__beacon" aria-hidden="true"></span><span class="orb__status-text">Connecting</span></p>
    </header>
    <div class="orb__stage">
      <canvas class="orb__canvas" aria-hidden="true"></canvas>
      <ol class="orb__markers" aria-label="Tokens the Observatory is surfacing"></ol>
    </div>
    <div class="orb__footer">
      <div class="orb__readout"></div>
      <div class="orb__aside"></div>
    </div>
  </section>`;

/** @param {OrbToken} token */
const markerLabel = (token) =>
  `${token.symbol} — ${token.verdictLabel}, score ${token.score}. ${token.why}${token.whyAt ? `, ${ago(token.whyAt)}` : ''}. ${token.reason}. Opens the token's dossier.`;

/** The role in two words, for the primary tokens' caption. */
const ROLE_SHORT = /** @type {Record<OrbToken['role'], string>} */ ({
  changed: 'Verdict changed',
  top: 'Top score',
  newest: 'Newest',
  watch: 'On watch',
  rejected: 'Rejected',
  subject: 'Analyzed',
});

/**
 * The first two tokens in priority order are primary: larger, captioned, and
 * more strongly tethered. The rest stay quiet. A disciplined hierarchy rather
 * than seven equal stickers.
 * @param {OrbToken} token @param {boolean} primary
 */
const markerInner = (token, primary) =>
  html`${tokenIcon(token, primary ? 40 : 28)}<span class="orb-marker__symbol">${token.symbol}</span>${primary
    ? html`<span class="orb-marker__caption">${token.score} · ${ROLE_SHORT[token.role]}</span>`
    : ''}`;

/** @param {OrbToken} token @param {boolean} primary */
const markerClass = (token, primary) => `orb-marker orb-marker--${token.tone}${primary ? ' orb-marker--primary' : ''}`;

/** @param {OrbToken} token @param {boolean} primary */
const markerTemplate = (token, primary) => html`<li class="orb__item">
  <a class="${markerClass(token, primary)}" href="${dossierUrl(token.mint)}" data-link data-mint="${token.mint}" aria-label="${markerLabel(token)}">${markerInner(token, primary)}</a>
</li>`;

/** @param {OrbToken} token */
const previewTemplate = (token) => html`<div class="orb-preview">
  <div class="orb-preview__head">
    ${tokenIcon(token, 28)}
    <p class="orb-preview__id"><strong>${token.symbol}</strong><span>${token.name}</span></p>
    <p class="orb-preview__score"><span class="sr-only">Score </span>${token.score}</p>
  </div>
  <p class="orb-preview__verdict">${verdictChip(token.verdict)}<span class="${toneClass(token.tone)}">${token.reason}</span></p>
  <p class="orb-preview__why">${token.why}${token.whyAt ? html` · <time datetime="${new Date(token.whyAt).toISOString()}">${ago(token.whyAt)}</time>` : ''}</p>
</div>`;

// --- the instrument ----------------------------------------------------------

/**
 * Where the sphere sits in its stage, as fractions of the stage, and how large
 * it is relative to the stage's natural size.
 * @typedef {{ fx: number, fy: number, size: number }} Placement
 * @typedef {{
 *   bare?: boolean,
 *   follow?: boolean,
 *   reveal?: boolean,
 *   placement?: Placement,
 *   composition?: 'auto' | 'sphere',
 *   ring?: 'orbit' | 'sides'
 * }} OrbOptions
 */

/**
 * Mounts the Observatory into `host`. Returns a handle whose `dispose()` stops
 * every loop, observer, listener and timer it started.
 *
 * The same instrument serves every surface. Options:
 * - `bare`: the stage only, without the Observatory's own heading and footer;
 * - `follow` (default true): reflect the monitor's scans;
 * - `reveal` (default true): show the live tokens around the sphere;
 * - `placement`: where the sphere sits in its stage;
 * - `composition`: 'auto' (a short stage gets the horizon) or always 'sphere';
 * - `ring`: 'orbit' (tokens all round, slowly drifting) or 'sides' (only on
 *   the sphere's flanks, clear of content above and below it).
 *
 * The handle also steers it: `setIntent` (a person leaning toward analysing
 * one token or discovering many), `beginAnalysis`/`stage`/`endAnalysis` (a
 * requested analysis, driven by the real pipeline's stages), and
 * `setPlacement` (moving the sphere within its stage, animated).
 * @param {HTMLElement} host
 * @param {OrbOptions} [options]
 */
export function mountOrb(host, options = {}) {
  render(host, shell());
  const root = /** @type {HTMLElement} */ (host.querySelector('.orb'));
  if (options.bare) root.classList.add('orb--bare');
  /** Whether the monitor's scans drive this Observatory's scanning state. */
  const follow = options.follow !== false;
  const revealByDefault = options.reveal !== false;
  let reveal = revealByDefault;
  /** A requested analysis is running. Its stages are real; there is no progress figure. */
  let activity = false;
  /** Attention rests on one node: while a person leans toward analysing, and on the analysed token. */
  let attentionGoal = false;
  let attentionNode = -1;
  /** @type {Map<number, number> | null} */
  let attentionNeighbourhood = null;
  /** The token a requested analysis produced, shown alone. @type {OrbToken | null} */
  let subject = null;
  const stage = /** @type {HTMLElement} */ (root.querySelector('.orb__stage'));
  const canvas = /** @type {HTMLCanvasElement} */ (root.querySelector('.orb__canvas'));
  const list = /** @type {HTMLOListElement} */ (root.querySelector('.orb__markers'));
  const readout = /** @type {HTMLElement} */ (root.querySelector('.orb__readout'));
  const statusText = /** @type {HTMLElement} */ (root.querySelector('.orb__status-text'));
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));

  instances += 1;
  publishInstances();

  const css = getComputedStyle(root);
  const rgb = (/** @type {string} */ name, /** @type {string} */ fallback) => hexToRgb(css.getPropertyValue(name).trim() || fallback);
  const colors = {
    accent: rgb('--accent', '#8ab4ff'),
    node: rgb('--orb-node', '#c9d4ea'),
    good: rgb('--good', '#4cc98f'),
    warn: rgb('--warn', '#e2b04e'),
    bad: rgb('--bad', '#f0706f'),
    neutral: rgb('--neutral', '#97a0b2'),
  };

  const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');

  /** Everything the frame reads. */
  const scene = {
    /** @type {Composition} */ composition: 'sphere',
    width: 0,
    height: 0,
    dpr: 1,
    cx: 0,
    cy: 0,
    radius: 0,
    ringRadius: 0,
    /** The sphere's token ring is an ellipse: it uses the hero's width. */
    ringX: 0,
    ringY: 0,
    /** A real scan just completed: an analysis wave crosses the network (wall-clock ms). */
    waveStart: -1,
    maxMarkers: 7,
    /** @type {Network | null} */ network: null,
    networkKey: '',
    /** Scene time: advances with the (eased) speed, so motion slows rather than stops. */
    t: STILL_T,
    speed: 1,
    scanAmount: 0,
    focusAmount: 0,
    offlineAmount: 0,
    tiltX: 0,
    tiltY: 0,
    pointerX: 0,
    pointerY: 0,
    /** @type {Signal[]} */ signals: [],
    /** @type {Courier[]} */ couriers: [],
    nextCourierAt: 6,
    nextSignalAt: 3,
    /** Real seconds since the previous frame, for eased marker motion. */
    frameDt: 0.016,
    nextRewireAt: 18,
    focusWaveAt: 0,
    /** Scan-completion ripples waiting to be released. @type {number[]} */ pendingRipples: [],
    /** @type {Placement} */ place: { fx: 0.5, fy: 0.5, size: 1, ...options.placement },
    /** @type {Placement} */ placeGoal: { fx: 0.5, fy: 0.5, size: 1, ...options.placement },
    attention: 0,
    nextConvergeAt: 0,
  };

  const status = {
    connection: liveState().connection,
    scanning: follow && liveState().status?.scanning === true,
    /** @type {number | null} */ scanStartedAt: null,
    /** @type {'ok' | 'failed' | 'complete'} */ lastOutcome: 'ok',
    /** @type {{ at: number, analyzed: number, fresh: number } | null} */ lastResult: null,
    completeUntil: 0,
  };

  /** @type {OrbResponse | null} */
  let data = null;
  /**
   * Marker state by mint.
   * @type {Map<string, { token: OrbToken, primary: boolean, el: HTMLAnchorElement, item: HTMLLIElement, slot: number, fraction: number,
   *   enter: number, appear: number, exit: number, anchor: number, anchorFrom: number, anchorBlend: number, anchorCheckAt: number,
   *   bob: number, glintAt: number, pulseAt: number, last: string, lastOpacity: string }>}
   */
  const markers = new Map();
  /** @type {string | null} */
  let hovered = null;
  /** @type {string | null} */
  let keyboardFocused = null;
  /** @type {string | null} */
  let focused = null;
  /** @type {Map<number, number> | null} */
  let focusNeighbourhood = null;
  /** The focused token's shortest route to a hub, as node indices. @type {number[] | null} */
  let focusPath = null;

  let frame = 0;
  let frames = 0;
  let lastTime = 0;
  let onScreen = true;
  let disposed = false;
  let reduced = reducedQuery.matches;

  // Test and diagnostics hook: a plain property, not a DOM attribute, so it
  // costs nothing per frame.
  Object.defineProperty(root, '__orb', {
    value: {
      get frames() {
        return frames;
      },
      get running() {
        return frame !== 0 || timer !== 0;
      },
      get state() {
        return root.dataset.state;
      },
      get composition() {
        return scene.composition;
      },
      get attention() {
        return attentionGoal;
      },
      get subject() {
        return subject?.mint ?? null;
      },
      get placement() {
        return { ...scene.place };
      },
    },
  });

  /** @type {HTMLCanvasElement | null} */
  let body = null;
  const bodyGeo = { cx: 0, cy: 0, r: 1 };

  /** Renders the static body once per layout: gradients are the costliest thing to fill. */
  const renderBody = () => {
    const { width, height, dpr, cx, cy, radius } = scene;
    Object.assign(bodyGeo, { cx, cy, r: radius });
    body = document.createElement('canvas');
    body.width = Math.round(width * dpr);
    body.height = Math.round(height * dpr);
    const g = /** @type {CanvasRenderingContext2D} */ (body.getContext('2d'));
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const A = colors.accent;
    const disc = g.createRadialGradient(cx - radius * 0.35, cy - radius * 0.4, radius * 0.1, cx, cy, radius * 1.08);
    disc.addColorStop(0, `rgba(${A},0.075)`);
    disc.addColorStop(0.7, `rgba(${A},0.025)`);
    disc.addColorStop(1, `rgba(${A},0)`);
    g.fillStyle = disc;
    g.beginPath();
    g.arc(cx, cy, radius * 1.08, 0, TAU);
    g.fill();
    // Atmosphere: the faintest halo beyond the limb, for depth, not glow.
    const air = g.createRadialGradient(cx, cy, radius * 0.98, cx, cy, radius * 1.32);
    air.addColorStop(0, `rgba(${A},0.05)`);
    air.addColorStop(1, `rgba(${A},0)`);
    g.fillStyle = air;
    g.beginPath();
    g.arc(cx, cy, radius * 1.32, 0, TAU);
    g.fill();
    g.lineWidth = 1;
    g.strokeStyle = `rgba(${A},0.09)`;
    g.beginPath();
    g.arc(cx, cy, radius * 1.004, 0, TAU);
    g.stroke();
    // A rim light on the upper left: the only "lighting" in the scene.
    const rim = g.createLinearGradient(cx - radius, cy - radius, cx + radius * 0.2, cy);
    rim.addColorStop(0, `rgba(${A},0.34)`);
    rim.addColorStop(1, `rgba(${A},0)`);
    g.strokeStyle = rim;
    g.lineWidth = 1.25;
    g.beginPath();
    g.arc(cx, cy, radius * 1.004, Math.PI * 0.95, Math.PI * 1.62);
    g.stroke();
  };

  /** The sphere's centre, radius and token ring for a placement. @param {Placement} place */
  const sphereGeometry = (place) => {
    const { width, height } = scene;
    scene.radius = Math.min(height * 0.345, width * 0.27) * place.size;
    scene.cx = width * place.fx;
    scene.cy = height * place.fy;
    scene.ringRadius = scene.radius * 1.4;
    scene.ringY = Math.max(40, Math.min(scene.radius * 1.36, Math.min(scene.cy, height - scene.cy) - 34));
    scene.ringX = Math.max(scene.ringY, Math.min(scene.radius * 1.7, Math.min(scene.cx, width - scene.cx) - 64));
  };

  const placementMoving = () =>
    Math.abs(scene.place.fx - scene.placeGoal.fx) + Math.abs(scene.place.fy - scene.placeGoal.fy) + Math.abs(scene.place.size - scene.placeGoal.size) > 0.002;

  // --- layout ----------------------------------------------------------------

  const layout = () => {
    const rect = stage.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (width === 0 || height === 0) return;
    scene.width = width;
    scene.height = height;
    scene.dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * scene.dpr);
    canvas.height = Math.round(height * scene.dpr);

    // A short band gets the horizon; anything with room for a sphere gets one.
    const horizon = options.composition !== 'sphere' && height < 260;
    scene.composition = horizon ? 'horizon' : 'sphere';
    if (horizon) {
      // A planet rising from the bottom of the band, seen from above its pole:
      // the cap turns in place, and the tokens sit in the sky over its limb.
      scene.radius = clamp(width * 0.62, 240, 720);
      scene.cx = width * 0.5;
      scene.cy = scene.radius + height * 0.5;
      scene.ringRadius = scene.radius + height * 0.28;
      scene.maxMarkers = width < 560 ? 3 : width < 820 ? 4 : 5;
    } else {
      sphereGeometry(scene.place);
      scene.maxMarkers = options.ring === 'sides' ? 6 : 7;
    }
    // Density follows size: a large sphere gets a richer network, in steps so a
    // resize does not rebuild it on every pixel. Sized from where the sphere is
    // going, so a placement animation never rebuilds it mid-flight.
    const goalRadius = Math.min(height * 0.345, width * 0.27) * scene.placeGoal.size;
    const surface = horizon ? (width < 560 ? 104 : 150) : Math.round(clamp(goalRadius * 1.55, 110, 300) / 20) * 20;
    const key = `${scene.composition}-${surface}`;
    if (key !== scene.networkKey) {
      scene.network = buildNetwork(surface, 1905, horizon);
      scene.couriers = [];
      scene.networkKey = key;
      scene.signals = [];
      for (const marker of markers.values()) {
        marker.anchor = marker.anchorFrom = -1;
        marker.fraction = -1;
      }
    }
    renderBody();
    syncMarkers();
    requestDraw();
  };

  // --- projection --------------------------------------------------------------

  const proj = { x: new Float32Array(0), y: new Float32Array(0), z: new Float32Array(0), s: new Float32Array(0) };

  /**
   * The camera at the current scene time. Incommensurate periods, so the
   * motion never visibly repeats; the pointer adds a little parallax.
   */
  const camera = () => {
    const t = scene.t;
    const yaw = t * (TAU / 130) + 0.28 * Math.sin(t / 41) + scene.tiltX * 0.14;
    const horizon = scene.composition === 'horizon';
    const pitch = (horizon ? 0.5 : 0.34) + (horizon ? 0.03 : 0.07) * Math.sin(t / 29 + 1) + 0.03 * Math.sin(t / 17) + scene.tiltY * 0.09;
    const roll = 0.05 * Math.sin(t / 53);
    return {
      yaw,
      cy: Math.cos(yaw), sy: Math.sin(yaw),
      cp: Math.cos(pitch), sp: Math.sin(pitch),
      cr: Math.cos(roll), sr: Math.sin(roll),
    };
  };

  /** Rotates, then projects with a gentle perspective. @param {ReturnType<typeof camera>} c @param {number} x @param {number} y @param {number} z @param {number} R */
  const toScreen = (c, x, y, z, R) => {
    const x1 = x * c.cy + z * c.sy;
    const z1 = -x * c.sy + z * c.cy;
    const y2 = y * c.cp - z1 * c.sp;
    const z2 = y * c.sp + z1 * c.cp;
    const x3 = x1 * c.cr - y2 * c.sr;
    const y3 = x1 * c.sr + y2 * c.cr;
    const s = PERSPECTIVE / (PERSPECTIVE - z2);
    return { x: scene.cx + x3 * R * s, y: scene.cy - y3 * R * s, z: z2, s };
  };

  const project = () => {
    const network = /** @type {Network} */ (scene.network);
    const n = network.nodes.length;
    if (proj.x.length !== n) {
      proj.x = new Float32Array(n);
      proj.y = new Float32Array(n);
      proj.z = new Float32Array(n);
      proj.s = new Float32Array(n);
    }
    const c = camera();
    for (let i = 0; i < n; i++) {
      const p = network.nodes[i];
      const q = toScreen(c, p.x, p.y, p.z, scene.radius);
      proj.x[i] = q.x;
      proj.y[i] = q.y;
      proj.z[i] = q.z;
      proj.s[i] = q.s;
    }
    return c;
  };

  /** How visible a point at depth z is: back of the sphere fades, not vanishes. @param {number} z */
  const depthAlpha = (z) => {
    const k = clamp((z + 1) / 2);
    return 0.07 + 0.93 * k ** 2.4;
  };

  // --- signals ---------------------------------------------------------------

  /** A short walk across the network from `from`. @param {number} from @param {number} hops @param {number} strength */
  const walk = (from, hops, strength) => {
    const network = /** @type {Network} */ (scene.network);
    const path = [from];
    const seen = new Set(path);
    for (let h = 0; h < hops; h++) {
      const options = network.adjacency[path[path.length - 1]].filter((m) => !seen.has(m));
      if (options.length === 0) break;
      const next = options[Math.floor(Math.random() * options.length)];
      path.push(next);
      seen.add(next);
    }
    if (path.length > 1) scene.signals.push({ nodes: path, start: scene.t, hop: 0.55, strength });
  };

  const frontNode = () => {
    const network = /** @type {Network} */ (scene.network);
    for (let tries = 0; tries < 12; tries++) {
      const i = Math.floor(Math.random() * network.nodes.length);
      if (proj.z[i] > 0.25 && !network.nodes[i].inner && inView(i)) return i;
    }
    return -1;
  };

  /** @param {number} i */
  const inView = (i) => proj.x[i] > -8 && proj.x[i] < scene.width + 8 && proj.y[i] > -8 && proj.y[i] < scene.height + 8;

  /** Chooses, or keeps, the node attention rests on. */
  const keepAttention = () => {
    const network = scene.network;
    if (!network || proj.z.length !== network.nodes.length) return;
    const ok = attentionNode >= 0 && proj.z[attentionNode] > 0.3 && inView(attentionNode);
    if (ok) return;
    // Near where attention was, or just right of centre and slightly high.
    const target =
      attentionNode >= 0
        ? { x: proj.x[attentionNode], y: proj.y[attentionNode] }
        : { x: scene.cx + scene.radius * 0.18, y: scene.cy - scene.radius * 0.12 };
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < network.nodes.length; i++) {
      if (network.nodes[i].inner || proj.z[i] < 0.5 || !inView(i)) continue;
      const d = (proj.x[i] - target.x) ** 2 + (proj.y[i] - target.y) ** 2;
      if (d < bestD) (bestD = d), (best = i);
    }
    if (best >= 0 && best !== attentionNode) {
      attentionNode = best;
      attentionNeighbourhood = neighbourhood(network.adjacency, best, 2);
    }
  };

  /** Signals that travel from elsewhere on the network to the attended node. @param {number} count */
  const converge = (count) => {
    const network = scene.network;
    if (!network || attentionNode < 0) return;
    for (let c = 0; c < count; c++) {
      const from = frontNode();
      if (from < 0 || from === attentionNode) continue;
      const path = pathBetween(network, from, attentionNode, 7);
      if (path && path.length > 1) scene.signals.push({ nodes: path, start: scene.t, hop: 0.32, strength: 0.95 });
    }
  };

  /** Occasionally retire one link and grow another nearby: the topology is never static. */
  const rewire = () => {
    const network = /** @type {Network} */ (scene.network);
    const candidates = network.edges.filter((e) => e.target === 1 && e.w === 1 && !network.nodes[e.a].hub && !network.nodes[e.b].hub);
    if (candidates.length === 0) return;
    const edge = candidates[Math.floor(Math.random() * candidates.length)];
    if (network.adjacency[edge.a].length < 3) return;
    edge.target = 0;
    const linked = new Set(network.adjacency[edge.a]);
    const fresh = network.near[edge.a].find((j) => j !== edge.b && !linked.has(j) && !network.nodes[j].inner);
    if (fresh !== undefined) network.edges.push({ a: edge.a, b: fresh, w: 0, target: 1 });
    network.adjacency = adjacencyOf(network.nodes.length, network.edges);
  };

  // --- the frame -----------------------------------------------------------------

  /**
   * Whether anything is changing fast enough to need every frame: a focus
   * easing in or out, a token entering, leaving or appearing.
   */
  const transitioning = () => {
    if (Math.abs(scene.focusAmount - (focused ? 1 : 0)) > 0.01) return true;
    if (placementMoving() || Math.abs(scene.attention - (attentionGoal ? 1 : 0)) > 0.01) return true;
    for (const marker of markers.values()) {
      if (marker.enter < 1 || marker.exit > 0 || marker.appear < 1 || marker.pulseAt > 0 || marker.glintAt > 0) return true;
    }
    return focused !== null;
  };

  /**
   * The one animation loop, paced to what is on screen.
   *
   * At rest the fastest thing moves ~5 px a second, which reads identically at
   * 24-30 fps. The next frame is then requested through a timer rather than
   * straight away: a pending requestAnimationFrame makes the browser produce a
   * main-thread frame on every vsync even if the callback does nothing, which
   * alone cost ~8% of the main thread. A transition (focus, a token entering or
   * leaving) asks for every frame.
   * @param {number} now
   */
  const tick = (now) => {
    frame = 0;
    if (disposed) return;
    const dt = lastTime === 0 ? 0.016 : Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;
    step(dt);
    draw();
    advanceMarkers(dt);
    frames += 1;
    schedule();
  };

  let timer = 0;
  const schedule = () => {
    if (!shouldRun()) return;
    if (transitioning()) frame = requestAnimationFrame(tick);
    else
      timer = window.setTimeout(() => {
        timer = 0;
        if (shouldRun()) frame = requestAnimationFrame(tick);
        // ~24-30 fps at rest, depending on the platform's timer resolution.
        // Measured with GPU compositing: 12-16% of the main thread, against
        // ~20% at a strict 30 fps and 27-36% at 60.
      }, 26);
  };

  /** Advances every eased quantity and the scene clock. @param {number} dt */
  const step = (dt) => {
    const scanning = (follow && status.scanning && status.connection === 'live') || activity;
    const offline = status.connection === 'offline' || status.connection === 'reconnecting';
    scene.scanAmount = approach(scene.scanAmount, scanning ? 1 : 0, scanning ? 1.6 : 0.9, dt);
    scene.focusAmount = approach(scene.focusAmount, focused ? 1 : 0, 7, dt);
    scene.offlineAmount = approach(scene.offlineAmount, offline ? 1 : 0, 1.4, dt);
    scene.attention = approach(scene.attention, attentionGoal ? 1 : 0, 3.5, dt);
    if (placementMoving()) {
      // Ease toward the new placement; exponential approach reads as ease-out.
      const k = 1 - Math.exp(-2.6 * dt);
      scene.place.fx += (scene.placeGoal.fx - scene.place.fx) * k;
      scene.place.fy += (scene.placeGoal.fy - scene.place.fy) * k;
      scene.place.size += (scene.placeGoal.size - scene.place.size) * k;
      if (!placementMoving()) {
        scene.place = { ...scene.placeGoal };
        if (scene.composition === 'sphere') sphereGeometry(scene.place);
        renderBody();
      } else if (scene.composition === 'sphere') sphereGeometry(scene.place);
    }
    const targetSpeed = offline ? 0 : focused ? 0.28 : activity ? 0.45 : attentionGoal ? 0.35 : scanning ? 1.35 : 1;
    scene.speed = approach(scene.speed, targetSpeed, 1.1, dt);
    scene.tiltX = approach(scene.tiltX, scene.pointerX, 2.2, dt);
    scene.tiltY = approach(scene.tiltY, scene.pointerY, 2.2, dt);
    scene.t += dt * scene.speed;
    scene.frameDt = dt;

    const network = scene.network;
    if (!network) return;
    let removed = false;
    for (const edge of network.edges) {
      if (edge.w !== edge.target) {
        edge.w = clamp(edge.w + (edge.target > edge.w ? dt : -dt) / 3.2);
        if (edge.target === 0 && edge.w === 0) removed = true;
      }
    }
    if (removed) {
      network.edges = network.edges.filter((e) => e.target === 1 || e.w > 0);
      network.adjacency = adjacencyOf(network.nodes.length, network.edges);
    }
    if (offline) return;

    if (scene.t >= scene.nextRewireAt) {
      rewire();
      scene.nextRewireAt = scene.t + 14 + Math.random() * 22;
    }
    if (scene.t >= scene.nextSignalAt) {
      const from = frontNode();
      if (from >= 0) walk(from, 3 + Math.floor(Math.random() * 3), scanning ? 0.9 : 0.45);
      scene.nextSignalAt = scene.t + (scanning ? 0.45 + Math.random() * 0.8 : 2.4 + Math.random() * 4.6);
    }
    if (scene.t >= scene.nextCourierAt && network.routes.length > 0) {
      scene.couriers.push({
        route: Math.floor(Math.random() * network.routes.length),
        start: scene.t,
        duration: 3.4 + Math.random() * 1.6,
        reverse: Math.random() < 0.5,
      });
      scene.nextCourierAt = scene.t + (scanning ? 1.6 : 7 + Math.random() * 7);
    }
    scene.couriers = scene.couriers.filter((c) => scene.t - c.start < c.duration);
    if (scene.pendingRipples.length > 0 && Math.random() < dt * 6) {
      const anchor = /** @type {number} */ (scene.pendingRipples.shift());
      if (anchor >= 0) walk(anchor, 4, 0.95);
    }
    // Attention stays on a node that faces us; if the sphere turns it away,
    // it passes to the nearest node that does.
    if (attentionGoal) keepAttention();
    // A requested analysis: signals converge on the attended node.
    if (activity && attentionNode >= 0 && scene.t >= scene.nextConvergeAt) {
      converge(1);
      scene.nextConvergeAt = scene.t + 0.35 + Math.random() * 0.4;
    }
    // While a token is focused, its neighbourhood carries a slow pulse outward.
    if (focused && scene.t >= scene.focusWaveAt) {
      const anchor = markers.get(focused)?.anchor ?? -1;
      if (anchor >= 0) walk(anchor, 3, 0.8);
      scene.focusWaveAt = scene.t + 1.1;
    }
    scene.signals = scene.signals.filter((s) => scene.t - s.start < s.hop * (s.nodes.length - 1) + 0.8);
  };

  const draw = () => {
    const network = scene.network;
    if (!network || scene.width === 0) return;
    const { dpr, width, height } = scene;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const cam = project();
    const yaw = cam.yaw;
    const horizon = scene.composition === 'horizon';
    const t = scene.t;
    const dim = 1 - 0.62 * Math.max(scene.focusAmount, scene.attention * 0.8);
    const life = 1 - 0.55 * scene.offlineAmount;
    const A = colors.accent;
    const N = colors.node;

    // The body - lit disc, rim, rim light - is static: one blit per frame.
    if (body) {
      ctx.globalAlpha = life;
      if (bodyGeo.cx === scene.cx && bodyGeo.cy === scene.cy && bodyGeo.r === scene.radius) {
        ctx.drawImage(body, 0, 0, width, height);
      } else {
        // Mid-placement: the cached body, moved and scaled to where the sphere is.
        const k = scene.radius / bodyGeo.r;
        ctx.save();
        ctx.translate(scene.cx, scene.cy);
        ctx.scale(k, k);
        ctx.translate(-bodyGeo.cx, -bodyGeo.cy);
        ctx.drawImage(body, 0, 0, width, height);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }

    // Backbone routes (batched by depth), and the couriers that travel them.
    const ROUTE_BUCKETS = 4;
    const routePaths = Array.from({ length: ROUTE_BUCKETS }, () => new Path2D());
    for (const route of network.routes) {
      /** @type {{ x: number, y: number, z: number } | null} */
      let previous = null;
      for (const q of route.points) {
        const point = toScreen(cam, q.x, q.y, q.z, scene.radius);
        if (previous) {
          const index = Math.min(ROUTE_BUCKETS - 1, Math.floor(depthAlpha((point.z + previous.z) / 2) * ROUTE_BUCKETS));
          routePaths[index].moveTo(previous.x, previous.y);
          routePaths[index].lineTo(point.x, point.y);
        }
        previous = point;
      }
    }
    ctx.lineWidth = 1;
    for (let i = 0; i < ROUTE_BUCKETS; i++) {
      ctx.strokeStyle = `rgba(${A},${((i + 0.5) / ROUTE_BUCKETS) * 0.16 * dim * life})`;
      ctx.stroke(routePaths[i]);
    }
    for (const courier of scene.couriers) {
      const route = network.routes[courier.route];
      if (!route) continue;
      const k = easeInOutSine(clamp((t - courier.start) / courier.duration));
      const f = courier.reverse ? 1 - k : k;
      const index = f * (route.points.length - 1);
      const i0 = Math.floor(index);
      const i1 = Math.min(route.points.length - 1, i0 + 1);
      const u = index - i0;
      const a = route.points[i0], b = route.points[i1];
      const point = toScreen(cam, a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.z + (b.z - a.z) * u, scene.radius);
      const fade = Math.sin(Math.PI * k);
      const alpha = depthAlpha(point.z) * fade * dim * life;
      ctx.fillStyle = `rgba(${A},${0.14 * alpha})`;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 5, 0, TAU);
      ctx.fill();
      ctx.fillStyle = `rgba(${N},${0.9 * alpha})`;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 1.4, 0, TAU);
      ctx.fill();
    }

    // Scan sweep: a great circle turning through the network, with a wake.
    const sweepAngle = t * (TAU / 7.5) - yaw;
    const sn = { x: Math.cos(sweepAngle), z: Math.sin(sweepAngle) };
    /** @param {Node} p */
    const sweepGlow = (p) => {
      if (scene.scanAmount < 0.01) return 0;
      const d = p.x * sn.x + p.z * sn.z;
      const g = d >= 0 ? Math.exp(-d / 0.04) : Math.exp(d / 0.2);
      return g * scene.scanAmount;
    };

    // A completed scan sends one analysis wave out across the network.
    const waveK = scene.waveStart >= 0 ? (performance.now() - scene.waveStart) / 2600 : 2;
    if (waveK >= 1) scene.waveStart = -1;
    const origin = horizon ? toScreen(cam, 0, 1, 0, scene.radius) : { x: scene.cx, y: scene.cy };
    /** @param {number} i */
    const waveGlow = (i) => {
      if (waveK >= 1 || proj.z[i] < -0.1) return 0;
      const d = Math.hypot(proj.x[i] - origin.x, proj.y[i] - origin.y) / scene.radius - waveK * 1.15;
      return Math.exp(-(d * d) / 0.005) * (1 - waveK);
    };
    /** @param {number} i */
    const glowOf = (i) => Math.max(sweepGlow(network.nodes[i]), waveGlow(i)) * (network.nodes[i].inner ? 0.35 : 1);
    /** @param {Node} p */
    const shellAlpha = (p) => (p.shell === 2 ? 0.45 : p.shell === 1 ? 0.62 : 1);

    const near = focusNeighbourhood ?? (scene.attention > 0.01 ? attentionNeighbourhood : null);

    // Edges, batched into alpha buckets: a handful of strokes per frame.
    const BUCKETS = 8;
    const MAX_EDGE = 0.42;
    const paths = Array.from({ length: BUCKETS }, () => new Path2D());
    const hot = new Path2D();
    let hotCount = 0;
    for (const edge of network.edges) {
      if (edge.w <= 0.01) continue;
      const { a, b } = edge;
      if (horizon && !inView(a) && !inView(b)) continue;
      const z = (proj.z[a] + proj.z[b]) / 2;
      let alpha = depthAlpha(z) * 0.3 * edge.w * Math.min(shellAlpha(network.nodes[a]), shellAlpha(network.nodes[b]));
      const inFocus = near && near.has(a) && near.has(b);
      alpha *= inFocus ? 1 : dim;
      const glow = Math.max(glowOf(a), glowOf(b));
      if (glow > 0.4 && z > -0.1) {
        hot.moveTo(proj.x[a], proj.y[a]);
        hot.lineTo(proj.x[b], proj.y[b]);
        hotCount++;
      }
      if (inFocus) {
        hot.moveTo(proj.x[a], proj.y[a]);
        hot.lineTo(proj.x[b], proj.y[b]);
        hotCount++;
        continue;
      }
      const index = Math.min(BUCKETS - 1, Math.floor((alpha * life) / (MAX_EDGE / BUCKETS)));
      paths[index].moveTo(proj.x[a], proj.y[a]);
      paths[index].lineTo(proj.x[b], proj.y[b]);
    }
    ctx.lineWidth = 0.8;
    for (let i = 0; i < BUCKETS; i++) {
      ctx.strokeStyle = `rgba(${A},${((i + 0.5) / BUCKETS) * MAX_EDGE})`;
      ctx.stroke(paths[i]);
    }
    if (hotCount > 0) {
      ctx.strokeStyle = `rgba(${A},${(0.28 + 0.3 * Math.max(scene.scanAmount, scene.focusAmount, waveK < 1 ? 1 - waveK : 0)) * life})`;
      ctx.lineWidth = 1;
      ctx.stroke(hot);
    }
    // The focused token's route into the network: anchor to its nearest hub.
    if (focusPath && focusPath.length > 1 && scene.focusAmount > 0.02) {
      ctx.strokeStyle = `rgba(${colors.accent},${0.85 * scene.focusAmount * life})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(proj.x[focusPath[0]], proj.y[focusPath[0]]);
      for (const n of focusPath.slice(1)) ctx.lineTo(proj.x[n], proj.y[n]);
      ctx.stroke();
      const hub = focusPath[focusPath.length - 1];
      ctx.strokeStyle = `rgba(${colors.accent},${0.6 * scene.focusAmount * life})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(proj.x[hub], proj.y[hub], 7, 0, TAU);
      ctx.stroke();
    }

    // Signals travelling along edges.
    for (const signal of scene.signals) {
      const elapsed = t - signal.start;
      const position = elapsed / signal.hop;
      const hop = Math.floor(position);
      const fade = clamp(1 - (elapsed - signal.hop * (signal.nodes.length - 1)) / 0.8);
      for (let h = 0; h < Math.min(hop, signal.nodes.length - 1); h++) {
        const a = signal.nodes[h], b = signal.nodes[h + 1];
        const age = clamp(1 - (position - h - 1) / 2.2);
        ctx.strokeStyle = `rgba(${A},${0.5 * signal.strength * age * fade * life * dim})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(proj.x[a], proj.y[a]);
        ctx.lineTo(proj.x[b], proj.y[b]);
        ctx.stroke();
      }
      if (hop < signal.nodes.length - 1) {
        const a = signal.nodes[hop], b = signal.nodes[hop + 1];
        const k = easeInOutSine(position - hop);
        const x = proj.x[a] + (proj.x[b] - proj.x[a]) * k;
        const y = proj.y[a] + (proj.y[b] - proj.y[a]) * k;
        const z = proj.z[a] + (proj.z[b] - proj.z[a]) * k;
        const alpha = depthAlpha(z) * signal.strength * life * dim;
        ctx.fillStyle = `rgba(${A},${0.16 * alpha})`;
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, TAU);
        ctx.fill();
        ctx.fillStyle = `rgba(${N},${0.95 * alpha})`;
        ctx.beginPath();
        ctx.arc(x, y, 1.5, 0, TAU);
        ctx.fill();
      }
    }

    // Nodes, batched by alpha. Hubs carry a faint halo when facing us.
    const nodePaths = Array.from({ length: BUCKETS }, () => new Path2D());
    const litPath = new Path2D();
    const breathing = reduced ? 0 : 1;
    for (let i = 0; i < network.nodes.length; i++) {
      if (horizon && !inView(i)) continue;
      const p = network.nodes[i];
      const z = proj.z[i];
      const breath = (0.62 + 0.38 * p.density) * (0.8 + 0.2 * breathing * Math.sin(t * p.freq + p.phase));
      const inFocus = near ? near.has(i) : false;
      const glow = glowOf(i);
      const alpha = clamp(depthAlpha(z) * breath * shellAlpha(p) * (inFocus ? 1 : dim) * life + glow * 0.6 * depthAlpha(z));
      const r = p.size * proj.s[i] * (0.75 + 0.45 * clamp((z + 1) / 2)) + glow * 0.8;
      if (glow > 0.3 || (inFocus && scene.focusAmount > 0.05)) {
        litPath.moveTo(proj.x[i] + r + 0.6, proj.y[i]);
        litPath.arc(proj.x[i], proj.y[i], r + 0.6, 0, TAU);
        continue;
      }
      const index = Math.min(BUCKETS - 1, Math.floor(alpha * BUCKETS));
      nodePaths[index].moveTo(proj.x[i] + r, proj.y[i]);
      nodePaths[index].arc(proj.x[i], proj.y[i], r, 0, TAU);
      if (p.hub && z > 0.1) {
        ctx.fillStyle = `rgba(${A},${0.07 * alpha})`;
        ctx.beginPath();
        ctx.arc(proj.x[i], proj.y[i], 7 * proj.s[i], 0, TAU);
        ctx.fill();
      }
    }
    for (let i = 0; i < BUCKETS; i++) {
      ctx.fillStyle = `rgba(${N},${(i + 0.5) / BUCKETS})`;
      ctx.fill(nodePaths[i]);
    }
    ctx.fillStyle = `rgba(${colors.node},${0.95 * life})`;
    ctx.fill(litPath);

    // The sweep's leading edge, drawn only on the facing hemisphere.
    if (scene.scanAmount > 0.02) drawSweep(cam, sweepAngle);

    // The attended node: one quiet ring, and a slow second one while analysing.
    if (scene.attention > 0.02 && attentionNode >= 0 && !subject) {
      const x = proj.x[attentionNode], y = proj.y[attentionNode];
      ctx.fillStyle = `rgba(${A},${0.1 * scene.attention * life})`;
      ctx.beginPath();
      ctx.arc(x, y, 20, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = `rgba(${A},${0.75 * scene.attention * life})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(x, y, 7 + (reduced ? 0 : 1.5 * Math.sin(t * 2)), 0, TAU);
      ctx.stroke();
      if (activity && !reduced) {
        const k = (performance.now() % 1600) / 1600;
        ctx.strokeStyle = `rgba(${A},${0.5 * (1 - k) * scene.attention})`;
        ctx.beginPath();
        ctx.arc(x, y, 8 + 26 * easeOutCubic(k), 0, TAU);
        ctx.stroke();
      }
      ctx.fillStyle = `rgba(${colors.node},${scene.attention})`;
      ctx.beginPath();
      ctx.arc(x, y, 2.4, 0, TAU);
      ctx.fill();
    }

    drawTethers();
    placeMarkers();
  };

  /** The sweep's great circle, through the poles. @param {ReturnType<typeof camera>} cam @param {number} angle */
  const drawSweep = (cam, angle) => {
    const u = { x: -Math.sin(angle), z: Math.cos(angle) };
    ctx.lineWidth = 1.2;
    /** @type {{ x: number, y: number, z: number } | null} */
    let previous = null;
    for (let k = 0; k <= 72; k++) {
      const phi = (k / 72) * TAU;
      const point = toScreen(cam, u.x * Math.cos(phi), Math.sin(phi), u.z * Math.cos(phi), scene.radius * 1.01);
      if (previous && point.z > 0 && previous.z > 0) {
        ctx.strokeStyle = `rgba(${colors.accent},${0.5 * scene.scanAmount * point.z * (1 - 0.55 * scene.offlineAmount)})`;
        ctx.beginPath();
        ctx.moveTo(previous.x, previous.y);
        ctx.lineTo(point.x, point.y);
        ctx.stroke();
      }
      previous = point;
    }
  };

  // --- markers -----------------------------------------------------------------

  /**
   * Where a marker's slot lies, as a fraction of the ring (sphere) or of the
   * band's width (horizon). Markers ease toward it, so a change in the
   * selection re-spaces them smoothly instead of teleporting them.
   * @param {number} slot @param {number} total
   */
  const slotFraction = (slot, total) =>
    scene.composition === 'horizon' || options.ring === 'sides' ? (slot + 0.5) / total : slot / total;

  /**
   * Screen position at `fraction` along the ring or band, at scene time t.
   * `still` holds it in place (the analysed token, which must not drift toward
   * the result beside it).
   * @param {number} fraction @param {number} bob @param {boolean} [still]
   */
  const slotPosition = (fraction, bob, still = false) => {
    const t = still ? 0 : scene.t;
    if (scene.composition === 'horizon') {
      // Evenly across the band, riding an arc concentric with the limb.
      const margin = Math.min(64, scene.width * 0.12);
      const x = margin + fraction * (scene.width - 2 * margin) + 6 * Math.sin(t / 23 + bob);
      const r = scene.ringRadius + 2.5 * Math.sin(t * 0.5 + bob);
      const dx = x - scene.cx;
      const y = scene.cy - Math.sqrt(Math.max(0, r * r - dx * dx));
      return { x, y: Math.min(y, scene.height * 0.62) };
    }
    const sides = options.ring === 'sides' && !still;
    const angle = sides
      ? fraction < 0.5
        ? -0.62 + fraction * 2 * 1.24 + 0.03 * Math.sin(t / 27 + bob)
        : Math.PI - 0.62 + (fraction - 0.5) * 2 * 1.24 + 0.03 * Math.sin(t / 27 + bob)
      : -Math.PI / 2 + 0.42 + fraction * TAU + t * (TAU / 520);
    const breathe = 1 + 0.012 * Math.sin(t * 0.45 + bob);
    return { x: scene.cx + Math.cos(angle) * scene.ringX * breathe, y: scene.cy + Math.sin(angle) * scene.ringY * breathe };
  };

  /**
   * The node a marker is tethered to: facing us, in the marker's direction.
   * @param {{ x: number, y: number }} at
   */
  const nearestAnchor = (at) => {
    const network = /** @type {Network} */ (scene.network);
    const direction = Math.atan2(at.y - scene.cy, at.x - scene.cx);
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < network.nodes.length; i++) {
      if (network.nodes[i].inner) continue;
      const z = proj.z[i];
      if (z < 0.18 || !inView(i)) continue;
      const angle = Math.atan2(proj.y[i] - scene.cy, proj.x[i] - scene.cx);
      let diff = Math.abs(angle - direction);
      if (diff > Math.PI) diff = TAU - diff;
      const reach = Math.hypot(proj.x[i] - at.x, proj.y[i] - at.y) / scene.radius;
      const score = diff * 1.4 + Math.abs(z - 0.55) * 0.5 + (scene.composition === 'horizon' ? reach * 0.8 : 0);
      if (score < bestScore) (bestScore = score), (best = i);
    }
    return best;
  };

  let nextMarkerWrite = 0;

  const placeMarkers = () => {
    // At rest markers drift ~2 px a second: writing their position ~8 times a
    // second is visually identical to every frame, and a frame that touches
    // the DOM costs a style-and-commit pass that a canvas-only frame does not.
    const wallNow = performance.now();
    const write = reduced || transitioning() || wallNow >= nextMarkerWrite;
    if (write) nextMarkerWrite = wallNow + 120;
    const active = [...markers.values()].filter((m) => m.exit === 0);
    const total = Math.max(1, active.length);
    const now = scene.t;
    // Around a ring, positions wrap; across a band or two flanks they do not.
    const horizon = scene.composition === 'horizon' || options.ring === 'sides';
    for (const marker of markers.values()) {
      const isSubject = marker.token.role === 'subject';
      if (marker.exit === 0) {
        // The analysed token hangs upper left, away from the result card.
        const goal = isSubject ? 0.86 : slotFraction(marker.slot, total);
        if (marker.fraction < 0 || reduced) marker.fraction = goal;
        else {
          // Around the ring, take the short way; across the band, straight.
          let delta = goal - marker.fraction;
          if (!horizon) delta -= Math.round(delta);
          marker.fraction += delta * (1 - Math.exp(-3.2 * scene.frameDt));
          if (!horizon) marker.fraction = ((marker.fraction % 1) + 1) % 1;
        }
      }
      const target = slotPosition(marker.fraction, marker.bob, isSubject);
      // Re-anchor with hysteresis: only when the current node has turned away.
      const current = marker.anchor;
      // The analysed token hangs from the node the analysis converged on.
      if (marker.token.role === 'subject' && attentionNode >= 0) {
        if (marker.anchor !== attentionNode) {
          marker.anchorFrom = marker.anchor < 0 ? attentionNode : marker.anchor;
          marker.anchorBlend = marker.anchor < 0 ? 1 : 0;
          marker.anchor = attentionNode;
        }
      }
      const needsAnchor =
        marker.token.role !== 'subject' &&
        current < 0 || proj.z[current] < 0.3 || !inView(current) || (now >= marker.anchorCheckAt && focused !== marker.token.mint);
      if (needsAnchor && scene.network) {
        const next = nearestAnchor(target);
        if (next >= 0 && next !== current) {
          const better = current < 0 || proj.z[current] < 0.3 || !inView(current);
          if (better || now >= marker.anchorCheckAt) {
            marker.anchorFrom = current < 0 ? next : current;
            marker.anchor = next;
            marker.anchorBlend = current < 0 ? 1 : 0;
          }
        }
        marker.anchorCheckAt = now + 4 + (marker.bob % 1) * 3;
      }

      let { x, y } = target;
      let scale = 1;
      let opacity = 1;
      if (marker.enter < 1) {
        const k = easeOutCubic(marker.enter);
        const from = anchorPoint(marker);
        x = from.x + (x - from.x) * k;
        y = from.y + (y - from.y) * k;
        scale = 0.45 + 0.55 * k;
        opacity = k;
      }
      if (marker.exit > 0) {
        const k = easeOutCubic(marker.exit);
        const to = anchorPoint(marker);
        x = x + (to.x - x) * k;
        y = y + (to.y - y) * k;
        scale = 1 - 0.55 * k;
        opacity = 1 - k;
      }
      opacity *= easeOutCubic(marker.appear);
      const isFocused = focused === marker.token.mint;
      if (focused && !isFocused) opacity *= 1 - 0.62 * scene.focusAmount;
      if (isFocused) scale *= 1 + 0.1 * scene.focusAmount;
      opacity *= 1 - 0.45 * scene.offlineAmount;

      // Half-pixel steps: at rest a marker drifts ~2 px a second, so its style
      // changes a few times a second rather than on every frame.
      const q = (/** @type {number} */ v) => (Math.round(v * 2) / 2).toFixed(1);
      const transform = `translate3d(${q(x)}px,${q(y)}px,0) translate(-50%,-50%) scale(${scale.toFixed(2)})`;
      if (write && marker.last !== transform) {
        marker.el.style.transform = transform;
        marker.last = transform;
      }
      // Compared with what was last written: the style getter normalises "1.00"
      // to "1", so comparing against it rewrote every marker on every frame.
      const o = opacity.toFixed(2);
      if (write && marker.lastOpacity !== o) {
        marker.el.style.opacity = o;
        marker.lastOpacity = o;
      }
    }
  };

  /** @param {{ anchor: number, anchorFrom: number, anchorBlend: number }} marker */
  const anchorPoint = (marker) => {
    if (marker.anchor < 0) return { x: scene.cx, y: scene.cy };
    const a = marker.anchorFrom >= 0 ? marker.anchorFrom : marker.anchor;
    const k = easeInOutSine(marker.anchorBlend);
    return {
      x: proj.x[a] + (proj.x[marker.anchor] - proj.x[a]) * k,
      y: proj.y[a] + (proj.y[marker.anchor] - proj.y[a]) * k,
    };
  };

  const drawTethers = () => {
    for (const marker of markers.values()) {
      if (marker.anchor < 0 || marker.fraction < 0) continue;
      const from = anchorPoint(marker);
      const to = slotPosition(marker.fraction, marker.bob, marker.token.role === 'subject');
      const isFocused = focused === marker.token.mint;
      const presence = marker.exit > 0 ? 1 - marker.exit : marker.enter;
      const rest = marker.primary ? 0.42 : 0.24;
      let alpha = (isFocused ? 0.3 + 0.55 * scene.focusAmount : rest * (1 - 0.7 * scene.focusAmount)) * presence;
      alpha *= 1 - 0.5 * scene.offlineAmount;
      // Pull the line back from the marker so it meets the icon's edge.
      const dx = to.x - from.x, dy = to.y - from.y;
      const length = Math.hypot(dx, dy) || 1;
      const inset = marker.primary ? 22 : 16;
      const end = { x: to.x - (dx / length) * inset, y: to.y - (dy / length) * inset };
      // The tether leaves the sphere along its surface normal, then bends to
      // the token: it emerges from the network rather than being ruled to it.
      const nx = from.x - scene.cx, ny = from.y - scene.cy;
      const nlen = Math.hypot(nx, ny) || 1;
      const reach = Math.min(length * 0.5, 80);
      const cx = from.x + (nx / nlen) * reach, cy = from.y + (ny / nlen) * reach;
      const tone = isFocused ? toneRgb(marker.token.tone) : colors.accent;
      const gradient = ctx.createLinearGradient(from.x, from.y, end.x, end.y);
      gradient.addColorStop(0, `rgba(${tone},${alpha})`);
      gradient.addColorStop(1, `rgba(${tone},${alpha * 0.35})`);
      ctx.strokeStyle = gradient;
      ctx.lineWidth = isFocused ? 1.2 : 0.9;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.quadraticCurveTo(cx, cy, end.x, end.y);
      ctx.stroke();
      // The anchor node itself.
      ctx.fillStyle = `rgba(${tone},${Math.min(1, alpha * 2.4)})`;
      ctx.beginPath();
      ctx.arc(from.x, from.y, isFocused ? 2.4 : 1.8, 0, TAU);
      ctx.fill();
      if (isFocused && scene.focusAmount > 0.05) {
        ctx.strokeStyle = `rgba(${tone},${0.55 * scene.focusAmount})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(from.x, from.y, 6 + 1.5 * Math.sin(scene.t * 2.2), 0, TAU);
        ctx.stroke();
      }
      // A real completion: the scan re-evaluated this token.
      if (marker.glintAt > 0) {
        const k = (performance.now() - marker.glintAt) / 1400;
        if (k >= 1) marker.glintAt = 0;
        else {
          ctx.strokeStyle = `rgba(${colors.accent},${0.6 * (1 - k)})`;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(from.x, from.y);
          ctx.quadraticCurveTo(cx, cy, end.x, end.y);
          ctx.stroke();
        }
      }
    }
  };

  /** @param {string} tone */
  const toneRgb = (tone) => (tone === 'good' ? colors.good : tone === 'warn' ? colors.warn : tone === 'bad' ? colors.bad : colors.neutral);

  /**
   * Brings the marker elements in line with `data`: departed tokens retreat into
   * the network, changed ones update in place (keeping focus), and new ones
   * appear. They *emerge* from the network - the gesture that means "new" - only
   * when `emerge` is set, which is only after a real scan changed the selection.
   * On first load, or when a resize makes room for more, they simply fade in:
   * nothing happened, so nothing should look as if it had.
   * @param {{ emerge?: boolean }} [options]
   */
  const syncMarkers = ({ emerge = false } = {}) => {
    const tokens = (subject ? [subject] : reveal ? data?.tokens ?? [] : []).slice(0, scene.maxMarkers);
    const wanted = new Set(tokens.map((token) => token.mint));

    for (const [mint, marker] of markers) {
      if (!wanted.has(mint) && marker.exit === 0) {
        marker.exit = reduced ? 1 : 0.0001;
        marker.el.setAttribute('tabindex', '-1');
        marker.el.setAttribute('aria-hidden', 'true');
      }
    }

    const usedSlots = new Set([...markers.values()].filter((m) => m.exit === 0).map((m) => m.slot));
    const freeSlot = () => {
      for (let i = 0; ; i++) if (!usedSlots.has(i)) return usedSlots.add(i), i;
    };

    tokens.forEach((token, index) => {
      const existing = markers.get(token.mint);
      if (existing && existing.exit > 0) {
        // Back in the selection before it finished leaving: bring it back.
        existing.exit = 0;
        existing.slot = freeSlot();
        existing.el.removeAttribute('tabindex');
        existing.el.removeAttribute('aria-hidden');
      }
      if (existing) {
        const primary = index < 2;
        const verdictChanged = existing.token.verdict !== token.verdict;
        const reevaluated = existing.token.lastSeenAt !== token.lastSeenAt;
        if (
          verdictChanged ||
          primary !== existing.primary ||
          existing.token.score !== token.score ||
          existing.token.symbol !== token.symbol ||
          existing.token.why !== token.why
        ) {
          render(existing.el, markerInner(token, primary));
          existing.el.className = markerClass(token, primary);
          if (existing.el.classList.contains('is-focused') || focused === token.mint) existing.el.classList.add('is-focused');
          existing.el.setAttribute('aria-label', markerLabel(token));
          existing.primary = primary;
        }
        if (verdictChanged && !reduced) {
          existing.el.classList.add('is-changed');
          existing.pulseAt = performance.now();
          scene.pendingRipples.push(existing.anchor);
        }
        if (reevaluated && !reduced) existing.glintAt = performance.now();
        existing.token = token;
        return;
      }
      const holder = document.createElement('ol');
      render(holder, markerTemplate(token, index < 2));
      const item = /** @type {HTMLLIElement} */ (holder.firstElementChild);
      const el = /** @type {HTMLAnchorElement} */ (item.querySelector('a'));
      // Keep DOM (and so tab) order equal to priority order.
      const before = [...list.children][index] ?? null;
      list.insertBefore(item, before);
      markers.set(token.mint, {
        token,
        primary: index < 2,
        el,
        item,
        slot: freeSlot(),
        fraction: -1,
        enter: reduced || !emerge ? 1 : 0,
        appear: reduced || emerge ? 1 : 0,
        exit: 0,
        anchor: -1,
        anchorFrom: -1,
        anchorBlend: 1,
        anchorCheckAt: 0,
        bob: index * 1.7 + 0.4,
        glintAt: 0,
        pulseAt: 0,
        last: '',
        lastOpacity: '',
      });
    });
    // Compact slot numbers so the ring stays evenly spaced.
    [...markers.values()]
      .filter((m) => m.exit === 0)
      .sort((a, b) => a.slot - b.slot)
      .forEach((m, i) => (m.slot = i));
  };

  /** @param {number} dt seconds */
  const advanceMarkers = (dt) => {
    for (const [mint, marker] of markers) {
      marker.anchorBlend = clamp(marker.anchorBlend + dt / 0.9);
      if (marker.enter < 1) marker.enter = Math.min(1, marker.enter + dt / 1.2);
      if (marker.appear < 1) marker.appear = Math.min(1, marker.appear + dt / 0.45);
      if (marker.exit > 0) {
        marker.exit = Math.min(1, marker.exit + dt / 0.7);
        if (marker.exit >= 1) {
          marker.item.remove();
          markers.delete(mint);
          if (focused === mint) setFocus(null, null);
        }
      }
      if (marker.pulseAt > 0 && performance.now() - marker.pulseAt > 1800) {
        marker.el.classList.remove('is-changed');
        marker.pulseAt = 0;
      }
    }
  };

  // --- state, readout ----------------------------------------------------------

  const stateName = () => {
    if (focused) return 'focus';
    if (status.connection === 'offline' || status.connection === 'reconnecting') return 'offline';
    if (activity) return 'analyzing';
    if (follow && status.scanning) return 'scanning';
    return 'idle';
  };

  const paintReadout = () => {
    const state = stateName();
    if (root.dataset.state !== state) root.dataset.state = state;
    root.dataset.scanning = String(follow && status.scanning);
    root.dataset.subject = subject?.mint ?? '';
    root.dataset.motion = reduced ? 'reduced' : 'full';

    const offline = state === 'offline' || (focused && (status.connection === 'offline' || status.connection === 'reconnecting'));
    const label = offline ? 'Paused' : status.scanning ? 'Scanning' : status.connection === 'connecting' ? 'Connecting' : 'Observing';
    if (statusText.textContent !== label) statusText.textContent = label;

    if (focused) {
      const marker = markers.get(focused);
      if (marker) return render(readout, previewTemplate(marker.token));
    }
    const shown = [...markers.values()].filter((m) => m.exit === 0).length;
    const live = data ? count(data.universe.live) : '—';
    let line;
    if (offline) {
      line = html`<p class="orb__line">Server unreachable. Showing what was last observed.</p>`;
    } else if (status.scanning) {
      line = html`<p class="orb__line orb__line--scan">Scan in progress${status.scanStartedAt ? html` · started ${ago(status.scanStartedAt)}` : ''}</p>`;
    } else if (status.lastOutcome === 'failed') {
      line = html`<p class="orb__line tone--warn">The last scan failed. These are the previous results.</p>`;
    } else if (status.lastOutcome === 'complete' && status.lastResult && Date.now() < status.completeUntil) {
      line = html`<p class="orb__line">Scan complete · ${count(status.lastResult.analyzed)} analysed · ${count(status.lastResult.fresh)} new</p>`;
    } else {
      line = html`<p class="orb__line">${shown ? html`${shown} of ${live} live tokens surfaced` : data ? 'No live token to surface yet' : 'Loading…'}</p>`;
    }
    // The engine records when a scan started. When this server process ran
    // the scan it also knows how long it took, so the finish can be stated;
    // "Scan complete" beside "last scan 2m ago" would read as a contradiction.
    const scan = data?.scan ?? null;
    const finished = scan?.last && scan.last.at === scan.lastScanAt ? scan.last.at + scan.last.durationMs : null;
    const when = finished ? html`Last scan finished ${ago(finished)}` : scan?.lastScanAt ? html`Last scan ${ago(scan.lastScanAt)}` : 'No scan yet';
    render(
      readout,
      html`${line}<p class="orb__meta">${when}${scan?.count ? html` · #${count(scan.count)}` : ''}<span class="orb__hint"> · hover or focus a token</span></p>`,
    );
  };

  /** @param {string | null} mint @param {'pointer' | 'keyboard' | null} source */
  const setFocus = (mint, source) => {
    if (source === 'pointer') hovered = mint;
    else if (source === 'keyboard') keyboardFocused = mint;
    else hovered = keyboardFocused = null;
    const next = hovered ?? keyboardFocused;
    if (next === focused) return;
    focused = next;
    for (const marker of markers.values()) marker.el.classList.toggle('is-focused', marker.token.mint === focused);
    const marker = focused ? markers.get(focused) : null;
    focusNeighbourhood = marker && marker.anchor >= 0 && scene.network ? neighbourhood(scene.network.adjacency, marker.anchor, 2) : null;
    focusPath = marker && marker.anchor >= 0 && scene.network ? pathToHub(scene.network, marker.anchor) : null;
    if (marker && marker.anchor >= 0 && !reduced) walk(marker.anchor, 4, 1);
    if (reduced) scene.focusAmount = focused ? 1 : 0;
    paintReadout();
    requestDraw();
  };

  // --- loop control ------------------------------------------------------------

  const shouldRun = () => !disposed && !reduced && onScreen && document.visibilityState === 'visible' && scene.width > 0;

  const start = () => {
    if (frame !== 0 || timer !== 0 || !shouldRun()) return;
    lastTime = 0;
    frame = requestAnimationFrame(tick);
  };
  const stop = () => {
    if (frame !== 0) cancelAnimationFrame(frame);
    if (timer !== 0) clearTimeout(timer);
    frame = 0;
    timer = 0;
  };
  /** Draw one frame now (reduced motion, or a change while the loop is paused). */
  let drawQueued = 0;
  const requestDraw = () => {
    if (frame !== 0 || timer !== 0 || drawQueued !== 0 || disposed) return;
    // Nothing is drawn into a hidden tab; showing it again redraws.
    if (document.visibilityState !== 'visible') return;
    drawQueued = requestAnimationFrame(() => {
      drawQueued = 0;
      if (disposed) return;
      if (reduced) {
        scene.t = STILL_T;
        scene.scanAmount = (follow && status.scanning && status.connection === 'live') || activity ? 1 : 0;
        scene.attention = attentionGoal ? 1 : 0;
        if (placementMoving()) {
          scene.place = { ...scene.placeGoal };
          if (scene.composition === 'sphere') sphereGeometry(scene.place);
          renderBody();
        }
        if (attentionGoal) {
          project();
          keepAttention();
        }
        scene.offlineAmount = stateName() === 'offline' ? 1 : 0;
        scene.focusAmount = focused ? 1 : 0;
        for (const marker of markers.values()) {
          marker.enter = 1;
          marker.appear = 1;
          if (marker.exit > 0) marker.exit = 1;
        }
      }
      draw();
      advanceMarkers(1);
      frames += 1;
    });
  };

  // --- data ----------------------------------------------------------------

  let loading = false;
  /** Bumped by every scan event, so a response cannot overrule a newer event. */
  let scanEvents = 0;
  let reloadQueued = false;
  const load = async () => {
    if (disposed) return;
    // A scan finishing while a request is in flight must still be reflected:
    // queue one more load rather than dropping this one.
    if (loading) {
      reloadQueued = true;
      return;
    }
    loading = true;
    const seenEvents = scanEvents;
    try {
      const next = /** @type {OrbResponse} */ (await api('/api/orb'));
      if (disposed) return;
      const first = data === null;
      data = next;
      // The response describes the moment it was generated. If a scan event
      // arrived since the request went out, the event is newer: keep it.
      if (follow && seenEvents === scanEvents) status.scanning = next.scan.scanning;
      if (!first) {
        for (const token of next.tokens) {
          const marker = markers.get(token.mint);
          if (marker && marker.token.lastSeenAt !== token.lastSeenAt) scene.pendingRipples.push(marker.anchor);
        }
      }
      syncMarkers({ emerge: !first });
      paintReadout();
      requestDraw();
    } catch {
      // The connection banner says the server is unreachable; keep what we have.
    } finally {
      loading = false;
      if (reloadQueued && !disposed) {
        reloadQueued = false;
        void load();
      }
    }
  };

  // --- wiring ----------------------------------------------------------------

  /** @param {Event} event */
  const markerOf = (event) => {
    const target = event.target;
    const el = target instanceof Element ? target.closest('.orb-marker') : null;
    return el instanceof HTMLElement ? el.dataset.mint ?? null : null;
  };
  /** @param {PointerEvent} event */
  const onPointerOver = (event) => {
    if (event.pointerType !== 'mouse') return;
    const mint = markerOf(event);
    if (mint) setFocus(mint, 'pointer');
  };
  /** @param {PointerEvent} event */
  const onPointerOut = (event) => {
    if (event.pointerType !== 'mouse') return;
    const into = event.relatedTarget instanceof Element ? event.relatedTarget.closest('.orb-marker') : null;
    if (!into && hovered) setFocus(null, 'pointer');
  };
  /** @param {FocusEvent} event */
  const onFocusIn = (event) => {
    const mint = markerOf(event);
    if (mint) setFocus(mint, 'keyboard');
  };
  /** @param {FocusEvent} event */
  const onFocusOut = (event) => {
    const into = event.relatedTarget instanceof Element ? event.relatedTarget.closest('.orb-marker') : null;
    if (!into) setFocus(null, 'keyboard');
  };
  /** Subtle parallax toward the pointer. @param {PointerEvent} event */
  const onStageMove = (event) => {
    if (event.pointerType !== 'mouse' || reduced) return;
    const rect = stage.getBoundingClientRect();
    scene.pointerX = clamp(((event.clientX - rect.left) / rect.width) * 2 - 1, -1, 1);
    scene.pointerY = clamp(((event.clientY - rect.top) / rect.height) * 2 - 1, -1, 1);
  };
  const onStageLeave = () => {
    scene.pointerX = 0;
    scene.pointerY = 0;
  };
  /** Missing icon: the monogram underneath shows through. @param {Event} event */
  const onImageError = (event) => {
    if (event.target instanceof HTMLImageElement) event.target.classList.add('is-broken');
  };
  const onVisibility = () => {
    if (document.visibilityState !== 'visible') return stop();
    start();
    requestDraw();
  };
  const onMotionPreference = () => {
    reduced = reducedQuery.matches;
    stop();
    paintReadout();
    if (reduced) requestDraw();
    else start();
  };

  list.addEventListener('pointerover', onPointerOver);
  list.addEventListener('pointerout', onPointerOut);
  list.addEventListener('focusin', onFocusIn);
  list.addEventListener('focusout', onFocusOut);
  stage.addEventListener('pointermove', onStageMove);
  stage.addEventListener('pointerleave', onStageLeave);
  root.addEventListener('error', onImageError, true);
  document.addEventListener('visibilitychange', onVisibility);
  reducedQuery.addEventListener('change', onMotionPreference);

  const resizeObserver = new ResizeObserver(() => {
    layout();
    start();
  });
  resizeObserver.observe(stage);
  const intersection = new IntersectionObserver((entries) => {
    onScreen = entries.some((entry) => entry.isIntersecting);
    if (onScreen) start();
    else stop();
  });
  intersection.observe(stage);

  const offLive = onLive((state) => {
    const before = status.connection;
    status.connection = state.connection;
    if (follow && state.status && state.connection === 'live') status.scanning = state.status.scanning;
    if (before !== state.connection) {
      paintReadout();
      requestDraw();
    }
  });
  const offEvents = onServerEvent((kind, payload) => {
    if (!follow) {
      // A surface that does not reflect scans still shows current tokens.
      if (kind === 'scan' || kind === 'reconnected') void load();
      return;
    }
    if (kind === 'scan-start' || kind === 'scan' || kind === 'scan-failed') scanEvents += 1;
    if (kind === 'scan-start') {
      status.scanning = true;
      status.scanStartedAt = typeof payload?.at === 'number' ? payload.at : Date.now();
      status.lastOutcome = 'ok';
    } else if (kind === 'scan') {
      if (!reduced) scene.waveStart = performance.now();
      status.scanning = false;
      status.scanStartedAt = null;
      status.lastOutcome = 'complete';
      status.lastResult = { at: payload?.at ?? Date.now(), analyzed: payload?.analyzed ?? 0, fresh: payload?.fresh ?? 0 };
      status.completeUntil = Date.now() + 12_000;
      void load();
    } else if (kind === 'scan-failed') {
      status.scanning = false;
      status.scanStartedAt = null;
      status.lastOutcome = 'failed';
    } else if (kind === 'reconnected') {
      void load();
    } else {
      return;
    }
    paintReadout();
    requestDraw();
  });

  // Ages in the readout ("2m ago") and scan time move on.
  const clock = window.setInterval(() => {
    if (!focused) paintReadout();
  }, 5_000);
  const refresh = window.setInterval(() => void load(), REFRESH_MS);

  paintReadout();
  layout();
  void load();

  /** Applies a state change now under reduced motion, or lets the loop ease it. */
  const changed = () => {
    paintReadout();
    requestDraw();
    start();
  };

  return {
    /** A slot in the Observatory's footer that the host page may fill. */
    aside: /** @type {HTMLElement} */ (root.querySelector('.orb__aside')),
    /**
     * A person leaning toward one of the two things they can do.
     * 'analyze' quiets the network onto one node; 'discover' reveals the live
     * tokens around it. Neither invents anything: the node is the one an
     * analysis will converge on, and the tokens are the real live selection.
     * @param {'analyze' | 'discover' | null} intent
     */
    setIntent(intent) {
      if (activity || subject) return;
      attentionGoal = intent === 'analyze';
      const nextReveal = intent === 'discover' ? true : revealByDefault;
      if (nextReveal !== reveal) {
        reveal = nextReveal;
        syncMarkers();
      }
      root.dataset.intent = intent ?? '';
      changed();
    },
    /** A requested analysis has started. */
    beginAnalysis() {
      activity = true;
      attentionGoal = true;
      subject = null;
      reveal = false;
      syncMarkers();
      root.dataset.intent = '';
      changed();
    },
    /** A real pipeline stage began: a burst of signals converges on the node. */
    stage() {
      if (!reduced) converge(3);
      requestDraw();
    },
    /**
     * The analysis finished. With a token, it emerges from the node the
     * analysis converged on and one analysis wave crosses the network. Without
     * one (no market, providers down), attention is released.
     * @param {OrbToken | null} token
     */
    endAnalysis(token) {
      activity = false;
      subject = token;
      attentionGoal = token !== null;
      if (token && !reduced) scene.waveStart = performance.now();
      syncMarkers({ emerge: token !== null });
      changed();
    },
    /** Back to the ambient state. */
    reset() {
      activity = false;
      subject = null;
      attentionGoal = false;
      reveal = revealByDefault;
      root.dataset.intent = '';
      syncMarkers();
      changed();
    },
    /**
     * Moves the sphere within its stage: eased, or at once under reduced motion.
     * @param {Placement} placement
     */
    setPlacement(placement) {
      scene.placeGoal = { ...placement };
      if (reduced) {
        scene.place = { ...placement };
        layout();
      }
      changed();
    },
    dispose() {
      disposed = true;
      stop();
      if (drawQueued) cancelAnimationFrame(drawQueued);
      resizeObserver.disconnect();
      intersection.disconnect();
      list.removeEventListener('pointerover', onPointerOver);
      list.removeEventListener('pointerout', onPointerOut);
      list.removeEventListener('focusin', onFocusIn);
      list.removeEventListener('focusout', onFocusOut);
      stage.removeEventListener('pointermove', onStageMove);
      stage.removeEventListener('pointerleave', onStageLeave);
      root.removeEventListener('error', onImageError, true);
      document.removeEventListener('visibilitychange', onVisibility);
      reducedQuery.removeEventListener('change', onMotionPreference);
      offLive();
      offEvents();
      clearInterval(clock);
      clearInterval(refresh);
      instances -= 1;
      publishInstances();
    },
  };
}

/** "#8ab4ff" → "138,180,255", for rgba() strings. @param {string} hex */
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '138,180,255';
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}
