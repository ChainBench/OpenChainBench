# Provider onboarding audit — Serialized (serialized.xyz)

> **Pre-onboarding evaluation.** Run before Serialized is wired into any live harness, so the
> decision to include or exclude them on each bench is documented and reproducible.
>
> **Version:** v1.1, 2026-09-05 (v1.0 same day; §8 corrected, §16 added). Author: internal. Key used: tenant `OpenChainBench`,
> plan `starter`, keyId `d5511a080aaa`, issued 2026-09-04.

---

## 1. What this document is

Serialized is a candidate provider for several existing OpenChainBench benchmarks. This file
records the apples-to-apples tests run against them, the exact methodology of each test, the
numbers that came back, and the methodology problems those tests exposed in **our own benches**.

Every test below replicates the scoring rule of the target bench rather than inventing a new one,
so the numbers are directly comparable to the published leaderboards.

## 2. Test harness and vantage point

| Property | Value |
|---|---|
| Host | `ocb-par-main` (the VPS that runs the production harnesses) |
| Rationale | Same egress, same region, same network path as the live monitors. A latency or coverage number taken from a laptop is not comparable to a published bench value. |
| Incumbent credentials | Read from the running `ocb-metadata-coverage` container env, never copied off the box |
| Scripts | `~/serbench/ab.py`, `ab2.py`, `ab3.py`, `ab4.py`, `wsab.py` |
| Date of run | 2026-09-05 |

**Throttling matters.** Serialized enforces a hard burst cap of 40 in-flight requests per second.
An unthrottled 8-worker pool produced 60 `429 RATE_LIMITED` responses out of 100 anchors and made
their coverage look like 37%. The same test throttled to 12 rps produced 0 errors and 77%. Any
harness that talks to them must rate-limit client-side, and any measurement that does not is wrong.

## 3. Provider surface

19 chains: 18 EVM plus Solana. `evm:1`, `evm:56`, `evm:130`, `evm:143`, `evm:196`, `evm:988`,
`evm:1514`, `evm:2741`, `evm:4217`, `evm:4326`, `evm:4663`, `evm:5042`, `evm:8453`, `evm:9745`,
`evm:42161`, `evm:43114`, `evm:57073`, `evm:645749`, `solana`. Audit engine covers the 18 EVM chains.

Auth is a raw `Authorization` header, no `Bearer` prefix (same convention as Mobula). The
documented `demo.serialized.xyz` server returns 403 outside their docs playground, so there is no
keyless path for a harness.

## 4. Rate limits and quota (measured, not quoted)

| Property | Documented | Measured |
|---|---|---|
| Monthly credits (starter) | 150,000 | **1,000,000** on our key |
| Per-minute rate | 1,200 | 1,200 (`x-ratelimit-limit` header) |
| Burst | 40 req/s | Exactly 40. 60/100/150 concurrent all yielded exactly 40× `200` and the rest `429`. Deterministic, no jitter. |
| Sustained | not stated | 891/891 `200` over 60 s at 15 rps, p50 38 ms, p99 67 ms |

Response headers expose `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset` and
`x-credits-remaining`. Good enough to instrument a harness without guessing.

Streams bill 1 credit per connection-minute. Limits are 5 concurrent connections, 20 subscriptions
per connection and 50 distinct tokens or pools per key. Bench 001 runs 3 regions × 4 chains, which
does not fit inside one key's 5-connection budget: it needs one key per region.

## 5. Bench 008 — wallet-labels-coverage

**Replica rule.** Identical to `harnesses/wallet-labels`: the same 178-anchor curated list, filtered
to the 5 chains Serialized covers (100 anchors, 59 contract / 41 EOA); a "hit" is any non-generic
name, using the harness's exact `genericLabel` exclusion set; Mobula queried through
`POST /api/1/wallet/labels` with the same field-precedence (`entityName` → `entityLabels` → `labels`).
Serialized queried through `GET /v1/wallet/profile`, taking the first non-generic of
`displayName` → `ensName` → `basename` → `solName`.

**Added dimension (not in the bench today):** accuracy. A hit is counted accurate when the returned
label shares a meaningful token with the curated `Hint` for that anchor.

| Provider | Coverage | Contract | EOA | Accurate | Accurate given hit | p50 |
|---|---|---|---|---|---|---|
| **Serialized** | **77.0%** | 76.3% | 78.0% | **58.0%** | 75.3% | 45 ms |
| Mobula | 59.0% | 54.2% | 65.9% | 44.0% | 74.6% | 34 ms |

Per chain (coverage / accuracy):

| Chain | n | Serialized | Mobula |
|---|---|---|---|
| ethereum | 32 | 96.9% / 78.1% | 62.5% / 53.1% |
| bnb | 15 | 80.0% / 60.0% | 80.0% / 46.7% |
| base | 17 | 76.5% / 58.8% | 70.6% / 47.1% |
| arbitrum | 17 | 58.8% / 52.9% | 47.1% / 41.2% |
| solana | 19 | 57.9% / 26.3% | 36.8% / 26.3% |

**Verdict: include.** Serialized leads on coverage and on absolute accuracy on every chain in scope.

**Bench flaw this exposed.** 25% of Serialized's hits are wrong (19 of 77). Mobula's ratio is
almost identical (74.6% accurate given hit). The bench scores presence of a non-generic string, so a
personal ENS or `.sol` name registered against a well-known contract counts as a correct entity
label. Concrete cases: Permit2 → `dex.davywoodfi.eth`, Uniswap V3 Router 2 → `factory.vibebet.eth`,
Base USDC → `jakie.base.eth`, Raydium Authority → `bonklanatoken.sol`, BSC USDT → `Fake_Phishing6512`,
OKX 1 → `Bittrex 3`, Bitfinex → `Polygon`.

This is a pre-existing, provider-neutral gameability hole. It should be fixed **before** Serialized
is published, not after, otherwise the fix looks like a reaction to a new entrant beating the
incumbent. Recommended fix: score against the curated `Hint` (the harness already carries it and
already ignores it), or exclude name-service strings from the hit rule.

## 6. Bench 004 — metadata-coverage

**Replica rule.** Same 4 fields as the bench (`logo`, `description`, `twitter`, `website`). Discovery
via GeckoTerminal `new_pools` (an independent third source, so neither provider's own discovery
biases the sample). Both providers queried on the **same token set**, and only tokens that **both**
resolved are scored, so the denominator is identical.

| Chain | paired n | Serialized | Mobula |
|---|---|---|---|
| solana | 48 | 10.4% | 34.4% |
| base | 37 | 19.6% | 34.5% |
| bsc | 38 | 60.5% | 80.9% |
| **total** | 123 | **28.7%** | **48.8%** |

Field breakdown:

| Chain | Field | Serialized | Mobula |
|---|---|---|---|
| solana | logo | 22.9% | 100.0% |
| solana | description | 8.3% | 25.0% |
| solana | twitter | 8.3% | 8.3% |
| solana | website | 2.1% | 4.2% |
| base | logo | 37.8% | 100.0% |
| base | description | 13.5% | 13.5% |
| base | twitter | 18.9% | 16.2% |
| base | website | 8.1% | 8.1% |
| bsc | logo | 78.9% | 100.0% |
| bsc | description | 78.9% | 71.1% |
| bsc | twitter | 78.9% | 76.3% |
| bsc | website | 5.3% | 76.3% |

**Verdict: include, but fix the logo field first.**

**Bench flaw this exposed.** Mobula returns `logo` = 100% on all three chains. That is not a data
advantage, it is a URL-shape artifact: Mobula rewrites every logo onto `metadata.mobula.io` at a
deterministic path (`/assets/logos/<chain>_<chain>_<address>`), so the field is never empty
regardless of whether an image exists. Serialized returns the upstream source URL instead
(`ipfs.io`, `gmgn.ai`, `axiomtrading.axiom-cdn.io`, `pbs.twimg.com`, `flap.sh`). A HEAD check on 12
distinct Mobula logo URLs resolved 11 and 404'd 1.

The bench currently measures *"is the field non-empty"*, which any provider can win by construction
by rewriting to its own CDN. It should measure *"does the logo resolve"* (HEAD 200 with an image
content type). Mobula is our own product and it is the beneficiary of the current rule, so this needs
fixing on fairness grounds before a competitor is added to the same leaderboard.

Excluding the logo field entirely, on the remaining three fields Serialized is level with Mobula on
Base, ahead on BSC description and twitter, and behind on Solana and on BSC website.

## 7. Benches 005 / 090 — chain-count coverage

| Bench | Incumbents | Serialized |
|---|---|---|
| 005 asset-registry | CoinGecko 465, CoinPaprika 310, CoinStats 149, Mobula 81 | **19** |
| 090 dex-network | GeckoTerminal 247, Codex 123, Sim by Dune 64, DexPaprika 35 | **19** |

**Verdict: exclude for now.** Serialized would rank last by a wide margin on both. The metric is
breadth, their product is deliberately narrow-and-deep. Adding them here produces a true but
uninformative row and gives them a reason to refuse every other bench. Revisit only if they ask.

Note: the GeckoTerminal count returned 100 in this run because the ad-hoc pager stopped early on
rate limit. The production harness value of 247 is the correct one.

## 8. Bench 001 — aggregator-head-lag

**Replica rule.** Single process on `ocb-par-main`, two WebSocket connections open simultaneously,
subscribed to the **same three tokens** (BONK / Solana, DEGEN / Base, CAKE / BNB). Serialized:
`wss://api.serialized.xyz/v1/stream`, `subscribe` on channel `trades` with `{chain, address}`.
Mobula: `wss://api.mobula.io`, `fast-trade` with `assetMode: true`. Trades matched by transaction
hash, so every comparison is the same on-chain event seen by both pipelines. 240 s window.

Note on protocol shape: Serialized's `params.pools` is a comma-separated **string**, not an array,
and `address` is required even when `pools` is supplied. Their trade events carry the hash inside
`data.id` as `<txHash>:<suffix>`, not as a `txHash` field, despite the docs naming `txHash` as the
dedup key.

### Relative arrival, the only comparison free of self-reported timestamps

| Chain | matched n | p10 | p50 | p90 | Serialized first |
|---|---|---|---|---|---|
| solana | 74 | −288 ms | **−0 ms** | +29 ms | 51% |
| base | 13 | −43 ms | +88 ms | +177 ms | 23% |
| bnb | 0 | — | — | — | Mobula returned no CAKE events in this window |
| **all** | 87 | | **+2 ms** | | **47%** |

Negative means Serialized delivered the trade first. **It is a dead heat.** Across 87 matched
trades the median difference is 2 ms and the two feeds trade the lead roughly half the time. On
Base, Mobula was actually ahead on 77% of trades despite Serialized running a preconfirmation feed.

### The finding that matters: providers disagree about when the trade happened

For the **same transaction hash**, the two providers' own on-chain timestamps differ:

| Chain | serialized `at` minus mobula `date` | p10 | p50 | p90 |
|---|---|---|---|---|
| solana | | −1,620 ms | **−707 ms** | −353 ms |
| base | | +1,000 ms | **+1,000 ms** | +2,000 ms |

Consequence, measured directly:

| Chain | Provider | Self-reported lag p50 | Actually delivered first |
|---|---|---|---|
| solana | Mobula | +0.04 s | 49% |
| solana | Serialized | +0.75 s | 51% |
| base | Serialized | −0.33 s (13/13 negative) | 23% |
| base | Mobula | +0.78 s | 77% |

Read those two tables together. On Solana, Mobula's self-reported lag is 19× better than
Serialized's, and the two arrive at the same instant. On Base, Serialized's self-reported lag is
negative while Mobula beats it to the wire on three trades out of four. **Any head-lag number built
on a provider's own timestamp is not a latency measurement, it is a measurement of where that
provider chooses to put its clock.**

**Correction, 2026-09-05 (v1.1).** An earlier draft of this file claimed bench 001 already
references archive nodes and was therefore unaffected. That was wrong: it repeated the spec's
methodology instead of reading the harness. `harnesses/aggregator-head-lag` contains no archive-node
reference at all (`grep -rl "archive|eth_getBlockByNumber|getBlockTime|blockTimestamp"` over
`cmd/` returns nothing). The gauge that feeds the leaderboard is computed from each provider's own
self-reported timestamp:

```go
// head_lag_monitor.go:211  (Mobula)
onChainTime := time.UnixMilli(trade.Date)     // Mobula's own field
totalLagMs  := receiveTime.Sub(onChainTime)
// head_lag_monitor.go:707  (Codex)
onChainTime := time.Unix(event.Timestamp, 0)  // Codex's own field
```

The published spec says otherwise in three places: `methodology[7]` ("Reference: archive nodes per
chain, validated against block hashes"), the FAQ ("The harness holds a live WebSocket subscription
to canonical-tip archive nodes on each chain"), and the per-chain explainers ("Measured against a
canonical archive node"). The documentation and the code disagree, on a live bench that is publicly
cited. That is a defect independent of Serialized and should be resolved before any provider is
added.

Second code-level issue, `head_lag_monitor.go:219`:

```go
if totalLagMs < 0 || totalLagMs > 30000 { continue }
```

Negative lags are dropped silently. Serialized's Base feed was negative on 13 of 13 sampled trades,
so under this filter its entire Base preconfirmed population would be discarded and its Base sample
would retain only its slowest trades. This is a measurable bias, not a policy question.

Recommended resolution: make the harness hold its own node subscription per chain and timestamp each
swap on receipt, matching by transaction hash. That is what the spec already claims, so no published
text changes, and it makes the three providers comparable for the first time.

**Blocking issue: Base preconfirmations.** Serialized emits Base trades from flashblocks
preconfirmations, ahead of the block timestamp they attach to the event. Measured on their stream,
Base events arrive with a **negative** lag versus their own `at` field (p50 −1.86 s, 3/3 negative in
the first sample). Their docs state this explicitly (~2.5 s ahead).

Measured on Base against Mobula on matched hashes: Serialized reports 13/13 negative self-lag while
losing the actual race 77% of the time. So the preconfirmation feed does **not** currently translate
into earlier delivery on Base, it only translates into an earlier timestamp. That distinction has to
survive into whatever the bench publishes. Options, in order of preference:

1. Add a `confirmation` dimension (`confirmed` / `preconfirmed`) and rank within it.
2. Clamp negative lag to 0 and footnote it.
3. Exclude Base for Serialized.

Option 3 is the least honest, because their preconfirmed feed is a real product advantage for a
trading UI. Option 1 is the one that survives a public dispute.

## 9. Bench 067 — portfolio-chain-coverage

`GET /v1/wallet/positions` returned `200` on all 19 chains with zero errors. Rows came back on 6
chains (ethereum 238, bsc 121, hyperevm 23, solana 13, arbitrum 12, avalanche 9) and 0 rows on the
other 13.

**This test is inconclusive and must not be quoted.** The zero-row chains reflect probe addresses
that hold nothing there, not unsupported chains. Bench 067 compares self-declared coverage against
probe-verified coverage, which requires a curated funded address per chain. That curation is the
work item; the endpoint itself is ready.

## 10. Bench 102 / 033 — not applicable

Serialized is not a swap router and returns no quotes. `token-quote-coverage` (102) and
`evm-quote-latency` (033) cannot include them. Their `/v1/pulse` endpoint tracks ~90 launchpads and
is usable as an **alternative discovery source** for bench 102, which is a separate question.

## 11. Latency, head to head

REST, identical call shape, 20 samples each, from `ocb-par-main`:

| Chain | Serialized p50 / p90 | Mobula p50 / p90 |
|---|---|---|
| base | 72 ms / 180 ms | 74 ms / 364 ms |
| solana | 50 ms / 58 ms | 39 ms / 180 ms |
| ethereum | 43 ms / 57 ms | 40 ms / 186 ms |

Median is a tie. The tail is not: Serialized's p90 is 2× to 3× tighter on every chain. That
consistency is the more defensible claim, and it is not currently measured by any bench.

## 12. Stretch tests

| Test | Result |
|---|---|
| Burst threshold | Hard cap at exactly 40 concurrent. 20 and 40 pass clean; 60/100/150 return 40× `200` and the remainder `429` with an explicit `Burst limit: max 40 requests per second` message |
| Sustained 60 s @ 15 rps | 891/891 `200`, p50 38 ms, p99 67 ms, zero degradation |
| `POST /v1/token` batch | 25 items → `200`, 526 ms, 25 rows |
| `POST /v1/token/price` batch | 100 items → `200`, 38 ms, 100 rows |
| Batch over cap | 200 items → `400 INVALID_PARAM`, "must NOT have more than 100 items". Enforced, not silently truncated |
| OHLCV page cap | `limit` ≤ 500, enforced with a clear `400` |
| OHLCV history depth | 1s → 0.01 d, 1m → 0.35 d, 5m → 1.73 d, 1h → 20.8 d, 1d → 499 d (back to 2025-04-24), 1w → 973 d (back to 2024-01-04) |
| Trades pagination | 10 cursor pages, 1,000 trades in 6.4 s, no gaps or repeats |
| Error contract | `INVALID_CHAIN`, `INVALID_PARAM`, `NOT_FOUND`, `UNAUTHORIZED`, `RATE_LIMITED` all machine-readable and correct for the case |

## 13. Defects found

| # | Endpoint | Symptom |
|---|---|---|
| 1 | `GET /v1/wallet/equity/history` | `503 UPSTREAM_ERROR` after a 10 s hang, reproduced twice |
| 2 | `GET /v1/wallet/transfers` | 6.5 s response on a routine call. Not benchmarkable as-is |
| 3 | `GET /v1/token/trades`, `/stats`, `/dev-tokens` | `404` for the native wrapped mint (`So111…112`). Native is treated as a quote asset, never as a token. Any harness iterating a standard basket will hit this |
| 4 | Parameter naming | Three conventions on one API: `/v1/pulse` takes `chains` (plural), `/v1/wallet/*` takes `wallet`, `/v1/wallet/profile` takes `address` |

## 14. Third-party sourcing

Worth knowing before any commercial discussion, neutral observation either way:

- Their token `iconUrl` values are upstream URLs from `cdn.dexscreener.com`, `ipfs.io`,
  `raw.githubusercontent.com`, `arweave.net`, `gmgn.ai`, `axiomtrading.axiom-cdn.io`.
- Their wallet-profile entity avatars are served from `metadata.mobula.io`, our own CDN.

## 15. Recommended sequence

1. Fix the bench 004 logo rule (resolve-check instead of presence-check) and the bench 008 hit rule
   (score against the curated hint). Both are provider-neutral fairness fixes and both should land
   before a new entrant appears on those leaderboards.
2. Onboard Serialized to bench 004 and bench 008. Both are 1:1 endpoint mappings.
3. Bench 001: they are level with Mobula on wall-clock delivery (p50 +2 ms over 87 matched trades),
   so they belong on the leaderboard. Decide the Base preconfirmation policy first, and keep the
   archive-node reference: this audit showed self-reported timestamps disagree by up to 1.6 s on the
   same transaction.
4. Curate funded probe addresses per chain for bench 067, then onboard.
5. Leave 005 and 090 alone unless they ask.
6. Consider a new token-security bench, where their `/v1/token/security` (18 fields) and
   `/v1/audit/contract` are a genuine differentiator rather than a last-place row.

Every onboarding needs a `docker build --no-cache` of the materialize-worker on `ocb-par-main`
after the harness change, or the new provider will not appear.


## 16. Follow-up tests, 2026-09-05

### 16.1 Bench 067, now conclusive

The earlier §9 result was inconclusive because it used the wrong probe address. The harness already
pins canonical ones in `registry.go`: EVM `0xF977...aceC` (Binance 8), Solana `9WzDX...WWM`, with a
$1 USD floor. Re-run verbatim against those:

| Metric | Serialized |
|---|---|
| listed (`/v1/meta/chains`) | 19 |
| verified (returned a > $1 balance) | **5** |
| errors | 0 |
| total probe latency, 19 calls | 1,696 ms |

Verified: ethereum (177 positions, $72.7M), bsc (93, $43.9M), base (27, $5.1M), arbitrum (12,
$3.5M), solana (1, $12). The other 14 chains returned zero rows because Binance 8 holds nothing
there, which is the harness's own "untestable residue" (`listed - probed`), not an indexer failure.

Published leaderboard: CoinStats 127, Mobula 50, Zerion 42, Moralis 15. Serialized would rank
last at 5. Verdict: addable and now measurable, but it is a third breadth metric and a third last
place. Their `verified / probed` ratio is 5/5, which the bench exposes as a separate series and is
the only flattering read available.

### 16.2 Negative capability probes

Confirmed by request rather than by reading docs. Every path returns `404 NOT_FOUND`:
`/v1/wallet/nfts`, `/v1/nft/collection`, `/v1/nfts`, `/v1/swap/quote`, `/v1/quote`, `/v1/route`,
`/v1/bridge/quote`. Benches 033, 102, `nft-collection-metadata`, `bridge-fee` and
`bridge-quote-latency` are definitively out.

### 16.3 A real pricing defect: BONK is 5.2x wrong

| Source | BONK price |
|---|---|
| Mobula | 3.3097e-06 |
| DexScreener (Orca, $305,835 liquidity) | 3.309e-06 |
| GeckoTerminal | 3.309731e-06 |
| **Serialized** | **6.3314e-07** |

Three independent sources agree; Serialized is low by a factor of 5.2, and reports a $55.7M market
cap against a real ~$290M.

Root cause is visible in their own response. `/v1/token/pools?chain=solana&address=DezXAZ...` ranks
`Gx1WGimRY3jF...` first with liquidity 4,339, and the deep Orca pool everyone else prices from is
absent from the list entirely. Their own ranks 2 and 3 quote ~3.18e-08 and ~3.20e-08 native against
rank 1 at 6.09e-09, so the pool list is internally inconsistent by the same 5x. This is pool
discovery missing the main market, not a decimals bug (`decimals: 5` is correct for BONK).

Worth raising with them directly: a top-100 token mispriced 5x is a bigger problem for their
prospects than any leaderboard position.

### 16.4 Cross-API price accuracy as a new bench: not proven

Two attempts, neither conclusive, recorded so nobody repeats them:

1. Basket from a DexScreener search returned eight distinct addresses all symbolled "SOL", i.e.
   impostor tokens rather than eight real assets. Result discarded.
2. Basket from GeckoTerminal top pools (28 distinct tokens) gated on DexScreener and GeckoTerminal
   agreeing within 200 bps. Only 3 tokens survived, because GeckoTerminal returned no price for 25
   of them. n=3 proves nothing.

The idea remains the most promising new bench for this vertical, and the BONK case shows the signal
is real. But it cannot be built on another aggregator as reference: the reference has to be computed
from on-chain reserves of the deepest pool over an RPC we control, which is the actual work and the
actual reason the bench would be defensible.
