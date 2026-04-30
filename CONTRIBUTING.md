# Contributing

OpenChainBench is community-run. Anyone can submit a benchmark, fix a number, propose a methodology change. The web tutorial at [`/contribute`](https://openchainbench.xyz/contribute) walks through the four steps; this file is the long-form reference.

## What lives where

```
benchmarks/        Self-contained YAML spec per benchmark
harnesses/         The script that emits Prometheus metrics
src/               The Next.js site that renders specs
scripts/           Validate + dry-run tooling
docs/              Methodology, ADRs, style guide
.github/           CI, issue templates, PR template
```

## Where to start

| Goal | Right channel |
| --- | --- |
| Float a rough idea | [Discussions → Ideas](https://github.com/OpenChainBench/OpenChainBench/discussions/categories/ideas) |
| Ask a methodology / harness question | [Discussions → Q&A](https://github.com/OpenChainBench/OpenChainBench/discussions/categories/q-a) |
| Propose a benchmark formally | [Issue → 📊 Propose a benchmark](https://github.com/OpenChainBench/OpenChainBench/issues/new?template=new-benchmark.yml) |
| Report a number that looks wrong | [Issue → 🐞 Data quality](https://github.com/OpenChainBench/OpenChainBench/issues/new?template=data-quality.yml) |
| Submit a provider correction | [Issue → ✏️ Provider correction](https://github.com/OpenChainBench/OpenChainBench/issues/new?template=provider-correction.yml) |
| See what's planned | [Roadmap project board](https://github.com/orgs/OpenChainBench/projects) |

## Submitting a benchmark

1. **Open an issue** with the [📊 Propose a benchmark template](https://github.com/OpenChainBench/OpenChainBench/issues/new?template=new-benchmark.yml). Sketch the metric, providers, methodology, hosting plan — get feedback before you write code. The issue lands in the `Requested` column of the roadmap.
2. **Write the spec.** Drop a YAML at `benchmarks/<slug>.yml`. The format is described in [`benchmarks/README.md`](./benchmarks/README.md) and validated by `src/lib/spec-schema.ts`.
3. **Build the harness** at `harnesses/<slug>/`. A harness is a data producer only — it exposes `/metrics` over HTTP with the metric names and labels your spec references. See [`harnesses/README.md`](./harnesses/README.md) for the full contract and the existing Go harnesses as reference implementations.
4. **Append a scrape job** to [`infrastructure/prometheus/prometheus.yml`](./infrastructure/prometheus/prometheus.yml) so the shared Prometheus picks up your harness. Format documented in [`infrastructure/README.md`](./infrastructure/README.md).
5. **Open a PR** referencing the issue (`Closes #N`). CI runs `pnpm validate` (schema lint), `pnpm typecheck`, `pnpm lint`, and `pnpm build`. Once green and reviewed, merge → site picks up the spec on next ISR cycle (≤60 s).
6. **Wire the harness on Railway** (maintainer task). Light harnesses run on the project's shared Railway. Heavier harnesses (wallets, signing) are hosted by the contributor and expose `/metrics` on a publicly-reachable URL — the central Prometheus scrapes it identically.

## Local development

```bash
pnpm install
pnpm validate            # schema-lint every spec in benchmarks/
pnpm spec:dry-run <slug> # query Prometheus and print numbers without rendering
pnpm dev                 # http://localhost:3000
pnpm build               # production build
```

## Editorial conventions

- **No pre-determined winners.** Specs do not mark a "winner". The leader on every page is computed at render time from the lowest p50.
- **Keep titles factual.** `Bridge — End-to-End Latency` not `The Fastest Bridge of 2026`.
- **Tail before mean.** Headlines use p50 and p99. The arithmetic mean is reported in the table but never used as a takeaway.
- **State the timeout.** Failures are excluded from latency aggregates and counted toward success rate. Both numbers are reported.
- **Write methodology before findings.** A spec without methodology is rejected.

## Corrections

If you can't reproduce a number, file a [provider correction](https://github.com/OpenChainBench/OpenChainBench/issues/new?template=provider-correction.yml) (you measured a different value for your service) or a [data quality issue](https://github.com/OpenChainBench/OpenChainBench/issues/new?template=data-quality.yml) (the site is showing something obviously wrong or stale). Material errors are corrected in place with a dated note on the report.

## Code of conduct & security

- [Code of conduct](./.github/CODE_OF_CONDUCT.md) — short, applies to all project spaces (issues, PRs, discussions).
- [Security policy](./.github/SECURITY.md) — private vulnerability reporting via GitHub advisories.

## License

Code: [MIT](./LICENSE).
Reports & figures: CC-BY-4.0.
