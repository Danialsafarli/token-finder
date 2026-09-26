/**
 * The render boundary and formatters, tested without a browser.
 *
 * lib/html.js is the only code in the frontend that produces HTML, so its
 * guarantees are the XSS guarantees. Each test below is an attack or a mistake
 * the template must refuse.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { appUrl, escapeHtml, html, safeUrl, SafeHtml, SafeUrl } from '../../src/server/public/lib/html.js';
import { age, pct, price, share, span, usd, DASH } from '../../src/server/public/lib/format.js';

/** The five vectors that executed in the audit, plus relatives. */
const PAYLOADS = [
  '<img src=x onerror=window.__x=1>',
  '<script>window.__x=1</script>',
  '"><svg onload=window.__x=1>',
  "'><img src=x onerror=alert(1)>",
  '</textarea><script>alert(1)</script>',
  '<a href="javascript:alert(1)">x</a>',
  '`${alert(1)}`',
];

describe('html template escaping', () => {
  test('every provider payload renders as inert text', () => {
    for (const payload of PAYLOADS) {
      const out = html`<p class="sym">${payload}</p>`.value;
      assert.doesNotMatch(out, /<(img|script|svg|a)[\s>]/i, payload);
      assert.equal(out.includes(escapeHtml(payload)), true);
    }
  });

  test('values cannot break out of a double-quoted attribute', () => {
    const out = html`<span title="${'" onmouseover="alert(1)'}"></span>`.value;
    assert.equal(out, '<span title="&quot; onmouseover=&quot;alert(1)"></span>');
  });

  test('fragments nest; strings never become markup', () => {
    const inner = html`<b>${'<i>'}</b>`;
    assert.equal(html`<p>${inner}</p>`.value, '<p><b>&lt;i&gt;</b></p>');
    assert.equal(html`<p>${[html`<i>a</i>`, '<i>b</i>']}</p>`.value, '<p><i>a</i>&lt;i&gt;b&lt;/i&gt;</p>');
  });

  test('null, undefined, false and non-finite numbers render as nothing - never "0" or "NaN"', () => {
    assert.equal(html`<p>${null}${undefined}${false}${Number.NaN}${Infinity}</p>`.value, '<p></p>');
    assert.equal(html`<p>${0}</p>`.value, '<p>0</p>');
  });

  test('a URL attribute refuses a plain string, however harmless it looks', () => {
    assert.equal(html`<a href="${'https://example.com'}">x</a>`.value, '<a href="">x</a>');
    assert.equal(html`<img src="${'javascript:alert(1)'}" />`.value, '<img src="" />');
    assert.equal(html`<a href="${safeUrl('https://example.com/a')}">x</a>`.value, '<a href="https://example.com/a">x</a>');
  });

  test('templates that escaping cannot protect throw instead of rendering', () => {
    assert.throws(() => html`<button onclick="${'go()'}">x</button>`, /event-handler/);
    assert.throws(() => html`<div style="${'color:red'}"></div>`, /style/);
    assert.throws(() => html`<div class=${'a onmouseover=alert(1)'}></div>`, /double-quoted/);
    assert.throws(() => html`<div title='${'x'}'></div>`, /double-quoted/);
  });

  test('text that merely looks like an attribute is fine outside a tag', () => {
    assert.equal(html`<p>Score = ${82}</p>`.value, '<p>Score = 82</p>');
  });

  test('only html`` can make a fragment; a lookalike object is escaped, not trusted', () => {
    const fake = { value: '<img src=x onerror=alert(1)>' };
    assert.doesNotMatch(html`<p>${fake}</p>`.value, /<img/);
    assert.ok(html``instanceof SafeHtml);
  });
});

describe('URL guards', () => {
  test('safeUrl admits only http(s)', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      '\tjavascript:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox(1)',
      'blob:https://x/1',
      'https://u:p@evil.example',
      '/relative/path',
      '',
      null,
      42,
    ]) {
      assert.equal(safeUrl(bad), null, String(bad));
    }
    assert.ok(safeUrl('https://solscan.io/token/x') instanceof SafeUrl);
    assert.equal(safeUrl('http://x.io', { httpsOnly: true }), null);
  });

  test('appUrl accepts internal paths and nothing that leaves the origin', () => {
    assert.equal(appUrl('/t/So11111111111111111111111111111111111111112/history').value, '/t/So11111111111111111111111111111111111111112/history');
    assert.equal(appUrl('/?segment=rejected&q=a+b').value, '/?segment=rejected&q=a+b');
    for (const bad of ['//evil.example', 'https://evil.example', 'javascript:alert(1)', '/"onload', 't/x']) {
      assert.throws(() => appUrl(bad), undefined, bad);
    }
  });
});

describe('formatters never invent a zero', () => {
  test('unknown renders as a dash everywhere', () => {
    for (const fmt of [usd, price, pct, share, age]) {
      assert.equal(fmt(null), DASH);
      assert.equal(fmt(undefined), DASH);
      assert.equal(fmt(Number.NaN), DASH);
    }
  });

  test('micro-prices use subscript zeros', () => {
    assert.equal(price(0.0000915), '$0.0₄915');
    assert.equal(price(0.00432), '$0.00432');
    assert.equal(price(1.5), '$1.5');
  });

  test('large moves stay readable', () => {
    assert.equal(pct(1323), '+1.3k%');
    assert.equal(pct(-9), '−9.0%');
    assert.equal(pct(0), '0.0%');
  });
});

describe('configured spans read as words', () => {
  test('minutes, hours and days', () => {
    assert.equal(span(90), '90 minutes');
    assert.equal(span(360), '6 hours');
    assert.equal(span(150), '2.5 hours');
    assert.equal(span(100000), '69 days');
  });
});
