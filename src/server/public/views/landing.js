// @ts-check
/**
 * Landing: what Token Finder is, and the two things a person comes to do.
 *
 *   "I have a token."            → Analyze: paste a mint, watch the real
 *                                   pipeline run, read the verdict.
 *   "Show me what matters now."  → Discover: the live Observatory and Board.
 *
 * `/` and `/analyze/:mint` are one view in different states - idle, scanning,
 * result, error - so the Observatory can move from the centre of the page to
 * the left as a result arrives, instead of the page being replaced.
 *
 * Nothing here is simulated. Stages are shown as the server reports them; the
 * result is the token's persisted Dossier data; a token with no market says so.
 */

import { appUrl, html, render } from '../lib/html.js';
import { api, ApiError } from '../lib/api.js';
import { count, share, shortAddress } from '../lib/format.js';
import { navigate } from '../lib/router.js';
import { liveState, onLive } from '../lib/live.js';
import { mountOrb } from '../ui/orb.js';
import { dossierUrl, tokenIcon, toneClass, verdictChip } from '../ui/components.js';

/** A Solana mint: base58, 32 to 44 characters. */
const MINT_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * @typedef {{ id: string, label: string, detail: string | null, at: number }} Stage
 * @typedef {'idle' | 'scanning' | 'result' | 'error'} Phase
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
  const candidate = /^https?:\/\//i.test(text)
    ? (new URL(text).pathname.split('/').filter(Boolean).pop() ?? '')
    : text;
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
        <p class="landing__eyebrow">Evidence-grade intelligence for new Solana tokens</p>
        <h1 class="landing__title" id="landing-title">Know what a token is <span class="landing__title-line">before you touch it.</span></h1>
        <p class="landing__lede">
          Token Finder reads a token's market, its contract and its risk reports, settles where they disagree,
          and gives you a verdict with the evidence behind it - including what it could not check.
        </p>
      </header>
      <div class="landing__orb" data-slot="orb"></div>
      <div class="landing__deck" data-slot="deck"></div>
    </div>
  </section>`;

/** @param {import('../lib/live.js').LiveState} live @param {string} value @param {string | null} error */
const pathsTemplate = (live, value, error) => {
  const status = live.status;
  return html`<div class="paths">
    <form class="path path--analyze" novalidate data-intent="analyze">
      <p class="path__kicker">I have a token</p>
      <h2 class="path__title" id="analyze-title">Analyze a token</h2>
      <div class="mint-field ${error ? 'is-invalid' : ''}">
        <label class="sr-only" for="mint-input">Solana mint address</label>
        <input id="mint-input" name="mint" type="text" inputmode="text" value="${value}" placeholder="Paste a Solana mint address"
          autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="mint-help${error ? ' mint-error' : ''}"
          aria-invalid="${error ? 'true' : 'false'}" />
        <button class="btn btn--primary" type="submit">Analyze</button>
      </div>
      ${error
        ? html`<p class="path__error" id="mint-error" role="alert">${error}</p>`
        : html`<p class="path__help" id="mint-help">A focused scan: market data, safety reports, evidence, verdict.</p>`}
    </form>
    <a class="path path--discover" href="${appUrl('/discover')}" data-link data-intent="discover">
      <span class="path__kicker">Show me what matters now</span>
      <span class="path__title">Discover live <span class="path__arrow" aria-hidden="true">→</span></span>
      <span class="path__help">${status
        ? html`<strong>${count(status.universe.live)}</strong> tokens evaluated in the last ${status.window.liveMinutes} minutes${status.counts.QUALIFIED ? html` · ${count(status.counts.QUALIFIED)} qualified` : ''}`
        : 'The tokens Token Finder is evaluating right now.'}</span>
    </a>
  </div>`;
};

/** @param {string} mint @param {Stage[]} stages @param {boolean} finishing */
const progressTemplate = (mint, stages, finishing) => html`<section class="progress" aria-labelledby="progress-title">
  <p class="path__kicker">Analyzing</p>
  <h2 class="progress__title" id="progress-title"><code>${shortAddress(mint)}</code></h2>
  <ol class="stages" aria-live="polite">
    ${stages.map((stage, index) => {
      const done = index < stages.length - 1 || finishing;
      return html`<li class="stage ${done ? 'stage--done' : 'stage--active'}">
        <span class="stage__mark" aria-hidden="true"></span>
        <span class="stage__text"><span class="stage__label">${stage.label}</span>${stage.detail ? html`<span class="stage__detail">${stage.detail}</span>` : ''}</span>
        <span class="sr-only">${done ? ', done' : ', in progress'}</span>
      </li>`;
    })}
  </ol>
  <p class="progress__note">Stages appear as the pipeline reaches them. There is no percentage: the engine does not estimate one.</p>
  <a class="progress__cancel" href="${appUrl('/')}" data-link>Cancel</a>
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
      <a class="btn btn--quiet" href="${appUrl('/')}" data-link>Analyze another</a>
    </div>
    <p class="result__note muted small">Like every token Token Finder evaluates, it is on the live Board for the next ${liveState().status?.window.liveMinutes ?? 90} minutes.</p>
  </article>`;
};

/** @param {string} title @param {string} message @param {string} mint */
const errorTemplate = (title, message, mint) => html`<section class="result result--error" role="alert" aria-labelledby="error-title">
  <p class="path__kicker">Analysis stopped${mint ? html` · <code>${shortAddress(mint)}</code>` : ''}</p>
  <h2 id="error-title" class="result__error-title" tabindex="-1">${title}</h2>
  <p>${message}</p>
  <div class="result__actions">
    <a class="btn btn--primary" href="${appUrl('/')}" data-link>Try another address</a>
    <a class="btn btn--quiet" href="${appUrl('/discover')}" data-link>Discover live</a>
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

// --- placement ------------------------------------------------------------------

/**
 * Where the sphere sits for each state. On a wide screen the Observatory is a
 * full-bleed layer behind the page and the sphere moves within it; on a phone
 * it is a block between the headline and the actions, and only its size changes.
 */
const narrow = matchMedia('(max-width: 760px)');
/** @param {Phase} phase @returns {import('../ui/orb.js').Placement} */
function placementFor(phase) {
  if (narrow.matches) {
    if (phase === 'result' || phase === 'error') return { fx: 0.5, fy: 0.5, size: 0.85 };
    if (phase === 'scanning') return { fx: 0.5, fy: 0.5, size: 1.45 };
    return { fx: 0.5, fy: 0.5, size: 1.4 };
  }
  if (phase === 'result' || phase === 'error') return { fx: 0.34, fy: 0.52, size: 0.88 };
  if (phase === 'scanning') return { fx: 0.5, fy: 0.5, size: 0.95 };
  return { fx: 0.5, fy: 0.55, size: 0.84 };
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
    placement: placementFor(route.params.mint ? 'scanning' : 'idle'),
  });

  /** @type {Phase} */
  let phase = 'idle';
  let inputValue = '';
  /** @type {string | null} */
  let inputError = null;
  /** @type {AbortController | null} */
  let running = null;
  let disposed = false;

  const setPhase = (/** @type {Phase} */ next) => {
    phase = next;
    section.dataset.phase = next;
    orb.setPlacement(placementFor(next));
  };

  const paintPaths = () => {
    const active = document.activeElement;
    const hadFocus = active instanceof HTMLInputElement && active.id === 'mint-input';
    render(deck, pathsTemplate(liveState(), inputValue, inputError));
    if (hadFocus || inputError) {
      const input = /** @type {HTMLInputElement | null} */ (deck.querySelector('#mint-input'));
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    }
  };

  const idle = () => {
    running?.abort();
    running = null;
    orb.reset();
    setPhase('idle');
    document.title = 'Token Finder — evidence-grade Solana token intelligence';
    paintPaths();
  };

  /** @param {string} title @param {string} message @param {string} mint */
  const fail = (title, message, mint) => {
    orb.endAnalysis(null);
    setPhase('error');
    render(deck, errorTemplate(title, message, mint));
    document.title = `${title} — Token Finder`;
    /** @type {HTMLElement | null} */ (deck.querySelector('h2'))?.focus();
  };

  /** Runs a real analysis and follows its stages. @param {string} mint */
  const analyze = async (mint) => {
    running?.abort();
    const controller = new AbortController();
    running = controller;
    /** @type {Stage[]} */
    const stages = [];
    setPhase('scanning');
    orb.beginAnalysis();
    document.title = `Analyzing ${shortAddress(mint)} — Token Finder`;
    render(deck, progressTemplate(mint, stages, false));

    /** @type {any} */
    let done = null;
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
        return fail(FAILURE_TITLE[code], String(body.error ?? 'The server refused the request.'), mint);
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
            if (!disposed && running === controller) render(deck, progressTemplate(mint, stages, false));
          } else if (message.type === 'done') {
            done = message;
          }
        }
      }
    } catch (error) {
      if (controller.signal.aborted || disposed) return;
      return fail(FAILURE_TITLE.network, 'The connection to Token Finder was lost during the analysis.', mint);
    }
    if (disposed || running !== controller) return;
    if (!done) return fail(FAILURE_TITLE.failed, 'The analysis ended without a result.', mint);
    if (!done.ok) return fail(FAILURE_TITLE[done.code] ?? FAILURE_TITLE.failed, done.message, mint);

    // The verdict is persisted; read it back as the Dossier presents it.
    render(deck, progressTemplate(mint, stages, true));
    try {
      const dossier = await api(`/api/tokens/${encodeURIComponent(mint)}`);
      if (disposed || running !== controller) return;
      const d = /** @type {any} */ (dossier);
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
      fail(FAILURE_TITLE.failed, error instanceof ApiError ? error.message : 'The result could not be loaded.', mint);
    } finally {
      if (running === controller) running = null;
    }
  };

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
  deck.addEventListener('input', onInput);
  deck.addEventListener('pointerover', onLean);
  deck.addEventListener('focusin', onLean);
  deck.addEventListener('pointerout', onLeave);
  deck.addEventListener('focusout', onLeave);

  const onNarrow = () => orb.setPlacement(placementFor(phase));
  narrow.addEventListener('change', onNarrow);

  // The Discover path states live counts; keep them current.
  const offLive = onLive(() => {
    if (phase === 'idle' && !(document.activeElement instanceof HTMLInputElement)) paintPaths();
  });

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
      orb.dispose();
      offLive();
      narrow.removeEventListener('change', onNarrow);
      deck.removeEventListener('submit', onSubmit);
      deck.removeEventListener('input', onInput);
      deck.removeEventListener('pointerover', onLean);
      deck.removeEventListener('focusin', onLean);
      deck.removeEventListener('pointerout', onLeave);
      deck.removeEventListener('focusout', onLeave);
    },
  };
}
