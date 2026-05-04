# Harnesses

Each subdirectory is a benchmark runner — a long-running process that calls providers, measures latency / cost / success, and exposes Prometheus metrics on `/metrics`. Anyone can clone, fork, host, or contribute one.

```
harnesses/
├── aggregator-head-lag/   Bench № 001 — Go service, exposes :2112/metrics
└── bridge-monitor/        Bench № 002 + № 003 — Go service, exposes :9090/metrics
```

A single harness can serve multiple benchmarks when the same set of measurements is consumed by more than one spec — `bridge-monitor` is the canonical example, producing both `bridge_quote_latency_ms` (read by `bridge-quote-latency.yml`) and `bridge_cost_percent` (read by `bridge-fee.yml`).

## Hosting model — federation, not centralization

OpenChainBench does **not** centralize harness execution. Each harness is hosted by whoever owns it:

- **Mobula** runs `aggregator-head-lag` and `bridge-monitor` on its own Railway infrastructure (sponsoring those two benchmarks).
- **Independent contributors** run their own harnesses on whatever infra they prefer (Railway, Fly, Cloud Run, a VPS, a home server with a static IP).
- **Providers that want to be benchmarked on their own service** can host the harness themselves and submit a scrape config — the data path is identical to externally-hosted benchmarks.

The only piece of infrastructure the project shares is a single Prometheus instance ([`/infrastructure/prometheus`](../infrastructure/prometheus)) that scrapes every harness's public `/metrics` endpoint and aggregates everything into one queryable URL. The site queries that URL.

This means you never share API keys with the project. You run your harness with your own credentials, on your own infra, on your own dime — the maintainers never see your secrets.

## Contract

A harness is a **data producer**, nothing more. It must:

| Concern | Requirement |
| --- | --- |
| Inputs | Read API keys / wallet keys from environment variables, never commit them |
| Loop | Run continuously and update the same metric set every iteration |
| Metric names | Match the names referenced in the matching `benchmarks/<slug>.yml` exactly |
| Labels | Include `provider` (or equivalent) and `region` at minimum; chain/route labels encouraged |
| Endpoint | Expose `/metrics` over HTTPS on a publicly reachable URL. The OpenChainBench Prometheus scrapes from the public internet — no VPN-only addresses |
| Timeouts | Documented; failures fail closed (counted toward success rate, excluded from latency aggregates) |
| Reproducibility | README explains how to run locally with one command |
| License | MIT, same as the rest of the repo |

A harness does **not** ship its own Prometheus, Grafana, Alertmanager, or `docker-compose.yml`. Hosting choice is the contributor's, but the data plane is shared.

## Subdirectory layout

```
harnesses/<slug>/
├── README.md           What it measures, providers, labels, env vars, port
├── Dockerfile          Container image for the runner
├── .env.example        Every env var the runner reads, with placeholders
└── …                   Source files in whatever language fits
```

## Submitting a new harness

See [`/CONTRIBUTING.md`](../CONTRIBUTING.md) for the full submission flow. Short version:

1. Open an issue with the [📊 Propose a benchmark template](https://github.com/OpenChainBench/OpenChainBench/issues/new?template=new-benchmark.yml).
2. Build the harness here at `harnesses/<slug>/`.
3. Deploy it on whatever infra you prefer, expose `/metrics` over HTTPS at a stable URL.
4. Append a scrape job to [`infrastructure/prometheus/prometheus.yml`](../infrastructure/prometheus/prometheus.yml) pointing at your URL.
5. Write the spec at `benchmarks/<slug>.yml`.
6. Open a PR.

Once merged, a maintainer redeploys the central Prometheus to apply the new scrape job — your benchmark appears on the site within 60 seconds (next ISR cycle).

## Hosting tips for contributors

A few options for hosting a harness, ranked roughly from "trivial setup" to "more control":

- **Railway** (via this repo, root `harnesses/<slug>/`) — same workflow as how Mobula hosts its harnesses. Free tier covers most light harnesses.
- **Fly.io** — `fly deploy` in any folder with a Dockerfile. Generous free tier.
- **Google Cloud Run** — pay-per-use, scales to zero.
- **VPS (Hetzner, DigitalOcean, OVH)** — €5/mo, full control, run a `systemd` service exposing a port.
- **Your laptop with ngrok** — fine for short-lived experiments, not for live benchmarks.

Whatever you pick, the OpenChainBench Prometheus only needs `https://<your-host>/metrics` to be reachable.
