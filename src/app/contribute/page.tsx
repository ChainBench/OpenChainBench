import type { Metadata } from "next";
import { AiBriefBlock } from "@/components/ai-brief-block";

export const metadata: Metadata = {
  title: "Contribute. Submit a benchmark",
  description:
    "How to publish your own benchmark on OpenChainBench in six steps.",
};

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
        Maintainers reply within a day to align on methodology before you
        write any code — what counts as a sample, the sampling cadence,
        which percentiles matter, and how to label cohorts. The output
        of this step is a one-paragraph spec you both agree on.
      </>
    ),
  },
  {
    n: "02",
    title: "Write the spec",
    body: (
      <>
        One YAML file at <CodeChip>benchmarks/&lt;your-slug&gt;.yml</CodeChip>{" "}
        — title, description, the Prometheus query that draws the chart,
        the dimensions (chain / region / asset), and the providers it
        will rank. The site reads this file at build time and renders
        the page itself; you never touch React.
      </>
    ),
  },
  {
    n: "03",
    title: "Build the harness",
    body: (
      <>
        Any language. The only contract is a publicly reachable{" "}
        <CodeChip>/metrics</CodeChip> endpoint speaking the Prometheus
        exposition format. Pick the providers you want to measure, hold
        your own credentials, and emit one labelled time-series per
        observation. Reference harnesses live in{" "}
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
        Anywhere with HTTPS — Fly, Railway, Cloud Run, your VPS, a Pi
        in your cupboard. The cost stays with the person who cares
        about the benchmark. Verify the endpoint answers a{" "}
        <CodeChip>200 OK</CodeChip> from the public internet before
        moving on.
      </>
    ),
  },
  {
    n: "05",
    title: "Wire the scrape",
    body: (
      <>
        Add one block under <CodeChip>scrape_configs</CodeChip> in{" "}
        <CodeChip>infrastructure/prometheus/prometheus.yml</CodeChip>{" "}
        pointing at your endpoint, with the labels your spec expects.
        That is the only file in shared infrastructure you ever touch.
      </>
    ),
  },
  {
    n: "06",
    title: "Open a PR",
    body: (
      <>
        Spec + scrape config in one PR. Maintainers review the
        methodology, merge, and reload Prometheus. The page picks up
        the new series within 60 seconds. From that moment on the
        benchmark is yours — you update the spec or the harness
        whenever you want.
      </>
    ),
  },
];

function CodeChip({ children }: { children: React.ReactNode }) {
  return (
    <code className="inline-block px-1.5 py-0.5 mx-0.5 rounded bg-paper-soft text-[0.92em] font-mono text-ink">
      {children}
    </code>
  );
}

export default function ContributePage() {
  return (
    <article className="mx-auto max-w-[1400px] px-4 sm:px-6 py-12 sm:py-20">
      {/* Tutorial label */}
      <p className="label-mono text-ink-faint">TUTORIAL</p>

      {/* Big title */}
      <h1 className="mt-4 display text-5xl sm:text-6xl text-ink font-bold tracking-tight">
        Submit a benchmark.
      </h1>

      {/* Lede */}
      <p className="mt-6 max-w-4xl text-lg sm:text-xl text-ink-soft leading-relaxed">
        Anyone can publish on OpenChainBench. You write the harness, you host
        it, you keep your secrets. The project shares one Prometheus that
        scrapes your public <CodeChip>/metrics</CodeChip> endpoint. that is the
        only piece of common infrastructure.
      </p>

      {/* 6 steps grid */}
      <ol className="mt-16 sm:mt-20 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-6 sm:gap-8">
        {STEPS.map((s) => (
          <li key={s.n}>
            <p
              className={`label-mono ${
                s.accent ? "text-accent" : "text-ink-faint"
              }`}
            >
              {s.n}
            </p>
            <div className="mt-3 mb-4 border-b border-rule" />
            <p className="text-sm font-bold text-ink leading-tight">
              {s.title}
            </p>
            <p className="mt-1 text-xs text-ink-muted leading-snug">
              {s.tagline}
            </p>
          </li>
        ))}
      </ol>

      {/* Two-column section: federation explainer + AI assist */}
      <div className="mt-16 sm:mt-24 grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
        {/* Left: How it actually works */}
        <section className="card p-8 sm:p-10 bg-paper-soft border border-rule rounded-xl">
          <p className="label-mono text-ink-faint">HOW IT ACTUALLY WORKS</p>
          <h2 className="mt-4 display text-3xl sm:text-4xl text-ink font-bold tracking-tight leading-tight">
            A federation,{" "}
            <span className="text-accent">not a platform.</span>
          </h2>
          <div className="mt-6 space-y-4 text-sm sm:text-base text-ink-soft leading-relaxed">
            <p>
              Every benchmark on OpenChainBench is run by its author. You pick
              the providers, you write the harness, you host it on Fly,
              Railway, Cloud Run or your own VPS. There is no shared runtime,
              no shared credentials, no central queue. The harness exposes a
              public <CodeChip>/metrics</CodeChip> endpoint over HTTPS, and
              that is the entire integration surface.
            </p>
            <p>
              The one piece of common infrastructure is a Prometheus instance
              that scrapes every published harness. To wire yours in, you add
              one block to <CodeChip>scrape_configs</CodeChip> inside{" "}
              <CodeChip>infrastructure/prometheus/prometheus.yml</CodeChip>{" "}
              and open a PR. Maintainers reload Prometheus, the site picks up
              the new spec, and your benchmark renders itself.
            </p>
            <p>
              This federation model means no team can gate-keep a metric, no
              outage on one harness affects another, and the cost of running a
              benchmark stays with the person who cares about it. The
              walkthrough in the repo shows a fictional contributor going from
              issue to merged PR end-to-end.
            </p>
          </div>
        </section>

        {/* Right: Drafting with AI (vertical stack) */}
        <section className="card p-8 sm:p-10 bg-paper-soft border border-rule rounded-xl">
          <div className="flex items-baseline gap-3">
            <span className="label-mono text-ink-faint">OPTIONAL</span>
            <h2 className="display text-2xl sm:text-3xl text-ink font-bold tracking-tight leading-tight">
              Drafting with AI
            </h2>
          </div>
          <p className="mt-4 text-sm sm:text-base text-ink-soft leading-relaxed">
            We maintain a single source-of-truth skill that walks any agent
            through the six steps above with the exact conventions a
            reviewer will check. Pick the surface that matches your tooling.
          </p>
          <div className="mt-6">
            <AiBriefBlock />
          </div>
        </section>
      </div>

      {/* Detailed walkthrough — what each step really involves */}
      <section className="mt-16 sm:mt-24">
        <p className="label-mono text-ink-faint">WALK-THROUGH</p>
        <h2 className="mt-4 display text-3xl sm:text-4xl text-ink font-bold tracking-tight leading-tight">
          What each step really involves.
        </h2>
        <p className="mt-4 max-w-3xl text-sm sm:text-base text-ink-soft leading-relaxed">
          The six tiles above are the shape of a contribution. Here is the
          detail behind each one — roughly three to four hours of focused
          work, spread across a couple of days.
        </p>

        <ol className="mt-10 grid grid-cols-1 md:grid-cols-2 gap-6">
          {WALKTHROUGH.map((s) => (
            <li
              key={s.n}
              className="border border-rule rounded-xl bg-paper p-6 sm:p-7"
            >
              <div className="flex items-baseline gap-3">
                <span className="label-mono text-accent">{s.n}</span>
                <h3 className="display text-lg text-ink font-bold tracking-tight">
                  {s.title}
                </h3>
              </div>
              <p className="mt-3 text-sm sm:text-base text-ink-soft leading-relaxed">
                {s.body}
              </p>
            </li>
          ))}
        </ol>

        <p className="mt-10 max-w-3xl text-sm text-ink-muted leading-relaxed">
          Reference contributors live in{" "}
          <CodeChip>mobula-api/openchainbench-app</CodeChip> (multi-chain
          harnesses) and <CodeChip>miniapps/</CodeChip> (single-purpose
          probes). Start there if you want a working example to copy.
        </p>
      </section>
    </article>
  );
}
