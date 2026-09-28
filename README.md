# Token Finder

Discovers newly launched Solana tokens, decides which of them can be trusted
enough to watch and which look interesting, and keeps that read current as
conditions change. Every verdict arrives with its evidence.

It is a **read-only analysis tool**: it reads public market and chain data
and produces verdicts and rankings. It holds no keys, signs nothing and trades
nothing.

Runs on **Node 24's native TypeScript support - no build step and no runtime
dependencies.** The only devDependencies are `typescript` and `@types/node`,
for `npm run typecheck`.

```bash
node src/cli.ts serve       # dashboard on http://localhost:5173 + background monitor
```

A one-minute tour for reviewers: **[DEMO.md](DEMO.md)**. Hosting:
**[DEPLOYMENT.md](DEPLOYMENT.md)**.

## What makes it different

- **Real data, with its source.** DexScreener, Jupiter, RugCheck and the
  chain itself (through Helius). Every fact carries its provider, age and
  state; **unknown is never zero** and **invalid is never safe**.
- **Safety and opportunity are separate questions.** A hard fail rejects
  outright; integrity (seven risk domains) and opportunity are scored apart,
  and momentum can never lift a verdict.
- **Who is behind the activity decides things.** Deep intelligence profiles
  the wallets - first buyers, bots and snipers, funding links, coordinated
  clusters, wash trading - and the creator's history and network, and the
  decision engine acts on it when the evidence is confident and covered.
- **Every verdict explains itself** - reasons, risks, what blocks a better
  verdict, coverage - and every change is recorded. Danger applies at once; a
  better verdict must be confirmed by a second reading.

## How it works

```
DISCOVERY        core/discover.ts        five feeds + launches read from the chain
    |
FAST SCREEN      core/analyze.ts         market, safety providers, evidence, Phase 1 gate
    |
DEEP ANALYSIS    intel/runner.ts         own loop, own budget: wallets, graph, wash, creator
    |  (stored)
DECISION         decision/*              every scan, from stored rows only, ~0.5 ms a token
    |
RANKING          core/ranking.ts         verdict tier, then rank
```

Six verdicts, in order: **Rejected** (at least one hard fail), **Insufficient
data**, **High risk** (serious soft risk on confident evidence), **Watch**,
**High potential** (safe, well covered, strong opportunity, real observed
momentum), **Qualified**. Within a tier, rank = opportunity - measured
integrity risk - what could not be checked. Full detail:
**[DECISION_ENGINE.md](DECISION_ENGINE.md)**; the fast screen and evidence
model: **[PIPELINE.md](PIPELINE.md)**.

Chain collection (**[DATA_BACKBONE.md](DATA_BACKBONE.md)**) and deep
intelligence (**[DEEP_INTELLIGENCE.md](DEEP_INTELLIGENCE.md)**) run beside the
scanner on their own bounded budgets. Deep analysis reaches 2-4 tokens a
cycle, chosen by stated priority; an unanalysed token is at most Qualified
and is charged for it in rank.

Everything is stored in SQLite (`node:sqlite`, WAL) and survives restarts:
tokens, verdict/market/holder/pool history, evidence, chain data,
intelligence, and every verdict transition (never pruned).
**[PERSISTENCE.md](PERSISTENCE.md)**.

Thresholds were reviewed against a replay of real stored history;
**[CALIBRATION.md](CALIBRATION.md)** records what changed, what did not, and
why most outcomes are still unknown.

## Dashboard

| Route | What it is |
|---|---|
| `/` | The Landing: what Token Finder is, how a verdict is reached, and the two ways in - **read one token** (the full pipeline on request, with its real stages) or **scan live** |
| `/discover` | The Observatory (a live network sphere with the few tokens that matter now, each surfaced for a stated reason) and the Board: candidates first, High risk and Rejected as their own segments; search, sort, keyboard (`/`, `j`/`k`, `Enter`) |
| `/t/:mint` | A token's Dossier: verdict and why; safety & integrity, opportunity, momentum and rank side by side; **Activity integrity**; **Rug intelligence**; integrity by domain; holders; **Deep Risk Analysis** (hands the mint to Solana Risk Radar); tabs for Evidence, History, Contract & holders |
| `/analyze/:mint` | One token analysed on request |
| `/changes` | Every verdict change with its reasons, plus market alerts |
| `/system` | What this instance can check, provider and persistence health, the decision policy and model versions, last scan timings |

Buildless ES modules, no framework ([docs/adr/](docs/adr/)). Freshness is
always visible: the top bar shows the connection and the last scan.

### Solana Risk Radar

A Dossier's **Deep Risk Analysis** opens
[Solana Risk Radar](https://solana-risk-radar.vercel.app) - a separate,
deterministic risk analyser - with the mint in the URL. The two products stay
separate: Risk Radar's score is its own and is never folded into Token
Finder's verdict. See [integrations/risk-radar/](integrations/risk-radar/).

## Commands

| Command | What it does |
| --- | --- |
| `node src/cli.ts serve` | Dashboard plus the monitor, chain collection and deep intelligence. The default. |
| `node src/cli.ts scan` | One discovery pass; prints the top 10 and any events. |
| `node src/cli.ts rank [n]` | The current ranking from stored state, no network. |
| `node src/cli.ts watch` | The monitor in the terminal, no dashboard. |
| `node src/cli.ts analyze <mint\|symbol>` | One token, with the full breakdown. |
| `node src/cli.ts discover` | The candidate mints each feed returned. |
| `node src/cli.ts ingest` / `chain` / `activity <mint>` | One chain-collection cycle; what has been collected; one token's trades and buyers. |
| `node src/cli.ts intel-run` / `intel <mint> [--run]` | One deep-intelligence cycle; one token's stored intelligence. |
| `node src/cli.ts calibrate [--db path] [--json out]` | Replay stored verdicts against measured outcomes (read-only; use a copy). |
| `node src/cli.ts db` / `reset` / `typesafe-check` | Database diagnostics; clear stored state; check TypeSafe credentials. |

| Script | What it runs |
| --- | --- |
| `npm run typecheck` | `tsc` over the server, then the browser code (JSDoc-typed). |
| `npm run lint` | `scripts/lint.mjs`: the render boundary, CSP-compatible markup and the persistence boundary. |
| `npm test` | Unit and integration tests, plus render-boundary tests for the browser code. |
| `npm run test:ui` | The product in a real headless Chrome or Edge, with real pointer, touch and key input. Skips, saying so, without a Chromium browser (`CHROME_PATH` overrides). |
| `npm run check` | All four. |

## Configuration

Copy `.env.example` to `.env`. Every key is optional - **the tool works
without any API key** (DexScreener, Jupiter, RugCheck); Helius adds on-chain
checks, chain collection and deep intelligence.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HELIUS_API_KEY` | - | On-chain authority, Token-2022, exact holders, chain collection, deep intelligence. |
| `BIRDEYE_API_KEY` | - | Birdeye's new-listing feed. |
| `PORT` / `HOST` | `5173` / `127.0.0.1` | Bind. Loopback by default (also `::1`); anything else exposes the dashboard, and turns on the public access limits. |
| `SCAN_INTERVAL_SEC` | `120` | Seconds between scans. |
| `LIVE_WINDOW_MIN` | `90` | How long a token stays on the live Board after its last evaluation. |
| `MIN_LIQUIDITY_USD`, `MAX_AGE_HOURS`, `MAX_ANALYZE_PER_SCAN` | `3000`, `168`, `60` | Discovery and fast-screen bounds. |
| `MIN_COVERAGE_QUALIFY` / `MIN_COVERAGE_WATCH` | `0.6` / `0.35` | Market-evidence coverage for Qualified / below which a token is Insufficient data. |
| `CATASTROPHIC_CONCENTRATION_PCT` | `90` | Top-holder share that hard-fails. |
| `INGEST_ENABLED`, `INTEL_ENABLED` | `true` | Chain collection and deep intelligence beside the monitor (`serve` only). |
| `INTEL_TOKENS_PER_CYCLE` / `INTEL_MAX_TOKENS_PER_CYCLE` | `2` / `4` | Tokens per deep cycle; more only when measured cost shows the budgets fit them. |
| `INTEL_REQUESTS_PER_CYCLE` / `INTEL_CYCLE_MAX_MS` | `150` / `90000` | The hard budget every deep stage draws on. |
| `RETENTION_HISTORY_DAYS` / `RETENTION_EVIDENCE_DAYS` | `90` / `14` | History kept; per-metric evidence kept for ordinary snapshots (transitions keep theirs). |
| `TOKEN_FINDER_DATA_DIR` | `data` | Where the database lives. |
| `PUBLIC_ORIGIN`, `ADMIN_TOKEN`, `ANALYZE_PER_*`, `SCAN_*`, ... | - | Public hosting; see [DEPLOYMENT.md](DEPLOYMENT.md). |
| `RISK_RADAR_URL` | `https://solana-risk-radar.vercel.app` | Where Deep Risk Analysis hands the mint. |
| `TYPESAFE_API_KEY` / `TYPESAFE_ENABLED` | - / `false` | Advisory impersonation screening. **Off**, and it never affects a verdict. |

The rest are in `.env.example` and the documents above. Keys are read only by
`src/config.ts`, server-side. No key is serialised into any response or
reaches the browser; `/api/status` reports booleans.

## API

View-shaped DTOs (`src/server/dto.ts`), gzipped over 1 KB.

| Endpoint | Returns |
| --- | --- |
| `GET /api/board?segment=&q=&sort=&limit=` | The live Board. |
| `GET /api/tokens/:mint` | The Dossier for one token, live or not. |
| `GET /api/tokens/:mint/history` | Verdict changes and the score, market and holder series. |
| `POST /api/analyze` `{"mint": "..."}` | Analyses one token; streams NDJSON `stage` lines, then `done`. Same-origin only. |
| `POST /api/scan` | Starts a scan. Same-origin only. |
| `GET /api/orb`, `/api/changes`, `/api/events` | The Observatory; verdict changes and alerts; recent events. |
| `GET /api/system`, `/api/status`, `/api/coverage` | Capabilities, health, policy, timings; scan state and active keys (booleans); live-universe coverage. |
| `GET /api/intel/:mint` | One token's stored deep intelligence (diagnostic). |
| `GET /api/stream` | SSE: `hello`, `scan-start`, `scan-stage`, `scan`, `scan-failed`, `decision`, `alert`. |
| `GET /healthz`, `/readyz` | Liveness; readiness (database healthy, recent scan). |

## Security

- **Locally**: loopback bind; a Host allowlist against DNS rebinding;
  same-origin `Origin` required on `POST`; a CSP with no `unsafe-inline` or
  `unsafe-eval`, plus `nosniff`, `frame-ancestors 'none'` and
  `Referrer-Policy: no-referrer`.
- **Publicly** (`HOST` not loopback): the Host and Origin must name
  `PUBLIC_ORIGIN`; analyses, manual scans, API reads and live streams are
  bounded per client and globally, refused with `429` and `Retry-After`
  (`src/server/access.ts`, [DEPLOYMENT.md](DEPLOYMENT.md)).
- Token names, symbols and links are attacker-controlled. The browser code has
  exactly one HTML sink, an escaping template that accepts only `http(s)` URLs
  and refuses event handlers and `style` attributes. `npm run lint` enforces
  it; `npm run test:ui` renders a hostile token and checks nothing executes.

## Rate limits

RugCheck is the bottleneck: self-limited to 30 requests a minute, cached for
20 minutes, so a cold scan of 60 tokens takes about two minutes. Each host has
its own queue (`src/util/http.ts`); a 429 cools that host only. Helius chain
reads are paced at 300 a minute; the public Solana endpoint at one a second.

## Documentation

| File | Contents |
| --- | --- |
| [DEMO.md](DEMO.md) | The one-minute path through the product, for reviewers. |
| [DECISION_ENGINE.md](DECISION_ENGINE.md) | Verdicts: the intelligence contract, rule versions, Hard Gate v2, integrity, opportunity, Momentum v2, the ladder, stability, ranking, re-decision. |
| [CALIBRATION.md](CALIBRATION.md) | The replay over real history, the outcome model, what changed and why, what stays uncalibrated. |
| [DEEP_INTELLIGENCE.md](DEEP_INTELLIGENCE.md) | Actor analysis: buyer classes, funding, the wallet graph, clusters, wash, attribution, security events, creator history, serial networks, scheduling, budgets. |
| [PIPELINE.md](PIPELINE.md) | The fast screen: provider validation, the evidence model, cross-provider resolution, the Phase 1 gate, coverage and confidence. |
| [DATA_BACKBONE.md](DATA_BACKBONE.md) | On-chain collection: launches, transactions, the canonical event model, budgets, gaps. |
| [PERSISTENCE.md](PERSISTENCE.md) | SQLite schema, migrations, deduplication, retention, failure behaviour. |
| [DATA_SOURCES.md](DATA_SOURCES.md) | Every provider, measured: what each returns and how it is used. |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Production architecture, access limits, storage, and how to deploy. |
| [SCORING.md](SCORING.md) | The Phase 1 market score (still shown beside the decision, never the ranking key). |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The architecture record and the long-range target design. |
| [ROADMAP.md](ROADMAP.md) | Status: what is implemented, provider-dependent, limited, or future. |
| [TECHNICAL_INTELLIGENCE.md](TECHNICAL_INTELLIGENCE.md) | **Future - not implemented.** A specification for chart-structure analysis. |
| [docs/adr/](docs/adr/) | Architecture decision records. |

## Caveats

- **Nothing here is financial advice.** A verdict says how a token looks on
  the evidence observed *now*; a new token can still go to zero minutes later.
- **Calibration is thin.** The replay drove two changes, but 98% of past
  decision points have no measured outcome, because tokens leave the feeds.
  Most thresholds remain reasoned starting points. High potential is currently
  unreachable for lack of momentum history and deep coverage.
- **Deep intelligence reaches few tokens** (2-4 a cycle); most live tokens are
  unanalysed at any moment, and the product says so.
- **Without a Helius key** there is no on-chain authority check, Token-2022
  inspection, exact holder math, chain collection or deep intelligence; those
  signals are UNAVAILABLE, never assumed clean.
- **Providers vary.** DexScreener can return different pair sets between reads,
  so the display pool can change; liquidity is only ever compared within one
  pool. Each adapter fails soft, so a provider outage degrades a scan with a
  stated reason rather than ending it.
- **Impersonation screening (TypeSafe/Jev) is off**, advisory only, and never
  affects a score, a ranking or a veto.
