import type { Metadata } from "next";
import { AiBriefBlock } from "@/components/ai-brief-block";
import { pageMetadata } from "@/lib/page-metadata";

export const metadata: Metadata = pageMetadata({
  path: "/contribute",
  title: "Contribute. Submit a benchmark",
  description:
    "How to publish your own benchmark on OpenChainBench in six steps.",
});

const STEPS = [
  {
    n: "01",
    title: "Open an issue",
    tagline: "Align on the metric.",
    accent: true,
  },
  {
    n: "02",
    title: "Write the spec",
    tagline: "One YAML file.",
  },
  {
    n: "03",
    title: "Build the harness",
    tagline: "Expose /metrics.",
  },
  {
    n: "04",
    title: "Host it",
    tagline: "Anywhere with HTTPS.",
  },
  {
    n: "05",
    title: "Wire the scrape",
    tagline: "One block in prometheus.yml.",
  },
  {
    n: "06",
    title: "Open a PR",
    tagline: "The page renders itself.",
  },
];

const WALKTHROUGH = [
  {
    n: "01",
    title: "Open an issue",
    body: (
      <>
        Describe the metric and the providers you intend to compare.
        Maintainers reply within a day to align on methodology: what
        counts as a sample, the cadence, which percentiles matter, and
        how to label cohorts. Output: a one-paragraph spec you both
        agree on.
      </>
    ),
  },
  {
    n: "02",
    title: "Write the spec",
    body: (
      <>
        One YAML file at <CodeChip>benchmarks/&lt;slug&gt;.yml</CodeChip>{" "}
        with title, description, the Prometheus query, the dimensions
        (chain / region / asset), and the providers it ranks. The site
        reads it at build time and renders the page; you never touch
        React.
      </>
    ),
  },
  {
    n: "03",
    title: "Build the harness",
    body: (
      <>
        Any language. Only contract: a public{" "}
        <CodeChip>/metrics</CodeChip> endpoint in the Prometheus
        format. Hold your own credentials, emit one labelled time-series
        per observation. Reference harnesses in{" "}
        <CodeChip>mobula-api/openchainbench-app</CodeChip> and{" "}
        <CodeChip>miniapps/</CodeChip>.
      </>
    ),
  },
  {
    n: "04",
    title: "Host it",
    body: (
      <>
        Anywhere with HTTPS: Fly, Railway, Cloud Run, your VPS, a Pi.
        Cost stays with the person who cares. Verify the endpoint
        answers a <CodeChip>200 OK</CodeChip> from the public internet
        before moving on.
      </>
    ),
  },
  {
    n: "05",
    title: "Wire the scrape",
    body: (
      <>
        One block under <CodeChip>scrape_configs</CodeChip> in{" "}
        <CodeChip>infrastructure/prometheus/prometheus.yml</CodeChip>{" "}
        pointing at your endpoint, with the labels your spec expects.
        Only file in shared infrastructure you ever touch.
      </>
    ),
  },
  {
    n: "06",
    title: "Open a PR",
    body: (
      <>
        Spec + scrape config in one PR. Maintainers review, merge, and
        reload Prometheus. The page picks up the new series within 60 s.
        From that moment on the benchmark is yours.
      </>
    ),
  },
];

function CodeChip({ children }: { children: React.ReactNode }) {
  return (
    <code className="px-1.5 py-0.5 mx-0.5 rounded bg-paper-soft text-[0.92em] font-mono text-ink break-all">
      {children}
    </code>
  );
}

export default function ContributePage() {
  return (
    <article className="mx-auto max-w-5xl px-4 sm:px-6 py-8 sm:py-12">
      <p className="label-mono text-ink-faint">TUTORIAL</p>

      <h1 className="mt-3 display text-4xl sm:text-5xl text-ink tracking-tight">
        Submit a benchmark.
      </h1>

      <p className="mt-4 max-w-3xl text-base sm:text-lg text-ink-muted leading-snug">
        Anyone can publish on OpenChainBench. You write the harness, you host
        it, you keep your secrets. The project shares one Prometheus that
        scrapes your public <CodeChip>/metrics</CodeChip> endpoint, the only
        piece of common infrastructure.
      </p>

      {/* 6 steps strip */}
      <ol className="mt-12 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-5">
        {STEPS.map((s) => (
          <li key={s.n}>
            <p
              className={`label-mono ${
                s.accent ? "text-accent" : "text-ink-faint"
              }`}
            >
              {s.n}
            </p>
            <div className="mt-2 mb-3 border-b border-rule" />
            <p className="text-sm font-semibold text-ink leading-tight">
              {s.title}
            </p>
            <p className="mt-1 text-xs text-ink-muted leading-snug">
              {s.tagline}
            </p>
          </li>
        ))}
      </ol>

      {/* Two-column: federation explainer + AI assist */}
      <div className="mt-14 grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        <section className="card-soft rounded-xl p-5 sm:p-6">
          <p className="label-mono text-ink-faint">HOW IT ACTUALLY WORKS</p>
          <h2 className="mt-3 display text-xl sm:text-2xl text-ink tracking-tight leading-tight">
            A federation,{" "}
            <span className="text-accent">not a platform.</span>
          </h2>
          <div className="mt-4 space-y-3 text-sm text-ink-soft leading-relaxed">
            <p>
              Every benchmark on OpenChainBench is run by its author. You pick
              the providers, write the harness, host it on Fly, Railway, Cloud
              Run or your own VPS. There is no shared runtime, no shared
              credentials, no central queue. The harness exposes a public{" "}
              <CodeChip>/metrics</CodeChip> endpoint over HTTPS, the entire
              integration surface.
            </p>
            <p>
              One Prometheus scrapes every published harness. To wire yours in,
              add one block to <CodeChip>scrape_configs</CodeChip> inside{" "}
              <CodeChip>infrastructure/prometheus/prometheus.yml</CodeChip>{" "}
              and open a PR. Maintainers reload Prometheus, the site picks up
              the new spec, your benchmark renders itself.
            </p>
            <p>
              No team can gate-keep a metric, no outage on one harness affects
              another, and the cost of running a benchmark stays with the
              person who cares about it.
            </p>
          </div>
        </section>

        <section id="ai-assist" className="card-soft rounded-xl p-5 sm:p-6 scroll-mt-20">
          <div className="flex items-baseline gap-3">
            <span className="label-mono text-ink-faint">OPTIONAL</span>
            <h2 className="display text-xl sm:text-2xl text-ink tracking-tight leading-tight">
              Drafting with AI
            </h2>
          </div>
          <p className="mt-3 text-sm text-ink-soft leading-relaxed">
            A single source-of-truth skill walks any agent through the six
            steps with the exact conventions a reviewer will check. Pick the
            surface that matches your tooling.
          </p>
          <div className="mt-4">
            <AiBriefBlock />
          </div>
        </section>
      </div>

      {/* Detailed walkthrough */}
      <section className="mt-14">
        <p className="label-mono text-ink-faint">WALK-THROUGH</p>
        <h2 className="mt-3 display text-2xl sm:text-3xl text-ink tracking-tight leading-tight">
          What each step really involves.
        </h2>
        <p className="mt-3 max-w-3xl text-sm text-ink-muted leading-snug">
          Roughly three to four hours of focused work, spread across a couple
          of days.
        </p>

        <ol className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
          {WALKTHROUGH.map((s) => (
            <li
              key={s.n}
              className="card-soft rounded-xl p-5"
            >
              <div className="flex items-baseline gap-3">
                <span className="label-mono text-accent">{s.n}</span>
                <h3 className="display text-base text-ink tracking-tight">
                  {s.title}
                </h3>
              </div>
              <p className="mt-2 text-sm text-ink-soft leading-relaxed">
                {s.body}
              </p>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}
