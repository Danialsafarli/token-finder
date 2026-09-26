# token-finder

Discovers newly launched Solana tokens, analyzes them for safety and traction,
ranks them with a transparent scoring model, and monitors the ones it has seen
for rug-shaped changes. Comes with a local web dashboard and a CLI.

Runs on **Node 24's native TypeScript support — no build step and no runtime
dependencies.** The only devDependencies are `typescript` and `@types/node`,
and they are needed solely for `npm run typecheck`.

```
node src/cli.ts serve       # dashboard on http://localhost:5173 + background monitor
```

The dashboard listens on loopback only unless `HOST` says otherwise.

## Commands

| Command | What it does |
| --- | --- |
| `node src/cli.ts serve` | Dashboard plus the monitor loop. The default. |
| `node src/cli.ts scan` | One discovery pass, prints the top 10 and any events. |
| `node src/cli.ts rank [n]` | Prints the current ranking from stored state, no network. |
| `node src/cli.ts watch` | Monitor loop in the terminal, no dashboard. |
| `node src/cli.ts analyze <mint\|symbol>` | Deep-dive one token with the full score breakdown. |
| `node src/cli.ts discover` | Just the candidate mints each feed returned. |
| `node src/cli.ts reset` | Clears stored tokens, history and events. |
| `node src/cli.ts typesafe-check` | One request to verify TypeSafe credentials and connectivity. |

`npm run serve`, `npm run scan` and friends are the same thing.

| Script | What it runs |
| --- | --- |
| `npm run typecheck` | `tsc` over the server, then over the browser code (`tsconfig.web.json`, JSDoc-typed). |
| `npm run lint` | `scripts/lint.mjs`: the render boundary, CSP-compatible markup and the persistence boundary. |
| `npm test` | Unit and integration tests, plus the render-boundary tests for the browser code. |
| `npm run test:ui` | The product in a real headless Chrome or Edge, driven by real pointer, touch and key input. Skips, saying so, when no Chromium browser is installed (`CHROME_PATH` overrides). |
| `npm run check` | All four. |

## Configuration

Copy `.env.example` to `.env`. Every key is optional — **the tool works fully
without any API key.**

| Variable | Default | Meaning |
| --- | --- | --- |
| `HELIUS_API_KEY` | — | Adds on-chain mint/freeze authority and holder concentration. |
| `BIRDEYE_API_KEY` | — | Adds Birdeye's new-listing feed. |
| `PORT` | `5173` | Dashboard port. |
| `HOST` | `127.0.0.1` | Bind address. The default also binds `::1`, so `localhost` answers on either stack. A non-loopback address exposes the dashboard to the network, and the server logs a warning when that happens. |
| `LIVE_WINDOW_MIN` | `90` | How long a token stays on the live Board after its last evaluation. It matches the point at which market evidence stops being trusted. |
| `SCAN_INTERVAL_SEC` | `120` | Seconds between monitor scans. |
| `MIN_LIQUIDITY_USD` | `3000` | Candidates with less pooled liquidity are dropped. |
| `MAX_AGE_HOURS` | `168` | Anything older is no longer treated as a new launch. |
| `MIN_SCORE_ALERT` | `70` | Score at which a newly discovered token raises an alert. |
| `MIN_COVERAGE_ALERT` | `0.6` | Evidence coverage a token must also reach before it can alert. |
| `MIN_COVERAGE_QUALIFY` | `0.6` | Coverage at or above which a veto-free token enters the main ranking. |
| `MIN_COVERAGE_WATCH` | `0.35` | Below this, a token is held out of the ranking as `INSUFFICIENT_DATA`. |
| `CATASTROPHIC_CONCENTRATION_PCT` | `90` | Top-holder share that triggers a hard veto rather than a penalty. |
| `TOKEN_FINDER_DATA_DIR` | `data` | Where runtime state lives. Point it elsewhere for smoke runs. |
| `MAX_ANALYZE_PER_SCAN` | `60` | Cap on deep (rate-limited) safety lookups per scan. |
| `TYPESAFE_API_KEY` | — | Enables advisory impersonation screening. **Server-side only.** |
| `TYPESAFE_ENABLED` | `false` | Feature flag; screening needs this *and* a key. |
| `TYPESAFE_MODEL` | `jev-latest` | Model id. |
| `TYPESAFE_MAX_PER_SCAN` | `10` | Hard cap on model requests per scan. |
| `TYPESAFE_TIMEOUT_MS` | `8000` | Per-request timeout. |

API keys are read only by `src/config.ts`, which runs server-side. No key is ever
serialised into an API response or reaches the browser — `/api/status` reports
booleans (`configured`, `enabled`) and nothing else.

## How it works

```
discover ──▶ analyze ──▶ score ──▶ store ──▶ monitor ──▶ dashboard / CLI
```

**1. Discover** (`src/core/discover.ts`) merges five feeds and records which
ones surfaced each mint. A feed that errors or lacks a key contributes nothing
rather than failing the scan.

| Feed | Key needed | What it gives |
| --- | --- | --- |
| `jupiter:recent` | no | Mints Jupiter has just seen created. |
| `jupiter:organic` | no | Top organic (non-wash) activity over the last hour. |
| `dexscreener:profiles` | no | Newly published token profiles. |
| `dexscreener:boosts` | no | Tokens whose owners just paid for promotion. |
| `birdeye:new` | yes | Birdeye's new-listing feed. |

**2. Analyze** (`src/core/analyze.ts`) runs in three passes so the expensive
sources only see tokens worth the call: batched market data first (DexScreener
pairs, Jupiter metadata), cheap filtering second (liquidity and age), then the
per-token safety lookups (RugCheck, Helius) on the deepest pools only.

**3. Score** (`src/core/score.ts`) produces a 0-100 total from seven weighted
components, then applies multiplicative penalties for hard risks.

| Component | Weight | Reads well when |
| --- | --- | --- |
| Safety | 26% | Mint and freeze authority revoked, low holder concentration, clean RugCheck. |
| Liquidity | 18% | Deep pool — scored logarithmically from $5K to $500K. |
| Activity | 14% | 24h volume around 3x liquidity; near zero is dead, 50x is wash trading. |
| Holders | 13% | Wide distribution, 50 to 5,000 wallets on a log scale. |
| Momentum | 12% | Blended 1h and 6h price change; 24h is too slow for a token hours old. |
| Buy pressure | 9% | More buys than sells over the last hour. |
| Age | 8% | Peaks around 12h old: past the chaotic first minutes, still new. |

Penalties are multiplicative, so they compound: live mint authority ×0.55, live
freeze authority ×0.45, top holders over 60% ×0.7, liquidity under the minimum
×0.65, wash-trading signature ×0.8. Grades are A ≥75, B ≥60, C ≥45, D ≥30, F below.

**4. Monitor** (`src/core/monitor.ts`) diffs each fresh snapshot against the
stored one and raises events: `discovered`, `score_up`, `score_down`,
`liquidity_drop` (the clearest on-chain signature of a rug), `price_spike`,
`risk_flag`. Scans chain rather than stack, so a slow scan delays the next one
instead of overlapping it.

**5. Store** (`src/core/store.ts` over `src/persist/`) persists to SQLite at
`data/token-finder.sqlite` using Node's built-in `node:sqlite` — no runtime
dependency. Current state is cached in memory for the dashboard; history lives
in normalized tables and accumulates across restarts. Snapshots are recorded
when something material changes, on a state transition, or on a 30-minute
heartbeat, so a two-minute scan loop does not write ~700 identical rows per
token per day. **State transitions are never pruned.** An existing
`data/state.json` is imported once, backed up first, and never written again.
See **[PERSISTENCE.md](PERSISTENCE.md)**.

## Dashboard

Four surfaces, each with its own URL. The architecture is recorded in
[docs/adr/0001-frontend-architecture.md](docs/adr/0001-frontend-architecture.md):
plain ES modules, no build step, no framework.

- **Board** (`/`) — the live ranking. It shows only tokens evaluated within
  `LIVE_WINDOW_MIN`, grouped by verdict, so a rejected token can never sit above
  a qualified one. There are segments (all, qualified, watch, rejected), search
  and sort. A search also lists matching tokens that are *not* live, labelled as
  history. When a capability is off (for example, no Helius key), the Board says
  which checks no verdict includes. `/` focuses search, `j`/`k` move between rows
  and `Enter` opens one.
- **Dossier** (`/t/:mint`) — one token. The overview gives the verdict and the
  reason for it; score, coverage and confidence as three separate numbers; every
  signal that was not measured, and why; and the hard vetoes. Tabs:
  - **Evidence**: every signal, each provider's claim, and which reading won.
  - **History**: the verdict timeline, market series with gaps shown as gaps,
    and every verdict change.
  - **Contract & holders**: the token program, authorities, Token-2022
    extensions with their policy, and holder concentration.
- **Changes** (`/changes`) — what the conclusions did: verdict changes across
  every token, market alerts and first assessments.
- **System** (`/system`) — what this instance can and cannot check, provider
  health, persistence health, and the rules the verdicts use.

Freshness is always visible. The top bar shows the connection state (`Live`,
`Reconnecting`, `Offline`) and the last scan. If the server stops answering, a
banner says so and warns that the page may be out of date. The banner clears
itself on reconnect.

## API

The dashboard reads view-shaped DTOs (`src/server/dto.ts`), never raw
snapshots. A Board row is about 0.5 KB: 200 rows come to about 100 KB, or about
19 KB gzipped. Responses over 1 KB are gzipped when the client accepts it.

| Endpoint | Returns |
| --- | --- |
| `GET /api/board?segment=&q=&sort=&limit=` | The live Board: rows, live-universe counts, history matches for a search, capability gaps and the qualify rules. |
| `GET /api/tokens/:mint` | The Dossier for one token, live or not. `400` for a malformed mint, `404` for an untracked one. |
| `GET /api/tokens/:mint/history` | Verdict changes and the score, market and holder series for one token. |
| `GET /api/changes?limit=` | Verdict changes, first assessments and market alerts across all tokens. |
| `GET /api/system` | Capabilities, provider health, persistence health, the live window and the rules. |
| `GET /api/status` | Scan count, last scan, whether a scan is running, and which keys are active (booleans). |
| `GET /api/coverage` | Coverage, confidence and eligibility across the **live** universe, with stale and never-evaluated counts beside it. |
| `GET /api/events?limit=` | Recent monitor events. |
| `GET /api/tokens` | Full snapshots of the live universe. Kept for scripts; the dashboard does not use it. |
| `POST /api/scan` | Triggers a scan. Same-origin only. |
| `GET /api/stream` | SSE: `hello`, `scan-start`, `scan`, `scan-failed`, `alert`. |

### Local security

The dashboard is a local tool, and it is defended as one:

- It binds `127.0.0.1` (and `::1`) by default.
- On a loopback bind, it refuses any request whose `Host` is not `localhost` or
  a loopback address. That stops DNS rebinding, where a hostile page points its
  own domain at your machine.
- `POST /api/scan` requires a same-origin `Origin` header, so another site
  cannot trigger scans from your browser.
- Every response carries a Content Security Policy with no `unsafe-inline` and
  no `unsafe-eval`, plus `nosniff`, `frame-ancestors 'none'` and
  `Referrer-Policy: no-referrer`.
- Token names, symbols and links are provider data, so an attacker controls
  them. The browser code has exactly one HTML sink, fed by a template that
  escapes every value. That template:
  - accepts only `http(s)` URLs in `href` and `src`;
  - refuses to build if a value is interpolated into an event handler or a
    `style` attribute.

  `npm run lint` enforces this. `npm run test:ui` renders a hostile token and
  checks that nothing executes.

## Rate limits

RugCheck is the bottleneck — this tool self-limits to 30 requests/minute
against it, which is why a cold scan of 60 tokens takes about two minutes.
Results are cached for 20 minutes, so later scans are far faster. Every host
has its own queue in `src/util/http.ts`; 429s set a cooldown for that host only.

## Documentation

| File | Contents |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | What exists today, stage by stage, plus the proposed target architecture, trading modes, decision engine, persistence and performance model. |
| [PERSISTENCE.md](PERSISTENCE.md) | **The storage layer as implemented**: SQLite schema, migrations, legacy JSON import, snapshot deduplication, retention, failure behaviour and how to extend it for transaction ingestion. |
| [DATA_SOURCES.md](DATA_SOURCES.md) | Measured live validation of all five providers, the fields we actually receive, and the proposed provider strategy. |
| [SCORING.md](SCORING.md) | Full scoring audit: every component, weight and penalty, with measured weaknesses. |
| [PIPELINE.md](PIPELINE.md) | **The analysis path as implemented**: provider validation, evidence model, cross-provider resolution, safety gate, coverage/confidence, eligibility and lifecycle. |
| [TECHNICAL_INTELLIGENCE.md](TECHNICAL_INTELLIGENCE.md) | **PLANNED / FUTURE — not implemented.** Design specification and research record for a future chart-structure analysis layer. No code implements any of it. |
| [ROADMAP.md](ROADMAP.md) | Proposed development sequence and test strategy. |
| [docs/adr/](docs/adr/) | Architecture decision records. 0001 is the frontend architecture. |

Parts of those documents describe proposals; they are labelled **NOT IMPLEMENTED** where so.

## Unknown is not zero

Every fact carries how we came to believe it. Six states, none interchangeable:

| State | Meaning | Earns points | Counts as evidence |
|---|---|---|---|
| `MEASURED` | a provider returned a value that passed validation | yes | yes |
| `CONFLICTED` | providers disagreed; the conservative reading was taken | yes | yes |
| `UNKNOWN` | nobody returned anything | no | **no** |
| `INVALID` | a provider returned something impossible; it was rejected | no | no |
| `STALE` | measured, but too old to speak for the present | no | no |
| `UNAVAILABLE` | the only provider that could answer is not configured | no | no |

A **measured zero** — a real pool that traded nothing — scores zero *and counts as
evidence*. An **unknown** scores the same zero but does not, so it lowers coverage. That
distinction is the difference between "this token is dead" and "we never looked".

Unknown components keep their weight, so missing data can never earn a point. Three
numbers are reported separately and never multiplied together:

- **score** — how good the token looks;
- **coverage** — how much of that rests on real observation (`score.ceiling` is the most
  it could have scored);
- **confidence** — what those observations are worth after provider disagreement,
  staleness and single-provider dependence.

## Not everything gets ranked

A numeric score is not a licence to appear in the ranking. Before scoring, a hard safety
gate can reject a token outright — a live mint authority, an untradeable pool, a RugCheck
critical finding. A penalty multiplier cannot express that, because a strong enough token
absorbs one and stays near the top.

| Status | Meaning |
|---|---|
| `QUALIFIED` | clean gate, enough evidence to stand behind |
| `WATCH` | clean gate, but coverage below the qualify bar |
| `INSUFFICIENT_DATA` | too little observed to say anything useful |
| `REJECTED` | one or more hard vetoes; not shown in the ranking by default |

Every veto records its code, a readable reason, the provider, the observed value, a
timestamp, and whether it can clear on fresh evidence. **A veto never fires on unknown
evidence** — absence of evidence is not evidence of danger.

Full detail: **[PIPELINE.md](PIPELINE.md)**.

## Caveats

- **Nothing here is financial advice.** A high score means a token looks
  structurally healthier than its peers *right now*; new tokens can still go to
  zero minutes later, and a score cannot see an intent to rug.
- Holder concentration from Helius includes AMM pool vaults, so `top10Share` is
  an upper bound, not a clean insider metric. Jupiter's audit figure is used
  first where available. The ratio itself is exact: raw base units on both
  sides, `uiAmount` never consulted, `decimals` never in the arithmetic.
- **Token-2022 extension support is partial, and deliberately so.** The mint's
  owning program and its extension list are read, and six extensions can veto:
  permanent delegate, transfer hook, pausable, default-frozen accounts,
  non-transferable, and an extreme transfer fee. Others are recorded as
  informational. An extension this build does not recognise never vetoes and
  marks extension coverage incomplete, so it lowers the token's coverage rather
  than passing silently. **Without a Helius key none of this runs at all** and
  extension evidence is UNAVAILABLE for every token.
- Third-party endpoints change. Each adapter in `src/sources/` fails soft, so a
  changed endpoint degrades the scan rather than breaking it — if a feed goes
  quiet, check it there first.
- **Test coverage is partial.** `npm test` runs 409 tests over a deterministic
  14-scenario fixture corpus. They cover:
  - provider validation, evidence resolution and cross-provider conflicts;
  - the safety gate, coverage, eligibility and the lifecycle;
  - Token-2022 extension policy and holder math;
  - the Jev failure paths;
  - persistence and restart;
  - the live-ranking universe and the view DTOs;
  - the server's security boundary and the browser render boundary.

  `npm run test:ui` adds 27 real-browser tests of the dashboard itself.
  Discovery against live providers is still untested. See
  [ROADMAP.md](ROADMAP.md).
- **Stale evidence cannot lower a current score.** A RugCheck finding only
  charges its penalty while it is current, is classified as something age does
  not touch, and is not contradicted by canonical on-chain state. Suppressed
  findings stay visible and say why they did not count.
- **A provider outage degrades a scan, it does not end one.** Every fan-out path is
  failure-isolated, and a failed provider's signals become `UNAVAILABLE` with a
  classified reason rather than silently reading as "no data".
- **No threshold here is calibrated against outcome data.** Coverage bars, the veto
  concentration limit and the A/B/C/D/F grades are reasoned starting points. Nothing has
  been validated against whether a token actually rugged.
- The two scoring defects previously listed here are **fixed**: absent market data now earns
  nothing, and a RugCheck `danger` authority finding now resolves authority state and triggers
  the penalty. See [SCORING.md](SCORING.md) §5.1 and §5.2. The weaknesses in §5.3–§5.6 —
  provider concentration, correlated components, exploitability, no hard veto — are still open.
- **Impersonation screening is advisory.** When enabled it flags naming that resembles an
  established token. It never changes a score, is not proof of fraud, and is not a trading
  signal. Any failure records "not assessed", which is not the same as safe.
- Scores are still uncalibrated against outcome data. The hard veto gate (above) excludes a
  token only for specific, evidenced dangers; anything short of those is still a penalty.
