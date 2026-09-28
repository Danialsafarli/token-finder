// @ts-check
/**
 * Landing: what Token Finder is, and the two ways in.
 *
 *   "I have a token."            → Analyze: paste a mint, watch the real
 *                                   pipeline run on it, read the verdict.
 *   "Show me what matters now."  → Scan live: Token Finder runs a real
 *                                   discovery scan here, then carries the
 *                                   same Observatory into Live discovery.
 *
 * The page reads top to bottom: the headline, the Observatory, then the two
 * ways in. When either begins, the Observatory lifts into an operational stage
 * - measured from where it is on screen, so it never jumps - and scans.
 *
 * `/` and `/analyze/:mint` are one view in different states. A discovery scan
 * runs on `/` and ends by handing the Observatory itself to `/discover`.
 *
 * Nothing here is simulated. Stages and counts are what the server reports;
 * results are persisted data; a scan that fails or a token with no market says
 * so.
 */

import { appUrl, html, render } from '../lib/html.js';
import { api, ApiError } from '../lib/api.js';
import { ago, count, duration, share, shortAddress } from '../lib/format.js';
import { navigate } from '../lib/router.js';
import { liveState, onLive, onServerEvent } from '../lib/live.js';
import { handOff, mountOrb } from '../ui/orb.js';
import { mountScanner } from '../ui/scanner.js';
import { dossierUrl, tokenIcon, toneClass, verdictChip } from '../ui/components.js';

/** A Solana mint: base58, 32 to 44 characters. */
const MINT_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * @typedef {{ id: string, label: string, detail: string | null, at: number }} Stage
 * @typedef {'idle' | 'scanning' | 'discovering' | 'arriving' | 'result' | 'error'} Phase
 */

/**
 * Accepts a pasted mint, or a link that ends in one (Solscan, Jupiter, a
 * Dossier link). Returns the mint, or a reason it is not one.
 * @param {string} raw
 * @returns {{ mint: string } | { error: string }}
 */
export function readMint(raw) {
  const text = raw.trim();
  if (text === '') return { error: 'Paste a Solana mint address.' };
  let candidate = text;
  if (/^https?:\/\//i.test(text)) {
    try {
      candidate = new URL(text).pathname.split('/').filter(Boolean).pop() ?? '';
    } catch {
      return { error: 'That link could not be read.' };
    }
  }
  if (MINT_ADDRESS.test(candidate)) return { mint: candidate };
  if (/[0OIl]/.test(candidate) && /^[0-9A-Za-z]+$/.test(candidate)) {
    return { error: 'That is not a Solana address: they never contain 0, O, I or lowercase l.' };
  }
  if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(candidate)) {
    return { error: `A Solana mint address is 32 to 44 characters; that is ${candidate.length}.` };
  }
  return { error: 'That does not look like a Solana mint address.' };
}

// --- templates ------------------------------------------------------------------

const shellTemplate = () => html`
  <section class="landing" data-phase="idle" aria-labelledby="landing-title">
    <div class="landing__content">
      <header class="landing__intro">
        <p class="landing__eyebrow">Live token discovery · Solana</p>
        <h1 class="landing__title" id="landing-title">Find the signal <span class="landing__title-line">in every new Solana launch.</span></h1>
        <p class="landing__lede">
          Token Finder watches new tokens as they appear, weighs each one's market, contract and risk reports,
          and keeps its read current as conditions change. Every verdict arrives with its evidence.
        </p>
      </header>
      <div class="landing__orb" data-slot="orb"></div>
      <div class="landing__deck" data-slot="deck"></div>
    </div>
  </section>`;

/**
 * @param {import('../lib/live.js').LiveState} live
 * @param {{ lastDurationMs: number | null }} facts
 * @param {string} value @param {string | null} error
 */
const pathsTemplate = (live, facts, value, error) => {
  const status = live.status;
  return html`<div class="paths" role="group" aria-label="Two ways to start">
    <form class="path path--analyze" novalidate data-intent="analyze">
      <p class="path__kicker">I have a token</p>
      <h2 class="path__title">Read one token</h2>
      <p class="path__body">Paste its mint. Token Finder runs its full pipeline on it - market, safety reports, evidence, verdict - and keeps the result.</p>
      <div class="mint-field ${error ? 'is-invalid' : ''}">
        <label class="sr-only" for="mint-input">Solana mint address</label>
        <input id="mint-input" name="mint" type="text" value="${value}" placeholder="Solana mint address"
          autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="${error ? 'mint-error' : 'mint-help'}"
          aria-invalid="${error ? 'true' : 'false'}" />
        <button class="btn btn--primary" type="submit">Analyze</button>
      </div>
      ${error
        ? html`<p class="path__error" id="mint-error" role="alert">${error}</p>`
        : html`<p class="path__help" id="mint-help">Or paste a Solscan, Jupiter or Dossier link.</p>`}
    </form>
    <section class="path path--discover" data-intent="discover" aria-labelledby="discover-title">
      <p class="path__kicker">Show me what matters now</p>
      <h2 class="path__title" id="discover-title">Scan live</h2>
      <p class="path__body">Token Finder sweeps its discovery feeds now, evaluates what they surface, and opens the Live Board with what it found.</p>
      <button class="btn btn--primary path__scan" type="button" data-action="discover">Start a live scan</button>
      <p class="path__help">
        ${status
          ? html`<strong>${count(status.universe.live)}</strong> tokens live${status.lastScanAt ? html` · last scan ${ago(status.lastScanAt)}` : ''}${facts.lastDurationMs ? html`, took ${duration(facts.lastDurationMs)}` : ''}`
          : 'Connecting…'}
        · <a href="${appUrl('/discover')}" data-link>open the Live Board without scanning</a>
      </p>
    </section>
  </div>`;
};

/** @param {Stage[]} stages @param {boolean} finishing */
const stageList = (stages, finishing) => html`<ol class="stages" aria-live="polite">
  ${stages.map((stage, index) => {
    const done = index < stages.length - 1 || finishing;
    return html`<li class="stage ${done ? 'stage--done' : 'stage--active'}">
      <span class="stage__mark" aria-hidden="true"></span>
      <span class="stage__text"><span class="stage__label">${stage.label}</span>${stage.detail ? html`<span class="stage__detail">${stage.detail}</span>` : ''}</span>
      <span class="sr-only">${done ? ', done' : ', in progress'}</span>
    </li>`;
  })}
</ol>`;

/** @param {string} mint @param {Stage[]} stages @param {boolean} finishing */
const analyzeProgress = (mint, stages, finishing) => html`<section class="progress" aria-labelledby="progress-title">
  <p class="path__kicker">Reading one token</p>
  <h2 class="progress__title" id="progress-title"><code>${shortAddress(mint)}</code></h2>
  ${stageList(stages, finishing)}
  <p class="progress__note">Stages appear as the pipeline reaches them. There is no percentage: the engine does not estimate one.</p>
  <a class="progress__cancel" href="${appUrl('/')}" data-link>Cancel</a>
</section>`;

/** @param {Stage[]} stages @param {boolean} finishing @param {boolean} following */
const discoverProgress = (stages, finishing, following) => html`<section class="progress" aria-labelledby="progress-title">
  <p class="path__kicker">Live scan</p>
  <h2 class="progress__title progress__title--text" id="progress-title">${finishing ? 'Discovery complete' : 'Searching for new tokens'}</h2>
  ${following ? html`<p class="progress__note">A scan was already running when you asked, so this follows it.</p>` : ''}
  ${stageList(stages, finishing)}
  <p class="progress__note">A real scan of the discovery feeds; it usually takes a minute or two. Counts are real - there is no percentage.</p>
  <div class="progress__links">
    <a class="progress__cancel" href="${appUrl('/')}" data-link>Stop watching</a>
    <a class="progress__cancel" href="${appUrl('/discover')}" data-link>Open the Live Board now</a>
  </div>
</section>`;

/** @param {any} d the Dossier @param {number | null} tookMs */
const resultTemplate = (d, tookMs) => {
  const trust = d.trust;
  const unknowns = /** @type {any[]} */ (trust.unknowns ?? []);
  return html`<article class="result" aria-labelledby="result-title">
    <p class="path__kicker">Analysis complete${tookMs !== null ? html` · took ${(tookMs / 1000).toFixed(1)} s` : ''}</p>
    <header class="result__id">
      ${tokenIcon(d.token, 48)}
      <div class="result__name">
        <h2 id="result-title" tabindex="-1">${d.token.symbol}</h2>
        <p>${d.token.name ? html`<span>${d.token.name}</span> · ` : ''}<code>${shortAddress(d.token.mint)}</code></p>
      </div>
    </header>
    <div class="result__verdict">
      ${verdictChip(d.verdict.eligibility, { size: 'lg' })}
      <p class="${toneClass(d.verdict.reasonTone ?? 'neutral')}">${d.verdict.reason}</p>
    </div>
    <dl class="result__trust">
      <div><dt>Score</dt><dd>${d.trust.score}</dd></div>
      <div><dt>Coverage</dt><dd>${share(trust.coverage)}</dd></div>
      <div><dt>Confidence</dt><dd>${share(trust.confidence)}</dd></div>
    </dl>
    ${d.verdict.vetoes.length
      ? html`<section class="result__block"><h3>Hard vetoes</h3><ul>${d.verdict.vetoes.map((v) => html`<li class="tone--bad">${v.label}</li>`)}</ul></section>`
      : ''}
    <section class="result__block">
      <h3>Not measured</h3>
      ${unknowns.length
        ? html`<ul>${unknowns.slice(0, 4).map((u) => html`<li><span>${u.label}</span><span class="muted"> · ${u.reason}</span></li>`)}</ul>
          ${unknowns.length > 4 ? html`<p class="muted small">and ${unknowns.length - 4} more in the Dossier.</p>` : ''}`
        : html`<p class="muted small">Every evidence signal was measured.</p>`}
    </section>
    <div class="result__actions">
      <a class="btn btn--primary" href="${dossierUrl(d.token.mint)}" data-link>Open the full dossier <span aria-hidden="true">→</span></a>
      <a class="btn btn--quiet" href="${appUrl('/')}" data-link>Read another token</a>
    </div>
    <p class="result__note muted small">Like every token Token Finder evaluates, it is on the Live Board for the next ${liveState().status?.window.liveMinutes ?? 90} minutes.</p>
  </article>`;
};

/** @param {string} kicker @param {string} title @param {string} message */
const errorTemplate = (kicker, title, message) => html`<section class="result result--error" role="alert" aria-labelledby="error-title">
  <p class="path__kicker">${kicker}</p>
  <h2 id="error-title" class="result__error-title" tabindex="-1">${title}</h2>
  <p>${message}</p>
  <div class="result__actions">
    <a class="btn btn--primary" href="${appUrl('/')}" data-link>Back to the start</a>
    <a class="btn btn--quiet" href="${appUrl('/discover')}" data-link>Open the Live Board</a>
  </div>
</section>`;

/** What each failure code means to a person. */
const FAILURE_TITLE = /** @type {Record<string, string>} */ ({
  'no-market': 'No market data for this address',
  'providers-down': 'Market data is unreachable',
  failed: 'The analysis failed',
  busy: 'Too many analyses at once',
  duplicate: 'Already analysing this token',
  invalid: 'Not a Solana mint address',
  network: 'Token Finder could not be reached',
});

/** A discovery scan's real progress events, in words. @param {any} event @returns {Stage | null} */
function discoveryStage(event) {
  switch (event.stage) {
    case 'discover':
      return { id: 'discover', label: 'Reading the discovery feeds', detail: 'Jupiter and DexScreener', at: event.at };
    case 'discovered':
      return { id: 'discovered', label: `Found ${count(event.count)} candidate tokens`, detail: null, at: event.at };
    case 'market':
      return { id: 'market', label: `Fetching market data for ${count(event.count)}`, detail: 'DexScreener and Jupiter', at: event.at };
    case 'safety':
      return { id: 'safety', label: `Checking safety for the ${count(event.count)} deepest pools`, detail: 'RugCheck, one token at a time', at: event.at };
    case 'evaluated':
      return { id: 'evaluated', label: `Evaluated ${count(event.done)} of ${count(event.total)}`, detail: 'Evidence, safety rules, verdict', at: event.at };
    default:
      return null;
  }
}

// --- placement ------------------------------------------------------------------

/**
 * Where the sphere sits in each state. On a wide screen: in the page's flow at
 * rest, then in a full-height operational stage once something starts. On a
 * phone it stays a block in the flow and only its size changes.
 */
const narrow = matchMedia('(max-width: 760px)');
/** @param {Phase} phase @returns {import('../ui/orb.js').Placement} */
function placementFor(phase) {
  if (narrow.matches) {
    if (phase === 'result' || phase === 'error') return { fx: 0.5, fy: 0.5, size: 1.05 };
    return { fx: 0.5, fy: 0.5, size: 1.37 };
  }
  if (phase === 'result' || phase === 'error') return { fx: 0.29, fy: 0.52, size: 0.95 };
  if (phase === 'arriving') return { fx: 0.31, fy: 0.5, size: 0.9 };
  if (phase === 'scanning' || phase === 'discovering') return { fx: 0.5, fy: 0.47, size: 1.08 };
  return { fx: 0.5, fy: 0.5, size: 1.2 };
}

// --- the view ---------------------------------------------------------------------

/**
 * @param {HTMLElement} root
 * @param {import('../lib/router.js').Route} route
 */
export function mountLanding(root, route) {
  render(root, shellTemplate());
  const section = /** @type {HTMLElement} */ (root.querySelector('.landing'));
  const deck = /** @type {HTMLElement} */ (root.querySelector('[data-slot="deck"]'));
  const orb = mountOrb(/** @type {HTMLElement} */ (root.querySelector('[data-slot="orb"]')), {
    bare: true,
    composition: 'sphere',
    ring: 'sides',
    follow: false,
    reveal: false,
    placement: placementFor('idle'),
  });
  // The atmospheric scan field behind the Observatory: decoration only, never
  // input. The sphere's own body hides it, wherever the sphere is.
  const scanner = mountScanner(section);

  /** @type {Phase} */
  let phase = 'idle';
  let inputValue = '';
  /** @type {string | null} */
  let inputError = null;
  /** @type {AbortController | null} */
  let running = null;
  let disposed = false;
  let handedOff = false;
  /** Real facts for the Discover path: how long the last scan took. */
  const facts = { lastDurationMs: /** @type {number | null} */ (null) };
  /** @type {{ stages: Stage[], following: boolean, finishing: boolean } | null} */
  let discovery = null;
  /** @type {Set<number>} */
  const timers = new Set();
  const later = (/** @type {() => void} */ fn, /** @type {number} */ ms) => {
    const id = window.setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  };

  /**
   * Moves to a phase. Leaving or entering the resting layout changes where the
   * Observatory's stage is; the sphere is measured before and continues from
   * the same place on screen, so it glides rather than jumps.
   * @param {Phase} next
   */
  const setPhase = (next) => {
    const from = orb.sphereOnScreen();
    const layoutChanges = (phase === 'idle') !== (next === 'idle');
    phase = next;
    section.dataset.phase = next;
    if (layoutChanges) {
      window.scrollTo({ top: 0, behavior: 'instant' });
      orb.hold(from);
    }
    orb.setPlacement(placementFor(next));
  };

  const paintPaths = () => {
    const active = document.activeElement;
    const hadFocus = active instanceof HTMLInputElement && active.id === 'mint-input';
    render(deck, pathsTemplate(liveState(), facts, inputValue, inputError));
    if (hadFocus || inputError) {
      const input = /** @type {HTMLInputElement | null} */ (deck.querySelector('#mint-input'));
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    }
  };

  const idle = () => {
    running?.abort();
    running = null;
    discovery = null;
    orb.reset();
    setPhase('idle');
    document.title = 'Token Finder — live Solana token discovery';
    paintPaths();
  };

  /** @param {string} kicker @param {string} title @param {string} message */
  const fail = (kicker, title, message) => {
    orb.endAnalysis(null);
    discovery = null;
    setPhase('error');
    render(deck, errorTemplate(kicker, title, message));
    document.title = `${title} — Token Finder`;
    /** @type {HTMLElement | null} */ (deck.querySelector('h2'))?.focus();
  };

  // --- Analyze: one token, the real pipeline ----------------------------------------

  /** @param {string} mint */
  const analyze = async (mint) => {
    running?.abort();
    const controller = new AbortController();
    running = controller;
    discovery = null;
    /** @type {Stage[]} */
    const stages = [];
    setPhase('scanning');
    orb.beginAnalysis();
    document.title = `Reading ${shortAddress(mint)} — Token Finder`;
    render(deck, analyzeProgress(mint, stages, false));

    /** @type {any} */
    let done = null;
    const stopped = `Analysis stopped · ${shortAddress(mint)}`;
    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mint }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const code = response.status === 429 ? 'busy' : response.status === 409 ? 'duplicate' : response.status === 400 ? 'invalid' : 'failed';
        const body = await response.json().catch(() => ({}));
        return fail(stopped, FAILURE_TITLE[code], String(body.error ?? 'The server refused the request.'));
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += value;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line);
          if (message.type === 'stage') {
            stages.push({ id: message.id, label: message.label, detail: message.detail, at: message.at });
            orb.stage();
            if (!disposed && running === controller) render(deck, analyzeProgress(mint, stages, false));
          } else if (message.type === 'done') {
            done = message;
          }
        }
      }
    } catch {
      if (controller.signal.aborted || disposed) return;
      return fail(stopped, FAILURE_TITLE.network, 'The connection to Token Finder was lost during the analysis.');
    }
    if (disposed || running !== controller) return;
    if (!done) return fail(stopped, FAILURE_TITLE.failed, 'The analysis ended without a result.');
    if (!done.ok) return fail(stopped, FAILURE_TITLE[done.code] ?? FAILURE_TITLE.failed, done.message);

    // The verdict is persisted; read it back as the Dossier presents it.
    render(deck, analyzeProgress(mint, stages, true));
    try {
      const d = /** @type {any} */ (await api(`/api/tokens/${encodeURIComponent(mint)}`));
      if (disposed || running !== controller) return;
      orb.endAnalysis({
        mint: d.token.mint,
        symbol: d.token.symbol,
        name: d.token.name,
        icon: d.token.icon,
        verdict: d.verdict.eligibility,
        verdictLabel: d.verdict.label,
        tone: d.verdict.tone,
        score: d.trust.score,
        reason: d.verdict.reason,
        role: 'subject',
        why: 'Analyzed at your request',
        whyAt: d.verdict.assessedAt,
        change: null,
        lastSeenAt: d.placement.lastSeenAt,
        freshness: d.placement.freshness ?? 'FRESH',
      });
      setPhase('result');
      // How long the pipeline took, from the server's own stage timestamps.
      const tookMs = stages.length > 0 && typeof done.at === 'number' ? done.at - stages[0].at : null;
      render(deck, resultTemplate(d, tookMs));
      document.title = `${d.token.symbol} · ${d.verdict.label} — Token Finder`;
      /** @type {HTMLElement | null} */ (deck.querySelector('h2'))?.focus();
    } catch (error) {
      if (disposed) return;
      fail(stopped, FAILURE_TITLE.failed, error instanceof ApiError ? error.message : 'The result could not be loaded.');
    } finally {
      if (running === controller) running = null;
    }
  };

  // --- Discover: a real scan, here, then Live discovery ---------------------------

  const paintDiscovery = () => {
    if (!discovery) return;
    render(deck, discoverProgress(discovery.stages, discovery.finishing, discovery.following));
  };

  const discover = async () => {
    running?.abort();
    running = null;
    discovery = { stages: [], following: false, finishing: false };
    setPhase('discovering');
    orb.beginDiscovery();
    document.title = 'Scanning live — Token Finder';
    paintDiscovery();
    // A scan already under way is followed, not duplicated.
    if (liveState().status?.scanning) {
      discovery.following = true;
      paintDiscovery();
      return;
    }
    try {
      // The monitor's own scan: the same one it runs on its schedule.
      const response = await fetch('/api/scan', { method: 'POST' });
      if (disposed || !discovery) return;
      if (response.status === 409) {
        discovery.following = true;
        paintDiscovery();
      } else if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        fail('Live scan', 'The scan could not start', String(body.error ?? `The server answered ${response.status}.`));
      }
    } catch {
      if (!disposed) fail('Live scan', FAILURE_TITLE.network, 'The scan could not be started.');
    }
  };

  /** A discovery scan finished: say so, move aside, then carry the Observatory to Live discovery. @param {any} result */
  const discoveryComplete = (result) => {
    if (!discovery) return;
    discovery.finishing = true;
    discovery.stages.push({
      id: 'complete',
      label: `Scan complete · ${count(result?.analyzed ?? 0)} analysed · ${count(result?.fresh ?? 0)} new`,
      detail: result?.durationMs ? `took ${duration(result.durationMs)}` : null,
      at: result?.at ?? Date.now(),
    });
    orb.endDiscovery();
    paintDiscovery();
    later(() => {
      if (disposed || phase !== 'discovering') return;
      setPhase('arriving');
      later(() => {
        if (disposed || phase !== 'arriving') return;
        // The same Observatory continues on the Live Board. On a phone the
        // Board uses a different composition, so it starts fresh there.
        if (!narrow.matches) {
          handedOff = true;
          handOff(orb);
        }
        navigate('/discover');
      }, 750);
    }, 650);
  };

  const offEvents = onServerEvent((kind, payload) => {
    if (phase !== 'discovering' || !discovery) return;
    if (kind === 'scan-stage') {
      const stage = discoveryStage(payload);
      if (!stage) return;
      // "Evaluated k of n" is one line that counts up, not a line per token.
      const last = discovery.stages.at(-1);
      if (stage.id === 'evaluated' && last?.id === 'evaluated') discovery.stages[discovery.stages.length - 1] = stage;
      else {
        discovery.stages.push(stage);
        orb.stage();
      }
      paintDiscovery();
    } else if (kind === 'scan') {
      discoveryComplete(payload);
    } else if (kind === 'scan-failed') {
      fail('Live scan', 'The scan failed', 'The Live Board still has the results of earlier scans.');
    }
  });

  // --- interaction ------------------------------------------------------------

  /** @param {SubmitEvent} event */
  const onSubmit = (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.classList.contains('path--analyze')) return;
    event.preventDefault();
    const input = /** @type {HTMLInputElement} */ (form.querySelector('#mint-input'));
    inputValue = input.value;
    const parsed = readMint(input.value);
    if ('error' in parsed) {
      inputError = parsed.error;
      paintPaths();
      return;
    }
    inputError = null;
    navigate(`/analyze/${parsed.mint}`);
  };
  /** @param {MouseEvent} event */
  const onClick = (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (target instanceof HTMLElement && target.dataset.action === 'discover') void discover();
  };
  /** @param {Event} event */
  const onInput = (event) => {
    if (event.target instanceof HTMLInputElement && event.target.id === 'mint-input') {
      inputValue = event.target.value;
      if (inputError) {
        inputError = null;
        paintPaths();
      }
    }
  };

  // Intent: the Observatory leans toward what the person is reaching for.
  /** @param {Event} event */
  const intentOf = (event) => {
    const el = event.target instanceof Element ? event.target.closest('[data-intent]') : null;
    return el instanceof HTMLElement ? /** @type {'analyze' | 'discover'} */ (el.dataset.intent) : null;
  };
  /** @param {Event} event */
  const onLean = (event) => {
    if (phase !== 'idle') return;
    const intent = intentOf(event);
    if (intent) orb.setIntent(intent);
  };
  /** @param {PointerEvent | FocusEvent} event */
  const onLeave = (event) => {
    if (phase !== 'idle') return;
    const into = event.relatedTarget instanceof Element ? event.relatedTarget.closest('[data-intent]') : null;
    const still = document.activeElement instanceof Element ? document.activeElement.closest('[data-intent]') : null;
    if (!into && !still) orb.setIntent(null);
  };

  deck.addEventListener('submit', onSubmit);
  deck.addEventListener('click', onClick);
  deck.addEventListener('input', onInput);
  deck.addEventListener('pointerover', onLean);
  deck.addEventListener('focusin', onLean);
  deck.addEventListener('pointerout', onLeave);
  deck.addEventListener('focusout', onLeave);

  const onNarrow = () => orb.setPlacement(placementFor(phase));
  narrow.addEventListener('change', onNarrow);

  // The Discover path states live facts; keep them current.
  const offLive = onLive((state) => {
    if (phase === 'idle' && !(document.activeElement instanceof HTMLInputElement)) paintPaths();
    if (phase === 'discovering' && state.connection === 'offline') {
      fail('Live scan', FAILURE_TITLE.network, 'The connection was lost during the scan. It may still be running on the server.');
    }
  });
  api('/api/orb')
    .then((/** @type {any} */ orbData) => {
      facts.lastDurationMs = orbData?.scan?.last?.durationMs ?? null;
      if (!disposed && phase === 'idle') paintPaths();
    })
    .catch(() => {});

  if (route.params.mint) void analyze(route.params.mint);
  else idle();

  return {
    /** Landing ↔ analysis happen in place. @param {import('../lib/router.js').Route} next */
    update(next) {
      if (next.params.mint) {
        void analyze(next.params.mint);
      } else {
        inputValue = '';
        inputError = null;
        idle();
      }
      return true;
    },
    dispose() {
      disposed = true;
      running?.abort();
      for (const id of timers) clearTimeout(id);
      // A handed-off Observatory now belongs to Live discovery.
      if (!handedOff) orb.dispose();
      scanner.dispose();
      offLive();
      offEvents();
      narrow.removeEventListener('change', onNarrow);
      deck.removeEventListener('submit', onSubmit);
      deck.removeEventListener('click', onClick);
      deck.removeEventListener('input', onInput);
      deck.removeEventListener('pointerover', onLean);
      deck.removeEventListener('focusin', onLean);
      deck.removeEventListener('pointerout', onLeave);
      deck.removeEventListener('focusout', onLeave);
    },
  };
}
