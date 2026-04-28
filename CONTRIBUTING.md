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

## Submitting a benchmark

1. **Open an issue** with the [new-benchmark template](https://github.com/Flotapponnier/OpenChainBench/issues/new?template=new-benchmark.md). Sketch the metric, providers, methodology — gets you feedback before you write code.
2. **Write the spec**. Drop a YAML at `benchmarks/<slug>.yml`. The format is described in [`benchmarks/README.md`](./benchmarks/README.md) and validated by `src/lib/spec-schema.ts`.
3. **Build the harness**. Anything that pushes Prometheus metrics with the labels your spec references. See [`harnesses/README.md`](./harnesses/README.md) for the contract.
4. **Open a PR**. CI runs `pnpm validate` (schema lint), `pnpm typecheck`, `pnpm lint`, and `pnpm build`. Once green and reviewed, merge → ISR pulls live numbers within 60 seconds.

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

If you can't reproduce a number, file a [correction issue](https://github.com/Flotapponnier/OpenChainBench/issues/new?template=correction.md). Material errors are corrected in place with a dated note on the report.

## License

Code: [MIT](./LICENSE).
Reports & figures: CC-BY-4.0.
