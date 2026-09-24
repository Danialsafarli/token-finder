# Technical Intelligence Engine

> **STATUS: PLANNED / FUTURE — NOT IMPLEMENTED.**
> No code in this repository implements any part of this document. There are no
> detectors, no OHLCV provider, no indicators, no chart overlays. This is a
> design specification and a research record. Nothing here has been validated
> against market outcomes.

Audience: engineers and reviewers evaluating Token Finder's architecture.
Scope: what the Technical Intelligence layer should become, why, and what it
must refuse to claim.

---

## 1. Purpose, and what this is not

Token Finder currently answers *is this token structurally safe and is anyone
really trading it?* Technical Intelligence would answer a different question:
*what shape is this market in, and what would have to happen for that shape to
mean something?*

It is a **separate intelligence layer**. It does not join the Risk Score. The
existing `score.total` measures safety and liquidity quality; folding chart
geometry into it would corrupt a number that currently means something specific.
The Decision Engine (a later phase) is the only component permitted to combine
them.

**What it is not:**

- Not a price predictor. See §2.3 — the evidence does not support that claim.
- Not a signal generator. It produces *states, evidence and scenarios*.
- Not an indicator library. No RSI/MACD dashboards; those are derived
  quantities that add nothing the raw series does not already contain.
- Not a replacement for Momentum Intelligence (§22.3 draws the boundary).

### 1.1 The constraint that shapes everything

Two measured facts about this specific product:

**There is no OHLCV data anywhere in the stack today.** DexScreener returns
*aggregate windows* (`m5`, `h1`, `h6`, `h24` volume and price-change scalars),
not candles. It publishes no candle, OHLC or historical endpoint. Every pattern
in this document requires a candle series that Token Finder currently cannot
obtain. The data layer (§4) is therefore the largest single piece of work, not
the detectors.

**Most tokens Token Finder analyses are too young for classical patterns.**
From a live scan of 30 analysed tokens:

| | |
|---|---|
| minimum age | 0.38 h (23 minutes) |
| 25th percentile | 3.0 h |
| median | 26.1 h |
| under 1 hour | 5 of 30 |
| under 24 hours | 15 of 30 |

At the median (26 h) a token has ~26 hourly candles, ~6 four-hour candles and
**one** daily candle. At the 25th percentile it has three hourly candles. A
Cup-and-Handle needs 100+ bars. A Head-and-Shoulders needs five confirmed
pivots, realistically 40+ bars.

**Conclusion that drives the whole catalog:** a Technical Intelligence engine
for newly launched tokens is mostly a *market-structure and breakout* engine
operating on 1m/5m/15m, not a classical chart-pattern scanner. Patterns that
need long history are specified here for completeness and for the minority of
older tokens, but they are explicitly **not** in the recommended initial
implementation set (§13.4).

---

## 2. Research foundation

### 2.1 Sources consulted

| Area | Source |
|---|---|
| Automated pattern recognition, formal definitions | Lo, Mamaysky & Wang, *Foundations of Technical Analysis*, Journal of Finance 55(4), 2000 — [NBER w7613](https://www.nber.org/papers/w7613), [Wiley](https://onlinelibrary.wiley.com/doi/abs/10.1111/0022-1082.00265) |
| Head-and-shoulders predictive power | Savin, Weller & Zvingelis, *The Predictive Power of "Head-and-Shoulders" Price Patterns in the U.S. Stock Market*, Journal of Financial Econometrics 5(2), 2007 — [Oxford Academic](https://academic.oup.com/jfec/article-abstract/5/2/243/785044), [working paper PDF](https://www.biz.uiowa.edu/faculty/gsavin/papers/hsrevision_paw_10%2019%2006.pdf) |
| Candlestick pattern value | Marshall, Young & Rose, *Candlestick technical trading strategies: Can they create value for investors?*, J. Banking & Finance, 2006 — [summary](https://www.researchgate.net/publication/223853109_Candlestick_technical_trading_strategies_Can_they_create_value_for_investors); Marshall, Young & Cahan (Japan, 2008) — [summary](https://www.researchgate.net/publication/5157791_Are_candlestick_technical_trading_strategies_profitable_in_the_Japanese_equity_market); contrary findings in Asian markets — [SAGE Open](https://journals.sagepub.com/doi/10.1177/2158244017736799) |
| Technical rules in crypto | Hudson & Urquhart, *Technical trading and cryptocurrencies*, Annals of Operations Research, 2019 — [open access PDF](https://centaur.reading.ac.uk/85715/8/Hudson-Urquhart2019_Article_TechnicalTradingAndCryptocurre.pdf), [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3387950) |
| Wash trading prevalence | Cong, Li, Tang & Yang, *Crypto Wash Trading*, Management Science, 2023 — [NBER w30783](https://www.nber.org/system/files/working_papers/w30783/w30783.pdf), [arXiv](https://arxiv.org/abs/2108.10984); DEX-specific — [Detecting and Quantifying Wash Trading on DEXs](https://arxiv.org/pdf/2102.07001) |
| Pattern base rates, throwbacks, failure rates | Bulkowski, *Encyclopedia of Chart Patterns* — [thepatternsite.com](https://thepatternsite.com/PatternReview4.html), [chart pattern failure](https://thepatternsite.com/id84.html) |
| Pivot / segmentation algorithms | Perceptually Important Points and ZigZag-PIP literature — [Zigzag-based PIP indexing (IEEE)](https://ieeexplore.ieee.org/document/5250725/), [segmentation comparison](https://www.sciencedirect.com/science/article/abs/pii/S1568494615006341), [PIP improvements](https://ieeexplore.ieee.org/iel7/8267452/8279582/08279589.pdf) |
| Solana launch-market manipulation | Pine Analytics sniper-wallet study, reported via [Gate News](https://www.gate.com/news/detail/10385858) |
| Candle/OHLCV availability on Solana | [Birdeye OHLCV](https://docs.birdeye.so/reference/get-defi-ohlcv), [Bitquery Solana OHLC](https://docs.bitquery.io/docs/trading/crypto-price-api/crypto-ohlc-candle-k-line-api/), [Bitquery on DexScreener's lack of candles](https://docs.bitquery.io/docs/blockchain/Solana/DEXScreener/solana_dexscreener/) |

Secondary and vendor material (TradingView, broker education pages) was read for
*definitional conventions only* and is not cited as evidence of performance.

### 2.2 What the literature actually establishes

Stated carefully, because overstating it is the easiest way to lose credibility
with a technical reviewer:

- **Automated pattern detection is tractable.** Lo, Mamaysky & Wang showed
  patterns can be defined formally enough for a machine, using kernel-smoothed
  prices and conditions on consecutive local extrema. Their head-and-shoulders
  definition is five extrema E₁…E₅ with E₃ the maximum, E₃ > E₁, E₃ > E₅, and
  the shoulder pair (E₁, E₅) and trough pair (E₂, E₄) each within ~1.5% of their
  own average. This is the template §15 generalises.
- **Some conditional information exists, in equities.** LMW found several
  indicators carried incremental information over 1962–1996. Savin, Weller &
  Zvingelis found H&S patterns predicted excess returns of 5–7%/yr on S&P 500
  and Russell 2000 constituents 1990–1999 — while finding **little or no support
  for a standalone trading strategy**. Detection value and trading value are not
  the same thing (§29).
- **Crypto evidence is real but fragile.** Hudson & Urquhart tested ~15,000
  rules across five classes with four multiple-testing corrections; 20–50% of
  rules survived, with breakeven transaction costs above typical crypto costs.
  But **Bitcoin generated no positive out-of-sample returns**. Encouraging
  in-sample, unproven out-of-sample.
- **Candlesticks are weakly supported at best.** Marshall, Young & Rose found no
  predictive power or economic value for 14 candlestick patterns on DJIA
  components; the same approach found nothing in Japan. Some Asian-market studies
  disagree. No study we found establishes candlestick value on 24/7 DEX
  microcaps.

### 2.3 The claim this engine is allowed to make

> This market's price geometry matches the formal definition of pattern X with
> quality Q, on timeframe T, from market M, with evidence E. Historically,
> structures of this family have *sometimes* preceded moves in direction D. We
> have not measured whether that holds for this asset class, and we are not
> claiming it does.

Anything stronger is unsupported until Token Finder's own backtest (§30)
produces evidence on *Solana microcaps specifically*. Equity results from 1962
do not transfer to a token that is four hours old.

---

## 3. Pipeline — reviewed and revised

The pipeline proposed in the brief was a reasonable first draft. Six changes:

**(a) Canonical market selection must come first, not be absent.** The draft
starts at "MARKET / OHLCV DATA". But a Solana token trades across many pools and
you cannot validate or interpret candles before knowing *which market produced
them*. Selecting the market is the first decision, not an afterthought.

**(b) Market-quality validation must gate, not merely precede.** A stage that
runs and passes data through regardless is not a gate. On a manipulated or dead
market the correct output is `TECHNICAL_UNAVAILABLE`, not a low score.

**(c) Timeframe eligibility is a missing stage.** Given §1.1, deciding which
timeframes are even admissible is a first-class step, not an implicit filter.

**(d) Confirmation is not a pipeline stage — it is a lifecycle transition.**
The draft has "PATTERN VALIDATION → VOLUME CONFIRMATION → MULTI-TIMEFRAME
CONFIRMATION" as sequential passes. But confirmation happens *over time*: a flag
detected now is confirmed or invalidated by candles that do not exist yet. One
pass cannot express that. Detection is per-tick; confirmation is stateful.

**(e) Invalidation is a continuous monitor, not a downstream stage.** It applies
to previously detected patterns, and must run even when no new pattern is found.

**(f) Deduplication and conflict resolution are missing.** Overlapping detectors
will fire simultaneously (a symmetrical triangle and a pennant on the same
pivots). Something must arbitrate before output.

### 3.1 Revised pipeline

```
CANONICAL MARKET SELECTION            which pool's candles are "the" market
        |
OHLCV RETRIEVAL                       per market, per eligible timeframe
        |
CANDLE VALIDATION & NORMALIZATION     schema, gaps, empty intervals, outliers
        |
MARKET QUALITY GATE  ---- fail ---->  TECHNICAL_UNAVAILABLE | LOW_CONFIDENCE
        |
TIMEFRAME ELIGIBILITY  -- none --->   INSUFFICIENT_HISTORY
        |
SCALE NORMALIZATION                   ATR, rolling sigma, relative volume
        |
PIVOT / SWING DETECTION               multi-scale, confirmed vs provisional
        |
   +----+----+----------+-----------+
   |         |          |           |
MARKET    SUPPORT/   REGIME      VOLUME
STRUCTURE RESISTANCE CLASSIFIER  PROFILE        (parallel derived layers)
   +----+----+----------+-----------+
        |
PATTERN CANDIDATE GENERATION          geometry only, no verdict
        |
PATTERN QUALITY SCORING               how well does it fit the definition
        |
DEDUPLICATION / CONFLICT RESOLUTION
        |
PATTERN REGISTRY (stateful)  <----->  LIFECYCLE MONITOR
        |                             trigger / confirm / invalidate / complete
MULTI-TIMEFRAME RECONCILIATION
        |
TECHNICAL STATE + SCENARIOS + SCORE   with provenance and confidence
        |
DECISION ENGINE                       (separate future phase; consumer only)
```

Every stage emits provenance (§37) and may emit `UNKNOWN` / `INSUFFICIENT_DATA`
rather than a value. Consistent with the existing evidence model, a stage that
cannot answer says so.

---

## 4. Data layer

### 4.1 Provider requirements

Nothing in the current stack supplies candles, so this is new work. Required
capabilities:

- OHLCV at 1m, 5m, 15m, 1h, 4h, 1d
- **pool-level**, not token-aggregated — aggregation across pools of differing
  depth manufactures candles no venue ever printed (the same class of error as
  the cross-provider turnover bug documented in SCORING.md §7.2)
- history from the token's first block, not a rolling recent window
- explicit empty-interval semantics (no trades ≠ zero price)
- per-candle trade count where available, for integrity checks (§19)

Candidates, in order of fit:

| Provider | Fit | Notes |
|---|---|---|
| GeckoTerminal | good | pool-level OHLCV, no API key; rate limits unverified |
| Birdeye | good | documented OHLCV endpoint, capped at 1000 records/request; already an optional key in Token Finder |
| Bitquery | best depth | per-pair candles at arbitrary intervals across Raydium/Orca/PumpSwap; aggregate history from 2024-06-01 |
| DexScreener | **unusable** | no candle/OHLC/historical endpoint at all |

**Decision deferred.** Provider choice must not leak into detector code. All
detectors consume a normalized internal `CandleSeries`; the adapter layer owns
provider differences, exactly as `src/sources/*` does today.

### 4.2 Canonical market selection

A token with five pools has five different charts. Analysing whichever appears
first produces analysis of a market nobody trades.

Selection inputs, all of which Token Finder already collects:

- pooled liquidity (depth is the dominant term)
- 24h volume, and volume/liquidity turnover
- pool age and trade count
- price agreement with the liquidity-weighted consensus across pools
- provider data quality for that pool

Rules:

- The canonical market is the pool maximising a documented liquidity-and-activity
  score, **subject to** its price agreeing with consensus within a tolerance.
- A pool that disagrees with consensus beyond tolerance is excluded and its
  disagreement recorded — a pool printing a different price is either stale or
  manipulated, and in both cases its candles are not the market.
- **Market changes are events, not silent substitutions.** When the canonical
  pool changes, every open pattern on the old market is marked
  `MARKET_CHANGED` and its lifecycle closed. Patterns do not migrate across
  markets; the geometry belonged to a different order book.
- Migration (pump.fun bonding curve → PumpSwap/Raydium) is the common case for
  new tokens and must be treated as a market change, not a continuation.

Every technical output names its market. "Which chart is this?" must always have
an answer.

### 4.3 Candle validation and normalization

Boundary validation as in `src/core/validate.ts`: reject, never coerce.

- `high >= max(open, close)`, `low <= min(open, close)`, all finite, all ≥ 0
- `volume >= 0`; `trades >= 0` where supplied
- timestamps strictly increasing, aligned to the interval boundary
- **empty intervals are explicit.** A minute with no trades is not a candle with
  `volume: 0` and a fabricated flat price. It is `NO_TRADE`. Silently forward-
  filling them invents doji bars, fake inside bars and phantom compression — a
  direct analogue of the fabricated-points defect this project already fixed.
- gap runs are measured; a series with >X% `NO_TRADE` intervals fails the
  quality gate for that timeframe

---

## 5. Market quality gate

Traditional technical analysis assumes a price formed by many independent
participants. On a four-hour-old Solana token that assumption frequently fails,
and the literature quantifies how badly: wash trading averaged **over 70% of
reported volume on unregulated exchanges** (Cong et al.), and on Solana launch
venues a Pine Analytics study found issuer-funded sniper wallets across **15,000+
token issuances** with an 87% profitable-trade rate.

Geometry computed on that is geometry of a manipulation, not of a market.

Gate inputs (most already available from Token Finder's existing layers):

| Check | Fails when |
|---|---|
| usable liquidity | below the configured floor |
| trade count per candle | so low that each candle is one or two fills |
| unique-trader estimate | concentrated in very few wallets |
| wash-volume indicators | turnover implausible against depth |
| single-wallet dominance | one address drives most volume |
| launch-candle distortion | first candle dwarfs all subsequent range |
| pool migration recency | canonical market changed inside the analysis window |
| price disagreement | pools disagree beyond tolerance |
| liquidity trajectory | depth removed during the window |

Outcomes:

- **`TECHNICAL_UNAVAILABLE`** — no analysis produced. Not a score of zero.
- **`LOW_CONFIDENCE`** — analysis produced, every confidence capped, targets
  suppressed (§17.2).
- **`OK`** — normal operation.

Bot/Sybil/Bundler Intelligence (an earlier roadmap phase) is the natural
supplier of several of these inputs, which is one reason it must land first
(§33).

---

## 6. Pivot / swing engine

Everything downstream depends on this. A pivot engine that reshuffles structure
when one noisy candle arrives makes every pattern above it unstable.

### 6.1 Approaches evaluated

| Approach | Strength | Failure mode |
|---|---|---|
| Fixed-window (k-bar) fractal | trivial, deterministic, O(n) | scale-blind; one wick creates a pivot; output depends entirely on k |
| Percentage deviation (classic ZigZag) | intuitive, scale-free | fixed % is wrong across assets — 5% is noise for a new memecoin and a crash for SOL; **repaints** |
| ATR-normalized deviation | adapts to each asset's volatility | needs warm-up; ATR itself unstable on very short history |
| Kernel smoothing then extrema (LMW) | published, reduces noise principledly | bandwidth selection is a hidden parameter; smoothing shifts extrema in time; not incremental |
| Prominence-based extrema | directly encodes "how much does this swing matter"; multi-scale for free | needs a prominence threshold, which must itself be normalized |
| Perceptually Important Points | designed for exactly this; good empirical results in segmentation comparisons | top-down and global — not naturally incremental for streaming |
| Multi-scale (pivots at several k) | structure at the scale you ask for | more state; must reconcile scales |

### 6.2 Recommendation

**Prominence-based extrema with ATR-normalized thresholds, computed at multiple
scales, with explicit confirmation state.** Rationale:

- Prominence answers the question patterns actually ask ("is this a *significant*
  swing?"), rather than "is this bar higher than its k neighbours?"
- ATR normalization makes one threshold valid across assets (§7).
- Multi-scale removes the arbitrary single `k`: a pattern declares the swing
  scale it needs.
- PIP is the fallback for batch/backtest work where incrementality does not
  matter; it should be implemented as a cross-check in validation, not in the
  live path.

**Repainting must be explicit.** A swing near the right edge is not yet
confirmed — later candles can erase it. Every pivot carries:

```
{ index, time, price, kind: HIGH|LOW,
  prominenceAtr,            // normalized significance
  scale,                    // which detection scale produced it
  state: PROVISIONAL | CONFIRMED,
  barsSinceFormation,
  confirmationRule }
```

A pattern may use `PROVISIONAL` pivots only for `CANDIDATE`/`DEVELOPING` states,
never for `CONFIRMED`. This is the single most important rule for false-positive
control, because "pattern detected" on an unconfirmed final pivot is the most
common way naive detectors lie.

---

## 7. Normalization

Absolute price distance is meaningless across Token Finder's universe — a token
at $0.000000184 and one at $42 must be comparable.

| Concept | Definition | Used by |
|---|---|---|
| ATR(n) | Wilder's average true range on the analysis timeframe | pivot prominence, tolerances, target zones |
| ATR% | ATR / close | regime classification, cross-asset comparison |
| relative distance | (a − b) / ATR | shoulder symmetry, level clustering |
| percentage distance | (a − b) / b | secondary check where ATR is unavailable |
| rolling σ of log returns | stddev over window | regime, volatility-suitability |
| normalized slope | Δprice/ATR per bar | trendline, wedge convergence, flag pole |
| time symmetry | \|t₁ − t₂\| / expected duration | pattern balance |
| relative volume | volume / median volume over window | all volume evidence |
| prominence ratio | swing prominence / ATR | pivot significance |

**Worked example.** LMW require shoulders within 1.5% of their average. On a
token whose hourly ATR is 12% of price, 1.5% is inside the noise — every wiggle
qualifies. On a token with 0.4% ATR, 1.5% is a structural difference — nothing
qualifies. The same constant is simultaneously too loose and too tight.

The replacement is **tolerance in ATR units**, with the percentage form retained
only as a sanity bound:

```
shouldersSimilar  ⟺  |E1 − E5| ≤ k_shoulder · ATR(n)
```

`k_shoulder` is a specified, testable constant per pattern — calibrated
empirically (§30), not guessed now.

---

## 8. Market structure engine

Runs before pattern recognition, because most useful output for young tokens is
structural rather than pictorial.

**Labels** derived from confirmed pivots: `HH`, `HL`, `LH`, `LL`.

**Regimes:**

| State | Objective criterion (to be calibrated) |
|---|---|
| `TRENDING_UP` | ≥ N consecutive HH+HL with no intervening LL |
| `TRENDING_DOWN` | ≥ N consecutive LH+LL with no intervening HH |
| `RANGING` | swings alternate within a band of width ≤ w·ATR |
| `TRANSITIONAL` | structure broken but new structure not yet established |
| `UNCERTAIN` | pivots insufficient or conflicting |

`UNCERTAIN` is a first-class answer. Forcing a noisy 40-candle chart into
"uptrend" is the failure mode this engine exists to avoid.

**Events:**

- **Break of Structure (BOS)** — price closes beyond the most recent confirmed
  swing extreme *in the direction of the prevailing structure*. Continuation.
- **Change of Character (CHoCH)** — first close beyond the most recent opposing
  confirmed swing extreme, ending the prior sequence. Reversal of structure, not
  a prediction of price.
- **Structural reclaim** — price closes back above/below a level it had broken,
  within a bounded number of bars.
- **Structural rejection** — price trades beyond a level intrabar but closes back
  inside.

These four are objectively definable from confirmed pivots and closes. Terms
that cannot be defined this cleanly — "order block", "fair value gap",
"institutional candle", "smart money" — are **deliberately excluded**. They are
discretionary vocabulary without machine-checkable definitions, and importing
them would make the engine undefendable to a reviewer.

---

## 9. Support / resistance engine

The failure mode is producing forty levels, at which point something is always
"near support" and the concept is worthless.

**Construction:**

1. Seed candidates from confirmed pivots only.
2. **Cluster** candidates whose separation is ≤ c·ATR into a single level;
   represent each cluster as a *zone* (low, high, centre), not a line. Price
   respects areas, not exact values.
3. Score each level:
   - touch count (distinct, separated in time)
   - rejection quality (how decisively price left the level)
   - total time spent adjacent
   - age and recency
   - volume transacted near the level
   - whether it has flipped role (resistance → support)
4. **Keep only the top N by strength.** Precision over quantity (§28).

**Level state machine:** `UNTESTED → TESTED → HOLDING → BROKEN → RETESTED →
{RECLAIMED | CONFIRMED_BROKEN}`.

Dynamic (sloped) levels are supported only where a trendline is anchored on ≥ 3
confirmed pivots with bounded residuals — otherwise a line can be drawn through
anything.

---

## 10. Regime engine

Pattern interpretation is regime-dependent; a triangle in a compression regime
and the same triangle mid-expansion are different objects.

**Volatility:** `LOW | NORMAL | HIGH | EXTREME`, from ATR% percentile against the
token's own history *and* against a cross-sectional cohort of similar-age tokens.
Own-history percentile alone is degenerate for a token with two hours of history.

**Structure:** `TREND | RANGE | EXPANSION | COMPRESSION`, from the market-
structure engine plus the trajectory of ATR and range width.

Regime enters pattern quality as a *suitability* term: flags and pennants
presuppose a trend, so a flag detected in `RANGE` scores lower on context even
when its geometry is perfect.

---

## 11. Volume intelligence

Volume is first-class evidence, with a crypto-specific caveat: **volume is the
most easily faked input on the chart**. Cong et al. put wash trading above 70% of
reported volume on unregulated venues. Volume confirmation must therefore be
gated on volume *integrity*, or the engine confirms patterns on fabricated data.

| Measure | Definition |
|---|---|
| relative volume | candle volume / median over lookback |
| breakout volume | breakout-candle volume vs pre-breakout baseline |
| expansion / contraction | trend of relative volume over the structure |
| dry-up | sustained relative volume below threshold (expected inside flags/pennants) |
| divergence | price makes HH while volume makes LH |
| buy/sell split | where per-side data exists |
| spike | outlier against a robust dispersion measure |
| **integrity** | trade count, unique traders, size rounding, per-trade size distribution |

**Rule:** a pattern whose confirmation depends on volume, on a market whose
volume integrity is suspect, yields `VOLUME_CONFIRMATION: UNVERIFIABLE` — not
"confirmed" and not "failed". A third state, exactly as the existing evidence
model distinguishes UNKNOWN from zero.

Size rounding and first-significant-digit anomalies are the detection methods
Cong et al. used; they are computable here and belong in Bot/Sybil Intelligence,
consumed by this layer.

---

## 12. Multi-timeframe intelligence

**Eligibility before analysis.** A timeframe is admissible only when it has
enough *real* candles:

```
eligible(tf) ⟺ realCandles(tf) ≥ minCandles(tf)
             ∧ noTradeRatio(tf) ≤ maxGapRatio
             ∧ marketAge ≥ minBars(tf) × interval(tf)
```

Given §1.1's age distribution, the realistic picture for Token Finder:

| Timeframe | Typically eligible | Notes |
|---|---|---|
| 1m | almost always | noisiest; most vulnerable to single-bot candles |
| 5m | usually | the workhorse for young tokens |
| 15m | after ~4–6 h | |
| 1h | after ~2 days | only the older half of the corpus |
| 4h | rarely | |
| 1d | almost never | one daily candle at the median age |

Ineligible timeframes return `INSUFFICIENT_HISTORY`. They are never approximated
by resampling a shorter timeframe into a longer one and pretending the result is
history.

**Cross-timeframe concepts:** aligned trend, conflicting trend, higher-timeframe
level proximity, lower-timeframe breakout against higher-timeframe resistance,
and an explicit `MTF_UNAVAILABLE` when only one timeframe is eligible — which,
for a large share of this corpus, is the honest answer.

---

## 13. Chart pattern taxonomy

**57 geometric structures investigated across 7 families.** Classification uses:
objectivity, machine detectability, false-positive risk, minimum history,
volume dependence, noise sensitivity, crypto suitability, suitability for *newly
launched* tokens, backtestability, and overlap with existing Token Finder layers.

Ratings: **H** high value · **M** medium · **L** low · **C** context-dependent ·
**N** not recommended.

Resulting distribution — chart patterns: **H 20 · M 15 · L 8 · C 4 · N 10**.
Candlesticks (§14): **H 2 · M 5 · L 16 · C 5 · N 4**. The asymmetry is the
finding, not an accident: geometric structure survives the move to 24/7 DEX
microcaps considerably better than candlestick sentiment does.

### 13.1 Reversal (14)

| Pattern | Min bars | Rating | Reasoning |
|---|---|---|---|
| Head & Shoulders | ~40 | **M** | Best-specified pattern in the literature (LMW; Savin et al.). Genuinely predictive in equities. But needs 5 confirmed pivots — out of reach for most of this corpus. |
| Inverse Head & Shoulders | ~40 | **M** | As above. Bulkowski ranks H&S bottoms 13/39 overall. |
| Double Top | ~20 | **H** | Two pivots plus a neckline. Cheapest high-value reversal; reachable on 5m for young tokens. |
| Double Bottom | ~20 | **H** | As above. |
| Triple Top | ~30 | **M** | Stronger evidence per instance, rarer; largely subsumed by Double + level strength. |
| Triple Bottom | ~30 | **M** | As above. |
| Rounded Top | ~60 | **L** | Definition is inherently fuzzy; needs long smooth history that microcaps do not have. |
| Rounded Bottom | ~60 | **L** | As above. |
| Diamond Top | ~40 | **N** | Requires broadening-then-narrowing; very rare, very subjective, high false-positive rate. |
| Diamond Bottom | ~40 | **N** | As above. |
| Adam & Eve variants | ~20 | **N** | Distinguishes "sharp" vs "rounded" lows — a discretionary judgement with no stable machine definition. Fold into Double Top/Bottom quality instead. |
| Island Reversal | ~10 | **N** | **Requires gaps. A 24/7 DEX has no session gaps.** Apparent gaps come from `NO_TRADE` intervals, i.e. absence of data, not of demand. Undefined here. |
| V-Top / V-Bottom (spike) | ~10 | **C** | Extremely common on launches, but nearly always the launch candle or a single-wallet event. Useful as a *market-integrity* signal, not a trade structure. |
| Complex / multiple H&S | ~60 | **N** | Combinatorially ambiguous; no defensible unique parse. |

### 13.2 Continuation (15)

| Pattern | Min bars | Rating | Reasoning |
|---|---|---|---|
| Bull Flag | ~15 | **H** | Objective: impulse pole + bounded counter-drift + volume dry-up + breakout. Short, frequent, fits young tokens. |
| Bear Flag | ~15 | **H** | As above. |
| Bull Pennant | ~15 | **M** | Nearly identical to flag with converging rather than parallel bounds. **Overlaps heavily with symmetrical triangle** — must be deduplicated (§28). |
| Bear Pennant | ~15 | **M** | As above. |
| Rectangle (continuation) | ~20 | **H** | Equivalent to a horizontal range with trend context; reuses the S/R engine. |
| Ascending Channel | ~25 | **M** | Needs ≥3 touches per boundary to be non-arbitrary. |
| Descending Channel | ~25 | **M** | As above. |
| Measured Move Up | ~30 | **L** | Really a *target method* (§17), not a detectable pattern. Specify as projection, not detector. |
| Measured Move Down | ~30 | **L** | As above. |
| Continuation wedge | ~25 | **C** | Same geometry as reversal wedge; only trend context differs. Ambiguous by construction. |
| Cup & Handle | ~100 | **N** *(initially)* | Well-known and reasonably objective, but the history requirement excludes essentially this entire corpus. Revisit if Token Finder tracks mature tokens. |
| Inverse Cup & Handle | ~100 | **N** *(initially)* | As above. |
| Cup without handle | ~80 | **N** *(initially)* | As above. |
| Scallop | ~50 | **N** | Marginal literature, fuzzy definition. |
| Three Rising Valleys / Falling Peaks | ~40 | **L** | Subsumed by market structure (HL sequence) — redundant. |

### 13.3 Triangles (5), Wedges (3), Channels & ranges (4), Structure (7), Breakout (8)

| Pattern | Min bars | Rating | Reasoning |
|---|---|---|---|
| Ascending Triangle | ~25 | **H** | Flat resistance + rising lows. Both boundaries objectively fittable; strong breakout semantics. |
| Descending Triangle | ~25 | **H** | Mirror. |
| Symmetrical Triangle | ~25 | **M** | Objective, but directionally neutral — lower decision value, and overlaps pennants. |
| Broadening Triangle | ~30 | **L** | Expanding structures fit noise easily; high false-positive risk. |
| Expanding formation (megaphone) | ~30 | **L** | As above. |
| Rising Wedge | ~25 | **M** | Converging with both boundaries rising. Needs strict convergence + slope tests or it captures any drift. |
| Falling Wedge | ~25 | **M** | Mirror. |
| Broadening Wedge | ~30 | **N** | Compounds the weaknesses of wedge and broadening. |
| Horizontal Range | ~15 | **H** | The most common real structure on young tokens. Directly reusable by breakout logic. |
| Broadening Range | ~25 | **L** | See broadening formations. |
| Compression (volatility contraction) | ~20 | **H** | ATR/range contraction is a *measurement*, not a drawn shape — highly objective, no pivot fitting. |
| Expansion | ~20 | **H** | Mirror; objective and cheap. |
| HH / HL / LH / LL labelling | ~10 | **H** | Foundation for everything else. |
| Break of Structure | ~12 | **H** | Objective, short-history, high information for new tokens. |
| Change of Character | ~15 | **H** | As above. |
| Trend continuation | ~15 | **M** | Derived from structure labels. |
| Trend exhaustion | ~25 | **C** | Definable via declining swing amplitude + volume divergence, but weak alone. |
| Range formation / expansion / compression | ~15 | **H** | Same engine as above. |
| Structural reclaim | ~12 | **H** | Very informative after failed breakouts. |
| Structural rejection | ~8 | **M** | Single-event, noisy alone. |
| Potential breakout / attempt / confirmed | ~10 | **H** | Core deliverable (§15). |
| Potential breakdown / attempt / confirmed | ~10 | **H** | Mirror. |
| Retest | ~5 after break | **H** | Bulkowski: throwbacks occur ~45% of the time after H&S-bottom breakouts, and performance is *worse* when they occur — a concrete, testable expectation. |
| Reclaim | ~5 after break | **H** | |
| Failed breakout / breakdown | ~5 after break | **H** | Arguably the highest-value structure here: a failed break is a strong, objective, short-horizon event and is exactly what Token Finder's users get hurt by. |
| Fakeout | ~5 after break | **M** | Same object as failed breakout; keep one name, not two. |
| Liquidity sweep | ~5 | **C** | Definable as: wick beyond a level by ≥ k·ATR with close back inside within m bars. Keep *only* that objective form; discard the discretionary narrative. |
| Continuation after breakout | ~10 after break | **M** | |

### 13.4 Recommended initial implementation catalog

Deliberately small. Precision over quantity, and matched to what this corpus can
actually support.

**Tier 1 — structure and breakout (no classical pattern fitting):**
HH/HL/LH/LL labelling · Break of Structure · Change of Character · Horizontal
Range · Compression · Expansion · Support/Resistance zones · Breakout /
Breakdown lifecycle · Retest · Reclaim · **Failed breakout / breakdown**

**Tier 2 — short, objective patterns:**
Double Top · Double Bottom · Bull Flag · Bear Flag · Ascending Triangle ·
Descending Triangle · Rectangle

**Tier 3 — only when history allows (older tokens):**
Head & Shoulders · Inverse H&S · Symmetrical Triangle · Rising/Falling Wedge ·
Channels

**Explicitly deferred or rejected:** Cup family, Diamonds, Rounded tops/bottoms,
Adam & Eve, Island Reversal, Complex H&S, Broadening family, Scallop, Three
Rising Valleys.

Tier 1 alone would deliver most of the practical value for this product, needs
the least history, and is the most defensible to a reviewer.

---

## 14. Candlestick taxonomy

**32 catalog entries investigated** (grouping mirrored variants such as Three
Inside Up/Down into one entry, covering 38 named patterns), kept strictly
separate from geometric patterns.

### 14.1 The crypto-specific problem

Most classical candlestick patterns were defined for markets with **daily bars
and overnight gaps**. A 24/7 DEX has neither:

1. **No session gaps.** Every pattern whose definition requires a gap — Island
   Reversal, Abandoned Baby, Kicker, classical Morning/Evening Star, Breakaway —
   is either undefined or degenerates to its non-gap variant.
2. **Apparent gaps are missing data.** A price jump across a `NO_TRADE` interval
   reflects absence of trading, not a demand shock.
3. **Bar boundaries are arbitrary.** Candle shape depends entirely on where the
   interval boundary falls. On 1m candles of a thin token, a single 3 SOL buy
   creates a textbook Marubozu. The pattern describes one fill, not sentiment.
4. **The empirical base is weak.** Marshall, Young & Rose found no value on DJIA
   components; the same method found none in Japan. Positive findings exist in
   some Asian equity markets. **No evidence exists for 24/7 DEX microcaps.**

### 14.2 Classification

| Pattern | Rating | Reasoning |
|---|---|---|
| Doji | **C** | Objective (body ≤ ε·range). Useful only as an *input* to compression/indecision measures, not as a signal. |
| Dragonfly Doji | **L** | Wick-dominant; on thin books a wick is one fill. |
| Gravestone Doji | **L** | As above. |
| Long-Legged Doji | **L** | As above. |
| Hammer | **C** | Only meaningful at a tested support zone — i.e. the *level* carries the information, not the candle. |
| Inverted Hammer | **L** | Weak standalone evidence. |
| Hanging Man | **L** | Identical shape to Hammer; differs only by context. |
| Shooting Star | **C** | As Hammer, at resistance. |
| Bullish Engulfing | **M** | Objective, gap-free definition; survives on DEX data. Best of the family. |
| Bearish Engulfing | **M** | As above. |
| Morning Star | **L** | Classical form needs gaps; non-gap variant is much weaker. |
| Evening Star | **L** | As above. |
| Morning/Evening Doji Star | **N** | Gap-dependent. |
| Bullish Harami | **L** | Equivalent to an Inside Bar with a colour condition. |
| Bearish Harami | **L** | As above. |
| Harami Cross | **N** | Harami + Doji; compounds two weak signals. |
| Piercing Line | **L** | Gap-influenced; weak without it. |
| Dark Cloud Cover | **L** | As above. |
| Tweezer Top | **C** | Really "two touches of one level" — the S/R engine expresses this better. |
| Tweezer Bottom | **C** | As above. |
| Three White Soldiers | **M** | Objective; overlaps strongly with momentum/trend measures. |
| Three Black Crows | **M** | As above. |
| **Inside Bar** | **H** | Fully objective, no gaps, no colour dependence. A genuine compression primitive. |
| **Outside Bar** | **H** | Fully objective. A genuine expansion/volatility primitive. |
| Marubozu | **L** | Trivially produced by one fill on thin books. |
| Spinning Top | **L** | Low information; use ATR instead. |
| Three Inside Up / Down | **L** | Harami + confirmation; inherits Harami's weakness. |
| Three Outside Up / Down | **M** | Engulfing + confirmation; inherits Engulfing's relative strength. |
| Abandoned Baby | **N** | **Requires gaps on both sides. Undefined on 24/7 DEX data.** |
| Belt Hold | **L** | Open-at-extreme; boundary-dependent. |
| Kicker | **N** | Gap-dependent. |
| Rising / Falling Three Methods | **L** | Long, rare, and largely a flag by another name. |

### 14.3 Recommendation

**Implement four, as primitives rather than signals:** Inside Bar, Outside Bar,
Bullish Engulfing, Bearish Engulfing.

They are fully objective, gap-free, and feed compression/expansion and breakout
quality. Everything else is deferred pending Token Finder's own evidence.

Candlestick patterns must **never** produce a standalone scenario or appear in
the UI as a recommendation. They are inputs to quality scores. Preserving a
pattern because it is famous is precisely what §28 forbids.

---

## 15. Machine-readable pattern specification

Every implemented pattern is a declarative spec, versioned, independently
testable. Detectors interpret specs; they do not embed constants.

```jsonc
{
  "id": "double_bottom.v1",
  "name": "Double Bottom",
  "family": "reversal",
  "direction": "bullish",
  "specVersion": 1,

  "requirements": {
    "minCandles": 20,
    "minMarketAgeMinutes": 60,
    "minLiquidityUsd": 3000,
    "minMarketQuality": "OK",
    "preferredTimeframes": ["5m", "15m", "1h"],
    "requiredPivots": { "lows": 2, "highsBetween": 1, "state": "CONFIRMED" }
  },

  "geometry": {
    // all tolerances in ATR units; percentages are sanity bounds only
    "lowSimilarity":      { "maxAtr": 0.75, "maxPct": 6 },
    "interveningHigh":    { "minProminenceAtr": 1.5 },
    "separation":         { "minBars": 5, "maxBars": 60 },
    "timeSymmetry":       { "maxRatio": 3.0 },
    "necklineSlope":      { "maxAtrPerBar": 0.15 }
  },

  "volume": {
    "secondLowVolume":   { "relativeMax": 0.9, "required": false },
    "breakoutVolume":    { "relativeMin": 1.5, "required": true },
    "integrityRequired": true
  },

  "trigger":      { "type": "close_above", "level": "neckline",
                    "minBeyondAtr": 0.25, "withinBars": 30 },
  "confirmation": { "closesBeyond": 2, "maxAdverseCloseAtr": 0.5 },
  "invalidation": [
    { "rule": "close_below", "level": "lower_of_two_lows", "immediate": true },
    { "rule": "timeout", "bars": 60 },
    { "rule": "market_changed" },
    { "rule": "market_quality_degraded", "to": "TECHNICAL_UNAVAILABLE" }
  ],

  "target": { "method": "pattern_height_projection",
              "from": "neckline", "heightSource": "neckline_to_lowest_low",
              "output": "zone", "zoneWidthAtr": 1.0,
              "capAt": "next_resistance_zone" },

  "qualityInputs": [
    "pivotProminence", "lowSimilarity", "timeSymmetry", "necklineQuality",
    "volumePattern", "trendContext", "noiseLevel", "breakoutQuality"
  ],

  "limitations": [
    "Two lows of similar depth occur frequently inside ranges; range context must reduce quality.",
    "On <5m timeframes a single large fill can create the second low."
  ],
  "knownFalsePositives": [
    "Horizontal range with two touches of the lower boundary",
    "Launch-candle wick followed by an unrelated retest",
    "Wash-traded oscillation between two price points"
  ],

  "lifecycle": ["CANDIDATE","DEVELOPING","TRIGGERED","CONFIRMED",
                "COMPLETED","FAILED","INVALIDATED","EXPIRED"]
}
```

Two further sketches, abbreviated:

**`bull_flag.v1`** — pole: ≥ p·ATR advance within ≤ q bars; flag: counter-drift
bounded by two roughly parallel lines with normalized slope opposite the pole,
retracement ≤ r·poleHeight, duration ≤ s·poleDuration; volume: contracting
through flag (`dry-up`), expanding on break; trigger: close above upper bound by
≥ k·ATR; invalidation: close below pole base, or retracement > r.
*Known false positives:* any ordinary pullback in a noisy uptrend; specify a
minimum pole prominence or the detector fires constantly.

**`failed_breakout.v1`** — precondition: a `BROKEN` level with a recorded break
event; trigger: close back inside the level by ≥ k·ATR within m bars of the
break; confirmation: a second close inside; quality rises with the distance and
volume of the original break (a high-volume break that fails is stronger evidence
than a marginal one). No target projection by default — this is a *risk* signal,
and §17.2 forbids inventing an upside from it.

---

## 16. Pattern quality vs. match confidence

These are different quantities and the distinction must survive into the API and
the UI.

**Pattern Match Confidence** — how well the observed geometry fits the formal
definition. A property of shape. Computable, deterministic, testable.

**Predictive Probability** — the chance price subsequently moves as the pattern
family suggests. A property of the *world*, obtainable only from a backtest on
comparable assets.

> **Pattern Match Confidence = 88%** means the geometry is a strong match.
> It does **not** mean an 88% chance of the expected move.

Until §30 produces measurements, Token Finder will publish match confidence and
**will publish no predictive probability at all**. An absent number is honest; a
fabricated one is not.

`PatternQualityScore` components (weights deliberately unset — §21):

geometric fit · pivot prominence · symmetry · time balance · neckline/boundary
quality · S/R quality at the level · trend context · regime suitability · volume
confirmation · volume integrity · breakout quality · retest behaviour · noise
level · liquidity quality · timeframe agreement · conflicting structures present

---

## 17. Breakout and target architecture

### 17.1 Breakout states

`price > resistance` is not a breakout. States:

`DEVELOPING` → `ATTEMPT` → `CONFIRMED` → `RETEST` → {`RECLAIM_HELD` |
`FAILED`} ; and `INVALIDATED` from any state.

Evidence per transition: close (not wick) beyond the zone; distance beyond in
ATR units; breakout-candle relative volume *with integrity*; number of closes
held beyond; time above the level; retest depth; timeframe; market quality.

A wick beyond a level with a close back inside is a **rejection** or a **liquidity
sweep** — never a breakout. This one rule removes a large class of false
positives.

### 17.2 Targets

Output is always a **zone with a stated method**, never a price with an implied
promise.

Methods: pattern-height projection · range-height projection · ATR multiple ·
next opposing S/R zone (used as a **cap**, since projecting through known
structure is unjustified) · measured-move continuation.

**Targets are suppressed entirely when:** market quality is `LOW_CONFIDENCE` or
worse; volume integrity is unverifiable; the canonical market changed inside the
pattern window; or pattern quality is below threshold. A target on a manipulated
microcap is the single most misleading thing this engine could emit.

### 17.3 Invalidation

Every structure answers *what would make this wrong?* before it is published.

| Structure | Invalidation |
|---|---|
| Double Bottom | close below the lower low |
| Head & Shoulders | close back above the right shoulder; neckline reclaim |
| Bull Flag | close below pole base; retracement beyond limit |
| Triangle | close beyond the opposite boundary |
| Breakout | failure to hold; reclaim of the level from the other side |
| Any | timeout, market change, quality degradation |

Published output always carries: `status`, `trigger`, `confirmation`,
`invalidation`.

### 17.4 Scenarios

Scenarios, not certainties. Each carries direction (`BULLISH | BEARISH |
NEUTRAL | UNCERTAIN`), status, trigger, target zone with method, invalidation,
and supporting/contradicting evidence. A primary and at most two alternatives.
`UNCERTAIN` with no scenario is a valid and frequent output.

---

## 18. Technical Score

An independent output, **not** merged into the Risk Score.

Proposed dimensions (weights unset until §30):

| Dimension | Measures |
|---|---|
| Market Structure | clarity and consistency of HH/HL/LH/LL |
| Trend Quality | persistence, swing regularity, absence of whipsaw |
| Pattern Quality | best qualifying pattern's match quality |
| Volume Confirmation | volume support, discounted by integrity |
| Breakout Quality | decisiveness and durability of recent breaks |
| Multi-TF Alignment | agreement across eligible timeframes |

Reported alongside — never multiplied into — **coverage** (how much of the
analysis rested on real candles) and **confidence** (what that evidence is
worth after market quality, staleness and single-provider dependence). This
mirrors the existing separation of score/coverage/confidence, which exists
precisely so a high number built on thin evidence cannot masquerade as a strong
one.

With market quality below `OK`, the Technical Score is **withheld**, not lowered.

---

## 19. Cross-intelligence integration

Technical Intelligence consumes other layers' outputs but never depends on them
to function, and never writes to them.

| Consumed from | Used for |
|---|---|
| Safety / Risk | market quality gate; suppression when vetoed |
| Buyer Intelligence | independent-buyer trend as confirmation context |
| Bot / Sybil / Bundler | volume integrity, wash detection, single-wallet dominance |
| Momentum | regime cross-check (§22.3 on avoiding overlap) |
| Liquidity | depth trajectory, target suppression |

Output combinations are **reported, never silently fused**:

> **Bull Flag** — match confidence 84%, 5m, CONFIRMED
> **On-chain confirmation: WEAK** — buyer quality declining, liquidity falling,
> volume integrity unverifiable

> **Breakout CONFIRMED** + independent buyers rising + liquidity growing +
> organic volume + positive momentum → **MULTI-LAYER CONFIRMATION**

The Decision Engine decides what to do with that. This layer does not.

---

## 20. Lifecycle, persistence, real-time, scale

### 20.1 Lifecycle

`CANDIDATE → DEVELOPING → TRIGGERED → CONFIRMED → COMPLETED`, with `FAILED`,
`INVALIDATED`, `EXPIRED` and `MARKET_CHANGED` as terminal branches from any
state. Every transition is stored with timestamp, triggering candle, and the
rule that fired — the same audit discipline the safety gate already uses for
vetoes.

### 20.2 Persistence

Store: canonical-market decisions and changes · confirmed pivots (not every
candle) · S/R zones with touch history · pattern detections and every lifecycle
transition · match-confidence history · breakout/retest/invalidation events ·
technical-score history · scenario history.

Do **not** store full OHLCV where it can be re-fetched; store the *derived*
structures plus enough provenance to reproduce them. Exception: candles in the
neighbourhood of a confirmed pattern should be snapshotted, because provider
history for dead microcaps disappears and the backtest corpus (§30) depends on
it.

This will exceed what a whole-file JSON store can carry; it is a concrete
argument for the Persistence phase preceding this one (§33).

### 20.3 Real-time

Two update paths: **candle-open** (provisional, may repaint — patterns may enter
`DEVELOPING` but never `CONFIRMED`) and **candle-close** (authoritative; pivots
may confirm, patterns may confirm or invalidate).

Incremental by construction: maintain rolling ATR, the confirmed-pivot list, and
the open-pattern registry. On each close, update only what the new candle can
affect. Full recomputation only on market change or spec-version change.

### 20.4 Scale

At 10,000 markets × 6 timeframes, naive full recomputation is hopeless.
Bottlenecks, in order: OHLCV retrieval (network, rate limits) → per-timeframe
aggregation → pivot recomputation → pattern rescanning → persistence writes.

Mitigations to design for now: tiered refresh by interest (the existing roadmap
already proposes this); event-driven recomputation on candle close only;
incremental pivot and ATR state; worker pool with per-provider rate budgets
(reusing `poolSettled`'s failure isolation); caching keyed by
`(market, timeframe, lastCandleTime)`; and a hard cap on patterns tracked per
market.

**No runtime optimisation today.** This section exists so the algorithms chosen
later are incremental by design rather than retrofitted.

---

## 21. False-positive control

The governing principle: **precision over quantity**. `NO_HIGH_QUALITY_PATTERN_
DETECTED` is a good answer and will be the most common one.

Controls: minimum pattern quality threshold · minimum confirmed-pivot prominence
· minimum candles and market age per pattern · minimum liquidity · market-quality
gate · `PROVISIONAL` pivots barred from confirmation · deduplication of
overlapping detections (one structure, one report) · conflict resolution when
detectors disagree in direction (report both with lower confidence, or
`UNCERTAIN` — never silently pick) · volatility-suitability checks · mandatory
volume integrity for volume-confirmed patterns · timeout expiry.

Per-family false-positive mechanisms are recorded in each spec
(`knownFalsePositives`), and each must have a **near-miss fixture** in the test
suite (§22.1).

---

## 22. Validation

### 22.1 Test strategy

Per detector: known-positive fixtures · known-negative fixtures · **near-miss
fixtures** (violate exactly one rule — the most valuable class) · noisy series ·
malformed candles · missing/`NO_TRADE` candles · insufficient history · extreme
volatility · low liquidity · volume anomalies · multi-timeframe disagreement ·
multi-pool disagreement · synthetic deterministic series with analytically known
answers · real historical series.

Synthetic-first, because a synthetic series has a *known* correct answer; real
charts only tell you whether output looks plausible. "It found the pattern on
this one chart I picked" is not a test.

### 22.2 Detection vs. predictive value

Two separate evaluations, never conflated:

**A. Detection quality** — did we correctly identify the pattern? Measured
against labelled fixtures: precision, recall, false-positive rate, stability
under noise, repaint rate.

**B. Predictive value** — did it matter? Measured forward from confirmed
detections on real history: completion rate, breakout success rate, failed-
breakout rate, forward-return distribution vs. an unconditional baseline,
Maximum Favourable/Adverse Excursion, time to resolution — all conditioned on
liquidity, market age, timeframe and regime, because pooled results hide exactly
the heterogeneity that matters here.

The baseline comparison is essential: on a corpus where most tokens fall,
*any* bearish signal looks predictive. Results must be reported against the
unconditional distribution, with multiple-testing correction — the methodological
point Hudson & Urquhart make, and the reason their Bitcoin out-of-sample result
matters more than their in-sample one.

**No profitability claim will be made without this evidence.** Until then the
product says: *detected, with this quality, on this market.*

---

## 23. Architecture, isolation and honesty

### 23.1 Module layout

```
src/technical/
  market/          canonical selection, migration, provenance
  data/            OHLCV adapters, candle validation, NO_TRADE semantics
  quality/         market-integrity gate
  normalize/       ATR, sigma, relative volume, tolerance helpers
  pivots/          multi-scale prominence detection, confirmation state
  structure/       HH/HL/LH/LL, BOS, CHoCH, reclaim, rejection
  levels/          S/R clustering, zones, level state machine
  regime/          volatility and structure regimes
  volume/          relative volume, dry-up, divergence, integrity
  patterns/
    registry.ts    spec loading, versioning, enable/disable
    reversal/  continuation/  triangles/  wedges/  channels/  cup/
  candlesticks/    inside/outside/engulfing primitives only
  breakout/        breakout + retest + failure lifecycle
  lifecycle/       pattern registry and transitions
  scoring/         quality, technical score dimensions
  scenarios/       scenario construction
  validation/      fixtures, backtest harness, metrics
  visualization/   annotation payload construction (no rendering)
```

Each detector: independently testable, documented, versioned, toggleable,
evaluated. No monolithic pattern file.

### 23.2 Failure isolation

Technical Intelligence must never be able to damage the scanner. It is a
**consumer** of the pipeline, never a participant in discovery, safety scoring,
eligibility or ranking.

| Condition | Output |
|---|---|
| OHLCV provider fails | `TECHNICAL_DATA_UNAVAILABLE` + classified `ProviderFailure` |
| insufficient candles | `INSUFFICIENT_HISTORY` |
| market quality poor | `LOW_CONFIDENCE_TECHNICAL_ANALYSIS`, targets suppressed |
| no qualifying pattern | `NO_HIGH_QUALITY_PATTERN_DETECTED` |
| detector throws | that detector isolated, others continue |

**Never** a default "safe" technical score. **Never** allowed to crash discovery,
alter Risk scoring, block Buyer Intelligence, change ranking, or fabricate
output. The existing `poolSettled` isolation and `ProviderFailure` taxonomy
extend directly to this layer.

### 23.3 Annotations and explainability

Annotation payloads are produced by detectors and consumed by the chart:
swing points, structure labels, S/R zones, trendlines, pattern-specific geometry
(head, shoulders, neckline; triangle and flag boundaries; channel), breakout
level, invalidation level, target zone, volume-confirmation markers.

**Never hard-coded for a demo token.** An annotation with no detector output
behind it is a lie told in pictures.

A reviewer clicking a pattern must see: which candles were used, which pivots
were selected and why they qualified, which rules passed and which failed,
timeframe, market, volume evidence, confirmation state, invalidation level, and
every input to the confidence figure. "AI detected Head & Shoulders" is not
acceptable output.

### 23.4 Provenance

Every result carries: provider · market/pool · timeframe · candle interval ·
first and last candle time · candle count · `NO_TRADE` ratio · observedAt ·
freshness · normalization parameters (ATR window, thresholds) · spec id and
version.

Four layers kept distinct: **raw market data** → **derived structure** (pivots,
levels, regime) → **pattern detection** → **interpretation** (scenarios, score).
Each labelled, so a reviewer can see where observation ends and inference begins.

### 23.5 Jev / AI boundary

Jev remains **disabled**, exactly as today, and this subsystem does not change
that. Pattern detection is deterministic and quantitative.

If a model is used later it may *interpret* deterministic output — ranking
ambiguous competing structures, phrasing explanations, secondary advisory
commentary. It may **never** be the source of a pattern, a level, a confidence
figure or a target. The deterministic evidence must always remain available and
sufficient on its own, and the same rules that govern the existing Jev
integration apply: advisory only, zero effect on scoring, ranking or vetoes,
failure produces `not_assessed` rather than a fabricated answer.

---

## 24. Roadmap placement

Proposed order, with the one change I would argue for:

```
Foundation / Safety                      (done)
  → Buyer Intelligence
  → Bot / Sybil / Bundler Intelligence
  → Momentum v2
  → Persistence
  → Technical Intelligence Engine        ← this document
  → Paper Trading
  → Entry / Exit Decision Engine
  → Manual Trading
  → Capped Auto Trading
  → Advanced Automation
```

**The order is broadly right, and the dependencies are real:**

- **Bot/Sybil before Technical** is essential, not merely convenient. Volume
  confirmation is load-bearing for most patterns, and with wash trading above
  70% of volume on unregulated venues, confirming patterns on unvetted volume
  would make the engine actively misleading.
- **Persistence before Technical** is required by §20.2. Pattern lifecycles,
  pivot history and the backtest corpus cannot live in a whole-file JSON store.

**The change I would argue for:** the **OHLCV data layer should be pulled
earlier**, in parallel with Persistence rather than inside the Technical phase.
Reasons: it is the largest and most uncertain piece of work (§4.1 — no provider
chosen, none currently integrated); it must accumulate history *before* the
backtest corpus can exist, and that accumulation is wall-clock-bound, not
effort-bound; and Momentum v2 would independently benefit from real candles
rather than DexScreener's aggregate windows.

Concretely: start persisting canonical-market OHLCV during the Persistence phase.
By the time Technical Intelligence is built, there is a corpus to validate it
against instead of a cold start.

One caution on Paper Trading's position: it is placed after Technical, which is
right if technical signals feed entries. But Paper Trading also needs a
measurement harness that overlaps heavily with §22's backtest framework. Building
§22 first and reusing it is cheaper than building both.

---

## 25. Self-review

Critiquing this specification before calling it done.

**Subjective definitions.** Removed: Adam & Eve, complex H&S, discretionary
"smart money" vocabulary. Retained-but-flagged: continuation wedges (distinguished
from reversal wedges only by context) and trend exhaustion. Both need sharper
criteria before implementation.

**Unnecessary complexity.** The 57-pattern catalog is research, not a build list.
The recommended Tier 1 is eleven structures, most sharing one engine. If Tier 1
underperforms in validation, the answer is to fix it, not to add Tier 2.

**Overlapping patterns.** Real and unresolved in places: pennant vs. symmetrical
triangle (nearly identical geometry); rectangle vs. horizontal range (the same
object with different trend context); fakeout vs. failed breakout (one object,
two names — collapsed to one here); Harami vs. Inside Bar (collapsed to Inside
Bar); Three Rising Valleys vs. HL sequence (dropped as redundant).
**Deduplication is a named pipeline stage (§3.1) precisely because this is
endemic.**

**Unreliable patterns.** Diamonds, broadening formations and rounded tops are
rated L/N on false-positive grounds, not popularity.

**Provider lock-in.** Avoided by an adapter boundary, but the risk is real: only
one candidate is keyless, and per-pool history depth varies. If the chosen
provider lacks history from first block, the backtest corpus is compromised.
Flagged as an open question.

**Normalization.** The main weakness is ATR itself on very short history. A
token with 20 candles has an ATR estimated from 20 candles, dominated by the
launch candle. Mitigation: a minimum-warmup requirement and a cross-sectional
volatility prior from similar-age tokens; neither is specified in detail yet.

**Ambiguous confidence.** Addressed head-on (§16), but the risk of a UI reader
conflating match confidence with probability remains. It must be a deliberate
labelling decision, not a tooltip.

**Scalability.** §20.4 identifies bottlenecks but commits to no numbers. Honest,
and a gap.

**Untestable assumptions.** The largest: that classical patterns carry *any*
information on Solana microcaps. There is no evidence either way. The engine is
designed so that a negative answer is survivable — Tier 1 is structure and
breakout logic, which is useful for describing state even if predictive value is
nil.

**Overlap with Momentum Intelligence.** The sharpest architectural risk. Momentum
measures *rate of price and activity change*; Technical measures *geometry and
levels*. They will overlap on trend direction, volume expansion and breakout
detection. Proposed boundary: **Momentum owns scalar rate-of-change over fixed
windows; Technical owns pivot-derived structure and levels.** Where both can
answer (e.g. "is this trending up?"), Technical defers to Momentum for the
scalar and reports only the structural label. This needs settling when Momentum
v2 is designed, not after.

**Overlap with Buyer Intelligence.** Lower risk. Buyer Intelligence analyses
*who* is trading; Technical analyses *what price did*. The contact point is
volume integrity, which should be owned by Bot/Sybil and consumed by both.

**Unsupported predictive claims.** Deliberately none. §2.3 states the only claim
permitted, and §16 forbids publishing predictive probabilities until §22 produces
them.

---

## 26. Open research questions

1. Do any classical patterns carry information on Solana microcaps? **Unknown.**
   Nothing in the literature addresses this asset class. Token Finder's own
   backtest is the only path to an answer.
2. What ATR multiple makes a defensible shoulder-similarity tolerance for tokens
   with 10%+ hourly ATR? Needs calibration.
3. Can pivot detection be made stable on series where one candle is 40% of the
   total range? The launch candle may need explicit exclusion from ATR and
   prominence baselines.
4. Which provider offers pool-level OHLCV from first block for tokens that later
   die? Dead-token history is what a backtest needs most and what providers are
   least likely to retain.
5. How should bonding-curve → AMM migration be represented — as one continuous
   market or two? It affects every pattern spanning the migration.
6. Is a cross-sectional volatility prior (cohort of similar-age tokens) a sound
   substitute for own-history ATR during warm-up?
7. What is the minimum viable history for each Tier 1 structure, measured rather
   than assumed?
8. Does volume confirmation retain any value once wash-traded volume is filtered,
   or does filtering remove so much that confirmation becomes untestable?
9. Where exactly should the Momentum/Technical boundary sit (§25)?
10. Should `NO_TRADE` intervals be dropped, or carried as explicit gaps? It
    changes every time-based tolerance in every spec.
