# ADR 0001 — Frontend architecture

**Status:** Accepted · **Date:** 2026-09-27 · **Phase:** A (Product Foundation)

## Context

The product surface was 514 lines of vanilla JavaScript building HTML by string
concatenation and assigning it to `innerHTML`. That one habit produced the two
worst defects the product has shipped:

- **Stored XSS.** Provider-controlled strings (token symbol, name, image URL,
  RugCheck text, website links) reached executable HTML. Five vectors executed on
  page load with no interaction.
- **No component boundary.** Rendering, state and data fetching were
  interleaved, so a CSS rule (`.drawer { display: flex }`) silently defeated the
  `hidden` attribute and blocked every pointer interaction for the life of the
  project — with no test able to notice.

The product now needs a Board, a deep-linkable Token Dossier with tabs that
future phases will extend (Activity, Buyers, Technical), a cross-token Changes
stream and a System surface. The choice is how to build that.

## Options

### A — Buildless native ES modules

Browser-native modules served as static files by the existing server, with three
small primitives:

1. an **escape-by-default `html` tagged template** — interpolated values are
   escaped unless they are themselves `html` fragments, and URL-bearing
   attributes (`href`, `src`) *refuse* plain strings and accept only values that
   passed a protocol allowlist;
2. a **History-API router** with path routes (`/t/:mint/evidence`);
3. a **single render sink** — the only `innerHTML` assignment in the codebase,
   which accepts nothing but a template fragment.

### B — A framework with a build step (React/Preact/Svelte + Vite)

JSX or compiled templates, a component model, an ecosystem of routers and chart
libraries, hot module reload.

## Evaluation

| Criterion | A — buildless | B — framework + build |
|---|---|---|
| **Escaping by default** | Enforced by the `html` tag, plus a lint rule that fails the build on any other HTML sink and on inline handlers | Escaped by default for text; `href="javascript:..."` still passes in React unless separately guarded |
| **URL safety** | Structural: URL attributes reject unvetted strings | Needs a convention or wrapper component |
| **CSP** | `script-src 'self'` with no nonces, no `unsafe-inline`, no `unsafe-eval` | Achievable, but dev servers and some libraries want `unsafe-eval` or inline styles |
| **Component architecture** | Plain functions returning fragments; enough for this app's size | Richer |
| **Routing** | ~80-line router covers path routes, params, tabs, back/forward | Library |
| **Testability** | Driven through a real browser in the quality gate (DevTools protocol, no npm) | Same browser testing still needed; plus a component test runner |
| **Bundle size** | 0 KB framework; ~40 KB of our own JS, uncompressed | 40–150 KB framework before our code |
| **Dev experience** | Edit a file, refresh. No watcher, no toolchain | HMR, but a build pipeline, a lockfile of dev dependencies and a second server |
| **Local preview** | Unchanged: `npm run serve`, `http://localhost:5173` | A dev server on another port, or a build step before every preview |
| **Future Dossier tabs, Buyers, Technical** | Each is a module exporting a tab definition; charts are hand-written SVG | Easier if heavy interactive charting arrives |
| **Migration cost** | Rewrite of 514 lines either way | Same rewrite, plus toolchain |
| **Supply chain** | No new dependency of any kind | Hundreds of transitive dev dependencies |

## Decision

**Option A.** Buildless native ES modules with the three primitives above.

The deciding factors, in order:

1. **Security is the reason this rewrite exists**, and A makes the safe path the
   *only* path: there is exactly one HTML sink, it accepts only template
   fragments, URL attributes accept only vetted URLs, and a lint rule fails the
   quality gate if anyone adds another sink. B would escape text by default but
   still need a separate convention for URLs.
2. **Zero dependencies is a property the project defends deliberately**
   (`CLAUDE.md`). A keeps it for the frontend as well as the server.
3. **The app is small.** Four surfaces and a dozen components do not need a
   framework's reconciliation machinery.
4. **The local preview workflow stays one command** with no second server.

Type checking is not given up: the frontend is written as `// @ts-check`
JavaScript and checked by the TypeScript compiler the project already has
(`tsconfig.web.json`).

## Tradeoffs accepted

- **No virtual DOM.** Views re-render their region wholesale. At a few hundred
  rows this is well under a frame; if the Board ever needs thousands of live rows
  it will need windowing, which A can do but which a framework would give sooner.
- **Hand-written SVG charts.** Adequate for timelines and sparklines. If
  Technical Intelligence needs interactive candlestick charting, that is the
  moment to revisit this ADR — for a charting library, not necessarily a
  framework.
- **Templates are not type-checked against their data.** Mitigated by DTOs
  defined server-side in TypeScript, and by browser tests that render real data.

## Migration impact

- `src/server/public/` is rewritten; nothing else in the repo imports it.
- The server gains path routing with an SPA fallback, security headers and new
  DTO routes. Zero server runtime dependencies are retained.
- `npm run lint` and `npm run test:ui` join `npm run check`.
- No build step exists, by this decision — there is no "production build" to run.
  What the browser loads is what is in the repository.

## Revisit when

- the Board needs more than ~2,000 simultaneously rendered rows;
- Technical Intelligence needs interactive financial charting;
- more than one engineer works on the UI concurrently and wants a component
  test runner.
