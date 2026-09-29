# Roadmap and status

Audience: whoever plans Token Finder work or asks what it does today. The
four development phases are complete; this file states what exists, what
depends on a provider, what is limited, and what is future.

## Implemented

| Area | What | Detail |
|---|---|---|
| Data backbone (Phase 1) | Five discovery feeds plus launches read from the chain; validated provider data; an evidence model where unknown is never zero; cross-provider resolution, conservative for safety facts; SQLite persistence that survives restarts | PIPELINE.md, DATA_BACKBONE.md, PERSISTENCE.md |
| Deep intelligence (Phase 2) | Wallet profiles and buyer classes, funding, the wallet graph and clusters, wash and activity quality, launch attribution, security events, creator history and serial networks - on its own bounded loop | DEEP_INTELLIGENCE.md |
| Decision engine (Phase 3) | A normalised, rule-versioned intelligence contract; Hard Gate v2; seven-domain integrity; opportunity kept apart from safety; Momentum v2 from observed history; multi-pool coverage; six verdicts with persisted, reasoned transitions; re-decision after each intelligence cycle | DECISION_ENGINE.md |
| Calibration and finalisation (Phase 4) | A replay over real stored history with an outcome model that never uses price; verdict stability (danger at once, improvement on confirmation); same-pool liquidity and a collapse signal, from replay evidence; deep-analysis scheduling by stated priority and measured cost; re-decision of linked launches; evidence retention; public access limits, health checks and a container deployment; a product polish pass | CALIBRATION.md, DEPLOYMENT.md, DEMO.md |
| Product | Landing, on-request analysis, live scan, Board and Observatory, Dossier (Activity integrity, Rug intelligence, evidence, history), Changes, System | README.md, docs/adr/ |

## Depends on an optional provider

| Capability | Needs | Without it |
|---|---|---|
| On-chain authority, Token-2022 extensions, exact holder concentration | `HELIUS_API_KEY` | UNAVAILABLE, never assumed clean; RugCheck and Jupiter still inform authority |
| Chain collection and deep intelligence (Activity integrity, Rug intelligence) | Helius (oldest-first history is Helius-only) | collection falls back to the public RPC slowly; deep intelligence reads less and says so |
| Birdeye listing feed | `BIRDEYE_API_KEY` | four feeds instead of five |
| Impersonation screening | TypeSafe key **and** `TYPESAFE_ENABLED` | off by design; advisory only, never affects a verdict |

## Limited, and stated as such

- **Calibration**: 98% of past decision points have no measured outcome,
  because tokens leave the feeds; most thresholds are reasoned starting points
  (CALIBRATION.md §4).
- **High potential** is currently unreachable (no token above an opportunity
  of 61 against 65), for lack of momentum history and deep coverage.
- **Deep intelligence coverage**: 2-4 tokens a cycle by default (current
  production: 2 every 15 minutes, DEPLOYMENT.md §6); most live tokens are
  unanalysed at any moment and are at most Qualified.
- **Momentum** needs at least 20 minutes and three observations; SUSTAINED and
  ACCELERATING need about 1.5 hours.
- **Samples**: by default at most 12 wallets per token, the newest 100
  transactions per wallet and per mint (current production: 6 wallets and 30
  transactions per wallet; the mint window stays 100); wash and coordination readings rarely represent half
  the market, and are capped accordingly.
- **Deployment** is one instance by design (SQLite has one writer); it runs
  live on Oracle Cloud, Frankfurt (DEPLOYMENT.md §6).

## Future - not implemented

- **Outcome tracking after tokens leave the feeds** (reading their pools
  directly), which is what calibration needs most.
- **Technical intelligence** - chart structure from OHLCV candles
  ([TECHNICAL_INTELLIGENCE.md](TECHNICAL_INTELLIGENCE.md)). No code exists.
- **Realtime ingestion** (websocket/gRPC pool events instead of polled feeds).
- **Watchlists and alerts delivered outside the dashboard.**
- **Trading, in strict order and each gated on the last**: paper trading with
  real pool depth; risk limits enforced in the execution path; manual
  confirmation trading after a key-custody decision; capped automation;
  full automation. **None of this exists.** Token Finder holds no keys, signs
  nothing and trades nothing, and no wallet integration or key handling will
  be added without explicit approval.
