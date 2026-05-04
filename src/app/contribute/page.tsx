import type { Metadata } from "next";
import Link from "next/link";
import { SectionRule } from "@/components/section-rule";

export const metadata: Metadata = {
  title: "Contribute. Submit a benchmark",
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
        Anyone can publish on OpenChainBench. You write the harness, you host it, you keep your secrets. The project shares one Prometheus that scrapes your public <span className="font-mono text-[0.85em]">/metrics</span> endpoint. that is the only piece of common infrastructure.
      </p>

      <div className="mt-8 border-y border-rule py-5 grid gap-4 sm:grid-cols-3 md:grid-cols-6">
        <Tldr n="01" title="Open an issue" body="Align on the metric." />
        <Tldr n="02" title="Write the spec" body="One YAML file." />
        <Tldr n="03" title="Build the harness" body="Expose /metrics." />
        <Tldr n="04" title="Host it" body="Anywhere with HTTPS." />
        <Tldr n="05" title="Wire the scrape" body="One block in prometheus.yml." />
        <Tldr n="06" title="Open a PR" body="The page renders itself." />
      </div>

      <div className="mt-12 grid gap-6 md:grid-cols-[1.6fr_1fr] items-start">
        <div className="card-soft p-6">
          <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink-faint">
            How it actually works
          </p>
          <h2 className="mt-2 display text-xl">A federation, not a platform.</h2>
          <p className="mt-3 text-[0.95rem] leading-relaxed text-ink-soft">
            Every benchmark on this site is run by whoever wrote it. You host your harness wherever you like, expose <Code>/metrics</Code> over HTTPS, and the project's shared Prometheus scrapes that URL on a schedule. You keep your API keys, your wallet keys, your budget. Maintainers only see the metric values your harness chooses to publish.
          </p>
          <p className="mt-3 text-[0.95rem] leading-relaxed text-ink-soft">
            The only piece of infrastructure shared by the project is one Prometheus instance. that is the URL every YAML spec points at. Adding a new harness is one extra <Code>scrape_configs</Code> block in <Code>infrastructure/prometheus/prometheus.yml</Code>. No new credentials, no new services, no privileged access to share.
          </p>
          <p className="mt-3 text-[0.95rem] leading-relaxed text-ink-soft">
            For a concrete end-to-end example with a fictional contributor. the spec, the Go harness, deploying to Fly.io, opening the PR. see the{" "}
            <a className="lnk" href="https://github.com/OpenChainBench/OpenChainBench/blob/main/docs/walkthrough.md">walkthrough doc</a>.
          </p>
        </div>
        <div className="card-soft p-6">
          <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink-faint">
            Realistic timeline
          </p>
          <ul className="mt-3 space-y-2 text-[0.92rem] leading-relaxed text-ink-soft">
            <li><strong className="text-ink">Day 0 · ~30 min</strong>. open issue, align on methodology with a maintainer.</li>
            <li><strong className="text-ink">Day 1-2 · ~2 h</strong>. write the spec + harness in your fork.</li>
            <li><strong className="text-ink">Day 2 · ~30 min</strong>. deploy your harness on Fly / Railway / your VPS, verify <Code>/metrics</Code> publicly reachable.</li>
            <li><strong className="text-ink">Day 2 · ~10 min</strong>. open the PR (spec + harness + scrape config).</li>
            <li><strong className="text-ink">Day 3 · ≤ 30 min</strong>. maintainer reviews, merges, reloads Prometheus. Site renders within 60 s.</li>
          </ul>
          <p className="mt-4 text-xs text-ink-faint">
            ~3-4 hours of focused work, spread across a few days.
          </p>
        </div>
      </div>

      <SectionRule label="Step 1. Open an issue" number="i" />
      <p className="text-base leading-relaxed text-ink-soft">
        Use the{" "}
        <a className="lnk" href="https://github.com/OpenChainBench/OpenChainBench/issues/new?template=new-benchmark.yml">
          Propose a benchmark
        </a>
        {" "}template to describe what you want to measure, which providers, and where the harness will run. Maintainers respond with feedback before any code is written. Want to brainstorm first? Use{" "}
        <a className="lnk" href="https://github.com/OpenChainBench/OpenChainBench/discussions/categories/ideas">
          Discussions → Ideas
        </a>
        .
      </p>

      <SectionRule label="Step 2. Write the spec" number="ii" />
      <p className="text-base leading-relaxed text-ink-soft">
        Drop a file at <Code>benchmarks/&lt;your-slug&gt;.yml</Code>. It is the source of truth for the report. title, abstract, methodology, providers and the PromQL that fills in the numbers.
      </p>

      <pre className="mt-6 font-mono text-[12px] leading-snug bg-paper-soft border border-rule p-5 overflow-x-auto whitespace-pre">
{`# benchmarks/wallet-portfolio-latency.yml

slug: wallet-portfolio-latency
number: "005"
title: Wallet Portfolio API. Read Latency
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
  url: https://prom.openchainbench.com   # shared OpenChainBench Prometheus
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

      <SectionRule label="Step 3. Build the harness" number="iii" />
      <p className="text-base leading-relaxed text-ink-soft">
        The harness is a long-running data producer. Whatever fits the providers. Bun, Node, Python, Go, Rust. The contract is small:
      </p>
      <ul className="mt-4 space-y-2 text-[1rem] leading-relaxed text-ink-soft">
        <li className="flex gap-3"><span className="text-ink-faint">·</span><span>Run continuously, expose <Code>/metrics</Code> over HTTP on a documented port (e.g. <Code>:2112</Code> or <Code>:9090</Code>).</span></li>
        <li className="flex gap-3"><span className="text-ink-faint">·</span><span>Use the metric and label names referenced by your YAML. That is how the site retrieves your numbers.</span></li>
        <li className="flex gap-3"><span className="text-ink-faint">·</span><span>Document inputs, regions, timeouts and the metrics port in <Code>harnesses/&lt;slug&gt;/README.md</Code>.</span></li>
        <li className="flex gap-3"><span className="text-ink-faint">·</span><span>Don&apos;t commit API keys. Read them from environment variables and document them in a <Code>.env.example</Code>.</span></li>
        <li className="flex gap-3"><span className="text-ink-faint">·</span><span>Don&apos;t bundle Prometheus, Grafana or Alertmanager. They live in <Code>infrastructure/</Code> and are shared across every harness.</span></li>
      </ul>

      <SectionRule label="Step 4. Host it" number="iv" />
      <p className="text-base leading-relaxed text-ink-soft">
        OpenChainBench is a federation: each harness is hosted by whoever wrote it. Pick whatever fits. Railway, Fly, Cloud Run, a VPS, a home server with a static IP. The only requirement is that <Code>/metrics</Code> is reachable over HTTPS at a stable URL.
      </p>
      <ul className="mt-4 space-y-2 text-[1rem] leading-relaxed text-ink-soft">
        <li className="flex gap-3"><span className="text-ink-faint">·</span><span>You own the runtime, the secrets and the budget. Maintainers never see your API keys or wallet keys.</span></li>
        <li className="flex gap-3"><span className="text-ink-faint">·</span><span>If your harness needs API keys from the providers it benchmarks, you bring them. The data path treats every harness identically. Either Mobula-hosted or contributor-hosted.</span></li>
        <li className="flex gap-3"><span className="text-ink-faint">·</span><span>Plan for stability: if your URL changes you (or a maintainer) need to update the scrape config.</span></li>
      </ul>

      <SectionRule label="Step 5. Wire the scrape" number="v" />
      <p className="text-base leading-relaxed text-ink-soft">
        Append a job to <Code>infrastructure/prometheus/prometheus.yml</Code> pointing at your public URL so the shared Prometheus picks up your harness:
      </p>
      <pre className="mt-3 font-mono text-[12px] leading-snug bg-paper-soft border border-rule p-5 overflow-x-auto whitespace-pre">
{`- job_name: <your-slug>
  metrics_path: /metrics
  scheme: https
  static_configs:
    - targets:
        - your-harness.example.com   # or *.up.railway.app, *.fly.dev, …
      labels:
        benchmark: <your-slug>
        host: <you>                   # alice | acme-rpc | mobula …`}
      </pre>

      <SectionRule label="Step 6. Dry-run + open the PR" number="vi" />
      <p className="text-base leading-relaxed text-ink-soft">Test the queries locally before opening the PR:</p>
      <pre className="mt-3 font-mono text-[12px] leading-snug bg-paper-soft border border-rule p-5 overflow-x-auto whitespace-pre">
{`pnpm validate                                # schema lint
pnpm spec:dry-run wallet-portfolio-latency   # hit Prometheus, print resolved numbers
pnpm dev                                     # render the page locally`}
      </pre>
      <p className="mt-5 text-base leading-relaxed text-ink-soft">
        Open the PR. CI runs <Code>pnpm validate</Code>, <Code>pnpm typecheck</Code> and the build. Once merged, a maintainer redeploys the central Prometheus to apply the new scrape job and the site renders your benchmark on the next ISR cycle (within 60 seconds).
      </p>

      <SectionRule label="Reference" number="vii" />
      <ul className="space-y-3 text-[1rem] leading-relaxed">
        <li><a className="lnk" href="https://github.com/OpenChainBench/OpenChainBench/blob/main/docs/walkthrough.md">docs/walkthrough.md &rarr; concrete end-to-end example with a fictional contributor</a></li>
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
