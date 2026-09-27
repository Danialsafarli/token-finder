# ADR 0003 — The Landing and on-demand analysis

**Status:** Proposed (in review on `feature/landing-experience`) · **Date:** 2026-09-27

## Context

Token Finder serves two different intentions, and until now only one of them
had a door:

- **"I have a token. What is it?"** Someone holds a mint address and wants
  Token Finder's judgement on it. Before this, they could only hope discovery
  had already found it, or use the CLI.
- **"Show me what matters now."** Someone wants to see what Token Finder is
  finding. That is the Observatory and the Board.

Opening straight onto the operational Board answered the second and hid the
first.

## Decision

### Routes

| Route | View | State |
|---|---|---|
| `/` | Landing | idle |
| `/analyze/:mint` | Landing | scanning → result or error |
| `/discover` | Observatory + Board | (the previous `/`) |
| `/t/:mint` | Dossier | canonical detail, unchanged |

`/` and `/analyze/:mint` are one view in different states (the router's
`update` hook). The Observatory is therefore never remounted between the
landing, the scan and the result: it moves. An `/analyze/:mint` link runs the
analysis when opened, so it can be shared.

The brand links home. The navigation reads Discover · Changes · System. The
Dossier's breadcrumb leads to Live discovery. A Dossier for a token Token
Finder does not track offers "Analyze this token".

### On-demand analysis is the same pipeline

`POST /api/analyze {"mint"}` runs exactly what `cli analyze` and the monitor
run: `analyze([{ mint }], { includeAll: true, deepLimit: 1 })`. That is
validation, cross-provider evidence, the safety gate, coverage and confidence,
scoring and eligibility. The discovery filters (liquidity floor, maximum age)
are lifted, because a person asking about a token has already chosen it. The
result is persisted exactly as a scan's would be, so `/t/:mint` works for any
analysed token.

Two details differ from the CLI, both deliberate:

- **Provenance is kept.** The CLI overwrote a token's discovery `sources` with
  `['cli']`, a known defect. A request adds `request` to the existing sources.
- **Lifecycle continuity.** The prior state is passed in, as the monitor does,
  so the lifecycle stays continuous.

**Stages are real.** `analyze()` gained an optional `onStage` callback (pure
instrumentation, no change to what is analysed or decided), fired as each stage
begins: market, safety, evidence, gate, verdict. The server streams these as
newline-delimited JSON, together with a `validate` stage for the address check.
Each stage's wording is derived from the configuration at the time:

- without a Helius key it says *"on-chain checks are off in this configuration"*;
- if the monitor is scanning, the safety stage says *"queued behind the running
  scan"*, because the rate-limited providers are shared.

There is no percentage anywhere, because the pipeline does not estimate one.
The result card states how long the analysis took, from the server's own
timestamps. With warm caches that can be a tenth of a second, and it says so
rather than padding the wait.

Outcomes that are not a verdict are stated as such and record nothing:

- `no-market`: no pool anywhere; it may not be a token mint;
- `providers-down`: both market providers are unreachable;
- `failed`: an unexpected error.

The endpoint is limited to same-origin requests, a JSON body of at most 1 KB,
a strict base58 mint of 32–44 characters, and two analyses at once (409 for a
duplicate, 429 when busy).

### One Observatory, more states

The Landing uses the same `mountOrb` as Discover: one implementation and one
animation loop. It gained options and a small controller:

- `bare` (no heading or footer), `follow: false` (the landing does not reflect
  the monitor's scans), `reveal: false` (no tokens until asked),
  `composition: 'sphere'` and `ring: 'sides'`;
- `setIntent('analyze' | 'discover')`:
  - hovering or focusing **Analyze** quiets the network onto one node, the node
    an analysis will converge on;
  - **Discover** reveals the real live tokens on the sphere's flanks.
- `beginAnalysis`, `stage`, `endAnalysis(token)`:
  - during an analysis, signals converge on that node, and each real stage
    releases a burst;
  - on a result, the token emerges from that node and one analysis wave
    crosses the network;
  - on failure, attention is released.
- `setPlacement({ fx, fy, size })` moves the sphere within its stage, eased. On
  a wide screen it moves from the centre to the left as the result card
  arrives on the right.

### Composition

- **Wide:** the Observatory is a full-bleed layer behind the page. The headline
  sits above the sphere, with a soft dark field behind it for legibility. The
  two paths sit below: Analyze as the primary card, Discover as the secondary,
  with its live count.
- **Phone:** headline, a 230 px Observatory block with a full sphere, then both
  paths. Both paths are on the first screen at 390×844.
- **Reduced motion:** no loop; placement and attention apply at once.

## Consequences

- A requested token enters the live universe for the live window (90 minutes),
  like any evaluated token, so it appears on `/discover`. The result card says
  so. It is the truthful consequence of the one-universe rule in PIPELINE §6.
- `/` no longer shows the Board. Old bookmarks to `/?segment=…` land on the
  Landing.
- The Dossier's own verdict reason still uses the verdict's colour (a caveat on
  a Qualified token shows green there). The result card uses the new
  `verdict.reasonTone`; the Dossier page is unchanged in this phase.
- Cost at rest, measured with GPU compositing: about 5–6% of the main thread at
  30 fps, and effectively zero when the tab is hidden.
