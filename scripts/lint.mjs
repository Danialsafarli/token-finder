#!/usr/bin/env node
/**
 * Project lint: architecture rules that must hold, checked mechanically.
 *
 * These are not style preferences. Each rule protects a boundary the project
 * relies on for correctness or security, and each exists because the boundary
 * was once crossed:
 *
 *   html-sink        Only src/server/public/lib/html.js may write HTML. Every
 *                    other file goes through its escape-by-default template.
 *                    (Five stored-XSS vectors came from `innerHTML` elsewhere.)
 *   inline-handler   No `onclick=`-style attributes. The CSP blocks them, and
 *                    escaping cannot make a value safe inside one.
 *   inline-style     No `style=` attributes or <style> blocks. The CSP blocks
 *                    them; styling lives in styles.css.
 *   dynamic-code     No eval, `new Function`, or string timers.
 *   blank-target     Links opening a new tab carry rel="noopener noreferrer".
 *   sql-boundary     No SQL outside src/persist/. The persistence layer is the
 *                    only thing that knows the schema.
 *
 * Zero dependencies: plain file reads and regular expressions, run by Node.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const PUBLIC = join(ROOT, 'src', 'server', 'public');
const SRC = join(ROOT, 'src');

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

const rel = (path) => relative(ROOT, path).split(sep).join('/');
const violations = [];

/** Strips // and /* *\/ comments so documentation can mention what code must not do. */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/** @param {string} file @param {string} text @param {RegExp} pattern @param {string} rule @param {string} message */
function check(file, text, pattern, rule, message) {
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (pattern.test(line)) violations.push(`${rel(file)}:${index + 1}  [${rule}] ${message}`);
  });
}

const HTML_SINK_ALLOWED = join(PUBLIC, 'lib', 'html.js');

for (const file of walk(PUBLIC)) {
  if (!/\.(js|html)$/.test(file)) continue;
  const raw = readFileSync(file, 'utf8');
  const text = file.endsWith('.js') ? code(raw) : raw;

  if (file !== HTML_SINK_ALLOWED) {
    check(file, text, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|createContextualFragment|DOMParser|srcdoc/, 'html-sink', 'HTML may only be written by lib/html.js render()');
  }
  check(file, text, /\son[a-z]+\s*=\s*["'{`$]/i, 'inline-handler', 'inline event-handler attribute');
  check(file, text, /\sstyle\s*=\s*["'`$]|<style[\s>]/i, 'inline-style', 'inline style (blocked by the CSP)');
  check(file, text, /\beval\s*\(|new\s+Function\s*\(|set(Timeout|Interval)\s*\(\s*["'`]/, 'dynamic-code', 'dynamic code execution');

  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (/target="_blank"/.test(line) && !/rel="noopener noreferrer"/.test(line)) {
      violations.push(`${rel(file)}:${index + 1}  [blank-target] target="_blank" without rel="noopener noreferrer"`);
    }
  });

  if (file.endsWith('.html')) {
    check(file, text, /<script(?![^>]*\bsrc=)[^>]*>/i, 'inline-script', 'inline <script> (blocked by the CSP)');
  }
}

const SQL = /\b(SELECT\s+[\w*(]|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(TABLE|INDEX)|PRAGMA\s+\w)/;
for (const file of walk(SRC)) {
  if (!file.endsWith('.ts')) continue;
  if (rel(file).startsWith('src/persist/')) continue;
  check(file, code(readFileSync(file, 'utf8')), SQL, 'sql-boundary', 'SQL outside src/persist/');
}

if (violations.length > 0) {
  console.error(`lint: ${violations.length} violation(s)\n`);
  for (const line of violations) console.error(`  ${line}`);
  process.exit(1);
}
console.log('lint: ok — render boundary, CSP-compatible markup, and persistence boundary all hold');
