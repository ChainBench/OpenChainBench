import type { Metadata } from "next";
import Link from "next/link";
import { SectionRule } from "@/components/section-rule";

export const metadata: Metadata = {
  title: "Contribute — Submit a benchmark",
  description:
    "How to publish your own benchmark on OpenChainBench in five steps.",
};

export default function ContributePage() {
  return (
    <article className="mx-auto max-w-3xl px-6 py-12">
      <p className="eyebrow">
        Tutorial
      </p>
      <h1 className="mt-3 display text-4xl sm:text-5xl">
        Submit a benchmark.
      </h1>
      <p className="mt-3 text-xl sm:text-2xl text-ink-muted leading-snug">
        Anyone can publish on OpenChainBench. The format is fixed, the methodology is yours, the harness is yours, the merge is open. Five steps.
      </p>

      <div className="mt-8 border-y border-rule py-5 grid gap-4 sm:grid-cols-5">
        <Tldr n="01" title="Open an issue" body="Align on the metric." />
        <Tldr n="02" title="Write the spec" body="One YAML file." />
        <Tldr n="03" title="Build the harness" body="Expose /metrics." />
        <Tldr n="04" title="Wire the scrape" body="One block in prometheus.yml." />
        <Tldr n="05" title="Open a PR" body="The page renders itself." />
      </div>

      <SectionRule label="Step 1 — Open an issue" number="i" />
      <p className="text-base leading-relaxed text-ink-soft">
        Use the{" "}
        <a className="lnk" href="https://github.com/OpenChainBench/OpenChainBench/issues/new?template=new-benchmark.yml">
          📊 Propose a benchmark
        </a>
        {" "}template to describe what you want to measure, which providers, and where the harness will run. Maintainers respond with feedback before any code is written. Want to brainstorm first? Use{" "}
        <a className="lnk" href="https://github.com/OpenChainBench/OpenChainBench/discussions/categories/ideas">
          Discussions → Ideas
        </a>
        .
      </p>

      <SectionRule label="Step 2 — Write the spec" number="ii" />
      <p className="text-base leading-relaxed text-ink-soft">
        Drop a file at <Code>benchmarks/&lt;your-slug&gt;.yml</Code>. It is the source of truth for the report — title, abstract, methodology, providers and the PromQL that fills in the numbers.
      </p>

      <pre className="mt-6 font-mono text-[12px] leading-snug bg-paper-soft border border-rule p-5 overflow-x-auto whitespace-pre">
{`# benchmarks/wallet-portfolio-latency.yml

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
  portfolio (tokens, balances, USD values, NFTs) for a known busy address
  across 12 chains. The harness issues identical GETs from three regions
  and records p50, p90 and p99 wall-clock latency along with success rate.

methodology:
  - "Address set: 200 addresses with 50+ tokens across at least 5 chains."
  - "Cadence: 1 request / address / region every 60 s for 24 hours."
  - "Timeout: 5,000 ms. Failures excluded from latency aggregates."
  - "Regions: us-east-1, eu-west-1, ap-southeast-1."

findings: []

source: https://github.com/OpenChainBench/OpenChainBench/tree/main/harnesses/wallet-portfolio

prometheus:
  url: https://prom.openchainbench.xyz   # shared OpenChainBench Prometheus
  window: 24h

providers:
  - slug: provider-a
    name: Provider A
    tag: v3 endpoints
    secondary: { label: "Chains", value: "44" }
    queries:
      p50: histogram_quantile(0.5,  sum by (le) (rate(ocb_portfolio_ms_bucket{provider="provider-a"}[24h])))
      p90: histogram_quantile(0.9,  sum by (le) (rate(ocb_portfolio_ms_bucket{provider="provider-a"}[24h])))
      p99: histogram_quantile(0.99, sum by (le) (rate(ocb_portfolio_ms_bucket{provider="provider-a"}[24h])))
      success: sum(rate(ocb_portfolio_total{provider="provider-a", success="true"}[24h])) / sum(rate(ocb_portfolio_total{provider="provider-a"}[24h]))
      sample_size: sum(increase(ocb_portfolio_total{provider="provider-a"}[24h]))
      series: histogram_quantile(0.5, sum by (le) (rate(ocb_portfolio_ms_bucket{provider="provider-a"}[1h])))`}
      </pre>

      <p className="mt-5 text-[1rem] leading-relaxed text-ink-soft">
        That is the entire wire format. The Zod schema in <Code>src/lib/spec-schema.ts</Code> is the single source of truth; <Code>pnpm validate</Code> lints every spec in CI.
      </p>

      <SectionRule label="Step 3 — Build the harness" number="iii" />
      <p className="text-base leading-relaxed text-ink-soft">
        The harness is a long-running data producer. Whatever fits the providers — Bun, Node, Python, Go, Rust. The contract is small:
      </p>
      <ul className="mt-4 space-y-2 text-[1rem] leading-relaxed text-ink-soft">
        <li className="flex gap-3"><span className="text-ink-muted">—</span><span>Run continuously, expose <Code>/metrics</Code> over HTTP on a documented port (e.g. <Code>:2112</Code> or <Code>:9090</Code>).</span></li>
        <li className="flex gap-3"><span className="text-ink-muted">—</span><span>Use the metric and label names referenced by your YAML — that is how the site retrieves your numbers.</span></li>
        <li className="flex gap-3"><span className="text-ink-muted">—</span><span>Document inputs, regions, timeouts and the metrics port in <Code>harnesses/&lt;slug&gt;/README.md</Code>.</span></li>
        <li className="flex gap-3"><span className="text-ink-muted">—</span><span>Don&apos;t commit API keys. Read them from environment variables and document them in a <Code>.env.example</Code>.</span></li>
        <li className="flex gap-3"><span className="text-ink-muted">—</span><span>Don&apos;t bundle Prometheus, Grafana or Alertmanager — they live in <Code>infrastructure/</Code> and are shared across every harness.</span></li>
      </ul>

      <SectionRule label="Step 4 — Wire the scrape" number="iv" />
      <p className="text-base leading-relaxed text-ink-soft">
        Append a job to <Code>infrastructure/prometheus/prometheus.yml</Code> so the shared Prometheus picks up your harness:
      </p>
      <pre className="mt-3 font-mono text-[12px] leading-snug bg-paper-soft border border-rule p-5 overflow-x-auto whitespace-pre">
{`- job_name: <your-slug>
  metrics_path: /metrics
  scheme: http
  static_configs:
    - targets:
        - <your-slug>.railway.internal:<port>
      labels:
        benchmark: <your-slug>`}
      </pre>
      <p className="mt-3 text-[1rem] leading-relaxed text-ink-soft">
        The target is the Railway internal DNS name of the service that will run your harness. If you intend to host the harness yourself (heavy harnesses with wallets or signing) replace the target with the public URL of your service.
      </p>

      <SectionRule label="Step 5 — Dry-run + open the PR" number="v" />
      <p className="text-base leading-relaxed text-ink-soft">Test the queries locally before opening the PR:</p>
      <pre className="mt-3 font-mono text-[12px] leading-snug bg-paper-soft border border-rule p-5 overflow-x-auto whitespace-pre">
{`pnpm validate                                # schema lint
pnpm spec:dry-run wallet-portfolio-latency   # hit Prometheus, print resolved numbers
pnpm dev                                     # render the page locally`}
      </pre>
      <p className="mt-5 text-base leading-relaxed text-ink-soft">
        Open the PR. CI runs <Code>pnpm validate</Code>, <Code>pnpm typecheck</Code> and the build. Once merged, a maintainer creates the Railway service for your harness, redeploys the shared Prometheus to pick up the new scrape job, and the site renders your benchmark on the next ISR cycle (within 60 seconds).
      </p>

      <SectionRule label="Reference" number="vi" />
      <ul className="space-y-3 text-[1rem] leading-relaxed">
        <li><Link className="lnk" href="/methodology">Methodology &rarr; design principles, statistical conventions</Link></li>
        <li><a className="lnk" href="https://github.com/OpenChainBench/OpenChainBench/blob/main/benchmarks/README.md">benchmarks/README.md &rarr; spec field reference</a></li>
        <li><a className="lnk" href="https://github.com/OpenChainBench/OpenChainBench/blob/main/harnesses/README.md">harnesses/README.md &rarr; harness contract</a></li>
        <li><a className="lnk" href="https://github.com/OpenChainBench/OpenChainBench/blob/main/infrastructure/README.md">infrastructure/README.md &rarr; the shared Prometheus, scrape config format</a></li>
        <li><a className="lnk" href="https://github.com/OpenChainBench/OpenChainBench/blob/main/CONTRIBUTING.md">CONTRIBUTING.md &rarr; full submission flow</a></li>
      </ul>

      <div className="mt-12 border-y border-rule py-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-base font-medium">Ready?</p>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 font-sans text-sm">
          <a
            className="inline-flex items-center gap-2 border-b-2 border-ink pb-0.5 hover:text-accent"
            href="https://github.com/OpenChainBench/OpenChainBench/issues/new?template=new-benchmark.yml"
          >
            Open a benchmark issue &rarr;
          </a>
          <a className="lnk text-ink-soft" href="https://github.com/OpenChainBench/OpenChainBench/discussions/categories/ideas">
            Brainstorm in Discussions ↗
          </a>
          <a className="lnk text-ink-soft" href="https://github.com/OpenChainBench/OpenChainBench">
            GitHub repository ↗
          </a>
        </div>
      </div>
    </article>
  );
}

function Tldr({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div>
      <p className="font-mono text-[10px] tabular text-ink-muted">{n}</p>
      <p className="mt-1 text-base font-semibold">{title}</p>
      <p className="mt-1 text-sm text-ink-soft">{body}</p>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="font-mono text-[0.92em] bg-paper-soft border border-rule px-1.5 py-0.5">
      {children}
    </code>
  );
}
