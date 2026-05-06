import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Contribute. Submit a benchmark",
  description:
    "How to publish your own benchmark on OpenChainBench in six steps.",
};

const STEP_COLORS = [
  "var(--color-good, #6a9466)",
  "var(--color-accent, #c97c5d)",
  "var(--color-warn, #c08a3c)",
  "#7a6db8",
  "#5da0a3",
  "#a85a78",
];

const STEPS = [
  {
    n: "I",
    title: "Open an issue",
    tagline: "Align on the metric.",
    body: (
      <>
        Use the{" "}
        <a
          className="text-ink font-medium underline-offset-4 hover:underline hover:text-accent transition-colors"
          href="https://github.com/OpenChainBench/OpenChainBench/issues/new?template=new-benchmark.yml"
        >
          Propose a benchmark
        </a>{" "}
        template to describe what you want to measure, which providers, and where the harness will run. Maintainers respond with feedback before any code is written. Want to brainstorm first? Use{" "}
        <a
          className="text-ink font-medium underline-offset-4 hover:underline hover:text-accent transition-colors"
          href="https://github.com/OpenChainBench/OpenChainBench/discussions/categories/ideas"
        >
          Discussions → Ideas
        </a>
        .
      </>
    ),
  },
  {
    n: "II",
    title: "Write the spec",
    tagline: "One YAML file.",
    body: (
      <>
        Drop a file at <Code>benchmarks/&lt;your-slug&gt;.yml</Code>. It is the source of truth for the report. Title, abstract, methodology, providers and the PromQL that fills in the numbers.
      </>
    ),
    code: `# benchmarks/wallet-portfolio-latency.yml
slug: wallet-portfolio-latency
number: "006"
title: Wallet Portfolio API. Read Latency
subtitle: How fast each wallet API returns a complete portfolio.
category: Wallets
unit: ms

abstract: |
  We benchmark how long the major wallet APIs take to return a full
  portfolio for a known busy address across 12 chains.

methodology:
  - "Address set: 200 addresses with 50+ tokens across 5+ chains."
  - "Cadence: 1 request / address every 60 s for 24 hours."
  - "Timeout: 5,000 ms. Failures excluded from latency aggregates."

source: https://github.com/OpenChainBench/OpenChainBench/...

prometheus:
  url: https://prom.openchainbench.com
  window: 24h

providers:
  - slug: provider-a
    name: Provider A
    queries:
      p50: histogram_quantile(0.5, sum by (le) (rate(...[24h])))
      p90: histogram_quantile(0.9, sum by (le) (rate(...[24h])))
      p99: histogram_quantile(0.99, sum by (le) (rate(...[24h])))`,
  },
  {
    n: "III",
    title: "Build the harness",
    tagline: "Expose /metrics.",
    body: (
      <>
        The harness is a long-running data producer in any language. Bun, Node, Python, Go, Rust. The contract is small:
        <ul className="mt-3 space-y-1.5">
          <li className="flex gap-2"><span className="text-ink-faint">·</span><span>Run continuously, expose <Code>/metrics</Code> over HTTP on a documented port.</span></li>
          <li className="flex gap-2"><span className="text-ink-faint">·</span><span>Use the metric and label names referenced by your YAML.</span></li>
          <li className="flex gap-2"><span className="text-ink-faint">·</span><span>Document inputs, regions, timeouts in <Code>harnesses/&lt;slug&gt;/README.md</Code>.</span></li>
          <li className="flex gap-2"><span className="text-ink-faint">·</span><span>Don&apos;t commit API keys. Read them from env vars.</span></li>
          <li className="flex gap-2"><span className="text-ink-faint">·</span><span>Don&apos;t bundle Prometheus, Grafana or Alertmanager. They are shared.</span></li>
        </ul>
      </>
    ),
  },
  {
    n: "IV",
    title: "Host it",
    tagline: "Anywhere with HTTPS.",
    body: (
      <>
        OpenChainBench is a federation: each harness is hosted by whoever wrote it. Pick whatever fits. Railway, Fly, Cloud Run, a VPS, even a home server with a static IP. The only requirement is that <Code>/metrics</Code> is reachable over HTTPS at a stable URL. You own the runtime, the secrets and the budget. Maintainers never see your API keys or wallet keys.
      </>
    ),
  },
  {
    n: "V",
    title: "Wire the scrape",
    tagline: "One block in prometheus.yml.",
    body: (
      <>
        Append a job to <Code>infrastructure/prometheus/prometheus.yml</Code> pointing at your public URL so the shared Prometheus picks up your harness:
      </>
    ),
    code: `- job_name: <your-slug>
  metrics_path: /metrics
  scheme: https
  static_configs:
    - targets:
        - your-harness.example.com   # or *.up.railway.app, *.fly.dev, ...
      labels:
        benchmark: <your-slug>
        host: <you>                   # alice | acme-rpc | mobula ...`,
  },
  {
    n: "VI",
    title: "Open a PR",
    tagline: "The page renders itself.",
    body: (
      <>
        Test locally first:
      </>
    ),
    code: `pnpm validate                                # schema lint
pnpm spec:dry-run wallet-portfolio-latency   # hit Prometheus, print resolved numbers
pnpm dev                                     # render the page locally`,
    after: (
      <>
        Open the PR. CI runs <Code>pnpm validate</Code>, <Code>pnpm typecheck</Code> and the build. Once merged, a maintainer redeploys the central Prometheus to apply the new scrape job; the site renders your benchmark on the next ISR cycle (≤ 60 s).
      </>
    ),
  },
];

const REFERENCES = [
  {
    href: "https://github.com/OpenChainBench/OpenChainBench/blob/main/docs/walkthrough.md",
    label: "docs/walkthrough.md",
    desc: "Concrete end-to-end example with a fictional contributor.",
  },
  {
    href: "/methodology",
    label: "Methodology",
    desc: "Design principles, statistical conventions.",
    internal: true,
  },
  {
    href: "https://github.com/OpenChainBench/OpenChainBench/blob/main/benchmarks/README.md",
    label: "benchmarks/README.md",
    desc: "Spec field reference.",
  },
  {
    href: "https://github.com/OpenChainBench/OpenChainBench/blob/main/harnesses/README.md",
    label: "harnesses/README.md",
    desc: "Harness contract.",
  },
  {
    href: "https://github.com/OpenChainBench/OpenChainBench/blob/main/CONTRIBUTING.md",
    label: "CONTRIBUTING.md",
    desc: "Full submission flow.",
  },
];

export default function ContributePage() {
  return (
    <article className="mx-auto max-w-5xl px-6 py-12">
      {/* Hero */}
      <header className="border-b-2 border-ink pb-6">
        <h1 className="display text-3xl sm:text-4xl tracking-tight">
          Submit a benchmark.
        </h1>
        <p className="mt-3 max-w-3xl text-base sm:text-lg text-ink-soft leading-snug">
          Anyone can publish on OpenChainBench. You write the harness, you host it, you keep your secrets. The project shares one Prometheus that scrapes your public <Code>/metrics</Code> endpoint. That is the only piece of common infrastructure.
        </p>
      </header>

      {/* Step strip — colored grid, each tile anchors to its detail below */}
      <ol className="mt-10 grid gap-px bg-rule border border-rule sm:grid-cols-2 lg:grid-cols-3">
        {STEPS.map((s, i) => (
          <li key={s.n}>
            <a
              href={`#step-${s.n}`}
              className="bg-paper p-5 relative group block h-full hover:bg-paper-soft/40 transition-colors"
              style={{ ["--accent" as string]: STEP_COLORS[i] }}
            >
              <span
                className="absolute left-0 top-0 bottom-0 w-[3px] transition-transform duration-200 origin-top group-hover:scale-y-110"
                style={{ background: STEP_COLORS[i] }}
                aria-hidden
              />
              <p
                className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em]"
                style={{ color: STEP_COLORS[i] }}
              >
                {s.n}
              </p>
              <p className="mt-1.5 display text-base text-ink leading-tight">
                {s.title}
              </p>
              <p className="mt-1 text-xs text-ink-muted">{s.tagline}</p>
              <span
                className="absolute right-3 top-3 font-mono text-[11px] text-ink-faint opacity-0 group-hover:opacity-100 transition-opacity"
                aria-hidden
              >
                ↓
              </span>
            </a>
          </li>
        ))}
      </ol>

      {/* Detailed step bodies */}
      {STEPS.map((s, i) => (
        <section key={s.n} id={`step-${s.n}`} className="mt-14 scroll-mt-20">
          <header
            className="flex items-baseline gap-3 border-b pb-2"
            style={{ borderColor: STEP_COLORS[i] }}
          >
            <span
              className="font-mono text-[10px] uppercase tracking-[0.2em] font-semibold"
              style={{ color: STEP_COLORS[i] }}
            >
              Step {s.n}
            </span>
            <h2 className="display text-xl sm:text-2xl text-ink leading-none">
              {s.title}
            </h2>
            <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint hidden sm:inline">
              {s.tagline}
            </span>
          </header>

          <div className="mt-4 max-w-3xl text-sm sm:text-base text-ink-soft leading-relaxed">
            {s.body}
          </div>

          {s.code && (
            <pre
              className="mt-5 font-mono text-[12px] leading-snug bg-paper-soft border-l-2 border-rule hover:border-l-accent transition-colors p-5 overflow-x-auto whitespace-pre"
              style={{ ["--accent" as string]: STEP_COLORS[i] }}
            >
              {s.code}
            </pre>
          )}

          {"after" in s && s.after ? (
            <div className="mt-5 max-w-3xl text-sm sm:text-base text-ink-soft leading-relaxed">
              {s.after}
            </div>
          ) : null}
        </section>
      ))}

      {/* Reference */}
      <section className="mt-16">
        <header className="flex items-baseline gap-3 border-b border-rule pb-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
            Reference
          </span>
          <h2 className="display text-xl sm:text-2xl text-ink leading-none">
            Where to look next
          </h2>
        </header>
        <ul className="mt-4 divide-y divide-rule border-b border-rule">
          {REFERENCES.map((r) => (
            <li key={r.href}>
              {r.internal ? (
                <Link
                  href={r.href}
                  className="group flex items-baseline gap-4 py-3 px-1 hover:bg-paper-soft/60 transition-colors"
                >
                  <RefRow label={r.label} desc={r.desc} />
                </Link>
              ) : (
                <a
                  href={r.href}
                  className="group flex items-baseline gap-4 py-3 px-1 hover:bg-paper-soft/60 transition-colors"
                >
                  <RefRow label={r.label} desc={r.desc} external />
                </a>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* Closing CTA */}
      <div
        className="mt-16 relative pl-6 py-5 border-l-4"
        style={{ borderColor: "var(--color-accent, #c97c5d)" }}
      >
        <span
          className="absolute -left-2 top-6 h-3 w-3 rounded-full"
          style={{ background: "var(--color-accent, #c97c5d)" }}
          aria-hidden
        >
          <span
            className="absolute inset-0 rounded-full animate-ping opacity-50"
            style={{ background: "var(--color-accent, #c97c5d)" }}
          />
        </span>
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
          Ready?
        </p>
        <p className="mt-2 text-base sm:text-lg text-ink-soft max-w-3xl leading-snug">
          <a
            className="text-ink font-medium underline-offset-4 hover:underline hover:text-accent transition-colors"
            href="https://github.com/OpenChainBench/OpenChainBench/issues/new?template=new-benchmark.yml"
          >
            Open a benchmark issue
          </a>
          {" · "}
          <a
            className="hover:text-ink transition-colors"
            href="https://github.com/OpenChainBench/OpenChainBench/discussions/categories/ideas"
          >
            brainstorm in Discussions
          </a>
          {" · "}
          <a
            className="hover:text-ink transition-colors"
            href="https://github.com/OpenChainBench/OpenChainBench"
          >
            GitHub repository ↗
          </a>
        </p>
      </div>
    </article>
  );
}

function RefRow({
  label,
  desc,
  external,
}: {
  label: string;
  desc: string;
  external?: boolean;
}) {
  return (
    <>
      <span className="font-mono text-sm text-ink shrink-0 group-hover:text-accent transition-colors">
        {label}
      </span>
      <span className="text-sm text-ink-muted">{desc}</span>
      <span className="ml-auto text-ink-faint group-hover:text-accent transition-colors">
        {external ? "↗" : "→"}
      </span>
    </>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="font-mono text-[0.92em] bg-paper-soft border border-rule px-1.5 py-0.5">
      {children}
    </code>
  );
}
