/**
 * The Landing and its two paths, in a real browser with real input.
 *
 * Analyze runs the real pipeline end to end - validation, evidence
 * resolution, the safety gate, scoring, persistence - with only the providers'
 * HTTP answers substituted by the fixture, and only for two test mints.
 * Nothing here checks animation frames; motion is checked by whether loops run.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { launch } from './browser.mjs';
import { MINTS, SKIP, rawRequest, startServer } from './harness.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PHASE = `document.querySelector('.landing')?.dataset.phase`;
const ORB = `document.querySelector('.landing .orb')`;

describe('the Landing', { skip: SKIP, timeout: 240_000 }, () => {
  let server;
  let browser;

  before(async () => {
    server = await startServer();
    browser = await launch();
  });

  after(async () => {
    await browser?.close();
    server?.stop();
  });

  const openLanding = async (width = 1440, height = 900, mobile = false) => {
    await browser.viewport(width, height, mobile);
    await browser.goto(`${server.origin}/`);
    await browser.waitFor(`${PHASE} === 'idle' && document.querySelector('#mint-input') && ${ORB}.__orb.frames > 2`);
  };

  test('says what Token Finder is, and offers both paths, above the fold', async () => {
    await openLanding();
    assert.match(await browser.eval(`document.querySelector('h1').textContent`), /Know what a token is/);
    const paths = await browser.eval(`(() => {
      const analyze = document.querySelector('.path--analyze').getBoundingClientRect();
      const discover = document.querySelector('.path--discover').getBoundingClientRect();
      return { analyze: analyze.bottom, discover: discover.bottom, label: document.querySelector('label[for="mint-input"]').textContent };
    })()`);
    assert.ok(paths.analyze <= 900 && paths.discover <= 900, JSON.stringify(paths));
    assert.equal(paths.label, 'Solana mint address');
    assert.equal(await browser.eval(`document.querySelector('.path--discover').getAttribute('href')`), '/discover');
    // Calm: the landing does not reflect the monitor's scans, and shows no tokens until asked.
    assert.equal(await browser.eval(`${ORB}.dataset.state`), 'idle');
    assert.equal(await browser.eval(`document.querySelectorAll('.landing .orb-marker').length`), 0);
    assert.equal(await browser.eval(`Math.max(document.documentElement.scrollWidth, innerWidth) - 1440`), 0);
  });

  test('leaning toward a path is reflected by the Observatory, with real tokens only', async () => {
    const api = await (await fetch(`http://127.0.0.1:${server.port}/api/orb`)).json();
    const point = await browser.locate('.path--discover');
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await browser.waitFor(`${ORB}.dataset.intent === 'discover' && document.querySelectorAll('.landing .orb-marker').length > 0`);
    const shown = await browser.eval(`[...document.querySelectorAll('.landing .orb-marker')].map((m) => m.dataset.mint)`);
    const live = new Set(api.tokens.map((t) => t.mint));
    assert.ok(shown.every((mint) => live.has(mint)), 'a token not in the live selection was shown');
    await browser.click('#mint-input');
    await browser.waitFor(`${ORB}.dataset.intent === 'analyze' && ${ORB}.__orb.attention === true`);
  });

  test('an invalid address is refused in place, and nothing is requested', async () => {
    await openLanding();
    await browser.click('#mint-input');
    await browser.type('0xNotASolanaAddress');
    await browser.key('Enter', 'Enter', 13);
    await browser.waitFor(`document.querySelector('#mint-error')`);
    assert.match(await browser.eval(`document.querySelector('#mint-error').textContent`), /never contain 0, O, I or lowercase l/);
    assert.equal(await browser.eval(`document.querySelector('#mint-input').getAttribute('aria-invalid')`), 'true');
    assert.equal(await browser.eval(`location.pathname`), '/');
    assert.equal(await browser.eval(PHASE), 'idle');
  });

  test('Analyze: a real mint runs the real pipeline, stage by stage, to a result', async () => {
    await openLanding();
    await browser.click('#mint-input');
    await browser.type(MINTS.analyze);
    await browser.key('Enter', 'Enter', 13);
    await browser.waitFor(`${PHASE} === 'scanning' && location.pathname === '/analyze/${MINTS.analyze}'`);
    assert.equal(await browser.eval(`${ORB}.dataset.state`), 'analyzing');
    // While the providers answer, there is no result - and no percentage anywhere.
    assert.equal(await browser.eval(`document.querySelector('.result')`), null);
    assert.doesNotMatch(await browser.eval(`document.querySelector('.progress').textContent`), /\d+\s*%/);
    // Stages appear as the pipeline reaches them, in its order.
    await browser.waitFor(`[...document.querySelectorAll('.stage__label')].some((s) => s.textContent === 'Checking safety reports')`, 10_000);
    const stages = await browser.eval(`[...document.querySelectorAll('.stage__label')].map((s) => s.textContent)`);
    assert.deepEqual(stages.slice(0, 3), ['Validating the mint address', 'Fetching market data', 'Checking safety reports']);
    await browser.waitFor(`${PHASE} === 'result'`, 20_000);
    const result = await browser.eval(`document.querySelector('.result').textContent.replace(/\\s+/g, ' ')`);
    assert.match(result, /CLARITY/);
    assert.match(result, /Qualified/);
    assert.match(result, /Score\s*\d+/);
    assert.match(result, /Not measured/);
    // The analysed token is the Observatory's focus, and the only token shown.
    assert.equal(await browser.eval(`${ORB}.__orb.subject`), MINTS.analyze);
    assert.deepEqual(await browser.eval(`[...document.querySelectorAll('.landing .orb-marker')].map((m) => m.dataset.mint)`), [MINTS.analyze]);
    // The sphere moves aside for the result (eased, so give it a moment).
    await browser.waitFor(`${ORB}.__orb.placement.fx < 0.4`, 4_000);
    assert.equal(await browser.eval(`Math.max(document.documentElement.scrollWidth, innerWidth) - 1440`), 0);
  });

  test('the result opens the canonical Dossier, which is also valid on its own', async () => {
    await browser.click('.result a[href^="/t/"]');
    await browser.waitFor(`location.pathname === '/t/${MINTS.analyze}' && document.querySelector('.verdict-panel')`);
    await browser.goto(`${server.origin}/t/${MINTS.analyze}`);
    await browser.waitFor(`document.querySelector('.verdict-panel')`);
    assert.match(await browser.eval(`document.querySelector('.identity__symbol')?.textContent ?? document.body.textContent`), /CLARITY/);
  });

  test('a direct /analyze/:mint link runs the analysis itself', async () => {
    await browser.viewport(1440, 900);
    await browser.goto(`${server.origin}/analyze/${MINTS.analyze}`);
    await browser.waitFor(`${PHASE} === 'result'`, 20_000);
    assert.match(await browser.eval(`document.querySelector('.result').textContent`), /CLARITY/);
  });

  test('a mint with no market says so, and records nothing', async () => {
    await openLanding();
    await browser.click('#mint-input');
    await browser.type(MINTS.noMarket);
    await browser.key('Enter', 'Enter', 13);
    await browser.waitFor(`${PHASE} === 'error'`, 20_000);
    assert.match(await browser.eval(`document.querySelector('.result--error').textContent`), /No market data for this address/);
    assert.equal(await browser.eval(`${ORB}.__orb.subject`), null);
    const res = await rawRequest(server.port, { path: `/api/tokens/${MINTS.noMarket}`, headers: { host: `localhost:${server.port}` } });
    assert.equal(res.status, 404);
  });

  test('Cancel during a scan returns to the Landing', async () => {
    await browser.goto(`${server.origin}/analyze/${MINTS.analyze}`);
    await browser.waitFor(`${PHASE} === 'scanning' && document.querySelector('.progress__cancel')`);
    await browser.click('.progress__cancel');
    await browser.waitFor(`${PHASE} === 'idle' && location.pathname === '/'`);
    assert.equal(await browser.eval(`${ORB}.dataset.state`), 'idle');
  });

  test('keyboard: Tab reaches the input and Discover; Enter on Discover opens Live discovery', async () => {
    await openLanding();
    let reached = { input: false, discover: false };
    for (let i = 0; i < 20 && !(reached.input && reached.discover); i++) {
      await browser.key('Tab', 'Tab', 9);
      const where = await browser.eval(`document.activeElement?.id || document.activeElement?.className || ''`);
      if (where === 'mint-input') reached.input = true;
      if (String(where).includes('path--discover')) {
        reached.discover = true;
        assert.equal(await browser.eval(`document.activeElement.matches(':focus-visible')`), true);
        break;
      }
    }
    assert.deepEqual(reached, { input: true, discover: true });
    await browser.key('Enter', 'Enter', 13);
    await browser.waitFor(`location.pathname === '/discover' && document.querySelectorAll('.board-row').length > 0 && document.querySelector('.board-hero .orb')`);
  });

  test('Discover keeps the operational Board: search, segments, Dossier', async () => {
    await browser.click('#board-search');
    await browser.type('solid');
    await browser.waitFor(`document.querySelectorAll('.board-row').length === 1`);
    await browser.click('.board-row .col-num');
    await browser.waitFor(`location.pathname === '/t/${MINTS.qualified}'`);
  });

  test('navigation: Home and Discover alternate without leaking an Observatory', async () => {
    await browser.goto(`${server.origin}/`);
    for (let i = 0; i < 3; i++) {
      await browser.click('.nav__link[data-nav="discover"]');
      await browser.waitFor(`location.pathname === '/discover' && document.querySelector('.board-hero .orb')`);
      assert.equal(await browser.eval(`document.documentElement.dataset.orbInstances`), '1');
      await browser.click('.brand');
      await browser.waitFor(`location.pathname === '/' && document.querySelector('.landing .orb')`);
      assert.equal(await browser.eval(`document.documentElement.dataset.orbInstances`), '1');
    }
  });

  test('mobile: both paths on the first screen, a real tap to analyze, no overflow', async () => {
    await openLanding(390, 844, true);
    const bottom = await browser.eval(`document.querySelector('.path--discover').getBoundingClientRect().bottom`);
    assert.ok(bottom <= 844, `Discover ends at ${bottom}px`);
    assert.equal(await browser.eval(`Math.max(document.documentElement.scrollWidth, innerWidth) - 390`), 0);
    assert.equal(await browser.eval(`${ORB}.__orb.composition`), 'sphere');
    await browser.tap('#mint-input');
    await browser.type(MINTS.analyze);
    await browser.tap('.mint-field .btn--primary');
    await browser.waitFor(`${PHASE} === 'result'`, 20_000);
    assert.equal(await browser.eval(`Math.max(document.documentElement.scrollWidth, innerWidth) - 390`), 0);
    await browser.tap('.result a[href^="/t/"]');
    await browser.waitFor(`location.pathname === '/t/${MINTS.analyze}'`);
  });

  test('tablet: the paths and the result fit without overflow', async () => {
    await openLanding(1024, 768);
    assert.equal(await browser.eval(`Math.max(document.documentElement.scrollWidth, innerWidth) - 1024`), 0);
    await browser.goto(`${server.origin}/analyze/${MINTS.analyze}`);
    await browser.waitFor(`${PHASE} === 'result'`, 20_000);
    assert.equal(await browser.eval(`Math.max(document.documentElement.scrollWidth, innerWidth) - 1024`), 0);
    const overlap = await browser.eval(`(() => {
      const card = document.querySelector('.result').getBoundingClientRect();
      const marker = document.querySelector('.landing .orb-marker').getBoundingClientRect();
      return marker.right > card.left && marker.bottom > card.top && marker.top < card.bottom;
    })()`);
    assert.equal(overlap, false, 'the analysed token sits under the result card');
  });

  test('reduced motion: no loop, and the whole flow still works', async () => {
    await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    try {
      await browser.viewport(1440, 900);
      await browser.goto(`${server.origin}/`);
      await browser.waitFor(`${PHASE} === 'idle' && ${ORB}.__orb.frames > 0`);
      await sleep(300);
      assert.equal(await browser.eval(`${ORB}.__orb.running`), false);
      await browser.click('#mint-input');
      await browser.type(MINTS.analyze);
      await browser.key('Enter', 'Enter', 13);
      await browser.waitFor(`${PHASE} === 'result'`, 20_000);
      // Placed at once, not animated.
      assert.ok((await browser.eval(`${ORB}.__orb.placement.fx`)) < 0.36);
      assert.equal(await browser.eval(`${ORB}.__orb.running`), false);
    } finally {
      await browser.send('Emulation.setEmulatedMedia', { features: [] });
    }
  });

  test('no script errors in the session', () => {
    assert.deepEqual(browser.errors.filter((e) => !/Failed to load resource|net::ERR/.test(e)), []);
  });
});

describe('POST /api/analyze boundary', { skip: SKIP, timeout: 60_000 }, () => {
  let server;
  before(async () => (server = await startServer()));
  after(() => server?.stop());

  const post = (headers, body) =>
    new Promise((resolve, reject) => {
      import('node:http').then(({ request }) => {
        const req = request({ host: '127.0.0.1', port: server.port, method: 'POST', path: '/api/analyze', headers }, (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode, text }));
        });
        req.on('error', reject);
        req.end(body);
      });
    });
  const host = () => `localhost:${server.port}`;
  const good = () => ({ host: host(), origin: `http://${host()}`, 'content-type': 'application/json' });

  test('cross-site and Origin-less requests are refused', async () => {
    assert.equal((await post({ ...good(), origin: 'https://evil.example' }, JSON.stringify({ mint: MINTS.analyze }))).status, 403);
    const { origin, ...noOrigin } = good();
    void origin;
    assert.equal((await post(noOrigin, JSON.stringify({ mint: MINTS.analyze }))).status, 403);
  });

  test('anything but a JSON body with a real mint address is refused', async () => {
    assert.equal((await post({ ...good(), 'content-type': 'text/plain' }, MINTS.analyze)).status, 415);
    assert.equal((await post(good(), JSON.stringify({ mint: 'not a mint' }))).status, 400);
    assert.equal((await post(good(), JSON.stringify({ mint: '<script>alert(1)</script>' }))).status, 400);
    assert.equal((await post(good(), 'x'.repeat(5000))).status, 400);
  });

  test('a real analysis streams its stages, then its outcome', async () => {
    const res = await post(good(), JSON.stringify({ mint: MINTS.analyze }));
    assert.equal(res.status, 200);
    const lines = res.text.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.filter((l) => l.type === 'stage').map((l) => l.id), ['validate', 'market', 'safety', 'evidence', 'gate', 'verdict']);
    assert.deepEqual(lines.at(-1), { ...lines.at(-1), type: 'done', ok: true, mint: MINTS.analyze });
  });
});
