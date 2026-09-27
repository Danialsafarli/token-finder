/**
 * The Landing and its two ways in, in a real browser with real input.
 *
 * Analyze runs the real pipeline end to end, and Scan live runs the monitor's
 * real scan end to end: the fixture substitutes only the providers' HTTP
 * answers (for designated test mints, and a discovery feed that surfaces one
 * of them). Nothing here checks animation frames; motion is checked by state,
 * placement and whether loops run.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { launch } from './browser.mjs';
import { MINTS, SKIP, rawRequest, startServer } from './harness.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PHASE = `document.querySelector('.landing')?.dataset.phase`;
const ORB = `document.querySelector('.landing .orb')`;
/** The sphere's radius on the previous landing, at 1440×900: 0.84 × min(788 × 0.345, 1440 × 0.27). */
const PREVIOUS_RADIUS = 0.84 * Math.min(788 * 0.345, 1440 * 0.27);

describe('the Landing', { skip: SKIP, timeout: 300_000 }, () => {
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

  test('reads top to bottom: headline, a large Observatory, then the two ways in', async () => {
    await openLanding();
    assert.match(await browser.eval(`document.querySelector('h1').textContent`), /Find the signal/);
    const layout = await browser.eval(`(() => {
      const lede = document.querySelector('.landing__lede').getBoundingClientRect();
      const stage = document.querySelector('.landing__orb').getBoundingClientRect();
      const paths = document.querySelector('.paths').getBoundingClientRect();
      const sphere = document.querySelector('.landing .orb').__orb;
      return { ledeBottom: lede.bottom, stageTop: stage.top, stageBottom: stage.bottom, pathsTop: paths.top };
    })()`);
    assert.ok(layout.stageTop - layout.ledeBottom >= 40, `only ${layout.stageTop - layout.ledeBottom}px between the words and the Observatory`);
    assert.ok(layout.pathsTop >= layout.stageBottom, 'the ways in overlap the Observatory');
    // Roughly 30% larger than before - the page scrolls rather than shrinking it.
    const radius = await browser.eval(`(() => { const s = document.querySelector('.landing .orb .orb__stage').getBoundingClientRect(); const p = document.querySelector('.landing .orb').__orb.placement; return Math.min(s.height * 0.345, s.width * 0.27) * p.size; })()`);
    assert.ok(radius >= PREVIOUS_RADIUS * 1.2, `radius ${radius} is not ~30% larger than ${PREVIOUS_RADIUS}`);
    assert.ok((await browser.eval(`document.documentElement.scrollHeight`)) > 900, 'the landing should scroll');
    assert.equal(await browser.eval(`document.querySelector('label[for="mint-input"]').textContent`), 'Solana mint address');
    assert.equal(await browser.eval(`${ORB}.dataset.state`), 'idle');
    assert.equal(await browser.eval(`document.querySelectorAll('.landing .orb-marker').length`), 0);
    assert.equal(await browser.eval(`Math.max(document.documentElement.scrollWidth, innerWidth) - 1440`), 0);
  });

  test('leaning toward a way in is reflected by the Observatory, with real tokens only', async () => {
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

  test('Analyze: the real pipeline, stage by stage, then the result beside a left-anchored Observatory', async () => {
    await openLanding();
    await browser.click('#mint-input');
    await browser.type(MINTS.analyze);
    await browser.key('Enter', 'Enter', 13);
    await browser.waitFor(`${PHASE} === 'scanning' && location.pathname === '/analyze/${MINTS.analyze}'`);
    assert.equal(await browser.eval(`${ORB}.dataset.state`), 'analyzing');
    assert.equal(await browser.eval(`document.querySelector('.result')`), null);
    assert.doesNotMatch(await browser.eval(`document.querySelector('.progress').textContent`), /\d+\s*%/);
    await browser.waitFor(`[...document.querySelectorAll('.stage__label')].some((s) => s.textContent === 'Checking safety reports')`, 10_000);
    const stages = await browser.eval(`[...document.querySelectorAll('.stage__label')].map((s) => s.textContent)`);
    assert.deepEqual(stages.slice(0, 3), ['Validating the mint address', 'Fetching market data', 'Checking safety reports']);
    await browser.waitFor(`${PHASE} === 'result'`, 20_000);
    const result = await browser.eval(`document.querySelector('.result').textContent.replace(/\\s+/g, ' ')`);
    assert.match(result, /CLARITY/);
    assert.match(result, /Qualified/);
    assert.match(result, /Score\s*\d+/);
    assert.match(result, /Not measured/);
    assert.equal(await browser.eval(`${ORB}.__orb.subject`), MINTS.analyze);
    // Anchored left, with clear space before the result.
    await browser.waitFor(`${ORB}.__orb.placement.fx < 0.31`, 4_000);
    const gap = await browser.eval(`(() => { const s = document.querySelector('.landing .orb .orb__stage').getBoundingClientRect(); const o = document.querySelector('.landing .orb').__orb; const r = Math.min(s.height * 0.345, s.width * 0.27) * o.placement.size; return document.querySelector('.result').getBoundingClientRect().left - (s.left + s.width * o.placement.fx + r); })()`);
    assert.ok(gap >= 60, `only ${Math.round(gap)}px between the sphere and the result`);
    assert.equal(await browser.eval(`Math.max(document.documentElement.scrollWidth, innerWidth) - 1440`), 0);
  });

  test('the result opens the canonical Dossier, which is also valid on its own', async () => {
    await browser.click('.result a[href^="/t/"]');
    await browser.waitFor(`location.pathname === '/t/${MINTS.analyze}' && document.querySelector('.verdict-panel')`);
    await browser.goto(`${server.origin}/t/${MINTS.analyze}`);
    await browser.waitFor(`document.querySelector('.verdict-panel')`);
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
    const res = await rawRequest(server.port, { path: `/api/tokens/${MINTS.noMarket}`, headers: { host: `localhost:${server.port}` } });
    assert.equal(res.status, 404);
  });

  test('Scan live: a real scan runs on the Landing, then the same Observatory becomes Live discovery', async () => {
    await openLanding();
    await browser.eval(`document.querySelector('.landing .orb').__handoffTag = 'the-same-observatory'`);
    await browser.click('[data-action="discover"]');
    await browser.waitFor(`${PHASE} === 'discovering'`);
    assert.equal(await browser.eval(`${ORB}.dataset.state`), 'analyzing');
    // Real stages from the monitor, in order, with real counts.
    await browser.waitFor(`[...document.querySelectorAll('.stage__label')].some((s) => /^Found \\d+ candidate tokens$/.test(s.textContent))`, 15_000);
    const stages = await browser.eval(`[...document.querySelectorAll('.stage__label')].map((s) => s.textContent)`);
    assert.equal(stages[0], 'Reading the discovery feeds');
    assert.doesNotMatch(await browser.eval(`document.querySelector('.progress').textContent`), /\d+\s*%/);
    // Completion hands the Observatory itself to /discover, and the Board assembles beside it.
    await browser.waitFor(`location.pathname === '/discover'`, 30_000);
    assert.equal(await browser.eval(`document.querySelector('.board-hero .orb')?.__handoffTag`), 'the-same-observatory');
    assert.equal(await browser.eval(`!!document.querySelector('.board-layout.is-arriving')`), true);
    assert.equal(await browser.eval(`document.documentElement.dataset.orbInstances`), '1');
    await browser.waitFor(`document.querySelectorAll('.board-row').length > 0 && document.querySelector('.board-hero .orb').dataset.state === 'idle'`);
    // The token the scan really found is now live.
    await browser.waitFor(`[...document.querySelectorAll('.board-row')].some((r) => r.dataset.mint === '${MINTS.discover}')`, 5_000);
    await browser.waitFor(`document.querySelector('.board-hero .orb').__orb.placement.fx < 0.46`, 4_000);
  });

  test('Scan live follows a scan that is already running instead of starting another', async () => {
    await openLanding();
    server.emit('scan-start');
    await browser.waitFor(`document.getElementById('live-text').textContent.startsWith('Scanning')`);
    await browser.click('[data-action="discover"]');
    await browser.waitFor(`${PHASE} === 'discovering' && /already running/.test(document.querySelector('.progress').textContent)`);
    server.emit('scan');
    await browser.waitFor(`location.pathname === '/discover' && document.querySelector('.board-hero .orb')`, 10_000);
  });

  test('a failed scan is stated, not dressed up as a result', async () => {
    await openLanding();
    server.emit('scan-start');
    await browser.waitFor(`document.getElementById('live-text').textContent.startsWith('Scanning')`);
    await browser.click('[data-action="discover"]');
    await browser.waitFor(`${PHASE} === 'discovering'`);
    server.emit('scan-failed');
    await browser.waitFor(`${PHASE} === 'error'`);
    assert.match(await browser.eval(`document.querySelector('.result--error').textContent`), /The scan failed/);
    assert.equal(await browser.eval(`location.pathname`), '/');
  });

  test('Cancel during an analysis returns to the Landing', async () => {
    await browser.goto(`${server.origin}/analyze/${MINTS.analyze}`);
    await browser.waitFor(`${PHASE} === 'scanning' && document.querySelector('.progress__cancel')`);
    await browser.click('.progress__cancel');
    await browser.waitFor(`${PHASE} === 'idle' && location.pathname === '/'`);
  });

  test('keyboard: Tab reaches the input, the scan button and the plain Live Board link', async () => {
    await openLanding();
    const reached = new Set();
    for (let i = 0; i < 24 && reached.size < 3; i++) {
      await browser.key('Tab', 'Tab', 9);
      const where = await browser.eval(`(() => { const a = document.activeElement; if (!a) return ''; if (a.id === 'mint-input') return 'input'; if (a.dataset?.action === 'discover') return 'scan'; if (a.getAttribute?.('href') === '/discover' && a.closest('.path--discover')) return 'board'; return ''; })()`);
      if (where) {
        reached.add(where);
        assert.equal(await browser.eval(`document.activeElement.matches(':focus-visible')`), true);
      }
    }
    assert.deepEqual([...reached].sort(), ['board', 'input', 'scan']);
    await browser.key('Enter', 'Enter', 13);
    await browser.waitFor(`location.pathname === '/discover' && document.querySelectorAll('.board-row').length > 0`);
  });

  test('Live discovery keeps the operational Board: search and Dossier', async () => {
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

  test('mobile: the same order, stacked; a real tap to analyze; no overflow', async () => {
    await openLanding(390, 844, true);
    const order = await browser.eval(`(() => ['.landing__intro', '.landing__orb', '.paths'].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().top)))()`);
    assert.ok(order[0] < order[1] && order[1] < order[2], JSON.stringify(order));
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

  test('tablet: the ways in and the result fit without overflow or overlap', async () => {
    await openLanding(1024, 768);
    assert.equal(await browser.eval(`Math.max(document.documentElement.scrollWidth, innerWidth) - 1024`), 0);
    await browser.goto(`${server.origin}/analyze/${MINTS.analyze}`);
    await browser.waitFor(`${PHASE} === 'result'`, 20_000);
    await sleep(1500);
    assert.equal(await browser.eval(`Math.max(document.documentElement.scrollWidth, innerWidth) - 1024`), 0);
    const overlap = await browser.eval(`(() => {
      const card = document.querySelector('.result').getBoundingClientRect();
      const marker = document.querySelector('.landing .orb-marker').getBoundingClientRect();
      return marker.right > card.left && marker.bottom > card.top && marker.top < card.bottom;
    })()`);
    assert.equal(overlap, false, 'the analysed token sits under the result card');
  });

  test('reduced motion: no loop, no cinematic movement, and both flows still work', async () => {
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
      assert.ok((await browser.eval(`${ORB}.__orb.placement.fx`)) < 0.31);
      assert.equal(await browser.eval(`${ORB}.__orb.running`), false);
      await browser.goto(`${server.origin}/`);
      await browser.waitFor(`${PHASE} === 'idle'`);
      await browser.click('[data-action="discover"]');
      await browser.waitFor(`location.pathname === '/discover' && document.querySelectorAll('.board-row').length > 0`, 30_000);
      assert.equal(await browser.eval(`document.querySelector('.board-hero .orb').__orb.running`), false);
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
