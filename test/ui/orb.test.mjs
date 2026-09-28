/**
 * The Observatory, in a real browser with real input.
 *
 * What these tests hold the Orb to:
 *   - every token it shows is a real, live token from /api/orb - never stale,
 *     never unevaluated, never invented;
 *   - it reacts to real state: a scan on the engine's own bus, a focused token,
 *     a server that went away;
 *   - it is operable: a real hover or keyboard focus previews a token, and a
 *     real click, tap or Enter opens its Dossier;
 *   - it is cheap: one loop, which stops when the tab is hidden, never runs
 *     under reduced motion, and does not survive navigating away.
 *
 * No test inspects an animation frame; motion is checked only by whether the
 * loop runs.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { launch } from './browser.mjs';
import { EXECUTED, MINTS, SKIP, startServer } from './harness.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ORB = `document.querySelector('.orb')`;
const markerMints = `[...document.querySelectorAll('.orb-marker:not([aria-hidden])')].map((m) => m.dataset.mint)`;

describe('the Observatory', { skip: SKIP, timeout: 180_000 }, () => {
  let server;
  let browser;
  let api;

  before(async () => {
    server = await startServer();
    browser = await launch();
    api = await (await fetch(`http://127.0.0.1:${server.port}/api/orb`)).json();
  });

  after(async () => {
    await browser?.close();
    server?.stop();
  });

  const openBoard = async (width = 1440, height = 900, mobile = false) => {
    await browser.viewport(width, height, mobile);
    await browser.goto(`${server.origin}/discover`);
    await browser.waitFor(`${ORB} && document.querySelectorAll('.orb-marker').length > 0 && ${ORB}.__orb.frames > 2`);
  };

  test('/api/orb surfaces only live tokens, each with its reason, in a small payload', () => {
    const mints = api.tokens.map((t) => t.mint);
    assert.ok(mints.length > 0 && mints.length <= 8);
    assert.equal(mints.includes(MINTS.stale), false, 'a stale token was surfaced');
    assert.equal(mints.includes(MINTS.legacy), false, 'a never-evaluated token was surfaced');
    const faded = api.tokens.find((t) => t.mint === MINTS.rejected);
    assert.equal(faded?.role, 'changed', 'the real Qualified → Rejected change is surfaced');
    assert.equal(faded.why, 'Verdict changed: Qualified → Rejected');
    assert.equal(api.tokens.find((t) => t.mint === MINTS.watch)?.role, 'watch');
    for (const token of api.tokens) assert.ok(token.why && token.reason && Number.isFinite(token.score), token.mint);
    assert.ok(JSON.stringify(api).length < 6_000);
  });

  test('desktop: the Observatory is the hero on the left, the Board a compact panel on the right', async () => {
    await openBoard();
    assert.equal(await browser.eval(`${ORB}.__orb.composition`), 'sphere');
    assert.equal(await browser.eval(`${ORB}.dataset.state`), 'idle');
    assert.equal(await browser.eval(`${ORB}.__orb.running`), true);
    const shown = await browser.eval(markerMints);
    assert.deepEqual(shown, api.tokens.slice(0, 7).map((t) => t.mint));
    const layout = await browser.eval(`(() => {
      const hero = document.querySelector('.board-hero').getBoundingClientRect();
      const panel = document.querySelector('.board-panel').getBoundingClientRect();
      const rows = document.querySelector('.board-row').getBoundingClientRect();
      return { heroRight: hero.right, heroWidth: hero.width, panelLeft: panel.left, panelWidth: panel.width, firstRow: rows.top };
    })()`);
    assert.ok(layout.heroRight <= layout.panelLeft, 'the Observatory overlaps the Board');
    const share = layout.heroWidth / (layout.heroWidth + layout.panelWidth);
    assert.ok(share > 0.66 && share < 0.74, `the Observatory takes ${(share * 100).toFixed(0)}% of the width`);
    assert.ok(layout.firstRow < 900, 'no Board row is above the fold');
    assert.equal(await browser.eval(`Math.max(document.documentElement.scrollWidth, innerWidth) - 1440`), 0);
    assert.equal(await browser.eval(`(() => { const t = document.querySelector('.table-scroll'); return t.scrollWidth - t.clientWidth; })()`), 0, 'the table overflows its panel');
  });

  test('the compact Board: five columns, the reason kept, freshness stated once', async () => {
    const headers = await browser.eval(`[...document.querySelectorAll('.board thead th')].map((th) => th.textContent.replace(/\\s+/g, ' ').trim())`);
    assert.deepEqual(headers, ['Token · why', 'Rank', 'State', 'Liquidity', 'Age']);
    // Token Finder's verdict reason is still in every row.
    assert.equal(await browser.eval(`[...document.querySelectorAll('.board-row')].every((r) => r.querySelector('.token-link__reason')?.textContent.trim().length > 0)`), true);
    assert.match(await browser.eval(`document.querySelector('.board-head__fresh').textContent`), /Last scan/);
  });

  test('two tokens lead; the rest stay quieter', async () => {
    const primaries = await browser.eval(`[...document.querySelectorAll('.orb-marker--primary')].map((m) => m.dataset.mint)`);
    assert.deepEqual(primaries, api.tokens.slice(0, 2).map((t) => t.mint));
    const caption = await browser.eval(`document.querySelector('.orb-marker--primary .orb-marker__caption').textContent`);
    assert.match(caption, new RegExp(`^${api.tokens[0].score} · `));
  });

  test('hovering a token with a real pointer focuses it and previews real data', async () => {
    const token = api.tokens[0];
    const point = await browser.locate(`.orb-marker[data-mint="${token.mint}"]`);
    assert.ok(point.hitsTarget, `covered by ${point.hit}`);
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await browser.waitFor(`${ORB}.dataset.state === 'focus'`);
    const preview = await browser.eval(`document.querySelector('.orb__readout').textContent.replace(/\\s+/g, ' ')`);
    assert.ok(preview.includes(token.why), preview);
    assert.ok(preview.includes(String(token.score)), preview);
    assert.ok(preview.includes(token.verdictLabel), preview);
    // Moving away returns to idle.
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 400 });
    await browser.waitFor(`${ORB}.dataset.state === 'idle'`);
  });

  test('previewing a token with a long or hostile name never resizes the Observatory', async () => {
    // Regression: the side column's auto track once grew to fit a preview's
    // unbreakable name, widening the stage and moving every marker away from
    // the pointer that was about to click it.
    const stageWidth = `Math.round(document.querySelector('.orb__stage').getBoundingClientRect().width)`;
    const before = await browser.eval(stageWidth);
    for (const mint of [MINTS.xss, MINTS.long].filter((m) => api.tokens.slice(0, 7).some((t) => t.mint === m))) {
      const point = await browser.locate(`.orb-marker[data-mint="${mint}"]`);
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
      await browser.waitFor(`${ORB}.dataset.state === 'focus'`);
      await sleep(150);
      assert.equal(await browser.eval(stageWidth), before, `previewing ${mint} resized the stage`);
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 400 });
      await browser.waitFor(`${ORB}.dataset.state === 'idle'`);
    }
  });

  test('a real click on a token opens its Dossier', async () => {
    const token = api.tokens[1];
    await browser.click(`.orb-marker[data-mint="${token.mint}"]`);
    await browser.waitFor(`location.pathname === '/t/${token.mint}' && document.querySelector('.verdict-panel')`);
  });

  test('keyboard: Tab reaches the tokens, focus previews, Enter opens the Dossier', async () => {
    await openBoard();
    let onMarker = null;
    for (let i = 0; i < 25 && !onMarker; i++) {
      await browser.key('Tab', 'Tab', 9);
      onMarker = await browser.eval(`document.activeElement?.classList.contains('orb-marker') ? document.activeElement.dataset.mint : null`);
    }
    assert.ok(onMarker, 'Tab never reached a token');
    await browser.waitFor(`${ORB}.dataset.state === 'focus'`);
    assert.equal(await browser.eval(`document.activeElement.matches(':focus-visible')`), true);
    const symbol = api.tokens.find((t) => t.mint === onMarker).symbol;
    assert.ok((await browser.eval(`document.querySelector('.orb__readout').textContent`)).includes(symbol));
    await browser.key('Enter', 'Enter', 13);
    await browser.waitFor(`location.pathname === '/t/${onMarker}'`);
  });

  test('a real scan on the engine bus puts the Orb in its scanning state, and completion ends it', async () => {
    await openBoard();
    server.emit('scan-start');
    await browser.waitFor(`${ORB}.dataset.state === 'scanning'`);
    assert.equal(await browser.eval(`document.querySelector('.orb__status-text').textContent`), 'Scanning');
    assert.match(await browser.eval(`document.querySelector('.orb__readout').textContent`), /Scan in progress/);
    server.emit('scan');
    await browser.waitFor(`${ORB}.dataset.state === 'idle'`);
    // Numbers from the scan's own payload, not invented.
    assert.match(await browser.eval(`document.querySelector('.orb__readout').textContent`), /Scan complete · 7 analysed · 0 new/);
  });

  test('a failed scan says so, rather than looking like a quiet success', async () => {
    server.emit('scan-start');
    await browser.waitFor(`${ORB}.dataset.state === 'scanning'`);
    server.emit('scan-failed');
    await browser.waitFor(`${ORB}.dataset.state === 'idle'`);
    assert.match(await browser.eval(`document.querySelector('.orb__readout').textContent`), /last scan failed/);
  });

  test('a missing or broken icon falls back to the monogram, never a broken image', async () => {
    await sleep(1500); // let every icon request settle
    const broken = await browser.eval(`[...document.querySelectorAll('.orb img')].filter((img) => img.complete && img.naturalWidth === 0 && getComputedStyle(img).display !== 'none').length`);
    assert.equal(broken, 0);
    const letters = await browser.eval(`[...document.querySelectorAll('.orb-marker .avatar__letter')].every((l) => l.textContent.trim().length === 1)`);
    assert.equal(letters, true);
  });

  test('hostile token text renders inert in the Orb', async () => {
    assert.deepEqual(await browser.eval(EXECUTED), []);
    const xss = await browser.eval(`document.querySelector('.orb-marker[data-mint="${MINTS.xss}"]')?.textContent ?? null`);
    if (xss !== null) assert.match(xss, /<img src=x onerror=/);
    assert.equal(await browser.eval(`document.querySelectorAll('.orb [onerror], .orb script').length`), 0);
  });

  test('a hidden tab stops the loop; showing it again resumes', async () => {
    await openBoard();
    const setHidden = (hidden) =>
      browser.eval(`(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => ${hidden ? "'hidden'" : "'visible'"} });
        document.dispatchEvent(new Event('visibilitychange'));
      })()`);
    await setHidden(true);
    assert.equal(await browser.eval(`${ORB}.__orb.running`), false);
    const frozen = await browser.eval(`${ORB}.__orb.frames`);
    await sleep(400);
    assert.equal(await browser.eval(`${ORB}.__orb.frames`), frozen, 'frames advanced while hidden');
    await setHidden(false);
    await browser.waitFor(`${ORB}.__orb.running && ${ORB}.__orb.frames > ${frozen}`);
  });

  test('navigating away and back never leaves a second Orb or loop running', async () => {
    await openBoard();
    for (let i = 0; i < 4; i++) {
      await browser.click('.nav__link[data-nav="system"]');
      await browser.waitFor(`location.pathname === '/system' && !document.querySelector('.orb')`);
      assert.equal(await browser.eval(`document.documentElement.dataset.orbInstances`), '0');
      await browser.click('.nav__link[data-nav="discover"]');
      await browser.waitFor(`${ORB} && ${ORB}.__orb.running`);
      assert.equal(await browser.eval(`document.documentElement.dataset.orbInstances`), '1');
    }
    // One loop means one requestAnimationFrame per frame, however many visits.
    const perSecond = await browser.eval(`new Promise((resolve) => {
      let calls = 0;
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => { calls += 1; return raf(cb); };
      setTimeout(() => { window.requestAnimationFrame = raf; resolve(calls); }, 1000);
    })`);
    assert.ok(perSecond <= 75, `${perSecond} animation frames requested per second`);
  });

  test('reduced motion: no loop, the same tokens, still focusable and clickable', async () => {
    await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    try {
      await browser.viewport(1440, 900);
      await browser.goto(`${server.origin}/discover`);
      await browser.waitFor(`${ORB} && document.querySelectorAll('.orb-marker').length > 0 && ${ORB}.__orb.frames > 0`);
      assert.equal(await browser.eval(`${ORB}.dataset.motion`), 'reduced');
      await sleep(300);
      assert.equal(await browser.eval(`${ORB}.__orb.running`), false, 'an animation loop runs under reduced motion');
      const still = await browser.eval(`${ORB}.__orb.frames`);
      await sleep(600);
      assert.equal(await browser.eval(`${ORB}.__orb.frames`), still, 'frames drawn with nothing changing');
      assert.deepEqual(await browser.eval(markerMints), api.tokens.slice(0, 7).map((t) => t.mint));
      // Real state still shows, without motion.
      server.emit('scan-start');
      await browser.waitFor(`${ORB}.dataset.state === 'scanning'`);
      server.emit('scan');
      await browser.waitFor(`${ORB}.dataset.state === 'idle'`);
      const token = api.tokens[0];
      await browser.click(`.orb-marker[data-mint="${token.mint}"]`);
      await browser.waitFor(`location.pathname === '/t/${token.mint}'`);
    } finally {
      await browser.send('Emulation.setEmulatedMedia', { features: [] });
    }
  });

  test('resize: the composition follows the space, and the tokens follow the composition', async () => {
    await openBoard(1440, 900);
    assert.equal(await browser.eval(`${ORB}.__orb.composition`), 'sphere');
    // Tablet: stacked, and still a full sphere.
    await browser.viewport(1000, 800);
    await browser.waitFor(`${ORB}.__orb.composition === 'sphere' && document.querySelector('.board-hero').getBoundingClientRect().width > 900`);
    // Phone width: the horizon band, with three tokens.
    await browser.viewport(420, 800);
    await browser.waitFor(`${ORB}.__orb.composition === 'horizon'`);
    await browser.waitFor(`document.querySelectorAll('.orb-marker:not([aria-hidden])').length === Math.min(3, ${api.tokens.length})`);
    await browser.viewport(1440, 900);
    await browser.waitFor(`${ORB}.__orb.composition === 'sphere' && document.querySelectorAll('.orb-marker:not([aria-hidden])').length === Math.min(7, ${api.tokens.length})`);
  });

  test('mobile: the Observatory leads as a horizon band with three tokens, no overflow, and a real tap opens a Dossier', async () => {
    await openBoard(390, 844, true);
    // Wait for the phone layout to settle rather than sampling the first frame.
    await browser.waitFor(`${ORB}.__orb.composition === 'horizon' && document.querySelectorAll('.orb-marker:not([aria-hidden])').length === Math.min(3, ${api.tokens.length})`);
    assert.deepEqual(await browser.eval(markerMints), api.tokens.slice(0, 3).map((t) => t.mint));
    assert.equal(await browser.eval(`Math.max(document.documentElement.scrollWidth, innerWidth) - 390`), 0);
    const band = await browser.eval(`document.querySelector('.orb__stage').getBoundingClientRect().height`);
    assert.ok(band >= 180 && band <= 240, `the band is ${band}px tall`);
    // Every token marker sits inside the band.
    const outside = await browser.eval(`(() => {
      const stage = document.querySelector('.orb__stage').getBoundingClientRect();
      return [...document.querySelectorAll('.orb-marker .avatar')].filter((a) => {
        const r = a.getBoundingClientRect();
        return r.top < stage.top - 1 || r.bottom > stage.bottom + 1 || r.left < 0 || r.right > innerWidth;
      }).length;
    })()`);
    assert.equal(outside, 0);
    const token = api.tokens[0];
    await browser.tap(`.orb-marker[data-mint="${token.mint}"]`);
    await browser.waitFor(`location.pathname === '/t/${token.mint}'`);
  });

  test('no script errors in the session', () => {
    assert.deepEqual(browser.errors.filter((e) => !/Failed to load resource|net::ERR/.test(e)), []);
  });
});

describe('the Observatory when the server goes away', { skip: SKIP, timeout: 60_000 }, () => {
  test('it stops observing and says so', async () => {
    const server = await startServer();
    const browser = await launch();
    try {
      await browser.viewport(1440, 900);
      await browser.goto(`${server.origin}/discover`);
      await browser.waitFor(`${ORB} && ${ORB}.dataset.state === 'idle' && document.body.dataset.connection === 'live'`);
      server.stop();
      await browser.waitFor(`${ORB}.dataset.state === 'offline'`, 20_000);
      assert.equal(await browser.eval(`document.querySelector('.orb__status-text').textContent`), 'Paused');
      assert.match(await browser.eval(`document.querySelector('.orb__readout').textContent`), /Server unreachable/);
    } finally {
      await browser.close();
      server.stop();
    }
  });
});
