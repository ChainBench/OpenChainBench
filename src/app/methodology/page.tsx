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
      <p className="font-sans text-[11px] uppercase tracking-[0.22em] text-accent">
        Standing note
      </p>
      <h1 className="mt-3 font-serif text-5xl font-bold tracking-tight">
        Methodology
      </h1>
      <p className="mt-3 font-serif italic text-xl text-ink-soft">
        How every benchmark is measured, reported and reproduced.
      </p>

      <SectionRule label="Design principles" number="i" />
      <ol className="space-y-5 font-serif text-[1.05rem] leading-[1.65]">
        <Principle
          n="I"
          title="Identical inputs."
          body="Every provider sees the same request — same pair, same notional, same destination — submitted at the same moment from the same region. If inputs differ, we say so."
        />
        <Principle
          n="II"
          title="Honest aggregates."
          body="We report p50, p90 and p99 latency along with success rate. Means are reported but never used as a headline — tail behaviour is what users feel."
        />
        <Principle
          n="III"
          title="Auditable runs."
          body="Raw metrics are stored in Prometheus and exposed publicly. Anyone can re-run the harness against the same endpoints and verify the numbers match."
        />
        <Principle
          n="IV"
          title="No cherry-picking."
          body="The benchmark plan is committed before each run: providers, routes, cadence, timeout. Adding or removing providers after seeing results requires a published correction."
        />
        <Principle
          n="V"
          title="Live leader."
          body="The leader on every page is computed at render time from the lowest p50. No spec marks a winner ahead of time."
        />
      </ol>

      <SectionRule label="Statistical conventions" number="ii" />
      <dl className="space-y-4 font-serif text-[1.02rem] leading-[1.6]">
        <DefRow term="Latency aggregates">
          Reported as p50, p90, p99 and arithmetic mean over the run window.
          Failed requests (timeout, 5xx, malformed response) are excluded
          from latency aggregates and counted toward success rate.
        </DefRow>
        <DefRow term="Success rate">
          Share of requests returning a usable result within the published
          timeout. The only metric that includes failures.
        </DefRow>
        <DefRow term="Region normalisation">
          Wherever a benchmark is multi-region, the headline figure is the
          cross-region median. Per-region figures appear in Fig. 3 of each
          report.
        </DefRow>
        <DefRow term="Significance">
          Differences smaller than the within-provider standard deviation
          are flagged as inside the noise envelope and reported without a
          leader.
        </DefRow>
      </dl>

      <SectionRule label="Reproducing a result" number="iii" />
      <ol className="space-y-3 font-serif text-[1.02rem] leading-[1.6] list-decimal pl-6 marker:font-mono marker:text-ink-muted">
        <li>
          Clone the harness from the link at the bottom of any benchmark
          report.
        </li>
        <li>
          Set API keys for the providers you want to include. Public
          endpoints work for most aggregators; some bridges require
          allow-listing.
        </li>
        <li>
          Run the harness for at least 24 hours to get a comparable sample
          size (n typically ≥ 1,000 per provider per region).
        </li>
        <li>
          Compare your aggregates to the published numbers. If they
          diverge, open an issue — we&apos;ll publish a correction or
          refine the methodology.
        </li>
      </ol>

      <SectionRule label="Corrections" number="iv" />
      <p className="font-serif text-[1.05rem] leading-[1.65]">
        Found a number you can&apos;t reproduce? An endpoint missing? A
        provider you&apos;d like benchmarked? Open an issue at{" "}
        <a
          className="lnk"
          href="https://github.com/Flotapponnier/OpenChainBench/issues"
        >
          github.com/Flotapponnier/OpenChainBench/issues
        </a>
        . Material errors are corrected in place with a dated note.
      </p>
    </article>
  );
}

function Principle({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <li className="flex gap-5">
      <span className="font-serif text-3xl font-semibold leading-none text-ink-muted shrink-0 w-9">
        {n}.
      </span>
      <p>
        <strong className="font-semibold">{title}</strong> {body}
      </p>
    </li>
  );
}

function DefRow({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[10rem_1fr] sm:gap-6">
      <dt className="font-sans text-[11px] uppercase tracking-[0.18em] text-ink-muted pt-1">
        {term}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}
