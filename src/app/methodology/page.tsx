import type { Metadata } from "next";
import { SectionRule } from "@/components/section-rule";

export const metadata: Metadata = {
  title: "Methodology",
  description:
    "How OpenChainBench measures: design principles, statistical conventions, and reproduction guidelines.",
};

export default function MethodologyPage() {
  return (
    <article className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="display text-4xl sm:text-5xl">
        Methodology
      </h1>
      <p className="mt-3 text-xl sm:text-2xl text-ink-muted leading-snug">
        How every benchmark is measured, reported and reproduced.
      </p>

      <SectionRule label="Design principles" number="i" />
      <ol className="space-y-5 text-base leading-relaxed text-ink-soft">
        <Principle n="I" title="Identical inputs." body="Every provider sees the same request — same pair, same notional, same destination — submitted at the same moment from the same region. If inputs differ, we say so." />
        <Principle n="II" title="Honest aggregates." body="We report p50, p90 and p99 latency along with success rate. Means are reported but never used as a headline — tail behaviour is what users feel." />
        <Principle n="III" title="Auditable runs." body="Raw metrics are stored in Prometheus and exposed publicly. Anyone can re-run the harness against the same endpoints and verify the numbers match." />
        <Principle n="IV" title="No cherry-picking." body="The benchmark plan is committed before each run: providers, routes, cadence, timeout. Adding or removing providers after seeing results requires a published correction." />
        <Principle n="V" title="Neutral presentation." body="No spec marks a winner ahead of time. Tables sort mechanically by p50; readers compare the columns themselves." />
      </ol>

      <SectionRule label="Statistical conventions" number="ii" />
      <dl className="space-y-4 text-base leading-relaxed text-ink-soft">
        <DefRow term="Latency aggregates">Reported as p50, p90, p99 and arithmetic mean over the run window. Failed requests (timeout, 5xx, malformed response) are excluded from latency aggregates and counted toward success rate.</DefRow>
        <DefRow term="24h range">Min and max of p50 observed across the rolling 24-hour window — captures the volatility of each provider, not just its central tendency.</DefRow>
        <DefRow term="Δ field">Each provider&apos;s p50 expressed as a percentage delta from the field mean. Negative is below the field, positive is above.</DefRow>
        <DefRow term="Success rate">Share of requests returning a usable result within the published timeout. The only metric that includes failures.</DefRow>
        <DefRow term="Region normalisation">Wherever a benchmark is multi-region, the headline figure is the cross-region median. Per-region figures appear in Fig. 3 of each report.</DefRow>
        <DefRow term="Significance">Differences smaller than the within-provider standard deviation are noted but not framed as a ranking.</DefRow>
      </dl>

      <SectionRule label="Reproducing a result" number="iii" />
      <ol className="space-y-3 text-base leading-relaxed text-ink-soft list-decimal pl-6 marker:font-mono marker:text-ink-muted">
        <li>Clone the harness from the link at the bottom of any benchmark report.</li>
        <li>Set API keys for the providers you want to include. Public endpoints work for most aggregators; some bridges require allow-listing.</li>
        <li>Run the harness — it exposes <code className="font-mono text-[0.92em]">/metrics</code> over HTTP. Point a local Prometheus at it, or query the public OpenChainBench Prometheus directly.</li>
        <li>Run for at least 24 hours to get a comparable sample size (n typically ≥ 1,000 per provider per region).</li>
        <li>Compare your aggregates to the published numbers. If they diverge, file a <a className="lnk" href="https://github.com/OpenChainBench/OpenChainBench/issues/new?template=provider-correction.yml">provider correction</a> with a reproducer.</li>
      </ol>

      <SectionRule label="Corrections" number="iv" />
      <p className="text-base leading-relaxed text-ink-soft">
        Found a number you can&apos;t reproduce? File a{" "}
        <a className="lnk" href="https://github.com/OpenChainBench/OpenChainBench/issues/new?template=data-quality.yml">
          data-quality issue
        </a>
        {" "}(the published figure looks wrong) or a{" "}
        <a className="lnk" href="https://github.com/OpenChainBench/OpenChainBench/issues/new?template=provider-correction.yml">
          provider correction
        </a>
        {" "}(your service measures a different value). Material errors are corrected in place with a dated note.
      </p>
    </article>
  );
}

function Principle({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <li className="flex gap-5">
      <span className="display text-2xl font-semibold leading-none text-ink-muted shrink-0 w-9">{n}.</span>
      <p>
        <strong className="font-semibold">{title}</strong> {body}
      </p>
    </li>
  );
}

function DefRow({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[10rem_1fr] sm:gap-6">
      <dt className="font-sans text-[11px] uppercase tracking-[0.18em] text-ink-muted pt-1">{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}
