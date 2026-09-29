# Demo path

Audience: a judge or first-time reviewer with a few minutes. Open the live
instance at **<https://130-61-32-89.sslip.io>**. Everything shown is live data; no token is hard-coded or staged, so the tokens you see will
differ from any screenshot.

## In one minute

| Step | Where | What it shows |
|---|---|---|
| 1 | **Landing** `/` | What Token Finder is. Scroll once: *How a verdict is reached* - real data with its source, safety before and apart from opportunity, who is behind the activity, verdicts that explain themselves |
| 2 | **Scan live** (or *open the Live Board without scanning*) | A real scan with its real stages and counts - feeds read, candidates found, market data, safety checks, evaluated *k* of *n*. No percentage bar: the pipeline has none |
| 3 | **Board** `/discover` | The Observatory and the live ranking. Candidates first; High risk and Rejected are their own segments. Each row: why, rank (its ring is how much was covered), integrity band and momentum |
| 4 | **A candidate's Dossier** `/t/<mint>` | The verdict and its reason; four separate numbers - safety & integrity, opportunity, momentum, rank - never combined |
| 5 | **Activity integrity** (Dossier) | Who traded it - organic, automated, snipers, coordinated - by wallets, trades and volume, with unknown always drawn; wash risk; wallet independence; how much of the market was observed |
| 6 | **Rug intelligence** (Dossier) | The token, its creator and their network: security events, the creator's other launches, relationship paths - and what could not be read |
| 7 | **Evidence** and **History** tabs | Every signal with each provider's claim and which reading won; every verdict change with its reasons |

## What to notice

- **The data is real.** The top bar shows when the last scan ran; System shows
  provider health, which checks are on, degraded or off, and the last scan's
  timings. Nothing is simulated. The live instance runs a reduced RPC
  profile - a scan and a chain-collection cycle every 5 minutes, deep
  intelligence every 15 - so the last scan can be up to 5 minutes old.
- **Safety and opportunity are separate.** A token can have strong momentum
  and still be Rejected; momentum never lifts a verdict. Open a **Rejected**
  token from its segment: its hard fail is named with the evidence.
- **Unknown is never zero.** A Dossier lists what was not measured and why;
  an unanalysed token is at most Qualified and is charged for it in rank.
- **Verdicts are explained and stable.** The *Why* panel lists reasons, risks
  and what blocks a better verdict. Danger applies at once; a better verdict
  must be confirmed by a second reading (the reason says "held" meanwhile).
- **Buyer, wallet and rug intelligence decide things.** A High risk token
  usually shows why in Activity integrity or Rug intelligence - snipers,
  coordinated wallets, disputed concentration, a same-pool liquidity collapse,
  or a creator's history.

## Picking tokens to show

Use the Board's segments: **Candidates** for a clean read, **High risk** for
intelligence at work, **Rejected** for a hard fail. The search (`/`) finds any
token by symbol, name or mint, live or historical; `j`/`k` move and `Enter`
opens.

## Running it locally

```bash
node src/cli.ts serve     # http://localhost:5173
```

It works without any key (DexScreener, Jupiter, RugCheck). With
`HELIUS_API_KEY` in `.env`, on-chain checks, chain collection and deep
intelligence switch on - the Activity and Rug panels need it.
