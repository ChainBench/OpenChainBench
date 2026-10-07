# trading-agent-alpha

Bench № 284. What eight frontier models earn once the asset they were pointed
at is taken out.

## Run it

```bash
go run .                 # one pass immediately, then hourly
POLL_SEC=600 go run .    # faster, floor is 300s
curl localhost:2115/metrics
```

No credentials. Both upstreams are public and keyless.

## What it measures

Recall Labs runs a weekly spot arena on Base: eight agents trade the same
ETH/USDC pair for six days under identical rules, each agent being one Recall
harness wrapped around a different frontier model. Recall publishes who won
each round.

That leaderboard cannot answer the question a reader has, because the arena is
single-asset. Every agent holds a mix of ETH and USDC, so a round's return is
mostly ETH's move: across the scored rounds the round median correlates with
ETH's own return at 0.81, R² 0.66, and the agents' implied exposure is beta
0.43. **Ranking raw returns ranks ETH weeks.**

So the headline is alpha: compounded return over the rounds an agent funded,
minus a passive position at *that agent's own measured beta*, compounded over
exactly those same rounds. Nobody is charged for a round they sat out, and
nobody is credited for the market rising.

## Metrics

| metric | meaning |
| --- | --- |
| `trading_agent_alpha_pct` | the headline: return minus the same-exposure passive hold |
| `trading_agent_return_pct` | compounded return, context only |
| `trading_agent_passive_pct` | the counterfactual the alpha is measured against |
| `trading_agent_asset_pct` | holding the asset outright over the same rounds |
| `trading_agent_hit_rate_pct` | share of funded rounds above zero |
| `trading_agent_beta` | measured exposure, not assumed |
| `trading_agent_rounds` | funded rounds behind every figure |
| `trading_agent_rounds_scored` | rounds that carried a real field |
| `trading_agent_rounds_skipped` | rounds refused, by reason |
| `trading_agent_last_round_end_timestamp_seconds` | the freshness that matters |

Every figure is published twice, once under the agent's real input modality
and once under `kind="all"`. That is not redundancy: the site replaces a label
selector only when it is pinned to `="all"`, so without the pooled series the
default tab renders empty.

## Three traps, each of which produced a wrong number first

**A zero is usually not a flat trade.** 88 of the 90 zero rows in this arena
carry `portfolioValue == 0`, meaning the agent did not fund that round.
Counting them as 0 % returns dropped the hit rate from 33 % to 22 % and
inflated each sample from ~22 rounds to 34. Only funded rounds count.

**Eleven ended rounds carry ranks 1..8 and no data at all.** The API serves
them. Publishing those ranks would be fabrication, so a round needs
`minFieldSize` funded agents before it is scored, and the refusals are
published as `trading_agent_rounds_skipped{reason="no_field"}`.

**The arena has had two rosters.** `minRounds` selects the eight-model roster
that 32 rounds share; the handful of entries with two or three appearances are
not averaged into the same table.

## What it does not measure

Recall builds the agents: *"Autonomous live spot trading agent built by Recall
Labs, powered by &lt;model&gt;"*. The prompt, the rebalancing and the execution are
Recall's and are held constant. This is **one harness interacting with each
model**, never a model's trading ability in the abstract. The agent names are
declared, not verified.

Portfolios are small, medians in the low hundreds of dollars, so nothing here
speaks to behaviour at a size where slippage and capacity bind.

## Upstream quirks worth knowing

- The docs say every request needs a bearer token. It does not:
  `/api/competitions` and `/api/competitions/<id>/agents` answer anonymously.
- `limit=200` returns **HTTP 200** with `{"success":false,"error":"Internal
  Server Error"}`. 100 is the ceiling, and the harness trusts the `success`
  field rather than the status line.
- Results back to May 2025 are still served, so the harness can be stateless.
- The asset counterfactual comes from Coinbase's public candles, deliberately
  outside Recall: a benchmark drawn from the same source as the thing it
  measures is circular.

## Verification

Two independent implementations agree on all eight agents to the decimal: this
Go harness, and the Python analysis in the session that designed the bench. Any
change to the model should re-establish that agreement rather than assume it.

MIT, same as the rest of the repo.
