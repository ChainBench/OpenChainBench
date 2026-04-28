import type { Metadata } from "next";
import { SectionRule } from "@/components/section-rule";

export const metadata: Metadata = {
  title: "Methodology",
  description:
    "How OpenChainBench measures: design principles, statistical conventions, regions, and reproduction guidelines.",
};

export default function MethodologyPage() {
  return (
    <article className="mx-auto max-w-3xl px-6 py-12">
      <p className="font-sans text-[11px] uppercase tracking-[0.22em] text-accent">
        Editorial · Standing Note
      </p>
      <h1 className="mt-3 font-serif text-5xl font-bold tracking-tight">
        Methodology
      </h1>
      <p className="mt-3 font-serif italic text-xl text-ink-soft">
        How we measure, how we report, and how to reproduce any number on this site.
      </p>

      <SectionRule label="Design principles" number="i" />
      <ol className="space-y-5 font-serif text-[1.05rem] leading-[1.65]">
        <Principle
          n="I"
          title="Identical inputs."
          body="Every provider sees the same request — same pair, same notional, same slippage tolerance, same destination — submitted at the same moment from the same region. If inputs differ, we say so."
        />
        <Principle
          n="II"
          title="Honest aggregates."
          body="We report p50, p90 and p99 latency along with success rate. Means are reported but never used as a headline — tail behaviour is what users feel."
        />
        <Principle
          n="III"
          title="Auditable runs."
          body="Raw request/response transcripts are stored for every run. Anyone can re-run the harness against the same endpoints and verify our numbers match."
        />
        <Principle
          n="IV"
          title="No cherry-picking."
          body="We commit a benchmark plan before running it: providers in the set, routes, cadence, timeout. Adding or removing providers after seeing results requires a published correction."
        />
      </ol>

      <SectionRule label="Statistical conventions" number="ii" />
      <dl className="space-y-4 font-serif text-[1.02rem] leading-[1.6]">
        <DefRow term="Latency aggregates">
          Reported as p50, p90, p99 and arithmetic mean over the run window.
          Failed requests (timeout, 5xx, malformed response) are excluded from
          latency aggregates and counted toward success rate.
        </DefRow>
        <DefRow term="Success rate">
          Share of requests returning a usable result within the published
          timeout. The only metric that includes failures.
        </DefRow>
        <DefRow term="Region normalisation">
          Wherever a benchmark is multi-region, the headline figure is the
          cross-region median. Per-region figures are available in the raw
          dataset and shown in the small-multiples grid (Fig. 3 in each report).
        </DefRow>
        <DefRow term="Significance">
          Differences smaller than the within-provider standard deviation are
          flagged as inside the noise envelope and reported without a winner.
        </DefRow>
      </dl>

      <SectionRule label="Reproducing a result" number="iii" />
      <ol className="space-y-3 font-serif text-[1.02rem] leading-[1.6] list-decimal pl-6 marker:font-mono marker:text-ink-muted">
        <li>
          Clone the harness from the link at the bottom of any benchmark report
          (each report links its specific harness directory).
        </li>
        <li>
          Set the API keys for the providers you want to include. Public
          endpoints work for most aggregators; some bridges require allow-listing.
        </li>
        <li>
          Run the harness for at least 24 hours to get a comparable sample size
          (n typically ≥ 1,000 per provider per region).
        </li>
        <li>
          Compare your aggregates to ours. If they diverge, open an issue —
          we'll publish a correction or refine the methodology.
        </li>
      </ol>

      <SectionRule label="Conflicts of interest" number="iv" />
      <p className="font-serif text-[1.05rem] leading-[1.65]">
        OpenChainBench is sponsored by{" "}
        <a className="lnk" href="https://mobula.io">
          Mobula
        </a>
        , whose products appear in several benchmarks. We treat that as a
        conflict and manage it explicitly:
      </p>
      <ul className="mt-4 space-y-3 font-serif text-[1.02rem] leading-[1.6] text-ink-soft">
        <li>— Mobula does not see results before publication, and cannot block a report.</li>
        <li>— Mobula is run through the harness in the same way as every other provider — same inputs, same timeouts, same code path.</li>
        <li>— Where Mobula loses, we publish that. Where it wins, we explain why.</li>
        <li>— The benchmark plan is committed publicly before each run. If we want to add or remove a provider mid-run, we open a PR.</li>
      </ul>

      <SectionRule label="Corrections" number="v" />
      <p className="font-serif text-[1.05rem] leading-[1.65]">
        Found a number you can't reproduce? An endpoint we missed? A provider
        you'd like benchmarked? Open an issue at{" "}
        <a className="lnk" href="https://github.com/mobula/openchainbench/issues">
          github.com/mobula/openchainbench/issues
        </a>
        . Material errors are corrected in place with a dated note; future
        issues acknowledge the change in their masthead.
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
