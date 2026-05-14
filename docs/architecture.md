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

**Mocks are out.** Earlier iterations had mock data the site fell back to when Prometheus was empty. That blurred "real" and "fake". a reader couldn't tell what was measured. Now: if Prometheus has nothing, the page renders in `draft` state with a "Awaiting first run" notice.

**Live leader.** No spec marks a winner. The leader on every page is recomputed at render time from the lowest p50.

**Schema as contract.** `src/lib/spec-schema.ts` is the single source of truth. derived TS types power the app, runtime parsing rejects bad submissions, and `pnpm validate` lints every PR in CI.

**ISR over SSR.** Pages prerender at build, then revalidate every 60 seconds. Readers get static-fast loads; data stays within a minute of fresh.

## Module boundaries

| Module                       | Responsibility                                           |
| ---------------------------- | -------------------------------------------------------- |
| `src/types/benchmark.ts`     | Wire shape consumed by every renderer                    |
| `src/lib/spec-schema.ts`     | Zod schema + derived TS types                            |
| `src/lib/prometheus.ts`      | Minimal HTTP client (instant + range queries)            |
| `src/lib/spec.ts`            | YAML loader, Prometheus overlay, draft fallback          |
| `src/data/benchmarks.ts`     | Async getters (used by every page)                       |
| `src/components/`            | Pure render. receives `Benchmark`, no fetching          |
| `scripts/validate-specs.ts`  | CI-callable lint                                         |
| `scripts/dry-run-spec.ts`    | Local debug. query Prometheus and print resolved values |

## Known constraints

- Prometheus must be reachable over HTTPS from the build runner and the ISR worker.
- Build time grows linearly with the number of providers (one Prometheus call per provider per benchmark). At ~6 providers × 5 benchmarks × 24 ticks for series, expect ~150 round-trips per build. The HTTP client times out at 4s; total build should stay under 10s.
- `generateStaticParams` reads the YAML filenames directly so the route table is stable even when Prometheus is offline.

## The live dashboard on /

The live dashboard at [openchainbench.com](https://openchainbench.com) has its **own data path** that does not touch Prometheus or the spec/YAML pipeline. It exists in addition to (not instead of) the benchmark pages.

### Data flow

```
[Mobula fast-trade WS]              [Mobula REST /lighthouse, /api/1/all]
   per-pool swap events                global vol/txs/fees, total mcap
        │                                       │
        └─────────────────┐         ┌───────────┘
                          ▼         ▼
              ┌───────────────────────────────┐
              │  ocb-stream-relay (Railway)   │   one Go binary, ~250 LOC
              │                               │
              │   chains.go     ── chain map  │
              │   chart_store   ── 10min ring │
              │   counters      ── 24h vol    │
              │   lighthouse    ── REST poll  │
              │   hub           ── fan-out    │
              │   server        ── /ws /stats │
              └────────────────┬──────────────┘
                               │  wss://…railway.app/ws
                               ▼
                       browser (Client Component)
                       Next.js /live page on Vercel
                       opens its own WebSocket.
                       Vercel serves only the HTML shell.
```

The browser opens a WebSocket **directly to the Railway relay**. Vercel
Functions are never invoked for live data — keeps cost flat at ~$5/mo
regardless of viewer count.

### Why a separate relay (not Vercel SSE)

A first design held an SSE handler in a Vercel Route Handler, but:
- One open SSE connection per viewer × Active CPU billing on Fluid Compute = bill scales linearly with traffic.
- Vercel functions are request-scoped; we'd open a new upstream Mobula WS per cold instance.

The current architecture inverts both: **one** upstream WS held by the Railway box, an in-process hub fans out to N browser WebSockets. Adding a viewer is a few KB of RAM, not a function instance.

### Wire messages

Three message types arrive on `/ws`, all JSON:

| `type` | When | Payload |
|---|---|---|
| `snapshot` | First message on every connect | `{ buckets: [{ ts, perChain }], nowMs }` — the last 10 min of incremental per-chain volume, padded with empty buckets on the left so the chart is full from t=0. |
| `swap` | Per real trade (filtered: `buy`/`sell`, `operation=regular\|arbitrage`) | `{ chain, pool, pair, exchange, side, usd, hash, onChainMs, mobulaMs, receivedMs }` — enriched with pair name + DEX from a top-N catalog fetched at boot. |
| `stats` | Every 1 s | `{ global: {vol24h, trades24h, …, mcap, byChain[]}, live: {swaps, vol, chains}, nowMs }` — ground-truth global stats from REST + per-session live counters. |

The browser snapshots the first message, then accumulates `swap` events into incremental buckets matching the relay's bucket boundaries (using the snapshot's `nowMs` to learn the relay/browser clock offset).

### Live page module layout

```
src/app/live/page.tsx               ← Server Component, sets up the layout
src/components/live/
├── dashboard.tsx                   ← orchestrator: WS connection, state, hydration
├── status-bar.tsx                  ← "Streaming · Mobula fast-trade · refreshed Xs ago"
├── stats-band.tsx                  ← 4 hero tiles (Vol/Txs/Mcap/Streamed live)
├── chart.tsx                       ← SVG time-series + pops + legend
└── compact-feed.tsx                ← scrolling table to the right of the chart

src/lib/live/
├── types.ts                        ← wire types (mirror the relay's Go structs)
├── config.ts                       ← tunables (WINDOW_MS, BUCKET_MS, thresholds…)
├── chains.ts                       ← chain meta (key, slug, display, color, aliases)
├── format.ts                       ← fmtMoney / fmtCount / fmtLag / fmtAge
└── buckets.ts                      ← appendSwapToBuckets, cumulativePerChain, niceCeil
```

The relay's own README (`miniapps/ocb-stream-relay/README.md` in the
`mobula-monorepo`) covers the backend.
