import type { Metadata } from "next";
import Link from "next/link";
import { SectionRule } from "@/components/section-rule";

export const metadata: Metadata = {
  title: "Contribute — Submit a benchmark",
  description:
    "How to publish your own benchmark on OpenChainBench in four steps: write a YAML spec, run a harness, push metrics to Prometheus, open a PR.",
};

export default function ContributePage() {
  return (
    <article className="mx-auto max-w-3xl px-6 py-12">
      <p className="font-sans text-[11px] uppercase tracking-[0.22em] text-accent">
        Tutorial
      </p>
      <h1 className="mt-3 font-serif text-5xl font-bold tracking-tight">
        Submit a benchmark.
      </h1>
      <p className="mt-3 font-serif italic text-xl text-ink-soft">
        Anyone can publish on OpenChainBench. Four steps, no committee, no
        editorial gatekeeping. The format is fixed, the methodology is yours.
      </p>

      {/* TL;DR card */}
      <div className="mt-8 border-y-2 border-ink py-5 grid gap-4 sm:grid-cols-4">
        <Tldr n="01" title="Write a spec" body="One YAML file." />
        <Tldr n="02" title="Run a harness" body="Push metrics to Prometheus." />
        <Tldr n="03" title="Open a PR" body="The page renders itself." />
        <Tldr n="04" title="Iterate" body="Numbers update every minute." />
      </div>

      <SectionRule label="Step 1 — Write the spec" number="i" />
      <p className="font-serif text-[1.05rem] leading-[1.65]">
        Drop a file at <Code>benchmarks/&lt;your-slug&gt;.yml</Code>. It is
        the source of truth for the report — title, abstract, methodology,
        providers and the PromQL that fills in the numbers.
      </p>

      <pre className="mt-6 font-mono text-[12px] leading-snug bg-paper-deep border border-rule p-5 overflow-x-auto whitespace-pre">
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

source: https://github.com/Flotapponnier/OpenChainBench/tree/main/harnesses/wallet-portfolio

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

      <p className="mt-5 font-serif text-[1rem] leading-relaxed text-ink-soft">
        That is the entire wire format. The Zod schema in{" "}
        <Code>src/lib/spec-schema.ts</Code> is the single source of truth;{" "}
        <Code>pnpm validate</Code> lints every spec in CI.
      </p>

      <SectionRule label="Step 2 — Run the harness" number="ii" />
      <p className="font-serif text-[1.05rem] leading-[1.65]">
        The harness is whatever script measures what you specified. Bun, Node,
        Python, Go — pick what fits the providers. The contract is small:
      </p>
      <ul className="mt-4 space-y-2 font-serif text-[1rem] leading-relaxed text-ink-soft">
        <li className="flex gap-3">
          <span className="text-ink-muted">—</span>
          <span>
            Run continuously, push to a Prometheus instance reachable over
            HTTPS.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="text-ink-muted">—</span>
          <span>
            Use the metric and label names referenced by your YAML — they
            are how the site retrieves your numbers.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="text-ink-muted">—</span>
          <span>
            Document timeouts, regions and inputs in a{" "}
            <Code>harnesses/&lt;slug&gt;/README.md</Code> so anyone can
            reproduce the run.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="text-ink-muted">—</span>
          <span>
            Don&apos;t commit API keys. Read them from environment
            variables and ship a <Code>.env.example</Code>.
          </span>
        </li>
      </ul>

      <p className="mt-4 font-serif text-[1rem] leading-relaxed text-ink-soft">
        A reference Prometheus histogram setup looks like:
      </p>
      <pre className="mt-3 font-mono text-[12px] leading-snug bg-paper-deep border border-rule p-5 overflow-x-auto whitespace-pre">
{`# Prometheus client (Bun / Node)
const histogram = new prom.Histogram({
  name: "ocb_portfolio_ms",
  help: "Wallet portfolio read latency, milliseconds",
  labelNames: ["provider", "region", "chain"],
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

const counter = new prom.Counter({
  name: "ocb_portfolio_total",
  help: "Wallet portfolio request count",
  labelNames: ["provider", "region", "chain", "success"],
});`}
      </pre>

      <SectionRule label="Step 3 — Dry-run + open the PR" number="iii" />
      <p className="font-serif text-[1.05rem] leading-[1.65]">
        Test the queries locally before opening the PR:
      </p>
      <pre className="mt-3 font-mono text-[12px] leading-snug bg-paper-deep border border-rule p-5 overflow-x-auto whitespace-pre">
{`pnpm validate                           # schema lint
pnpm spec:dry-run wallet-portfolio-latency   # hit Prometheus, print resolved numbers
pnpm dev                                # render the page locally`}
      </pre>
      <p className="mt-5 font-serif text-[1.05rem] leading-[1.65]">
        Open the PR. CI runs <Code>pnpm validate</Code>,{" "}
        <Code>pnpm typecheck</Code> and the build. Once merged, the site
        re-queries Prometheus every 60 seconds and your benchmark goes live
        on the next revalidation.
      </p>

      <SectionRule label="Step 4 — Iterate" number="iv" />
      <p className="font-serif text-[1.05rem] leading-[1.65]">
        Edit the YAML to add providers, change the window, swap the
        Prometheus URL, expand to more regions. Each merge to{" "}
        <Code>main</Code> pushes a new build; ISR picks up changes within
        the minute.
      </p>
      <p className="mt-4 font-serif text-[1.05rem] leading-[1.65]">
        Bug in a number you can&apos;t reproduce? File an issue. Material
        errors are corrected in place with a dated note on the report.
      </p>

      <SectionRule label="Reference" number="v" />
      <ul className="space-y-3 font-serif text-[1rem] leading-relaxed">
        <li>
          <Link className="lnk" href="/methodology">
            Methodology &rarr; design principles, statistical conventions
          </Link>
        </li>
        <li>
          <a
            className="lnk"
            href="https://github.com/Flotapponnier/OpenChainBench/blob/main/benchmarks/README.md"
          >
            benchmarks/README.md &rarr; spec field reference
          </a>
        </li>
        <li>
          <a
            className="lnk"
            href="https://github.com/Flotapponnier/OpenChainBench/blob/main/harnesses/README.md"
          >
            harnesses/README.md &rarr; harness contract
          </a>
        </li>
        <li>
          <a
            className="lnk"
            href="https://github.com/Flotapponnier/OpenChainBench/blob/main/CONTRIBUTING.md"
          >
            CONTRIBUTING.md &rarr; full submission flow
          </a>
        </li>
      </ul>

      <div className="mt-12 border-y-2 border-ink py-6 flex flex-wrap items-center justify-between gap-3">
        <p className="font-serif text-lg">Ready?</p>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 font-sans text-sm">
          <a
            className="inline-flex items-center gap-2 border-b-2 border-ink pb-0.5 hover:text-accent"
            href="https://github.com/Flotapponnier/OpenChainBench/issues/new?template=new-benchmark.md"
          >
            Open a benchmark issue &rarr;
          </a>
          <a
            className="lnk text-ink-soft"
            href="https://github.com/Flotapponnier/OpenChainBench"
          >
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
      <p className="mt-1 font-serif text-base font-semibold">{title}</p>
      <p className="mt-1 font-serif italic text-sm text-ink-soft">{body}</p>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="font-mono text-[0.92em] bg-paper-deep border border-rule px-1.5 py-0.5">
      {children}
    </code>
  );
}
