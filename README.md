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

`npm run serve`, `npm run scan` and friends are the same thing.

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
| `MAX_ANALYZE_PER_SCAN` | `60` | Cap on deep (rate-limited) safety lookups per scan. |

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
| `GET /api/status` | Scan count, last scan, which keys are active. |
| `GET /api/tokens?sort=&minScore=&maxAgeH=&minLiquidity=&q=&hideRisky=&limit=` | Filtered ranking. |
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
| [ROADMAP.md](ROADMAP.md) | Proposed development sequence and test strategy. |

Parts of those documents describe proposals; they are labelled **NOT IMPLEMENTED** where so.

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
- **There are no automated tests yet.** Verification so far is a typecheck plus live smoke
  scans. See [ROADMAP.md](ROADMAP.md) for the proposed test strategy.
- Two scoring defects are known and documented rather than fixed, so this baseline stays
  honest about them: absent market data currently earns neutral points, and a RugCheck
  `danger` authority finding does not trigger the authority penalty. See
  [SCORING.md](SCORING.md) sections 5.1 and 5.2.
