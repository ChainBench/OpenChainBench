import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Methodology",
  description:
    "How OpenChainBench measures: design principles, statistical conventions, and reproduction guidelines.",
};

const PRINCIPLES = [
  {
    n: "I",
    title: "Identical inputs",
    color: "var(--color-good, #6a9466)",
    body: "Every provider sees the same request — same pair, same notional, same destination, submitted at the same moment from the same region. If inputs differ, we say so.",
  },
  {
    n: "II",
    title: "Honest aggregates",
    color: "var(--color-accent, #c97c5d)",
    body: "We report p50, p90 and p99 latency along with success rate. Means are reported but never used as a headline — tail behaviour is what users feel.",
  },
  {
    n: "III",
    title: "Auditable runs",
    color: "var(--color-warn, #c08a3c)",
    body: "Raw metrics are stored in Prometheus and exposed publicly. Anyone can re-run the harness against the same endpoints and verify the numbers match.",
  },
  {
    n: "IV",
    title: "No cherry-picking",
    color: "#7a6db8",
    body: "The benchmark plan is committed before each run: providers, routes, cadence, timeout. Adding or removing providers after seeing results requires a published correction.",
  },
  {
    n: "V",
    title: "Neutral presentation",
    color: "#5da0a3",
    body: "No spec marks a winner ahead of time. Tables sort mechanically by p50; readers compare the columns themselves.",
  },
] as const;

const CONVENTIONS = [
  {
    term: "Latency aggregates",
    body: "Reported as p50, p90, p99 and arithmetic mean over the run window. Failed requests (timeout, 5xx, malformed response) are excluded from latency aggregates and counted toward success rate.",
  },
  {
    term: "24h range",
    body: "Min and max of p50 observed across the rolling 24-hour window. Captures the volatility of each provider, not just its central tendency.",
  },
  {
    term: "Δ field",
    body: "Each provider's p50 expressed as a percentage delta from the field mean. Negative is below the field, positive is above.",
  },
  {
    term: "Success rate",
    body: "Share of requests returning a usable result within the published timeout. The only metric that includes failures.",
  },
  {
    term: "Region normalisation",
    body: "Where a benchmark is multi-region, the headline figure is the cross-region median. Per-region figures appear on every benchmark page.",
  },
  {
    term: "Significance",
    body: "Differences smaller than the within-provider standard deviation are noted but not framed as a ranking.",
  },
];

const STEPS = [
  "Clone the harness from the link at the bottom of any benchmark report.",
  "Set API keys for the providers you want to include. Public endpoints work for most aggregators; some bridges require allow-listing.",
  "Run the harness — it exposes /metrics over HTTP. Point a local Prometheus at it, or query the public OpenChainBench Prometheus directly.",
  "Run for at least 24 hours to get a comparable sample size (n typically ≥ 1,000 per provider per region).",
  "Compare your aggregates to the published numbers. If they diverge, file a provider correction with a reproducer.",
] as const;

export default function MethodologyPage() {
  return (
    <article className="mx-auto max-w-5xl px-6 py-12">
      {/* Hero */}
      <header className="border-b border-rule pb-6">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
          Editorial standard · last reviewed 2026-05-06
        </p>
        <h1 className="mt-3 display text-3xl sm:text-4xl tracking-tight">
          Methodology
        </h1>
        <p className="mt-3 max-w-3xl text-base sm:text-lg text-ink-soft leading-snug">
          How every benchmark on OpenChainBench is measured, reported and
          reproduced. Open by design — every claim on this page is checkable
          against the underlying spec, harness and Prometheus dataset.
        </p>
      </header>

      {/* Section: Design principles — colored grid */}
      <section className="mt-14">
        <SectionHeader number="I" label="Design principles" />
        <ol className="mt-6 grid gap-px bg-rule border border-rule sm:grid-cols-2">
          {PRINCIPLES.map((p, i) => (
            <li
              key={p.n}
              className={`bg-paper p-6 sm:p-7 relative ${
                i === PRINCIPLES.length - 1 && PRINCIPLES.length % 2 === 1
                  ? "sm:col-span-2"
                  : ""
              }`}
              style={{ ["--accent" as string]: p.color }}
            >
              <span
                className="absolute left-0 top-0 bottom-0 w-[3px]"
                style={{ background: p.color }}
                aria-hidden
              />
              <p
                className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em]"
                style={{ color: p.color }}
              >
                {p.n}
              </p>
              <h3 className="mt-2 display text-lg sm:text-xl text-ink leading-tight">
                {p.title}
              </h3>
              <p className="mt-2 text-sm text-ink-soft leading-relaxed">
                {p.body}
              </p>
            </li>
          ))}
        </ol>
      </section>

      {/* Section: Statistical conventions — ledger-style def list */}
      <section className="mt-16">
        <SectionHeader number="II" label="Statistical conventions" />
        <dl className="mt-6 divide-y divide-rule border-y border-rule">
          {CONVENTIONS.map((c) => (
            <div
              key={c.term}
              className="grid grid-cols-1 sm:grid-cols-[14rem_1fr] gap-1 sm:gap-8 py-4"
            >
              <dt className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink pt-1">
                {c.term}
              </dt>
              <dd className="text-sm text-ink-soft leading-relaxed">{c.body}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Section: Reproducing — recipe layout */}
      <section className="mt-16">
        <SectionHeader number="III" label="Reproducing a result" />
        <ol className="mt-6 space-y-4">
          {STEPS.map((step, i) => (
            <li
              key={i}
              className="flex gap-5 border-l-2 border-rule hover:border-accent transition-colors pl-5 py-2"
            >
              <span className="font-mono text-[12px] tabular text-accent font-semibold shrink-0 pt-1 w-6">
                {String(i + 1).padStart(2, "0")}
              </span>
              <p className="text-sm sm:text-base text-ink-soft leading-relaxed">
                {step}
              </p>
            </li>
          ))}
        </ol>
      </section>

      {/* Section: Corrections — colored callout */}
      <section className="mt-16">
        <SectionHeader number="IV" label="Corrections" />
        <div
          className="mt-6 border-l-4 pl-6 py-4"
          style={{ borderColor: "var(--color-accent, #c97c5d)" }}
        >
          <p className="text-base text-ink-soft leading-relaxed max-w-3xl">
            Found a number you can&apos;t reproduce? File a{" "}
            <a
              className="text-ink font-medium underline-offset-4 hover:underline"
              href="https://github.com/OpenChainBench/OpenChainBench/issues/new?template=data-quality.yml"
            >
              data-quality issue
            </a>{" "}
            (the published figure looks wrong) or a{" "}
            <a
              className="text-ink font-medium underline-offset-4 hover:underline"
              href="https://github.com/OpenChainBench/OpenChainBench/issues/new?template=provider-correction.yml"
            >
              provider correction
            </a>{" "}
            (your service measures a different value). Material errors are
            corrected in place with a dated note on the affected report.
          </p>
        </div>
      </section>

      {/* Footer link */}
      <p className="mt-16 text-xs text-ink-muted">
        Read more about the project on{" "}
        <Link href="/about" className="lnk text-ink-soft">
          /about
        </Link>{" "}
        or browse the source on{" "}
        <a
          className="lnk text-ink-soft"
          href="https://github.com/OpenChainBench/OpenChainBench"
        >
          GitHub
        </a>
        .
      </p>
    </article>
  );
}

function SectionHeader({ number, label }: { number: string; label: string }) {
  return (
    <header className="flex items-baseline gap-3 border-b border-rule pb-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
        Section {number}
      </span>
      <h2 className="display text-xl sm:text-2xl text-ink leading-none">
        {label}
      </h2>
    </header>
  );
}
