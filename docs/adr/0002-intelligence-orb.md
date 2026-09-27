# ADR 0002 — The Observatory (Intelligence Orb)

**Status:** Proposed (in review on `feature/intelligence-orb`) · **Date:** 2026-09-27

## Context

The Board is a strong instrument but carries no visual signature. Nothing on
screen says that Token Finder is continuously observing, filtering and
re-evaluating what launches on Solana: between scans the page looks static even
while the engine works.

The goal is a memorable, animated signature that is also useful, and that
stays inside the product's rules:

- **"Instrument, not casino."** Colour is semantic; hierarchy comes from type
  and space; nothing flashes for its own sake.
- **No fake intelligence.** If it looks like an event (a scan, a change, a
  token arriving), it must be one.
- **The Board stays first.** At 1440×900 the table must start where it did.
- **Zero runtime dependencies, buildless frontend** (ADR 0001), CSP with no
  `unsafe-inline`.

## Decision

### What it is

A slowly turning network sphere, the Observatory, with up to seven real live
tokens tethered around it.

- **Desktop (side column ≥ 1240 px):** a sphere at the top of the right column,
  beside the title. The recent-changes rail follows below it. The table does not
  move.
- **Below 1240 px, down to phones:** a *planetary horizon*. The camera looks down
  at the sphere's pole, so only its cap shows, rising from the bottom of a short
  band between the title and the table. The cap turns in place, and a scan's
  sweep becomes a radar arm around the pole. It shows five tokens on a tablet and
  three on a phone, with a band 176 px or 128 px tall. It is a different
  composition, not a shrunken sphere.

### Which tokens, and why (`/api/orb`)

The server picks at most eight **live** tokens (the same `placementOf` predicate
as the Board, so a stale or never-evaluated verdict cannot appear). Each carries
the reason it was surfaced, in words:

| Role | Rule |
|---|---|
| `changed` | verdict changed within 6 h, and the current verdict is still the one it changed to |
| `top` | highest-scoring qualified tokens, labelled by rank ("2nd-highest score of 165 qualified") |
| `newest` | most recent first assessment |
| `watch` | most recently evaluated Watch token |
| `rejected` | most recently evaluated rejected token: the filter at work |

The roles are interleaved (change, top, newest, top, watch, rejected, change,
top), so a phone showing three still sees different kinds of fact. If there are
fewer facts than slots, the next-best qualified tokens fill them. Nothing is
padded or invented. The payload is about 1.2 KB gzipped.

### States, all driven by real state

| State | Source | What it looks like |
|---|---|---|
| idle | connection live, no scan | slow rotation with incommensurate periods (never visibly loops), breathing nodes, occasional faint pulses and couriers along backbone routes: decoration, never attached to a token |
| scanning | `scan-start` on the stream, or `status.scanning` | a sweep crosses the network with a wake; the readout says "Scan in progress" (with the start time only if it saw the start). No progress bar: the engine reports none |
| scan complete | `scan` event | readout gives the scan's own numbers (analysed, new). Tokens new to the selection *emerge* from their anchor node; a real verdict change pulses once; tokens the scan re-evaluated glint and release a ripple |
| scan failed | `scan-failed` | "The last scan failed. These are the previous results." |
| focus | hover, or keyboard focus | everything else dims, rotation slows, the token's anchor and its two-hop neighbourhood light, its tether takes the verdict colour, and the readout previews verdict, score, reason and why it was surfaced |
| offline | connection offline or reconnecting | rotation eases to a stop and the network dims: an instrument that is not observing must not look as if it were |

A token *emerges* only after a scan changed the selection. On first load, or when
a resize makes room for more tokens, markers simply fade in: nothing happened, so
nothing should look as if it had.

### Rendering: Canvas 2D plus real links

- **Canvas 2D** draws the network: about 135 nodes, a few hundred edges, and up to seven
  backbone arcs. Edges and nodes are batched into eight alpha buckets, so a frame
  is a handful of strokes. The static body (lit disc, rim) is pre-rendered once
  per layout.
- **The tokens are `<a href="/t/:mint">` elements** laid over the canvas and
  positioned with CSS transforms (CSSOM, allowed by the CSP). They are focusable,
  announced with a full label, hit-tested like any link, and open the Dossier
  through the router.
- **No dependency.** WebGL/three.js was rejected: a few hundred primitives do not
  need it, it would be the project's first runtime dependency (or a large vendored
  file), and it would put the tokens inside a canvas where they are not links.
  SVG was rejected because redrawing a few hundred elements every frame costs
  more DOM work than a canvas.

### Cost control

Measured with Chrome's Performance metrics on the real database at 1440×900:

| | main thread at rest |
|---|---|
| first implementation, 60 fps | 60% (DPR 1) / 92% (DPR 2), software-rendered |
| shipped, GPU (Intel Iris Xe, D3D11) | 12% (DPR 1) / 16% (DPR 2) |
| loop paused (hidden tab, off-screen) | < 1% |

This came from, in order of effect:

1. **Timer-paced frames at rest.** A pending `requestAnimationFrame` makes the
   browser produce a main-thread frame on every vsync, even if the callback does
   nothing (~8%). At rest the next frame is requested through a timer, at about
   24–30 fps; transitions get every frame.
2. **Marker writes throttled to about 8 per second at rest.** A frame that
   touches the DOM costs a style-and-commit pass that a canvas-only frame does
   not.
3. **The opacity comparison bug.** `style.opacity` reads back `"1"` for a
   written `"1.00"`, so every marker was rewritten on every frame. Values are now
   compared with what was last written.
4. **The pre-rendered body, and batched routes.**

The loop runs only while the tab is visible, the Observatory is on screen
(IntersectionObserver) and motion is allowed. There is exactly one loop per
mount. `dispose()` removes every listener, observer and timer, and a test
checks this across repeated navigation.

### Reduced motion

Under `prefers-reduced-motion: reduce` nothing loops. The scene is a still frame
at a composed angle, redrawn only when something changes (data, focus, scan
state). Scanning shows as a static sweep line and the status text; focus still
lights the token's neighbourhood.

## Consequences

- The Board's layout gains a side column that holds the Observatory above the
  rail. It is rendered once per mount, and the Board repaints its own slots
  around it.
- Rule 4 of the visual system ("motion only when something changed") gains one
  stated exception, recorded in `styles.css`.
- The test fixture can now emit the monitor's own `scan-start`, `scan` and
  `scan-failed` bus events (stdin), so the browser suite exercises the real SSE
  path without contacting a provider.
- About 12–16% of one core while idle on the Board, on this machine class, with
  a GPU. Revisit if the Board gains other continuous work.

## When to revisit

- If the Observatory should become the place for real-time transaction flow
  (after Transaction Ingestion): tethers could then carry actual buy activity.
  That would be a data change, not a rendering one.
- If idle cost matters more than the signature (for example on battery), add a
  user setting to pause ambient motion. Reduced motion already provides this
  through the OS.
