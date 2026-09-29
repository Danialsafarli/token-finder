# Data backbone

Audience: engineers building the next intelligence phases (buyer authenticity,
wallet graph, creator history) on top of what Token Finder now collects.

This phase builds the **substrate**, not the intelligence. It reads the chain,
records what it read with provenance, states what it did not read, and makes no
judgement about any wallet, buyer or creator. Nothing here changes a score, a
veto, provider precedence or the evidence model.

---

## 1. Provider capability matrix

Verified 2026-09-27 on this build. "Live" means a real response was received
and parsed in that session; "unit-tested only" means the code path exists and
is tested against recorded payloads but has not seen a live response.

| Fact | Source | Role | Key | Raw / indexed | Freshness | Rate limit | On failure | Status |
|---|---|---|---|---|---|---|---|---|
| New-token discovery | Jupiter `recent`, `toporganicscore` | primary | none | indexed | provider feed | 120/min (our cap) | feed contributes nothing | **live** |
| New-token discovery | DexScreener profiles, boosts | secondary | none | indexed | provider feed | 120/min (our cap) | feed contributes nothing | **live** |
| New-token discovery | **pump.fun launches, on-chain** | layered with the feeds | none (public RPC) | **raw on-chain** | finalized, ~1 cycle | see RPC below | cycle PARTIAL/FAILED, gap recorded | **live** |
| New-token discovery | Birdeye new listings | optional | `BIRDEYE_API_KEY` | indexed | - | 50/min (our cap) | returns nothing | unit-tested only (no key) |
| Price, liquidity, volume, txn counts | DexScreener pairs | primary | none | indexed | provider rolling windows | 120/min (our cap) | metric UNAVAILABLE | **live** |
| Price, liquidity, holders, audit | Jupiter search | fallback / cross-check | none | indexed | provider | 120/min (our cap) | metric UNAVAILABLE | **live** |
| Risk findings, authority, LP | RugCheck summary | primary report | none | indexed | 20-min cache | 30/min (our cap) | UNAVAILABLE, not cached | **live** |
| Mint/freeze authority (chain) | Helius `getAccountInfo` | authoritative when keyed | `HELIUS_API_KEY` | raw | per scan, 10-min cache | 300/min (our cap; 120 until [DEEP_INTELLIGENCE.md](DEEP_INTELLIGENCE.md) §12) | UNAVAILABLE | parser **live-verified via public RPC**; keyed path not run |
| Token program, Token-2022 extensions | Helius `getAccountInfo` | only source | `HELIUS_API_KEY` | raw | per scan | as above | UNAVAILABLE | parser **live-verified via public RPC** (USDC, BONK, PYUSD, a fresh launch); keyed path not run |
| Exact holder concentration | Helius `getTokenLargestAccounts` | only source | `HELIUS_API_KEY` | raw | per scan | as above | concentration UNKNOWN (null) | public RPC returns 429 unconditionally - **verified to degrade to UNKNOWN, not 0** |
| Transaction history | `getSignaturesForAddress` | backbone | none (public) / Helius / custom | raw | finalized | see RPC below | cycle PARTIAL, gap | **live** |
| Parsed transactions, balances, transfers | `getTransaction` (jsonParsed, v1) | backbone | as above | raw | finalized | see RPC below | fetch_failed gap | **live** |
| Swaps, liquidity events | derived from pool balance changes | backbone | - | **derived** | as above | - | UNRESOLVED with reason | **live** |
| Impersonation | TypeSafe | advisory, disabled | `TYPESAFE_API_KEY` | - | - | - | "not assessed" | disabled by design |

**The Solana RPC endpoint**, in order of preference: `SOLANA_RPC_URL`, Helius
when `HELIUS_API_KEY` is set, otherwise the public mainnet endpoint. The
endpoint in use is recorded on every row (`solana-rpc:public`,
`solana-rpc:helius`, `solana-rpc:custom`) and shown on the System page.

**Measured rate limit of the public endpoint.** Documented: 100 requests per
10 s per IP, 40 per 10 s per method (Tier 1, solana.com/docs/references/
clusters). Measured for `getTransaction`: at 2.5 requests/s, 19 of 30 were
refused with HTTP 429 and `Retry-After: 10`; at 1/s, 30 of 30 succeeded. The
backbone therefore paces that host at **60 requests/min**, and counts every
429 it receives, including ones a retry recovered from.

**Keyed mode was not verified in this phase: no `HELIUS_API_KEY` or
`BIRDEYE_API_KEY` is configured.** The on-chain safety parser was verified on
live mainnet accounts through the public endpoint (`scripts/verify-live.ts`),
which exercises the same `parseMint` the Helius path uses; the Helius request
itself, and Helius's own rate limits, remain unexercised.

---

## 2. Layered discovery

```
  ON-CHAIN DISCOVERY        pump.fun creations, read from the chain
+ AGGREGATOR DISCOVERY      Jupiter, DexScreener (and Birdeye when keyed)
+ PROVIDER ENRICHMENT       market data, RugCheck - unchanged
```

**How launches are found without a firehose.** pump.fun's mint authority is a
PDA, `TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM`, that takes part only in
token creation. The signatures that reference it are, with failures filtered
out, exactly pump.fun's launches - about 25-33 a minute when measured. Each is
fetched and read by `ingest/launch.ts` from facts the node itself parsed:
`initializeMint2` (mint, decimals, the PDA as authority), `mintTo` (supply),
the owner of the supplied account (the bonding curve), cross-checked against
the account created for pump.fun's program.

**Canonical identity is the mint.** A launch younger than
`CHAIN_CANDIDATE_WINDOW_MIN` joins discovery as the `chain:pumpfun` feed, so a
mint seen on-chain and by an aggregator is one candidate carrying both
sources. `token_discoveries` records the first and latest sighting per source,
which is how "does the chain see tokens first" is answered
(`ChainRepository.chainLead`, shown on the System page).

**Being seen on-chain is provenance, never a verdict.** A chain candidate faces
exactly the same fast screen as any other. In the first live session, four
chain-discovered tokens passed that screen into full analysis.

**Measured in the first live session** (25 mints seen both ways): a feed first
listed a pump.fun launch a median **43 s after its launch block** - that is how
much earlier the chain has it. Token Finder's own chain path observed them
later than its feed scans did (median 66 s), because it runs in budgeted
cycles and started with a backlog. The System page shows both figures; the
first is the ceiling a keyed, faster collector could approach.

---

## 3. The processing budget

```
FAST SCREEN   the existing scan: batched market data, the gate, eligibility
    |           cheap per token; rejects most of what is discovered
    v
SURVIVORS     QUALIFIED or WATCH, evaluated within the live window
    |
    v
DEEP DATA     the survivor's pool history, one RPC call per transaction
COLLECTION      budgeted: INGEST_TOKENS_PER_CYCLE x INGEST_TX_PER_TOKEN
```

`ingest/budget.ts` decides; `ingest/runner.ts` fetches. Order within the
survivors: QUALIFIED before WATCH, then the pool collected longest ago, then
liquidity - so every survivor is revisited in turn. What is left out is
counted by reason (not a survivor, not live, no pool, over budget) and shown.

A cycle runs every `INGEST_INTERVAL_SEC` after the previous one finished, in
its own loop beside the scanner. The scanner does not depend on it.

---

## 4. Transaction reading, and what stays unresolved

`ingest/normalize.ts` turns a `getTransaction` result into facts only: exact
BigInt balance changes per token account and per account in lamports, and the
node's own parsed instructions - token transfers, SOL transfers, mint
creations, `mintTo`, `setAuthority`, account creations - each with a stable
path (`2.13`). Absent fields stay unknown; impossible ones are issues.

`ingest/activity.ts` reads what a transaction did to **one pool**, anchored on
the pool's own balance change, because the fee payer's is wrong too often on
real traffic (relayers, routers, rent refunds; see the fixtures):

| Pool's token | Pool's other asset | Reading |
|---|---|---|
| up | down | SWAP, the trader SOLD |
| down | up | SWAP, the trader BOUGHT |
| up | up | LIQUIDITY_ADDED |
| down | down | LIQUIDITY_REMOVED |
| - | - | UNRESOLVED, with the reason |

The trader is the owner whose change mirrors the pool's: `EXACT` to the base
unit, `APPROXIMATE` when a transfer fee or similar makes the amounts differ,
`AMBIGUOUS` when several owners moved, `NET_ZERO` when nobody outside the pool
kept a change (a route or arbitrage through it). The trade is recorded in every
case; the trader is named only when the balances settle who it was.

Unresolved reasons: `pool_side_not_found` (the pool does not own its reserves
and the shape does not identify who does), `pool_side_mixed_assets` (a shared
vault authority moving a third asset - two pools of one program in one
transaction), `no_counter_asset`. Failed transactions are not fetched: they
moved nothing, and the budget is better spent on ones that did.

---

## 5. The canonical event model

| Type | Evidence | Raw / derived | Stored in |
|---|---|---|---|
| TOKEN_DISCOVERED | a feed or the chain surfaced the mint | raw sighting | `token_discoveries` |
| POOL_CREATED | the curve holding a launch's supply | derived (confidence 1 when confirmed by account creation, 0.7 when not) | `chain_events` |
| TOKEN_MINT | a parsed `mintTo` | raw | `chain_events` |
| AUTHORITY_CHANGE | a parsed `setAuthority` | raw | `chain_events` |
| SWAP | opposite pool reserve changes | derived | `pool_activity` |
| LIQUIDITY_ADDED / REMOVED | same-direction pool reserve changes | derived | `pool_activity` |
| TOKEN_TRANSFER | a parsed token transfer between two non-pool owners | raw | `transfer_edges` |
| SOL_TRANSFER | a parsed system transfer between two keypair accounts, >= 0.01 SOL | raw | `transfer_edges` |
| HOLDER_SNAPSHOT / MARKET_SNAPSHOT | a scan's provider readings | raw (provider) | `holder_snapshots` / `market_snapshots` (unchanged) |

**Not implemented: WALLET_FUNDED.** "Funded" is a claim about the first SOL a
wallet received, which needs the wallet's own history. The SOL transfer edges
are its raw input; the claim belongs to the wallet-graph phase.

Every row carries `source`, chain time (`block_time`) separately from our time
(`recorded_at`), and - where interpretation was needed - `derived`,
`confidence` or a resolution column. Canonical ids (`events.ts`) are hashes of
what makes two observations the same fact, so duplicates collapse on insert.

**Wallet vs program account.** `chain/address.ts` tests whether an address is
on the ed25519 curve, mirroring Solana's `is_on_curve`. A keypair's key is on
the curve; a PDA (pool, vault authority, bonding curve, token account) is not.
Verified on every signer in the fixtures (all on-curve) and on known PDAs (all
off). It is a cryptographic fact, stored as `wallets.on_curve`.

---

## 6. Storage (migration 2)

| Table | Writer | Reader | Retention |
|---|---|---|---|
| `token_discoveries` | scan (every candidate, every source) | `discoveriesOf`, `chainLead` (System, CLI) | `RETENTION_CHAIN_DAYS` |
| `token_launches` | launch discovery | chain candidates (discovery), `launchesByFeePayer` (creator phase), budget (launch pool) | `RETENTION_LAUNCH_DAYS` unless the mint is tracked |
| `chain_transactions` | every fetch | `knownSignatures` (dedupe), stats | chain days |
| `pool_activity` | survivor collection | `activityOf` (CLI), stats; buyer phase | chain days; cascades with the token |
| `transfer_edges` | survivor collection | `edgesOf` (wallet-graph phase), stats | chain days |
| `wallets` | traders, launch fee payers | `buyerArrivals`, stats; wallet phase | chain days |
| `wallet_token_activity` | each newly inserted trade | `buyerArrivals` (CLI) - buyer arrival order | chain days; cascades |
| `chain_events` | launches, survivor collection | `eventsOf` (CLI) | chain days |
| `ingest_cursors` | every collected address | the runner (resume) | token days |
| `ingest_gaps` | every uncollected stretch | stats (System, CLI) | chain days |

Raw amounts are TEXT, as in migration 1. Every insert is idempotent and the
counters above them move only with a newly inserted row, so re-ingesting after
a restart is free and harmless.

---

## 7. What is collected now, and the holes in it

Collected from the first cycle onward, with no backfill:

- every pump.fun launch the budget reaches: mint, launch time, fee payer, curve,
  supply, whether the mint authority was revoked, the fee payer's initial buy;
- for each survivor's pool: every successful transaction the budget reaches,
  as trades (direction, amounts, reserve price, trader) or stated
  non-trades; buyer first arrival per wallet; wallet-to-wallet token and SOL
  movements;
- first sighting of every candidate by every source;
- the existing market, holder and pool snapshots, unchanged.

**Gaps are rows, not silence.** `ingest_gaps` records, with reason, slot range
and count where known:

| Reason | Meaning |
|---|---|
| `before_collection_began` | history before an address was first collected - not reconstructed |
| `over_budget` | seen, not fetched: the cycle's budget was spent on newer ones |
| `page_limit` | more than one page (1000) arrived since the cursor; the rest were never listed |
| `fetch_failed` | listed, the fetch failed (usually 429); moved past, not retried |

---

## 8. Health

| State | When |
|---|---|
| AVAILABLE | the last cycle's calls all succeeded |
| PARTIAL | some calls failed or were throttled; what they missed is in `ingest_gaps` |
| FAILED | every call in the last cycle failed |
| STALE | no successful cycle for three intervals |
| UNAVAILABLE | switched off, not started, or no database |

None of these affects scanning, scoring or any verdict.

---

## 9. Measured performance

`node --expose-gc scripts/bench-backbone.ts` (5000 fixture-derived
transactions, on-disk SQLite, this machine):

| Measure | Result |
|---|---|
| parse + derive | 0.037 ms/tx (~27,000 tx/s) |
| write, one commit per transaction | 0.34 ms/tx (~2,900 tx/s) |
| duplicate re-ingest | 0.055 ms/tx, 0 rows inserted |
| known-signature check, 1000-signature page | 8 ms |
| restart (reopen + migration check) | 3 ms; every row intact |
| budget plan, 5000 tokens | 1.8 ms |
| 200 cycles x 30 transactions | 21 ms/cycle of processing; heap flat (120.6 -> 120.8 MB) |
| storage | ~1.1 KB per collected transaction, all tables and indexes |

**The bottleneck is acquisition, by three orders of magnitude.** The public
endpoint gives about one transaction a second; processing handles thousands.
At the default budget a cycle is ~120 calls, ~2 minutes; about 60% of
pump.fun's launches are read and the rest are recorded as `over_budget`.

**The next real bottleneck after acquisition is storage**: at the public
endpoint's pace, ~60,000 transactions a day, ~65 MB a day. `RETENTION_CHAIN_DAYS`
(default 30) bounds it at ~2 GB. A keyed endpoint that raises acquisition 10x
raises this 10x too, and would make trimming `pool_activity`'s redundant
columns (fee payer, repeated with the ledger) worth doing.

---

## 10. Known limitations

- **Keyed mode is unverified** (no key configured). The code path is shared -
  only the URL differs - but Helius's own responses and limits are unexercised.
- **pump.fun is the only on-chain launch venue.** Other launchpads and direct
  AMM pool creation are not read from the chain; their tokens still arrive
  through the aggregator feeds.
- **The public endpoint cannot keep up with every launch.** ~60% at the
  default budget; the remainder are counted gaps.
- **Survivor collection is recent-first.** A busy pool's older trades beyond
  the budget are counted gaps, not collected later.
- **Shared-authority pools** (Raydium AMM v4, CPMM, Meteora DAMM) are read
  through a conservative inference; a route through two pools of one program,
  or a trade split across several pools in one transaction, is UNRESOLVED
  (`pool_side_not_found`). Seen live on Meteora.
- **No-op transactions are common.** Bots invoke programs that reference a pool
  and move nothing; they read as NO_POOL_ACTIVITY, truthfully, and are kept -
  12 of 94 PumpSwap readings in the first live session.
- **`fee_payer` is recorded, not "creator".** pump.fun names a creator in
  instruction data this phase does not decode.
- **"First observed" is Token Finder's observation**, not a wallet's first
  transaction on Solana.
- **No liquidity lock, LP burn or pool-state decoding.** LIQUIDITY events come
  from reserve changes only.
- **Concentration without a key stays UNKNOWN.** The public endpoint refuses
  `getTokenLargestAccounts`.

---

## 11. Deliberately not built in this phase

Buyer organic probability, bot or sniper classification, wash-trading score,
wallet coordination, creator reputation, serial-rugger classification, new
hard-reject rules, scoring-weight changes, Momentum v2, trading. The tables
above are their inputs; none of them reads or writes a verdict.

---

## 12. Operating it

| Variable | Default | |
|---|---|---|
| `INGEST_ENABLED` | `true` | the collection loop (server only) |
| `INGEST_INTERVAL_SEC` | 60 | pause after each cycle |
| `INGEST_TOKENS_PER_CYCLE` | 6 | survivors collected per cycle |
| `INGEST_TX_PER_TOKEN` | 10 | transactions per survivor per cycle |
| `LAUNCH_DISCOVERY_ENABLED` | `true` | read pump.fun launches |
| `LAUNCH_TX_PER_CYCLE` | 60 | launches fetched per cycle |
| `CHAIN_CANDIDATE_WINDOW_MIN` | 30 | launches this young join discovery |
| `CHAIN_CANDIDATE_MAX` | 150 | at most this many per scan |
| `RETENTION_CHAIN_DAYS` | 30 | chain history kept |

These are code defaults. Current production collects every 300 s with 3
survivors, 5 transactions and 1 pool per survivor, and 20 launches per cycle
(DEPLOYMENT.md §6).
| `RETENTION_LAUNCH_DAYS` | 30 | untracked launches kept |
| `SOLANA_RPC_URL` | unset | any RPC endpoint; treated as a secret |

CLI: `node src/cli.ts ingest` (one cycle, with its report), `chain` (what has
been collected), `activity <mint>` (a token's trades, buyers, sightings).
`node scripts/verify-live.ts` re-runs the live verification;
`node --expose-gc scripts/bench-backbone.ts` re-runs the benchmark.
