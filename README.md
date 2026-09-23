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
`npm test` runs the test suite; `npm run check` runs the typecheck and the tests together.

## Configuration

Copy `.env.example` to `.env`. Every key is optional — **the tool works fully
without any API key.**

| Variable | Default | Meaning |
| --- | --- | --- |
| `HELIUS_API_KEY` | — | Adds on-chain mint/freeze authority and holder concentration. |
| `BIRDEYE_API_KEY` | — | Adds Birdeye's new-listing feed. |
| `PORT` | `5173` | Dashboard port. |
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

**5. Store** (`src/core/store.ts`) keeps everything in `data/state.json`,
written through a temp file so a crash cannot truncate it. Each token keeps up
to 240 history points for the dashboard sparklines.

## Dashboard

Sortable table with live SSE updates, filters for score, age, liquidity and
critical risk, a live event feed, and a detail drawer per token showing the
score breakdown bar by bar, every risk flag, score and price sparklines, and
links out to DexScreener, Jupiter, RugCheck and Solscan. Press `/` to search.

## API

| Endpoint | Returns |
| --- | --- |
| `GET /api/status` | Scan count, last scan, which keys are active (booleans), corpus evidence coverage. |
| `GET /api/coverage` | Evidence coverage, confidence, lifecycle states, eligibility counts and vetoes across the corpus. |
| `GET /api/tokens?sort=&minScore=&maxAgeH=&minLiquidity=&minCoverage=&eligibility=&q=&hideRisky=&limit=` | Filtered ranking. Shows `QUALIFIED` and `WATCH` by default; `eligibility=all` reveals rejected and low-data tokens. |
| `GET /api/tokens/:mint` | One snapshot plus its history. |
| `GET /api/events?limit=` | Recent monitor events. |
| `POST /api/scan` | Triggers a scan. |
| `GET /api/stream` | SSE: `alert` and `scan` events. |

## Rate limits

RugCheck is the bottleneck — this tool self-limits to 30 requests/minute
against it, which is why a cold scan of 60 tokens takes about two minutes.
Results are cached for 20 minutes, so later scans are far faster. Every host
has its own queue in `src/util/http.ts`; 429s set a cooldown for that host only.

## Documentation

| File | Contents |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | What exists today, stage by stage, plus the proposed target architecture, trading modes, decision engine, persistence and performance model. |
| [DATA_SOURCES.md](DATA_SOURCES.md) | Measured live validation of all five providers, the fields we actually receive, and the proposed provider strategy. |
| [SCORING.md](SCORING.md) | Full scoring audit: every component, weight and penalty, with measured weaknesses. |
| [PIPELINE.md](PIPELINE.md) | **The analysis path as implemented**: provider validation, evidence model, cross-provider resolution, safety gate, coverage/confidence, eligibility and lifecycle. |
| [ROADMAP.md](ROADMAP.md) | Proposed development sequence and test strategy. |

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
  first where available.
- Third-party endpoints change. Each adapter in `src/sources/` fails soft, so a
  changed endpoint degrades the scan rather than breaking it — if a feed goes
  quiet, check it there first.
- **Test coverage is partial.** 124 tests cover provider validation, evidence resolution,
  the safety gate, coverage, eligibility, the lifecycle and the Jev failure paths, over a
  deterministic 14-scenario fixture corpus. Discovery, the HTTP layer, the store and the
  dashboard still have no tests. See [ROADMAP.md](ROADMAP.md) for the rest.
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
- Scores are still uncalibrated against outcome data, and there is no hard veto: a dangerous
  token is penalised, never excluded.
