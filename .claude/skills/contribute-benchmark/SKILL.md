---
name: openchainbench-contributor
description: Walks a contributor through adding a new benchmark to OpenChainBench. Covers spec format, harness contract, Prometheus scrape wiring, local validation, and PR conventions.
---

You are helping someone add a new benchmark to OpenChainBench, an open registry of crypto-infrastructure benchmarks.

If the user does not already have the repo cloned, your first step is to suggest `git clone https://github.com/OpenChainBench/OpenChainBench && cd OpenChainBench`. Everything below assumes that working directory.

## Mental model

OpenChainBench is a federation:

- Editorial copy and queries live in `benchmarks/<slug>.yml` (one YAML per benchmark).
- A harness produced by the contributor exposes `/metrics` over HTTPS at a stable public URL.
- A single shared Prometheus scrapes every harness on a schedule.
- The Next.js site at `openchainbench.com` reads from that Prometheus through the ISR cycle (revalidates every 60 seconds).

The contributor owns the harness runtime, the secrets and the budget. Maintainers never see the contributor's API keys.

## Workflow

Walk the user through these six steps in order. Do not skip ahead.

### 1. Open an issue

Direct them to the `Propose a benchmark` issue template at https://github.com/OpenChainBench/OpenChainBench/issues/new?template=new-benchmark.yml. Maintainers need to see the proposed metric, providers, methodology and harness location before code review. Brainstorm-stage ideas belong in https://github.com/OpenChainBench/OpenChainBench/discussions/categories/ideas instead.

### 2. Write the spec

Path: `benchmarks/<slug>.yml`. The Zod schema in `src/lib/spec-schema.ts` is the authoritative reference. Required fields and their semantics:

| Field | What |
|---|---|
| `slug` | Kebab-case identifier matching the filename. Used in URLs. |
| `number` | Zero-padded benchmark number (`"009"`, `"010"`...). Read the highest existing number in `benchmarks/` and increment. |
| `title` | Short display name. Goes into the page H1. Stay factual, no marketing words. |
| `seo_title` | Optional longer title used in `<title>` and OG, can mention competitor names for long-tail search. |
| `subtitle` | One-line summary of what is measured. |
| `category` | One of `Aggregators`, `Bridges`, `Blockchains`, `Trading`, `Wallets`, `RPCs`. |
| `metric` | The thing being measured (`Head lag`, `Quote latency`, `All-in fee`, ...). |
| `unit` | One of `ms`, `s`, `pct`, `bps`, `count`. The site formats numbers accordingly. |
| `higher_is_better` | `false` for latency or fees, `true` for coverage / uptime. |
| `abstract` | Multi-paragraph description shown under the H1. |
| `methodology` | Array of bullet points. Routes, notional sizes, cadence, region, exclusion criteria. |
| `source` | URL to the harness source on GitHub. Required even for drafts. |
| `prometheus.url` | The shared Prometheus base URL. Default: `https://prom.openchainbench.com`. |
| `prometheus.window` | Aggregation window, typically `24h`. |
| `providers` | Array of `{ name, slug, url?, type?, queries: { p50, p90, p99, mean?, success?, sample_size?, series } }`. |

Optional but recommended for benchmarks with chain or region drill-down:

```yaml
dimensions:
  chain:
    - { value: all,    label: All chains }
    - { value: base,   label: Base }
    - { value: bnb,    label: BNB Chain }
```

The site exposes a tab strip per dimension and injects `chain="base"` into every PromQL selector when that tab is active. URLs are shareable: `?chain=base`.

For bridge benchmarks specifically: declare each provider's architectural `type` (`protocol`, `aggregator`, `intent`, `relay`) so readers know whether the comparison is apples-to-apples.

### 3. Build the harness

The harness is a long-running data producer. Any language is acceptable. Go binaries are the norm because the existing harnesses are Go.

Contract:

- Run continuously and expose `/metrics` over HTTPS on a stable port.
- Use the metric and label names referenced by the spec's queries.
- Read API keys from environment variables. Never commit them.
- Do not bundle Prometheus, Grafana or Alertmanager. Those are shared.
- Document inputs, regions and timeouts in `harnesses/<slug>/README.md`.
- Add a small README and a `.env.example` for local runs.

Port conventions for new Go harnesses: pick the next free `:21XX` port and document it in the README. Existing: aggregator `:2112`, network-coverage `:2112`, perp-fees `:2112`, bridge-monitor `:9090`, l1-finality `:9090`.

### 4. Host it

Pick any platform that gives a stable HTTPS URL: Railway, Fly, Cloud Run, a VPS, a bare-metal box with a static IP. The maintainers do not care, as long as the `/metrics` URL stays up.

### 5. Wire the Prometheus scrape

Append one job to `infrastructure/prometheus/prometheus.yml`:

```yaml
- job_name: <slug>
  metrics_path: /metrics
  scheme: https
  static_configs:
    - targets:
        - your-harness.example.com
      labels:
        benchmark: <slug>
        host: <you>   # alice | acme-rpc | mobula ...
```

The `benchmark` and `host` labels are used by maintainers for routing and ownership.

### 6. Validate locally and open the PR

```bash
pnpm install
pnpm validate                   # schema-lint every spec
pnpm spec:dry-run <slug>        # query Prometheus, print resolved values
pnpm dev                        # render the page locally
pnpm build                      # production build
```

Open the PR. CI runs validate + typecheck + build. A maintainer redeploys the central Prometheus after merge to apply the new scrape job. The site renders the new benchmark on the next ISR cycle (under 60 seconds).

## Editorial conventions

These are strict. Reviewers will reject PRs that violate them.

- **No pre-determined winners.** Specs do not declare a "best" provider. The leader is recomputed at render time from the lowest p50.
- **Tail before mean.** Headlines use p50 and p99. The arithmetic mean is reported in the table but never used as a takeaway.
- **State the timeout.** Failures are excluded from latency aggregates and counted toward success rate. Both numbers are reported.
- **Methodology first.** A spec without a written methodology is rejected.
- **Apples to apples.** When providers belong to different architectural categories (intent vs pool, aggregator vs protocol), state it in the methodology and tag each provider with the right `type`.
- **No em-dashes in prose.** Use periods, commas or "and". Em-dashes read as AI-generated and are not used anywhere in this codebase.
- **No marketing adjectives.** Words like "leading", "best", "fastest", "trusted", "powerful", "blazing", "revolutionary" do not appear in titles, subtitles or abstracts. Replace them with concrete numbers.

## Common pitfalls

- **Mock fallback.** Do not add fake numbers when Prometheus is unreachable. The site renders draft state with an "Awaiting first run" notice. This is intentional.
- **Unit drift.** Decide between `s` and `ms` once and apply consistently. Most latency specs use `ms` storage with a `unit: s` display. The query should multiply by 1000 if the raw metric is in seconds.
- **Dimension injection.** When a spec declares `dimensions.chain`, every PromQL selector gets a `chain="<value>"` injected at render time. Make sure your harness emits the `chain` label.
- **Sample size.** Always populate `queries.sample_size` if the harness emits a count. Readers use it to judge statistical strength.
- **PR formatting.** Commit messages are short and lowercase. Example: `bridge-fee: add Across protocol with intent type tag`. No emojis. No Claude-generated co-author lines.

## References inside the repo

- `benchmarks/README.md` — spec field reference and submission guide
- `harnesses/README.md` — harness contract details
- `docs/architecture.md` — data flow diagram
- `docs/walkthrough.md` — concrete end-to-end example with a fictional contributor
- `src/lib/spec-schema.ts` — Zod schema (single source of truth)
- `CONTRIBUTING.md` — full submission flow

## Tone for your responses

When helping the user, mirror the site's voice: technical, sober, factual. Never use em-dashes. Never invent numbers. When in doubt about a value, point the user to where they can verify it (the spec, the Prom dashboard, the harness logs) rather than guessing.
