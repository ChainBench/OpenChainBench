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

const TIMELINE = [
  {
    when: "Day 0 · ~30 min.",
    what: "open issue, align on methodology with a maintainer.",
  },
  {
    when: "Day 1-2 · ~2 h.",
    what: "write the spec + harness in your fork.",
  },
  {
    when: "Day 2 · ~30 min.",
    what: "deploy your harness on Fly / Railway / your VPS, verify ",
    code: "/metrics",
    tail: " publicly reachable.",
  },
  {
    when: "Day 2 · ~10 min.",
    what: "open the PR (spec + harness + scrape config).",
  },
  {
    when: "Day 3 · < 30 min.",
    what: "maintainer reviews, merges, reloads Prometheus. Site renders within 60 s.",
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

      {/* Two-column section */}
      <div className="mt-16 sm:mt-24 grid grid-cols-1 lg:grid-cols-2 gap-8">
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

        {/* Right: Realistic timeline */}
        <section className="card p-8 sm:p-10 bg-paper-soft border border-rule rounded-xl">
          <p className="label-mono text-ink-faint">REALISTIC TIMELINE</p>
          <ul className="mt-6 space-y-5 text-sm sm:text-base text-ink-soft leading-relaxed">
            {TIMELINE.map((t) => (
              <li key={t.when}>
                <span className="font-bold text-ink">{t.when}</span>{" "}
                {t.what}
                {t.code ? (
                  <>
                    <CodeChip>{t.code}</CodeChip>
                    {t.tail}
                  </>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="mt-8 text-xs sm:text-sm italic text-ink-muted">
            ~3-4 hours of focused work, spread across a few days.
          </p>
        </section>
      </div>

      {/* Keep existing AI brief block */}
      <AiBriefBlock />
    </article>
  );
}
