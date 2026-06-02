# Getting help

OpenChainBench is community-run. Before opening an issue, pick the right channel. it gets you faster answers and keeps the issue tracker focused on actionable work.

## I want to…

| Goal | Where to go |
| --- | --- |
| Propose a new benchmark formally | [New issue → 📊 Propose a benchmark](https://github.com/ChainBench/OpenChainBench/issues/new?template=new-benchmark.yml) |
| Float an idea before writing it up | [Discussions → Ideas](https://github.com/ChainBench/OpenChainBench/discussions/categories/ideas) |
| Ask a question about a spec, harness, methodology, or the site | [Discussions → Q&A](https://github.com/ChainBench/OpenChainBench/discussions/categories/q-a) |
| Show a fork or a dashboard you built | [Discussions → Show & tell](https://github.com/ChainBench/OpenChainBench/discussions/categories/show-and-tell) |
| Report a number that looks wrong on the site | [New issue → 🐞 Data quality](https://github.com/ChainBench/OpenChainBench/issues/new?template=data-quality.yml) |
| Submit a provider correction (you measured a different number) | [New issue → ✏️ Provider correction](https://github.com/ChainBench/OpenChainBench/issues/new?template=provider-correction.yml) |
| Privately report a security vulnerability | [Security advisories](https://github.com/ChainBench/OpenChainBench/security/advisories/new) |
| See what's planned and where to contribute code | [Roadmap project board](https://github.com/orgs/OpenChainBench/projects) |
| Read about how the data is produced | [`benchmarks/README.md`](../benchmarks/README.md) and [`harnesses/README.md`](../harnesses/README.md) |

## Response time

- **Discussions**: best-effort, usually within a few days.
- **Issues**: triaged once a week. Critical (data clearly wrong / site down) is faster.
- **Pull requests**: reviewed within ~5 days for new benchmarks, ~2 days for fixes.
- **Security advisories**: acknowledged within 72 hours.

## What we won't help with

- Provider-specific support (e.g. "my Alchemy quota is exhausted"). Contact the provider.
- Generic Prometheus / Grafana questions unrelated to OpenChainBench.
- Asking us to add your private node as a benchmarked provider. We benchmark public, generally-available infrastructure.

## Commercial support

There is no commercial support offering. The maintainers contribute on a best-effort basis. If your team depends on continuous, SLA-backed visibility into a particular metric, run your own harness. the contract documented in [`harnesses/README.md`](../harnesses/README.md) is small and the existing harnesses are MIT-licensed reference implementations.
