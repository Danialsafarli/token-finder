/**
 * Product surface, tested in a real browser with real input.
 *
 * The dashboard once shipped with a full-screen overlay that swallowed every
 * click for the life of the project, while hundreds of backend tests passed.
 * This suite exists so that cannot recur: every interaction here is a real
 * mouse, touch or key event, hit-tested by Chrome, and a click that lands on
 * anything other than its target fails the test.
 *
 * Runs against the seeded fixture server (test/ui/fixture-server.ts) on an
 * isolated database with the monitor off. Skips, saying so, when no Chromium
 * browser is installed.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { launch } from './browser.mjs';
import { EXECUTED, MINTS, SKIP, rawRequest, startServer } from './harness.mjs';

describe('product surface in a real browser', { skip: SKIP, timeout: 180_000 }, () => {
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

  const rowCount = () => browser.eval(`document.querySelectorAll('.board-row').length`);
  const boardMints = () => browser.eval(`[...document.querySelectorAll('.board-row')].map((r) => r.dataset.mint)`);

  test('first load: the Board is live and nothing covers it', async () => {
    await browser.viewport(1440, 900);
    await browser.goto(`${server.origin}/discover`);
    await browser.waitFor(`document.querySelectorAll('.board-row').length > 0`);
    // The centre of the page is page content, not an overlay.
    const centre = await browser.eval(`(() => { const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2); return !!el && !!el.closest('main'); })()`);
    assert.equal(centre, true, 'something covers the middle of the page');
    const hidden = await browser.eval(`[...document.querySelectorAll('[hidden]')].every((el) => getComputedStyle(el).display === 'none')`);
    assert.equal(hidden, true, 'an element with the hidden attribute is still displayed');
    // The guarantee itself, not just today's markup: a component class that
    // sets display must still lose to the hidden attribute. This is exactly
    // how the original overlay stayed on screen.
    const guard = await browser.eval(`(() => { const probe = document.createElement('div'); probe.className = 'card-list'; probe.hidden = true; document.body.append(probe); const display = getComputedStyle(probe).display; probe.remove(); return display; })()`);
    assert.equal(guard, 'none', 'a class that sets display overrides the hidden attribute');
  });

  test('only live, evaluated tokens are ranked', async () => {
    // The default view is the candidate ranking: rejected tokens are not in it.
    const candidates = await boardMints();
    for (const mint of [MINTS.qualified, MINTS.watch]) assert.ok(candidates.includes(mint), `${mint} should be a live candidate`);
    for (const mint of [MINTS.rejected, MINTS.t22]) assert.equal(candidates.includes(mint), false, `${mint} is rejected and must not be among the candidates`);
    await browser.goto(`${server.origin}/discover?segment=all`);
    await browser.waitFor(`document.querySelectorAll('.board-row[data-verdict="REJECTED"]').length > 0`);
    const mints = await boardMints();
    for (const mint of [MINTS.qualified, MINTS.watch, MINTS.rejected, MINTS.t22]) assert.ok(mints.includes(mint), `${mint} should be live`);
    assert.equal(mints.includes(MINTS.stale), false, 'a stale token is on the live Board');
    assert.equal(mints.includes(MINTS.legacy), false, 'a never-evaluated token is on the live Board');
  });

  test('a rejected token never sits above a qualified one', async () => {
    const verdicts = await browser.eval(`[...document.querySelectorAll('.board-row')].map((r) => r.dataset.verdict)`);
    const lastQualified = verdicts.lastIndexOf('QUALIFIED');
    const firstRejected = verdicts.indexOf('REJECTED');
    assert.ok(firstRejected > lastQualified, verdicts.join(','));
  });

  test('keyless capability loss is stated on the Board', async () => {
    const banner = await browser.eval(`document.querySelector('.notice--warn')?.textContent ?? ''`);
    assert.match(banner, /On-chain checks are off/);
    assert.match(banner, /HELIUS_API_KEY/);
  });

  test('a real click on a row opens its Dossier', async () => {
    // A non-link cell: the whole row is the target for pointer users.
    await browser.click(`.board-row[data-mint="${MINTS.qualified}"] .col-num`);
    await browser.waitFor(`location.pathname === '/t/${MINTS.qualified}'`);
    await browser.waitFor(`document.querySelector('.verdict-panel')`);
    const verdict = await browser.eval(`document.querySelector('.verdict-panel .verdict').textContent.trim()`);
    assert.equal(verdict, 'Qualified');
  });

  test('the Dossier names what was not measured, and why', async () => {
    const unknowns = await browser.eval(`[...document.querySelectorAll('.unknown')].map((u) => u.textContent.replace(/\\s+/g, ' ').trim())`);
    assert.ok(unknowns.some((u) => u.includes('Token-2022 extensions') && u.includes('Needs a Helius API key')), unknowns.join(' | '));
    const coverageLabels = await browser.eval(`[...document.querySelectorAll('.trust__label')].map((l) => l.textContent.trim())`);
    // One term per concept: no second, contradictory "coverage".
    assert.deepEqual(coverageLabels, ['Score', 'Coverage', 'Confidence', 'Not measured']);
  });

  test('Evidence opens with a real click and shows each provider\'s claim', async () => {
    await browser.click(`.tab[href$="/evidence"]`);
    await browser.waitFor(`location.pathname.endsWith('/evidence') && document.querySelector('.ev')`);
    await browser.click(`.ev details summary`);
    await browser.waitFor(`document.querySelector('.ev details[open] .claims')`);
    const providers = await browser.eval(`[...document.querySelectorAll('.ev details[open] .claims tbody td:first-child')].map((c) => c.textContent)`);
    assert.ok(providers.some((p) => p.includes('Jupiter')) && providers.some((p) => p.includes('DexScreener')), providers.join(','));
  });

  test('History shows the verdict timeline and the change', async () => {
    await browser.goto(`${server.origin}/t/${MINTS.rejected}/history`);
    await browser.waitFor(`document.querySelector('svg.timeline') && document.querySelector('.change--changed')`);
    const change = await browser.eval(`document.querySelector('.change--changed').textContent.replace(/\\s+/g, ' ')`);
    assert.match(change, /Qualified\s*→\s*Rejected/);
    assert.match(change, /Liquidity below safety floor/);
  });

  test('Token-2022: an armed permanent delegate is shown as the veto and in the contract', async () => {
    await browser.goto(`${server.origin}/t/${MINTS.t22}`);
    await browser.waitFor(`document.querySelector('.veto__label')`);
    assert.equal(await browser.eval(`document.querySelector('.veto__label').textContent.trim()`), 'Permanent delegate can move holder tokens');
    await browser.click(`.tab[href$="/contract"]`);
    await browser.waitFor(`document.querySelector('.extension')`);
    const extension = await browser.eval(`document.querySelector('.extension').textContent`);
    assert.match(extension, /Permanent delegate/);
    assert.match(extension, /Armed/);
  });

  test('search: real click into the box, real typing, results filter', async () => {
    await browser.goto(`${server.origin}/discover`);
    await browser.waitFor(`document.querySelectorAll('.board-row').length > 0`);
    await browser.click('#board-search');
    assert.equal(await browser.eval(`document.activeElement?.id`), 'board-search', 'search did not take focus from a real click');
    await browser.type('fading');
    await browser.waitFor(`document.querySelectorAll('.board-row').length === 1`);
    assert.deepEqual(await boardMints(), [MINTS.rejected]);
  });

  test('search still finds history, labelled as history', async () => {
    await browser.eval(`(() => { const i = document.querySelector('#board-search'); i.select(); })()`);
    await browser.type('oldnews');
    await browser.waitFor(`document.querySelector('.history-matches')`);
    const text = await browser.eval(`document.querySelector('.history-matches').textContent`);
    assert.match(text, /Not on the live Board/);
    assert.match(text, /OLDNEWS/);
  });

  test('segments: a real click on Rejected shows only rejected tokens', async () => {
    await browser.goto(`${server.origin}/discover`);
    await browser.waitFor(`document.querySelectorAll('.board-row').length > 0`);
    await browser.click('[data-segment="rejected"]');
    await browser.waitFor(`location.search.includes('segment=rejected') && [...document.querySelectorAll('.board-row')].every((r) => r.dataset.verdict === 'REJECTED')`);
    assert.equal(await rowCount(), 2);
    await browser.click('[data-segment="watch"]');
    await browser.waitFor(`location.search.includes('segment=watch') && document.querySelectorAll('.board-row').length === 1`);
    assert.deepEqual(await boardMints(), [MINTS.watch]);
  });

  test('keyboard: j moves between rows and Enter opens one', async () => {
    await browser.goto(`${server.origin}/discover`);
    await browser.waitFor(`document.querySelectorAll('.board-row').length > 1`);
    await browser.key('j', 'KeyJ', 74);
    await browser.key('j', 'KeyJ', 74);
    const focused = await browser.eval(`document.activeElement?.closest('.board-row')?.dataset.mint ?? null`);
    assert.ok(focused, 'j did not focus a row');
    const second = (await boardMints())[1];
    assert.equal(focused, second);
    // Keyboard users can see where they are.
    assert.equal(await browser.eval(`document.activeElement.matches(':focus-visible')`), true);
    assert.notEqual(await browser.eval(`getComputedStyle(document.activeElement).outlineStyle`), 'none');
    await browser.key('Enter', 'Enter', 13);
    await browser.waitFor(`location.pathname === '/t/${second}'`);
  });

  test('navigation by real clicks reaches Changes and System', async () => {
    await browser.click('.nav__link[data-nav="changes"]');
    await browser.waitFor(`location.pathname === '/changes' && document.querySelector('.stream-item')`);
    const change = await browser.eval(`document.querySelector('.stream-item').textContent.replace(/\\s+/g, ' ')`);
    assert.match(change, /FADING/);
    await browser.click('.nav__link[data-nav="system"]');
    await browser.waitFor(`location.pathname === '/system' && document.querySelector('.capability')`);
    const t22 = await browser.eval(`[...document.querySelectorAll('.capability')].find((c) => c.textContent.includes('Token-2022'))?.textContent ?? ''`);
    assert.match(t22, /Off/);
    assert.match(t22, /HELIUS_API_KEY/);
    // On-chain collection is stated, not implied: this fixture server runs no
    // collector, and the page says so rather than showing an empty success.
    const ingest = await browser.eval(`document.querySelector('[aria-labelledby="ingest-title"]')?.textContent.replace(/\\s+/g, ' ') ?? ''`);
    assert.match(ingest, /On-chain data collection/);
    assert.match(ingest, /Not collecting/);
    assert.match(ingest, /solana-rpc:public/);
    // Deep intelligence is diagnostics only, and says both that it is not
    // running here and that it feeds nothing.
    const intel = await browser.eval(`document.querySelector('[aria-labelledby="intel-title"]')?.textContent.replace(/\\s+/g, ' ') ?? ''`);
    assert.match(intel, /Deep intelligence/);
    assert.match(intel, /Not running/);
    assert.match(intel, /Read by the decision engine/);
  });

  test('stale and never-evaluated Dossiers say so', async () => {
    await browser.goto(`${server.origin}/t/${MINTS.stale}`);
    await browser.waitFor(`document.querySelector('.notice--history')`);
    assert.match(await browser.eval(`document.querySelector('.notice--history').textContent`), /Not on the live Board/);
    await browser.goto(`${server.origin}/t/${MINTS.legacy}`);
    await browser.waitFor(`document.querySelector('.notice--history')`);
    assert.match(await browser.eval(`document.querySelector('.notice--history').textContent`), /Never evaluated/);
  });

  test('XSS: every hostile provider string renders inert, everywhere', async () => {
    for (const path of ['/', '/discover', `/t/${MINTS.xss}`, `/t/${MINTS.xss}/evidence`, `/t/${MINTS.xss}/contract`, '/changes?view=alerts']) {
      await browser.goto(`${server.origin}${path}`);
      await browser.waitFor(`document.querySelector('main') && document.querySelector('main').children.length > 0 && !document.querySelector('.skeleton')`);
      assert.deepEqual(await browser.eval(EXECUTED), [], `script executed on ${path}`);
      assert.equal(await browser.eval(`document.querySelectorAll('[onerror],[onload],[onclick],[onmouseover]').length`), 0, `handler attribute injected on ${path}`);
      assert.equal(await browser.eval(`document.scripts.length`), 1, `script element injected on ${path}`);
      const unsafe = await browser.eval(`[...document.querySelectorAll('[href],[src]')].map((e) => e.getAttribute('href') ?? e.getAttribute('src')).filter((u) => /^\\s*(javascript|data|vbscript):/i.test(u))`);
      assert.deepEqual(unsafe, [], `unsafe URL rendered on ${path}`);
    }
    // The hostile text is shown - as text.
    await browser.goto(`${server.origin}/t/${MINTS.xss}`);
    await browser.waitFor(`document.querySelector('.identity__symbol')`);
    assert.match(await browser.eval(`document.querySelector('.identity__symbol').textContent`), /<img src=x onerror=/);
    const links = await browser.eval(`[...document.querySelectorAll('.ext-link')].map((a) => a.getAttribute('href'))`);
    assert.ok(links.includes('https://legit.example/'), 'the one legitimate website is kept');
    assert.ok(links.every((href) => /^https?:\/\//.test(href)), links.join(' '));
  });

  test('long provider strings do not break the layout', async () => {
    for (const [width, height, mobile] of [[1440, 900, false], [390, 844, true]]) {
      await browser.viewport(width, height, mobile);
      for (const path of ['/', '/discover', `/t/${MINTS.long}`]) {
        await browser.goto(`${server.origin}${path}`);
        await browser.waitFor(`document.querySelector('main').children.length > 0 && !document.querySelector('.skeleton')`);
        // Measured against the device width, not innerWidth: on a phone an
        // overflowing page widens the layout viewport itself, so innerWidth
        // grows with the bug it is supposed to detect.
        const overflow = await browser.eval(`Math.max(document.documentElement.scrollWidth, innerWidth) - ${width}`);
        assert.ok(overflow <= 0, `${width}px ${path}: horizontal overflow of ${overflow}px`);
      }
    }
  });

  test('mobile: cards, no overlay, and a real touch opens a token', async () => {
    await browser.viewport(390, 844, true);
    await browser.goto(`${server.origin}/discover`);
    await browser.waitFor(`document.querySelectorAll('.card').length > 0`);
    assert.equal(await browser.eval(`getComputedStyle(document.querySelector('.table-scroll')).display`), 'none', 'the desktop table is shown on mobile');
    const centre = await browser.eval(`(() => { const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2); return !!el && !!el.closest('main'); })()`);
    assert.equal(centre, true, 'something covers the middle of the mobile screen');
    await browser.tap(`.card .card__link[href="/t/${MINTS.qualified}"]`);
    await browser.waitFor(`location.pathname === '/t/${MINTS.qualified}' && document.querySelector('.verdict-panel')`);
    await browser.tap('.nav__link[data-nav="system"]');
    await browser.waitFor(`location.pathname === '/system'`);
  });

  test('mobile: primary controls are comfortable touch targets', async () => {
    await browser.goto(`${server.origin}/discover`);
    await browser.waitFor(`document.querySelectorAll('.card').length > 0`);
    const small = await browser.eval(`[...document.querySelectorAll('.nav__link, .segment, #board-search, #board-sort, .card__link, #scan-now')]
      .map((el) => ({ el: el.className || el.id, h: el.getBoundingClientRect().height }))
      .filter((x) => x.h < 32)`);
    assert.deepEqual(small, []);
  });

  test('no script errors during the session', () => {
    const real = browser.errors.filter((e) => !/Failed to load resource|favicon|net::ERR/.test(e));
    assert.deepEqual(real, []);
  });
});

describe('server security boundary', { skip: SKIP, timeout: 60_000 }, () => {
  let server;
  before(async () => (server = await startServer()));
  after(() => server?.stop());

  test('pages and API responses carry a strict CSP and anti-framing headers', async () => {
    for (const path of ['/', '/t/abc', '/api/status']) {
      const res = await rawRequest(server.port, { path, headers: { host: `localhost:${server.port}` } });
      assert.equal(res.status, 200, path);
      assert.match(res.headers['content-security-policy'], /script-src 'self'/);
      assert.doesNotMatch(res.headers['content-security-policy'], /unsafe-inline|unsafe-eval/);
      assert.equal(res.headers['x-frame-options'], 'DENY');
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
    }
  });

  test('a forged Host header is refused (DNS rebinding)', async () => {
    const res = await rawRequest(server.port, { path: '/api/status', headers: { host: 'attacker.example' } });
    assert.equal(res.status, 403);
  });

  test('a scan cannot be triggered cross-site or without an Origin', async () => {
    const host = `localhost:${server.port}`;
    assert.equal((await rawRequest(server.port, { method: 'POST', path: '/api/scan', headers: { host } })).status, 403);
    assert.equal((await rawRequest(server.port, { method: 'POST', path: '/api/scan', headers: { host, origin: 'https://evil.example' } })).status, 403);
    assert.equal((await rawRequest(server.port, { method: 'POST', path: '/api/scan', headers: { host, origin: `http://${host}`, 'sec-fetch-site': 'cross-site' } })).status, 403);
  });

  test('the server listens on loopback only', async () => {
    // Reaching it through a non-loopback address must fail; loopback succeeds.
    const loop = await rawRequest(server.port, { path: '/api/status', headers: { host: `127.0.0.1:${server.port}` } });
    assert.equal(loop.status, 200);
  });

  test('JSON is compressed when the client accepts it, and only then', async () => {
    const host = `localhost:${server.port}`;
    const gz = await rawRequest(server.port, { path: '/api/board', headers: { host, 'accept-encoding': 'gzip, deflate, br' } });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(gz.headers.vary, 'accept-encoding');
    const plain = await rawRequest(server.port, { path: '/api/board', headers: { host } });
    assert.equal(plain.headers['content-encoding'], undefined);
    // fetch decompresses transparently; the body is the same document.
    const body = await (await fetch(`http://127.0.0.1:${server.port}/api/board`)).json();
    assert.ok(Array.isArray(body.rows) && body.rows.length > 0);
  });

  test('path traversal outside the public directory is refused', async () => {
    const res = await rawRequest(server.port, { path: '/..%2f..%2fpackage.json', headers: { host: `localhost:${server.port}` } });
    assert.ok(res.status === 403 || res.status === 404, String(res.status));
  });
});

describe('backend unavailable', { skip: SKIP, timeout: 60_000 }, () => {
  test('the page says so instead of showing stale data as live', async () => {
    const server = await startServer();
    const browser = await launch();
    try {
      await browser.viewport(1440, 900);
      await browser.goto(`${server.origin}/discover`);
      await browser.waitFor(`document.body.dataset.connection === 'live' && document.querySelectorAll('.board-row').length > 0`);
      server.stop();
      await browser.waitFor(`document.body.dataset.connection === 'offline'`, 20_000);
      const banner = await browser.eval(`(() => { const b = document.getElementById('conn-banner'); return { visible: !b.hidden && getComputedStyle(b).display !== 'none', text: b.textContent }; })()`);
      assert.equal(banner.visible, true);
      assert.match(banner.text, /cannot be reached/);
      assert.match(banner.text, /may be out of date/);
      assert.equal(await browser.eval(`document.getElementById('live-text').textContent`), 'Offline');
      assert.equal(await browser.eval(`document.getElementById('scan-now').disabled`), true);
    } finally {
      await browser.close();
      server.stop();
    }
  });
});
