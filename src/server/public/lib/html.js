// @ts-check
/**
 * The render boundary. The ONLY place in the frontend that produces HTML.
 *
 * Token metadata is written by whoever deployed the token: a symbol can be
 * `<img src=x onerror=...>`, a website can be `javascript:...`. The previous UI
 * concatenated those strings into `innerHTML` and five injection vectors
 * executed on page load. This module removes the class of bug, not instances:
 *
 * 1. `html\`...\`` escapes every interpolated value unless it is itself an
 *    `html` fragment. There is no `raw()` escape hatch.
 * 2. URL-bearing attributes (`href`, `src`, ...) do not accept strings at all -
 *    only a `SafeUrl`, which exists only if the value parsed as http(s), or an
 *    internal route. Anything else renders as an empty attribute.
 * 3. Templates that would put a value somewhere escaping cannot protect - an
 *    inline event handler, a `style` attribute, an unquoted attribute - throw at
 *    render time, so the mistake fails loudly in development and in tests.
 * 4. `render()` is the single `innerHTML` sink and accepts only fragments.
 *    `npm run lint` fails if any other file writes HTML.
 *
 * A strict Content-Security-Policy (no inline script, no inline style) is the
 * second, independent layer.
 */

const ESCAPES = /** @type {Record<string, string>} */ ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
});

/** @param {unknown} value */
export const escapeHtml = (value) => String(value).replace(/[&<>"'`]/g, (c) => ESCAPES[c] ?? c);

/** A trusted HTML fragment. Only `html` can make one. */
export class SafeHtml {
  /** @param {string} value */
  constructor(value) {
    this.value = value;
    Object.freeze(this);
  }
}

/** A URL that passed the protocol allowlist. Only `safeUrl`/`appUrl` can make one. */
export class SafeUrl {
  /** @param {string} value */
  constructor(value) {
    this.value = value;
    Object.freeze(this);
  }
}

/**
 * External URL guard. Parsed rather than pattern-matched, so `JaVaScRiPt:`,
 * `java\tscript:` and entity tricks are seen the way a browser sees them.
 *
 * @param {unknown} raw
 * @param {{ httpsOnly?: boolean }} [options]
 * @returns {SafeUrl | null}
 */
export function safeUrl(raw, options = {}) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  const allowed = options.httpsOnly ? ['https:'] : ['https:', 'http:'];
  if (!allowed.includes(parsed.protocol)) return null;
  if (parsed.username || parsed.password) return null;
  return new SafeUrl(parsed.href);
}

/**
 * An internal route. Same-origin paths only: no scheme, no `//host`.
 *
 * @param {string} path
 * @returns {SafeUrl}
 */
export function appUrl(path) {
  if (!/^\/(?!\/)[A-Za-z0-9\-._~/%?=&+]*$/.test(path)) {
    throw new Error(`appUrl: not an internal path: ${path}`);
  }
  return new SafeUrl(path);
}

// Contexts where escaping is not enough, detected from the text immediately
// before an interpolation.
const URL_ATTRIBUTE = /\s(?:href|src|srcset|action|formaction|poster|xlink:href)\s*=\s*"$/i;
const HANDLER_ATTRIBUTE = /\son[a-z]+\s*=\s*["']?$/i;
const STYLE_ATTRIBUTE = /\sstyle\s*=\s*["']?$/i;
const UNQUOTED_ATTRIBUTE = /\s[a-z-:]+\s*=\s*$/i;
const SINGLE_QUOTED_ATTRIBUTE = /\s[a-z-:]+\s*=\s*'$/i;

/**
 * @param {unknown} value
 * @returns {string}
 */
function interpolate(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (value instanceof SafeUrl) return escapeHtml(value.value);
  if (Array.isArray(value)) return value.map(interpolate).join('');
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return escapeHtml(value);
}

/**
 * Tagged template. Everything interpolated is text unless it is a fragment.
 *
 * @param {TemplateStringsArray} strings
 * @param {...unknown} values
 * @returns {SafeHtml}
 */
export function html(strings, ...values) {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    // Attribute rules apply only inside an open tag; "Score = ${n}" in text is fine.
    const inTag = out.lastIndexOf('<') > out.lastIndexOf('>');
    if (inTag && HANDLER_ATTRIBUTE.test(out)) throw new Error('html: interpolation into an event-handler attribute');
    if (inTag && STYLE_ATTRIBUTE.test(out)) throw new Error('html: interpolation into a style attribute (blocked by CSP)');
    if (inTag && (UNQUOTED_ATTRIBUTE.test(out) || SINGLE_QUOTED_ATTRIBUTE.test(out))) {
      throw new Error('html: attribute values must be double-quoted');
    }
    if (inTag && URL_ATTRIBUTE.test(out)) {
      // A URL attribute takes a vetted URL or nothing. A plain string - even a
      // harmless-looking one - is refused, because the check that makes it safe
      // has to have happened somewhere explicit.
      out += value instanceof SafeUrl ? escapeHtml(value.value) : '';
    } else {
      out += interpolate(value);
    }
    out += strings[i + 1] ?? '';
  }
  return new SafeHtml(out);
}

/**
 * The single HTML sink.
 *
 * @param {Element} target
 * @param {SafeHtml} fragment
 */
export function render(target, fragment) {
  if (!(fragment instanceof SafeHtml)) throw new TypeError('render: expected an html`` fragment');
  target.innerHTML = fragment.value;
}

/** Joins fragments with a separator fragment. @param {SafeHtml[]} parts @param {SafeHtml} [separator] */
export function join(parts, separator = html``) {
  return html`${parts.map((part, index) => (index === 0 ? part : html`${separator}${part}`))}`;
}
