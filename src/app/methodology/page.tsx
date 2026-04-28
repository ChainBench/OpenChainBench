import type { Metadata } from "next";
import { SectionRule } from "@/components/section-rule";

export const metadata: Metadata = {
  title: "Methodology",
  description:
    "How OpenChainBench measures: design principles, statistical conventions, and reproduction guidelines.",
};

export default function MethodologyPage() {
  return (
    <article className="px-4 pt-12 sm:pt-16">
      <div className="mx-auto max-w-3xl">
        <span className="eyebrow">Standing note</span>
        <h1 className="mt-5 display text-4xl sm:text-5xl">Methodology</h1>
        <p className="mt-4 text-lg text-ink-muted leading-relaxed">
          How every benchmark is measured, reported and reproduced.
        </p>

        <SectionRule label="Design principles" />
        <ol className="space-y-5">
          <Principle n="01" title="Identical inputs." body="Every provider sees the same request — same pair, same notional, same destination — submitted at the same moment from the same region. If inputs differ, we say so." />
          <Principle n="02" title="Honest aggregates." body="We report p50, p90 and p99 latency along with success rate. Means are reported but never used as a headline — tail behaviour is what users feel." />
          <Principle n="03" title="Auditable runs." body="Raw metrics are stored in Prometheus and exposed publicly. Anyone can re-run the harness against the same endpoints and verify the numbers match." />
          <Principle n="04" title="No cherry-picking." body="The benchmark plan is committed before each run: providers, routes, cadence, timeout. Adding or removing providers after seeing results requires a published correction." />
          <Principle n="05" title="Live leader." body="The leader on every page is computed at render time from the lowest p50. No spec marks a winner ahead of time." />
        </ol>

        <SectionRule label="Statistical conventions" />
        <dl className="space-y-5 text-base leading-relaxed text-ink-soft">
          <DefRow term="Latency aggregates">Reported as p50, p90, p99 and arithmetic mean over the run window. Failed requests (timeout, 5xx, malformed response) are excluded from latency aggregates and counted toward success rate.</DefRow>
          <DefRow term="Success rate">Share of requests returning a usable result within the published timeout. The only metric that includes failures.</DefRow>
          <DefRow term="Region normalisation">Wherever a benchmark is multi-region, the headline figure is the cross-region median. Per-region figures appear in Fig. 3 of each report.</DefRow>
          <DefRow term="Significance">Differences smaller than the within-provider standard deviation are flagged as inside the noise envelope and reported without a leader.</DefRow>
        </dl>

        <SectionRule label="Reproducing a result" />
        <ol className="space-y-3 text-base leading-relaxed text-ink-soft list-decimal pl-6 marker:font-mono marker:text-ink-faint">
          <li>Clone the harness from the link at the bottom of any benchmark report.</li>
          <li>Set API keys for the providers you want to include. Public endpoints work for most aggregators; some bridges require allow-listing.</li>
          <li>Run the harness for at least 24 hours to get a comparable sample size (n typically ≥ 1,000 per provider per region).</li>
          <li>Compare your aggregates to the published numbers. If they diverge, open an issue — we&apos;ll publish a correction or refine the methodology.</li>
        </ol>

        <SectionRule label="Corrections" />
        <p className="text-base leading-relaxed text-ink-soft">
          Found a number you can&apos;t reproduce? Open an issue at{" "}
          <a className="lnk" href="https://github.com/OpenChainBench/OpenChainBench/issues">
            github.com/OpenChainBench/OpenChainBench/issues
          </a>
          . Material errors are corrected in place with a dated note.
        </p>
      </div>
    </article>
  );
}

function Principle({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <li className="grid grid-cols-[3rem_1fr] gap-4">
      <span className="font-mono text-sm tabular text-ink-faint pt-1">{n}</span>
      <p className="text-base leading-relaxed text-ink-soft">
        <strong className="font-semibold text-ink">{title}</strong> {body}
      </p>
    </li>
  );
}

function DefRow({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2 sm:grid-cols-[10rem_1fr] sm:gap-6">
      <dt className="text-xs font-medium uppercase tracking-[0.12em] text-ink-faint pt-1">{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}
