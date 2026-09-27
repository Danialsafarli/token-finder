/**
 * A minimal headless-Chrome driver over the DevTools protocol.
 *
 * No npm dependency: Node's built-in WebSocket and fetch talk to the Chrome
 * already on the machine. Interaction goes through `Input.dispatch*` - real
 * pointer, touch and key events that the browser hit-tests exactly as it would
 * a person's. A scripted `element.click()` bypasses hit-testing, which is how a
 * full-screen overlay once blocked every click while every check passed.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

/** Path to a Chromium browser, or null when none is installed. */
export function findBrowser() {
  return CANDIDATES.find((path) => existsSync(path)) ?? null;
}

/** A free TCP port on loopback. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch() {
  const executable = findBrowser();
  if (!executable) throw new Error('no Chromium browser found (set CHROME_PATH)');
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'tf-ui-'));
  const proc = spawn(executable, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--hide-scrollbars',
    'about:blank',
  ], { stdio: 'ignore' });

  let targets;
  for (let i = 0; i < 80 && !targets; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    } catch {
      await sleep(150);
    }
  }
  const page = targets.find((target) => target.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));

  let nextId = 0;
  const pending = new Map();
  const errors = [];
  /** @type {Map<string, Set<(params: any) => void>>} */
  const listeners = new Map();
  ws.addEventListener('message', (message) => {
    const data = JSON.parse(message.data);
    if (data.method) for (const fn of listeners.get(data.method) ?? []) fn(data.params);
    if (data.id && pending.has(data.id)) {
      pending.get(data.id)(data);
      pending.delete(data.id);
    } else if (data.method === 'Runtime.exceptionThrown') {
      errors.push(data.params.exceptionDetails?.exception?.description ?? data.params.exceptionDetails?.text ?? 'exception');
    } else if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error') {
      errors.push(`${data.params.entry.text} ${data.params.entry.url ?? ''}`);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, (data) => (data.error ? reject(new Error(`${method}: ${data.error.message}`)) : resolve(data.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');

  const browser = {
    errors,
    send,
    /** Subscribes to a DevTools protocol event. */
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(fn);
    },
    async viewport(width, height, mobile = false) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
      await send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    },
    async goto(url) {
      await send('Page.navigate', { url });
      await browser.waitFor('document.readyState === "complete"');
    },
    /** Evaluates an expression in the page and returns its JSON value. */
    async eval(expression) {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    },
    async waitFor(expression, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        try {
          last = await browser.eval(`Boolean(${expression})`);
          if (last) return true;
        } catch {
          // Page may be mid-navigation.
        }
        await sleep(100);
      }
      const state = await browser
        .eval(`JSON.stringify({ path: location.pathname + location.search, view: document.querySelector('main')?.firstElementChild?.className ?? null, connection: document.body.dataset.connection ?? null, text: document.querySelector('main')?.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160) ?? null })`)
        .catch((error) => `unavailable: ${error.message}`);
      throw new Error(`timed out waiting for: ${expression}\n  page: ${state}`);
    },
    /**
     * Centre of the first element matching `selector`, after scrolling it into
     * view, plus what a pointer at that point would actually hit.
     */
    async locate(selector) {
      return browser.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        const x = r.left + Math.min(r.width / 2, 40), y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return { x, y, hitsTarget: !!hit && (hit === el || el.contains(hit)), hit: hit ? (hit.id || hit.tagName.toLowerCase() + '.' + [...hit.classList].join('.')) : null };
      })()`);
    },
    /** A real mouse click, hit-tested by the browser. Fails if something covers the target. */
    async click(selector) {
      const point = await browser.locate(selector);
      if (!point) throw new Error(`no element: ${selector}`);
      if (!point.hitsTarget) throw new Error(`${selector} is covered by ${point.hit}`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
      }
    },
    /** A real touch tap. */
    async tap(selector) {
      const point = await browser.locate(selector);
      if (!point) throw new Error(`no element: ${selector}`);
      if (!point.hitsTarget) throw new Error(`${selector} is covered by ${point.hit}`);
      const touch = [{ x: point.x, y: point.y }];
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touch });
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    },
    async type(text) {
      await send('Input.insertText', { text });
    },
    async key(key, code = key, keyCode = 0) {
      const base = { key, code, windowsVirtualKeyCode: keyCode };
      // Enter carries a carriage return, as a real keyboard's does: without it
      // Chrome does not submit a form.
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: key.length === 1 ? key : key === 'Enter' ? String.fromCharCode(13) : undefined });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    },
    async screenshot() {
      return (await send('Page.captureScreenshot', { format: 'png' })).data;
    },
    async close() {
      try {
        ws.close();
      } catch {
        // already closed
      }
      proc.kill();
      await sleep(200);
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        // Windows may still hold the profile briefly; it is in the temp dir.
      }
    },
  };
  return browser;
}
