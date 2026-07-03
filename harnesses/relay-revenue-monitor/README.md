# relay-revenue-monitor

OCB bench `bridge-revenue` companion harness. Tracks the Relay solver
EOA `0xf70da97812CB96acDF810712Aa562db8dfA3dbEF` total wallet balance
over time via Mobula's `/wallet/portfolio` endpoint, then publishes the
24h / 7d / 30d net balance delta as a floor on Relay's captured margin.

## Why balance delta, not inflows

The solver receives the full deposit on the origin chain then forwards
almost all of it to the user on the destination chain. Tracking inflows
measures gross swap throughput, which on Relay is in the multi-million
USD per day range and tells us nothing about how much value Relay
actually retains.

Net balance change over a window = margin captured + sweeps to ops. As
long as we know the solver is a hot wallet (not actively swept to cold
storage every hour), the delta is a defensible floor on Relay's actual
take from the system.

## Why two flavours: total vs stables

Two delta lines are exposed:
- `relay_solver_balance_delta_usd{kind="total"}` — sums every asset in
  the wallet at its current USD price
- `relay_solver_balance_delta_usd{kind="stables"}` — sums only USDC,
  USDT, DAI and a few other USD-pegged tokens

The total figure includes price-movement noise (ETH up 5% = the wallet
is "worth" more without a single new fee). The stables figure strips
that noise: a $1k stables delta over 24h is purely cash flow.

For the bench we display the stables delta as the headline floor.

## Cadence

One portfolio fetch every 300 seconds (5 min) by default. Each fetch
takes 5 to 15 s for a multi-chain wallet of this size, so we keep the
HTTP timeout generous (90 s). Override with `POLL_INTERVAL_SEC` env if
needed (lower bound 60 s).

## Run locally

```bash
cp .env.example .env
# fill MOBULA_API_KEY
go build -o monitor ./cmd/monitor
./monitor
```

## Deploy on Railway

Secrets are baked into the Dockerfile per the project's deploy
convention. Railway just needs:
- Repo: `MobulaFi/mobula-monorepo`, branch `dev`
- Root Directory: `miniapps/relay-revenue-monitor`
- Builder: `DOCKERFILE` (auto via `railway.toml`)

No env vars need to be configured in the Railway dashboard. To rotate a
secret, edit the Dockerfile and redeploy.

## Endpoints

- `:2112/metrics` Prometheus scrape
- `:2112/logs?tail=N` last N log lines (token-gated by LOGS_TOKEN if set)
- `:2112/healthz` liveness probe

## Metrics

- `relay_solver_balance_usd{kind=total|stables}` gauge — latest snapshot
- `relay_solver_balance_delta_usd{kind, window}` gauge — rolling delta over 24h, 7d, 30d
- `relay_solver_assets_count` gauge — diagnostic, total assets held
- `relay_solver_poll_duration_seconds` gauge — last fetch latency
- `relay_solver_polls_total` counter — successful polls
- `relay_solver_poll_errors_total` counter — failed polls
- `relay_solver_window_snapshots` gauge — snapshots in memory

## Limitations

- In-memory window. Restart wipes history; 24h delta needs 24h of
  runtime to populate. To survive restarts wire Redis later.
- Mobula portfolio coverage is whatever Mobula indexes; if a chain
  Relay supports is not in Mobula's coverage the balance there is
  invisible to the floor. Currently Mobula returns ~$7M total for the
  solver across the chains it sees.
- Sweeps from the solver to a cold storage / multisig appear as a
  negative balance delta and subtract from the apparent margin. If
  Relay ops sweep heavily on a given day the floor undershoots. This
  is acceptable for a floor metric; a future v2 can track outflows
  to known ops addresses and add them back.

## Where this feeds

The OCB `bridge-revenue` bench reads these metrics via the shared OCB
Prometheus gateway. The bench page renders Relay with two rows: the
existing ceiling (USD-in minus USD-out minus gas minus app fees) and
the new floor from `relay_solver_balance_delta_usd{kind="stables",
window="24h"}`. Real Relay revenue sits between the two.
