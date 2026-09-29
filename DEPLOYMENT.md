# Deployment

Audience: whoever hosts Token Finder publicly. Status: **live** at
<https://130-61-32-89.sslip.io> - Oracle Cloud, Frankfurt, deployed with §5
(see §6).

## 1. What Token Finder needs from a host

Token Finder is not a static site and not a serverless app. It is **one
long-lived Node 24 process** that runs the dashboard, the scanner, chain
collection and deep intelligence side by side, over **one SQLite database**.

| Requirement | Why |
|---|---|
| A process that stays up | the scanner runs on an interval (2 min by default, 5 min in current production, §6); the product is what it has observed |
| A persistent disk for `/data` | SQLite is the history; losing it on restart loses the product |
| Exactly one instance | SQLite has one writer; two machines would each keep a different history |
| Server-side secrets | `HELIUS_API_KEY` and friends are read only by `src/config.ts` and never reach the browser |
| HTTPS in front | the dashboard is public; the app itself speaks plain HTTP behind a proxy |

Serverless platforms (Vercel, Netlify, Lambda) meet none of the first three,
and are therefore not an option.

## 2. What is in the repository

| File | What it is |
|---|---|
| `Dockerfile` | Node 24 slim, `package.json` and `src/` only - zero runtime dependencies, no build step. Runs as the unprivileged `node` user, database at `/data`, health check on `/healthz`, `SIGTERM` closes the database cleanly |
| `fly.toml` | Fly.io: one machine, a 10 GB volume at `/data`, never auto-stopped, readiness check on `/readyz`, HTTPS forced |
| `deploy/docker-compose.yml` | any Docker host behind your own HTTPS proxy |
| `.dockerignore` | keeps `.env`, `data/` and every database file out of the image |

### Health

| Endpoint | Meaning |
|---|---|
| `GET /healthz` | liveness: the process answers |
| `GET /readyz` | readiness: the database is open and healthy, and a scan completed recently (or the process only just started). 503 otherwise, with the reason |

Both answer whatever Host the platform sends.

### Restarts and integrity

SQLite runs in WAL mode; every write is a transaction. Verified: a scan, then
a **hard kill** (no shutdown handler) and a restart - the same scan count and
verdict counts, `PRAGMA integrity_check` ok. A normal stop (`SIGTERM`) closes
the database first.

## 3. Configuration for public hosting

Set as secrets or environment on the host, never in the image:

| Variable | Required | Meaning |
|---|---|---|
| `HELIUS_API_KEY` | strongly recommended | on-chain authority, Token-2022, exact holders, chain collection and deep intelligence |
| `BIRDEYE_API_KEY` | optional | one more discovery feed |
| `PUBLIC_ORIGIN` | **yes** | the exact origin visitors use, e.g. `https://token-finder.fly.dev`. The Host header must name it and state-changing requests must come from it |
| `ADMIN_TOKEN` | optional | an operator secret; `Authorization: Bearer <token>` bypasses the limits below |
| `HOST`, `PORT`, `TOKEN_FINDER_DATA_DIR`, `TRUST_PROXY` | set by the image | `0.0.0.0`, `8080`, `/data`, `true` |

### Access limits (only when not bound to loopback)

The public product stays usable - the Board, Dossiers, Changes, System and
the live stream are open - but nobody can spend the provider budget without
limit (`src/server/access.ts`):

| What | Default | Variable |
|---|---|---|
| Analyses per client per hour | 12 | `ANALYZE_PER_CLIENT_PER_HOUR` |
| Analyses per hour, everyone | 120 | `ANALYZE_PER_HOUR` |
| Minimum time between manual scans, anyone | 300 s | `SCAN_MIN_INTERVAL_SEC` |
| Manual scans per client per hour | 3 | `SCAN_PER_CLIENT_PER_HOUR` |
| API reads per client per minute | 300 | `API_READS_PER_MINUTE` |
| Concurrent live streams | 200 | `MAX_STREAMS` |

Refusals are `429` with `Retry-After`; the UI shows the reason. The scheduled
scanner is unaffected. Behind the proxy the client is the first
`X-Forwarded-For` address (`TRUST_PROXY=true`, set by the image).

### Storage

Measured growth on the development database was ~67 MB a day, dominated by
per-metric evidence. Evidence of ordinary snapshots is kept 14 days
(`RETENTION_EVIDENCE_DAYS`); the evidence behind verdict transitions, history
90 days, chain data 30 days and unseen tokens 180 days follow the other
`RETENTION_*` settings (PERSISTENCE.md). Expect a steady state of roughly
3-4 GB; the volume is sized at 10 GB.

## 4. Deploy on Fly.io

```bash
fly auth login
fly launch --no-deploy --copy-config --name <app>      # keeps fly.toml
fly volumes create token_finder_data --size 10 --region fra
fly secrets set HELIUS_API_KEY=... PUBLIC_ORIGIN=https://<app>.fly.dev
fly deploy
curl https://<app>.fly.dev/readyz
```

Never `fly scale count` above 1.

## 5. Deploy on any Docker host

```bash
HELIUS_API_KEY=... PUBLIC_ORIGIN=https://tokens.example.com \
  docker compose -f deploy/docker-compose.yml up -d
```

and point an HTTPS reverse proxy (Caddy: `reverse_proxy 127.0.0.1:8080`) at it.

## 6. Current production

§5 on one Oracle Cloud Always Free ARM VM (`VM.Standard.A1.Flex`, 1 OCPU,
2 GB) in Frankfurt, Ubuntu 24.04:

| Piece | How |
|---|---|
| App | `deploy/docker-compose.yml`, unchanged, one container on `127.0.0.1:8080` |
| HTTPS | Caddy with automatic certificates, `reverse_proxy 127.0.0.1:8080`; port 8080 is closed to the internet |
| Storage | a separate 50 GB block volume mounted by UUID; a host-side compose override binds the `token-finder-data` volume onto it, and Docker is ordered after the mount so a restart can never start on an empty directory |
| Secrets | `HELIUS_API_KEY` and `PUBLIC_ORIGIN` in a root-only `.env` (mode 600) on the host |
| Configuration | the same override adds `env_file: /opt/token-finder/.env`, so every key in that file reaches the app. `deploy/docker-compose.yml` on its own forwards only the four keys it names; tuning variables need this line |
| Recovery | verified with a real reboot: Docker, Caddy and the container returned on their own, with the same scan count and database |

### Competition RPC profile

Production runs a reduced profile that bounds Helius usage while keeping every
capability on. It is set in the host `.env`; the code defaults (and
`.env.example`) are unchanged, and so is every rule that reaches a verdict.

| Variable | Production | Code default |
|---|---|---|
| `SCAN_INTERVAL_SEC` | 300 (5 min) | 120 |
| `INGEST_INTERVAL_SEC` | 300 (5 min) | 60 |
| `INGEST_TOKENS_PER_CYCLE` | 3 | 6 |
| `INGEST_TX_PER_TOKEN` | 5 | 10 |
| `INGEST_POOLS_PER_TOKEN` | 1 | 2 |
| `LAUNCH_TX_PER_CYCLE` | 20 | 60 |
| `INTEL_INTERVAL_SEC` | 900 (15 min) | 300 |
| `INTEL_TOKENS_PER_CYCLE` | 2 | 2 |
| `INTEL_MAX_TOKENS_PER_CYCLE` | 2 | 4 |
| `INTEL_WALLETS_PER_TOKEN` | 6 | 12 |
| `INTEL_TX_PER_WALLET` | 30 | 100 |
| `INTEL_GRAPH_DEPTH` | 1 | 2 |
| `INTEL_REQUESTS_PER_CYCLE` | 50 | 150 |

The effective values are visible at runtime: `/api/status` reports
`scanIntervalSec`, `/api/system` reports `ingestion.intervalSec` and
`intelligence.intervalSec`, and the startup log prints all three. Smaller
samples show up as more truncations and lower coverage, never as a cleaner
verdict.
