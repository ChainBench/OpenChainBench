# Architecture

## Data flow

```
benchmarks/<slug>.yml          ← editorial + queries (one source of truth)
        │
        ▼
src/lib/spec-schema.ts         ← Zod contract
        │
        ▼
src/lib/spec.ts                ← reads YAML, hits Prometheus, returns Benchmark
        │                            ↑
        │                  src/lib/prometheus.ts (HTTP client)
        ▼
src/data/benchmarks.ts         ← async getters used by pages
        │
        ▼
Next.js App Router pages       ← ISR, revalidate every 60s
        │
        ▼
Paper-styled report at /benchmarks/<slug>
```

## Why this shape

**One YAML per benchmark.** Editorial copy and queries live next to each other in a single file. Submitters edit one place; reviewers diff one place.

**Mocks are out.** Earlier iterations had mock data the site fell back to when Prometheus was empty. That blurred "real" and "fake" — a reader couldn't tell what was measured. Now: if Prometheus has nothing, the page renders in `draft` state with a "Awaiting first run" notice.

**Live leader.** No spec marks a winner. The leader on every page is recomputed at render time from the lowest p50.

**Schema as contract.** `src/lib/spec-schema.ts` is the single source of truth — derived TS types power the app, runtime parsing rejects bad submissions, and `pnpm validate` lints every PR in CI.

**ISR over SSR.** Pages prerender at build, then revalidate every 60 seconds. Readers get static-fast loads; data stays within a minute of fresh.

## Module boundaries

| Module                       | Responsibility                                           |
| ---------------------------- | -------------------------------------------------------- |
| `src/types/benchmark.ts`     | Wire shape consumed by every renderer                    |
| `src/lib/spec-schema.ts`     | Zod schema + derived TS types                            |
| `src/lib/prometheus.ts`      | Minimal HTTP client (instant + range queries)            |
| `src/lib/spec.ts`            | YAML loader, Prometheus overlay, draft fallback          |
| `src/data/benchmarks.ts`     | Async getters (used by every page)                       |
| `src/components/`            | Pure render — receives `Benchmark`, no fetching          |
| `scripts/validate-specs.ts`  | CI-callable lint                                         |
| `scripts/dry-run-spec.ts`    | Local debug — query Prometheus and print resolved values |

## Known constraints

- Prometheus must be reachable over HTTPS from the build runner and the ISR worker.
- Build time grows linearly with the number of providers (one Prometheus call per provider per benchmark). At ~6 providers × 5 benchmarks × 24 ticks for series, expect ~150 round-trips per build. The HTTP client times out at 4s; total build should stay under 10s.
- `generateStaticParams` reads the YAML filenames directly so the route table is stable even when Prometheus is offline.
