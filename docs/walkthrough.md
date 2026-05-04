# Walkthrough — what happens when you contribute a benchmark

A concrete, end-to-end example of how a new benchmark gets onto the site. Written from the contributor's perspective, with the maintainer + automation actions called out so you can see what is yours to do and what happens around you.

For the formal step-by-step reference, see [`/CONTRIBUTING.md`](../CONTRIBUTING.md) and the [`/contribute`](https://openchainbench.com/contribute) page. This document is the "what does a real contribution look like in practice" version.

## The scenario

Imagine a contributor — let's call them **Alex** — who works on a wallet that surfaces token portfolios across many chains. Their UX team wants to choose between four wallet-portfolio APIs (Mobula, Zerion, DeBank, Quick Intel) on hard data, not vendor decks. Alex decides to build the benchmark in the open, on OpenChainBench.

The whole journey takes them roughly **3-4 hours of focused work**, spread over a few days.

## Phase 1 — Align (Day 0, ~30 min)

Alex opens an issue with the [📊 Propose a benchmark](https://github.com/OpenChainBench/OpenChainBench/issues/new?template=new-benchmark.yml) template. They fill in:

- **What to measure**: time-to-receive-full-portfolio in milliseconds.
- **Providers**: Mobula, Zerion, DeBank, Quick Intel.
- **Methodology**: 200 known busy addresses, one request per address per region every 60 s, 5 s timeout, three regions (us-east-1, eu-west-1, ap-southeast-1).
- **Hosting**: "I'll host the harness on my own Fly.io project."

A maintainer comments:

> "Methodology looks solid. Two notes: (1) please add Helius for Solana addresses since DeBank is EVM-only — otherwise the comparison is uneven on multi-chain wallets. (2) 5 s timeout is fine for the headline; record the unbounded latency too as a separate metric so we can see what providers really do under load."

Alex agrees, edits the issue. The maintainer labels it `bench-request` and moves it to `Approved` on the roadmap.

**No code yet.** This phase exists so methodology disagreements happen on a forum, not on a closed-PR — much faster to resolve.

## Phase 2 — Build (Day 1-2, ~2 hours)

### The spec

Alex creates `benchmarks/wallet-portfolio-latency.yml`:

```yaml
slug: wallet-portfolio-latency
number: "005"
title: Wallet Portfolio API — Read Latency
subtitle: How fast each wallet API returns a complete portfolio for a busy address.
category: Wallets
status: live
metric: Portfolio read
unit: ms

abstract: |
  We benchmark how long the major wallet APIs take to return a full
  portfolio (tokens, balances, USD values, NFTs) for a known busy
  address across 12 chains. The harness issues identical GETs from
  three regions and records p50, p90 and p99 wall-clock latency
  along with success rate.

methodology:
  - "Address set: 200 addresses with 50+ tokens across at least 5 chains."
  - "Cadence: 1 request / address / region every 60 s for 24 hours."
  - "Timeout: 5,000 ms. Failures excluded from latency aggregates."
  - "Regions: us-east-1, eu-west-1, ap-southeast-1."

source: https://github.com/OpenChainBench/OpenChainBench/tree/main/harnesses/wallet-portfolio-latency

prometheus:
  url: https://prom.openchainbench.com
  window: 24h

providers:
  - slug: mobula
    name: Mobula
    queries:
      p50: histogram_quantile(0.5,  sum by (le) (rate(ocb_portfolio_ms_bucket{provider="mobula"}[24h])))
      p90: histogram_quantile(0.9,  sum by (le) (rate(ocb_portfolio_ms_bucket{provider="mobula"}[24h])))
      p99: histogram_quantile(0.99, sum by (le) (rate(ocb_portfolio_ms_bucket{provider="mobula"}[24h])))
      success: sum(rate(ocb_portfolio_total{provider="mobula", success="true"}[24h])) / sum(rate(ocb_portfolio_total{provider="mobula"}[24h]))
      sample_size: sum(increase(ocb_portfolio_total{provider="mobula"}[24h]))
      series: histogram_quantile(0.5, sum by (le) (rate(ocb_portfolio_ms_bucket{provider="mobula"}[1h])))
  # … one block per provider
```

### The harness

Alex picks Go because they're familiar with `prometheus/client_golang`. They create `harnesses/wallet-portfolio-latency/`:

```
harnesses/wallet-portfolio-latency/
├── cmd/portfolio/
│   ├── main.go            // boots metrics server, starts goroutines per provider
│   ├── config.go          // reads MOBULA_API_KEY, ZERION_API_KEY, etc. from env
│   ├── metrics.go         // defines ocb_portfolio_ms_bucket histogram + counters
│   ├── mobula_client.go   // HTTP client per provider, identical interface
│   ├── zerion_client.go
│   ├── debank_client.go
│   └── quickintel_client.go
├── Dockerfile             // multi-stage Go build
├── .env.example           // every env var the runner reads, with placeholders
├── .gitignore             // excludes .env
└── README.md              // how to run locally, how to add a provider
```

The shape of `main.go` is roughly:

```go
func main() {
    cfg := loadEnv()
    for _, provider := range []Provider{newMobula(cfg), newZerion(cfg), ...} {
        go runLoop(provider, cfg)
    }
    log.Fatal(http.ListenAndServe(":9090", promhttp.Handler()))
}

func runLoop(p Provider, cfg *Config) {
    ticker := time.NewTicker(60 * time.Second)
    for ; ; <-ticker.C {
        for _, addr := range cfg.Addresses {
            start := time.Now()
            err := p.FetchPortfolio(addr)
            elapsed := time.Since(start).Milliseconds()
            metrics.PortfolioMs.WithLabelValues(p.Name(), cfg.Region).Observe(float64(elapsed))
            metrics.PortfolioTotal.WithLabelValues(p.Name(), success(err)).Inc()
        }
    }
}
```

The metric names match those referenced in the YAML — that is the contract.

## Phase 3 — Host (Day 2, ~30 min)

Alex's harness needs to expose `/metrics` over HTTPS at a stable URL. They go with Fly.io because they already have an account.

```bash
cd harnesses/wallet-portfolio-latency
fly launch                           # generates fly.toml, picks a region
fly secrets set MOBULA_API_KEY=...   # secrets stay on Fly, never in git
fly secrets set ZERION_API_KEY=...
fly secrets set DEBANK_API_KEY=...
fly secrets set QUICKINTEL_API_KEY=...
fly secrets set REGION=eu-west-1
fly deploy                           # boots the container
```

Fly returns a URL: `https://alex-portfolio-bench.fly.dev`.

Alex tests it:

```bash
curl -s https://alex-portfolio-bench.fly.dev/metrics | head -20
# HELP ocb_portfolio_ms duration of portfolio fetch
# TYPE ocb_portfolio_ms histogram
# ocb_portfolio_ms_bucket{provider="mobula", region="eu-west-1", le="100"} 0
# ocb_portfolio_ms_bucket{provider="mobula", region="eu-west-1", le="200"} 12
# …
```

The harness is alive, producing data, and reachable from the open internet. The OpenChainBench Prometheus does not yet know about it.

**Cost so far**: ~$5/mo on Fly's lowest tier. Alex pays it; OpenChainBench pays nothing.
**Secrets shared with maintainers**: zero.

## Phase 4 — Wire the scrape (Day 2, ~5 min)

Alex appends one block to `infrastructure/prometheus/prometheus.yml`:

```yaml
- job_name: wallet-portfolio-latency
  metrics_path: /metrics
  scheme: https
  static_configs:
    - targets:
        - alex-portfolio-bench.fly.dev
      labels:
        benchmark: wallet-portfolio-latency
        host: alex
```

That is the **only** thing the project needs from Alex's hosting. No credentials, no callbacks, no ingress rules — just a URL.

## Phase 5 — Open the PR (Day 2, ~10 min)

Alex pushes their branch and opens a PR with three changes:

```
benchmarks/wallet-portfolio-latency.yml             [new]
harnesses/wallet-portfolio-latency/…                [new, ~12 files]
infrastructure/prometheus/prometheus.yml            [+1 scrape job]
```

CI runs on the PR (~30 s):

- ✅ `pnpm validate` — schema-lints the YAML.
- ✅ `pnpm typecheck` — type-checks the site.
- ✅ `pnpm build` — verifies the site rebuilds with the new spec.

Alex also runs `pnpm spec:dry-run wallet-portfolio-latency` locally — it queries Prometheus from their laptop and prints the resolved p50/p90/p99 numbers. They share those in the PR description so the maintainer can sanity-check.

## Phase 6 — Review + merge (Day 3, ~20 min)

A maintainer pulls up the PR. They check four things:

1. **Spec hygiene**. Title isn't editorialised ("the fastest"), methodology is concrete, abstract describes inputs.
2. **Harness contract**. The metric names emitted match those queried in the YAML. The `.env.example` is accurate. No secrets in the diff.
3. **Public reachability**. They `curl https://alex-portfolio-bench.fly.dev/metrics` from their machine. Returns 200 with valid Prometheus exposition format.
4. **Methodology vs the issue**. Did Alex address the maintainer's request to add Helius and an unbounded-latency metric? Yes.

The maintainer comments "looks good", merges to `main`. The PR is auto-linked to the original issue, which moves to `In progress` on the roadmap.

**Vercel rebuilds the site automatically.** The benchmark page appears at `https://openchainbench.com/benchmarks/wallet-portfolio-latency` immediately, but it's empty — the central Prometheus has not been told to scrape Alex's URL yet.

## Phase 7 — Apply the scrape (Day 3, ~30 s)

The maintainer triggers a Prometheus reload:

```bash
curl -X POST https://prom.openchainbench.com/-/reload
```

Prometheus reloads its config file (which now has Alex's new scrape job), starts hitting `https://alex-portfolio-bench.fly.dev/metrics` every 15 s, and stores the data with `benchmark: wallet-portfolio-latency, host: alex` labels.

## Phase 8 — Live (Day 3, ≤ 60 s after the reload)

The site's ISR cache for `/benchmarks/wallet-portfolio-latency` expires (default 60 s). The next visitor's request triggers a re-render: the Next.js server queries the central Prometheus, gets fresh data, renders the page with the new numbers.

Alex's benchmark is live. The roadmap card moves to `Live`. The maintainer pings the original issue:

> "Live at https://openchainbench.com/benchmarks/wallet-portfolio-latency. Initial 24-hour run will smooth out — the page may look noisy until then."

## What Alex did vs what Alex didn't have to do

### Did:
- Wrote the spec
- Wrote the harness
- Hosted the harness (Fly.io account, $5/mo)
- Provided their own provider API keys
- Maintained the harness over time (if it crashes, the bench data goes blank — gracefully)

### Didn't have to:
- Share API keys with anyone
- Provision infrastructure for OpenChainBench
- Run their own Prometheus or Grafana
- Coordinate deploy windows with maintainers
- Set up CI

### What the maintainer did:
- Reviewed the issue (5 min)
- Reviewed the PR (15 min)
- Triggered the Prom reload (30 s)

### What the project paid for:
- An additional scrape target on the existing OpenChainBench Prometheus — effectively zero cost.

## Failure modes and how they're handled

| What happens | Effect |
| --- | --- |
| Alex's harness crashes | Prometheus marks the target down; the bench's percentile values turn null on the site. Nothing else affected. |
| Alex moves the harness to a new URL | Alex (or the maintainer, if Alex disappears) opens a 1-line PR updating the scrape config. Prom reloads, scraping resumes. |
| One provider in the bench rate-limits Alex | That provider's success rate drops on the page; latency aggregates exclude failures so the bench stays interpretable. |
| Alex stops paying for the harness | The bench goes dark. After ~30 days of no data, a maintainer can archive the bench (move issue to `Archived`, mark spec `status: draft` in the YAML). The code stays in the repo for anyone to revive. |
| A provider files a [provider correction](https://github.com/OpenChainBench/OpenChainBench/issues/new?template=provider-correction.yml) saying "your number is wrong" | Public discussion in the issue. If they're right and provide a reproducer, the YAML or harness gets a correction with a dated note on the report. |

## What this enables

This is what "open" actually means for a benchmark project:

- **No insiders.** No team has privileged access to publish numbers; everyone goes through PRs.
- **No sponsorship asymmetry.** The provider being benchmarked has the same rights as everyone else: file corrections, propose benchmarks, contribute harness improvements.
- **No infrastructure bottleneck.** New benchmarks don't require new Railway services, new Prometheus instances, or new credentials. They require one PR.
- **No data lock-in.** The whole pipeline from spec → harness → metrics → site is checked into git. Anyone can clone, fork, and run their own copy of OpenChainBench against their own harnesses tomorrow.

## Frequently asked questions

**"What if my harness needs a paid API key I don't want to expose to the world?"**
You don't. The API key lives in your hosting platform's secrets store (Fly secrets, Railway env vars, AWS Secrets Manager, whatever). The harness reads it from `os.Getenv("…")` at startup. Nothing about the running harness reveals the key — only the metric values it produces are public.

**"What if I want to be benchmarked on my own service?"**
Same flow. You write the harness, host it on your infra, expose `/metrics`, PR the scrape config. Maintainers will look extra carefully at the methodology to make sure you're not benchmarking yourself in a way that flatters you, but the door is open.

**"What if I don't have any infra at all?"**
Two options. (1) Use a free tier — Fly.io and Cloud Run both have generous free tiers that cover light harnesses indefinitely. (2) Ask in the PR for OpenChainBench-hosted onboarding — a maintainer will help you deploy onto the project's Railway and you'll transfer secrets via [1Password Send](https://1password.com/send) or a similar one-shot share.

**"What if my harness is heavy and signs transactions?"**
Same flow. You absolutely should host it yourself in that case — the project never wants custody of wallet keys. The data path is identical: the harness exposes Prometheus metrics on a URL, the central Prom scrapes.

**"Can I update my harness later?"**
Yes. As long as the metric names + labels stay stable, you can deploy whatever changes you want. If you change a metric name you'll need to update the YAML query at the same time and open a PR. If you break backward-compatibility of an established benchmark, write a methodology note in the spec's `findings:` section so the change is dated.

**"How is this different from each provider running their own Grafana?"**
Same definition, same harness. Numbers are comparable across providers because the harness is the same code calling each provider with the same inputs. A provider's own dashboard tells you about that provider; OpenChainBench tells you about the field.
