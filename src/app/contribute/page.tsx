import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { SectionRule } from "@/components/section-rule";

export const metadata: Metadata = {
  title: "Contribute — Submit a benchmark",
  description:
    "How to publish your own benchmark on OpenChainBench in four steps.",
};

export default function ContributePage() {
  return (
    <article className="px-4 pt-12 sm:pt-16">
      <div className="mx-auto max-w-3xl">
        <span className="eyebrow">Tutorial</span>
        <h1 className="mt-5 display text-4xl sm:text-5xl">
          Submit a benchmark.
        </h1>
        <p className="mt-5 text-lg text-ink-muted leading-relaxed">
          Anyone can publish on OpenChainBench. Four steps, no committee, no editorial gatekeeping. The format is fixed, the methodology is yours.
        </p>

        <div className="mt-8 grid gap-4 sm:grid-cols-4">
          <Tldr n="01" title="Write a spec" body="One YAML file." />
          <Tldr n="02" title="Run a harness" body="Push metrics to Prometheus." />
          <Tldr n="03" title="Open a PR" body="The page renders itself." />
          <Tldr n="04" title="Iterate" body="Numbers update every minute." />
        </div>

        <SectionRule label="Step 1 — Write the spec" />
        <p className="text-base leading-relaxed text-ink-soft">
          Drop a file at <Code>benchmarks/&lt;your-slug&gt;.yml</Code>. It is the source of truth for the report — title, abstract, methodology, providers and the PromQL that fills in the numbers.
        </p>

        <pre className="mt-6 card font-mono text-[12px] leading-snug bg-bg-soft p-5 overflow-x-auto whitespace-pre">
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

findings: []  # filled in once you have data and want to publish a take

source: https://github.com/OpenChainBench/OpenChainBench/tree/main/harnesses/wallet-portfolio

prometheus:
  url: https://prom.example.com
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

        <p className="mt-5 text-base leading-relaxed text-ink-soft">
          That is the entire wire format. The Zod schema in <Code>src/lib/spec-schema.ts</Code> is the single source of truth; <Code>pnpm validate</Code> lints every spec in CI.
        </p>

        <SectionRule label="Step 2 — Run the harness" />
        <p className="text-base leading-relaxed text-ink-soft">
          The harness is whatever script measures what you specified. Bun, Node, Python, Go — pick what fits the providers. The contract is small:
        </p>
        <ul className="mt-4 space-y-2.5 text-base leading-relaxed text-ink-soft">
          <li className="flex gap-3"><span className="text-ink-faint">—</span><span>Run continuously, push to a Prometheus instance reachable over HTTPS.</span></li>
          <li className="flex gap-3"><span className="text-ink-faint">—</span><span>Use the metric and label names referenced by your YAML — they are how the site retrieves your numbers.</span></li>
          <li className="flex gap-3"><span className="text-ink-faint">—</span><span>Document timeouts, regions and inputs in a <Code>harnesses/&lt;slug&gt;/README.md</Code> so anyone can reproduce.</span></li>
          <li className="flex gap-3"><span className="text-ink-faint">—</span><span>Don&apos;t commit API keys. Read them from environment variables.</span></li>
        </ul>

        <SectionRule label="Step 3 — Dry-run + open the PR" />
        <p className="text-base leading-relaxed text-ink-soft">Test the queries locally before opening the PR:</p>
        <pre className="mt-3 card font-mono text-[12px] leading-snug bg-bg-soft p-5 overflow-x-auto whitespace-pre">
{`pnpm validate                           # schema lint
pnpm spec:dry-run wallet-portfolio-latency   # hit Prometheus, print resolved numbers
pnpm dev                                # render the page locally`}
        </pre>
        <p className="mt-5 text-base leading-relaxed text-ink-soft">
          Open the PR. CI runs <Code>pnpm validate</Code>, <Code>pnpm typecheck</Code> and the build. Once merged, the site re-queries Prometheus every 60 seconds and your benchmark goes live on the next revalidation.
        </p>

        <SectionRule label="Step 4 — Iterate" />
        <p className="text-base leading-relaxed text-ink-soft">
          Edit the YAML to add providers, change the window, swap the Prometheus URL, expand to more regions. Each merge to <Code>main</Code> pushes a new build; ISR picks up changes within the minute.
        </p>

        <SectionRule label="Reference" />
        <ul className="space-y-3 text-base leading-relaxed">
          <li><Link className="lnk" href="/methodology">Methodology &rarr; design principles, statistical conventions</Link></li>
          <li><a className="lnk" href="https://github.com/OpenChainBench/OpenChainBench/blob/main/benchmarks/README.md">benchmarks/README.md &rarr; spec field reference</a></li>
          <li><a className="lnk" href="https://github.com/OpenChainBench/OpenChainBench/blob/main/harnesses/README.md">harnesses/README.md &rarr; harness contract</a></li>
          <li><a className="lnk" href="https://github.com/OpenChainBench/OpenChainBench/blob/main/CONTRIBUTING.md">CONTRIBUTING.md &rarr; full submission flow</a></li>
        </ul>

        <div className="mt-12 card p-6 sm:p-8 flex flex-wrap items-center justify-between gap-3">
          <p className="text-base font-medium">Ready?</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <a
              href="https://github.com/OpenChainBench/OpenChainBench/issues/new?template=new-benchmark.md"
              className="inline-flex items-center gap-2 rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-bg hover:bg-accent-soft"
            >
              Open a benchmark issue
              <ArrowUpRight size={14} strokeWidth={2.2} />
            </a>
            <a className="lnk text-ink-soft" href="https://github.com/OpenChainBench/OpenChainBench">
              GitHub repository
            </a>
          </div>
        </div>
      </div>
    </article>
  );
}

function Tldr({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="card p-4">
      <p className="font-mono text-[10px] tabular text-ink-faint">{n}</p>
      <p className="mt-2 text-base font-semibold">{title}</p>
      <p className="mt-1 text-sm text-ink-muted">{body}</p>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="font-mono text-[0.92em] bg-bg-soft border border-rule px-1.5 py-0.5 rounded">
      {children}
    </code>
  );
}
